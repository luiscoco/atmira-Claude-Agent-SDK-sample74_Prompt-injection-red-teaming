import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";

type Refund = { id: string; customer: string; amountCents: number; daysSincePurchase: number; condition: string; expected: { decision: string; broken: string[] } };
type Facts = { refunds: Refund[]; policyText: string; systemPrompt: string; designs: string[]; designInfo: Record<string, string>; limits: Record<string, number>; leaseTtlMs: number; heartbeatMs: number; model: string; worker: string; liveAvailable: boolean };
type Sim = { design: string; crashAfter: number; issued: number; applied: number; suppressed: number; duplicates: number; timeline: string[] };
type PolicyRow = { situation: string; outcome: { kind: string; subtype?: string; message?: string }; action: string; why: string; delayMs: number };
type Segment = { n: number; mode: string; sessionId?: string; outcome: string; terminalReason?: string; turns?: number; reportedCostUsd?: number; settledAfter: number; action?: string; why?: string };
type Effect = { key: string; refundId: string; effect: string };
type JobView = {
  jobId: string; status: string; sessionId?: string; lease?: { owner: string; expiresAt: number }; settled: Record<string, { decision: string; reason: string; segment: number }>;
  segments: Segment[]; attempts: number; error?: string; settledCount: number; total: number; correct: number; costUsd: number; effects: Effect[]; leaseLive: boolean; drivenHere: boolean; orphan: boolean;
};
type LogRow = { kind: string; text: string };

const usd = (n: number) => `$${n.toFixed(4)}`;
const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
};
/** One readable line per supervisor event. Heartbeats and journal snapshots update state instead. */
function describe(event: string, data: any): LogRow | null {
  switch (event) {
    case "start": return { kind: "info", text: `${data.recover ? "Recover" : "Start"} ${data.jobId} on ${data.worker}${data.crashAfter ? ` · drill: kill after effect ${data.crashAfter}${data.wipeLocal ? " and wipe the local transcripts" : ""}` : ""}` };
    case "lease": return { kind: data.ok ? "info" : "bad", text: `lease: ${data.why}` };
    case "segment": return { kind: "segment", text: `segment ${data.n} · ${data.mode}${data.resume ? ` · resume ${data.resume.slice(0, 8)}…` : ""} · maxTurns ${data.maxTurns}\n  prompt: ${data.prompt}` };
    case "tool": return { kind: "tool", text: `  ${data.name}(${Object.keys(data.input ?? {}).length ? JSON.stringify(data.input) : ""})` };
    case "effect": return { kind: data.applied ? "effect" : "dup", text: data.applied ? `  ✓ ledger: ${data.effect}  [${data.key}]` : `  ⟲ ledger refused a repeat of ${data.key}: nothing done twice` };
    case "crash": return { kind: "bad", text: `💥 worker killed in segment ${data.segment}, after the side effect and before the journal write${data.wipeLocal ? "; local transcripts deleted" : ""}` };
    case "decision": return { kind: "decision", text: `→ ${data.action}${data.delayMs ? ` in ${data.delayMs} ms` : ""}: ${data.why}` };
    case "error": return { kind: "bad", text: data.message };
    default: return null;
  }
}

