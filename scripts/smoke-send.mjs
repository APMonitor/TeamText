import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a local test port.");
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("TeamText exited before the smoke test started.");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The local server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the TeamText API.");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 6_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), SMS_DRY_RUN: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  await waitForHealth(baseUrl, child);
  const response = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pauseOpen: 0,
      pauseBetween: 0,
      pauseAfterSend: 0,
      targets: [{
        id: "smoke-group-1",
        recipient_label: "Example parent group",
        addresses: ["+12025550101", "+12025550104"],
        body: "TeamText group dry-run smoke check.",
      }],
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Smoke send failed with HTTP ${response.status}.`);
  if (!result.dryRun || result.results?.length !== 1 || result.results[0]?.status !== "simulated") {
    throw new Error(`Expected one simulated group result, received ${JSON.stringify(result)}.`);
  }
  const serialized = JSON.stringify(result);
  if (
    serialized.includes("+12025550101")
    || serialized.includes("+12025550104")
    || serialized.includes("TeamText group dry-run smoke check.")
  ) {
    throw new Error("The public send result exposed private target data.");
  }

  const invalidResponse = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targets: [{
        id: "combined-address",
        recipient_label: "Combined address should fail",
        address: "+12025550101; +12025550104",
        body: "This combined target must be rejected.",
      }],
    }),
  });
  const invalidResult = await invalidResponse.json();
  if (invalidResponse.status !== 400 || !invalidResult.invalidTargets?.[0]?.issues?.includes("each address must contain exactly one phone number")) {
    throw new Error("The API accepted an unstructured delimiter-bearing address.");
  }

  const duplicateResponse = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targets: [{
        id: "duplicate-group-member",
        recipient_label: "Duplicate group should fail",
        addresses: ["+12025550101", "(202) 555-0101"],
        body: "This duplicate group must be rejected.",
      }],
    }),
  });
  const duplicateResult = await duplicateResponse.json();
  if (duplicateResponse.status !== 400 || !duplicateResult.invalidTargets?.[0]?.issues?.includes("addresses must be unique within a group")) {
    throw new Error("The API accepted a duplicate group recipient.");
  }
  console.log("TeamText dry-run sender smoke test passed.");
} catch (error) {
  if (output.trim()) console.error(output.trim());
  throw error;
} finally {
  await stopChild(child);
}
