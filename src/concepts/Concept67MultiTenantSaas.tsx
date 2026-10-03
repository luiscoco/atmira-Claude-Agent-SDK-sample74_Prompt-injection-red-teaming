import { useEffect, useRef, useState } from "react";

type Workspace = {
  principal: { tenant: string; user: string; role: string };
  projects: { id: string; name: string }[];
  sessions: { id: string; messages: { question: string; answer: string }[] }[];
  usage: { runs: number; active: number; spentUsd: number; reservedUsd: number; audit: { event: string; user: string; at: string }[] };
  limits: { runs: number; budgetUsd: number; sessions: number };
};
const accounts = [ ["lesson67-alice", "Alice · Acme admin"], ["lesson67-ava", "Ava · Acme viewer"], ["lesson67-bob", "Bob · Orbit admin"] ];
export function Concept67MultiTenantSaas() {
  const [token, setToken] = useState(accounts[0][0]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [session, setSession] = useState("");
  const [target, setTarget] = useState("orbit-launch");
  const [foreignSession, setForeignSession] = useState("");
  const [prompt, setPrompt] = useState("List my projects. Can you switch to Orbit and read its private launch?");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [code, setCode] = useState<Record<string, string>>();
  const [refreshing, setRefreshing] = useState(false), [refreshFeedback, setRefreshFeedback] = useState(""), [refreshFailed, setRefreshFailed] = useState(false);
  const refreshCount = useRef(0);
  const [runFeedback, setRunFeedback] = useState("");
  const [checking, setChecking] = useState<"project" | "session" | null>(null);
  const [accessFeedback, setAccessFeedback] = useState<Record<"project" | "session", { text: string; failed: boolean }>>({ project: { text: "", failed: false }, session: { text: "", failed: false } });
  const accessCount = useRef({ project: 0, session: 0 });
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(`/api/c67${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.message}`);
    return data;
  }
  useEffect(() => {
    const epoch = ++generation.current, abort = new AbortController();
    setWorkspace(undefined); setSession(""); setError(""); setNotice(""); setBusy(false);
    setRunFeedback("");
    setRefreshing(false); setRefreshFeedback(""); setRefreshFailed(false); refreshCount.current = 0;
    setChecking(null); setAccessFeedback({ project: { text: "", failed: false }, session: { text: "", failed: false } }); accessCount.current = { project: 0, session: 0 };
    request("/workspace", undefined, abort.signal).then((data) => { if (epoch === generation.current) setWorkspace(data); }).catch((err) => { if (!abort.signal.aborted) setError(String(err)); });
    return () => { ++generation.current; abort.abort(); controller.current?.abort(); };
  }, [token]);
  async function refreshWorkspace() {
    if (busy) return;
    const epoch = generation.current, abort = new AbortController(); controller.current = abort;
    setBusy(true); setRefreshing(true); setRefreshFailed(false); setRefreshFeedback("Refreshing workspace…"); setError(""); setNotice("");
    const timer = window.setTimeout(() => abort.abort(), 15000);
    try {
      const data: Workspace = await request("/workspace", undefined, abort.signal);
      if (epoch !== generation.current) return;
      setWorkspace(data);
      if (session && !data.sessions.some((s) => s.id === session)) setSession("");
      setRefreshFeedback(`Refresh #${++refreshCount.current} completed at ${new Date().toLocaleTimeString()}: ${data.projects.length} projects, ${data.sessions.length} conversations, ${data.usage.runs}/${data.limits.runs} accepted runs. Current data loaded; refreshing does not reset quotas.`);
    } catch (err) {
      if (epoch === generation.current) {
        setRefreshFailed(true);
        setRefreshFeedback(abort.signal.aborted ? "Refresh stopped or timed out. Try Refresh workspace again." : `Refresh failed: ${String(err)}. Try again when the server is available.`);
      }
    } finally {
      window.clearTimeout(timer);
      if (epoch === generation.current) { setBusy(false); setRefreshing(false); }
    }
  }
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    const epoch = generation.current, abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setNotice("");
    try { await work(abort.signal); }
    catch (err) { if (epoch === generation.current) setError(abort.signal.aborted ? "Stopped. Refresh usage; an accepted request still counts toward quota." : String(err)); }
    finally {
      if (epoch === generation.current) {
        try { const data = await request("/workspace"); if (epoch === generation.current) setWorkspace(data); } catch (err) { if (epoch === generation.current) setError(String(err)); }
        if (epoch === generation.current) setBusy(false);
      }
    }
  }
  const conversation = workspace?.sessions.find((s) => s.id === session);
  const runBlocked = !workspace ? ""
    : workspace.principal.role !== "admin" ? "Only admins can run the agent."
    : workspace.usage.runs >= workspace.limits.runs ? `Tenant run quota reached (${workspace.usage.runs}/${workspace.limits.runs}). Switch to another tenant, or restart the demo server to reset this in-memory fixture. Refreshing and creating a new conversation do not reset quotas.`
    : workspace.usage.active >= 1 ? "This tenant already has an active run. Refresh workspace after it finishes." : "";
  const liveBlocked = runBlocked || (workspace && workspace.usage.spentUsd + workspace.usage.reservedUsd + 0.05 > workspace.limits.budgetUsd + 1e-9 ? "Tenant live budget exhausted. Guided runs remain available if run quota remains." : "");
  async function checkAccess(kind: "project" | "session", id: string) {
    if (busy) return;
    const epoch = generation.current, abort = new AbortController(); controller.current = abort;
    const update = (text: string, failed = false) => {
      if (epoch === generation.current) setAccessFeedback((all) => ({ ...all, [kind]: { text, failed } }));
    };
    const number = ++accessCount.current[kind];
    setBusy(true); setChecking(kind); setError(""); setNotice("");
    update(`Checking ${kind === "project" ? "project" : "conversation"} access…`);
    const timer = window.setTimeout(() => abort.abort(), 15000);
    try {
      const result = await request("/access-check", { kind, id: id.trim() }, abort.signal);
      if (epoch !== generation.current) return;
      const outcome = result.allowed
        ? (kind === "project" ? `Authorized read: ${result.resource.name} (ID: ${result.resource.id}).` : `Authorized conversation: ${result.resource.id}.`)
        : `Access denied (404) for ID "${id.trim()}": ${result.message} Foreign and unknown IDs are treated alike.${kind === "session" ? " Use a generated conversation UUID from Create conversation." : ""}`;
      update(`Check #${number} · ${outcome}`);
      try {
        const data = await request("/workspace", undefined, abort.signal);
        if (epoch === generation.current) setWorkspace(data);
      } catch { update(`Check #${number} · ${outcome} Audit refresh unavailable; use Refresh workspace to retry.`); }
    } catch (err) {
      update(abort.signal.aborted ? "Access check stopped or timed out. Try again." : `Access check failed: ${String(err)}. Try again when the server is available.`, true);
    } finally {
      window.clearTimeout(timer);
      if (epoch === generation.current) { setBusy(false); setChecking(null); }
    }
  }
  return <>
    <h2>67. A multi-tenant SaaS architecture</h2>
    <p>One shared application serves multiple organizations. Authentication establishes tenant context; every data read, conversation, tool and quota uses that context on the host.</p>
    <div className="grid">
      <div className="card"><b>Identity → membership</b><p>Resolve the caller's workspace and role from verified credentials. A tenant name in a prompt or request body grants no access.</p></div>
      <div className="card"><b>Scoped storage and tools</b><p>Filter records by tenant and authorize conversation ownership. Tool closures capture the authenticated context.</p></div>
      <div className="card"><b>Fair resource use</b><p>Reserve budget and concurrency before launching a worker. Keep usage and audit records inside the tenant boundary.</p></div>
    </div>
    <h3>A · Switch authenticated demo accounts</h3>
    <div className="card">
      <label htmlFor="saas-account">Demo identity </label><select id="saas-account" value={token} disabled={busy} onChange={(e) => setToken(e.target.value)}>{accounts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <p className="hint">These published bearer credentials simulate authentication for a local lesson. Production needs an identity provider and a server-side membership lookup. Data and quotas are in memory and reset when the server restarts.</p>
      {workspace && <p role="status">Workspace: {workspace.principal.tenant} · User: {workspace.principal.user} · Role: {workspace.principal.role}</p>}
      <button disabled={busy} aria-busy={refreshing} onClick={refreshWorkspace}>{refreshing ? "Refreshing workspace…" : "Refresh workspace"}</button>
      {refreshFeedback && <p role={refreshFailed ? "alert" : "status"} aria-live="polite">{refreshFeedback}</p>}
    </div>
    {error && <p className="card warn" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {workspace && <>
      <div className="card"><b>Visible projects</b><ul>{workspace.projects.map((p) => <li key={p.id}>{p.name} <code>{p.id}</code></li>)}</ul></div>
      <h3>B · Test authorization at the HTTP boundary</h3>
      <div className="card">
        <label htmlFor="saas-project">Project ID </label><input id="saas-project" value={target} disabled={busy} onChange={(e) => { setTarget(e.target.value); setAccessFeedback((all) => ({ ...all, project: { text: "", failed: false } })); }} />{" "}
        <button disabled={busy || !target.trim() || target.trim().length > 200} aria-busy={checking === "project"} aria-describedby="saas-project-result" onClick={() => checkAccess("project", target)}>{checking === "project" ? "Reading project…" : "Read project"}</button>
        <p id="saas-project-result" role={accessFeedback.project.failed ? "alert" : "status"} aria-live="polite">{accessFeedback.project.text || "Enter a project ID and click Read project to see its access result here."}</p>
        <p>Acme can read <code>acme-roadmap</code>; Orbit can read <code>orbit-launch</code>. The lesson check displays a 404 denial for foreign or nonexistent IDs without a failed network request. Direct resource API requests still return HTTP 404.</p>
        <label htmlFor="saas-foreign-session">Conversation ID </label><input id="saas-foreign-session" value={foreignSession} disabled={busy} onChange={(e) => { setForeignSession(e.target.value); setAccessFeedback((all) => ({ ...all, session: { text: "", failed: false } })); }} />{" "}
        <button disabled={busy || !foreignSession.trim() || foreignSession.trim().length > 200} aria-busy={checking === "session"} aria-describedby="saas-session-result" onClick={() => checkAccess("session", foreignSession)}>{checking === "session" ? "Checking conversation…" : "Check conversation access"}</button>
        <p id="saas-session-result" role={accessFeedback.session.failed ? "alert" : "status"} aria-live="polite">{accessFeedback.session.text || "Paste a conversation ID and click Check conversation access to see its result here."}</p>
        <p>Paste the generated conversation UUID, rather than a person's name. Copy an Acme conversation ID below, switch to Bob and paste it here. Ownership checks deny the read. Ava may read Acme projects but cannot create or run conversations.</p>
      </div>
      <h3>C · A tenant-scoped agent conversation</h3>
      <div className="card">
        <button disabled={busy} onClick={() => action(async (signal) => { const s = await request("/sessions", {}, signal); setSession(s.id); })}>Create conversation</button>{" "}
        <label htmlFor="saas-session">Conversation </label><select id="saas-session" value={session} disabled={busy} onChange={(e) => setSession(e.target.value)}><option value="">Select a conversation</option>{workspace.sessions.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select>
        {session && <p>Conversation ID: <code>{session}</code></p>}
        <label htmlFor="saas-prompt">Question</label><textarea id="saas-prompt" rows={3} value={prompt} maxLength={2000} disabled={busy} onChange={(e) => setPrompt(e.target.value)} />
        <p>{(["guided", "live"] as const).map((mode) => <button key={mode} disabled={busy || !session || !prompt.trim() || Boolean(mode === "live" ? liveBlocked : runBlocked)} aria-describedby="saas-run-availability" onClick={() => action(async (signal) => {
          setRunFeedback("Starting workspace agent…");
          try {
            const result = await request(`/sessions/${session}/execute`, { requestId: crypto.randomUUID(), prompt, mode }, signal);
            setRunFeedback(result.accepted ? "Run completed; conversation and tenant usage updated." : `Run not started (${result.status}): ${result.message} Refresh workspace to see current quota usage.`);
          } catch (err) { setRunFeedback(signal.aborted ? "Run stopped. Refresh workspace to inspect usage." : `Run failed: ${String(err)}`); throw err; }
        })}>{mode === "guided" ? "Run guided (no model API)" : "Run live agent (billed)"}</button>)}{" "}<button disabled={!busy} onClick={() => controller.current?.abort()}>Stop request</button></p>
        <p id="saas-run-availability" role="status" aria-live="polite">{runBlocked || liveBlocked || `${workspace.limits.runs - workspace.usage.runs} accepted runs remaining for this tenant.`}</p>
        {runFeedback && <p role="status" aria-live="polite">{runFeedback}</p>}
        <p className="hint">Guided mode executes the scoped project read and quota checks. Live mode uses Haiku, one private list_projects tool, four turns, a $0.05 SDK budget and a 60-second deadline. Earlier turns are passed explicitly; SDK sessions are not resumed.</p>
        {conversation?.messages.map((m, i) => <div className="card" key={i}><b>You</b><p>{m.question}</p><b>Workspace assistant</b><p>{m.answer}</p></div>)}
      </div>
      <div className="card"><b>Tenant usage</b><p>Accepted runs: {workspace.usage.runs}/{workspace.limits.runs} · Active: {workspace.usage.active}/1 · Spent: ${workspace.usage.spentUsd.toFixed(4)} · Reserved: ${workspace.usage.reservedUsd.toFixed(4)} · Budget: ${workspace.limits.budgetUsd.toFixed(2)}</p><p>Five accepted runs per tenant, ten conversations and one concurrent worker. Guided runs count but cost $0. If live usage is unknown after a failure, the reservation is charged conservatively. A duplicate request ID is rejected to avoid a second charge.</p></div>
      <details className="card"><summary>Tenant audit trail (latest 50 events)</summary><pre className="wrap">{JSON.stringify(workspace.usage.audit, null, 2)}</pre></details>
    </>}
    <h3>D · From this fixture to a deployed SaaS</h3>
    <p>Use a tenant key on every table, composite tenant/object keys and database row-level authorization as a second boundary. Scope caches, object storage, retrieval indexes, logs and background jobs too. Workers must resolve current membership before executing queued jobs.</p>
    <p>This single-process fixture uses synchronous quota reservation. Multiple replicas need atomic shared reservations and a durable usage ledger. SDK budgets are execution limits rather than strict prepaid billing guarantees. Record actual provider usage, reconcile failures and add rate limits. Separate configuration directories help prevent accidental state sharing; tools are disabled except for the scoped read. They do not provide an operating-system security boundary: use isolated worker processes or containers for filesystem and shell access.</p>
    <button onClick={() => action(async (signal) => { setCode(await request("/code", undefined, signal)); })} disabled={busy}>Load source code</button>
    {code && Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
  </>;
}
