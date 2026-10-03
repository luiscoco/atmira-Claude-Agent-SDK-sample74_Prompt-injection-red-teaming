import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import type { Baseline, Comparison, RunReport, TrialRecord } from "../../server/evals/baseline";
import type { CalibrationItem, summarize } from "../../server/evals/calibration";
import type { PairOutcome } from "../../server/evals/judge";

type Facts = {
  agentModel: string; rubricVersion: string; judgeSystem: string; verdictSchema: unknown;
  judges: Record<string, string>;
  criteria: { id: string; title: string; question: string }[];
  variants: Record<string, { title: string; expect: string }>;
  cases: { id: string; title: string; prompt: string; customer: string }[];
  golden: { id: string; reply: string; note: string; human: Record<string, boolean> }[];
  trust: { minKappa: number; maxLenient: number }; commands: string[];
  baseline: (Pick<Baseline, "id" | "variant" | "trials" | "note" | "fingerprint" | "totals"> & { synthetic: boolean }) | null;
};
type Calibration = ReturnType<typeof summarize> & { trusted: boolean };
const money = (n: number) => `$${n.toFixed(4)}`;

function ComparisonTable({ value }: { value: Comparison }) {
  return <div className="card">
    <p><b>Comparison: {value.verdict.toUpperCase()}</b> · agent cost/trial {money(value.cost.base)} → {money(value.cost.cand)} ({value.cost.deltaPct.toFixed(0)}%)</p>
    {[...value.stale, ...value.warnings].map((s) => <p className="hint" key={s}>{s}</p>)}
    <p className="hint">Changes under test: {value.changed.join("; ") || "none"}</p>
    <div className="eval-table"><table className="tools"><thead><tr><th>Case / metric</th><th>Baseline</th><th>Candidate</th><th>p</th><th>Verdict</th></tr></thead>
      <tbody>{value.rows.map((r) => <tr key={`${r.caseId}:${r.metric}`}>
        <td>{r.caseId}<br />{r.metric}{r.critical && " (gate)"}</td>
        <td>{r.base ? `${r.base.k}/${r.base.n}` : "—"}</td><td>{r.cand ? `${r.cand.k}/${r.cand.n}` : "—"}</td>
        <td>{r.p?.toFixed(3) ?? "—"}</td><td>{r.verdict}</td>
      </tr>)}</tbody></table></div>
  </div>;
}

