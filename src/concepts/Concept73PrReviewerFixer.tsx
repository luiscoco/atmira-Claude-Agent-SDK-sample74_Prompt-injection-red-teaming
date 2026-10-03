import { useEffect, useRef, useState } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type Trigger = { action: string; draft: boolean; fromFork: boolean; headCommitAuthor: string; labels: string[]; botCommits: number };
type Finding = { file: string; line: number; severity: string; category: string; confidence: string; title: string; body: string; suggestion?: string };
type Triaged = Finding & { id: string; placement: "inline" | "summary"; action: "autofix" | "human" | "comment"; why: string; planted?: string };
type Triage = { review: { summary: string; verdict: string; findings: Finding[] }; findings: Triaged[]; dropped: { finding: Finding; why: string }[]; grade: { found: string[]; missed: string[] } };
type Payload = { event: string; body: string; comments: { path: string; line: number; side: string; body: string }[] };
type Check = { name: string; ok: boolean; detail: string; severity: "error" | "warning" };
type Verification = { ok: boolean; checks: Check[]; changed: string[]; diff: string; tests?: { output: string } };
type Commit = { sha: string; message: string };
type FixReport = { fixed: string[]; notFixed: { id: string; reason: string }[]; summary: string };
type Result = { triage?: Triage; payload?: Payload; commands: string[] };
type FixResult = Result & { report: FixReport; verification: Verification; commit?: Commit };
type Round = { round: number; report: FixReport; verification: Verification; commit?: Commit };
type PolicyEvent = { phase: string; tool: string; input: Record<string, unknown>; decision: "allow" | "deny"; reason: string };
type Facts = {
  pr: { number: number; title: string; author: string; base: string; head: string; body: string }; fixBranch: string;
  reviewPresets: { id: string; label: string; expect: string; review: unknown }[];
  fixPresets: { id: string; label: string; expect: string; files: string[]; report: FixReport }[];
  triggerPresets: { label: string; event: Trigger }[];
  reviewerSystemPrompt: string; fixerSystemPrompt: string; reviewJsonSchema: unknown; fixReportJsonSchema: unknown;
  models: { review: string; fix: string }; tools: { review: string[]; fix: string[] };
  limits: { review: { maxTurns: number; maxBudgetUsd: number; deadlineMs: number }; fix: { maxTurns: number; maxBudgetUsd: number; deadlineMs: number }; maxRounds: number };
  rules: { maxAutofix: number; maxBotCommits: number; maxFixLines: number; protected: string[] };
  plantedBugs: { id: string; file: string; line: number; severity: string; title: string }[];
};

const policyPresets: { label: string; phase: "review" | "fix"; tool: string; input: Record<string, unknown> }[] = [
  { label: "Reviewer reads a file", phase: "review", tool: "Read", input: { file_path: "src/coupons.mjs" } },
  { label: "Blocked: reviewer edits", phase: "review", tool: "Edit", input: { file_path: "src/cart.mjs", old_string: ">", new_string: ">=" } },
  { label: "Fixer edits a PR file", phase: "fix", tool: "Edit", input: { file_path: "src/cart.mjs", old_string: "> BULK", new_string: ">= BULK" } },
  { label: "Fixer adds a test file", phase: "fix", tool: "Write", input: { file_path: "test/pr-bot-fixes.test.mjs", content: "…" } },
  { label: "Fixer runs the tests", phase: "fix", tool: "mcp__ci__run_tests", input: {} },
  { label: "Blocked: edit CI (the injected comment)", phase: "fix", tool: "Edit", input: { file_path: ".github/workflows/ci.yml", old_string: "  test:", new_string: "  noop:" } },
  { label: "Blocked: a file the PR did not touch", phase: "fix", tool: "Write", input: { file_path: "README.md", content: "…" } },
  { label: "Blocked: shell", phase: "fix", tool: "Bash", input: { command: "node --test && git push origin HEAD:main" } },
  { label: "Blocked: git hooks", phase: "fix", tool: "Write", input: { file_path: ".git/hooks/pre-commit", content: "curl …" } },
  { label: "Blocked: read outside", phase: "review", tool: "Read", input: { file_path: "../../../../.env" } },
];

