import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Fault = "529" | "429" | "500" | "401" | "400" | "drop" | "hang";
type Plan = {
  faults: Fault[];
  repeatLast?: boolean;
  onlyPrimary?: boolean;
  retryAfter?: number;
  maxRetries?: number;
  apiTimeoutMs?: number;
  fallbackModel?: boolean;
  badModel?: boolean;
  hostRetries?: number;
};

// Part A: API failures, made by the fault proxy. Each preset is a fault plan sent to POST /api.
const apiScenarios: { label: string; hint: string; plan: Plan }[] = [
  {
    label: "1 · 529 twice: Claude Code retries",
    hint: "The proxy answers the first two main-loop requests with 529 overloaded_error. Claude Code retries by itself: one system/api_retry per failure, with a growing delay (~0.5 s, ~1 s). The third request reaches the API and the run succeeds. Your code did nothing. Under $0.01.",
    plan: { faults: ["529", "529"] },
  },
  {
    label: "2 · 429 with retry-after",
    hint: "A 429 rate_limit_error with the header retry-after: 3. Claude Code honours it: retry_delay_ms is exactly 3000, not its own backoff. Under $0.01.",
    plan: { faults: ["429"], retryAfter: 3 },
  },
  {
    label: "3 · Dropped connection",
    hint: "The proxy closes the socket without an answer. There is no HTTP status, so api_retry has error_status: null and error: 'unknown'. Retried like a 529. Under $0.01.",
    plan: { faults: ["drop"] },
  },
  {
    label: "4 · The retries run out",
    hint: "500 on every request, with CLAUDE_CODE_MAX_RETRIES=2. After 2 retries Claude Code gives up. Look at the shape: a SYNTHETIC assistant message (model <synthetic>, error: server_error), the StopFailure hook, a result with subtype 'success' but is_error: true and terminal_reason 'api_error', and then the iterator THROWS. $0 for the model; the side call costs ~$0.001.",
    plan: { faults: ["500"], repeatLast: true, maxRetries: 2 },
  },
  {
    label: "5 · 400: not retried",
    hint: "An invalid_request_error is not transient, so there is no api_retry at all: the synthetic message, StopFailure and the error result come at once. The verdict says 'fix first'. $0.",
    plan: { faults: ["400"] },
  },
  {
    label: "6 · A request that never answers",
    hint: "The proxy accepts the request and never replies. Without API_TIMEOUT_MS Claude Code waited about 6 minutes (360 s) in the probe. With API_TIMEOUT_MS=4000 and 1 retry: api_retry after 4 s (status null), then 'Request timed out' after ~9 s. CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS did NOT shorten it. $0.",
    plan: { faults: ["hang"], repeatLast: true, apiTimeoutMs: 4000, maxRetries: 1 },
  },
  {
    label: "7 · fallbackModel",
    hint: "529 on every Haiku request only (onlyPrimary), and fallbackModel: 'claude-sonnet-4-5'. After 3 overloaded answers in a row, Claude Code sends system/model_fallback (not in sdk.d.ts) and repeats the request on Sonnet, which works. The result's modelUsage lists both models. About $0.002.",
    plan: { faults: ["529"], repeatLast: true, onlyPrimary: true, fallbackModel: true },
  },
  {
    label: "8 · 401: retried, then fatal",
    hint: "A 401 authentication_error on every request, with 2 retries. Surprise: Claude Code DOES retry a 401 (error: authentication_failed), because a token can be refreshed. When it gives up, the verdict is 'fix first': retrying the same key gives the same answer. $0.",
    plan: { faults: ["401"], repeatLast: true, maxRetries: 2 },
  },
  {
    label: "9 · A model that does not exist",
    hint: "No fault: model 'claude-no-such-model'. The real API answers 404, and the synthetic message has error: model_not_found and a readable text. Not retried. $0.",
    plan: { faults: [], badModel: true },
  },
  {
    label: "10 · The outage outlasts Claude Code: the host resumes",
    hint: "529 three times, and CLAUDE_CODE_MAX_RETRIES=1, so the first query() fails after 2 requests. The verdict is 'resume', so the host waits 2 s and resumes the SAME session with 'Continue'. Request 3 fails too, Claude Code's retry gets through, and the model still knows the code word from the failed turn. About $0.01.",
    plan: { faults: ["529", "529", "529"], maxRetries: 1, hostRetries: 2 },
  },
];