export function Concept52Evals() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [source, setSource] = useState("rubric:rubric");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [actionScope, setActionScope] = useState("page");
  const [variant, setVariant] = useState("cold-tone");
  const [judge, setJudge] = useState("heuristic");
  const [trials, setTrials] = useState(3);
  const [demo, setDemo] = useState<{ candidate: RunReport; comparison: Comparison } | null>(null);
  const [items, setItems] = useState<CalibrationItem[]>([]);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [records, setRecords] = useState<TrialRecord[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [caseId, setCaseId] = useState("damaged-item");
  const [pair, setPair] = useState<PairOutcome | null>(null);
  const [sides, setSides] = useState<{ baseline: string; candidate: string } | null>(null);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function json(url: string, signal: AbortSignal, body?: unknown) {
    const r = await fetch(`/api/c52/${url}`, { signal, ...(body !== undefined && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!r.ok) {
      const detail = await r.json().catch(() => null);
      if (typeof detail?.error === "string") throw new Error(detail.error);
      if (r.status === 404) throw new Error("Lesson 52 is missing from the running backend. Restart npm run dev from the sample52 folder, then retry.");
      throw new Error(`Lesson server returned HTTP ${r.status}. Retry once the server is ready.`);
    }
    return r.json();
  }

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([json("facts", abort.signal), json("code", abort.signal)])
      .then(([f, c]) => { if (!abort.signal.aborted) { setFacts(f); setCode(c); setCaseId(f.cases[0].id); setError(""); } })
      .catch((e) => { if (!abort.signal.aborted) setError(`Unable to load lesson 52. ${e instanceof Error ? e.message : String(e)}`); });
    return () => { abort.abort(); abortRef.current?.abort(); };
  }, [attempt]);

  async function job(name: string, fn: (signal: AbortSignal) => Promise<void>, scope = "page") {
    if (abortRef.current) return;
    const abort = new AbortController(); abortRef.current = abort;
    setActionScope(scope); setBusy(name); setError(""); setNotice("");
    try { await fn(abort.signal); }
    catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (abort.signal.aborted) setNotice("Stopped. Partial results are shown; no baseline was promoted."); setBusy(""); abortRef.current = null; }
  }

  async function stream(route: string, body: unknown, signal: AbortSignal, onEvent: (event: string, data: any) => void) {
    await streamPost(`/api/c52/${route}`, body, (event, data) => {
      if (event === "error") throw new Error(data.message);
      onEvent(event, data);
    }, signal);
  }

  const promotionBlocked = !report ? "Run the live suite in section D first. Offline demos cannot be promoted."
    : report.trials < 3 ? "Run at least three trials per case before promoting."
    : !report.totals.trials || report.totals.infraErrors || report.totals.judgeErrors ? "This run has missing measurements or execution errors. Fix the errors in section D and rerun before promoting."
    : "";
  const pairBlocked = !report ? "Run the live suite in section D first to produce a candidate reply."
    : !facts?.baseline ? "A stored baseline is required before comparing replies."
    : !report.cases[caseId]?.sample?.reply ? `No candidate reply was produced for ${caseId}. ${report.records?.find((r) => r.caseId === caseId)?.infra ?? "Check the failed trials in section D and rerun."}`
    : "";
  function actionFeedback(scope: string) {
    if (actionScope !== scope) return null;
    return <div aria-live="polite">
      {busy && <p role="status">{busy}… <button onClick={() => abortRef.current?.abort()}>Stop</button></p>}
      {error && <div className="card warn" role="alert">{error}</div>}
      {notice && <p className="card" role="status">{notice}</p>}
    </div>;
  }

  return <section>
    <h2>52. Evals in depth: judges & regression baselines</h2>
    <p className="lead">Measure model behaviour across repeated trials. Combine business checks with a calibrated judge, then compare changes against a committed baseline.</p>
    {error && <div className="card warn" role="alert">{error}{!facts && <p><button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button></p>}</div>}
    {!facts && !error && <p role="status">Loading lesson…</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <div className="row" role="status">{busy}… <button onClick={() => abortRef.current?.abort()}>Stop</button></div>}

    <h3>A · A rubric with evidence</h3>
    <p>Code checks inspect refunds, tickets and tenant boundaries. The judge inspects the customer-visible reply against orders, policies, tool results and persisted effects. Each criterion returns evidence and a binary verdict.</p>
    {facts?.criteria.map((c) => <details className="card" key={c.id}><summary>{c.title}</summary><p>{c.question}</p></details>)}
    <details className="card"><summary>Judge instructions & output schema ({facts?.rubricVersion})</summary><pre className="wrap">{facts?.judgeSystem}</pre><pre className="wrap">{JSON.stringify(facts?.verdictSchema, null, 2)}</pre></details>

    <h3>B · Explore a regression without model calls</h3>
    <label>Prompt change<select disabled={!!busy || !facts} value={variant} onChange={(e) => setVariant(e.target.value)}>{Object.entries(facts?.variants ?? {}).map(([id, v]) => <option key={id} value={id}>{v.title}</option>)}</select></label>
    <p className="hint">{facts?.variants[variant]?.expect} Live results may vary.</p>
    <button disabled={!!busy || !facts} onClick={() => job("Comparing synthetic trials", async (s) => setDemo(await json("demo", s, { variant })))}>Compare offline demo</button>
    {demo && <><p className="hint">Synthetic {demo.candidate.variant} trials · zero model calls. These examples illustrate the rules; they are not measured model performance.</p><ComparisonTable value={demo.comparison} /></>}
    <p>Money and privacy checks are strict gates: one failure fails the comparison. Other metrics use a pass-rate drop of at least 20 percentage points and one-sided Fisher p &lt; 0.1. A “suspect” result needs more trials. These small samples and unadjusted per-metric tests are exploratory evidence.</p>

    <h3>C · Calibrate the judge first</h3>
    <label>Judge<select disabled={!!busy || !facts} value={judge} onChange={(e) => { setJudge(e.target.value); setCalibration(null); setItems([]); }}>{Object.entries(facts?.judges ?? {}).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
    <p className="hint">Keyword calibration is free. Sonnet and Haiku calibration call the model. Release trust requires κ ≥ {facts?.trust.minKappa ?? 0.6}, at most {facts?.trust.maxLenient ?? 2} lenient misses, and no judge errors. Calibration is advisory in this lab; promotion does not enforce it.</p>
    <button disabled={!!busy || !facts} onClick={() => job("Calibrating judge", async (s) => { setItems([]); setCalibration(null); await stream("calibrate", { judge }, s, (e, d) => { if (e === "item") setItems((xs) => [...xs, d]); if (e === "summary") setCalibration(d); }); })}>Calibrate on {facts?.golden.length ?? "the"} human-labelled replies</button>
    {calibration && <div className="card"><b>{calibration.trusted ? "Meets trust bar" : "Does not meet trust bar"}</b><p>Agreement {(calibration.overall.agreement * 100).toFixed(0)}% · κ {calibration.overall.kappa.toFixed(3)} · lenient {calibration.overall.lenient} · harsh {calibration.overall.harsh} · errors {calibration.judgeErrors} · {money(calibration.costUsd)}</p></div>}
    {facts?.golden.map((g) => {
      const item = items.find((i) => i.id === g.id);
      return <details className="card" key={g.id}><summary>{g.id}{item && ` · ${item.graded.ok ? `${item.disagreements.length} disagreement(s)` : "judge error"}`}</summary><p className="snippet">{g.reply}</p><p>{g.note}</p><p>Human failures: {Object.entries(g.human).filter(([, pass]) => !pass).map(([id]) => id).join(", ") || "none"}</p>{item && <pre className="wrap">{JSON.stringify(item, null, 2)}</pre>}</details>;
    })}

    <h3>D · Run the live suite</h3>
    <p>Each of the five support cases starts with isolated state. The agent uses {facts?.agentModel ?? "Haiku"}; its selected judge grades the reply afterwards. Even with the keyword judge, this suite calls the agent model and costs money.</p>
    <label>Trials per case<select disabled={!!busy} value={trials} onChange={(e) => setTrials(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
    <button className="primary" disabled={!!busy || !facts} onClick={() => job("Running live agent evals", async (s) => {
      setRecords([]); setReport(null); setComparison(null); setPair(null); setSides(null);
      await stream("run", { variant, trials, judge }, s, (e, d) => { if (e === "trial-end") setRecords((xs) => [...xs, d]); if (e === "report") setReport(d); if (e === "comparison") { if (d.missing) setNotice("No baseline yet. Review this run before promoting it."); else setComparison(d); } });
    })}>Run {5 * trials} live trials</button>
    <p role="status">{records.length} trials completed{report && ` · agent ${money(report.totals.agentCostUsd)} · judge ${money(report.totals.judgeCostUsd)} · ${report.totals.infraErrors} infrastructure errors`}</p>
    {records.map((r) => <details className="card" key={`${r.caseId}:${r.trial}`}><summary>{r.caseId} #{r.trial} · {r.infra ? "infrastructure error" : r.checks.every((c) => c.pass) ? "code checks pass" : "code checks fail"}</summary><p className="snippet">{r.reply || "No reply"}</p><pre className="wrap">{JSON.stringify({ checks: r.checks, judge: r.judge, infra: r.infra }, null, 2)}</pre></details>)}
    {comparison && <ComparisonTable value={comparison} />}

    <h3>E · Review and promote a baseline</h3>
    <p>Stored baseline: {facts?.baseline ? `${facts.baseline.variant}, ${facts.baseline.trials} trials/case (${facts.baseline.id})` : "none"}{facts?.baseline?.synthetic && " · synthetic teaching fixture"}.</p>
    {facts?.baseline && !facts.baseline.totals.trials && <p className="card warn" role="alert">The stored baseline has no measured trials. Resolve the live-run errors and promote a completed run before using it as a reference.</p>}
    <p>The harness fingerprint tracks the judge, rubric and cases. Changing those makes a comparison stale: rerun the baseline agent with the new harness. Changes to agent model, prompt or policies are the changes under test.</p>
    <label>Reason for replacing the baseline<input maxLength={200} value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} /></label>
    <button disabled={!!busy || !!promotionBlocked} aria-describedby="promotion-requirements" onClick={() => job("Promoting reviewed run", async (s) => {
      const result = await json("promote", s, { runId: report!.id, note });
      setNotice(`Baseline saved: ${result.baseline.id}${note.trim() ? ` — ${note.trim()}` : ""}. Review and commit evals/baseline.json.`);
      setFacts(await json("facts", s));
    }, "promote")}>{busy && actionScope === "promote" ? "Saving baseline…" : "Promote this live run to baseline"}</button>
    <p id="promotion-requirements" className="hint">{promotionBlocked || `Ready to promote ${report?.variant} (${report?.id}).`}</p>
    {actionFeedback("promote")}
    <p className="hint">Promotion overwrites evals/baseline.json and needs at least three trials per case. Review individual failures and calibration before making this run the reference.</p>

    <h3>F · Compare replies in both orders</h3>
    <label>Case<select value={caseId} disabled={!!busy} onChange={(e) => setCaseId(e.target.value)}>{facts?.cases.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
    <p className="hint">Selected judge: {facts?.judges[judge] ?? judge}.</p>
    {report && facts?.baseline?.id === report.id && <p className="hint">This candidate is already the stored baseline; the comparison uses the same run on both sides.</p>}
    <button disabled={!!busy || !!pairBlocked} aria-describedby="pairwise-requirements" onClick={() => job("Comparing sample replies", async (s) => { setPair(null); setSides(null); await stream("pairwise", { runId: report!.id, caseId, judge }, s, (e, d) => { if (e === "sides") setSides(d); if (e === "outcome") setPair(d); }); if (!s.aborted) setNotice("Comparison complete. The replies and verdict are shown below."); }, "pairwise")}>{busy && actionScope === "pairwise" ? "Judging replies…" : "Judge baseline vs candidate"}</button>
    <p id="pairwise-requirements" className="hint">{pairBlocked || "Ready to compare the stored baseline with this live run."}</p>
    {actionFeedback("pairwise")}
    {sides && <div className="compare-grid"><div className="card"><b>Baseline</b><p className="snippet">{sides.baseline}</p></div><div className="card"><b>Candidate</b><p className="snippet">{sides.candidate}</p></div></div>}
    {pair && <div className="card"><b>{pair.winner} · {pair.consistent ? "consistent after swap" : "order-sensitive; treated as tie"}</b><pre className="wrap">{JSON.stringify(pair.orders, null, 2)}</pre><p>{money(pair.costUsd)}</p></div>}
    <p className="hint">This compares one selected sample per case, not all trials. Swapping A/B exposes position bias; the metric table remains the regression evidence.</p>

    <h3>G · Read the code and run in CI</h3>
    <label>Source<select value={source} onChange={(e) => setSource(e.target.value)}>{Object.keys(code).map((id) => <option key={id}>{id}</option>)}</select></label>
    <details className="card"><summary>Show {source}</summary><pre className="wrap">{code[source] ?? "Loading…"}</pre></details>
    <pre className="wrap">{facts?.commands.join("\n")}</pre>
    <p>CLI exit codes: 0 passes, 1 fails regression or budget gates, 2 means stale data or an execution error. Live comparisons save runs under eval-lab/runs/ and append a Markdown report to the GitHub step summary. See Tab52-Evals-in-depth.md and ci-kit/workflows/agent-evals.yml.</p>
  </section>;
}
