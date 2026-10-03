import { useEffect, useRef, useState } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type Order = { id: string; status: string; totalCents: number; version: number; note: string };
type Proposal = { id: string; orderId: string; before: string; after: string; reason: string; version: number; expiresAt: number; state: string };
type Snapshot = { orders: Order[]; proposals: Proposal[]; audit: { action: string; outcome: string; at: string }[] };
export function Concept63SafeDatabaseAgent() {
  const [id, setId] = useState(""); const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [status, setStatus] = useState("all"); const [rows, setRows] = useState<Order[]>();
  const [orderId, setOrderId] = useState("A-101"); const [reason, setReason] = useState("Customer requested cancellation.");
  const [question, setQuestion] = useState("List pending orders and propose cancelling A-101 at the customer's request.");
  const [messages, setMessages] = useState<any[]>([]); const [calls, setCalls] = useState<any[]>([]);
  const [answer, setAnswer] = useState<{ text: string; costUsd: number }>(); const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function request(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`); return data;
  }
  async function start() {
    setBusy(true); setError(""); setNotice(""); setRefreshFeedback("");
    try { const data = await request("/api/c63/sessions", {}); setId(data.id); setSnapshot(data); setRows(undefined); setMessages([]); setCalls([]); setAnswer(undefined); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  async function action(operation: string, body: unknown) {
    setBusy(true); setError(""); setNotice("");
    try { const data = await request(`/api/c63/sessions/${id}/${operation}`, body); setSnapshot(data); if (data.ok === false) setNotice(data.message); else if (operation === "read") setRows(data.result); }
    catch (error) { setError(String(error)); try { setSnapshot(await request(`/api/c63/sessions/${id}`)); } catch { /* Keep original error. */ } }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!id || busy) return;
    setBusy(true); setRefreshing(true); setError(""); setNotice("");
    setRefreshFailed(false); setRefreshFeedback("");
    try {
      const data: Snapshot = await request(`/api/c63/sessions/${id}`);
      setSnapshot(data);
      if (rows) setRows(data.orders.filter((row) => status === "all" || row.status === status).slice(0, 5));
      setRefreshFeedback(`Refreshed at ${new Date().toLocaleTimeString()}: ${data.orders.length} orders, ${data.proposals.length} proposals and ${data.audit.length} audit events. Refresh reads the current state; it does not reset the database.`);
    } catch (error) {
      setRefreshFailed(true); setRefreshFeedback(String(error));
    } finally { setRefreshing(false); setBusy(false); }
  }
  async function live() {
    setBusy(true); setError(""); setNotice(""); setMessages([]); setCalls([]); setAnswer(undefined);
    const abort = new AbortController(); controller.current = abort;
    try { await streamPost(`/api/c63/sessions/${id}/query`, { question }, (event, data) => {
      if (event === "message") setMessages((all) => [...all, data]);
      if (event === "tool") setCalls((all) => [...all, data]);
      if (event === "answer") setAnswer(data);
      if (event === "snapshot") setSnapshot(data);
      if (event === "error") setError(data.message);
    }, abort.signal); }
    catch (error) { setError(abort.signal.aborted ? "Run stopped. Refresh to inspect any proposals created before Stop." : String(error)); }
    finally { setBusy(false); }
  }
  const table = (items: Order[]) => <div className="scroll-x"><table className="compare"><thead><tr><th>Order</th><th>Status</th><th>Total (cents)</th><th>Version</th><th>Untrusted note</th></tr></thead><tbody>{items.map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.status}</td><td>{row.totalCents}</td><td>{row.version}</td><td>{row.note}</td></tr>)}</tbody></table></div>;
  return <>
    <h2>63. A safe database agent</h2>
    <p>Put the database boundary in code. The agent reads through narrow tools and proposes changes. A human reviews the exact preview before a separate host action commits it.</p>
    <div className="grid"><div className="card"><b>Bounded reads</b><p>Fixed SQL, bound parameters, a host-selected tenant and a ten-row maximum. No arbitrary SQL tool or sensitive customer columns.</p></div><div className="card"><b>Preview before write</b><p>A cancellation proposal changes no rows. Approve or reject the stored preview within five minutes. Each proposal can be consumed once.</p></div><div className="card"><b>Check at commit</b><p>A transaction rechecks tenant, status and version. Stale previews roll back. The agent has no approval tool.</p></div></div>
    {error && <p className="card warn" role="alert">{error}</p>}
    {notice && <p className="card" role="status">{notice}</p>}
    <h3>A · Disposable SQLite database</h3>
    <p>Start an isolated, fictional Acme lab (expires after one hour). A second tenant's row exists but is never returned. One note contains a prompt injection to test the data boundary.</p>
    <button disabled={busy} onClick={start}>{id ? "Start a fresh lab" : "Start lab (offline)"}</button>
    {snapshot && table(snapshot.orders)}
    <h3>B · Read and propose without a model</h3>
    <div className="card"><label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}>{["all", "pending", "shipped", "cancelled"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <button disabled={busy || !id} onClick={() => action("read", { status, limit: 5 })}>Read orders</button>
      <button disabled={busy || !id} onClick={() => action("blocked-sql", {})}>Try blocked arbitrary SQL</button>
      {rows && table(rows)}
      <label>Order ID <input value={orderId} maxLength={50} onChange={(event) => setOrderId(event.target.value)} /></label>
      <label>Reason <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} /></label>
      <button disabled={busy || !id || !reason.trim()} onClick={() => action("propose", { orderId, reason })}>Preview cancellation</button>
    </div>
    <h3>C · Human review</h3>
    <p>Approval applies only the stored change shown below. Try two previews for the same order: committing one makes the other stale. Rejection, expiry and replay cannot commit.</p>
    {snapshot?.proposals.map((proposal) => <div className="card" key={proposal.id}><b>{proposal.orderId}: {proposal.before} → {proposal.after}</b><p>{proposal.reason}</p><p className="hint">Version {proposal.version} · {proposal.state} · expires {new Date(proposal.expiresAt).toLocaleTimeString()}</p>
      <button disabled={busy || proposal.state !== "pending"} onClick={() => action("decide", { proposalId: proposal.id, approve: true })}>Approve cancellation of {proposal.orderId}</button>{" "}
      <button disabled={busy || proposal.state !== "pending"} onClick={() => action("decide", { proposalId: proposal.id, approve: false })}>Reject</button>
    </div>)}
    <button disabled={busy || !id} aria-busy={refreshing} onClick={refresh}>{refreshing ? "Refreshing database and audit…" : "Refresh database and audit"}</button>
    {!id && <p className="hint">Start a lab above to enable refresh.</p>}
    {refreshFeedback && <div className={`card${refreshFailed ? " warn" : ""}`}>
      <p role={refreshFailed ? "alert" : "status"}>{refreshFeedback}</p>
      {!refreshFailed && snapshot && <details><summary>Inspect refreshed database and latest audit events</summary>
        {table(snapshot.orders)}
        <pre className="wrap">{JSON.stringify(snapshot.audit.slice(-5), null, 2)}</pre>
      </details>}
    </div>}
    <h3>D · Ask the database agent (live, billed)</h3>
    <p>Uses configured Anthropic credentials, Haiku, two custom tools, no built-in tools or project settings, six turns, a $0.10 budget and a 90-second deadline. Stop disconnects the run; proposals already created remain for review.</p>
    <div className="card"><label>Request <textarea value={question} disabled={busy} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} /></label><button disabled={busy || !id || !question.trim()} onClick={live}>Ask agent (billed)</button>{" "}<button disabled={!busy || !controller.current || controller.current.signal.aborted} onClick={() => controller.current?.abort()}>Stop</button></div>
    {calls.map((call, index) => <details className="card" key={index}><summary>{call.name}</summary><pre className="wrap">{JSON.stringify(call.result, null, 2)}</pre></details>)}
    {answer && <div className="card"><p>{answer.text}</p><p className="hint">SDK cost: ${answer.costUsd.toFixed(4)}. Verify database state above; model prose does not prove a commit.</p></div>}
    <MessageLog messages={messages} />
    <h3>E · Audit and implementation</h3>
    <details className="card"><summary>Host audit (last 100 events)</summary><pre className="wrap">{JSON.stringify(snapshot?.audit ?? [], null, 2)}</pre></details>
    <button onClick={async () => { try { setCode(await request("/api/c63/code")); } catch (error) { setError(String(error)); } }}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
    <p>This localhost teaching lab uses an opaque session ID as a capability, an in-memory database and a bounded in-memory audit. Production needs authenticated tenant and approver identities, CSRF protection, separate read-only database credentials, durable proposals and audit storage. SQLite query_only is an extra guard on the private connection; fixed application operations enforce the boundary. Read-only SQL alone does not prevent data disclosure or expensive queries.</p>
    <p className="hint">References: <a href="https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html">Node SQLite</a> · <a href="https://code.claude.com/docs/en/agent-sdk/custom-tools">Agent SDK custom tools</a>.</p>
  </>;
}
