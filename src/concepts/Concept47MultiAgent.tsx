import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Lanes = Record<string, Ev[]>;

const usd = (n?: number) => (n === undefined || Number.isNaN(n) ? "" : `$${n.toFixed(4)}`);
const k = (n?: number) => (n === undefined ? "" : n.toLocaleString("en-US"));
const sec = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);
const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const of = (events: Ev[] | undefined, name: string) => (events ?? []).filter((e) => e.event === name).map((e) => e.data);
const last = (events: Ev[] | undefined, name: string) => of(events, name).at(-1);
/** The first error of a run: a result with is_error, a failed agent, a failed stage, a stopped loop. */
const failureOf = (events: Ev[] | undefined): string | undefined => {
  for (const { event, data: d } of events ?? []) {
    if (event === "result" && (d.isError || d.subtype !== "success")) return d.text;
    if (event === "agent-end" && d.status === "failed") return d.error ?? d.summary;
    if (event === "stage" && d.error) return d.error;
    if (event === "stopped" || event === "error") return d.text ?? d.message;
  }
};
/** At least one agent finished its job (a completed row), so the run's numbers mean something. */
const anyCompleted = (events: Ev[] | undefined) => of(events, "agent-end").some((d) => d.status === "completed");

// ---------------------------------------------------------------------------------------------
// The timeline: one row per agent, built from agent-start / agent-end (and the rest of each agent's events)
// ---------------------------------------------------------------------------------------------

type Row = {
  id: string;
  name: string;
  depth: number;
  parent: string;
  start: number;
  end?: number;
  status?: string;
  background?: boolean;
  launched?: boolean;
  prompt?: string;
  description?: string;
  summary?: string;
  cost?: number;
  costEstimate?: number;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  model?: string;
  skipped?: string;
  check?: { check: string; good: boolean };
  tools: { name: string; input: string; at: number }[];
  progress: string[];
  gates: { verdict: string; reason?: string; report: string; at: number }[];
};

function buildRows(events: Ev[]): Row[] {
  const rows = new Map<string, Row>();
  for (const { event, data: d } of events) {
    const r = rows.get(d.row);
    if (event === "agent-start") rows.set(d.row, { id: d.row, name: d.name, depth: d.depth, parent: d.parent, start: d.at, background: d.background, prompt: d.prompt, description: d.description, tools: [], progress: [], gates: [] });
    if (event === "agent-skip") rows.set(d.row, { id: d.row, name: d.name, depth: 1, parent: "code", start: d.at, end: d.at, status: "skipped", skipped: d.reason, tools: [], progress: [], gates: [] });
    if (!r) continue;
    if (event === "agent-end") Object.assign(r, { end: d.at, status: d.status, summary: d.summary, cost: d.cost ?? r.cost, tokens: d.tokens ?? r.tokens, toolUses: d.toolUses ?? r.toolUses, durationMs: d.durationMs ?? r.durationMs });
    if (event === "agent-report") Object.assign(r, { model: d.model, tokens: d.tokens, toolUses: d.toolUses, durationMs: d.durationMs, costEstimate: d.costEstimate, summary: d.text });
    if (event === "agent-progress") r.progress.at(-1) !== d.text && r.progress.push(d.text);
    if (event === "agent-launched") r.launched = true;
    if (event === "tool") r.tools.push({ name: d.name, input: d.input, at: d.at });
    if (event === "gate") r.gates.push(d);
    if (event === "check") r.check = d;
  }
  // Tree order: every agent right under the one that started it.
  const all = [...rows.values()].sort((a, b) => a.start - b.start);
  const out: Row[] = [];
  const walk = (parent: string) => all.filter((r) => r.parent === parent).forEach((r) => (out.push(r), walk(r.id)));
  walk("main");
  walk("code");
  return out;
}

