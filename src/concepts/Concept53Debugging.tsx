import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import type { Bundle, TraceRow } from "../../server/debugging/trace";

const labels: Record<string, string> = { success: "Successful file check", denied: "Permission denied by a hook", missing: "Read a missing file", "max-turns": "Exhaust the turn limit", startup: "Process cannot start", "api-error": "API error with success subtype", truncated: "Stream ends without a result" };
type Facts = { scenarios: string[]; liveScenarios: string[]; model: string; timeoutMs: number };

export function Concept53Debugging() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("offline");
  const [scenario, setScenario] = useState("denied");
  const [debug, setDebug] = useState(true);
  const [maxTurns, setMaxTurns] = useState(4);
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [toolId, setToolId] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void Promise.all([fetch("/api/c53/facts", { signal: abort.signal }), fetch("/api/c53/code", { signal: abort.signal })])
      .then(async (responses) => {
        if (responses.some((r) => !r.ok)) throw new Error("Lesson 53 backend is unavailable. Run npm run dev from sample53 and retry.");
        const [info, sources] = await Promise.all(responses.map((r) => r.json()));
        if (!abort.signal.aborted) { setFacts(info); setCode(sources); }
      }).catch((e) => { if (!abort.signal.aborted) setError(String(e)); });
    return () => { abort.abort(); abortRef.current?.abort(); };
  }, [attempt]);

  async function run() {
    const abort = new AbortController(); abortRef.current = abort;
    setBusy(true); setRows([]); setBundle(null); setRunId(""); setError(""); setToolId(""); setFilter("all");
    try {
      await streamPost("/api/c53/run", { mode, scenario, debug, maxTurns }, (event, data) => {
        if (abort.signal.aborted) return;
        if (event === "start") setRunId(data.id);
        else if (event === "trace") setRows((all) => [...all, data]);
        else if (event === "bundle") setBundle(data);
        else if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { if (!abort.signal.aborted) setError(String(e)); }
    finally { if (!abort.signal.aborted) setBusy(false); if (abortRef.current === abort) abortRef.current = null; }
  }
  function stop() { abortRef.current?.abort(); setBusy(false); setError("Run stopped. Partial evidence is shown; recover the saved bundle after the backend finishes cancellation."); }
  async function recover() {
    setError("");
    try {
      const response = await fetch(`/api/c53/runs/${runId}`);
      if (!response.ok) throw new Error(response.status === 404 ? "Bundle is not saved yet. Retry shortly." : `HTTP ${response.status}`);
      const saved: Bundle = await response.json(); setBundle(saved); setRows(saved.rows);
    } catch (e) { setError(String(e)); }
  }
  function download() {
    if (!bundle) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `debug-${bundle.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  const visible = rows.filter((row) => (filter === "all" || row.layer === filter) && (!toolId || row.toolUseId === toolId || JSON.stringify(row.data).includes(toolId)));
  const result = [...rows].reverse().find((row) => row.kind === "result");
  const session = rows.find((row) => row.kind === "init");

  return <section>
    <h2>53. Debugging an agent run</h2>
    <p className="lead">Reproduce a failure, locate the first useful evidence, and change one thing before running again.</p>
    <div className="offline-boundaries">
      <div className="card"><b>SDK messages</b><p>What the agent requested and received; init, assistant, tool results, final result and thrown errors.</p></div>
      <div className="card"><b>Hooks & permissions</b><p>Why an action was allowed or denied, and whether the tool itself failed. Match calls using tool_use_id.</p></div>
      <div className="card"><b>Process diagnostics</b><p>stderr and optional CLI debug logs help explain failures before the first SDK message.</p></div>
    </div>
    <h3>A · Reproduce a controlled run</h3>
    <p>Offline replays make no model calls. Live runs start Claude Code with only Read, an isolated working folder and a 60-second host deadline. Live outcomes can vary.</p>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}
    <div className="form-grid">
      <label>Run mode<select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value); if (e.target.value === "live" && !facts?.liveScenarios.includes(scenario)) setScenario("success"); }}>
        <option value="offline">Offline · synthetic evidence · free</option><option value="live">Live · model authentication required · incurs API cost</option>
      </select></label>
      <label>Scenario<select value={scenario} disabled={busy} onChange={(e) => setScenario(e.target.value)}>
        {(mode === "live" ? facts?.liveScenarios ?? [] : facts?.scenarios ?? Object.keys(labels)).map((id) => <option key={id} value={id}>{labels[id]}</option>)}
      </select></label>
      <label>Turn limit<select value={scenario === "max-turns" ? 1 : mode === "offline" ? 4 : maxTurns} disabled={busy || mode === "offline" || scenario === "max-turns"} onChange={(e) => setMaxTurns(Number(e.target.value))}>
        {[1, 2, 4, 8].map((n) => <option value={n} key={n}>{n}</option>)}
      </select></label>
    </div>
    <label className="check"><input type="checkbox" checked={mode === "live" && debug} disabled={busy || mode === "offline"} onChange={(e) => setDebug(e.target.checked)} />Capture CLI debug file in live runs</label>
    <p className="hint">The turn-limit scenario always uses maxTurns = 1. “Denied” returns a hook denial; “missing” allows Read but requests an absent file. These failures belong to different layers.</p>
    <div className="row"><button className="primary" disabled={busy || !facts} onClick={run}>{busy ? "Collecting evidence…" : mode === "live" ? "Run live diagnostic (uses API)" : "Replay offline"}</button>{busy && <button onClick={stop}>Stop</button>}</div>
    <h3>B · Inspect the timeline</h3>
    <div className="card" aria-live="polite"><b>{bundle ? "Diagnostics saved" : busy ? "Run in progress" : rows.length ? "Partial diagnostics" : "No run yet"}</b>
      {runId && <p>Run: <code>{runId}</code></p>}
      {session && <p>Session: <code>{(session.data as any)?.session_id}</code></p>}
      {result && <p>Terminal subtype: <code>{(result.data as any)?.subtype}</code> · is_error: <code>{String((result.data as any)?.is_error)}</code> · cost: ${(Number((result.data as any)?.total_cost_usd ?? 0)).toFixed(4)}{bundle?.mode === "offline" ? " (synthetic)" : ""}</p>}
      {runId && !busy && <div className="row"><button onClick={recover}>Recover saved bundle</button><button disabled={!bundle} onClick={download}>Download diagnostics JSON</button></div>}
    </div>
    <div className="form-grid">
      <label>Evidence layer<select value={filter} onChange={(e) => setFilter(e.target.value)}>{["all", "host", "sdk", "hook", "permission", "stderr"].map((layer) => <option key={layer} value={layer}>{layer}</option>)}</select></label>
      <label>Correlate tool_use_id<input value={toolId} onChange={(e) => setToolId(e.target.value)} placeholder="Paste an ID from a tool_use block" /></label>
    </div>
    <p className="hint">{visible.length} of {rows.length} entries. Times measure arrival at the host; hooks and streamed messages may interleave. Expand an entry to inspect the evidence.</p>
    <div className="log debug-timeline">{visible.map((row) => <details key={row.seq} id={`debug-event-${row.seq}`}>
      <summary><code>#{row.seq} · +{row.elapsedMs} ms</code> <span className="tag">{row.layer}</span> {row.kind}{row.toolUseId && <span className="subtype">{row.toolUseId}</span>}</summary>
      <pre className="wrap">{typeof row.data === "string" ? row.data : JSON.stringify(row.data, null, 2)}</pre>
    </details>)}</div>
    <h3>C · Follow the evidence</h3>
    {!bundle && <p className="hint">Complete a run or recover its bundle to see diagnosis suggestions.</p>}
    {bundle?.findings.map((finding) => <div className="card" key={finding.title}><b>{finding.title}</b><p>{finding.next}</p><div className="row">{finding.evidence.map((seq) => <button key={seq} onClick={() => { setFilter("all"); setToolId(""); requestAnimationFrame(() => { const entry = document.getElementById(`debug-event-${seq}`) as HTMLDetailsElement | null; if (entry) { entry.open = true; entry.scrollIntoView({ behavior: "smooth", block: "center" }); } }); }}>Evidence #{seq}</button>)}</div></div>)}
    {bundle && <><details className="card"><summary>Effective run options</summary><pre className="wrap">{JSON.stringify(bundle.config, null, 2)}</pre></details>
      <details className="card"><summary>CLI debug log (bounded, redacted preview)</summary><pre className="wrap">{bundle.debugLog}</pre></details><p className="hint">{bundle.limitations}</p></>}
    <h3>D · Fix one cause, then verify</h3>
    <ol className="steps"><li>Record the prompt, selected model, cwd, tool scope and limits. Preserve the failing evidence.</li><li>Find the first denial, tool error, API error or process failure. Distinguish this from the final symptom.</li><li>For the denied or missing fixture, rerun “Successful file check” as a controlled comparison. For the turn limit, select success and increase the limit. Fresh runs get fresh sessions.</li><li>Verify the file evidence and final result together, then add an offline regression test (lesson 51) and a task eval (lesson 52).</li></ol>
    <p>Changing maxTurns can help diagnose a limit but will not repair a denied path or a missing file. A successful SDK result can still contain an incorrect answer.</p>
    <h3>E · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">Reference: <a href="https://platform.claude.com/docs/en/agent-sdk/typescript" target="_blank" rel="noreferrer">Claude Agent SDK TypeScript reference</a>. This lab uses debugFile, stderr, hooks and SDK messages; source types are checked against the installed SDK.</p>
  </section>;
}
