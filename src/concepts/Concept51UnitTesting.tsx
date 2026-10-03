import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";

type CaseInfo = { id: string; name: string; group: string; purpose: string };
type CaseResult = Omit<CaseInfo, "purpose"> & { passed: boolean; durationMs: number; error?: string };
type Summary = { passed: number; failed: number; total: number; durationMs: number; modelApiCalls: number };
type ReplayResult = { status: string; text: string; sessionId?: string; costUsd: number; summary?: unknown; error?: string };
type Facts = { cases: CaseInfo[]; scenarios: string[]; command: string; boundary: string };
const scenarioLabels: Record<string, string> = {
  success: "Stream + complete reply + structured result", complete: "Complete reply without deltas", subagent: "Subagent output mixed with customer output",
  budget: "Budget exhausted", apiError: "Success subtype, but is_error = true", invalid: "Invalid structured output", truncated: "Stream ends without a result",
  throw: "Iterator throws", wait: "Waiting stream times out after 1 second",
};

export function Concept51UnitTesting() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [source, setSource] = useState("host.ts");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [group, setGroup] = useState("all");
  const [mutation, setMutation] = useState(false);
  const [results, setResults] = useState<CaseResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [running, setRunning] = useState(false);
  const [scenario, setScenario] = useState("success");
  const [replaying, setReplaying] = useState(false);
  const [deltas, setDeltas] = useState("");
  const [fixture, setFixture] = useState<unknown>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busy = running || replaying;

  useEffect(() => {
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseRetry: (() => void) | undefined;
    setLoading(true);
    setError(null);
    async function load() {
      for (let attempt = 0; attempt < 6 && !abort.signal.aborted; attempt++) {
        try {
          const responses = await Promise.all([fetch("/api/c51/facts", { signal: abort.signal }), fetch("/api/c51/code", { signal: abort.signal })]);
          for (const response of responses) {
            if (response.status === 404) throw new Error("Lesson 51 is missing from the running backend. Restart npm run dev from the sample51 folder, then retry.");
            if (!response.ok) throw new Error(`Lesson 51: HTTP ${response.status}. The backend on port 3001 may be restarting. Retry once it is ready.`);
          }
          const [info, sources] = await Promise.all(responses.map((r) => r.json()));
          if (!abort.signal.aborted) { setFacts(info); setCode(sources); setLoading(false); }
          return;
        } catch (e) {
          if (abort.signal.aborted) return;
          if (attempt === 5) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); return; }
        }
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
          retryTimer = setTimeout(resolve, 1000);
        });
      }
    }
    void load();
    return () => {
      abort.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      releaseRetry?.();
      abortRef.current?.abort();
    };
  }, [loadAttempt]);

  async function runSuite() {
    setRunning(true); setError(null); setResults([]); setSummary(null);
    const abort = new AbortController(); abortRef.current = abort;
    try {
      await streamPost("/api/c51/run", { group, mutation }, (event, data) => {
        if (event === "case") setResults((all) => [...all, data]);
        else if (event === "summary") setSummary(data);
        else if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { if (!abort.signal.aborted) setError(String(e)); }
    finally { setRunning(false); abortRef.current = null; }
  }

  async function replayFixture() {
    setReplaying(true); setError(null); setDeltas(""); setReplay(null); setFixture(null);
    const abort = new AbortController(); abortRef.current = abort;
    try {
      await streamPost("/api/c51/replay", { scenario, mutation }, (event, data) => {
        if (event === "fixture") setFixture(data);
        else if (event === "delta") setDeltas((text) => text + data.text);
        else if (event === "result") setReplay(data);
        else if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { if (!abort.signal.aborted) setError(String(e)); }
    finally { setReplaying(false); abortRef.current = null; }
  }

  return (
    <section>
      <h2>51. Unit-testing agents without the API</h2>
      <p className="lead">Test the code around the model with real assertions, isolated data and synthetic messages. Every exercise here runs locally with zero model API calls and no API key.</p>
      {loading && <p className="hint" role="status">Connecting to the lesson server…</p>}
      {error && <div className="card warn" role="alert">{error}{!facts && <p><button disabled={loading} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading lesson</button></p>}</div>}

      <h3>A · Choose the test boundary</h3>
      <div className="offline-boundaries">
        <div className="card"><b>Tools & state</b><p>Real capstone MCP tools and zod schemas, called through linked in-memory transports. Each test gets a fresh <code>Store</code>.</p></div>
        <div className="card"><b>Hooks & permissions</b><p>Call the registered callbacks with typed inputs and a deterministic approver. Assert allow/deny decisions and audit effects.</p></div>
        <div className="card"><b>Host & streams</b><p>Inject a <code>QueryPort</code> that yields synthetic SDK message fields. Assert text, failures, cancellation and structured output.</p></div>
      </div>
      <p className="hint">These tests verify application code. Real-model evals from lesson 50 still check whether a model chooses the right tools and follows the policy.</p>

      <h3>B · Run the offline suite</h3>
      <p>Run all {facts?.cases.length ?? "the"} cases or one layer. Expand a result to see its purpose and any failed assertion.</p>
      <div className="form-grid">
        <label>Test layer<select value={group} disabled={busy} onChange={(e) => setGroup(e.target.value)}>
          <option value="all">All layers</option><option value="tools">Tools & state</option><option value="policy">Hooks & permissions</option><option value="streams">Host & streams</option>
        </select></label>
      </div>
      <label className="check"><input type="checkbox" checked={mutation} disabled={busy} onChange={(e) => setMutation(e.target.checked)} />Inject a bug: append the complete assistant text after its streamed deltas</label>
      <p className="hint">With the bug enabled, “Streamed text is not duplicated” should fail. Tools and policy tests should still pass. Disable the bug and rerun to restore a green suite.</p>
      <div className="row"><button className="primary" disabled={busy || !facts} onClick={runSuite}>{running ? "Running tests…" : "Run offline tests"}</button>
        {busy && <button onClick={() => abortRef.current?.abort()}>Stop</button>}</div>
      <div aria-live="polite">
        {summary && <div className={`card ${summary.failed ? "warn" : "offline-passed"}`}><b>{summary.passed}/{summary.total} passed</b> · {summary.failed} failed · {summary.durationMs.toFixed(0)} ms · {summary.modelApiCalls} model API calls</div>}
        {results.map((result) => <details className={`card offline-case ${result.passed ? "offline-passed" : "warn"}`} key={result.id}>
          <summary><span className={`tag ${result.passed ? "st-completed" : "tag-error"}`}>{result.passed ? "PASS" : "FAIL"}</span> {result.name} <span className="subtype">{result.durationMs.toFixed(1)} ms</span></summary>
          <p>{facts?.cases.find((c) => c.id === result.id)?.purpose}</p>
          {result.error && <pre className="wrap">{result.error}</pre>}
        </details>)}
      </div>

      <h3>C · Replay a synthetic stream</h3>
      <p>A fake async generator controls every message. Select an edge case and compare the streamed preview with the host’s terminal state.</p>
      <label>Fixture<select value={scenario} disabled={busy} onChange={(e) => setScenario(e.target.value)}>
        {(facts?.scenarios ?? Object.keys(scenarioLabels)).map((id) => <option key={id} value={id}>{scenarioLabels[id]}</option>)}
      </select></label>
      <button disabled={busy || !facts} onClick={replayFixture}>{replaying ? "Replaying…" : "Replay fixture"}</button>
      <div className="compare-grid">
        <div className="card"><b>Streamed preview</b><p className="snippet">{deltas || "No text deltas received."}</p></div>
        <div className="card"><b>Host result</b>{replay ? <><p><span className="tag">{replay.status}</span> · ${replay.costUsd.toFixed(4)} simulated cost</p><pre className="wrap">{JSON.stringify(replay, null, 2)}</pre></> : <p className="hint">Replay a fixture to inspect the result.</p>}</div>
      </div>
      {fixture !== null && <details className="card"><summary>Inspect synthetic messages</summary><pre className="wrap">{JSON.stringify(fixture, null, 2)}</pre></details>}

      <h3>D · Read the executable code</h3>
      <p>The UI and the command-line tests use the same assertions. The Node runner also demonstrates a 60-second timeout using virtual time and verifies that the deliberate mutation is detected.</p>
      <label>Source file<select value={source} onChange={(e) => setSource(e.target.value)}>{Object.keys(code).map((file) => <option key={file} value={file}>{file}</option>)}</select></label>
      <details className="card"><summary>Show {source}</summary><pre className="wrap">{code[source] ?? "Loading source…"}</pre></details>
      <div className="card"><b>Run from a terminal (Node 24)</b><pre className="wrap">{facts?.command ?? "npm run test:offline"}</pre><p className="hint">No web server, .env file, login or model API key is needed for this command.</p></div>

      <h3>E · What a green suite proves</h3>
      <ul>
        <li>Tool schemas reject invalid inputs; tenant boundaries and refund balance checks hold.</li>
        <li>Your hook and permission functions return the expected decisions and audit entries.</li>
        <li>Your host handles repeated text, subagent output, terminal errors, missing results and cancellation.</li>
      </ul>
      <p>It does not prove that Claude will choose a refund, that Claude Code will schedule callbacks correctly, or that a provider will accept your request. Keep a smaller set of live integration tests and effect-based model evals for those boundaries.</p>
      <p className="hint">Reference: <a href="https://nodejs.org/docs/latest-v24.x/api/test.html" target="_blank" rel="noreferrer">Node test runner and mock timers</a>. Fixture field types are checked against the installed Claude Agent SDK.</p>
    </section>
  );
}