// Part B: failures that are not the API's. Each one is a case for POST /run.
const runCases: { id: string; label: string; hint: string }[] = [
  {
    id: "toolErrors",
    label: "Tool errors",
    hint: "Read missing.txt fails (PostToolUseFailure hook) and Bash is denied by canUseTool (tool_result is_error, and a permission_denials entry in the result). Neither one ends the run: the model reads the error and reads a.txt instead. A tool error is information for the MODEL, not an exception for you. About $0.01.",
  },
  {
    id: "maxTurns",
    label: "maxTurns → resume",
    hint: "maxTurns: 1 stops the run after the first tool round: result error_max_turns, errors ['Reached maximum number of turns (1)'], and the iterator throws. The work is in the session, so the host resumes it with maxTurns: 6 and the model finishes without reading the files again. About $0.01.",
  },
  {
    id: "abort",
    label: "abortController.abort()",
    hint: "abort() 1.5 s into a 250-word poem. With this SDK (0.3.281) the turn is NOT stopped: the poem is written and paid for, the result arrives, and only then does for await throw 'Operation aborted' (an AbortError). Concept 10 saw an immediate kill with an older SDK. About $0.003.",
  },
  {
    id: "interrupt",
    label: "q.interrupt()",
    hint: "The same poem, with streaming input and q.interrupt() at 1.5 s. The turn stops within milliseconds: result error_during_execution, terminal_reason aborted_streaming, $0 for that turn. To stop NOW, interrupt first, then close or abort. $0.",
  },
  {
    id: "badExecutable",
    label: "Bad executable",
    hint: "pathToClaudeCodeExecutable points to a file that does not exist. The iterator throws before any message: 'Claude Code native binary not found at …'. There is no result to read. $0.",
  },
  {
    id: "badCwd",
    label: "cwd does not exist",
    hint: "cwd points to a missing folder. The error is MISLEADING: 'native binary … exists but failed to launch. This usually means the binary does not match this system's libc'. The real cause is the cwd. Check it yourself before calling query(). $0.",
  },
];

// Part D: every failure, what arrives, and what to do.
const table: [string, string, string, string][] = [
  ["529 overloaded, 500, dropped connection", "system/api_retry (error_status null if no answer)", "yes, up to CLAUDE_CODE_MAX_RETRIES (10)", "Nothing. If it still fails: wait, resume the session"],
  ["429 rate limit", "api_retry, retry_delay_ms = retry-after", "yes", "Same. On a claude.ai plan, also watch rate_limit_event (Concept 15)"],
  ["401 authentication", "api_retry with authentication_failed", "yes (a token may refresh)", "Fix the key. Do not retry"],
  ["400 invalid request, 404 model", "No retry. Synthetic message: unknown (text 'API Error: 400') / model_not_found", "no", "Fix the request or the model"],
  ["A request that hangs", "Nothing, for minutes", "only after API_TIMEOUT_MS", "Set API_TIMEOUT_MS"],
  ["Primary model overloaded", "system/model_fallback after 3 × 529", "yes, on fallbackModel", "Set fallbackModel"],
  ["Retries exhausted", "Synthetic assistant (error) → StopFailure → result success + is_error, api_error → throw", "—", "Read the result BEFORE the throw; classify the error code"],
  ["Tool fails or is denied", "tool_result is_error, PostToolUseFailure, permission_denials", "the model decides", "Nothing: the run goes on"],
  ["maxTurns / maxBudgetUsd", "error_max_turns / error_max_budget_usd → throw", "no", "Resume with a larger limit, or ask the user"],
  ["interrupt()", "error_during_execution, aborted_streaming, in ms", "no", "Not a failure"],
  ["abort()", "AbortError, after the running turn ends (0.3.281)", "no", "Interrupt first if you need it to stop now"],
  ["Claude Code cannot start", "A throw before any message", "no", "Check pathToClaudeCodeExecutable and cwd"],
];

