import { useEffect, useRef, useState } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type Issue = { row: number; kind: string; column: string; detail: string };
type Computation = { id: string; tool: string; input: unknown; output: Record<string, unknown> };
type Chart = { id: string; computationId: string; kind: "bar" | "line"; title: string; metric: string; points: { label: string; value: number }[] };
type Snapshot = { rowCount: number; issues: Issue[]; computations: Computation[]; charts: Chart[] };
type Finding = { statement: string; value: number; unit: string; computationId: string };
type Report = { headline: string; findings: Finding[]; charts: string[]; caveats: string[] };
type Verification = { ok: boolean; findings: { index: number; verdict: string; detail: string; uncheckedProse: number[] }[]; charts: { id: string; exists: boolean }[] };
type Call = { name: string; input: unknown; result: unknown };

const presets: { label: string; name: string; input: unknown }[] = [
  { label: "Profile the dataset", name: "profile_dataset", input: {} },
  { label: "Revenue by month", name: "aggregate", input: { metric: "revenue_eur", by: ["order_month"] } },
  { label: "Units: raw total", name: "aggregate", input: { metric: "units", quality: "raw" } },
  { label: "Units: clean total", name: "aggregate", input: { metric: "units" } },
  { label: "Return rate by product", name: "aggregate", input: { metric: "return_rate", by: ["product"] } },
  { label: "Jan → Jun by region", name: "compare_periods", input: { metric: "revenue_eur", from: "2026-01", to: "2026-06", by: "region" } },
  { label: "Chart C2 as a line", name: "make_chart", input: { computationId: "C2", kind: "line", title: "Revenue by month (EUR)" } },
  { label: "Blocked: raw SQL", name: "aggregate", input: { sql: "SELECT SUM(revenue_eur) FROM sales" } },
  { label: "Blocked: unknown column", name: "aggregate", input: { metric: "profit", by: ["customer"] } },
];