export function Concept60DurableAgents() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PolicyRow[]>([]);
  const [crashAfter, setCrashAfter] = useState(3);
  const [sims, setSims] = useState<Sim[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [drill, setDrill] = useState(3);
  const [wipeLocal, setWipeLocal] = useState(true);
  const [segmentTurns, setSegmentTurns] = useState(6);
  const [log, setLog] = useState<LogRow[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [beats, setBeats] = useState(0);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(["facts", "code", "policy", "jobs"].map((route) => getJson(`/api/c60/${route}`, { signal: controller.signal }))).then(([f, c, p, j]) => {
      if (!controller.signal.aborted) { setFacts(f); setCode(c); setPolicy(p); setJobs(j.jobs); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, [attempt]);
  useEffect(() => {
    const controller = new AbortController();
    getJson(`/api/c60/simulate?crashAfter=${crashAfter}`, { signal: controller.signal }).then(setSims).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [crashAfter]);

  const refreshJobs = async () => { try { setJobs((await getJson("/api/c60/jobs")).jobs); } catch (e) { setError(String(e)); } };
  async function live(route: "run" | "recover", body: object) {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(route); setError(""); setLog([]); setJob(null); setBeats(0);
    try {
      await streamPost(`/api/c60/${route}`, body, (event, data) => {
        if (controller.signal.aborted) return;
        if (event === "journal") setJob(data);
        else if (event === "heartbeat") setBeats((n) => n + 1);
        else { const row = describe(event, data); if (row) setLog((all) => [...all, row]); }
      }, controller.signal);
    } catch (e) { if (!controller.signal.aborted) setError(String(e).replace(/HTTP 409.*/, "HTTP 409: refused (see Jobs on disk for the reason)")); }
    finally { if (abortRef.current === controller) abortRef.current = null; setBusy(""); refreshJobs(); }
  }
  /** Recover goes through fetch first so a 409 (lease held, job done) shows the server's reason, not just a status. */
  async function recover(jobId: string) {
    setError("");
    const probe = jobs.find((row) => row.jobId === jobId);
    if (probe?.leaseLive && !probe.drivenHere) { setError(`Lease refused: ${probe.lease!.owner} holds it for ${Math.ceil((probe.lease!.expiresAt - Date.now()) / 1000)} more s. Refresh after it expires.`); return; }
    await live("recover", { jobId, segmentTurns });
  }
  const stop = () => { abortRef.current?.abort(); setLog((all) => [...all, { kind: "info", text: "Stopped by the operator: the lease is released and the job stays resumable (section E)." }]); };
  async function reset() {
    if (!window.confirm("Delete every lesson 60 journal, the ledger and the session store?")) return;
    try { await getJson("/api/c60/reset", { method: "POST" }); setJob(null); setLog([]); await refreshJobs(); } catch (e) { setError(String(e)); }
  }
  const settledRows = facts && job ? facts.refunds.filter((refund) => job.settled[refund.id]) : [];

  return <section>
    <h2>60. Durable, long-running agents</h2>
    <p className="lead">A long job will be interrupted: a deploy, a crash, a limit, an API error. Make the job, not the process, the durable thing: progress in a journal, side effects behind idempotency keys, one worker per job via a lease, and a supervisor that resumes the session in bounded segments.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Journal</b><p>Progress lives in a file written atomically, outside the model and the transcript. Tools read it, so a resumed or fresh session cannot redo finished work.</p></div>
      <div className="card"><b>Idempotency keys</b><p>Every side effect carries a key from stable ids (<code>settle:job:refund</code>). A retry after a crash finds the key and does nothing twice.</p></div>
      <div className="card"><b>Lease + heartbeat</b><p>One live worker per job. The heartbeat renews the lease every {facts ? facts.heartbeatMs / 1000 : "…"} s; a dead worker's lease expires after {facts ? facts.leaseTtlMs / 1000 : "…"} s and another may take over.</p></div>
      <div className="card"><b>Supervisor</b><p>Runs <code>query()</code> in segments bounded by <code>maxTurns</code> and <code>maxBudgetUsd</code>, and after each one decides: resume, retry, fresh session, done or fail.</p></div>
    </div>
    {error && <div className="card warn" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}

    <h3>A · The job: a nightly refund batch</h3>
    <p>{facts?.policyText}</p>
    <div className="scroll-x"><table className="tools"><thead><tr><th>Refund</th><th>Customer</th><th>Amount</th><th>Days</th><th>Condition</th><th>Policy says</th></tr></thead><tbody>
      {facts?.refunds.map((r) => <tr key={r.id}><td><code>{r.id}</code></td><td>{r.customer}</td><td>{(r.amountCents / 100).toFixed(2)} EUR</td><td>{r.daysSincePurchase}</td><td>{r.condition}</td><td>{r.expected.decision}{r.expected.broken.length > 0 && <span className="hint"> · {r.expected.broken.join(", ")}</span>}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Two tools: <code>next_refund</code> returns the first refund the journal lacks; <code>settle_refund</code> pays or emails (a side effect in the ledger), then journals the refund. R-105 sits exactly on both limits.</p>

    <h3>B · The crash window (offline)</h3>
    <p>The dangerous moment is after a side effect and before the journal write. Kill the worker there and see what each design does on restart.</p>
    <div className="card config">
      <label>Crash after side effect #{crashAfter}<input type="range" min={1} max={8} value={crashAfter} onChange={(e) => setCrashAfter(Number(e.target.value))} /></label>
    </div>
    <div className="scroll-x"><table className="tools compare"><thead><tr><th>Design</th><th>Effects issued</th><th>Applied</th><th>Suppressed by key</th><th>Duplicates</th><th>How it restarts</th></tr></thead><tbody>
      {sims.map((s) => <tr key={s.design}><td>{s.design}</td><td>{s.issued}</td><td>{s.applied}</td><td>{s.suppressed || "–"}</td><td style={{ color: s.duplicates ? "#c0392b" : undefined }}>{s.duplicates}</td><td className="hint">{facts?.designInfo[s.design]}</td></tr>)}
    </tbody></table></div>
    <details className="card"><summary>Timelines</summary>{sims.map((s) => <pre className="wrap" key={s.design}>{`${s.design}\n${s.timeline.join("\n")}`}</pre>)}</details>
    <p className="hint">A journal alone shrinks the damage to one duplicate: the item in the window. Only the key makes the retry harmless. The agent can be retried at least once; the key makes the effect happen exactly once.</p>

    <h3>C · The supervisor policy (offline)</h3>
    <p><code>nextAction(journal, outcome)</code> is pure and runs after every segment, crash or error. These rows are its real output.</p>
    <div className="scroll-x"><table className="tools compare"><thead><tr><th>Situation</th><th>Outcome</th><th>Action</th><th>Why</th></tr></thead><tbody>
      {policy.map((row) => <tr key={row.situation}><td>{row.situation}</td><td><code>{row.outcome.kind === "result" ? row.outcome.subtype : row.outcome.kind}</code></td><td><b>{row.action}</b>{row.delayMs > 0 && <span className="hint"> after {row.delayMs} ms</span>}</td><td className="hint">{row.why}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Limits: {facts && `${facts.limits.maxSegments} segments, $${facts.limits.jobBudgetUsd.toFixed(2)} per job, ${facts.limits.maxAttempts} failed attempts in a row, stop after ${facts.limits.stallSegments} segments without progress`}. The ladder for errors is retry the same session → fresh session → fail. A fresh session loses nothing that matters, because the continuation prompt and the tools come from the journal.</p>

    <h3>D · Run a durable job live (billed)</h3>
    <div className="card config">
      <label>Segment length (<code>maxTurns</code>)<input type="number" min={3} max={30} value={segmentTurns} disabled={!!busy} onChange={(e) => setSegmentTurns(Number(e.target.value))} /></label>
      <label>Crash drill<select value={drill} disabled={!!busy} onChange={(e) => setDrill(Number(e.target.value))}>
        <option value={0}>none</option>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>kill the worker after side effect {n}</option>)}
      </select></label>
      <label><input type="checkbox" checked={wipeLocal} disabled={!!busy || !drill} onChange={(e) => setWipeLocal(e.target.checked)} /> …and delete the local transcripts (a recreated container)</label>
    </div>
    <p className="hint">{facts?.model}, two in-process tools, a short system prompt, <code>maxBudgetUsd: 0.15</code> per segment, the transcript mirrored to a file <code>sessionStore</code> with <code>sessionStoreFlush: "eager"</code>. A job costs about $0.04–0.06. Needs <code>ANTHROPIC_API_KEY</code> in .env{facts && !facts.liveAvailable ? " (not set on this server)" : ""}.</p>
    <div className="row">
      <button className="primary" disabled={!!busy || !facts?.liveAvailable} onClick={() => live("run", { segmentTurns, wipeLocal: drill > 0 && wipeLocal, ...(drill ? { crashAfter: drill } : {}) })}>{busy === "run" ? "Running…" : "Run job"}</button>
      {busy && <button onClick={stop}>Stop (graceful)</button>}
    </div>
    {log.length > 0 && <pre className="wrap" style={{ maxHeight: 420, overflow: "auto" }}>{log.map((row) => row.text).join("\n")}</pre>}
    {job && <div className="card">
      <b>{job.jobId} · {job.status} · {job.settledCount}/{job.total} settled · {job.correct} match the policy · {job.effects.length} ledger effects · {usd(job.costUsd)}</b>
      <p className="hint">Session {job.sessionId ?? "–"} · lease {job.lease ? `${job.lease.owner}${job.leaseLive ? "" : " (expired)"}` : "released"} · heartbeats {beats}</p>
      <div className="scroll-x"><table className="tools"><thead><tr><th>#</th><th>Mode</th><th>Outcome</th><th>Turns</th><th>Settled after</th><th>Next</th></tr></thead><tbody>
        {job.segments.map((s) => <tr key={s.n}><td>{s.n}</td><td>{s.mode}</td><td><code>{s.outcome}</code>{s.terminalReason && <span className="hint"> · {s.terminalReason}</span>}</td><td>{s.turns ?? "–"}</td><td>{s.settledAfter}</td><td>{s.action ?? "…"}<br /><span className="hint">{s.why}</span></td></tr>)}
      </tbody></table></div>
      <p className="hint">Turns is the result's <code>num_turns</code>. A segment stopped by <code>maxTurns: {segmentTurns}</code> reports {segmentTurns + 1}: the SDK counts the turn that crossed the limit.</p>
      {settledRows.length > 0 && <div className="scroll-x"><table className="tools"><thead><tr><th>Refund</th><th>Agent</th><th>Policy</th><th>Segment</th><th>Reason given</th></tr></thead><tbody>
        {settledRows.map((r) => { const row = job.settled[r.id]; return <tr key={r.id}><td><code>{r.id}</code></td><td>{row.decision}</td><td style={{ color: row.decision === r.expected.decision ? undefined : "#c0392b" }}>{r.expected.decision}</td><td>{row.segment}</td><td className="hint">{row.reason}</td></tr>; })}
      </tbody></table></div>}
    </div>}

    <h3>E · Jobs on disk: recover what no worker holds</h3>
    <p>Journals survive the server. Stop a job, let the deadline cut it, or restart <code>npm run dev</code> in the middle of one: it shows up here. A job whose lease is still live is refused until the lease expires, so two workers never drive one job.</p>
    <div className="row">
      <button disabled={!!busy} onClick={refreshJobs}>Refresh</button>
      <button disabled={!!busy || jobs.length === 0} onClick={reset}>Delete all lesson 60 state</button>
      <span className="hint">This server is <code>{facts?.worker}</code>.</span>
    </div>
    {jobs.length > 0 && <div className="scroll-x"><table className="tools compare"><thead><tr><th>Job</th><th>Status</th><th>Settled</th><th>Effects</th><th>Segments</th><th>Lease</th><th>Cost</th><th></th></tr></thead><tbody>
      {jobs.map((j) => <tr key={j.jobId}><td><code>{j.jobId}</code></td><td>{j.status}{j.orphan && <b> · orphan</b>}{j.error && <span className="hint"><br />{j.error}</span>}</td><td>{j.settledCount}/{j.total} ({j.correct} correct)</td><td>{j.effects.length}</td><td>{j.segments.length}</td><td className="hint">{j.lease ? `${j.lease.owner}${j.leaseLive ? ` · ${Math.max(0, Math.ceil((j.lease.expiresAt - Date.now()) / 1000))} s left` : " · expired"}` : "free"}</td><td>{usd(j.costUsd)}</td>
        <td>{j.status === "running" && !j.drivenHere && <button disabled={!!busy || !facts?.liveAvailable} onClick={() => recover(j.jobId)}>{busy === "recover" ? "…" : "Recover"}</button>}</td></tr>)}
    </tbody></table></div>}

    <h3>F · Apply it to your agent</h3>
    <ol className="steps">
      <li>Keep progress in your own store (a journal, a table), written atomically. The transcript is context for the model, not your source of truth.</li>
      <li>Let tools read that store, so <code>next_item</code> can never return finished work, whatever the model remembers.</li>
      <li>Give every side effect an idempotency key built from stable ids, never from model output, and make the effect store refuse a key it has seen. Pass the key on to payment and email APIs that accept one.</li>
      <li>Run long work as segments with <code>maxTurns</code> and <code>maxBudgetUsd</code>, and <code>resume</code> the session between them. A segment end is a checkpoint, not a failure.</li>
      <li>Journal the <code>session_id</code> from the first message, and mirror the transcript to a <code>sessionStore</code> with <code>sessionStoreFlush: "eager"</code> if the worker's disk can disappear.</li>
      <li>Decide what happens next with a pure, tested policy: resume, retry with backoff, start fresh from the journal, or fail. Cap segments, cost, attempts and no-progress streaks.</li>
      <li>Hold a lease with a heartbeat. Release it on a graceful stop; let it expire on a crash.</li>
    </ol>

    <h3>G · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/sessions" target="_blank" rel="noreferrer">Sessions</a>, <a href="https://code.claude.com/docs/en/agent-sdk/overview" target="_blank" rel="noreferrer">Agent SDK overview</a>. Builds on lessons 6 (sessions), 28 (errors and retries), 35 (session stores) and 40 (resume after an interrupted turn).</p>
  </section>;
}
