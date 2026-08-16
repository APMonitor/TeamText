import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";

const ROOT_DIR = process.cwd();
const SEND_SCRIPT = path.join(ROOT_DIR, "server", "scripts", "send_messages.py");
const DIST_DIR = path.join(ROOT_DIR, "web", "dist");
const PYTHON_BIN = fs.existsSync(path.join(ROOT_DIR, ".venv", "bin", "python"))
  ? path.join(ROOT_DIR, ".venv", "bin", "python")
  : "python3";
const READY_MARKER = "__TEAMTEXT_SEND_READY__";
const PROGRESS_MARKER = "__TEAMTEXT_SEND_PROGRESS__";
const STATE_MARKER = "__TEAMTEXT_SEND_STATE__";
const MAX_TARGETS = 5_000;
const MAX_GROUP_RECIPIENTS = 20;
const MAX_LABEL_LENGTH = 240;
const MAX_ADDRESS_LENGTH = 160;
const MAX_BODY_LENGTH = 10_000;
const FORCE_CANCEL_AFTER_MS = 5_000;

let activeSendJob = null;
let httpServer = null;
let shuttingDown = false;

const app = express();
app.use(express.json({ limit: "10mb" }));

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTargetId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function addressKey(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || value.toLocaleLowerCase();
}

function validateTargets(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      targets: [],
      invalidTargets: [{ index: null, target_id: null, recipient_label: "", issues: ["at least one target is required"] }],
    };
  }

  if (value.length > MAX_TARGETS) {
    return {
      targets: [],
      invalidTargets: [
        {
          index: null,
          target_id: null,
          recipient_label: "",
          issues: [`no more than ${MAX_TARGETS} targets may be sent at once`],
        },
      ],
    };
  }

  const targets = [];
  const invalidTargets = [];
  const seenIds = new Set();

  value.forEach((entry, index) => {
    const target = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const targetId = normalizeTargetId(target.id);
    const recipientLabel = cleanText(target.recipient_label);
    const addressValues = Array.isArray(target.addresses)
      ? target.addresses
      : target.address === undefined
        ? []
        : [target.address];
    const addresses = [];
    const body = typeof target.body === "string" ? target.body.replace(/\r\n/g, "\n").trim() : "";
    const issues = [];

    if (targetId === null) {
      issues.push("id is required");
    } else {
      const idKey = `${typeof targetId}:${targetId}`;
      if (seenIds.has(idKey)) {
        issues.push("id must be unique within the batch");
      } else {
        seenIds.add(idKey);
      }
    }
    if (!recipientLabel) {
      issues.push("recipient_label is required");
    } else if (recipientLabel.length > MAX_LABEL_LENGTH) {
      issues.push(`recipient_label must be ${MAX_LABEL_LENGTH} characters or fewer`);
    }
    if (!addressValues.length) {
      issues.push("at least one address is required");
    } else if (addressValues.length > MAX_GROUP_RECIPIENTS) {
      issues.push(`no more than ${MAX_GROUP_RECIPIENTS} recipients may be included in one group`);
    } else {
      const seenAddresses = new Set();
      addressValues.forEach((value) => {
        if (typeof value !== "string") {
          issues.push("each address must be a string");
          return;
        }
        const address = value.trim();
        if (!address) {
          issues.push("addresses cannot be blank");
        } else if (address.length > MAX_ADDRESS_LENGTH) {
          issues.push(`each address must be ${MAX_ADDRESS_LENGTH} characters or fewer`);
        } else if (/[;,]/.test(address)) {
          issues.push("each address must contain exactly one phone number");
        } else if (/[\u0000-\u001f\u007f]/.test(address)) {
          issues.push("addresses cannot contain control characters");
        } else {
          const key = addressKey(address);
          if (seenAddresses.has(key)) {
            issues.push("addresses must be unique within a group");
          } else {
            seenAddresses.add(key);
            addresses.push(address);
          }
        }
      });
    }
    if (body.length < 5) {
      issues.push("body must contain at least 5 characters");
    } else if (body.length > MAX_BODY_LENGTH) {
      issues.push(`body must be ${MAX_BODY_LENGTH} characters or fewer`);
    }

    if (issues.length) {
      invalidTargets.push({
        index,
        target_id: targetId,
        recipient_label: recipientLabel,
        issues,
      });
      return;
    }

    targets.push({
      target_id: targetId,
      recipient_label: recipientLabel,
      addresses,
      body,
    });
  });

  return { targets, invalidTargets };
}

