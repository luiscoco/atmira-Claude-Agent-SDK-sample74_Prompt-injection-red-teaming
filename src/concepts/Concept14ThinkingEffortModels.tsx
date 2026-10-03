import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5-5";
const models = [HAIKU, SONNET, OPUS];
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

export function Concept14ThinkingEffortModels() {
  return (
    <section>
      <h2>14 · Thinking, effort &amp; models</h2>
      <p className="lead">
        Three options decide <b>how hard the model works</b> before it answers: <code>thinking</code> (whether it reasons,
        and whether you see that reasoning), <code>effort</code> (how deep it goes) and <code>model</code>. What each one
        does depends on the model, so the tab compares them side by side, then changes them in a live session.
      </p>
      <Compare />
      <hr />
      <Models />
      <hr />
      <LiveSession />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared: one configuration, and what one run of it produced
// ---------------------------------------------------------------------------------------------

type Config = {
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  budgetTokens?: number;
  display?: "summarized" | "omitted";
  effort?: (typeof efforts)[number];
  fallbackModel?: string;
};

type Run = { messages: any[]; effort?: string | null; error?: string; running: boolean; firstTextMs?: number };

/** Streams one /run into a Run. `update` is called with the new state after every event. */
async function startRun(prompt: string, config: Config, update: (fn: (r: Run) => Run) => void) {
  const startedAt = Date.now();
  update(() => ({ messages: [], running: true }));
  try {
    await streamPost("/api/c14/run", { prompt, ...config }, (event, data) => {
      if (event === "message") {
        const isText = data.type === "stream_event" && data.event.type === "content_block_delta" && data.event.delta.type === "text_delta";
        update((r) => ({ ...r, messages: [...r.messages, data], firstTextMs: r.firstTextMs ?? (isText ? Date.now() - startedAt : undefined) }));
      }
      if (event === "effort") update((r) => ({ ...r, effort: data.level }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}

/** Everything the result card shows, derived from the raw messages. */
function summarize(messages: any[]) {
  const deltas = messages.filter((m) => m.type === "stream_event" && m.event.type === "content_block_delta").map((m) => m.event.delta);
  const final = messages.filter((m) => m.type === "assistant").flatMap((m) => m.message.content);
  const thinkingBlocks = final.filter((b: any) => b.type === "thinking" || b.type === "redacted_thinking");
  const estimates = messages.filter((m) => m.type === "system" && m.subtype === "thinking_tokens");
  return {
    init: messages.find((m) => m.type === "system" && m.subtype === "init"),
    fallback: messages.find((m) => m.type === "system" && m.subtype === "model_fallback"),
    result: messages.find((m) => m.type === "result"),
    // Thinking text grows through thinking_delta events. With display "omitted" the block exists but stays empty.
    thinking: deltas.filter((d) => d.type === "thinking_delta").map((d) => d.thinking).join("") || thinkingBlocks.map((b: any) => b.thinking ?? "").join(""),
    thinkingBlock: thinkingBlocks.length > 0,
    estimate: estimates.at(-1)?.estimated_tokens as number | undefined,
    answer: deltas.filter((d) => d.type === "text_delta").map((d) => d.text).join("") || final.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
  };
}

function RunCard({ run, title }: { run?: Run; title?: React.ReactNode }) {
  if (!run) return null;
  const { init, fallback, result, thinking, thinkingBlock, estimate, answer } = summarize(run.messages);
  const usage = Object.entries<any>(result?.modelUsage ?? {});
  return (
    <div className={`card ${result && (result.is_error || result.subtype !== "success") ? "warn" : ""}`}>
      {title}
      <div className="subtype" style={{ margin: 0 }}>
        init.model <code>{init?.model ?? "…"}</code>
      </div>
      {fallback && (
        <div className="delegation warn">
          <b>system/model_fallback</b> <span className="subtype">trigger "{fallback.trigger}"</span>
          <div className="snippet">
            {fallback.original_model} → {fallback.fallback_model}: {fallback.content}
          </div>
        </div>
      )}
      {(thinking || thinkingBlock || estimate) && (
        <details className="thinking" open={!!thinking && !result}>
          <summary>
            thinking {estimate !== undefined && <>· ~{estimate} tokens (estimate)</>}
            {thinkingBlock && !thinking && <> · <b>text omitted</b></>}
          </summary>
          {thinking && <div className="thinking-text">{thinking}</div>}
        </details>
      )}
      {answer && (
        <div className="answer thin">
          {answer}
          {!result && <span className="cursor">▌</span>}
        </div>
      )}
      {run.running && !answer && <div className="hint">running…</div>}
      {result && (
        <div className="subtype" style={{ margin: 0 }}>
          <b>result/{result.subtype}</b>
          {result.is_error && " · is_error"} · {result.duration_ms} ms
          {run.firstTextMs !== undefined && <> · first answer token {run.firstTextMs} ms</>} · ${result.total_cost_usd.toFixed(4)}
          <br />
          applied effort <EffortBadge level={run.effort} />
          <table className="tools usage">
            <tbody>
              {usage.map(([model, u]) => (
                <tr key={model}>
                  <td>
                    <code>{model.replace("claude-", "")}</code>
                  </td>
                  <td>out {u.outputTokens}</td>
                  <td>thinking {u.thinkingTokens ?? "?"}</td>
                  <td>${u.costUSD.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {run.error && <div className="snippet">for await threw: {run.error}</div>}
    </div>
  );
}

function EffortBadge({ level }: { level?: string | null }) {
  if (level === undefined) return <code>?</code>;
  return level === null ? <span className="tag st-disabled">none sent</span> : <span className="tag tag-effort">{level}</span>;
}

// ---------------------------------------------------------------------------------------------
// Part A: the same prompt, several configurations side by side
// ---------------------------------------------------------------------------------------------

const prompts = [
  { label: "Count the 7s (300)", text: "How many times does the digit 7 appear when you write every integer from 1 to 1000? Reply with just the number." },
  { label: "Clock angle (7.5)", text: "At 3:15, what is the smaller angle between the hour and minute hands of a clock? Reply with just the number of degrees." },
  { label: "Bat and ball (5)", text: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost, in cents? Reply with just the number." },
  { label: "Easy (Lisbon)", text: "What is the capital of Portugal? One word." },
];

const compareSets: { label: string; hint: string; columns: Config[] }[] = [
  {
    label: "Thinking on / off (Haiku)",
    hint: "Haiku 4.5 thinks even when you omit the option. Compare the thinking tokens and the cost with disabled.",
    columns: [{ model: HAIKU }, { model: HAIKU, thinking: "disabled" }, { model: HAIKU, thinking: "enabled", budgetTokens: 1024, display: "summarized" }],
  },
  {
    label: "display: omitted vs summarized",
    hint: "Same budget. Both runs think and pay for it; only one gives you the text.",
    columns: [
      { model: HAIKU, thinking: "enabled", budgetTokens: 2000, display: "omitted" },
      { model: HAIKU, thinking: "enabled", budgetTokens: 2000, display: "summarized" },
    ],
  },
  {
    label: "Effort ladder (Sonnet)",
    hint: "Adaptive thinking: the model decides whether to think, and effort pushes that decision. Low effort often skips thinking.",
    columns: (["low", "medium", "high", "max"] as const).map((effort) => ({ model: SONNET, thinking: "adaptive" as const, display: "summarized" as const, effort })),
  },
  {
    label: "effort on a model without effort",
    hint: "Haiku 4.5 does not support effort: the option is accepted, but the Stop hook shows that none was sent.",
    columns: [{ model: HAIKU, effort: "max" }, { model: SONNET, effort: "max", thinking: "adaptive", display: "summarized" }],
  },
  {
    label: "budgetTokens on an adaptive model",
    hint: 'Sonnet 5 thinks adaptively. A fixed { type: "enabled", budgetTokens } does not force it to think.',
    columns: [
      { model: SONNET, thinking: "enabled", budgetTokens: 4000, display: "summarized" },
      { model: SONNET, thinking: "adaptive", display: "summarized", effort: "max" },
    ],
  },
  {
    label: "Models",
    hint: "Default options for each model. Look at modelUsage: some runs also list a small Haiku call outside the main loop.",
    columns: models.map((model) => ({ model })),
  },
];

function Compare() {
  const [prompt, setPrompt] = useState(prompts[0].text);
  const [set, setSet] = useState(0);
  const [columns, setColumns] = useState<Config[]>(compareSets[0].columns);
  const [runs, setRuns] = useState<Run[]>([]);
  const running = runs.some((r) => r?.running);

  function pick(i: number) {
    setSet(i);
    setColumns(compareSets[i].columns);
    setRuns([]);
  }

  function edit(i: number, patch: Partial<Config>) {
    setColumns((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function runAll() {
    setRuns([]);
    // One stream per column, all at the same time, so the durations are comparable.
    columns.forEach((config, i) =>
      startRun(prompt, config, (fn) =>
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
      <h3>A · The same prompt, several configurations</h3>
      <p className="hint">
        Pick a comparison (or edit the columns), then run them all at once. <b>Applied effort</b> comes from a{" "}
        <code>Stop</code> hook (<code>input.effort.level</code>), which shows what was really sent after the model's own
        downgrades.
      </p>
      <div className="scenarios">
        {prompts.map((p) => (
          <button key={p.label} className={prompt === p.text ? "active" : ""} onClick={() => setPrompt(p.text)}>
            {p.label}
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="scenarios">
        {compareSets.map((s, i) => (
          <button key={s.label} className={set === i ? "active" : ""} onClick={() => pick(i)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="hint">{compareSets[set].hint}</p>

      <div className="compare-grid">
        {columns.map((c, i) => (
          <div key={i}>
            <ConfigEditor config={c} onChange={(patch) => edit(i, patch)} onRemove={columns.length > 1 ? () => setColumns(columns.filter((_, j) => j !== i)) : undefined} />
            <RunCard run={runs[i]} />
          </div>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={runAll} disabled={running || !prompt.trim()}>
          {running ? "Running…" : `Run ${columns.length} configuration(s) in parallel`}
        </button>
        <button onClick={() => setColumns([...columns, { model: HAIKU }])} disabled={running || columns.length >= 4}>
          + column
        </button>
      </div>
      {runs.length > 0 && !running && <MessageLog messages={runs.flatMap((r) => r?.messages ?? []).filter((m) => m.type !== "stream_event" && m.subtype !== "thinking_tokens")} />}
    </>
  );
}

function ConfigEditor({ config, onChange, onRemove }: { config: Config; onChange: (patch: Partial<Config>) => void; onRemove?: () => void }) {
  const c = config;
  return (
    <div className="card config">
      <label>
        <code>model</code>
        <select value={c.model} onChange={(e) => onChange({ model: e.target.value })}>
          {[...new Set([...models, c.model])].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        <code>thinking.type</code>
        <select value={c.thinking ?? ""} onChange={(e) => onChange({ thinking: (e.target.value || undefined) as Config["thinking"] })}>
          <option value="">(omit)</option>
          <option>adaptive</option>
          <option>enabled</option>
          <option>disabled</option>
        </select>
      </label>
      {c.thinking === "enabled" && (
        <label>
          <code>budgetTokens</code>
          <input type="number" min={1024} step={512} value={c.budgetTokens ?? ""} placeholder="(omit)" onChange={(e) => onChange({ budgetTokens: Number(e.target.value) || undefined })} />
        </label>
      )}
      {(c.thinking === "enabled" || c.thinking === "adaptive") && (
        <label>
          <code>display</code>
          <select value={c.display ?? ""} onChange={(e) => onChange({ display: (e.target.value || undefined) as Config["display"] })}>
            <option value="">(omit)</option>
            <option>summarized</option>
            <option>omitted</option>
          </select>
        </label>
      )}
      <label>
        <code>effort</code>
        <select value={c.effort ?? ""} onChange={(e) => onChange({ effort: (e.target.value || undefined) as Config["effort"] })}>
          <option value="">(omit)</option>
          {efforts.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </label>
      {onRemove && (
        <button className="link" onClick={onRemove}>
          remove
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: what each model supports, and fallbackModel
// ---------------------------------------------------------------------------------------------

const fallbackCases: { label: string; config: Config }[] = [
  { label: "model: claude-nope-9", config: { model: "claude-nope-9" } },
  { label: `model: claude-nope-9 + fallbackModel: ${HAIKU}`, config: { model: "claude-nope-9", fallbackModel: HAIKU } },
];

function Models() {
  const [list, setList] = useState<{ models: any[]; ms: number; cached: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/c14/models");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setList(json);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function tryFallback() {
    setRuns([]);
    fallbackCases.forEach(({ config }, i) =>
      startRun("Which model are you? One short line.", config, (fn) =>
        setRuns((prev) => {
          const next = [...prev];
          next[i] = fn(next[i] ?? { messages: [], running: true });
          return next;
        }),
      ),
    );
  }

  const yes = (v?: boolean) => (v ? "✔" : "–");

  return (
    <>
      <h3>B · What each model supports</h3>
      <p className="hint">
        <code>q.supportedModels()</code> lists the models this login can use and what each one accepts. It is a control
        request, so the server starts a <code>query()</code> whose prompt never yields a message, asks, and closes it.
      </p>
      <button className="primary" onClick={load} disabled={loading}>
        {loading ? "Asking…" : "await q.supportedModels()"}
      </button>
      {error && (
        <div className="card warn">
          <code>{error}</code>
        </div>
      )}
      {list && (
        <div className="card">
          <span className="subtype" style={{ margin: 0 }}>
            {list.models.length} models · {list.ms} ms {list.cached && "(cached by the server)"}
          </span>
          <table className="tools">
            <thead>
              <tr>
                <th>value</th>
                <th>resolvedModel</th>
                <th>supportsEffort</th>
                <th>supportedEffortLevels</th>
                <th>adaptive thinking</th>
                <th>fast mode</th>
              </tr>
            </thead>
            <tbody>
              {list.models.map((m) => (
                <tr key={m.value} title={m.description}>
                  <td>
                    <code>{m.value}</code>
                  </td>
                  <td>
                    <code>{m.resolvedModel ?? ""}</code>
                  </td>
                  <td>{yes(m.supportsEffort)}</td>
                  <td>{m.supportedEffortLevels?.join(", ") ?? "–"}</td>
                  <td>{yes(m.supportsAdaptiveThinking)}</td>
                  <td>{yes(m.supportsFastMode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="hint">
            <code>value</code> is what you pass as <code>model</code>: an alias like <code>sonnet</code> works, and{" "}
            <code>system/init.model</code> shows the id it resolved to.
          </span>
        </div>
      )}

      <h3>When the model is not available: fallbackModel</h3>
      <p className="hint">
        The same bad model name twice: once alone, once with <code>fallbackModel</code>. The fallback is also used when the
        primary model is overloaded, and the primary is tried again at the start of every user turn.
      </p>
      <button className="primary" onClick={tryFallback} disabled={runs.some((r) => r?.running)}>
        Run both
      </button>
      <div className="compare-grid">
        {runs.map((run, i) => (
          <RunCard key={i} run={run} title={<code>{fallbackCases[i].label}</code>} />
        ))}
      </div>
      {runs.length > 0 && !runs.some((r) => r?.running) && (
        <MessageLog messages={runs.flatMap((r) => r?.messages ?? []).filter((m) => m.type !== "stream_event" && m.subtype !== "thinking_tokens")} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part C: change effort, thinking and model in a live session
// ---------------------------------------------------------------------------------------------

type Entry = { kind: "control" | "message" | "effort"; data: any };

const questions = [
  { label: "Count the 7s", text: prompts[0].text },
  { label: "Clock angle", text: prompts[1].text },
  { label: "Bat and ball", text: prompts[2].text },
  { label: "Primes", text: "What is the sum of all prime numbers below 50? Reply with just the number." },
  { label: "Which model?", text: "Which model are you? One line." },
];

async function post(route: string, body: object) {
  const res = await fetch(`/api/c14/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json.result;
}

function LiveSession() {
  const [startModel, setStartModel] = useState(SONNET);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState(questions[0].text);
  const [effort, setEffort] = useState("max");
  const [tokens, setTokens] = useState("0");
  const [model, setModel] = useState(HAIKU);

  async function start() {
    setLog([]);
    setError(null);
    setOpen(true);
    try {
      await streamPost("/api/c14/session", { model: startModel }, (event, data) => {
        if (event === "session") setSessionId(data.id);
        if (event === "control" || event === "message" || event === "effort") setLog((prev) => [...prev, { kind: event, data }]);
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
  const pushed = log.filter((e) => e.kind === "control" && e.data.method === "push user message").length;
  const busy = open && pushed > messages.filter((m) => m.type === "result").length;

  return (
    <>
      <h3>C · Change them while the session is alive</h3>
      <p className="hint">
        A streaming-input session (Concept 12) with <code>thinking: {"{ type: \"adaptive\", display: \"summarized\" }"}</code>.
        Each change applies from the <b>next</b> turn. Ask a different question each time: with the same question, the model
        tends to repeat its earlier answer without thinking.
      </p>
      <div className="row">
        <label className="check">
          <code>model</code> at start
          <select className="inline" value={startModel} onChange={(e) => setStartModel(e.target.value)} disabled={open}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={start} disabled={open}>
          {open ? "Session open" : "Start session"}
        </button>
        <button onClick={() => run("end")} disabled={!sessionId}>
          Close input (end session)
        </button>
      </div>

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
          {busy ? "Send (queued)" : "Send"}
        </button>
      </div>

      <div className="row">
        <select className="inline" value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="null">null (model default)</option>
          {efforts.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <button onClick={() => run("effort", { level: effort === "null" ? null : effort })} disabled={!sessionId}>
          await q.applyFlagSettings({"{ effortLevel }"})
        </button>
        <select className="inline" value={tokens} onChange={(e) => setTokens(e.target.value)}>
          <option value="0">0 (off)</option>
          <option value="1024">1024</option>
          <option value="8000">8000</option>
          <option value="null">null (session default)</option>
        </select>
        <button onClick={() => run("thinking", { tokens: tokens === "null" ? null : Number(tokens) })} disabled={!sessionId}>
          await q.setMaxThinkingTokens()
        </button>
        <select className="inline" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button onClick={() => run("model", { model })} disabled={!sessionId}>
          await q.setModel()
        </button>
      </div>

      <SessionTimeline log={log} />
      {error && (
        <div className="card warn">
          <b>Error</b> — <code>{error}</code>
        </div>
      )}
      {!open && log.length > 0 && !error && <div className="card">The session ended (the input iterable was closed).</div>}
      <MessageLog messages={messages.filter((m) => m.type !== "stream_event" && m.subtype !== "thinking_tokens")} />
    </>
  );
}

/** One card per turn: the question, what the model thought, the answer, and what the turn cost. */
function SessionTimeline({ log }: { log: Entry[] }) {
  const items: React.ReactNode[] = [];
  let turn: any[] = []; // the messages of the turn that is running
  let effort: string | null | undefined;
  let previous = { cost: 0, thinking: 0 }; // cost and modelUsage are running totals for the session

  log.forEach((e, key) => {
    const d = e.data;
    if (e.kind === "control" && d.method === "push user message") {
      items.push(
        <div key={key} className="card">
          <b>You</b> <span className="subtype">at {d.ms} ms</span>
          <div>{d.text}</div>
        </div>,
      );
    } else if (e.kind === "control") {
      items.push(
        <div key={key} className="delegation">
          <code>{d.method}</code> <span className="subtype">at {d.ms} ms</span>
        </div>,
      );
    } else if (e.kind === "effort") {
      effort = d.level;
    } else if (d.type === "user" && typeof d.message.content === "string" && d.message.content.includes("local-command-stdout")) {
      items.push(
        <div key={key} className="hint">
          Echo from the CLI: <code>{d.message.content.replace(/<\/?local-command-stdout>/g, "")}</code>
        </div>,
      );
    } else if (d.type === "result") {
      const s = summarize(turn);
      const thinking = Object.values<any>(d.modelUsage).reduce((sum, u) => sum + (u.thinkingTokens ?? 0), 0);
      const cost = d.total_cost_usd;
      items.push(
        <div key={key} className={`card ${d.subtype === "success" ? "" : "warn"}`}>
          <span className="subtype" style={{ margin: 0 }}>
            model <code>{s.init?.model}</code> · applied effort <EffortBadge level={effort} />
          </span>
          {s.thinking ? (
            <details className="thinking">
              <summary>thinking · {thinking - previous.thinking} tokens</summary>
              <div className="thinking-text">{s.thinking}</div>
            </details>
          ) : (
            <div className="hint">{thinking - previous.thinking > 0 ? `thinking · ${thinking - previous.thinking} tokens (text omitted)` : "no thinking"}</div>
          )}
          <div className="answer thin">{s.answer || d.result}</div>
          <span className="subtype" style={{ margin: 0 }}>
            result/{d.subtype} · {d.duration_ms} ms · this turn ${(cost - previous.cost).toFixed(4)} · session ${cost.toFixed(4)}
          </span>
        </div>,
      );
      previous = { cost, thinking };
      turn = [];
      effort = undefined;
    } else {
      turn.push(d);
    }
  });

  // The turn that is still running: show its thinking and answer as they stream.
  const live = summarize(turn);
  if (live.thinking || live.answer) {
    items.push(
      <div key="live" className="card">
        {live.thinking && <div className="thinking-text">{live.thinking}</div>}
        {live.answer && (
          <div className="answer thin">
            {live.answer}
            <span className="cursor">▌</span>
          </div>
        )}
      </div>,
    );
  }
  return <>{items}</>;
}
