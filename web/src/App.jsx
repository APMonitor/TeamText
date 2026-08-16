import { useEffect, useMemo, useRef, useState } from "react";
import { buildRecipientUnits, clean, looksLikeTextNumber } from "./recipientModel.js";
import { fieldKey, parseRoster } from "./rosterFile.js";

const ACTIVE = new Set(["starting", "running", "pausing", "paused", "resuming", "stopping"]);
const RESERVED_TOKENS = new Set(["athlete_names", "athlete_count"]);
const MAX_GROUP_RECIPIENTS = 20;
const OPERATORS = [
  ["contains", "contains"],
  ["one_of", "is one of"],
  ["between", "between"],
  ["not_blank", "is not blank"],
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function tokensFor(columns) {
  const used = new Set(RESERVED_TOKENS);
  return Object.fromEntries(columns.map((column, index) => {
    const base = fieldKey(column) || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return [column, candidate];
  }));
}

function detectName(columns) {
  const exact = ["name", "athlete_name", "full_name", "athlete", "participant_name"];
  return columns.find((column) => exact.includes(fieldKey(column)))
    || columns.find((column) => fieldKey(column).includes("name"))
    || columns[0] || "";
}

function detectPhone(columns) {
  const exact = ["phone", "phone_number", "mobile", "mobile_phone", "cell", "cell_phone", "text_number", "parent_phone"];
  return columns.find((column) => exact.includes(fieldKey(column)))
    || columns.find((column) => /(phone|mobile|cell|text_number|sms)/.test(fieldKey(column)))
    || "";
}

function numberValue(value) {
  const candidate = clean(value).replace(/,/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value) {
  const candidate = clean(value);
  if (!/[a-z/-]/i.test(candidate)) return null;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? null : parsed;
}

function between(value, startValue, endValue) {
  const values = [clean(value), clean(startValue), clean(endValue)];
  if (!values[1] && !values[2]) return true;
  if (!values[0]) return false;
  let current;
  let start;
  let end;
  const populated = values.filter(Boolean);
  if (populated.every((item) => numberValue(item) !== null)) {
    [current, start, end] = values.map((item) => item ? numberValue(item) : null);
  } else if (populated.every((item) => dateValue(item) !== null)) {
    [current, start, end] = values.map((item) => item ? dateValue(item) : null);
  } else {
    [current, start, end] = values.map((item) => item.toLocaleLowerCase());
  }
  if (start !== null && start !== "" && end !== null && end !== "" && start > end) [start, end] = [end, start];
  return (start === null || start === "" || current >= start) && (end === null || end === "" || current <= end);
}

function matches(row, filter) {
  const value = clean(row.values[filter.column]);
  if (filter.operator === "not_blank") return Boolean(value);
  if (filter.operator === "between") return between(value, filter.value, filter.endValue);
  if (filter.operator === "one_of") {
    const choices = filter.value.split(",").map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
    return !choices.length || choices.includes(value.toLocaleLowerCase());
  }
  return !filter.value.trim() || value.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase());
}

function mergeMessage(body, values, tokens, additions = {}) {
  const context = {
    ...Object.fromEntries(Object.entries(values).map(([column, value]) => [tokens[column], value])),
    ...additions,
  };
  return String(body || "").replace(/{{\s*([^}]+?)\s*}}/g, (match, key) => {
    const normalized = fieldKey(key);
    return Object.hasOwn(context, normalized) ? context[normalized] : match;
  });
}

function unknownMergeFields(body, tokens) {
  const available = new Set([...Object.values(tokens), ...RESERVED_TOKENS]);
  const unknown = new Set();
  String(body || "").replace(/{{\s*([^}]+?)\s*}}/g, (_match, key) => {
    const normalized = fieldKey(key);
    if (!available.has(normalized)) unknown.add(normalized || clean(key));
    return _match;
  });
  return [...unknown];
}

function statusKey(value) {
  const status = fieldKey(value || "ready") || "ready";
  return status === "cancelling" ? "stopping" : status;
}

function statusText(value) {
  const status = statusKey(value);
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ");
}

function isSuccessfulStatus(value) {
  return ["sent", "submitted", "simulated"].includes(statusKey(value));
}

function activeButtonText(status) {
  const key = statusKey(status);
  if (key === "paused") return "Paused";
  if (key === "pausing") return "Pausing…";
  if (key === "resuming") return "Resuming…";
  if (key === "stopping") return "Stopping…";
  return "Sending…";
}

