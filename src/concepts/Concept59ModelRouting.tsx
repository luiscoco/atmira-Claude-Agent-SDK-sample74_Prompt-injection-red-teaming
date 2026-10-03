import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Tier = "light" | "standard" | "deep";
type Model = { id: string; label: string; inputPerMTok: number; outputPerMTok: number };
type TaskInfo = { id: string; tier: Tier; prompt: string; accept: string[]; format: string; note: string; rule: { tier: Tier; why: string } };
type Facts = { models: Record<Tier, Model>; strategies: string[]; strategyInfo: Record<string, string>; liveAvailable: boolean; tasks: TaskInfo[]; rules: { tier: Tier; pattern: string; why: string }[]; assumptions: { inputTokens: number; outputTokens: Record<Tier, number> } };
type Usage = { model: string; inputTokens: number; outputTokens: number; costUsd: number };
type Row = { task: string; label: Tier; route: string[]; why: string; answer: string; correct: boolean; status: string; costUsd: number; routerCostUsd: number; usage: Usage[]; ms: number; escalated: boolean };
type Summary = { strategy: string; tasks: number; correct: number; costUsd: number; costPerCorrect: number | null; routerCostUsd: number; escalations: number; medianMs: number; byModel: Record<string, number> };

const usd = (n: number) => `$${n.toFixed(4)}`;
const short = (model: string) => model.replace("claude-", "").replace(/-(\d)-(\d)/, " $1.$2");
const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
};

