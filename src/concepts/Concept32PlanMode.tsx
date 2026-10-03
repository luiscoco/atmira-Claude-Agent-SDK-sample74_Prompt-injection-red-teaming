import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Open = { run: string; id: string; plan: string; planFilePath: string; timeoutMs: number; receivedAt: number };

// Part A: the approval loop. Each one is a scenario for POST /run.
const partA: { id: string; label: string; hint: string }[] = [
  {
    id: "review",
    label: "1 · Plan, then you decide",
    hint: "permissionMode: 'plan'. The model reads cart.js and README.md, writes a plan file, and calls ExitPlanMode. Claude Code sends it to canUseTool, which WAITS for your decision in the card below. Try each button: auto-accept edits, review each edit (the mode becomes 'default' and every Edit comes to canUseTool), edit the plan first, keep planning with feedback, or cancel. About $0.04.",
  },
  {
    id: "instructions",
    label: "2 · Your own plan format",
    hint: "planModeInstructions replaces the default workflow part of the plan-mode reminder: here, 'Goal, at most 4 numbered steps, Risk'. The CLI keeps the read-only preamble and the ExitPlanMode footer around it. Compare the plan with scenario 1. About $0.03.",
  },
  {
    id: "enter",
    label: "3 · The model enters plan mode",
    hint: "permissionMode: 'default', with EnterPlanMode in the tools. The prompt asks the model to plan first: it calls EnterPlanMode (canUseTool is NOT asked), system/status says 'plan', and from there it is the same loop. About $0.04.",
  },
];

// Part B: the host's side.
const partB: { id: string; label: string; hint: string }[] = [
  {
    id: "policy",
    label: "4 · A policy hook reviews first",
    hint: "A PreToolUse hook (matcher: ExitPlanMode) checks the plan before you see it: it must add cart.test.js. The task does not mention tests, so the first plan is refused with the hook's reason; the model revises it and asks again. A hook's 'allow' would NOT skip your review: canUseTool is still asked. About $0.05.",
  },
];

// Part D: what you decide, and what the model gets.
const table: [string, string, string][] = [
  ["Approve, auto-accept edits", "allow, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]", "“User has approved your plan. You can now start coding…” + “## Approved Plan:”. system/status → acceptEdits; edits inside cwd no longer reach canUseTool"],
  ["Approve, review each edit", "allow (no updatedPermissions)", "The same text. The mode becomes 'default' (not acceptEdits): every Edit/Write comes to canUseTool, with a setMode suggestion"],
  ["Approve an edited plan", "allow, updatedInput: { ...input, plan: '<yours>' }", "“## Approved Plan (edited by user):” + your plan; tool_use_result.planWasEdited: true; the plan file is overwritten. The model follows YOUR version"],
  ["Keep planning", "deny, message: '<feedback>'", "is_error with your message. The mode stays 'plan'; the model edits its plan file and calls ExitPlanMode again"],
  ["Cancel", "deny, message, interrupt: true", "“STOP what you are doing…”; result error_during_execution; query() throws"],
  ["Nobody decides", "(no limit: canUseTool can wait for ever)", "The lab's own 3-minute timeout sends deny + interrupt: an unreviewed plan is never implemented"],
  ["A PreToolUse hook: deny", "permissionDecision: 'deny', permissionDecisionReason", "“PreToolUse:ExitPlanMode hook error: <reason>”; canUseTool is not asked; the model revises"],
  ["A PreToolUse hook: allow", "permissionDecision: 'allow'", "canUseTool is STILL asked for ExitPlanMode: a hook cannot approve a plan for the user"],
  ["No canUseTool", "—", "ExitPlanMode and EnterPlanMode are not in the tool list: the model writes the plan and stops, still in plan mode"],
  ["A write in plan mode", "no canUseTool: the CLI denies it · with canUseTool: YOUR function decides", "“Cannot write to … while in plan mode” + system/permission_denied (mode) · or, if you allow it, the file is written"],
];

// ---------------------------------------------------------------------------------------------