const verdictClass: Record<string, string> = { no: "", resume: "st-running", "fix first": "st-failed" };

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "proxy":
            return (
              <div key={i} className={`tool-call proxy ${data.aux ? "observer" : ""} ${data.status && data.status >= 400 ? "denied" : ""}`}>
                <span className="tag tag-proxy">proxy</span> <code>{data.aux ? "side call" : `request ${data.n}`}</code> <span className="subtype">{data.model}</span> {t}
                <div className="snippet">
                  {data.action}
                  {data.status && !String(data.action).startsWith("injected") ? ` → ${data.status}` : ""}
                </div>
              </div>
            );
          case "init":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/init</span> <code>{data.model}</code> {t}
              </div>
            );
          case "apiRetry":
            return (
              <div key={i} className="tool-call retry">
                <span className="tag tag-retry">system/api_retry</span> <code>
                  attempt {data.attempt}/{data.max_retries}
                </code>{" "}
                {t}
                <div className="snippet">
                  error_status: {String(data.error_status)} · error: {data.error} · retry_delay_ms: {data.retry_delay_ms}
                </div>
              </div>
            );
          case "fallback":
            return (
              <div key={i} className="tool-call retry">
                <span className="tag tag-retry">system/model_fallback</span> <code>{data.trigger}</code> {t}
                <div className="snippet">
                  {data.original_model} → {data.fallback_model} · “{data.content}”
                </div>
              </div>
            );
          case "hostRetry":
            return (
              <div key={i} className="tool-call call">
                <span className="tag tag-call">host retry {data.attempt}/{data.of}</span> {t}
                <div className="snippet">
                  wait {data.delayMs} ms, then query({"{"} resume: "{data.resume.slice(0, 8)}…"{data.maxTurns ? `, maxTurns: ${data.maxTurns}` : ""} {"}"})
                </div>
              </div>
            );
          case "call":
            return (
              <div key={i} className="tool-call call">
                <span className="tag tag-call">{data.method}</span> {t}
              </div>
            );
          case "assistant":
            return (
              <div key={i} className={`tool-call ${data.error ? "denied" : ""}`}>
                <span className="tag tag-assistant">assistant</span> {data.error && <code>error: {data.error}</code>} {data.model === "<synthetic>" && <b className="subtype bad">model: &lt;synthetic&gt;</b>} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-pre">tool_use {data.name}</span> {t}
                <div className="snippet">{JSON.stringify(data.input)}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> {data.is_error && <code>is_error</code>} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "hook":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-post">{data.name} hook</span> {t}
                <div className="snippet">
                  {data.name === "StopFailure" ? `error: ${data.error}${data.error_details ? ` · ${data.error_details}` : ""}` : `${data.tool}: ${data.error} · is_interrupt: ${data.is_interrupt}`}
                </div>
              </div>
            );
          case "result":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code> <code className={data.is_error ? "bad" : ""}>is_error: {String(data.is_error)}</code>
                <span className="subtype">
                  terminal_reason {data.terminal_reason ?? "–"} · num_turns {data.num_turns} · ${data.cost.toFixed(4)}
                  {data.permission_denials ? ` · permission_denials ${data.permission_denials}` : ""}
                  {data.models?.length ? ` · modelUsage: ${data.models.join(", ")}` : ""}
                </span>{" "}
                {t}
                {data.errors?.length > 0 && <div className="snippet">errors: {JSON.stringify(data.errors)}</div>}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "finished":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-user">for await ended</span> <span className="subtype">no throw</span> {t}
              </div>
            );
          case "thrown":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">for await threw</span> <code>{data.name}</code> {t}
                <div className="snippet">{data.message}</div>
              </div>
            );
          case "verdict":
            return (
              <div key={i} className="tool-call verdict">
                <span className="tag tag-verdict">classify()</span> <code>{data.where}</code> <code>{data.what}</code>{" "}
                <span className={`tag ${verdictClass[data.retry] ?? ""}`}>retry: {data.retry}</span>
                <div className="snippet">{data.why}</div>
              </div>
            );
          case "error":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">error</span>
                <div className="snippet">{data.message}</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

const FAULTS: Fault[] = ["529", "429", "500", "401", "400", "drop", "hang"];
const num = (v: string) => (v === "" ? undefined : Number(v));