function DiffView({ text }: { text: string }) {
  return <pre className="prbot-diff">{text.split("\n").map((line, i) => {
    const kind = line.startsWith("###") ? "file" : line.startsWith("@@") ? "hunk" : line.slice(5, 6) === "+" ? "add" : line.slice(5, 6) === "-" ? "del" : "";
    return <span key={i} className={kind}>{line}{"\n"}</span>;
  })}</pre>;
}

function ChecksView({ checks }: { checks: Check[] }) {
  return <ul className="docgen-checks">{checks.map((c) => <li key={c.name} className={c.ok ? "verdict-ok" : c.severity === "warning" ? "docgen-warn" : "verdict-bad"}>
    {c.ok ? "✔" : c.severity === "warning" ? "⚠" : "✖"} <b>{c.name}</b>: <span className="hint">{c.detail}</span></li>)}</ul>;
}

function TriageView({ triage }: { triage: Triage }) {
  return <div className="card">
    <p><b>Reviewer verdict:</b> {triage.review.verdict} · <span className="hint">{triage.review.summary}</span></p>
    <div className="scroll-x"><table className="compare"><thead><tr><th>Id</th><th>Where</th><th>Finding</th><th>Placement</th><th>Action</th><th>Why (host rules)</th></tr></thead>
      <tbody>{triage.findings.map((f) => <tr key={f.id}>
        <td>{f.id}{f.planted && <div className="hint">= {f.planted}</div>}</td>
        <td><code>{f.file}:{f.line}</code></td>
        <td><b>{f.title}</b><div className="hint">{f.severity} · {f.category} · confidence {f.confidence}</div></td>
        <td>{f.placement}</td>
        <td><span className={`prbot-action ${f.action}`}>{f.action === "autofix" ? "bot fixes" : f.action === "human" ? "a person" : "comment"}</span></td>
        <td className="hint">{f.why}</td></tr>)}</tbody></table></div>
    {triage.dropped.length > 0 && <p className="hint">Dropped: {triage.dropped.map((d) => `${d.finding.title} (${d.why})`).join("; ")}</p>}
    <p className={triage.grade.missed.length ? "verdict-bad" : "verdict-ok"}>Lab grade (the answer key, which a real bot does not have): found {triage.grade.found.join(", ") || "none"} · missed {triage.grade.missed.join(", ") || "none"}</p>
  </div>;
}

function PayloadView({ payload, commands }: { payload: Payload; commands: string[] }) {
  return <div className="card">
    <p><b>GitHub review that would be posted:</b> <span className={`prbot-event ${payload.event}`}>{payload.event}</span> <span className="hint">· {payload.comments.length} inline comment(s), each on a line inside the diff (side RIGHT)</span></p>
    <details><summary>Review body (Markdown)</summary><pre className="wrap">{payload.body}</pre></details>
    <details><summary>Inline comments</summary>{payload.comments.map((c, i) => <div key={i}><p><code>{c.path}:{c.line}</code></p><pre className="wrap">{c.body}</pre></div>)}</details>
    <details><summary>review.json (POST /repos/…/pulls/{"{n}"}/reviews)</summary><pre className="wrap">{JSON.stringify(payload, null, 2)}</pre></details>
    <p className="hint">Publishing (not run by the lab):</p><pre className="wrap">{commands.map((c) => `$ ${c}`).join("\n")}</pre>
  </div>;
}