/** One series, one axis, value labels on hover; the table view below carries the same numbers. */
function ChartView({ chart }: { chart: Chart }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560; const H = 220; const pad = { l: 64, r: 16, t: 16, b: 32 };
  const max = Math.max(...chart.points.map((p) => p.value), 0) * 1.1 || 1;
  const min = Math.min(0, ...chart.points.map((p) => p.value));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min));
  const step = (W - pad.l - pad.r) / chart.points.length;
  const x = (i: number) => pad.l + step * (i + 0.5);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  const fmt = (v: number) => Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v * 100) / 100}`;
  const barW = Math.min(48, step - 2);
  return <figure className="analysis-chart card">
    <figcaption><b>{chart.title}</b> <span className="hint">{chart.id} · from {chart.computationId} · {chart.metric}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${chart.title}: ${chart.points.map((p) => `${p.label} ${p.value}`).join(", ")}`} onMouseLeave={() => setHover(null)}>
      {ticks.map((t) => <g key={t}><line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} /><text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
      {chart.kind === "line" && <polyline className="series-line" points={chart.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />}
      {chart.points.map((p, i) => <g key={p.label}>
        {chart.kind === "bar"
          ? <path className="series-fill" d={`M${x(i) - barW / 2},${y(0)} V${y(p.value) + 4} q0,-4 4,-4 H${x(i) + barW / 2 - 4} q4,0 4,4 V${y(0)} Z`} />
          : <circle className="series-dot" cx={x(i)} cy={y(p.value)} r={hover === i ? 6 : 4} />}
        <text className="axis" x={x(i)} y={H - 10} textAnchor="middle">{p.label}</text>
        {hover === i && <text className="value" x={x(i)} y={y(p.value) - 10} textAnchor="middle">{p.value}</text>}
        <rect className="hit" x={x(i) - step / 2} y={pad.t} width={step} height={H - pad.t - pad.b} onMouseEnter={() => setHover(i)}><title>{`${p.label}: ${p.value}`}</title></rect>
      </g>)}
    </svg>
    <details><summary>Table view</summary><table className="compare"><tbody>{chart.points.map((p) => <tr key={p.label}><td>{p.label}</td><td>{p.value}</td></tr>)}</tbody></table></details>
  </figure>;
}

function ReportView({ report, verification, charts }: { report: Report; verification?: Verification; charts: Chart[] }) {
  return <div className="card">
    <b>{report.headline}</b>
    <ol>{report.findings.map((f, i) => {
      const check = verification?.findings[i];
      return <li key={i}>{f.statement} <span className="hint">[{f.value} {f.unit} · {f.computationId}]</span>
        {check && <div className={`hint verdict-${check.verdict === "verified" ? "ok" : "bad"}`}>{check.verdict === "verified" ? "✔ verified" : `✖ ${check.verdict}`}: {check.detail}
          {check.uncheckedProse.length > 0 && <> ⚠ Other numbers in the sentence not found in the cited computation: {check.uncheckedProse.join(", ")}.</>}</div>}
      </li>;
    })}</ol>
    {report.caveats.length > 0 && <><p className="hint">Caveats</p><ul>{report.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
    {verification && <p className={verification.ok ? "verdict-ok" : "verdict-bad"}><b>{verification.ok ? "Report verified: every cited number is in the ledger." : "Needs review: at least one claim is not backed by the ledger."}</b>
      {verification.charts.filter((c) => !c.exists).map((c) => <span key={c.id}> Chart {c.id} was never drawn.</span>)}</p>}
    {report.charts.map((id) => charts.find((c) => c.id === id)).filter((c): c is Chart => !!c).map((c) => <ChartView key={c.id} chart={c} />)}
  </div>;
}

export function Concept71DataAnalysisAgent() {
  const [id, setId] = useState(""); const [snapshot, setSnapshot] = useState<Snapshot>();
  const [facts, setFacts] = useState<{ csv: string; systemPrompt: string; model: string; limits: { maxTurns: number; maxBudgetUsd: number; deadlineMs: number } }>();
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [toolName, setToolName] = useState("profile_dataset"); const [toolInput, setToolInput] = useState("{}");
  const [toolResult, setToolResult] = useState<unknown>();
  const [scripted, setScripted] = useState<{ calls: Call[]; report: Report; verification: Verification; tampered: Report }>();
  const [draft, setDraft] = useState(""); const [draftCheck, setDraftCheck] = useState<{ report: Report; verification: Verification }>();
  const [question, setQuestion] = useState("Which regions are growing and which are shrinking between January and June 2026, and is the Pro product returned more often than Basic? Chart the most useful result.");
  const [messages, setMessages] = useState<any[]>([]); const [calls, setCalls] = useState<Call[]>([]);
  const [live, setLive] = useState<{ report?: Report; verification?: Verification; invalid?: string; costUsd: number; turns: number }>();
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { request("/api/c71/facts").then(setFacts).catch((e) => setError(String(e))); }, []);

  async function request(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`); return data;
  }
  async function guarded(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const start = () => guarded(async () => {
    const data = await request("/api/c71/sessions", {});
    setId(data.id); setSnapshot(data); setToolResult(undefined); setScripted(undefined); setDraft(""); setDraftCheck(undefined);
    setMessages([]); setCalls([]); setLive(undefined);
  });
  const callTool = () => guarded(async () => {
    let input: unknown;
    try { input = JSON.parse(toolInput); } catch { throw new Error("Tool input is not valid JSON."); }
    const data = await request(`/api/c71/sessions/${id}/tool`, { name: toolName, input });
    setSnapshot(data);
    if (data.ok) setToolResult(data.result); else { setToolResult(undefined); setNotice(`Rejected by the host: ${data.message}`); }
  });
  const runScripted = () => guarded(async () => {
    const data = await request(`/api/c71/sessions/${id}/scripted`, {});
    setSnapshot(data);
    if (!data.ok) { setNotice(data.message); return; }
    setScripted(data); setDraft(JSON.stringify(data.report, null, 2)); setDraftCheck(undefined);
  });
  const verifyDraft = () => guarded(async () => {
    let report: Report;
    try { report = JSON.parse(draft); } catch { throw new Error("The report is not valid JSON."); }
    const data = await request(`/api/c71/sessions/${id}/verify`, { report });
    if (!data.ok) { setDraftCheck(undefined); setNotice(data.message); return; }
    setDraftCheck({ report, verification: data.verification });
  });
  async function runLive() {
    setBusy(true); setError(""); setNotice(""); setMessages([]); setCalls([]); setLive(undefined);
    const abort = new AbortController(); controller.current = abort;
    try {
      await streamPost(`/api/c71/sessions/${id}/query`, { question }, (event, data) => {
        if (event === "message") setMessages((all) => [...all, data]);
        if (event === "tool") setCalls((all) => [...all, data]);
        if (event === "report") setLive(data);
        if (event === "snapshot") setSnapshot(data);
        if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { setError(abort.signal.aborted ? "Run stopped. The ledger keeps every computation made before Stop." : String(e)); }
    finally { setBusy(false); }
  }

  const csvRows = facts?.csv.trim().split("\n") ?? [];
  const flagged = new Set(snapshot?.issues.map((issue) => issue.row));
  const callList = (items: Call[]) => items.map((call, index) => <details className="card" key={index}>
    <summary>{call.name} {JSON.stringify(call.input)} {(call.result as { computationId?: string; chartId?: string; error?: string })?.computationId ?? (call.result as { chartId?: string })?.chartId ?? ((call.result as { error?: string })?.error ? "✖ rejected" : "")}</summary>
    <pre className="wrap">{JSON.stringify(call.result, null, 2)}</pre></details>);

  return <>
    <h2>71. A data-analysis agent</h2>
    <p>A language model is good at choosing an analysis and explaining it, and unreliable at arithmetic over many rows. So split the work: the model plans, the host computes, and every number in the final report must point at the computation that produced it.</p>
    <div className="grid">
      <div className="card"><b>Tools, not code</b><p>Four read-only tools over a CSV the host parsed. Metrics, columns and filters are enumerations. No Bash, no Python, no SQL, no file access.</p></div>
      <div className="card"><b>A computation ledger</b><p>Each tool result gets an ID (C1, C2…) and is stored. Charts are drawn by the host from a ledger entry, never from numbers the model typed.</p></div>
      <div className="card"><b>Verified report</b><p><code>outputFormat</code> forces JSON findings that cite computation IDs. The host checks each number against the ledger. Schema-valid is not the same as true.</p></div>
    </div>
    {error && <p className="card warn" role="alert">{error}</p>}
    {notice && <p className="card warn" role="status">{notice}</p>}

    <h3>A · The dataset</h3>
    <p>Fictional sales for six months, four regions and two products ({csvRows.length - 1} CSV lines). Four traps are planted: a typo outlier, an empty revenue cell, a duplicated line and a note that tries to give the model orders.</p>
    <button disabled={busy} onClick={start}>{id ? "Start a fresh lab" : "Start lab (offline)"}</button>
    {snapshot && <div className="card"><b>Quality issues found by code</b><ul>{snapshot.issues.map((issue) => <li key={`${issue.row}-${issue.kind}`}>Line {issue.row}: {issue.kind} — {issue.detail}</li>)}</ul>
      <p className="hint">“Clean” drops duplicate and outlier lines and skips empty cells. The rules are code, so “clean” means the same thing in every run.</p></div>}
    {facts && <details className="card"><summary>sales.csv ({csvRows.length - 1} rows; flagged lines highlighted)</summary><div className="scroll-x"><table className="compare">
      <thead><tr><th>Line</th>{csvRows[0].split(",").map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{csvRows.slice(1).map((line, i) => { const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.slice(0, 7).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "")); return <tr key={i} className={flagged.has(i + 2) ? "flagged" : undefined}><td>{i + 2}</td>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>; })}</tbody>
    </table></div></details>}

    <h3>B · Call the tools by hand (offline)</h3>
    <p>Exactly the functions and validation the model gets. Compare the raw and clean unit totals; then try the blocked inputs and read the message the model would receive.</p>
    <div className="card">
      <div className="row">{presets.map((p) => <button key={p.label} disabled={busy || !id} onClick={() => { setToolName(p.name); setToolInput(JSON.stringify(p.input, null, 1)); }}>{p.label}</button>)}</div>
      <label>Tool <select value={toolName} onChange={(e) => setToolName(e.target.value)}>{["profile_dataset", "aggregate", "compare_periods", "make_chart"].map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Input (JSON) <textarea value={toolInput} rows={4} onChange={(e) => setToolInput(e.target.value)} /></label>
      <button disabled={busy || !id} onClick={callTool}>Call tool</button>
      {toolResult !== undefined && <pre className="wrap">{JSON.stringify(toolResult, null, 2)}</pre>}
    </div>
    {snapshot && snapshot.charts.length > 0 && <details className="card"><summary>Charts in this lab ({snapshot.charts.length})</summary>{snapshot.charts.map((c) => <ChartView key={c.id} chart={c} />)}</details>}

    <h3>C · Offline analyst and the verifier</h3>
    <p>A fixed plan calls the same tools and writes a report in the agent's output format. The verifier then checks every finding against the ledger. Load the tampered copy (an inflated number, a citation to a computation that never ran and a chart that was never drawn), or edit the JSON yourself, and verify again.</p>
    <button disabled={busy || !id} onClick={runScripted}>Run offline analyst</button>
    {scripted && <>
      {callList(scripted.calls)}
      <ReportView report={scripted.report} verification={scripted.verification} charts={snapshot?.charts ?? []} />
      <div className="card">
        <label>Report JSON <textarea value={draft} rows={12} onChange={(e) => setDraft(e.target.value)} /></label>
        <div className="row">
          <button disabled={busy} onClick={() => { setDraft(JSON.stringify(scripted.tampered, null, 2)); setDraftCheck(undefined); }}>Load tampered report</button>
          <button disabled={busy} onClick={() => { setDraft(JSON.stringify(scripted.report, null, 2)); setDraftCheck(undefined); }}>Load original report</button>
          <button disabled={busy || !draft.trim()} onClick={verifyDraft}>Verify against ledger</button>
        </div>
      </div>
      {draftCheck && <ReportView report={draftCheck.report} verification={draftCheck.verification} charts={snapshot?.charts ?? []} />}
    </>}

    <h3>D · Ask the analyst (live, billed)</h3>
    <p>Uses configured Anthropic credentials, {facts?.model ?? "Haiku"}, the four analysis tools, no built-in tools or project settings, structured output, {facts?.limits.maxTurns ?? 14} turns, a ${facts?.limits.maxBudgetUsd ?? 0.25} budget and a {(facts?.limits.deadlineMs ?? 120_000) / 1000}-second deadline. Its computations join this lab's ledger, and its report is verified the same way.</p>
    <div className="card"><label>Question <textarea value={question} disabled={busy} maxLength={2000} onChange={(e) => setQuestion(e.target.value)} /></label>
      <button disabled={busy || !id || !question.trim()} onClick={runLive}>Ask analyst (billed)</button>{" "}
      <button disabled={!busy || !controller.current || controller.current.signal.aborted} onClick={() => controller.current?.abort()}>Stop</button></div>
    {callList(calls)}
    {live?.report && <ReportView report={live.report} verification={live.verification} charts={snapshot?.charts ?? []} />}
    {live?.invalid && <p className="card warn">The structured output did not match the report schema: {live.invalid}</p>}
    {live && <p className="hint">SDK cost: ${live.costUsd.toFixed(4)} · {live.turns} turns.</p>}
    <MessageLog messages={messages} />

    <h3>E · Ledger, prompt and implementation</h3>
    <details className="card"><summary>Computation ledger ({snapshot?.computations.length ?? 0})</summary><pre className="wrap">{JSON.stringify(snapshot?.computations ?? [], null, 2)}</pre></details>
    {facts && <details className="card"><summary>System prompt</summary><pre className="wrap">{facts.systemPrompt}</pre></details>}
    <button onClick={async () => { try { setCode(await request("/api/c71/code")); } catch (e) { setError(String(e)); } }}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
    <p>Production notes: put the real data behind the same kind of narrow, typed tools (or a sandboxed code runner whose outputs are recorded the same way), keep quality rules in code, store the ledger with the report, and show readers the computation behind each number. The verifier checks that a cited number exists in the cited result; it does not judge whether the conclusion is sensible. A human still reads the report.</p>
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/custom-tools">Agent SDK custom tools</a> · <a href="https://code.claude.com/docs/en/agent-sdk/structured-outputs">Structured outputs</a>.</p>
  </>;
}
