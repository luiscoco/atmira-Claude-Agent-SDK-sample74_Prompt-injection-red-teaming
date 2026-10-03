import { useEffect, useRef, useState } from "react";
import type { Report, Scenario } from "../../server/worktrees/workshop";
import { streamPost } from "../lib/sse";

const example = `git worktree add -b worker/greeting ../greeting HEAD
git worktree add -b worker/tax ../tax HEAD
# Start one SDK query({ options: { cwd: ... } }) per checkout.
# Await all worker results, validate each diff, then integrate serially:
git cherry-pick <greeting-commit>
git cherry-pick <tax-commit>
node --test app.test.mjs
# On conflict: inspect it, then git cherry-pick --abort to retain prior picks.
# After successful validation, remove clean worktrees without --force:
git worktree remove ../greeting
git worktree remove ../tax`;

export function Concept57ParallelWorktrees() {
  const [scenario, setScenario] = useState<Scenario>("independent");
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<{ stage: string; detail: string }[]>([]);
  const [results, setResults] = useState<unknown[]>([]);
  const [code, setCode] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/c57/code", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load lesson source.");
      setCode(await response.json());
    }).catch((error) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);
  async function run(mode: "offline" | "live") {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(""); setReport(null); setEvents([]); setResults([]);
    try {
      await streamPost("/api/c57/run", { mode, scenario }, (event, data) => {
        if (controller.signal.aborted) return;
        if (event === "progress") setEvents((items) => [...items, data]);
        if (event === "worker-result") setResults((items) => [...items, data]);
        if (event === "report") setReport(data);
        if (event === "error") setError(data.message);
      }, controller.signal);
    } catch (error) { setError(controller.signal.aborted ? "Cancelled. The coordinator waits for workers to stop and saves report.json in the run folder shown below. Worktrees are retained for inspection." : String(error)); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <section>
    <h2>57. Parallel workers in git worktrees</h2>
    <p className="lead">Give each worker a branch and checkout, validate its changes, then integrate the commits one at a time.</p>
    <div className="offline-boundaries">
      <div className="card"><b>One base commit</b><p>Both assignments start from the same immutable SHA. Uncommitted changes in another checkout are absent.</p></div>
      <div className="card"><b>Two independent workers</b><p>Separate files, HEAD and index. Promise.allSettled waits for both workers before integration.</p></div>
      <div className="card"><b>One coordinator</b><p>Validate ownership and behavior, commit each result, cherry-pick serially and run combined tests.</p></div>
    </div>
    <h3>A · Run the real Git exercise</h3>
    <p>The offline run makes no model calls. It creates a tiny repository under <code>worktrees-lab/run-*</code> and runs actual Git commands and Node assertions. Your course files are outside that repository.</p>
    <label>Worker assignments<select value={scenario} disabled={busy} onChange={(event) => setScenario(event.target.value as Scenario)}>
      <option value="independent">Independent: greeting and tax</option>
      <option value="conflict">Conflict: both edit the same greeting line</option>
    </select></label>
    <p>Independent workers implement <code>greeting() → Hello</code> and <code>tax(100) → 20</code>. In the conflict exercise, the second worker implements <code>Hi</code> in the same line. Both worker checks pass; integration exposes the incompatible decisions.</p>
    <div className="row"><button className="primary" disabled={busy} onClick={() => run("offline")}>Run offline worktree lab</button><button disabled={!busy} onClick={() => pending.current?.abort()}>Cancel run</button></div>
    {error && <p className="card warn" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{busy ? "Workers running…" : report ? `Run ${report.status}. ${report.integrated.length} commits integrated. Cleanup ${report.cleaned ? "complete" : "deferred"}.` : "Ready to run."}</p>
    <ol>{events.map((event, index) => <li key={index}><b>{event.stage}</b> · {event.detail}</li>)}</ol>
    {report && <>
      <p>Evidence saved in <code>{report.run}/report.json</code>. Base: <code>{report.base}</code>.</p>
      {report.error && <p className="card warn" role="alert">{report.error}</p>}
      <div className="eval-table"><table><thead><tr><th>Worker / branch</th><th>Owned file</th><th>Status</th><th>Commit</th></tr></thead><tbody>{report.workers.map((worker) => <tr key={worker.id}><td>{worker.id}<br /><code>{worker.branch}</code></td><td>{worker.file}</td><td>{worker.status}{worker.error && <p>{worker.error}</p>}</td><td><code>{worker.commit ?? "None"}</code></td></tr>)}</tbody></table></div>
      {report.workers.map((worker) => <details className="card" key={worker.id}><summary>{worker.id} · validated diff</summary><pre className="wrap">{worker.diff ?? "No validated diff."}</pre></details>)}
      <details className="card"><summary>Combined tests and remaining worktrees</summary><pre className="wrap">{report.tests}</pre><pre className="wrap">{report.worktrees}</pre></details>
      {report.status === "conflict" && <p className="card warn">The second cherry-pick was aborted. Main retains the first commit; both worker branches and directories remain. Review the two greeting diffs and choose the desired behavior before retrying integration. This run has not passed combined tests.</p>}
    </>}
    <h3>B · Optional live SDK workers</h3>
    <p>Launch two separate Haiku <code>query()</code> sessions with each worktree as <code>cwd</code>. Each session has a separate configuration folder and can edit only its assigned file through the supplied tools. The host runs the same validation and integration gates as the offline exercise.</p>
    <p>Requires <code>ANTHROPIC_API_KEY</code> in .env and makes billed calls. Each worker has a $0.08 SDK budget threshold and four turns; the host deadline is 90 seconds. Budget thresholds are stop conditions. Cancel disconnects the request and aborts both sessions.</p>
    <button disabled={busy} onClick={() => run("live")}>Run live SDK workers (billed)</button>
    {results.length > 0 && <details className="card" open><summary>SDK terminal results and costs</summary><pre className="wrap">{JSON.stringify(results, null, 2)}</pre></details>}
    <h3>C · Integration and cleanup rules</h3>
    <p>Use GitHub to host your project. This exercise runs Git locally and needs no hosting account. For a GitHub project, clone the repository, create worker worktrees from the chosen commit, then push reviewed worker branches and open pull requests on GitHub.</p>
    <pre className="wrap">{example}</pre>
    <p>Worktrees share repository objects, refs and repository configuration. They provide separate checkouts, rather than an operating system sandbox. Use separate ports, databases and environment files when workers run services. A fresh checkout also needs its dependencies installed.</p>
    <p>A worker report alone does not establish success. This coordinator checks file ownership and behavior before committing. Any worker failure prevents integration. A conflict preserves prior cherry-picks and aborts only the failing pick. Failed tests and cancellation retain evidence; successful runs remove only clean worker directories and retain branches and commits.</p>
    <p>In your own project, inspect local changes first, choose a base SHA explicitly and review diffs before integration. Never force-remove a dirty worktree to make cleanup pass. To explore native interactive sessions, start <code>claude --worktree greeting</code> and <code>claude --worktree tax</code> in separate terminals.</p>
    <p>References: <a href="https://git-scm.com/docs/git-worktree" target="_blank" rel="noreferrer">Git worktree documentation</a>, <a href="https://code.claude.com/docs/en/worktrees" target="_blank" rel="noreferrer">Claude Code parallel sessions</a>, and <a href="https://platform.claude.com/docs/en/agent-sdk/typescript" target="_blank" rel="noreferrer">SDK TypeScript reference</a>.</p>
    <h3>D · Read the implementation</h3>
    {Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
  </section>;
}
