import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Channel = "slack" | "teams" | "email";
type Notification = { channel: Channel; text: string; external: boolean; link?: string; payload?: unknown; id?: string; token?: string };
export function Concept65HumanApproval() {
  const [channel, setChannel] = useState<Channel>("slack");
  const [delivery, setDelivery] = useState<"local" | "external">("local");
  const [amount, setAmount] = useState(2500); const [timeout, setTimeoutSeconds] = useState(60);
  const [facts, setFacts] = useState<{ channels: { channel: Channel; configured: boolean }[] }>();
  const [attempt, setAttempt] = useState(0); const [busy, setBusy] = useState(false); const [deciding, setDeciding] = useState(false);
  const [notification, setNotification] = useState<Notification>();
  const [decisionError, setDecisionError] = useState("");
  const [expiresAt, setExpiresAt] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const [state, setState] = useState(""); const [error, setError] = useState("");
  const [events, setEvents] = useState<{ event: string; data: unknown }[]>([]);
  const [messages, setMessages] = useState<any[]>([]); const [answer, setAnswer] = useState("");
  const [evidence, setEvidence] = useState<{ executed: boolean; approval: unknown; ledger: unknown[] }>();
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/c65/facts", { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Loading lesson: HTTP ${response.status}`);
      setFacts(await response.json()); setError("");
    }).catch((error) => { if (!abort.signal.aborted) setError(String(error)); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [attempt]);
  useEffect(() => {
    if (state !== "pending" || !expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state, expiresAt]);
  async function start(mode: "guided" | "live") {
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setDecisionError(""); setExpiresAt(undefined); setState("starting"); setNotification(undefined); setEvidence(undefined); setEvents([]); setMessages([]); setAnswer("");
    let completed = false;
    try {
      await streamPost("/api/c65/run", { mode, delivery, channel, amountCents: amount, timeoutSeconds: timeout }, (event, data) => {
        if (event === "message") setMessages((all) => [...all, data]);
        else {
          // The notification contains a capability; keep it out of the general event log.
          if (event !== "notification") setEvents((all) => [...all, { event, data }]);
          if (event === "notification") setNotification(data);
          if (event === "pending" || event === "decision") { setState(data.state); setExpiresAt(data.expiresAt); setNow(Date.now()); }
          if (event === "answer") setAnswer(data.text);
          if (event === "evidence") { setEvidence(data); setState(data.approval?.state ?? "finished without a request"); }
          if (event === "error") setError(data.message);
          if (event === "done") completed = true;
        }
      }, abort.signal);
      if (!completed) { setState("disconnected"); setError("The approval connection closed before the run finished. Start a new run."); }
    } catch (error) { setError(abort.signal.aborted ? "Run stopped. Pending approval is cancelled; an already completed effect stays completed." : String(error)); setState(abort.signal.aborted ? "cancelled" : "failed"); }
    finally { setBusy(false); }
  }
  async function decide(approve: boolean) {
    if (!notification?.id || !notification.token) { setDecisionError("This preview has no approval credential. Start a new run."); return; }
    setDeciding(true); setDecisionError("");
    try {
      const response = await fetch("/api/c65/decision", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: notification.id, token: notification.token, approve }), signal: AbortSignal.timeout(10000) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message ?? `Decision failed: HTTP ${response.status}.`);
      if (!result?.state) throw new Error("The server did not confirm the decision. Try again or start a new run.");
      setState(result.state);
    } catch (error) { setDecisionError(error instanceof Error && error.name === "TimeoutError" ? "No decision confirmation received within 10 seconds. Check the run status before retrying." : error instanceof Error ? error.message : String(error)); } finally { setDeciding(false); }
  }
  async function loadCode() {
    try { const response = await fetch("/api/c65/code"); if (!response.ok) throw new Error(`Source: HTTP ${response.status}`); setCode(await response.json()); }
    catch (error) { setError(String(error)); }
  }
  const valid = Number.isInteger(amount) && amount > 0 && amount <= 10000 && Number.isInteger(timeout) && timeout >= 5 && timeout <= 120;
  const externalReady = facts?.channels.find((entry) => entry.channel === channel)?.configured;
  const remaining = expiresAt === undefined ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const canDecide = busy && state === "pending" && remaining > 0;
  const feedback = deciding ? "Submitting your decision…" : state === "pending" && canDecide ? `Waiting for your decision. ${remaining} seconds remaining.`
    : state === "expired" || (state === "pending" && remaining === 0) ? "This request expired. Start a new run to approve or reject a fresh request."
    : state === "approved" ? "Approval recorded. Check the host ledger below for the refund result."
    : state === "rejected" ? "Rejection recorded. No refund will execute."
    : "This request is no longer active. Start a new run to make a decision.";
  return <>
    <h2>65. Human approval over Slack, Teams or email</h2>
    <p>An agent proposes an action, your host sends a review request, and a human decides before the tool executes. Practice with a fictional refund for <code>ORD-65</code>, with an observable host ledger.</p>
    <div className="grid">
      <div className="card"><b>Propose</b><p>Freeze the order, amount and reason. Attach an expiry and a request fingerprint. Approval applies to this exact action.</p></div>
      <div className="card"><b>Review</b><p>Slack Block Kit, a Teams Adaptive Card or an HTML email opens the same review page. The reviewer explicitly approves or rejects.</p></div>
      <div className="card"><b>Execute</b><p>The tool waits for the decision. Rejection, timeout, delivery failure and cancellation leave the ledger empty. Replayed decisions cannot execute twice.</p></div>
    </div>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((value) => value + 1)}>Retry loading</button>}</div>}
    <h3>A · Choose the approval channel</h3>
    <div className="card">
      <label htmlFor="approval-channel">Channel </label><select id="approval-channel" value={channel} disabled={busy} onChange={(event) => setChannel(event.target.value as Channel)}><option value="slack">Slack</option><option value="teams">Microsoft Teams</option><option value="email">Email</option></select>{" "}
      <label htmlFor="approval-delivery">Delivery </label><select id="approval-delivery" value={delivery} disabled={busy} onChange={(event) => setDelivery(event.target.value as "local" | "external")}><option value="local">Local preview (no messages sent)</option><option value="external">Send to configured channel</option></select>
      <p><label>Refund amount in cents <input type="number" min={1} max={10000} step={1} value={amount} disabled={busy} onChange={(event) => setAmount(Number(event.target.value))} /></label>{" "}
        <label>Approval expiry in seconds <input type="number" min={5} max={120} step={1} value={timeout} disabled={busy} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></label></p>
      <p className="hint">Local preview simulates the selected channel's inbox with the real approval gate. External delivery sends a real notification; the refund remains fictional. {delivery === "external" && (externalReady ? "This channel is configured." : "Configure this channel in .env and restart the server first.")}</p>
      <button disabled={busy || !valid || (delivery === "external" && !externalReady)} onClick={() => start("guided")}>Run guided approval (no model API)</button>{" "}
      <button disabled={busy || !valid || (delivery === "external" && !externalReady)} onClick={() => start("live")}>Run approval agent (billed)</button>{" "}
      <button disabled={!busy} onClick={() => controller.current?.abort()}>Stop</button>
    </div>
    <p role="status" aria-live="polite">Status: {state || "ready"}{state === "pending" && " — waiting for the reviewer; no refund has executed."}</p>
    {notification && <div className="card"><h3>{notification.external ? "Notification accepted by provider" : `${notification.channel.toUpperCase()} · local inbox preview`}</h3>
      <p>{notification.text}</p>
      {notification.link && <p><a href={notification.link} target="_blank" rel="noreferrer">Open approval page</a></p>}
      {!notification.external && <div className="approval-actions" aria-label="Refund decision">
        {canDecide && <><button type="button" disabled={deciding} onClick={() => decide(true)}>Approve refund</button>{" "}<button type="button" disabled={deciding} onClick={() => decide(false)}>Reject refund</button></>}
        <p role="status" aria-live="polite">{feedback}</p>
        {decisionError && <p className="warn" role="alert">{decisionError}</p>}
        {!busy && <button type="button" disabled={!valid} onClick={() => start("guided")}>Start a new approval request</button>}
        <details><summary>Channel payload (contains the private review link)</summary><pre className="wrap">{JSON.stringify(notification.payload, null, 2)}</pre></details></div>}
    </div>}
    {evidence && <div className="card" aria-live="polite"><b>{evidence.executed ? "Host ledger: one fictional refund executed" : "Host ledger: no refund executed"}</b><pre className="wrap">{JSON.stringify(evidence, null, 2)}</pre></div>}
    {answer && <div className="card"><b>Agent report</b><p>{answer}</p></div>}
    <details className="card"><summary>Request and decision events</summary><pre className="wrap">{JSON.stringify(events, null, 2)}</pre></details>
    <MessageLog messages={messages} />
    <h3>B · SDK permission prompts and application approval</h3>
    <p><code>canUseTool</code> can pause an SDK permission prompt until a channel reply returns <code>allow</code> or <code>deny</code>. Auto-approved tools bypass that callback. This lab therefore enforces business approval inside the custom tool handler, using the same gate for guided and live runs.</p>
    <pre className="wrap">{`tool("issue_refund", description, schema, async input => {
  const request = createApproval(input); // immutable, expiring
  await sendNotification(request);
  const decision = await request.result;
  if (decision !== "approved") return denied(decision);
  return executeOnce(request.id, request.refund);
});`}</pre>
    <p>The live run uses Haiku, one MCP tool, no built-in tools, four turns and a $0.10 budget. Its overall deadline is the approval expiry plus 60 seconds. Only one lesson 65 run is active at a time. Leaving this lesson or pressing Stop cancels pending approval.</p>
    <h3>C · Configure real notification delivery</h3>
    <p>Set <code>APPROVAL_PUBLIC_BASE_URL</code> to the HTTPS origin serving this app, then configure one channel in <code>.env</code>. Slack needs <code>APPROVAL_SLACK_BOT_TOKEN</code> with <code>chat:write</code> and <code>APPROVAL_SLACK_CHANNEL</code>. Teams needs <code>APPROVAL_TEAMS_WORKFLOW_URL</code> for a workflow that posts the supplied Adaptive Card. Email uses Microsoft Graph with <code>APPROVAL_GRAPH_TOKEN</code>, <code>APPROVAL_EMAIL_SENDER</code> and <code>APPROVAL_EMAIL_TO</code>, with <code>Mail.Send</code> permission.</p>
    <p>These are outbound adapters. Teams buttons use <code>Action.OpenUrl</code>; the workflow does not itself capture approval. Slack uses a URL button. The review page sends a separate decision POST. Provider acceptance does not guarantee notification delivery or human approval.</p>
    <h3>D · Trust, replay and recovery</h3>
    <p>The private review link is a bearer capability: anyone holding it can decide. It does not prove a Slack, Teams or email identity. GET requests have no decision effect, and the credential stays in the URL fragment until the review page moves it into a POST body. Do not share links or payloads. For identified reviewers, replace this capability flow with authenticated application sessions and an approver allowlist.</p>
    <p>The sample keeps requests, audit and refund ledger in memory. Restart loses them and invalidates outstanding links. For longer approvals, combine lesson 60's durable supervisor with persisted action snapshots, authenticated callbacks and provider idempotency keys. Cancellation cannot undo an effect that already completed.</p>
    <button onClick={loadCode}>Load source code</button>
    {code && Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/user-input">Agent SDK approvals</a> · <a href="https://docs.slack.dev/reference/methods/chat.postMessage/">Slack messages</a> · <a href="https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook">Teams workflows and cards</a> · <a href="https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0">Graph sendMail</a>.</p>
  </>;
}