function activeStatusNote(status) {
  const key = statusKey(status);
  if (key === "paused") return "Send paused.";
  if (key === "pausing") return "Pausing at the next safe point…";
  if (key === "resuming") return "Resuming the send…";
  if (key === "stopping") return "Stopping after the current text…";
  if (key === "starting") return "Starting the send…";
  return "Send is running.";
}

function App() {
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [nameColumn, setNameColumn] = useState("");
  const [phoneColumn, setPhoneColumn] = useState("");
  const [filters, setFilters] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [deliveryMode, setDeliveryMode] = useState("individual");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sendStatus, setSendStatus] = useState("idle");
  const [sendPending, setSendPending] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [runtime, setRuntime] = useState({});
  const [runNote, setRunNote] = useState("");
  const filterId = useRef(0);
  const messageRef = useRef(null);

  const tokens = useMemo(() => tokensFor(columns), [columns]);
  const unknownFields = useMemo(() => unknownMergeFields(templateBody, tokens), [templateBody, tokens]);
  const filteredRows = useMemo(() => rows.filter((row) => filters.every((filter) => matches(row, filter))), [rows, filters]);
  const recipientRows = useMemo(() => filteredRows.filter((row) => !excluded.has(row.id)), [filteredRows, excluded]);
  const recipientUnits = useMemo(() => buildRecipientUnits({
    rows: recipientRows,
    deliveryMode,
    nameColumn,
    phoneColumn,
    columns,
  }), [recipientRows, deliveryMode, nameColumn, phoneColumn, columns]);
  const hasGroupTexts = recipientUnits.some((unit) => unit.recipientCount > 1);
  const summaries = useMemo(() => recipientUnits.map((unit, index) => {
    const body = mergeMessage(templateBody, unit.values, tokens, {
      athlete_names: unit.athleteNames,
      athlete_count: String(unit.athleteCount),
    }).trim();
    const issues = [];
    const missingNames = unit.rows.filter((row) => !clean(row.values[nameColumn])).length;
    if (missingNames) issues.push(missingNames === 1 ? "missing athlete name" : `${missingNames} missing athlete names`);
    else if (unit.name.length > 240) issues.push("athlete names are too long");
    if (!unit.addresses.length) issues.push("missing text number");
    else if (unit.addresses.length > MAX_GROUP_RECIPIENTS) issues.push(`group exceeds ${MAX_GROUP_RECIPIENTS} recipients`);
    else if (unit.addresses.some((address) => address.length > 160)) issues.push("a text number is too long");
    else if (unit.addresses.some((address) => !looksLikeTextNumber(address))) issues.push("invalid text number in recipient group");
    if (!body) issues.push("blank message");
    else if (body.length < 5) issues.push("message is too short");
    else if (body.length > 10000) issues.push("message is too long");
    if (unknownFields.length) issues.push(`unknown merge field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
    if (index >= 5000) issues.push("batch limit exceeded");
    return { ...unit, body, issues };
  }), [recipientUnits, nameColumn, templateBody, tokens, unknownFields]);
  const ready = useMemo(() => summaries.filter((summary) => !summary.issues.length), [summaries]);
  const active = sendPending || ACTIVE.has(sendStatus);
  const locked = active || uploading;
  const pauseControlLabel = sendStatus === "paused"
    ? "Resume"
    : sendStatus === "pausing"
      ? "Pausing…"
      : sendStatus === "resuming"
        ? "Resuming…"
        : "Pause";
  const pauseControlDisabled = controlBusy || ["starting", "pausing", "resuming", "stopping"].includes(sendStatus);
  const stopControlDisabled = controlBusy || ["starting", "stopping"].includes(sendStatus);

  function resetResults() {
    if (!active) {
      setRuntime({});
      setRunNote("");
      setSendStatus("idle");
    }
  }

  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const parsed = await parseRoster(await file.arrayBuffer());
      setColumns(parsed.columns);
      setRows(parsed.rows);
      setFileName(file.name);
      setNameColumn(detectName(parsed.columns));
      setPhoneColumn(detectPhone(parsed.columns));
      setFilters([]);
      setExcluded(new Set());
      setDeliveryMode("individual");
      setRuntime({});
      setRunNote("");
      setSendStatus("idle");
      setNotice(`Loaded ${parsed.rows.length} roster rows from ${file.name}.`);
    } catch (uploadError) {
      setError(uploadError.message || "Unable to read that roster.");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  function addFilter() {
    filterId.current += 1;
    setFilters((current) => [...current, {
      id: filterId.current,
      column: columns[0],
      operator: "contains",
      value: "",
      endValue: "",
    }]);
    resetResults();
  }

  function updateFilter(id, patch) {
    setFilters((current) => current.map((filter) => filter.id === id ? { ...filter, ...patch } : filter));
    resetResults();
  }

  function removeFilter(id) {
    setFilters((current) => current.filter((filter) => filter.id !== id));
    resetResults();
  }

  function toggleRow(id) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    resetResults();
  }

  function insertToken(token) {
    const tag = `{{${token}}}`;
    const input = messageRef.current;
    const start = input?.selectionStart ?? templateBody.length;
    const end = input?.selectionEnd ?? templateBody.length;
    setTemplateBody(`${templateBody.slice(0, start)}${tag}${templateBody.slice(end)}`);
    resetResults();
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  function insertField(column) {
    insertToken(tokens[column]);
  }

  function applyResults(results) {
    if (!Array.isArray(results)) return;
    setRuntime((current) => {
      const next = { ...current };
      results.forEach((result) => {
        const id = result.target_id ?? result.id ?? result.contact_id;
        if (id !== undefined && id !== null) next[String(id)] = result;
      });
      return next;
    });
  }

  async function getSendStatus() {
    try {
      const state = await api("/api/send/status");
      const next = statusKey(state.status);
      if (state.active || ACTIVE.has(next)) {
        setSendStatus(next);
        setRunNote(activeStatusNote(next));
      } else {
        setSendStatus((current) => {
          if (ACTIVE.has(current)) setRunNote("The active send finished.");
          return next;
        });
      }
      applyResults(state.results || state.progress?.results);
    } catch {
      // The final send response remains authoritative if a status poll briefly fails.
    }
  }

  useEffect(() => {
    let mounted = true;
    api("/api/send/status")
      .then((state) => {
        if (!mounted || !state.active) return;
        const next = statusKey(state.status);
        setSendStatus(next);
        setRunNote(`Existing batch: ${activeStatusNote(next)}`);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    let timer;
    async function poll() {
      await getSendStatus();
      if (mounted) timer = window.setTimeout(poll, 900);
    }
    timer = window.setTimeout(poll, 250);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [active]);

  async function send() {
    if (!ready.length || locked) return;
    const targets = ready.map((summary) => ({
      id: summary.id,
      recipient_label: summary.name,
      addresses: summary.addresses,
      body: summary.body,
    }));
    setError("");
    setNotice("");
    setRunNote(`Sending ${targets.length} text${targets.length === 1 ? "" : "s"}…`);
    setRuntime(Object.fromEntries(targets.map((target) => [String(target.id), { target_id: target.id, status: "queued" }])));
    setSendStatus("starting");
    setSendPending(true);
    try {
      const result = await api("/api/send", { method: "POST", body: JSON.stringify({ targets }) });
      applyResults(result.results);
      if (result.cancelled) {
        const reportedIds = new Set((result.results || []).map((entry) => String(entry.target_id)));
        const hasUnknownOutcomes = Boolean(result.error) || reportedIds.size < targets.length;
        setRuntime((current) => {
          const next = { ...current };
          targets.forEach((target) => {
            const prior = next[String(target.id)];
            if (["queued", "running"].includes(statusKey(prior?.status))) {
              next[String(target.id)] = {
                ...prior,
                target_id: target.id,
                status: hasUnknownOutcomes ? "unknown" : "cancelled",
                ...(hasUnknownOutcomes ? { error: "Status unknown. Check Messages before retrying." } : {}),
              };
            }
          });
          return next;
        });
        setSendStatus(hasUnknownOutcomes ? "unknown" : "cancelled");
        setRunNote(hasUnknownOutcomes
          ? "Send stopped with unknown outcomes. Check Messages before retrying."
          : "Send stopped. Review completed and cancelled athletes below.");
      } else {
        const successful = (result.results || []).filter((entry) => isSuccessfulStatus(entry.status)).length;
        const failed = targets.length - successful;
        if (failed) {
          setSendStatus("failed");
          setRunNote(`Send finished: ${successful} submitted to Messages, ${failed} failed.`);
        } else if (result.dryRun) {
          setSendStatus("complete");
          setRunNote(`Dry run complete: ${successful} text${successful === 1 ? "" : "s"} simulated.`);
        } else {
          setSendStatus("complete");
          setRunNote(`Send complete: ${successful} text${successful === 1 ? "" : "s"} submitted to Messages.`);
        }
      }
    } catch (sendError) {
      setRuntime((current) => Object.fromEntries(Object.entries(current).map(([id, result]) => [id,
        ["queued", "running"].includes(statusKey(result.status))
          ? { ...result, status: "unknown", error: `Status unknown: ${sendError.message}` }
          : result,
      ])));
      setSendStatus("failed");
      setError(sendError.message);
      setRunNote("The send connection failed. Check Messages before retrying any athlete with an unknown status.");
      try {
        const state = await api("/api/send/status");
        if (state.active) {
          setSendStatus(statusKey(state.status));
          setRunNote("A send is still active. Use Pause or Stop before retrying.");
        }
      } catch {
        // Keep the unknown result state when the status endpoint is also unavailable.
      }
    } finally {
      setSendPending(false);
    }
  }

  async function control(action) {
    if (controlBusy) return;
    setControlBusy(true);
    setError("");
    const expected = action === "pause" ? "pausing" : action === "resume" ? "resuming" : "stopping";
    try {
      const state = await api(`/api/send/${action}`, { method: "POST" });
      setSendStatus(statusKey(state.status || expected));
      setRunNote(action === "pause" ? "Pausing at the next safe point…" : action === "resume" ? "Resuming the send…" : "Stopping after the current text…");
    } catch (controlError) {
      setError(controlError.message);
      await getSendStatus();
    } finally {
      setControlBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-copy">
          <span className="brand-mark" aria-hidden="true">T</span>
          <div>
            <p className="eyebrow">TeamText</p>
            <h1>Roster texts, made simple.</h1>
            <p>Upload a roster, narrow the recipients, write one personalized template, and send.</p>
          </div>
        </div>
        <div className="compact-totals" aria-label="Roster totals">
          <div><strong>{rows.length}</strong><span>Uploaded</span></div>
          <div><strong>{filteredRows.length}</strong><span>Matching</span></div>
          <div><strong>{ready.length}</strong><span>Ready</span></div>
        </div>
      </header>

      {(error || notice) && <div className={`notice ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error || notice}</div>}

      {active && !rows.length && <section className="card active-run-card" aria-labelledby="active-run-title">
        <div>
          <p className="step-label">Active batch</p>
          <h2 id="active-run-title">An existing text batch is {statusText(sendStatus).toLowerCase()}.</h2>
          <p>{runNote || "You can pause, resume, or stop it here even though this page was reloaded."}</p>
        </div>
        <div className="button-row">
          <button type="button" className="pause-button" onClick={() => control(sendStatus === "paused" ? "resume" : "pause")} disabled={pauseControlDisabled}>{pauseControlLabel}</button>
          <button type="button" className="stop-button" onClick={() => control("cancel")} disabled={stopControlDisabled}>{sendStatus === "stopping" ? "Stopping…" : "Stop"}</button>
        </div>
      </section>}

      <section className="card upload-card" aria-labelledby="upload-title">
        <div className="section-heading">
          <div><p className="step-label">01 · Roster</p><h2 id="upload-title">Upload your roster</h2><p>CSV, XLS, or XLSX. A new upload replaces the current roster for this session.</p></div>
          {fileName && <span className="file-pill">{fileName}</span>}
        </div>
        <div className="upload-controls">
          <label className="file-input-label" htmlFor="roster-file">
            <span>{uploading ? "Reading roster…" : rows.length ? "Replace roster" : "Choose roster file"}</span>
            <input id="roster-file" type="file" accept=".csv,.xls,.xlsx" onChange={upload} disabled={uploading || active} />
          </label>
          {!!columns.length && <div className="mapping-controls">
            <label htmlFor="name-column">Athlete name column
              <select id="name-column" value={nameColumn} onChange={(event) => { setNameColumn(event.target.value); resetResults(); }} disabled={locked}>
                {columns.map((column) => <option value={column} key={column}>{column}</option>)}
              </select>
            </label>
            <label htmlFor="phone-column">Text number column (separate group members with ; or ,)
              <select id="phone-column" value={phoneColumn} onChange={(event) => { setPhoneColumn(event.target.value); resetResults(); }} disabled={locked}>
                <option value="" disabled>Choose a text number column…</option>
                {columns.map((column) => <option value={column} key={column}>{column}</option>)}
              </select>
            </label>
          </div>}
        </div>
      </section>

      {!!rows.length && <section className="card roster-card" aria-labelledby="filter-title">
        <div className="section-heading">
          <div><p className="step-label">02 · Recipients</p><h2 id="filter-title">Filter the roster</h2><p>Every filter intersects. Matching checked rows become recipients automatically.</p></div>
          <div className="recipient-count"><strong>{recipientRows.length}</strong><span>included of {filteredRows.length} matches</span></div>
        </div>

        <div className="filter-stack" aria-label="Roster filters">
          {filters.map((filter) => <div className="filter-row" key={filter.id}>
            <label><span className="sr-only">Filter column</span><select value={filter.column} onChange={(event) => updateFilter(filter.id, { column: event.target.value })} disabled={locked}>
              {columns.map((column) => <option value={column} key={column}>{column}</option>)}
            </select></label>
            <label><span className="sr-only">Filter operator</span><select value={filter.operator} onChange={(event) => updateFilter(filter.id, { operator: event.target.value })} disabled={locked}>
              {OPERATORS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
            {filter.operator === "not_blank" ? <span className="filter-hint">Any non-empty value</span>
              : filter.operator === "between" ? <div className="range-inputs">
                <label><span className="sr-only">Range start</span><input value={filter.value} onChange={(event) => updateFilter(filter.id, { value: event.target.value })} placeholder="From" disabled={locked} /></label>
                <span>to</span>
                <label><span className="sr-only">Range end</span><input value={filter.endValue} onChange={(event) => updateFilter(filter.id, { endValue: event.target.value })} placeholder="Through" disabled={locked} /></label>
              </div>
              : <label><span className="sr-only">Filter value</span><input value={filter.value} onChange={(event) => updateFilter(filter.id, { value: event.target.value })} placeholder={filter.operator === "one_of" ? "Value one, value two" : "Type to filter"} disabled={locked} /></label>}
            <button type="button" className="icon-button" onClick={() => removeFilter(filter.id)} aria-label={`Remove ${filter.column} filter`} disabled={locked}>×</button>
          </div>)}
          <button type="button" className="secondary add-filter" onClick={addFilter} disabled={locked}>+ Add filter</button>
        </div>

        <div className="table-shell">
          <table>
            <thead><tr><th scope="col" className="include-column">Include</th>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{filteredRows.map((row) => {
              const label = clean(row.values[nameColumn]) || `spreadsheet row ${row.sourceRow}`;
              return <tr key={row.id} className={excluded.has(row.id) ? "excluded" : ""}>
                <td className="include-column"><input type="checkbox" checked={!excluded.has(row.id)} onChange={() => toggleRow(row.id)} aria-label={`Include ${label}`} disabled={locked} /></td>
                {columns.map((column) => <td key={column}>{row.values[column] || <span className="blank-cell">—</span>}</td>)}
              </tr>;
            })}</tbody>
          </table>
          {!filteredRows.length && <div className="empty-state">No roster rows match every active filter.</div>}
        </div>
      </section>}

      {!!rows.length && <section className="card compose-card" aria-labelledby="compose-title">
        <div className="section-heading">
          <div><p className="step-label">03 · Message</p><h2 id="compose-title">Create your text template</h2><p>The template and results stay only in this browser session.</p></div>
          <span className="ready-pill">{ready.length} ready to text</span>
        </div>
        <div className="template-fields">
          <label htmlFor="template-name">Template name
            <input id="template-name" value={templateName} onChange={(event) => { setTemplateName(event.target.value); resetResults(); }} placeholder="Practice reminder" disabled={locked} />
          </label>
          <label htmlFor="template-body" className="message-field">Message
            <textarea ref={messageRef} id="template-body" rows={7} value={templateBody} onChange={(event) => { setTemplateBody(event.target.value); resetResults(); }} placeholder="Hi {{parent_name}}, practice for {{athlete_names}} starts at 5:00 today." disabled={locked} />
          </label>
        </div>

        <fieldset className="delivery-mode" disabled={locked}>
          <legend>Delivery mode</legend>
          <div className="mode-options">
            <label className={deliveryMode === "individual" ? "selected" : ""}>
              <input
                type="radio"
                name="delivery-mode"
                value="individual"
                checked={deliveryMode === "individual"}
                onChange={() => { setDeliveryMode("individual"); resetResults(); }}
              />
              <span><strong>One text per athlete</strong><small>Multiple numbers in one cell receive a single group text.</small></span>
            </label>
            <label className={deliveryMode === "household" ? "selected" : ""}>
              <input
                type="radio"
                name="delivery-mode"
                value="household"
                checked={deliveryMode === "household"}
                onChange={() => { setDeliveryMode("household"); resetResults(); }}
              />
              <span><strong>One text per household</strong><small>Rows with the same complete set of numbers are combined.</small></span>
            </label>
          </div>
        </fieldset>

        {hasGroupTexts && <div className="group-warning" role="note">
          <strong>Group text visibility:</strong> Everyone in a group can see the other recipients, and replies may go to everyone.
        </div>}

        <div className="merge-fields"><span>Insert roster field</span><div>
          {columns.map((column) => <button type="button" className="merge-chip" key={column} onClick={() => insertField(column)} disabled={locked} title={`Insert {{${tokens[column]}}}`}>{column}</button>)}
          <button type="button" className="merge-chip system-chip" onClick={() => insertToken("athlete_names")} disabled={locked} title="Insert {{athlete_names}}">Athlete names</button>
          <button type="button" className="merge-chip system-chip" onClick={() => insertToken("athlete_count")} disabled={locked} title="Insert {{athlete_count}}">Athlete count</button>
        </div></div>

        <div className="send-controls">
          <div><strong>{templateName.trim() || "Untitled message"}</strong><p>{ready.length} ready · {summaries.length - ready.length} will be skipped</p></div>
          <div className="button-row">
            <button type="button" className="primary" onClick={send} disabled={!ready.length || locked}>{active ? activeButtonText(sendStatus) : `Send ${ready.length} text${ready.length === 1 ? "" : "s"}`}</button>
            {active && <>
              <button type="button" className="pause-button" onClick={() => control(sendStatus === "paused" ? "resume" : "pause")} disabled={pauseControlDisabled}>{pauseControlLabel}</button>
              <button type="button" className="stop-button" onClick={() => control("cancel")} disabled={stopControlDisabled}>{sendStatus === "stopping" ? "Stopping…" : "Stop"}</button>
            </>}
          </div>
        </div>

        <section className="message-summary" aria-labelledby="summary-title">
          <div className="summary-heading">
            <div><h3 id="summary-title">Message summary</h3><p>One personalized preview and send status for every {deliveryMode === "household" ? "household recipient group" : "included athlete"}.</p></div>
            <span className={`run-status status-${statusKey(sendStatus)}`} role="status" aria-live="polite">{runNote || (active ? statusText(sendStatus) : "Ready when you are")}</span>
          </div>
          <div className="summary-list">
            {summaries.map((summary) => {
              const result = runtime[String(summary.id)];
              const status = summary.issues.length ? "skipped" : result?.status || "ready";
              const normalizedStatus = statusKey(status);
              const fallbackDetail = isSuccessfulStatus(normalizedStatus)
                ? normalizedStatus === "simulated" ? "Dry run only" : "Submitted to Messages"
                : ["cancelled", "failed", "stopping"].includes(normalizedStatus)
                  ? "Not sent"
                  : "Ready to send";
              return <article className="summary-row" key={summary.id}>
                <div className="summary-recipient"><strong>{summary.name}</strong><span>{summary.address || "No text number"}{deliveryMode === "household" && summary.rows.length > 1 ? ` · ${summary.athleteCount} athletes` : ""}{summary.recipientCount > 1 ? ` · ${summary.recipientCount} recipients · group text` : ""}</span></div>
                <span className={`status-pill status-${statusKey(status)}`}>{statusText(status)}</span>
                <p className="summary-message">{summary.body || "Message is blank."}</p>
                <small className={summary.issues.length || result?.error ? "summary-error" : ""}>{summary.issues.join(" · ") || result?.error || result?.sent_at || fallbackDetail}</small>
              </article>;
            })}
            {!summaries.length && <div className="empty-state">No included athletes match the current filters.</div>}
          </div>
        </section>
      </section>}
    </main>
  );
}

export default App;