function parseDelay(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300) {
    const error = new Error(`${fieldName} must be a number from 0 to 300 seconds.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function sendStatusPayload() {
  const job = activeSendJob;
  if (!job) {
    return { active: false, status: "idle" };
  }
  const counts = resultCounts(job.results);
  return {
    active: true,
    jobId: job.id,
    status: job.status,
    ready: job.ready,
    dryRun: job.dryRun,
    targetCount: job.targetCount,
    startedAt: job.startedAt,
    results: job.results.map((entry) => ({ ...entry })),
    ...counts,
  };
}

function signalJob(job, signalName) {
  try {
    return job.child.kill(signalName);
  } catch {
    return false;
  }
}

function armForceKill(job) {
  if (job.forceKillTimer) {
    return;
  }
  job.forceKillTimer = setTimeout(() => {
    if (activeSendJob?.id === job.id && job.status === "cancelling") {
      signalJob(job, "SIGKILL");
    }
  }, FORCE_CANCEL_AFTER_MS);
  job.forceKillTimer.unref?.();
}

function requestJobCancellation(job) {
  job.cancelRequested = true;
  job.status = "cancelling";
  signalJob(job, "SIGTERM");
  armForceKill(job);
}

function publicResultEntry(entry) {
  const targetId = normalizeTargetId(entry?.target_id);
  const recipientLabel = cleanText(entry?.recipient_label).slice(0, MAX_LABEL_LENGTH);
  const status = cleanText(entry?.status).toLowerCase() || "failed";
  const error = cleanText(entry?.error);
  const sentAt = cleanText(entry?.sent_at);
  return {
    target_id: targetId,
    recipient_label: recipientLabel,
    status,
    ...(error ? { error } : {}),
    ...(sentAt ? { sent_at: sentAt } : {}),
  };
}

function resultCounts(results) {
  return {
    completedCount: results.length,
    submittedCount: results.filter((entry) => entry.status === "submitted").length,
    simulatedCount: results.filter((entry) => entry.status === "simulated").length,
    failedCount: results.filter((entry) => entry.status === "failed").length,
    cancelledCount: results.filter((entry) => entry.status === "cancelled").length,
    unknownCount: results.filter((entry) => entry.status === "unknown").length,
  };
}

function publicSenderResult(value, fallbackDryRun = false) {
  const results = Array.isArray(value?.results) ? value.results.map(publicResultEntry) : [];
  const response = {
    results,
    cancelled: Boolean(value?.cancelled),
    dryRun: typeof value?.dryRun === "boolean" ? value.dryRun : fallbackDryRun,
    ...resultCounts(results),
  };
  const error = cleanText(value?.error);
  if (error) {
    response.error = error;
  }
  return response;
}

function targetKey(targetId) {
  return `${typeof targetId}:${targetId}`;
}

function recordJobResult(job, value) {
  const result = publicResultEntry(value);
  if (result.target_id === null) {
    return false;
  }
  const key = targetKey(result.target_id);
  const target = job.targetByKey.get(key);
  if (!target) {
    return false;
  }
  result.target_id = target.target_id;
  result.recipient_label = target.recipient_label;
  const existingIndex = job.resultIndex.get(key);
  if (existingIndex === undefined) {
    job.resultIndex.set(key, job.results.length);
    job.results.push(result);
  } else {
    job.results[existingIndex] = result;
  }
  return true;
}

function addResultsForUntouched(job, status = "cancelled", error = "Send stopped before this text began.") {
  for (const target of job.targets) {
    const key = targetKey(target.target_id);
    if (job.resultIndex.has(key)) {
      continue;
    }
    recordJobResult(job, {
      ...target,
      status,
      error,
      sent_at: new Date().toISOString(),
    });
  }
}

function runSendScript(payload) {
  if (activeSendJob) {
    const error = new Error("A send is already in progress.");
    error.statusCode = 409;
    throw error;
  }

  const child = spawn(PYTHON_BIN, [SEND_SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const targets = payload.messages.map((message) => ({
    target_id: message.target_id,
    recipient_label: message.recipient_label,
  }));
  const job = {
    id: randomUUID(),
    status: "starting",
    ready: false,
    cancelRequested: false,
    child,
    dryRun: ["1", "true", "yes"].includes(cleanText(process.env.SMS_DRY_RUN).toLowerCase()),
    targets,
    targetByKey: new Map(targets.map((target) => [targetKey(target.target_id), target])),
    results: [],
    resultIndex: new Map(),
    targetCount: targets.length,
    startedAt: new Date().toISOString(),
    forceKillTimer: null,
  };
  activeSendJob = job;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stderrLineBuffer = "";
    let settled = false;

    function clearActiveJob() {
      if (job.forceKillTimer) {
        clearTimeout(job.forceKillTimer);
        job.forceKillTimer = null;
      }
      if (activeSendJob?.id === job.id) {
        activeSendJob = null;
      }
    }

    function appendStderrLine(line) {
      if (!line) {
        return;
      }
      stderr += `${stderr ? "\n" : ""}${line}`;
    }

    function markReady() {
      if (job.ready) {
        return;
      }
      job.ready = true;
      if (job.status === "starting") {
        job.status = "running";
      } else if (job.status === "pausing" && !signalJob(job, "SIGUSR1")) {
        job.status = "running";
      }
    }

    function handleProtocolLine(rawLine) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === READY_MARKER) {
        markReady();
        return;
      }
      if (line.startsWith(PROGRESS_MARKER)) {
        try {
          recordJobResult(job, JSON.parse(line.slice(PROGRESS_MARKER.length)));
        } catch {
          appendStderrLine("Sender returned a malformed progress update.");
        }
        return;
      }
      if (line.startsWith(STATE_MARKER)) {
        try {
          const state = cleanText(JSON.parse(line.slice(STATE_MARKER.length))?.status).toLowerCase();
          if (["running", "paused", "cancelling"].includes(state)) {
            if (job.status !== "cancelling" || state === "cancelling") {
              job.status = state;
            }
          }
        } catch {
          appendStderrLine("Sender returned a malformed state update.");
        }
        return;
      }
      appendStderrLine(line);
    }

    function consumeStderr(chunk = "", flush = false) {
      stderrLineBuffer += chunk;
      let lineEnd = stderrLineBuffer.indexOf("\n");
      while (lineEnd !== -1) {
        handleProtocolLine(stderrLineBuffer.slice(0, lineEnd));
        stderrLineBuffer = stderrLineBuffer.slice(lineEnd + 1);
        lineEnd = stderrLineBuffer.indexOf("\n");
      }
      if (flush && stderrLineBuffer) {
        handleProtocolLine(stderrLineBuffer);
        stderrLineBuffer = "";
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      consumeStderr(chunk);
    });

    child.stdin.on("error", (error) => {
      if (!stderr) {
        stderr = error.message;
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveJob();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      consumeStderr("", true);
      clearActiveJob();

      const output = stdout.trim();
      if (output) {
        try {
          const parsed = JSON.parse(output);
          if (Array.isArray(parsed?.results)) {
            parsed.results.forEach((entry) => recordJobResult(job, entry));
          }
          const cancelled = Boolean(parsed?.cancelled) || job.cancelRequested || signal === "SIGTERM" || signal === "SIGKILL";
          if (cancelled) {
            addResultsForUntouched(
              job,
              signal === "SIGKILL" ? "unknown" : "cancelled",
              signal === "SIGKILL"
                ? "Status unknown after the sender had to be force-stopped. Check Messages before retrying."
                : "Send stopped before this text began."
            );
          }
          resolve({
            jobId: job.id,
            targetCount: job.targetCount,
            ...publicSenderResult({
              ...parsed,
              results: job.results,
              cancelled,
            }, job.dryRun),
          });
          return;
        } catch (error) {
          reject(new Error(`Sender returned invalid JSON: ${error.message}`));
          return;
        }
      }

      if (job.cancelRequested || signal === "SIGTERM" || signal === "SIGKILL") {
        addResultsForUntouched(
          job,
          signal === "SIGKILL" ? "unknown" : "cancelled",
          signal === "SIGKILL"
            ? "Status unknown after the sender had to be force-stopped. Check Messages before retrying."
            : "Send stopped before this text began."
        );
        resolve({
          jobId: job.id,
          targetCount: job.targetCount,
          ...publicSenderResult({
            results: job.results,
            cancelled: true,
            dryRun: job.dryRun,
            error: cleanText(stderr) || "Send cancelled.",
          }, job.dryRun),
        });
        return;
      }

      reject(new Error(cleanText(stderr) || `Send failed with exit code ${code ?? "unknown"}.`));
    });

    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, send: sendStatusPayload() });
});

app.get("/api/send/status", (_req, res) => {
  res.json(sendStatusPayload());
});

app.post("/api/send", async (req, res) => {
  if (activeSendJob) {
    res.status(409).json({ error: "A send is already in progress.", send: sendStatusPayload() });
    return;
  }

  const { targets, invalidTargets } = validateTargets(req.body?.targets);
  if (invalidTargets.length) {
    res.status(400).json({
      error: "Fix the invalid message targets before sending.",
      invalidTargets,
    });
    return;
  }

  try {
    const payload = {
      messages: targets,
      pauseOpen: parseDelay(req.body?.pauseOpen, 2, "pauseOpen"),
      pauseBetween: parseDelay(req.body?.pauseBetween, 7, "pauseBetween"),
      pauseAfterSend: parseDelay(req.body?.pauseAfterSend, 1.25, "pauseAfterSend"),
    };
    const result = await runSendScript(payload);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Sending failed." });
  }
});

app.post("/api/send/pause", (_req, res) => {
  const job = activeSendJob;
  if (!job) {
    res.status(404).json({ error: "No active send is currently running." });
    return;
  }
  if (job.status === "cancelling") {
    res.status(409).json({ error: "The active send is already stopping.", send: sendStatusPayload() });
    return;
  }
  if (["paused", "pausing"].includes(job.status)) {
    res.json(sendStatusPayload());
    return;
  }

  job.status = "pausing";
  if (job.ready && !signalJob(job, "SIGUSR1")) {
    job.status = "running";
    res.status(409).json({ error: "The send finished before it could be paused.", send: sendStatusPayload() });
    return;
  }
  res.json(sendStatusPayload());
});

app.post("/api/send/resume", (_req, res) => {
  const job = activeSendJob;
  if (!job) {
    res.status(404).json({ error: "No paused send is currently available." });
    return;
  }
  if (job.status === "cancelling") {
    res.status(409).json({ error: "The active send is already stopping.", send: sendStatusPayload() });
    return;
  }
  if (["running", "resuming", "starting"].includes(job.status)) {
    res.json(sendStatusPayload());
    return;
  }

  if (!job.ready) {
    job.status = "starting";
    res.json(sendStatusPayload());
    return;
  }
  job.status = "resuming";
  if (!signalJob(job, "SIGUSR2")) {
    job.status = "paused";
    res.status(409).json({ error: "The send finished before it could be resumed.", send: sendStatusPayload() });
    return;
  }
  res.json(sendStatusPayload());
});

app.post("/api/send/cancel", (_req, res) => {
  const job = activeSendJob;
  if (!job) {
    res.status(404).json({ error: "No active send is currently running." });
    return;
  }
  if (job.status === "cancelling") {
    res.json(sendStatusPayload());
    return;
  }

  requestJobCancellation(job);

  res.json(sendStatusPayload());
});

if (fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || "Unexpected server error." });
});

function waitForJobClose(job) {
  if (!job || job.child.exitCode !== null || job.child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      job.child.off("close", finish);
      job.child.off("error", finish);
      resolve();
    };
    job.child.once("close", finish);
    job.child.once("error", finish);
  });
}

function closeHttpServer() {
  if (!httpServer?.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    httpServer.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error(error);
      }
      resolve();
    });
    httpServer.closeIdleConnections?.();
  });
}

async function shutdown(signalName) {
  if (shuttingDown) {
    if (activeSendJob) {
      signalJob(activeSendJob, "SIGKILL");
    }
    httpServer?.closeAllConnections?.();
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signalName}; stopping the messaging service.`);

  const job = activeSendJob;
  const jobClosePromise = waitForJobClose(job);
  if (job) {
    requestJobCancellation(job);
  }

  const serverClosePromise = closeHttpServer();
  const connectionTimer = setTimeout(() => {
    httpServer?.closeAllConnections?.();
  }, FORCE_CANCEL_AFTER_MS + 1_000);
  connectionTimer.unref?.();

  await jobClosePromise;
  await serverClosePromise;
  clearTimeout(connectionTimer);
  process.exitCode = 0;
}

function handleShutdownSignal(signalName) {
  void shutdown(signalName).catch((error) => {
    console.error(error);
    if (activeSendJob) {
      signalJob(activeSendJob, "SIGKILL");
    }
    httpServer?.closeAllConnections?.();
    process.exitCode = 1;
  });
}

process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

const port = Number(process.env.PORT || 4100);
httpServer = app.listen(port, "127.0.0.1", () => {
  const address = httpServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`TeamText API listening on http://127.0.0.1:${listeningPort}`);
});