export function Concept59ModelRouting() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<any[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [strategy, setStrategy] = useState("rules");
  const [rows, setRows] = useState<Row[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [expertModel, setExpertModel] = useState("claude-opus-5-5");
  const [delegation, setDelegation] = useState<{ events: any[]; summary: any | null; messages: any[] }>({ events: [], summary: null, messages: [] });
  const [supported, setSupported] = useState<any[] | null>(null);
  const [resolution, setResolution] = useState<any[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(["facts", "code", "plan"].map((route) => getJson(`/api/c59/${route}`, { signal: controller.signal }))).then(([f, c, p]) => {
      if (!controller.signal.aborted) { setFacts(f); setCode(c); setPlan(p); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, [attempt]);

  /** Runs one strategy over the whole task set (or several strategies one after another). */
  async function run(list: string[]) {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy("run"); setError("");
    try {
      for (const name of list) {
        setStrategy(name); setRows([]); setRoutes({});
        await streamPost("/api/c59/run", { strategy: name }, (event, data) => {
          if (controller.signal.aborted) return;
          if (event === "route") setRoutes((all) => ({ ...all, [data.task]: `${data.tier}: ${data.why}` }));
          else if (event === "task") setRows((all) => [...all, data]);
          else if (event === "summary") setSummaries((all) => [...all.filter((row) => row.strategy !== data.strategy), data]);
          else if (event === "error") setError((previous) => `${previous}${previous ? "\n" : ""}${data.message}`);
        }, controller.signal);
        if (controller.signal.aborted) break;
      }
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(""); if (abortRef.current === controller) abortRef.current = null; }
  }
  async function delegate() {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy("delegate"); setError(""); setDelegation({ events: [], summary: null, messages: [] });
    try {
      await streamPost("/api/c59/delegate", { expertModel }, (event, data) => {
        if (controller.signal.aborted) return;
        if (event === "message") setDelegation((d) => ({ ...d, messages: [...d.messages, data] }));
        else if (event === "summary") setDelegation((d) => ({ ...d, summary: data }));
        else if (event === "error") setError(data.message);
        else if (event === "delegation" || event === "start") setDelegation((d) => ({ ...d, events: [...d.events, { kind: event, data }] }));
      }, controller.signal);
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(""); if (abortRef.current === controller) abortRef.current = null; }
  }
  async function once(kind: "models" | "resolution") {
    setBusy(kind); setError("");
    try {
      if (kind === "models") setSupported(await getJson("/api/c59/models"));
      else setResolution(await getJson("/api/c59/resolution", { method: "POST" }));
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }
  const stop = () => { abortRef.current?.abort(); setBusy(""); setError("Stopped. Finished tasks are kept."); };

  return <section>
    <h2>59. Model routing</h2>
    <p className="lead">Send each task to the cheapest model that completes it. Pick the model per call, per subagent, or mid-session, and judge the router by cost and latency per correct answer, not by price per token.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Per call</b><p>A router chooses <code>options.model</code> before <code>query()</code>: rules (free), or a cheap classifier (billed too).</p></div>
      <div className="card"><b>Mid-session</b><p>A cascade starts cheap and calls <code>q.setModel()</code> to escalate in the same session when a check fails.</p></div>
      <div className="card"><b>Per agent</b><p><code>agents.expert.model</code> lets a cheap orchestrator delegate hard work to a stronger subagent. <code>modelUsage</code> bills each model separately.</p></div>
    </div>
    {error && <div className="card warn" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}

    <h3>A · Three tiers and a graded task set</h3>
    <div className="scroll-x"><table className="tools"><thead><tr><th>Tier</th><th>Model ID</th><th>Input $/MTok</th><th>Output $/MTok</th></tr></thead><tbody>
      {facts && Object.entries(facts.models).map(([tier, m]) => <tr key={tier}><td>{tier}</td><td><code>{m.id}</code></td><td>{m.inputPerMTok}</td><td>{m.outputPerMTok}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Explicit IDs, not aliases: in this CLI version the alias <code>sonnet</code> resolves to <code>claude-sonnet-5</code> (section E).</p>
    <p>{facts?.tasks.length ?? "…"} tasks, each with one checkable answer. The tier is a human label; the routers try to predict it.</p>
    <div className="scroll-x"><table className="tools task-table"><thead><tr><th>Task</th><th>Label</th><th>Rule router</th><th>Prompt</th></tr></thead><tbody>
      {facts?.tasks.map((task) => <tr key={task.id}><td><code>{task.id}</code></td><td>{task.tier}</td><td style={{ color: task.rule.tier === task.tier ? undefined : "#c0392b" }}>{task.rule.tier}{task.rule.tier !== task.tier && " ✗"}</td><td>{task.prompt}<br /><span className="hint">{task.note}</span></td></tr>)}
    </tbody></table></div>
    <details className="card"><summary>Answer key and the rules</summary>
      <pre className="wrap">{facts?.tasks.map((task) => `${task.id}: ${task.accept.join(" | ")}   (cascade format check ${task.format})`).join("\n")}</pre>
      <pre className="wrap">{facts?.rules.map((rule) => `${rule.pattern} -> ${rule.tier}  (${rule.why})`).join("\n")}{"\nno match -> standard"}</pre>
    </details>

    <h3>B · The naive projection (offline)</h3>
    <p>Price per token × an assumed {facts?.assumptions.inputTokens.toLocaleString("en")} input tokens and a fixed output size per task. This is the spreadsheet most routers are built on. Section C shows where it breaks.</p>
    <div className="scroll-x"><table className="tools compare"><thead><tr><th>Strategy</th><th>Projected cost</th><th>Misrouted</th><th>How it routes</th></tr></thead><tbody>
      {plan.map((row) => <tr key={row.strategy}><td>{row.strategy}</td><td>{usd(row.totalUsd)}</td><td>{row.strategy === "rules" ? row.misrouted : "–"}</td><td className="hint">{facts?.strategyInfo[row.strategy]}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Two hidden assumptions: every model writes the same number of tokens for the same task, and cheap models are right. Both are wrong. Thinking makes a small model write more on hard tasks, and the projection only prices answers it assumes are correct. The classifier row assumes a perfect classifier; the cascade row assumes Haiku flags exactly the deep tasks.</p>

    <h3>C · Run the strategies live (billed)</h3>
    <div className="card config">
      <label>Strategy<select value={strategy} disabled={!!busy} onChange={(e) => setStrategy(e.target.value)}>{facts?.strategies.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <p className="hint">{facts?.strategyInfo[strategy]}</p>
    </div>
    <p className="hint">Each call: no tools, a one-line system prompt, structured output, 4 turns, a $0.10 budget threshold. Three tasks run at a time, with a 240-second deadline per strategy. All 8 strategies cost about $0.80 in total. Needs <code>ANTHROPIC_API_KEY</code> in .env{facts && !facts.liveAvailable ? " (not set on this server)" : ""}.</p>
    <div className="row">
      <button className="primary" disabled={!!busy || !facts?.liveAvailable} onClick={() => run([strategy])}>{busy === "run" ? "Running…" : `Run ${strategy}`}</button>
      <button disabled={!!busy || !facts?.liveAvailable} onClick={() => run(facts!.strategies)}>Run all {facts?.strategies.length} strategies</button>
      {busy && <button onClick={stop}>Stop</button>}
      {summaries.length > 0 && !busy && <button onClick={() => setSummaries([])}>Clear comparison</button>}
    </div>
    {(rows.length > 0 || Object.keys(routes).length > 0) && <div className="scroll-x"><table className="tools compare"><thead><tr><th>Task</th><th>Label</th><th>Route</th><th>Answer</th><th>Correct</th><th>Cost</th><th>Time</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.task}><td><code>{row.task}</code></td><td>{row.label}</td><td>{row.route.map(short).join(" → ")}<br /><span className="hint">{row.why}</span></td><td><code>{row.answer || row.status}</code></td><td>{row.correct ? "yes" : "no"}</td><td>{usd(row.costUsd)}{row.routerCostUsd > 0 && <span className="hint"><br />router {usd(row.routerCostUsd)}</span>}</td><td>{(row.ms / 1000).toFixed(1)} s</td></tr>)}
      {Object.entries(routes).filter(([task]) => !rows.some((row) => row.task === task)).map(([task, route]) => <tr key={task}><td><code>{task}</code></td><td colSpan={6} className="hint">routed to {route} · solving…</td></tr>)}
    </tbody></table></div>}
    {summaries.length > 0 && <>
      <h4>Comparison</h4>
      <div className="scroll-x"><table className="tools compare"><thead><tr><th>Strategy</th><th>Correct</th><th>Total cost</th><th>Cost per correct</th><th>Router cost</th><th>Escalations</th><th>Median time</th><th>Spend by model</th></tr></thead><tbody>
        {summaries.map((s) => <tr key={s.strategy}><td>{s.strategy}</td><td>{s.correct}/{s.tasks}</td><td>{usd(s.costUsd)}</td><td>{s.costPerCorrect === null ? "–" : usd(s.costPerCorrect)}</td><td>{s.routerCostUsd ? usd(s.routerCostUsd) : "–"}</td><td>{s.escalations || "–"}</td><td>{(s.medianMs / 1000).toFixed(1)} s</td><td>{Object.entries(s.byModel).map(([model, cost]) => `${short(model)} ${usd(cost)}`).join(" · ")}</td></tr>)}
      </tbody></table></div>
      <p className="hint">Cost is what <code>modelUsage</code> billed for each <code>query()</code>, router calls included. One run per strategy is an anecdote, not a benchmark: re-run it, or move the task set into lesson 52's evals before you decide.</p>
    </>}

    <h3>D · Routing inside one agent: a subagent with its own model</h3>
    <p>A Haiku orchestrator classifies a sentence itself and delegates the lineup puzzle to an <code>expert</code> subagent defined with <code>model</code>. One <code>query()</code>, two models on the bill.</p>
    <div className="row">
      <select value={expertModel} disabled={!!busy} onChange={(e) => setExpertModel(e.target.value)} style={{ width: "auto" }}>
        <option value="claude-opus-5-5">expert on Opus 5.5</option><option value="claude-sonnet-5-5">expert on Sonnet 5.5</option>
      </select>
      <button className="primary" disabled={!!busy || !facts?.liveAvailable} onClick={delegate}>{busy === "delegate" ? "Running…" : "Run delegation (billed)"}</button>
    </div>
    {delegation.events.map((row, i) => <div className="card" key={i}>{row.kind === "delegation"
      ? <><b>{short(row.data.by)} → Agent(<code>{row.data.subagent}</code>)</b><pre className="wrap">{row.data.prompt}</pre></>
      : <span className="hint">main {row.data.main} · expert {row.data.expert}</span>}</div>)}
    {delegation.summary && <div className="card"><b>{delegation.summary.correct ? "Correct" : "Check the answer"} · {usd(delegation.summary.costUsd)}</b>
      <pre className="wrap">{delegation.summary.answer}</pre>
      <div className="scroll-x"><table className="tools"><thead><tr><th>Model (modelUsage key)</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead><tbody>
        {delegation.summary.usage.map((u: Usage) => <tr key={u.model}><td><code>{u.model}</code></td><td>{u.inputTokens.toLocaleString("en")}</td><td>{u.outputTokens.toLocaleString("en")}</td><td>{usd(u.costUsd)}</td></tr>)}
      </tbody></table></div>
      <p className="hint">The orchestrator pays for the Agent tool definition on every turn, so delegation has a fixed overhead. The subagent may run on the 1M-context variant (<code>[1m]</code>).</p></div>}
    <MessageLog messages={delegation.messages} />

    <h3>E · Where a model name really resolves</h3>
    <div className="row">
      <button disabled={!!busy} onClick={() => once("models")}>{busy === "models" ? "Asking…" : "supportedModels() (free, no model turn)"}</button>
      <button disabled={!!busy || !facts?.liveAvailable} onClick={() => once("resolution")}>{busy === "resolution" ? "Running…" : "Resolution check (3 tiny calls, ≈ $0.01)"}</button>
    </div>
    {supported && <div className="scroll-x"><table className="tools"><thead><tr><th>value</th><th>resolvedModel</th><th>Display name</th><th>Effort</th></tr></thead><tbody>
      {supported.map((m) => <tr key={m.value}><td><code>{m.value}</code></td><td><code>{m.resolvedModel ?? "–"}</code></td><td>{m.displayName}</td><td>{m.supportsEffort ? "yes" : "no"}</td></tr>)}
    </tbody></table></div>}
    {resolution && <div className="scroll-x"><table className="tools compare"><thead><tr><th>Request</th><th>Billed models (modelUsage)</th><th>Cost</th></tr></thead><tbody>
      {resolution.map((row) => <tr key={row.label}><td>{row.label}</td><td>{row.usage.map((u: Usage) => <div key={u.model}><code>{u.model}</code> {u.inputTokens.toLocaleString("en")} in / {u.outputTokens} out</div>)}</td><td>{usd(row.costUsd)}</td></tr>)}
    </tbody></table></div>}
    <p className="hint">Aliases follow the CLI version: upgrade the SDK and <code>sonnet</code> can change model. <code>ANTHROPIC_DEFAULT_SONNET_MODEL</code> (and the HAIKU and OPUS variants) remap an alias without code changes. With nonessential traffic allowed, Claude Code may add an auxiliary call on its small fast model (<code>ANTHROPIC_SMALL_FAST_MODEL</code>); it shows up as an extra <code>modelUsage</code> row. The lab sets <code>CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1</code> so the comparison measures only the routed model.</p>

    <h3>F · Apply it to your agent</h3>
    <ol className="steps">
      <li>Build a graded task set from real traffic first. Without one, a router is a guess.</li>
      <li>Measure the one-model baselines, including the strong model at lower <code>effort</code>. If that wins, you do not need a router, and you keep one prompt cache (caches are per model).</li>
      <li>Compare strategies by cost and latency <b>per correct answer</b>. A cheap model that thinks for 30 seconds can cost more than a strong one that answers in 6.</li>
      <li>Keep the router cheaper than what it saves: rules are free but brittle; a classifier costs a call per task.</li>
      <li>Cascade only on a real check (tests, a schema, a validator). Self-reported confidence misses confident mistakes.</li>
      <li>Pin explicit model IDs in code. Use the <code>ANTHROPIC_DEFAULT_*_MODEL</code> variables for central remapping, and <code>fallbackModel</code> (lesson 14) for availability, not quality.</li>
      <li>Read <code>modelUsage</code>, not just <code>total_cost_usd</code>: it shows which models actually ran, including subagents and auxiliary calls.</li>
    </ol>

    <h3>G · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/overview" target="_blank" rel="noreferrer">Agent SDK overview</a>, <a href="https://code.claude.com/docs/en/model-config" target="_blank" rel="noreferrer">Model configuration</a> and <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noreferrer">Pricing</a>.</p>
  </section>;
}