function Timeline({ events, root }: { events: Ev[]; root: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = buildRows(events);
  const now = Math.max(1, ...events.map((e) => e.data.at ?? 0));
  const mainTools = of(events, "tool").filter((t) => t.row === "main");
  const pct = (ms: number) => `${(ms / now) * 100}%`;
  const bar = (start: number, end: number | undefined, cls: string, title: string) => (
    <div className="wf-track">
      <div className={`wf-bar ${cls}`} style={{ left: pct(start), width: `max(2px, ${pct((end ?? now) - start)})` }} title={title} />
    </div>
  );
  return (
    <div className="waterfall ma-timeline">
      <div className="wf-row" onClick={() => setOpen(open === "root" ? null : "root")}>
        <span className="wf-name">
          <b>{root}</b>
        </span>
        {bar(0, now, "ma-root", root)}
        <span className="wf-ms">{sec(now)}</span>
      </div>
      {open === "root" && mainTools.length > 0 && (
        <div className="wf-detail">
          {mainTools.map((t, i) => (
            <div key={i} className="snippet">
              <span className="tag tag-call">{t.name}</span> <code>{t.input}</code> <span className="subtype">@ {sec(t.at)}</span>
            </div>
          ))}
        </div>
      )}
      {rows.map((r) => {
        const cls = r.status === "skipped" ? "ma-skipped" : r.status === "failed" ? "wf-error" : r.status === "stopped" ? "ma-stopped" : r.background ? "ma-bg" : `ma-d${Math.min(r.depth, 3)}`;
        const blocked = r.gates.filter((g) => g.verdict === "block").length;
        return (
          <div key={r.id}>
            <div className={`wf-row ${open === r.id ? "open" : ""}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="wf-name" style={{ paddingLeft: r.depth * 14 }}>
                {r.name}
                {r.background && <span className="subtype"> · background</span>}
                {r.gates.length > 0 && <b className={blocked ? "bad" : "good"}> · gate {blocked ? `blocked ×${blocked}` : "pass"}</b>}
                {r.check && <b className={r.check.good ? "good" : "bad"}> · {r.check.good ? "✓" : "✗"}</b>}
                {r.skipped && <span className="subtype"> · skipped</span>}
              </span>
              {bar(r.start, r.end, cls, `${r.name}: ${sec(r.start)} → ${r.end !== undefined ? sec(r.end) : "running"}`)}
              <span className="wf-ms">{r.end !== undefined ? sec(r.end - r.start) : "…"}</span>
            </div>
            {open === r.id && (
              <div className="wf-detail card">
                <div className="snippet">
                  <b>depth</b> {r.depth} · <b>started by</b> {r.parent === "main" ? "the main thread" : r.parent === "code" ? "your code (a query() call)" : (rows.find((x) => x.id === r.parent)?.name ?? r.parent)}
                  {r.model && <> · <code>{r.model}</code></>}
                  {r.tokens !== undefined && <> · {k(r.tokens)} tokens</>}
                  {r.cost !== undefined && <> · <b>{usd(r.cost)}</b></>}
                  {r.costEstimate !== undefined && <> · ≈ {usd(r.costEstimate)} (from its usage)</>}
                </div>
                {r.prompt && (
                  <div className="snippet">
                    <b>its prompt</b> (all it knows): {r.prompt}
                  </div>
                )}
                {r.tools.map((t, i) => (
                  <div key={i} className="snippet">
                    <span className="tag tag-call">{t.name}</span> <code>{t.input}</code> <span className="subtype">@ {sec(t.at)}</span>
                  </div>
                ))}
                {r.progress.length > 0 && <div className="subtype">task_progress: {r.progress.join(" → ")}</div>}
                {r.launched && <div className="subtype">Agent tool_result: "Async agent launched" at once; the report came later in task_notification.summary.</div>}
                {r.gates.map((g, i) => (
                  <div key={i} className={`tool-call ${g.verdict === "block" ? "denied" : ""}`}>
                    <span className="tag tag-gate">SubagentStop</span> <b className={g.verdict === "pass" ? "good" : "bad"}>{g.verdict}</b> <span className="snippet">{g.report}</span>
                    {g.reason && <div className="subtype">reason → the worker: {g.reason}</div>}
                  </div>
                ))}
                {r.check && <div className={`snippet ${r.check.good ? "" : "bad"}`}>code check: {r.check.check}</div>}
                {r.skipped && <div className="subtype">{r.skipped}</div>}
                {r.summary && <pre className="wrap tur">{r.summary}</pre>}
              </div>
            )}
          </div>
        );
      })}
      <div className="subtype ma-legend">
        <span className="wf-dot ma-d1" /> depth 1 <span className="wf-dot ma-d2" /> depth 2 <span className="wf-dot ma-bg" /> background <span className="wf-dot wf-error" /> failed{" "}
        <span className="wf-dot ma-stopped" /> stopped · click a row for its prompt, tools and report
      </div>
    </div>
  );
}

/** The main thread's words and results (and the orchestration events that are not a row). */
function MainEvents({ events }: { events: Ev[] }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "result")
          return (
            <div key={i} className={`tool-call ${d.subtype !== "success" || d.isError ? "denied" : ""}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>result #{d.n}{d.isError && " · is_error"}</span> <span className="subtype">@ {sec(d.at)} · total_cost_usd {usd(d.cost)}{d.n > 1 ? " (running total, all results so far)" : ""} · {d.turns} turns{Object.keys(d.modelUsage ?? {}).length > 0 && ` · modelUsage ${Object.entries(d.modelUsage).map(([m, c]) => `${m.replace("claude-", "")} ${usd(c as number)}`).join(", ")}`}</span>
              <pre className="wrap tur">{d.text}</pre>
            </div>
          );
        if (event === "supervisor")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-gate">your code → the dispatcher</span> <span className="subtype">@ {sec(d.at)} · a new user turn in the same (held-open) session</span>
              <div className="snippet">{d.text}</div>
            </div>
          );
        if (event === "stopped")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">loop stopped</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "guard")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">budget guard</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span> <span className="snippet">{d.message}</span>
            </div>
          );
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------------------------

export function Concept47MultiAgent() {
  const [facts, setFacts] = useState<any>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [orch, setOrch] = useState<Lanes>({});
  const [tree, setTree] = useState<Lanes>({});
  const [pipe, setPipe] = useState<Lanes>({});
  const [fan, setFan] = useState<Lanes>({});
  const [loop, setLoop] = useState<Lanes>({});
  const [gate, setGate] = useState(true);
  const [limit, setLimit] = useState(3);
  const [budget, setBudget] = useState(0.1);
  const [rounds, setRounds] = useState(3);

  useEffect(() => {
    // The server needs a few seconds to start (and restarts on a change): retry for up to 45 s instead of staying empty.
    let stopped = false;
    const get = async (url: string) => {
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) return r.json();
          if (![502, 503, 504].includes(r.status) || i >= 30) throw new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`);
        } catch (e) {
          if (i >= 30 || !(e instanceof TypeError)) throw e;
        }
        if (stopped) throw new Error("unmounted");
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    get("/api/c47/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c47/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, body: object, set: (f: (p: Lanes) => Lanes) => void) {
    set(() => ({}));
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done" && data.lane) set((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] }));
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const btn = (key: string, label: string, url: string, body: object, set: (f: (p: Lanes) => Lanes) => void) => (
    <button className={running === key ? "active" : ""} onClick={() => run(key, url, body, set)} disabled={!!running}>
      {running === key ? "Running…" : label}
    </button>
  );

  // Part B's numbers
  const lead = orch.lead;
  const leadRows = lead ? buildRows(lead) : [];
  const leadResult = last(lead, "result");
  const workersEstimate = sum(leadRows.map((r) => r.costEstimate));
  const workerTime = sum(leadRows.map((r) => (r.end !== undefined ? r.end - r.start : 0)));
  const workersWall = leadRows.length ? Math.max(...leadRows.map((r) => r.end ?? 0)) - Math.min(...leadRows.map((r) => r.start)) : 0;
  const blocks = leadRows.flatMap((r) => r.gates).filter((g) => g.verdict === "block").length;

  // Part E's numbers
  const fanVerdict = last(fan.fanout, "verdict");
  const fanRows = fan.fanout ? buildRows(fan.fanout).filter((r) => r.id !== "merge") : [];
  const peak = (() => {
    let best = 0;
    for (const r of fanRows) best = Math.max(best, fanRows.filter((x) => x.status !== "skipped" && x.start <= r.start && (x.end ?? Infinity) > r.start).length);
    return best;
  })();

  return (
    <section className="ma-wrap">
      <h2>47 · Multi-agent orchestration</h2>
      <p className="lead">
        One agent with every tool and a long prompt gets slow, expensive and confused. Several <b>specialists</b>, each with a small prompt, the tools it needs and a clear output, do better,
        but someone has to <b>orchestrate</b> them: split the job, run the parts (in parallel when they are independent), check what comes back, and merge it. That someone can be{" "}
        <b>the model</b> (a lead agent with the <code>Agent</code> tool, Parts B and C) or <b>your code</b> (one <code>query()</code> per agent, Parts D to F). Tab 8 introduced subagents; this tab is
        about putting several of them to work together.
      </p>
      <div className="card">
        <pre>{`// MODEL-DRIVEN: one query(), the lead decides who does what
query({ prompt: "Sales report for north, south and east", options: {
  agent: "lead",                                           // the main thread IS the lead agent
  agents: { lead: { tools: ["Agent(analyst)"], … }, analyst: { tools: ["Read"], … } },
  hooks: { SubagentStop: [{ hooks: [qualityGate] }] },     // check every report before the lead sees it
} });

// CODE-DRIVEN: your code decides; each agent is a query() with its own prompt, tools and schema
const { tickets } = await runAgent("extractor", prompt, { outputFormat: schema(Tickets) });
const answers = await Promise.all(tickets.map((t) => limit(() => runAgent(t.category, …))));`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}
      {(() => {
        const failure = [orch.lead, tree.tree, tree.send, pipe.pipeline, fan.fanout, loop.loop].map(failureOf).find((f) => f && /credit balance|api key|authentication|401|403|overloaded|rate limit/i.test(f));
        if (!failure) return null;
        return (
          <div className="card warn">
            <b>The Anthropic API refused the calls</b> — <code>{failure}</code>
            <div className="hint">
              {/credit balance/i.test(failure) ? (
                <>
                  The account of <code>ANTHROPIC_API_KEY</code> (in <code>.env</code>) has no credit left. Add credit in the Claude Console (Billing), or leave the key empty in <code>.env</code> to use
                  your Claude Code login instead, then restart <code>npm run dev</code>.
                </>
              ) : (
                <>Check <code>ANTHROPIC_API_KEY</code> in <code>.env</code> (or your Claude Code login), then restart <code>npm run dev</code>.</>
              )}{" "}
              Until then every agent fails at its first call, so the parts below show no workers, no checks and no costs: that is not what the scenarios do.
            </div>
          </div>
        );
      })()}

      <h3>A · Two ways to orchestrate</h3>
      <p className="hint">
        SDK {facts?.sdkVersion ?? "…"} · Claude Code {facts?.claudeCodeVersion ?? "…"} · the lab's data: five regional CSV files (the server knows every right answer, total {k(facts?.grandTotal)}{" "}
        units) and an inbox of five customer emails. Every agent is Haiku 4.5, thinking off.
      </p>
      <table className="tools compare">
        <thead>
          <tr>
            <th />
            <th>model-driven (the Agent tool)</th>
            <th>code-driven (one query() per agent)</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["who plans", "the lead model: it chooses how many workers, which ones, and what to tell them", "your code: the order, the fan-out and the retries are written down"],
            ["parallel", "several Agent calls in ONE assistant message run at the same time", "Promise.all, with your own concurrency limit"],
            ["handoff", "the worker's final text becomes the Agent tool_result (marked “[Subagent hand-back] … NOT a message from the user”)", "structured_output (outputFormat), checked with zod before the next stage"],
            ["checking", "hooks: SubagentStop (block + reason sends the worker back), PreToolUse", "plain code between the calls: if, zod, a comparison with the truth"],
            ["cost per agent", "estimated from each Agent tool_use_result's usage; modelUsage splits by model, not by agent", "exact: each query() has its own total_cost_usd and maxBudgetUsd"],
            ["good for", "open-ended jobs where the split is not known in advance", "repeatable workflows, auditing, SLAs, budgets"],
          ].map(([a, b, c]) => (
            <tr key={a}>
              <td>
                <b>{a}</b>
              </td>
              <td className="snippet">{b}</td>
              <td className="snippet">{c}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="compare-grid lanes43">
        <div className="card">
          <b>The Agent tool's input (sdk-tools.d.ts)</b>
          <table className="tools compare cache-bps">
            <tbody>
              {(facts?.agentInput ?? []).map((f: any) => (
                <tr key={f.name}>
                  <td>
                    <code>{f.name}</code>
                  </td>
                  <td className="snippet">{f.doc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <b>The options and fields this tab uses (sdk.d.ts)</b>
          {[
            ["agent", facts?.agentOption],
            ["spawn_depth", facts?.spawnDepth],
            ["SubagentStop output", facts?.subagentStop],
            ["agentProgressSummaries", facts?.agentProgressSummaries],
          ].map(([n, d]) => (
            <div key={n} className="snippet">
              <code>{n}</code>: {d ?? "…"}
            </div>
          ))}
        </div>
      </div>

      <h3>B · Orchestrator and workers, inside one query()</h3>
      <p className="hint">
        <code>agent: "lead"</code> makes the main thread the lead agent: its prompt, its tools (<code>Agent(analyst)</code> only), its model. It starts one <code>analyst</code> per region{" "}
        <b>in one message</b>, so they run in parallel. A <code>SubagentStop</code> hook reads each report (<code>last_assistant_message</code>) and checks it against the data: a wrong
        format or a wrong total is answered with <code>decision: "block"</code> and a reason, which goes back to <b>the worker</b>, not to the lead. About $0.03.
      </p>
      <div className="scenarios">
        {btn("orch", "1 · Lead + 3 analysts", "/api/c47/orchestrator", { gate }, setOrch)}
        <label className="subtype">
          <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} disabled={!!running} /> SubagentStop quality gate
        </label>
      </div>
      {lead && (
        <div className="card">
          <Timeline events={lead} root="lead (main thread)" />
          {leadRows.length > 0 && (
            <table className="tools compare cloud-table">
              <thead>
                <tr>
                  <th>worker</th>
                  <th>its prompt from the lead</th>
                  <th>report</th>
                  <th>gate</th>
                  <th>tokens · time · ≈ cost</th>
                </tr>
              </thead>
              <tbody>
                {leadRows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.name} <span className="subtype">{r.description}</span>
                    </td>
                    <td className="snippet">{r.prompt}</td>
                    <td className="snippet">{r.summary}</td>
                    <td>{r.gates.map((g, i) => <div key={i}><b className={g.verdict === "pass" ? "good" : "bad"}>{g.verdict}</b> {g.reason && <span className="subtype">{g.reason}</span>}</div>)}</td>
                    <td className="snippet">
                      {k(r.tokens)} · {sec(r.durationMs)} · {usd(r.costEstimate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <MainEvents events={lead} />
          {leadResult && (leadResult.isError || !leadRows.length) && (
            <p className="hint bad">
              The lead failed before it could start any worker ({failureOf(lead) ?? "no worker was started"}): nothing was delegated, checked or merged.
            </p>
          )}
          {leadResult && !leadResult.isError && leadRows.length > 0 && (
            <p className="hint">
              {leadRows.length} workers, {sec(workerTime)} of work in {sec(workersWall)}{workerTime > workersWall * 1.2 ? ": they ran in parallel" : ""}. The run cost {usd(leadResult.cost)} (<code>total_cost_usd</code>); the workers' share
              is about {usd(workersEstimate)} (computed from the <code>usage</code> in each <code>Agent</code> tool_use_result), the lead's own calls the rest. {gate ? (blocks ? `The gate sent ${blocks} report(s) back; the worker fixed it before the lead saw it.` : "The gate passed every report this time: open a row to see what it checked, or run again (Haiku does not always keep the format).") : "Gate off: whatever a worker says goes straight to the lead."}
            </p>
          )}
        </div>
      )}

      <h3>C · Deeper trees and live messages</h3>
      <p className="hint">
        Two runs at once. <b>Left</b>: a director (main thread) → a manager → two analysts. A subagent may start subagents: the analysts run at <code>spawn_depth</code> 2. Their messages
        do <b>not</b> reach the stream (only depth 1 is forwarded); the timeline finds them through <code>task_started</code> (every depth) and a <code>PreToolUse</code> hook (its{" "}
        <code>agent_id</code> says which agent made the call). <b>Right</b>: a dispatcher starts a slow worker in the <b>background</b> with a <code>name</code>, then steers it with{" "}
        <code>SendMessage</code>: the message is queued and delivered “at its next tool round”. This lane keeps its input open until the worker has reported. About $0.05.
      </p>
      <div className="scenarios">{btn("tree", "2 · A 3-level tree + SendMessage", "/api/c47/hierarchy", {}, setTree)}</div>
      {Object.keys(tree).length > 0 && (
        <div className="compare-grid lanes43">
          {[
            ["tree", "director → manager → analysts"],
            ["send", "dispatcher → background surveyor + SendMessage"],
          ].map(([l, title]) => (
            <div key={l} className="card">
              <b>{title}</b>
              {tree[l] ? (
                <>
                  <Timeline events={tree[l]} root={l === "tree" ? "director (main thread)" : "dispatcher (main thread)"} />
                  {of(tree[l], "tool")
                    .filter((t) => t.row === "main" && t.name === "SendMessage")
                    .map((t, i) => (
                      <div key={i} className="tool-call">
                        <span className="tag tag-call">SendMessage</span> <code>{t.input}</code> <span className="subtype">@ {sec(t.at)}</span>
                      </div>
                    ))}
                  <MainEvents events={tree[l]} />
                  {last(tree[l], "verdict")?.reportCheck && (
                    <table className="tools compare cloud-table">
                      <thead>
                        <tr>
                          <th>the code checks the final answer</th>
                          <th>total</th>
                          <th>best product</th>
                        </tr>
                      </thead>
                      <tbody>
                        {last(tree[l], "verdict").reportCheck.map((c: any) => (
                          <tr key={c.region}>
                            <td className="snippet">
                              <b>{c.region}</b> {c.line}
                            </td>
                            <td className={c.total === "ok" ? "" : "bad"}>{c.total}</td>
                            <td className={c.best === "ok" ? "" : "bad"}>{c.best}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {last(tree[l], "verdict")?.reportCheck?.some((c: any) => c.total !== "ok" || c.best !== "ok") && (
                    <p className="hint bad">
                      The orchestrator's final answer does not match the data. Whatever it says about it (“complete”, “could not be determined”), the code check is what counts. The code
                      sends one correction turn; if the answer is still wrong after it, the run stops here and reports the gap instead of looping.
                    </p>
                  )}
                </>
              ) : (
                <span className="hint">Waiting…</span>
              )}
            </div>
          ))}
        </div>
      )}
      {Object.keys(tree).length > 0 && !running && ![tree.tree, tree.send].some(anyCompleted) && (
        <p className="hint bad">Both runs failed before any subagent started ({failureOf(tree.tree) ?? failureOf(tree.send)}): there is no tree and no message to look at.</p>
      )}
      {[tree.tree, tree.send].some(anyCompleted) && (
        <p className="hint">
          Left: the depth-2 rows exist only because of <code>task_started</code> and the hooks. A <code>SubagentStop</code> or <code>PreToolUse</code> hook is the one place that sees (and can stop)
          every level. Right: the first <code>result</code> comes while the worker is still running (the dispatcher only said it is waiting); the report arrives as a{" "}
          <code>task_notification</code> and wakes the dispatcher up for a second <code>result</code>. The worker applies the message from its next line on, so the lines it wrote before
          it (usually north) have no <code>BEST=</code>. The dispatcher is told to check the report and send the worker back for what is missing: a message to a worker that has already finished starts
          it again (a new row). A model's “all five regions have BEST” is a claim, not a check, and the worker
          sometimes <b>guesses</b> a value it never re-read (north's BEST as P1 or P3). So the <b>code supervises</b>: when the session goes quiet, it checks the dispatcher's last answer against
          the data (the table) and, if something is wrong, sends <b>one</b> more user turn into the same session naming exactly what (“your code → the dispatcher”). The dispatcher has the worker
          re-read those files, and the code checks again.
          This lane keeps Claude Code's input <b>open</b> (streaming input) until the session has been idle for 4 s: with a plain string prompt the input closes at once, and Claude Code then
          “kills hold-back tasks at the held-result release” (sdk.d.ts). In the first version of this lab that cut the worker off after two or three files (“I was stopped while reading
          east.csv… awaiting instructions”, “permission blocks”). So: a one-shot <code>query()</code> is for foreground work; background workers need a session that stays open until they report.
        </p>
      )}

      <h3>D · A pipeline, orchestrated by your code</h3>
      <p className="hint">
        Three stages, seven <code>query()</code> calls. <b>1</b>: an extractor reads the inbox and returns tickets (<code>outputFormat</code>, checked with zod). <b>2</b>: the router is{" "}
        <b>plain code</b> (a map from category to specialist), and the specialists answer in parallel, at most 3 at a time, each with its own policy as system prompt. <b>3</b>: an editor gets
        only the data of stage 2 and writes the digest. The code then checks that every escalated ticket is in the digest. About $0.03.
      </p>
      <div className="scenarios">{btn("pipe", "3 · Extract → route → answer → edit", "/api/c47/pipeline", {}, setPipe)}</div>
      {pipe.pipeline && (
        <div className="card">
          <Timeline events={pipe.pipeline} root="your code" />
          <div className="compare-grid lanes43">
            {[1, 2, 3].map((n) => {
              const st = of(pipe.pipeline, "stage").filter((s) => s.n === n);
              if (!st.length) return null;
              const done = st.find((s) => s.output || s.error);
              return (
                <div key={n} className="card">
                  <b>
                    stage {n} · {st[0].name}
                  </b>{" "}
                  <span className="subtype">{st[0].note}</span>
                  {st.find((s) => s.routes) && <div className="snippet">router (code): {st.find((s) => s.routes).routes.map((r: any) => `#${r.id} → ${r.to}`).join(" · ")}</div>}
                  {done?.error && <div className="snippet bad">{done.error}</div>}
                  {done?.output && (
                    <>
                      <div className="subtype">
                        the handoff to the next stage (data, not a conversation) · {usd(done.cost)}
                        {done.ms !== undefined && ` · ${sec(done.ms)}`}
                      </div>
                      <pre className="wrap tur">{JSON.stringify(done.output, null, 1)}</pre>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <MainEvents events={pipe.pipeline} />
          {last(pipe.pipeline, "verdict") && (
            <p className="hint">
              {last(pipe.pipeline, "verdict").agents} agents, {usd(last(pipe.pipeline, "verdict").cost)} (the sum of their exact <code>total_cost_usd</code>). Escalated by the specialists: {last(pipe.pipeline, "verdict").escalated?.map((id: number) => `#${id}`).join(", ") || "none"}. Code checks on the digest: missing from its list{" "}
              <b className={last(pipe.pipeline, "verdict").missingEscalations.length ? "bad" : "good"}>{last(pipe.pipeline, "verdict").missingEscalations.join(", ") || "none"}</b>, not named in its text{" "}
              <b className={last(pipe.pipeline, "verdict").notInText?.length ? "bad" : "good"}>{last(pipe.pipeline, "verdict").notInText?.map((id: number) => `#${id}`).join(", ") || "none"}</b>, listed without being escalated{" "}
              <b className={last(pipe.pipeline, "verdict").extraEscalations?.length ? "bad" : "good"}>{last(pipe.pipeline, "verdict").extraEscalations?.join(", ") || "none"}</b>. Each specialist saw one
              ticket and one policy; none of them could leak another customer's data into its answer.
            </p>
          )}
        </div>
      )}

      <h3>E · Fan-out and fan-in: limits, failures, verification, a budget</h3>
      <p className="hint">
        Six workers (one per region; <code>islands.csv</code> does not exist) behind a <b>concurrency limit</b>, each with <code>maxTurns</code>, <code>maxBudgetUsd</code> and a schema. The code
        verifies every number against the data, and a <b>budget guard</b> stops the workers still running and skips the rest once the spend passes the budget (one shared{" "}
        <code>AbortController</code>). An aggregator merges only the <b>verified</b> results. About $0.04; set the budget to $0.008 to see the guard.
      </p>
      <div className="scenarios">
        {btn("fan", "4 · Six workers", "/api/c47/fanout", { limit, budgetUsd: budget }, setFan)}
        <label className="subtype">
          at most{" "}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={!!running}>
            {[1, 2, 3, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>{" "}
          at a time
        </label>
        <label className="subtype">
          budget ${" "}
          <select value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={!!running}>
            {[0.008, 0.02, 0.1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fan.fanout && (
        <div className="card">
          <Timeline events={fan.fanout} root="your code" />
          <MainEvents events={fan.fanout} />
          {fanVerdict && (
            <>
              <table className="tools compare cloud-table">
                <thead>
                  <tr>
                    <th>region</th>
                    <th>Promise.allSettled</th>
                    <th>structured_output</th>
                    <th>code check</th>
                    <th>cost</th>
                  </tr>
                </thead>
                <tbody>
                  {fanVerdict.settled.map((s: any) => (
                    <tr key={s.region}>
                      <td>{s.region}</td>
                      <td>
                        <b className={s.status === "fulfilled" ? "good" : "bad"}>{s.status}</b>
                      </td>
                      <td className="snippet">{s.status === "fulfilled" ? `found ${s.found} · total ${s.total} · best ${s.best || "-"}` : s.error}</td>
                      <td className={`snippet ${s.check?.startsWith("ok") ? "" : "bad"}`}>{s.check ?? ""}</td>
                      <td>{usd(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                Peak concurrency: <b>{peak}</b> (the limit was {of(fan.fanout, "options")[0]?.limit}). Spent {usd(fanVerdict.spent)} of a {usd(of(fan.fanout, "options")[0]?.budgetUsd)} budget.{" "}
                <code>Promise.allSettled</code>, not <code>Promise.all</code>: one failed worker must not throw away the others' work.{" "}
                {fanVerdict.merge
                  ? "The aggregator was told which regions have no verified result, so it cannot invent them:"
                  : "No worker returned a verified result, so the aggregator was not started: there is nothing to merge."}
              </p>
              {fanVerdict.merge && <pre className="wrap tur">{fanVerdict.merge}</pre>}
              {fanVerdict.mergeCheck?.length > 0 && (
                <p className="hint">
                  The code computed the total and the top region and passed them in (the aggregator only words them), then checked its text:{" "}
                  {fanVerdict.mergeCheck.map((c: any, i: number) => (
                    <span key={i} className={c.ok ? "" : "bad"}>
                      {c.ok ? "✓" : "✗"} {c.rule}
                      {i < fanVerdict.mergeCheck.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <h3>F · Evaluator and optimizer: a writer, a critic, a loop</h3>
      <p className="hint">
        The writer is an enthusiastic copywriter in <b>one session</b> (streaming input, Tab 12: it keeps its draft and the brief). The critic is a strict editor, a <b>new</b>{" "}
        <code>query()</code> every round (it sees only the rubric, the facts and this draft) that returns <code>{"{ approved, score, issues }"}</code>. The work is split by who can judge it: the <b>code</b>{" "}
        checks what it can measure exactly (words, the total, East, “!”); the <b>critic</b> judges only what code cannot (tone, numbers against the facts, invented facts such as a quarter name) and
        is told not to count. The loop ends when both pass, or after the last round. About $0.02.
      </p>
      <div className="scenarios">
        {btn("loop", "5 · Write until approved", "/api/c47/evaluator", { maxRounds: rounds }, setLoop)}
        <label className="subtype">
          at most{" "}
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} disabled={!!running}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>{" "}
          rounds
        </label>
      </div>
      {loop.loop && (
        <div className="card">
          <Timeline events={loop.loop} root="your code" />
          {of(loop.loop, "round").length > 0 && (
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>round</th>
                <th>the writer's draft</th>
                <th>code checks</th>
                <th>the critic</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {of(loop.loop, "round").map((r) => (
                <tr key={r.n}>
                  <td>
                    {r.n} {r.approved && <b className="good">approved</b>}
                  </td>
                  <td className="snippet">
                    <pre className="wrap tur">{r.draft}</pre>
                  </td>
                  <td className="snippet">
                    {r.checks.map((c: any) => (
                      <div key={c.rule} className={c.ok ? "" : "bad"}>
                        {c.ok ? "✓" : "✗"} {c.rule} {c.detail && <span className="subtype">({c.detail})</span>}
                      </div>
                    ))}
                  </td>
                  <td className="snippet">
                    <b className={r.critic.approved ? "good" : "bad"}>{r.critic.approved ? "approved" : "rejected"}</b> · score {r.critic.score}
                    {r.critic.issues.map((x: string, i: number) => (
                      <div key={i}>- {x}</div>
                    ))}
                  </td>
                  <td>{usd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
          <MainEvents events={loop.loop} />
          {last(loop.loop, "verdict") && of(loop.loop, "round").length > 0 && (
            <p className="hint">
              {of(loop.loop, "round").length} round(s), {usd(last(loop.loop, "verdict").cost)}. The feedback of each round is the code's failed checks plus the critic's issues, sent as the next turn
              of the same writer session. Counting is a job for code, tone is a job for a model: when the critic was also asked to count, it rejected a draft of exactly 60 words as “approximately 67”
              and cost a round. A cap on the rounds is not optional: without one, a
              writer and a critic that disagree loop (and bill) forever.
            </p>
          )}
        </div>
      )}

      <h3>G · A checklist for multi-agent systems</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>rule</th>
            <th>how, in the SDK</th>
            <th>seen in</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Give each agent one job", "AgentDefinition: a short prompt, only the tools it needs (tools: [\"Read\"]), maxTurns; or one query() with its own systemPrompt", "B, D"],
            ["Workers start from zero", "A subagent sees only its definition's prompt and the prompt it was given: put everything it needs in it (Tab 8)", "B (open a row)"],
            ["Run independent work in parallel", "Several Agent calls in one message, or Promise.all with a limiter; wall time ≈ the slowest worker", "B, D, E"],
            ["Make the handoff data", "outputFormat + zod between stages, a strict line format for workers; stop the pipeline at the first bad shape", "B, D, E"],
            ["Check before you trust", "SubagentStop with decision: \"block\" (the worker fixes it), code checks against known facts, also on the orchestrator's final answer; stop_hook_active prevents an endless loop", "B, C, E, F"],
            ["Scope who may start whom", "Agent(type) in a SUBAGENT's tools. On the main-thread agent it holds for the whole tree (the probe: a manager that could only start managers, to depth 3)", "B, C"],
            ["Keep background work alive", "A string prompt closes the input, and Claude Code then kills held-back background tasks: give background workers a streaming-input session that stays open until they report", "C"],
            ["Split the judging", "Code checks what it can measure (counts, totals, fields); a model judges only what code cannot (tone, invented facts), and is told not to count", "F"],
            ["Bound everything", "maxTurns per agent, maxBudgetUsd per query(), a total budget guard with an AbortController, a cap on loop rounds", "E, F"],
            ["Plan for failure", "Promise.allSettled, a found: false field, tell the aggregator what is missing instead of letting it guess", "E"],
            ["Watch every level", "task_started (spawn_depth), task_progress, task_notification, SubagentStart/Stop and PreToolUse (agent_id); forwardSubagentText for depth 1's text", "B, C"],
            ["Keep costs per agent", "code-driven: each total_cost_usd; model-driven: the usage in each Agent tool_use_result; modelUsage splits by model", "B, D"],
            ["Treat reports as untrusted", "Claude Code already wraps each report as “[Subagent hand-back] … NOT a message from the user”; do not give a worker's text more authority in your own code", "B"],
          ].map(([a, b, c]) => (
            <tr key={a}>
              <td>
                <b>{a}</b>
              </td>
              <td className="snippet">{b}</td>
              <td>{c}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>H · The code</h3>
      <div className="row">
        {["data", "options", "observe", "run-agent", "gate", "scenario-orchestrator", "scenario-hierarchy", "scenario-pipeline", "scenario-fanout", "scenario-evaluator"].map(
          (r) =>
            typeof code[r] === "string" && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && typeof code[openCode] === "string" && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