/** The host's approval dialog: what Claude Code shows in the terminal, rendered by your own UI. */
function PlanCard({ open }: { open: Open }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(open.plan);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((open.receivedAt + open.timeoutMs - now) / 1000));
  const edited = plan.trim() !== open.plan.trim();

  async function send(action: "approve" | "revise" | "cancel", mode?: "acceptEdits" | "default") {
    setSending(true);
    setError(null);
    const body: any = { run: open.run, id: open.id, action };
    if (action === "approve") body.mode = mode;
    if (action === "approve" && edited) body.plan = plan.trim();
    if (action === "revise") body.feedback = feedback.trim();
    try {
      const r = await fetch("/api/c32/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return setError(j.error ?? `HTTP ${r.status}`);
      // The card closes when the "decision" event comes back on the run's stream.
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card permission plan-card">
      <b>Claude has a plan</b> <span className="subtype">canUseTool(“ExitPlanMode”) is waiting · plan #{open.id} · the host gives up in {left} s</span>
      <div className="subtype">plan file: {open.planFilePath || "(none)"}</div>
      {editing ? (
        <textarea className="plan-edit" rows={14} maxLength={20000} value={plan} onChange={(e) => setPlan(e.target.value)} />
      ) : (
        <pre className="plan-text">{plan}</pre>
      )}
      <div className="row">
        <button onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit the plan"}</button>
        {edited && (
          <>
            <span className="subtype">edited: approving sends your version in updatedInput.plan</span>
            <button onClick={() => setPlan(open.plan)}>Undo my edits</button>
          </>
        )}
      </div>
      <div className="row">
        <button className="primary" disabled={sending} onClick={() => send("approve", "acceptEdits")} title="allow + updatedPermissions: setMode acceptEdits">
          Approve · auto-accept edits
        </button>
        <button disabled={sending} onClick={() => send("approve", "default")} title="allow, no updatedPermissions: the mode becomes 'default'">
          Approve · I review each edit
        </button>
      </div>
      <div className="row">
        <input className="plan-feedback" placeholder="what should change in the plan? → deny message" maxLength={2000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <button disabled={sending || !feedback.trim()} onClick={() => send("revise")} title="deny with your feedback: the model stays in plan mode and revises">
          Keep planning
        </button>
        <button disabled={sending} onClick={() => send("cancel")} title="deny with interrupt: true: the run stops">
          Cancel the job
        </button>
      </div>
      {error && <div className="snippet bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "init":
            return (
              <div key={i} className={`tool-call ${data.hasExit ? "" : "denied"}`}>
                <span className="tag tag-system">system/init</span> <code>{data.model}</code> <span className={`tag mode-${data.permissionMode}`}>{data.permissionMode}</span>{" "}
                <span className="subtype">tools: {data.tools.join(", ")}</span> {t}
                {!data.hasExit && <div className="snippet">ExitPlanMode is not in the list: the agent cannot ask to leave plan mode.</div>}
              </div>
            );
          case "mode":
            return (
              <div key={i} className="tool-call mode-change">
                <span className="tag tag-plan">host: mode</span> <span className={`tag mode-${data.mode}`}>{data.mode}</span> <span className="subtype">{data.why}</span> {t}
              </div>
            );
          case "status":
            return (
              <div key={i} className="tool-call mode-change">
                <span className="tag tag-system">system/status</span> <code>permissionMode: {data.permissionMode}</code> {t}
              </div>
            );
          case "apiError":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">API error</span> <code className="bad">{data.error}</code> {t}
                <div className="snippet">
                  {data.text} — a synthetic assistant message written by Claude Code: the model never ran.
                  {data.error === "billing_error" && " Add credit to the account of ANTHROPIC_API_KEY (or use another key) and restart the server."}
                </div>
              </div>
            );
          case "assistant":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-assistant">assistant</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className={`tool-call ${data.name.endsWith("PlanMode") || data.planFile ? "plan" : ""}`}>
                <span className={`tag ${data.name.endsWith("PlanMode") ? "tag-plan" : "tag-pre"}`}>tool_use {data.name}</span> {data.planFile && <code>the plan file</code>} {t}
                <div className="snippet">{data.input}</div>
              </div>
            );
          case "plan":
            return (
              <div key={i} className="tool-call plan">
                <span className="tag tag-call">canUseTool</span> <code>ExitPlanMode</code> <span className="subtype">plan #{data.id} · waiting for your decision…</span> {t}
                <div className="snippet">{data.plan.split("\n").find((l: string) => l.trim()) ?? ""} … ({data.plan.length} characters)</div>
              </div>
            );
          case "policy":
            return (
              <div key={i} className={`tool-call call ${data.ok ? "" : "denied"}`}>
                <span className="tag tag-pre">PreToolUse hook</span> <code>ExitPlanMode</code> <span className="subtype">{data.rule}</span> {t}
                <div className="snippet">{data.ok ? "passes: return {} → canUseTool decides" : "fails: permissionDecision 'deny' → canUseTool is not asked"}</div>
              </div>
            );
          case "decision":
            return (
              <div key={i} className={`tool-call call ${data.result.behavior === "deny" ? "denied" : ""}`}>
                <span className="tag tag-call">host → PermissionResult</span> <code>{data.how}</code> {t}
                <pre className="wrap tur">{JSON.stringify(data.result)}</pre>
              </div>
            );
          case "blocked":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">canUseTool denied</span> <code>{data.tool}</code> <span className="subtype">{data.target}</span> {t}
                <div className="snippet">{data.why === "plan mode" ? "The mode is still 'plan': the host denies anything that reaches it." : "Outside the run folder."}</div>
              </div>
            );
          case "asked":
            return (
              <div key={i} className="tool-call call">
                <span className="tag tag-call">canUseTool</span> <code>{data.tool}</code> <span className="subtype">{data.target} · mode {data.mode}: asked, allowed inside the folder</span> {t}
              </div>
            );
          case "cliDenied":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">system/permission_denied</span> <code>{data.tool}</code> <span className="subtype">reason: {data.reason}</span> {t}
                <div className="snippet">{data.message}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""} ${data.name.endsWith("PlanMode") ? "plan" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> <code>{data.name}</code> {data.is_error && <code className="bad">is_error</code>} {t}
                <div className="snippet">{data.text || "(empty)"}</div>
                {data.tool_use_result && <pre className="wrap tur">tool_use_result: {JSON.stringify(data.tool_use_result)}</pre>}
              </div>
            );
          case "result":
            return (
              <div key={i} className={`tool-call ${data.is_error || data.apiError ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                {data.apiError && <code className="bad"> but the API failed: {data.apiError}</code>}
                <span className="subtype">
                  num_turns {data.num_turns} · ${data.cost?.toFixed(4)}
                  {data.denials.length > 0 && ` · permission_denials: ${data.denials.join(", ")}`}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "check":
            return <Check key={i} data={data} />;
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

function Check({ data }: { data: any }) {
  const outside = data.changes.filter((c: any) => data.approved && !c.inPlan);
  return (
    <div className="tool-call verdict">
      <span className="tag tag-verdict">host check</span>{" "}
      <span className="subtype">
        modes: {data.modes.map((m: any) => m.mode).join(" → ")} · {data.plans} plan{data.plans === 1 ? "" : "s"} · decisions: {data.decisions.map((d: any) => d.how + (d.mode ? ` (${d.mode})` : "") + (d.edited ? " edited" : "")).join(", ") || "none"}
      </span>
      {data.apiError && <div className="snippet bad">The API refused the call ({data.apiError}): the model never ran, so this run shows nothing about plan mode.</div>}
      {!data.apiError && data.plans === 0 && (
        <div className="snippet bad">
          The model never called ExitPlanMode: it never asked for approval, so the run ended in mode '{data.finalMode}'. {data.planFile && `Its plan is only in ${data.planFile}.`}
        </div>
      )}
      {!data.apiError && data.plans > 0 && !data.approved && <div className="snippet">No plan was approved: {data.changes.length === 0 ? "the project is unchanged, as it should be." : "yet the project changed!"}</div>}
      {data.blocked.length > 0 && <div className="snippet">The host denied {data.blocked.length} call(s) while the mode was 'plan': {data.blocked.map((b: any) => `${b.tool} ${b.target}`).join(", ")}</div>}
      {data.changes.map((c: any) => (
        <div key={c.file} className={`snippet ${(data.approved && !c.inPlan) || !data.approved ? "bad" : ""}`}>
          {c.file}: {c.change}
          {data.approved ? (c.inPlan ? " · named in the approved plan" : " · NOT named in the approved plan") : " · without an approved plan"}
        </div>
      ))}
      {data.approved && data.changes.length === 0 && <div className="snippet bad">A plan was approved, but no file changed.</div>}
      {outside.length === 0 && data.approved && data.changes.length > 0 && <div className="snippet">Every changed file is named in the plan you approved.</div>}
    </div>
  );
}

function WhoTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>options</th>
          <th>ExitPlanMode listed</th>
          <th>canUseTool asked</th>
          <th>hello.txt</th>
          <th>the model's tool_result</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>
              <code>{r.shown}</code>
            </td>
            <td>{r.hasExit === undefined ? "" : <code className={r.hasExit ? "" : "bad"}>{r.hasExit ? "yes" : "no"}</code>}</td>
            <td>{r.asked ? "yes" : "no"}</td>
            <td>
              {r.error ? (
                <code className="bad">{String(r.error).replace("Claude Code returned an error result: ", "API error: ")}</code>
              ) : !r.triedWrite ? (
                <code>the model did not try</code>
              ) : (
                <code className={r.written ? "bad" : ""}>{r.written ? "WRITTEN in plan mode" : r.cliDenied ? `denied by the CLI (${r.cliDenied})` : "denied by the host"}</code>
              )}
            </td>
            <td className="hint">
              {r.result}
              {r.maxTurns && " (the model kept retrying until maxTurns: 3)"}
              {r.stoppedAtPlan && " (then it called ExitPlanMode; this check refuses plans with interrupt: true)"}
            </td>
            <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept32PlanMode() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [options, setOptions] = useState<{ prompt: string; options: any } | null>(null);
  const [whoRows, setWhoRows] = useState<any[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Rename total() to cartTotal() everywhere, and add a function itemCount(items) that returns the number of units in the cart. When the plan is ready, submit it for my approval with the ExitPlanMode tool.");
  const [instructions, setInstructions] = useState("");
  const [plansInProject, setPlansInProject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c32/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c32 — is this sample's server running on port 3001?"));
  }, []);

  async function run(label: string, body: any, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    setOpen(null);
    setMode(null);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c32/run", body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data), setMode(data.options.permissionMode);
        if (event === "mode") setMode(data.mode);
        if (event === "plan") setOpen({ ...data, receivedAt: Date.now() });
        if (event === "decision") setOpen((o) => (o && o.id === data.id ? null : o));
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
      setOpen(null);
    }
  }

  async function who() {
    setRunning("who");
    setError(null);
    const rows: any[] = [];
    setWhoRows([]);
    try {
      await streamPost("/api/c32/who", {}, (event, data) => {
        if (event === "whoRow") setWhoRows((rows.push(data), [...rows]));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = events.filter((e) => e.event === "result").reduce((s, e) => s + (e.data.cost ?? 0), 0);
  const plans = events.filter((e) => e.event === "plan").length;
  const button = (s: { id: string; label: string; hint: string }) => (
    <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, { scenario: s.id }, s.hint)}>
      {s.label}
    </button>
  );

  return (
    <section>
      <h2>32 · Plan mode</h2>
      <p className="lead">
        With <code>permissionMode: 'plan'</code> the agent first <b>looks</b> (Read, Glob, Grep), writes a <b>plan</b>, and asks to leave plan mode with the
        built-in <code>ExitPlanMode</code> tool. Claude Code does not show that plan: it reaches <b>your</b> <code>canUseTool</code>, which is the approval
        dialog. Approve (and pick the next mode), edit the plan, send it back with feedback, or cancel. This tab is that host, and it also shows who really
        keeps plan mode read-only.
      </p>

      <h3>A · The agent plans, you decide</h3>
      <div className="row">
        <button disabled={!!running} className={running === "who" ? "active" : ""} onClick={who}>
          {running === "who" ? "Checking…" : "0 · Who keeps plan mode read-only?"}
        </button>
        <span className="subtype">the same forced Write in 3 setups, in parallel · about $0.04</span>
      </div>
      {whoRows.length > 0 && <WhoTable rows={whoRows} />}
      <div className="scenarios">{partA.map(button)}</div>

      <h3>B · The host reviews too</h3>
      <p className="hint">
        A person is not the only reviewer. A <code>PreToolUse</code> hook sees <code>ExitPlanMode</code> first and can refuse a plan that breaks a rule, but it
        cannot approve one for the user.
      </p>
      <div className="scenarios">{partB.map(button)}</div>

      <div className="card config">
        <label>your own job (the agent works on a fresh copy of cart.js and README.md; it has Read, Glob, Grep, Write, Edit and ExitPlanMode)</label>
        <textarea rows={3} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%" }} />
        <label>planModeInstructions (optional: replaces the default planning workflow)</label>
        <textarea rows={2} maxLength={2000} value={instructions} placeholder="e.g. List the files you will touch first, then the steps." onChange={(e) => setInstructions(e.target.value)} style={{ width: "100%" }} />
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={plansInProject} onChange={(e) => setPlansInProject(e.target.checked)} /> <span>settings: {"{ plansDirectory: 'plans' }"} (the plan file goes into the project, not CLAUDE_CONFIG_DIR/plans)</span>
          </label>
          <button
            className="primary"
            disabled={!!running || !prompt.trim()}
            onClick={() => run("custom", { scenario: "custom", prompt, ...(instructions.trim() && { planModeInstructions: instructions }), ...(plansInProject && { plansInProject: true }) }, null)}
          >
            {running === "custom" ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {open && <PlanCard key={`${open.run}:${open.id}`} open={open} />}
      {(events.length > 0 || running) && running !== "who" && (
        <div className="card">
          <b>Events</b> {mode && <span className={`tag mode-${mode}`}>mode: {mode}</span>}{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · {plans} ExitPlanMode call{plans === 1 ? "" : "s"} · ${cost.toFixed(4)}
          </span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["options", "guard", "review", "decide", "hook", "messages", "check"].map(
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

      <h3>D · What you decide, and what the model gets</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>You</th>
            <th>The host returns</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([k, a, b]) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>
                <code>{a}</code>
              </td>
              <td>{b}</td>
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