function VerificationView({ title, report, verification, commit, patchUrl }: { title: string; report?: FixReport; verification: Verification; commit?: Commit; patchUrl?: string }) {
  return <div className="card">
    <p className={verification.ok ? "verdict-ok" : "verdict-bad"}><b>{title}: {verification.ok ? "accepted, committed by the host as pr-bot" : "rejected, nothing committed"}</b></p>
    {report && <p className="hint">The fixer's claim: fixed {report.fixed.join(", ") || "nothing"}{report.notFixed.length ? `; not fixed ${report.notFixed.map((n) => `${n.id} (${n.reason})`).join(", ")}` : ""}. "{report.summary}"</p>}
    <ChecksView checks={verification.checks} />
    <details><summary>Diff the host verified ({verification.changed.length} file(s))</summary><pre className="wrap">{verification.diff || "(empty)"}</pre></details>
    {verification.tests && <details><summary>Host test run (TAP)</summary><pre className="wrap">{verification.tests.output}</pre></details>}
    {commit && <><details open><summary>Commit {commit.sha.slice(0, 7)}</summary><pre className="wrap">{commit.message}</pre></details>
      {patchUrl && <p><a href={patchUrl} download>Download the .patch</a> <span className="hint">(git am applies it on the PR branch)</span></p>}</>}
  </div>;
}

export function Concept73PrReviewerFixer() {
  const [facts, setFacts] = useState<Facts>();
  const [id, setId] = useState(""); const [diff, setDiff] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [gateLabel, setGateLabel] = useState(""); const [gateResult, setGateResult] = useState<{ run: string; reasons: string[] }>();
  const [reviewPreset, setReviewPreset] = useState("good"); const [reviewText, setReviewText] = useState("");
  const [reviewResult, setReviewResult] = useState<Result & { message?: string; ok?: boolean }>();
  const [fixPreset, setFixPreset] = useState("good"); const [fixResult, setFixResult] = useState<FixResult>();
  const [policy, setPolicy] = useState(policyPresets[0]); const [policyInput, setPolicyInput] = useState(JSON.stringify(policyPresets[0].input, null, 1));
  const [policyResult, setPolicyResult] = useState<{ decision: string; reason: string }>();
  const [liveEvent, setLiveEvent] = useState(0);
  const [messages, setMessages] = useState<any[]>([]); const [policyLog, setPolicyLog] = useState<PolicyEvent[]>([]);
  const [stages, setStages] = useState<string[]>([]); const [rounds, setRounds] = useState<Round[]>([]);
  const [results, setResults] = useState<{ phase: string; subtype: string; costUsd: number; turns: number }[]>([]);
  const [final, setFinal] = useState<Result>();
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    request_("/api/c73/facts").then((data: Facts) => { setFacts(data); setReviewText(JSON.stringify(data.reviewPresets[0].review, null, 2)); }).catch((e) => setError(String(e)));
  }, []);

  async function request_(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`); return data;
  }
  async function guarded(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const resetLive = () => { setMessages([]); setPolicyLog([]); setStages([]); setRounds([]); setResults([]); setFinal(undefined); };
  const start = () => guarded(async () => {
    const data = await request_("/api/c73/sessions", {});
    setId(data.id); setDiff(data.numbered); setReviewResult(undefined); setFixResult(undefined); setPolicyResult(undefined); resetLive();
  });
  const checkGate = (label: string, event: Trigger) => guarded(async () => { setGateLabel(label); setGateResult(await request_("/api/c73/gate", { event })); });
  const runReview = () => guarded(async () => {
    let review: unknown;
    try { review = JSON.parse(reviewText); } catch { throw new Error("The review is not valid JSON."); }
    setFixResult(undefined);
    setReviewResult(await request_(`/api/c73/sessions/${id}/review`, { review }));
  });
  const runFix = () => guarded(async () => { setFixResult(await request_(`/api/c73/sessions/${id}/fix`, { preset: fixPreset })); });
  const checkPolicy = () => guarded(async () => {
    let input: Record<string, unknown>;
    try { input = JSON.parse(policyInput); } catch { throw new Error("Tool input is not valid JSON."); }
    setPolicyResult(await request_(`/api/c73/sessions/${id}/policy`, { phase: policy.phase, tool: policy.tool, input }));
  });
  async function runLive(stagesToRun: "review" | "fix" | "all") {
    setBusy(true); setError(""); resetLive();
    const abort = new AbortController(); controller.current = abort;
    const note = (line: string) => setStages((all) => [...all, line]);
    try {
      await streamPost(`/api/c73/sessions/${id}/run`, { stages: stagesToRun, ...(stagesToRun === "all" ? { event: facts!.triggerPresets[liveEvent].event } : {}) }, (event, data) => {
        if (event === "message") setMessages((all) => [...all, data]);
        if (event === "policy") setPolicyLog((all) => [...all, data]);
        if (event === "gate") note(`gate → ${data.run}: ${data.reasons.join(" ")}`);
        if (event === "stage") note(`${data.stage}: ${data.detail}`);
        if (event === "tests") note(`run_tests (host): ${data.pass}/${data.tests} passed, ${data.fail} failed, ${data.skipped} skipped`);
        if (event === "result") setResults((all) => [...all, data]);
        if (event === "review") setReviewResult({ ok: true, ...data });
        if (event === "verification") setRounds((all) => [...all, data]);
        if (event === "final") setFinal(data);
        if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { setError(abort.signal.aborted ? "Run stopped. Nothing is committed after Stop." : String(e)); }
    finally { setBusy(false); }
  }

  const currentReview = facts?.reviewPresets.find((p) => p.id === reviewPreset);
  const currentFix = facts?.fixPresets.find((p) => p.id === fixPreset);
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return <>
    <h2>73. An autonomous PR reviewer and fixer</h2>
    <p>A bot that reviews every pull request and fixes what it finds, with nobody approving each step. The models do the reading and the editing. The <em>host</em> owns every decision that matters: whether the bot runs, which findings it may fix, which files it may touch, whether the fix is really a fix, and what gets published. The bot never approves and never pushes to the contributor's branch.</p>
    <ol className="prbot-pipeline">
      <li><b>Gate</b><span>Host: loop guard, forks, drafts, a fix budget</span></li>
      <li><b>Review</b><span>Agent: read-only, schema without "approve"</span></li>
      <li><b>Triage</b><span>Host: anchor to the diff, choose who acts</span></li>
      <li><b>Fix</b><span>Agent: own worktree, PR files + tests, no shell</span></li>
      <li><b>Verify</b><span>Host: scope, test integrity, tests, ≤{facts?.limits.maxRounds ?? 2} rounds</span></li>
      <li><b>Publish</b><span>Host: bot commit, fix PR, review (never APPROVE)</span></li>
    </ol>
    {error && <p className="card warn" role="alert">{error}</p>}

    <h3>A · The pull request</h3>
    {facts && <div className="card">
      <p><b>#{facts.pr.number} {facts.pr.title}</b> <span className="hint">by @{facts.pr.author} · {facts.pr.head} → {facts.pr.base}</span></p>
      <pre className="wrap">{facts.pr.body}</pre>
      <p className="hint">CI is green on this PR. Read the diff before the bot does: there are two real bugs, and one comment written for AI reviewers.</p>
    </div>}
    <button disabled={busy} onClick={start}>{id ? "Start a fresh repository" : "Start lab (offline): create the repository"}</button>
    {id && <details className="card" open><summary>Numbered diff (what the reviewer receives; new-side line numbers on the left)</summary><DiffView text={diff} /></details>}

    <h3>B · The trigger gate</h3>
    <p>An autonomous bot runs on webhook events, including the push of its <em>own</em> fix. Without a gate it reviews its fix, fixes its review, and loops. The gate is plain code that runs before any model.</p>
    <div className="card">
      <div className="row">{facts?.triggerPresets.map((p) => <button key={p.label} className={p.label === gateLabel ? "active" : undefined} disabled={busy} onClick={() => checkGate(p.label, p.event)}>{p.label}</button>)}</div>
      {gateResult && <p className={gateResult.run === "skip" ? "verdict-bad" : "verdict-ok"}><b>{gateResult.run}</b>: {gateResult.reasons.join(" ")}</p>}
    </div>

    <h3>C · Review and triage (offline)</h3>
    <p>The reviewer returns JSON that must match a schema (the SDK's <code>outputFormat</code>). Its <code>verdict</code> is <code>comment</code> or <code>request_changes</code>: no value means "approve". The host then triages each finding. A comment must sit on a line inside the diff (GitHub answers 422 otherwise). Duplicates are dropped. Only confident, medium-or-worse correctness, security or test findings on changed lines go to the fixer, at most {facts?.rules.maxAutofix ?? 3} per run. CI and package files are for a person.</p>
    <div className="card">
      <div className="row">{facts?.reviewPresets.map((p) => <button key={p.id} className={p.id === reviewPreset ? "active" : undefined} disabled={busy || !id} onClick={() => { setReviewPreset(p.id); setReviewText(JSON.stringify(p.review, null, 2)); setReviewResult(undefined); }}>{p.label}</button>)}</div>
      {currentReview && <p className="hint">Expected: {currentReview.expect}</p>}
      <label>Reviewer output (JSON) <textarea value={reviewText} rows={10} onChange={(e) => setReviewText(e.target.value)} /></label>
      <button disabled={busy || !id} onClick={runReview}>Validate and triage</button>
    </div>
    {reviewResult?.ok === false && <pre className="card warn wrap">{reviewResult.message}</pre>}
    {reviewResult?.triage && <TriageView triage={reviewResult.triage} />}
    {reviewResult?.payload && !fixResult && <PayloadView payload={reviewResult.payload} commands={reviewResult.commands} />}

    <h3>D · Fix and verify (offline)</h3>
    <p>Each preset is a recorded fixer result, written into <code>fix/</code> (branch <code>{facts?.fixBranch}</code>) as if the agent had made the change. The host then verifies the working tree, whatever the fixer claims. It checks the scope, the size (≤{facts?.rules.maxFixLines ?? 150} lines) and that no test was removed, weakened or skipped. It runs the tests itself, with a clean environment. In this lab it also runs hidden probes for the planted bugs, like an eval. Only an accepted fix is committed, as pr-bot.</p>
    <div className="card">
      <div className="row">{facts?.fixPresets.map((p) => <button key={p.id} className={p.id === fixPreset ? "active" : undefined} disabled={busy || !id} onClick={() => { setFixPreset(p.id); setFixResult(undefined); }}>{p.label}</button>)}</div>
      {currentFix && <p className="hint">Expected: {currentFix.expect} Files: {currentFix.files.join(", ")}.</p>}
      <button disabled={busy || !id || !reviewResult?.triage} onClick={runFix}>Apply and verify</button>
      {!reviewResult?.triage && id && <span className="hint"> Load a review in C first (the good review selects F1 and F2).</span>}
    </div>
    {fixResult && <VerificationView title={currentFix?.label ?? "Fix"} report={fixResult.report} verification={fixResult.verification} commit={fixResult.commit} patchUrl={fixResult.commit ? `/api/c73/sessions/${id}/patch` : undefined} />}
    {fixResult?.payload && <PayloadView payload={fixResult.payload} commands={fixResult.commands} />}

    <h3>E · Run the bot (live, billed)</h3>
    <p>Reviewer: {facts?.models.review}, tools {facts?.tools.review.join(", ")}, {facts?.limits.review.maxTurns} turns, ${facts?.limits.review.maxBudgetUsd}. Fixer: {facts?.models.fix}, tools {facts?.tools.fix.join(", ")}, {facts?.limits.fix.maxTurns} turns and ${facts?.limits.fix.maxBudgetUsd} per round, at most {facts?.limits.maxRounds} rounds. Both use <code>permissionMode: "dontAsk"</code> behind a <code>PreToolUse</code> policy, with <code>settingSources: []</code> and a private config dir. If a round is rejected, the fixer gets the failed checks (never the lab probes) and one more try. After that, the bot gives up and leaves the findings to a person.</p>
    <div className="card">
      <div className="row">
        <button disabled={busy || !id} onClick={() => runLive("review")}>Review only (live)</button>
        <button disabled={busy || !id || !reviewResult?.triage?.findings.some((f) => f.action === "autofix")} onClick={() => runLive("fix")}>Fix the current review (live)</button>
      </div>
      <label>Autopilot webhook event <select value={liveEvent} disabled={busy} onChange={(e) => setLiveEvent(Number(e.target.value))}>{facts?.triggerPresets.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}</select></label>
      <button disabled={busy || !id} onClick={() => runLive("all")}>Autopilot: gate → review → fix (live)</button>{" "}
      <button disabled={!busy || !controller.current || controller.current.signal.aborted} onClick={() => controller.current?.abort()}>Stop</button>
    </div>
    {stages.length > 0 && <div className="card"><b>Pipeline</b><ol>{stages.map((s, i) => <li key={i}>{s}</li>)}</ol></div>}
    {policyLog.length > 0 && <div className="card"><b>Tool calls through the policy</b><ol>{policyLog.map((p, i) => <li key={i} className={p.decision === "allow" ? undefined : "verdict-bad"}>
      <span className="hint">[{p.phase}]</span> <code>{p.tool}</code> <span className="hint">{String(p.input.file_path ?? p.input.pattern ?? p.input.command ?? "").slice(0, 140)}</span> · {p.decision}
      {p.decision === "deny" && <div className="hint">Reason sent to the model: {p.reason}</div>}</li>)}</ol></div>}
    {results.length > 0 && <p className="hint">{results.map((r) => `${r.phase}: ${r.subtype}, ${r.turns} turns, $${(r.costUsd ?? 0).toFixed(4)}`).join(" · ")} · total ${cost.toFixed(4)}</p>}
    {rounds.map((r) => <VerificationView key={r.round} title={`Round ${r.round}`} report={r.report} verification={r.verification} commit={r.commit} patchUrl={r.commit ? `/api/c73/sessions/${id}/patch` : undefined} />)}
    {final?.payload && <PayloadView payload={final.payload} commands={final.commands} />}
    <MessageLog messages={messages} />

    <h3>F · The tool policy</h3>
    <p>The same <code>decide()</code> the <code>PreToolUse</code> hook calls. The reviewer can only read. The fixer can edit the PR's own source files and <code>test/*.test.mjs</code>, and run tests through the host's <code>run_tests</code> tool. It has no shell, no git and no network. The PR's code is untrusted, so it runs only in a process without the bot's API key.</p>
    <div className="card">
      <div className="row">{policyPresets.map((p) => <button key={p.label} disabled={busy || !id} onClick={() => { setPolicy(p); setPolicyInput(JSON.stringify(p.input, null, 1)); setPolicyResult(undefined); }}>{p.label}</button>)}</div>
      <p className="hint">Phase <b>{policy.phase}</b> · tool <code>{policy.tool}</code></p>
      <label>Input (JSON) <textarea value={policyInput} rows={3} onChange={(e) => setPolicyInput(e.target.value)} /></label>
      <button disabled={busy || !id} onClick={checkPolicy}>Check policy</button>
      {policyResult && <p className={policyResult.decision === "allow" ? "verdict-ok" : "verdict-bad"}><b>{policyResult.decision === "allow" ? "✔ allow" : "✖ deny"}</b>: {policyResult.reason}</p>}
    </div>

    <h3>G · Prompts, schemas, answer key and code</h3>
    {facts && <>
      <details className="card"><summary>Reviewer system prompt</summary><pre className="wrap">{facts.reviewerSystemPrompt}</pre></details>
      <details className="card"><summary>Fixer system prompt</summary><pre className="wrap">{facts.fixerSystemPrompt}</pre></details>
      <details className="card"><summary>Review schema (outputFormat)</summary><pre className="wrap">{JSON.stringify(facts.reviewJsonSchema, null, 2)}</pre></details>
      <details className="card"><summary>Fix report schema (outputFormat)</summary><pre className="wrap">{JSON.stringify(facts.fixReportJsonSchema, null, 2)}</pre></details>
      <details className="card"><summary>Answer key: the planted bugs (lab only)</summary><ul>{facts.plantedBugs.map((b) => <li key={b.id}><b>{b.id}</b> <code>{b.file}:{b.line}</code> {b.severity}: {b.title}</li>)}</ul>
        <p className="hint">The probes that check them run on the server and are never shown to the fixer.</p></details>
    </>}
    <button onClick={async () => { try { setCode(await request_("/api/c73/code")); } catch (e) { setError(String(e)); } }}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
    <p>Production notes: run the bot on <code>pull_request</code>, not <code>pull_request_target</code>, so fork code never runs with write tokens. Give it a dedicated bot identity whose commits the gate recognises. Protect the base branch so the bot cannot merge. Keep a per-PR fix budget. Green tests are not proof of a fix (see "Green, but B1 not fixed"): a person merges the fix PR.</p>
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/structured-outputs">Structured outputs</a> · <a href="https://code.claude.com/docs/en/agent-sdk/hooks">Hooks</a> · <a href="https://code.claude.com/docs/en/agent-sdk/custom-tools">Custom tools</a> · <a href="https://docs.github.com/en/rest/pulls/reviews">GitHub pull request reviews API</a>.</p>
  </>;
}
