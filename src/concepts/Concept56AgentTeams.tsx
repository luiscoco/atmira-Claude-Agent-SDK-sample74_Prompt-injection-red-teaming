import { useEffect, useRef, useState } from "react";
import type { Command, TeamState, Receipt } from "../../server/teams/workshop";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Report = { state: TeamState; receipts: Receipt[] };
type Facts = { members: string[]; walkthrough: Command[]; initial: Report };
const terminalExample = '$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"\nclaude --teammate-mode in-process';
const teamPrompt = `Create an agent team with researcher and reviewer. Researcher owns the calculation of 12 + 18 + 7. Reviewer independently verifies it. Give each worker the data and acceptance criteria. Have researcher send its equation directly to reviewer, then have reviewer send verified evidence to the lead. Use shared tasks and a review dependency if Task tools are available. Wait for both reports, synthesize the answer, then request worker shutdown.`;

export function Concept56AgentTeams() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Command[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [actor, setActor] = useState("researcher");
  const [to, setTo] = useState("reviewer");
  const [text, setText] = useState("12 + 18 + 7 = 37; please verify.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exerciseStatus, setExerciseStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [messages, setMessages] = useState<any[]>([]);
  const [tools, setTools] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const pending = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const walkthroughRuns = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch("/api/c56/facts", { signal: controller.signal }), fetch("/api/c56/code", { signal: controller.signal })]).then(async ([a, b]) => {
      if (!a.ok || !b.ok) throw new Error("Could not load lesson 56.");
      const [f, c] = await Promise.all([a.json(), b.json()]);
      if (!controller.signal.aborted) { setFacts(f); setReport(f.initial); setCode(c); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [attempt]);
  async function replay(commands: Command[]) {
    if (lock.current) return; lock.current = true;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    setExerciseStatus("Updating the exercise…");
    const deadline = setTimeout(() => controller.abort(new Error("The exercise request timed out. Please try again.")), 15_000);
    try {
      const response = await fetch("/api/c56/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commands }), signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted) {
        setReport(result); setHistory(commands);
        setExerciseStatus(result.state.cleaned
          ? `Walkthrough run ${++walkthroughRuns.current} completed. Restart the walkthrough to step through it again.`
          : `Step ${commands.length} processed. ${result.receipts.at(-1)?.detail ?? "Exercise ready."}`);
      }
    } catch (e) {
      if (pending.current === controller) {
        const message = controller.signal.aborted ? "Exercise request cancelled or timed out. Try again or reset the exercise." : String(e);
        setError(message); setExerciseStatus(message);
      }
    }
    finally {
      clearTimeout(deadline);
      if (pending.current === controller) { lock.current = false; pending.current = null; setBusy(false); }
    }
  }
  function resetExercise() {
    if (lock.current || !facts) return;
    setReport(facts.initial); setHistory([]); setError("");
    setExerciseStatus("Exercise reset. Click Next walkthrough step to begin at step 1.");
  }
  async function live() {
    if (lock.current) return; lock.current = true;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(""); setMessages([]); setTools([]); setSummary(null);
    try {
      await streamPost("/api/c56/live", {}, (event, data) => {
        if (controller.signal.aborted) return;
        if (event === "message") setMessages((rows) => [...rows, data]);
        if (event === "tool") setTools((rows) => [...rows, data]);
        if (event === "summary") setSummary(data);
        if (event === "error") setError(data.message);
      }, controller.signal);
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { lock.current = false; if (pending.current === controller) pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  function cancel() { pending.current?.abort(); setBusy(false); setError("Request cancelled. The backend cancels a disconnected live run."); }
  const disabled = busy || !facts || history.length >= 100;
  const state = report?.state;
  const latest = report?.receipts.at(-1);
  return <section>
    <h2>56. Agent teams and inter-agent messaging</h2>
    <p className="lead">Give workers clear ownership, exchange evidence directly, and distinguish a sent message from completed work.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Subagents</b><p>Focused workers inside a caller's session. A named worker can be addressed for a follow-up.</p></div>
      <div className="card"><b>Native agent teams</b><p>Experimental interactive Claude Code sessions with independent teammates, mailboxes and shared work.</p></div>
      <div className="card"><b>Application orchestration</b><p>Your own protocol around SDK calls. You own routing, retries, validation and lifecycle.</p></div>
    </div>
    <p>Native teammates require an interactive session. Enabling the teams flag does not turn <code>query()</code> into a native team. This lesson provides an application-owned offline exercise and a separate live named-subagent demo. See <a href="https://code.claude.com/docs/en/agent-teams" target="_blank" rel="noreferrer">official agent teams documentation</a>.</p>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}
    <h3>A · Step through coordination</h3>
    <p>No API calls. Each click executes the lesson's reducer on the server. Rejected steps leave task and mailbox state unchanged. This protocol is a teaching design, not Claude Code's internal schema.</p>
    <div className="row">
      <button className="primary" disabled={busy || !facts || (!state?.cleaned && disabled) || (!state?.cleaned && history.length >= (facts?.walkthrough.length ?? 0))} onClick={() => state?.cleaned ? resetExercise() : replay([...history, facts!.walkthrough[history.length]])}>{state?.cleaned ? "Restart walkthrough" : `Next walkthrough step (${Math.min(history.length, facts?.walkthrough.length ?? 0)}/${facts?.walkthrough.length ?? 16})`}</button>
      <button disabled={busy || !facts} onClick={() => replay(facts!.walkthrough)}>{state?.cleaned ? "Run full walkthrough again" : "Run full walkthrough"}</button>
      <button disabled={busy || !facts} onClick={resetExercise}>Reset exercise</button>
    </div>
    {exerciseStatus && <p role="status" aria-live="polite">{exerciseStatus}</p>}
    {facts && history.length < facts.walkthrough.length && <details className="card"><summary>Next command</summary><pre className="wrap">{JSON.stringify(facts.walkthrough[history.length], null, 2)}</pre></details>}
    {latest && <p role="status"><b>{latest.ok ? "Accepted" : "Rejected"} · step {latest.step}</b> · {latest.detail}</p>}
    {state && <>
      <div className="teams-members">{Object.entries(state.members).map(([name, status]) => <div className="card" key={name}><b>{name}</b><p>{status}</p></div>)}</div>
      <div className="eval-table"><table><thead><tr><th>Task</th><th>Dependency</th><th>Owner</th><th>Status</th><th>Evidence</th></tr></thead><tbody>{state.tasks.map((task) => <tr key={task.id}><td>{task.title}</td><td>{task.dependsOn.join(", ") || "None"}</td><td>{task.owner ?? "Unclaimed"}</td><td>{task.status}</td><td>{task.evidence ?? "Pending"}</td></tr>)}</tbody></table></div>
      <h4>Mailboxes</h4>
      {!state.messages.length && <p className="hint">No messages yet.</p>}
      {state.messages.map((message) => <div className="card" key={message.id}><b>{message.from} → {message.to}</b> · <code>{message.id}</code> · {message.status}<p>{message.text}</p></div>)}
      {state.cleaned && <p role="status">Team exercise closed. Click Restart walkthrough to try again.</p>}
    </>}
    <details className="card"><summary>Command receipts ({report?.receipts.length ?? 0})</summary><ol>{report?.receipts.map((receipt) => <li key={receipt.step}><b>{receipt.ok ? "PASS" : "REJECT"} · {receipt.type}</b> — {receipt.detail}</li>)}</ol></details>
    <h3>B · Send your own peer message</h3>
    <p>Reset before experimenting. Try delivery before acknowledgment, replay the same ID, or claim review before research completes. Custom commands share the walkthrough history; reset to restart its sequence.</p>
    <div className="row">
      <label>Sender<select value={actor} disabled={busy} onChange={(e) => setActor(e.target.value)}>{facts?.members.map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Recipient<select value={to} disabled={busy} onChange={(e) => setTo(e.target.value)}>{facts?.members.map((name) => <option key={name}>{name}</option>)}</select></label>
    </div>
    <label>Message<textarea value={text} maxLength={500} disabled={busy} onChange={(e) => setText(e.target.value)} /></label>
    <div className="row">
      <button disabled={disabled || !text.trim()} onClick={() => replay([...history, { type: "send", actor, to, id: `custom-${history.length + 1}`, text } as Command])}>Queue message</button>
      <button disabled={disabled} onClick={() => replay([...history, { type: "deliver", actor: to } as Command])}>Deliver recipient inbox</button>
      <button disabled={disabled || !state?.messages.some((m) => m.to === to && m.status === "delivered")} onClick={() => replay([...history, { type: "ack", actor: to, id: state!.messages.find((m) => m.to === to && m.status === "delivered")!.id } as Command])}>Acknowledge first delivered message</button>
    </div>
    <h3>C · Inspect real SDK messaging</h3>
    <p>This optional run uses Haiku and billed model calls: turn one names a calculator worker, turn two asks the lead to use <code>SendMessage</code> to continue it with +7. Requires API credentials and credit. Limit: $0.15 and 90 seconds. Model behavior varies; inspect actual tool results and the worker's reply.</p>
    <div className="row"><button className="primary" disabled={busy || !facts} onClick={live}>Run live named-worker demo</button><button disabled={!busy} onClick={cancel}>Cancel request</button></div>
    {tools.map((tool, index) => <details className="card" key={index} open><summary>{tool.agent} · {tool.name} attempted</summary><pre className="wrap">{JSON.stringify(tool.input, null, 2)}</pre></details>)}
    {summary && <div className="card"><b>Live observations</b><pre className="wrap">{JSON.stringify(summary, null, 2)}</pre></div>}
    <MessageLog messages={messages} />
    <h3>D · Try a native team in your terminal</h3>
    <p>In an interactive Claude Code terminal on Windows, enable teams for that shell and use the in-process display. This is a separate manual exercise with its own model usage.</p>
    <pre className="wrap">{terminalExample}</pre><pre className="wrap">{teamPrompt}</pre>
    <p>Supply each worker's task data explicitly. Assign separate file ownership, limit the team size, verify reports, and wait for shutdown. An idle worker can still receive messages. A peer message supplies evidence; it does not grant user permission.</p>
    <h3>E · Read and extend the implementation</h3>
    <p>Try changing a duplicate message's content while keeping its ID, removing the review dependency, or weakening the completion gate. The exercise's replay is sequential within one request. A production task store needs atomic claims across concurrent processes, durable messages, correlation IDs, bounded retries and recovery after crashes.</p>
    {Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
  </section>;
}
