import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5-5";
const models = [HAIKU, SONNET, OPUS];

export function Concept15CostUsage() {
  return (
    <section>
      <h2>15 · Cost &amp; usage tracking</h2>
      <p className="lead">
        Every run already reports what it cost: <code>total_cost_usd</code>, <code>usage</code> and{" "}
        <code>modelUsage</code> on the <code>result</code>, <code>usage</code> on each assistant message. They do not all
        count the same calls, and some are not final. This tab shows which number to read, how to stop a run that costs
        too much, and how to keep a running meter in a live session.
      </p>
      <OneRun />
      <hr />
      <Limits />
      <hr />
      <LiveMeter />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared: reading the numbers out of the raw messages
// ---------------------------------------------------------------------------------------------

type Run = { messages: any[]; error?: string; running: boolean };

const usd = (n?: number) => (n === undefined ? "?" : `$${n.toFixed(4)}`);
const num = (n?: number) => (n === undefined ? "?" : n.toLocaleString("en-US"));
// Plan utilization comes in two units: rate_limit_event says 0.95 (a fraction), usage_EXPERIMENTAL…() says 95 (a percent).
// Both are shown as a whole percent.
const pct = (percent?: number | null) => (percent == null ? "?" : `${Math.round(percent)}%`);

/** Streams one /run into a Run. `update` is called with the new state after every event. */
async function startRun(body: object, update: (fn: (r: Run) => Run) => void) {
  update(() => ({ messages: [], running: true }));
  try {
    await streamPost("/api/c15/run", body, (event, data) => {
      if (event === "message") update((r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}

/**
 * One row per API call. While a response streams, the CLI emits one assistant message per content block, and they all
 * share message.id and the same (not final) usage. Counting each message would count the same call several times.
 */
function apiCalls(messages: any[]) {
  type Call = { id: string; model: string; blocks: string[]; usage: any; subagent: boolean };
  const calls = new Map<string, Call>();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    const call: Call = calls.get(m.message.id) ?? { id: m.message.id, model: m.message.model, blocks: [], usage: m.message.usage, subagent: m.parent_tool_use_id !== null };
    call.blocks.push(...m.message.content.map((b: any) => (b.type === "tool_use" ? `tool_use(${b.name})` : b.type)));
    calls.set(m.message.id, call);
  }
  return [...calls.values()];
}

/** modelUsage is keyed by model. This adds the entries up, so it can be compared with result.usage. */
function sumModelUsage(modelUsage: Record<string, any> = {}) {
  const all = Object.values<any>(modelUsage);
  const sum = (k: string) => all.reduce((s, u) => s + (u[k] ?? 0), 0);
  return {
    input: sum("inputTokens"),
    cacheWrite: sum("cacheCreationInputTokens"),
    cacheRead: sum("cacheReadInputTokens"),
    output: sum("outputTokens"),
    thinking: sum("thinkingTokens"),
    cost: sum("costUSD"),
  };
}

/** The rate-limit window of the latest rate_limit_event (claude.ai login only). */
function RateLimit({ messages }: { messages: any[] }) {
  const info = messages.filter((m) => m.type === "rate_limit_event").at(-1)?.rate_limit_info;
  if (!info) return <div className="hint">No <code>rate_limit_event</code> (normal with an API key: plan limits do not apply).</div>;
  // unifiedWindows is not in the SDK types, but the CLI sends it: { five_hour: { utilization: 0.95, resetsAt }, ... }.
  const windows = Object.entries<any>(info.unifiedWindows ?? {});
  return (
    <div className="delegation">
      <b>rate_limit_event</b> <span className="subtype">status "{info.status}" · {info.rateLimitType}</span>
      {windows.map(([name, w]) => (
        <div key={name} className="subtype" style={{ margin: 0 }}>
          {name}: {pct(w.utilization == null ? null : w.utilization * 100)} used · resets {w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : "?"}
        </div>
      ))}
    </div>
  );
}

/** The result's headline numbers, and why the run stopped. */
function ResultLine({ result }: { result: any }) {
  return (
    <div className="subtype" style={{ margin: 0 }}>
      <b>result/{result.subtype}</b>
      {result.is_error && " · is_error"} · terminal_reason <code>{result.terminal_reason ?? "?"}</code> · num_turns {result.num_turns} ·{" "}
      <b>total_cost_usd {usd(result.total_cost_usd)}</b>
      <br />
      duration_ms {num(result.duration_ms)} · duration_api_ms {num(result.duration_api_ms)}
      {result.errors?.length > 0 && <div className="snippet">errors: {result.errors.join("; ")}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A: where the numbers are in one run
// ---------------------------------------------------------------------------------------------

const tasks = [
  {
    label: "Read the sandbox (several calls)",
    text: "List the files here, read each one, then tell me in two lines how many tasks are open and what the TODO in the notes says.",
  },
  { label: "One-word answer (one call)", text: "What is the capital of Portugal? One word, no tools." },
  { label: "Grep (two calls)", text: 'Use Grep to find which file mentions "canUseTool" and reply with just the file name.' },
];

type HistoryRow = { label: string; model: string; agentTool: boolean; calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; cost: number };

function OneRun() {
  const [prompt, setPrompt] = useState(tasks[0].text);
  const [model, setModel] = useState(HAIKU);
  const [agentTool, setAgentTool] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  async function go() {
    // A local copy, so the finished run can be read right after the await (React state may not be updated yet).
    let final: Run = { messages: [], running: true };
    await startRun({ prompt, model, agentTool }, (fn) => {
      final = fn(final);
      setRun(final);
    });
    // Keep one line per run, so you can compare runs with different models or prompts.
    const result = final.messages.find((m) => m.type === "result");
    if (!result) return;
    const s = sumModelUsage(result.modelUsage);
    const label = tasks.find((t) => t.text === prompt)?.label ?? "custom prompt";
    setHistory((h) => [...h, { label, model, agentTool, calls: apiCalls(final.messages).length, input: s.input, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, output: s.output, cost: result.total_cost_usd }]);
  }

  const result = run?.messages.find((m) => m.type === "result");
  const calls = apiCalls(run?.messages ?? []);
  const assistantCount = run?.messages.filter((m) => m.type === "assistant").length ?? 0;

  return (
    <>
      <h3>A · Where the numbers are in one run</h3>
      <p className="hint">
        The agent gets read-only tools (<code>Read</code>, <code>Glob</code>, <code>Grep</code>) in the Concept 3 sandbox, so
        one prompt can make several API calls: one per tool round-trip.
      </p>
      <div className="scenarios">
        {tasks.map((t) => (
          <button key={t.label} className={prompt === t.text ? "active" : ""} onClick={() => setPrompt(t.text)}>
            {t.label}
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="row">
        <label className="check">
          <code>model</code>
          <select className="inline" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="check" title="Adds the Agent tool. Its description makes the system prompt big enough to be cached.">
          <input type="checkbox" checked={agentTool} onChange={(e) => setAgentTool(e.target.checked)} />
          also give it the <code>Agent</code> tool (bigger prompt → caching)
        </label>
        <button className="primary" onClick={go} disabled={run?.running || !prompt.trim()}>
          {run?.running ? "Running…" : "Run"}
        </button>
      </div>

      {run && (
        <div className={`card ${result?.is_error ? "warn" : ""}`}>
          <h4 style={{ margin: "0 0 4px" }}>1. assistant.message.usage: one row per API call</h4>
          <span className="hint">
            {assistantCount} assistant messages, but only {calls.length} API call(s): each streamed block is its own message, with
            the same <code>message.id</code> and a copy of the same <code>usage</code>. Its <code>output_tokens</code> is a
            placeholder (the call has not finished yet), so read only the input side here.
          </span>
          <table className="tools usage">
            <thead>
              <tr>
                <th>#</th>
                <th>blocks</th>
                <th>input</th>
                <th>cache write</th>
                <th>cache read</th>
                <th>output (not final)</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => (
                <tr key={c.id} title={c.id}>
                  <td>
                    {i + 1}
                    {c.subagent && " (subagent)"}
                  </td>
                  <td>
                    <code>{c.blocks.join(", ")}</code>
                  </td>
                  <td>{num(c.usage.input_tokens)}</td>
                  <td>{num(c.usage.cache_creation_input_tokens)}</td>
                  <td>{num(c.usage.cache_read_input_tokens)}</td>
                  <td style={{ opacity: 0.5 }}>{num(c.usage.output_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {run.running && <div className="hint">running…</div>}

          {result && (
            <>
              <h4 style={{ margin: "10px 0 4px" }}>2. result.usage vs result.modelUsage</h4>
              <UsageCompare result={result} />
              <h4 style={{ margin: "10px 0 4px" }}>3. The cost, the time and the turns</h4>
              <ResultLine result={result} />
              {result.result && <div className="answer thin">{result.result}</div>}
              <h4 style={{ margin: "10px 0 4px" }}>4. Plan limits</h4>
              <RateLimit messages={run.messages} />
            </>
          )}
          {run.error && <div className="snippet">for await threw: {run.error}</div>}
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <b>Runs so far</b> <span className="subtype">from modelUsage (every call)</span>
          <table className="tools usage">
            <thead>
              <tr>
                <th>prompt</th>
                <th>model</th>
                <th>API calls</th>
                <th>input</th>
                <th>cache write</th>
                <th>cache read</th>
                <th>output</th>
                <th>total_cost_usd</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td>
                    {h.label}
                    {h.agentTool && " + Agent"}
                  </td>
                  <td>
                    <code>{h.model.replace("claude-", "")}</code>
                  </td>
                  <td>{h.calls}</td>
                  <td>{num(h.input)}</td>
                  <td>{num(h.cacheWrite)}</td>
                  <td>{num(h.cacheRead)}</td>
                  <td>{num(h.output)}</td>
                  <td>{usd(h.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link" onClick={() => setHistory([])}>
            clear
          </button>
        </div>
      )}
      {run && !run.running && <MessageLog messages={run.messages} />}
    </>
  );
}

/** Side by side: the main loop only (usage) vs every call of this query() (modelUsage). */
function UsageCompare({ result }: { result: any }) {
  const u = result.usage ?? {};
  const all = sumModelUsage(result.modelUsage);
  const rows: [string, number | undefined, number][] = [
    ["input tokens", u.input_tokens, all.input],
    ["cache write", u.cache_creation_input_tokens, all.cacheWrite],
    ["cache read", u.cache_read_input_tokens, all.cacheRead],
    ["output tokens", u.output_tokens, all.output],
    ["  of which thinking", u.output_tokens_details?.thinking_tokens, all.thinking],
  ];
  const zeroed = rows.every(([, main]) => !main) && all.input > 0;
  return (
    <>
      <table className="tools usage">
        <thead>
          <tr>
            <th></th>
            <th>
              <code>result.usage</code> (main loop)
            </th>
            <th>
              <code>result.modelUsage</code> (all calls)
            </th>
            <th>not in usage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, main, total]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{num(main)}</td>
              <td>{num(total)}</td>
              <td>{main !== undefined && total - main !== 0 ? num(total - main) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="tools usage">
        <tbody>
          {Object.entries<any>(result.modelUsage ?? {}).map(([model, m]) => (
            <tr key={model}>
              <td>
                <code>{model}</code>
              </td>
              <td>costUSD {usd(m.costUSD)}</td>
              <td>costBasis {m.costBasis ?? "list"}</td>
              <td>contextWindow {num(m.contextWindow)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="hint">
        {zeroed
          ? "result.usage is all zeros: the run ended early (a limit or an API error), so only modelUsage has the real numbers."
          : "modelUsage also counts calls outside the main loop (subagents, small helper calls), so it is the one to use for accounting."}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: limits that stop a run
// ---------------------------------------------------------------------------------------------

type Limit = { model: string; maxTurns?: number; maxBudgetUsd?: number; taskBudget?: number };

const limitSets: { label: string; hint: string; columns: Limit[] }[] = [
  {
    label: "maxTurns vs maxBudgetUsd",
    hint: "The same task three times: no limit, too few turns, too little money. Compare how each run ends and what it cost.",
    columns: [{ model: HAIKU }, { model: HAIKU, maxTurns: 2 }, { model: HAIKU, maxBudgetUsd: 0.001 }],
  },
  {
    label: "Budget: too low / enough",
    hint: "The budget is checked after each API call, so a call that starts under the limit always finishes. Low budgets end over their limit.",
    columns: [{ model: HAIKU, maxBudgetUsd: 0.001 }, { model: HAIKU, maxBudgetUsd: 0.005 }, { model: HAIKU, maxBudgetUsd: 0.05 }],
  },
  {
    label: "taskBudget (alpha)",
    hint: "taskBudget tells the model how many tokens it has left, so it can pace itself. Sonnet 5 accepts it (on a small task nothing changes); Haiku 4.5 rejects the request with a 400.",
    columns: [{ model: SONNET }, { model: SONNET, taskBudget: 20000 }, { model: HAIKU, taskBudget: 20000 }],
  },
];

function Limits() {
  const [set, setSet] = useState(0);
  const [columns, setColumns] = useState<Limit[]>(limitSets[0].columns);
  const [runs, setRuns] = useState<Run[]>([]);
  const running = runs.some((r) => r?.running);

  function pick(i: number) {
    setSet(i);
    setColumns(limitSets[i].columns);
    setRuns([]);
  }

  function edit(i: number, patch: Partial<Limit>) {
    setColumns((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function runAll() {
    setRuns([]);
    columns.forEach((limit, i) =>
      startRun({ prompt: tasks[0].text, ...limit }, (fn) =>
        setRuns((prev) => {
          const next = [...prev];
          next[i] = fn(next[i] ?? { messages: [], running: true });
          return next;
        }),
      ),
    );
  }

  return (
    <>
      <h3>B · Limits that stop a run</h3>
      <p className="hint">
        Concept 2 introduced <code>maxTurns</code> and <code>maxBudgetUsd</code>. Here they run side by side on the{" "}
        <i>{tasks[0].label}</i> task. A run stopped by a limit ends with an error <code>result</code>, then{" "}
        <code>for await</code> throws.
      </p>
      <div className="scenarios">
        {limitSets.map((s, i) => (
          <button key={s.label} className={set === i ? "active" : ""} onClick={() => pick(i)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="hint">{limitSets[set].hint}</p>
      <div className="compare-grid">
        {columns.map((c, i) => (
          <div key={i}>
            <div className="card config">
              <label>
                <code>model</code>
                <select value={c.model} onChange={(e) => edit(i, { model: e.target.value })}>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label>
                <code>maxTurns</code>
                <input type="number" min={1} value={c.maxTurns ?? ""} placeholder="(omit)" onChange={(e) => edit(i, { maxTurns: Number(e.target.value) || undefined })} />
              </label>
              <label>
                <code>maxBudgetUsd</code>
                <input type="number" min={0} step={0.001} value={c.maxBudgetUsd ?? ""} placeholder="(omit)" onChange={(e) => edit(i, { maxBudgetUsd: Number(e.target.value) || undefined })} />
              </label>
              <label>
                <code>taskBudget.total</code>
                <input type="number" min={0} step={1000} value={c.taskBudget ?? ""} placeholder="(omit)" onChange={(e) => edit(i, { taskBudget: Number(e.target.value) || undefined })} />
              </label>
              {columns.length > 1 && (
                <button className="link" onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
                  remove
                </button>
              )}
            </div>
            <LimitCard run={runs[i]} limit={c} />
          </div>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={runAll} disabled={running}>
          {running ? "Running…" : `Run ${columns.length} in parallel`}
        </button>
        <button onClick={() => setColumns([...columns, { model: HAIKU }])} disabled={running || columns.length >= 4}>
          + column
        </button>
      </div>
      {runs.length > 0 && !running && <MessageLog messages={runs.flatMap((r) => r?.messages ?? [])} />}
    </>
  );
}

function LimitCard({ run, limit }: { run?: Run; limit: Limit }) {
  if (!run) return null;
  const result = run.messages.find((m) => m.type === "result");
  const calls = apiCalls(run.messages).length;
  if (!result) return <div className="card hint">running… {calls} API call(s)</div>;
  const cost = result.total_cost_usd;
  const budget = limit.maxBudgetUsd;
  return (
    <div className={`card ${result.is_error ? "warn" : ""}`}>
      <ResultLine result={result} />
      <div className="subtype" style={{ margin: 0 }}>
        {calls} API call(s)
      </div>
      {budget && (
        <>
          <div className="meter" title={`${usd(cost)} of ${usd(budget)}`}>
            <div style={{ width: `${Math.min(100, (cost / budget) * 100)}%`, background: cost > budget ? "#d9a13b" : undefined }} />
          </div>
          <span className="subtype" style={{ margin: 0 }}>
            {usd(cost)} of {usd(budget)} {cost > budget && <b>· {Math.round((cost / budget) * 100)}% of the budget</b>}
          </span>
        </>
      )}
      {result.result ? <div className="answer thin">{result.result}</div> : <div className="hint">no answer text</div>}
      {run.error && <div className="snippet">for await threw: {run.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part C: a live cost meter
// ---------------------------------------------------------------------------------------------

type Entry = { kind: "control" | "message"; data: any };

const questions = [
  { label: "Say hi", text: "Say hi in one word." },
  { label: "Poem (long answer)", text: "Write a 12-line poem about cloud bills." },
  { label: "Read notes.txt (tool)", text: "Read notes.txt and tell me the TODO in one line." },
  { label: "Recap", text: "In one line: what have we talked about so far?" },
];

async function post(route: string, body: object) {
  const res = await fetch(`/api/c15/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json.result;
}

function LiveMeter() {
  const [model, setModel] = useState(HAIKU);
  const [budget, setBudget] = useState("0.02");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(questions[0].text);

  async function start() {
    setLog([]);
    setError(null);
    setOpen(true);
    try {
      await streamPost("/api/c15/session", { model, maxBudgetUsd: Number(budget) || undefined }, (event, data) => {
        if (event === "session") setSessionId(data.id);
        if (event === "control" || event === "message") setLog((prev) => [...prev, { kind: event, data }]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setOpen(false);
      setSessionId(null);
    }
  }

  async function run(route: string, body: object = {}) {
    try {
      setError(null);
      await post(route, { id: sessionId, ...body });
    } catch (err) {
      setError(String(err));
    }
  }

  const messages = log.filter((e) => e.kind === "message").map((e) => e.data);
  const results = messages.filter((m) => m.type === "result");
  const total = results.at(-1)?.total_cost_usd ?? 0; // cumulative: read the latest, never add them up
  const limit = Number(budget) || 0;
  const context = log.filter((e) => e.data.context).at(-1)?.data.context;

  return (
    <>
      <h3>C · A live cost meter</h3>
      <p className="hint">
        In a streaming-input session (Concept 12), <code>total_cost_usd</code> and <code>modelUsage</code> are{" "}
        <b>running totals</b>: each result carries the session's cost so far, so the cost of one turn is the difference with
        the previous one. <code>result.usage</code> is per turn. <code>maxBudgetUsd</code> covers the whole session.
      </p>
      <div className="row">
        <label className="check">
          <code>model</code>
          <select className="inline" value={model} onChange={(e) => setModel(e.target.value)} disabled={open}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <code>maxBudgetUsd</code>
          <input style={{ width: 90, padding: "2px 6px" }} type="number" min={0} step={0.005} value={budget} placeholder="(omit)" onChange={(e) => setBudget(e.target.value)} disabled={open} />
        </label>
        <button className="primary" onClick={start} disabled={open}>
          {open ? "Session open" : "Start session"}
        </button>
        <button onClick={() => run("end")} disabled={!sessionId}>
          Close input (end session)
        </button>
      </div>

      {log.length > 0 && (
        <div className="card">
          <b>Session cost {usd(total)}</b>
          {limit > 0 && (
            <>
              {" "}
              <span className="subtype">of {usd(limit)} maxBudgetUsd</span>
              <div className="meter">
                <div style={{ width: `${Math.min(100, (total / limit) * 100)}%`, background: total > limit ? "#d9a13b" : undefined }} />
              </div>
            </>
          )}
          {context && (
            <>
              <span className="subtype" style={{ margin: 0 }}>
                context window: {num(context.totalTokens)} of {num(context.maxTokens)} tokens ({context.percentage}%) · auto-compact at {num(context.autoCompactThreshold)}
              </span>
              <div className="meter">
                <div style={{ width: `${Math.max(1, context.percentage)}%` }} />
              </div>
            </>
          )}
        </div>
      )}

      <div className="scenarios">
        {questions.map((q) => (
          <button key={q.label} onClick={() => setText(q.text)}>
            {q.label}
          </button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="row">
        <button className="primary" onClick={() => run("send", { text })} disabled={!sessionId || !text.trim()}>
          Send
        </button>
        <button onClick={() => run("context")} disabled={!sessionId}>
          await q.getContextUsage()
        </button>
        <button onClick={() => run("usage")} disabled={!sessionId}>
          await q.usage_EXPERIMENTAL…()
        </button>
      </div>

      <MeterTimeline log={log} />
      {error && (
        <div className="card warn">
          <b>Error</b> — <code>{error}</code>
        </div>
      )}
      {!open && log.length > 0 && <div className="card">The session ended.</div>}
      <MessageLog messages={messages.filter((m) => m.type !== "stream_event")} />
    </>
  );
}

/** One card per turn: this turn's cost (the difference), the running total, and the control calls in between. */
function MeterTimeline({ log }: { log: Entry[] }) {
  const items: React.ReactNode[] = [];
  let previous = 0;

  log.forEach((e, key) => {
    const d = e.data;
    if (e.kind === "control" && d.method === "push user message") {
      items.push(
        <div key={key} className="card">
          <b>You</b> <span className="subtype">at {d.ms} ms</span>
          <div>{d.text}</div>
        </div>,
      );
    } else if (e.kind === "control" && d.context) {
      items.push(<ContextCard key={key} method={d.method} took={d.took} context={d.context} />);
    } else if (e.kind === "control" && d.usage) {
      items.push(<UsageCard key={key} method={d.method} took={d.took} usage={d.usage} />);
    } else if (e.kind === "control") {
      items.push(
        <div key={key} className="delegation">
          <code>{d.method}</code> <span className="subtype">at {d.ms} ms</span>
        </div>,
      );
    } else if (d.type === "result") {
      const turn = d.total_cost_usd - previous;
      items.push(
        <div key={key} className={`card ${d.is_error ? "warn" : ""}`}>
          {d.result ? <div className="answer thin">{d.result}</div> : <div className="hint">no answer text</div>}
          <span className="subtype" style={{ margin: 0 }}>
            <b>result/{d.subtype}</b> · num_turns {d.num_turns} · this turn <b>{usd(turn)}</b> · session {usd(d.total_cost_usd)}
            <br />
            result.usage (this turn): in {num(d.usage.input_tokens)} · cache read {num(d.usage.cache_read_input_tokens)} · out {num(d.usage.output_tokens)}
          </span>
          {d.errors?.length > 0 && <div className="snippet">errors: {d.errors.join("; ")}</div>}
          {d.is_error && turn < 1e-9 &&<div className="hint">This turn cost nothing: the budget was already used, so no API call was made.</div>}
        </div>,
      );
      previous = d.total_cost_usd;
    }
  });
  return <>{items}</>;
}

function ContextCard({ method, took, context }: { method: string; took: number; context: any }) {
  return (
    <div className="card">
      <code>{method}</code> <span className="subtype">{took} ms</span>
      <table className="tools usage">
        <tbody>
          {context.categories.map((c: any) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{num(c.tokens)}</td>
              <td>
                <span className="subtype">{c.kind}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {context.apiUsage && (
        <span className="subtype" style={{ margin: 0 }}>
          apiUsage (last response): in {num(context.apiUsage.input_tokens)} · cache read {num(context.apiUsage.cache_read_input_tokens)} · out{" "}
          {num(context.apiUsage.output_tokens)}
        </span>
      )}
    </div>
  );
}

function UsageCard({ method, took, usage }: { method: string; took: number; usage: any }) {
  const s = usage.session;
  return (
    <div className="card">
      <code>{method}</code> <span className="subtype">{took} ms · experimental</span>
      <div className="subtype" style={{ margin: 0 }}>
        session: {usd(s.total_cost_usd)} · API {num(s.total_api_duration_ms)} ms of {num(s.total_duration_ms)} ms · lines +{s.total_lines_added} −{s.total_lines_removed}
        <br />
        subscription_type <code>{String(usage.subscription_type)}</code> · rate_limits_available <code>{String(usage.rate_limits_available)}</code>
      </div>
      {usage.rate_limits &&
        Object.entries<any>(usage.rate_limits)
          .filter(([, w]) => w)
          .map(([name, w]) => (
            <div key={name}>
              <span className="subtype" style={{ margin: 0 }}>
                {name}: {pct(w.utilization)} used · resets {w.resets_at ? new Date(w.resets_at).toLocaleString() : "?"}
              </span>
              <div className="meter">
                <div style={{ width: `${w.utilization ?? 0}%` }} />
              </div>
            </div>
          ))}
    </div>
  );
}