export function Concept28ErrorsRetries() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [options, setOptions] = useState<unknown>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan>({ faults: ["529", "529"] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c28/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c28 — is this sample's server running on port 3001?"));
  }, []);

  async function run(label: string, url: string, body: unknown, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data.options);
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = events.filter((e) => e.event === "result").reduce((s, e) => s + e.data.cost, 0);
  const retries = events.filter((e) => e.event === "apiRetry").length;
  const set = (p: Partial<Plan>) => setPlan({ ...plan, ...p });

  return (
    <section>
      <h2>28 · Errors, retries &amp; recovery</h2>
      <p className="lead">
        A run can fail in the <b>API</b>, in the <b>run</b> or in the <b>process</b>, and each failure reaches your code in a different shape. Some are
        retried by Claude Code before you see anything, some are information for the model, and some end the run. This tab makes each one happen on
        purpose, shows exactly what arrives, and runs a <code>classify()</code> function that decides what the host should do.
      </p>

      <h3>A · API errors, through a fault proxy</h3>
      <p className="hint">
        The lab sets <code>ANTHROPIC_BASE_URL</code> to a small proxy on <code>127.0.0.1</code>. It forwards every request to the real API, except the ones
        its fault plan says to fail. Only main-loop requests count: Claude Code also makes a small side call per run, shown faded. The prompt is always
        “My code word is PELICAN…”, so a resumed session can prove it kept the context.
      </p>
      <div className="scenarios">
        {apiScenarios.map((s) => (
          <button key={s.label} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => (setPlan(s.plan), run(s.label, "/api/c28/api", s.plan, s.hint))}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="card config">
        <label>fault plan (one fault per main-loop request, in order)</label>
        <div className="row">
          {FAULTS.map((f) => (
            <button key={f} disabled={plan.faults.length >= 6} onClick={() => set({ faults: [...plan.faults, f] })}>
              + {f}
            </button>
          ))}
          <button className="link" onClick={() => set({ faults: [] })}>
            clear
          </button>
        </div>
        <div className="row">
          <code>[{plan.faults.join(", ")}]</code>
          <span className="subtype">{plan.repeatLast ? "then the last one forever" : "then forward"}</span>
        </div>
        <div className="form-grid">
          <label className="check">
            <input type="checkbox" checked={!!plan.repeatLast} onChange={(e) => set({ repeatLast: e.target.checked })} /> repeat the last fault
          </label>
          <label className="check">
            <input type="checkbox" checked={!!plan.onlyPrimary} onChange={(e) => set({ onlyPrimary: e.target.checked })} /> fail only Haiku requests
          </label>
          <label className="check">
            <input type="checkbox" checked={!!plan.fallbackModel} onChange={(e) => set({ fallbackModel: e.target.checked })} /> fallbackModel
          </label>
          <label className="check">
            <input type="checkbox" checked={!!plan.badModel} onChange={(e) => set({ badModel: e.target.checked })} /> model that does not exist
          </label>
          <label>
            CLAUDE_CODE_MAX_RETRIES
            <input type="number" min={0} max={10} placeholder="10 (default)" value={plan.maxRetries ?? ""} onChange={(e) => set({ maxRetries: num(e.target.value) })} />
          </label>
          <label>
            API_TIMEOUT_MS
            <input type="number" min={2000} max={60000} step={1000} placeholder="default (5000 with hang)" value={plan.apiTimeoutMs ?? ""} onChange={(e) => set({ apiTimeoutMs: num(e.target.value) })} />
          </label>
          <label>
            429 retry-after (s)
            <input type="number" min={1} max={10} placeholder="none" value={plan.retryAfter ?? ""} onChange={(e) => set({ retryAfter: num(e.target.value) })} />
          </label>
          <label>
            host retries (resume)
            <input type="number" min={0} max={2} placeholder="0" value={plan.hostRetries ?? ""} onChange={(e) => set({ hostRetries: num(e.target.value) })} />
          </label>
        </div>
        <div className="row">
          <button className="primary" disabled={!!running} onClick={() => run("custom plan", "/api/c28/api", plan, null)}>
            {running === "custom plan" ? "Running…" : "Run this plan"}
          </button>
        </div>
      </div>

      <h3>B · Errors that are not the API's</h3>
      <div className="scenarios">
        {runCases.map((c) => (
          <button key={c.id} disabled={!!running} className={running === c.label ? "active" : ""} onClick={() => run(c.label, "/api/c28/run", { case: c.id }, c.hint)}>
            {c.label}
          </button>
        ))}
      </div>

      {hint && <p className="hint">{hint}</p>}
      {(events.length > 0 || running) && (
        <div className="card">
          <b>Events</b>{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · {retries} api_retry · ${cost.toFixed(4)}
          </span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">options sent to query()</summary>
          <pre className="wrap">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["classify", "recovery", "messages", "options", "proxy"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>D · Every failure, and what to do</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>failure</th>
            <th>what your code sees</th>
            <th>Claude Code retries?</th>
            <th>the host should</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([f, s, r, d]) => (
            <tr key={f}>
              <td>
                <code>{f}</code>
              </td>
              <td>{s}</td>
              <td>{r}</td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
