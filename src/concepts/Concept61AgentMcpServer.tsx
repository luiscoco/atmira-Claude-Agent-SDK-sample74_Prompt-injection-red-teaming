import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";

type Order = { id: string; customer: string; item: string; amountCents: number; daysSincePurchase: number; condition: string; expected: { decision: string; broken: string[] } };
type Facts = {
  model: string; limits: { maxConcurrent: number; perCallBudgetUsd: number; serverBudgetUsd: number; callTimeoutMs: number }; policyText: string; toolDescription: string;
  deskSystemPrompt: string; leadSystemPrompt: string; sampleMessages: Record<string, string>; orders: Order[]; tokenFromEnv: boolean; liveAvailable: boolean; url: string;
  config: { claudeHttp: string; claudeStdio: string; mcpJson: string; agentSdk: string };
};
type Describe = { server: { name: string; version: string }; instructions?: string; tools: unknown[]; resources: { uri: string; name: string }[]; policy: { text: string } };
type ContractRow = { scenario: string; call: string; isError: boolean; thrown?: string; text: string; progress: string[]; serverLog: string; agentRan: boolean; ms: number };
type Usage = { costUsd: number; turns: number; durationMs: number };
type CallLog = { at: number; transport: string; caller: string; orderId: string; outcome: string; isError: boolean; usage?: Usage; ms: number; progress: string[] };
type Verdict = { orderId: string; decision: string; brokenRules: string[]; customerReply: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const usd = (n: number) => `$${n.toFixed(4)}`;
const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
};

export function Concept61AgentMcpServer() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [desk, setDesk] = useState<Describe | null>(null);
  const [contract, setContract] = useState<ContractRow[]>([]);
  const [code, setCode] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [checks, setChecks] = useState<{ stdio?: any; http?: any }>({});
  const [checking, setChecking] = useState("");
  const [orderId, setOrderId] = useState("O-206");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [callLog, setCallLog] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<{ structured?: Verdict; isError?: boolean; text: string; usage?: Usage; ms: number; expected: { decision: string; broken: string[] } } | null>(null);
  const [picked, setPicked] = useState<string[]>(["O-201", "O-204", "O-206"]);
  const [delegateLog, setDelegateLog] = useState<string[]>([]);
  const [delegateResult, setDelegateResult] = useState<{ text: string; outerUsd: number; innerUsd: number; innerCalls: number; turns: number } | null>(null);
  const [serverLog, setServerLog] = useState<{ spentUsd: number; calls: CallLog[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(["facts", "describe", "contract", "code", "log"].map((route) => getJson(`/api/c61/${route}`, { signal: controller.signal }))).then(([f, d, c, k, l]) => {
      if (controller.signal.aborted) return;
      setFacts(f); setDesk(d); setContract(c); setCode(k); setServerLog(l); setLogAt(Date.now()); setMessage((m) => m || f.sampleMessages["O-206"]); setError("");
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, [attempt]);

  const [refreshing, setRefreshing] = useState(false);
  const [logAt, setLogAt] = useState(0);
  /** no-store: always ask the server, never a cached 304. logAt shows that a click did something even when nothing changed. */
  const refreshLog = async () => {
    setRefreshing(true);
    try { setServerLog(await getJson("/api/c61/log", { cache: "no-store" })); setLogAt(Date.now()); } catch (e) { setError(String(e)); }
    finally { setRefreshing(false); }
  };
  async function check(kind: "stdio" | "http") {
    setChecking(kind); setError("");
    try { const data = await getJson(`/api/c61/${kind}-check`); setChecks((all) => ({ ...all, [kind]: data })); } catch (e) { setError(String(e)); }
    finally { setChecking(""); }
  }
  async function stream(route: "call" | "delegate", body: object, onEvent: (event: string, data: any) => void) {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(route); setError("");
    try { await streamPost(`/api/c61/${route}`, body, (event, data) => { if (!controller.signal.aborted) onEvent(event, data); }, controller.signal); }
    catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (abortRef.current === controller) abortRef.current = null; setBusy(""); refreshLog(); }
  }
  const call = () => {
    setCallLog([]); setVerdict(null);
    stream("call", { orderId, customerMessage: message }, (event, data) => {
      if (event === "start") setCallLog([`tools/call review_refund → ${data.url}`]);
      if (event === "progress") setCallLog((all) => [...all, `  notifications/progress ${data.progress}: ${data.message}  (+${data.ms} ms)`]);
      if (event === "result") {
        setCallLog((all) => [...all, `result after ${data.ms} ms${data.isError ? " · isError" : ""}`]);
        setVerdict({ structured: data.structuredContent, isError: data.isError, text: data.content?.[0]?.text ?? "", usage: data._meta?.["refund-desk/usage"], ms: data.ms, expected: data.expected });
      }
      if (event === "error") setCallLog((all) => [...all, `error: ${data.message}`]);
    });
  };
  const delegate = () => {
    setDelegateLog([]); setDelegateResult(null);
    stream("delegate", { orderIds: picked }, (event, data) => {
      const add = (line: string) => setDelegateLog((all) => [...all, line]);
      if (event === "start") add(`outer agent prompt:\n${data.prompt}`);
      if (event === "init") add(`init: mcp_servers ${data.mcp_servers.map((s: any) => `${s.name}=${s.status}`).join(", ")} · tools ${data.tools.join(", ")}`);
      if (event === "text") add(`outer: ${data.text}`);
      if (event === "tool") add(`outer → ${data.name}(${data.input.orderId})`);
      if (event === "inner") add(`    desk [${data.orderId}] ${data.outcome}${data.usage ? ` · inner agent ${data.usage.turns} turns, ${usd(data.usage.costUsd)}, ${data.ms} ms` : ""}`);
      if (event === "tool_result") add(`outer ← ${data.isError ? "isError: " : ""}${typeof data.content === "string" ? data.content : JSON.stringify(data.content)}`.slice(0, 260));
      if (event === "result") {
        // The lead's last text block IS its final answer: drop it from the log, the result card below shows it once.
        setDelegateLog((all) => all.length && all[all.length - 1] === `outer: ${data.text}` ? all.slice(0, -1) : all);
        setDelegateResult(data);
      }
      if (event === "error") add(`error: ${data.message}`);
    });
  };
  const order = facts?.orders.find((o) => o.id === orderId);

  return <section>
    <h2>61. Exposing your agent as an MCP server</h2>
    <p className="lead">Wrap an Agent SDK agent in an MCP server, and any MCP client can use it as one tool: Claude Code, Claude Desktop, or another agent. The caller sees a typed tool. The agent behind it, with its prompt, its private tools and its data, stays on your side.</p>
    <div className="offline-boundaries">
      <div className="card"><b>One tool, one contract</b><p><code>review_refund</code> with an <code>inputSchema</code>, an <code>outputSchema</code> and annotations. The same zod object feeds the agent's <code>outputFormat</code>, so the agent cannot answer outside the contract.</p></div>
      <div className="card"><b>The agent behind it</b><p>One <code>query()</code> per call: its own system prompt, a private <code>lookup_order</code> tool, <code>maxTurns</code> and <code>maxBudgetUsd</code>, no settings, no other MCP servers, so it cannot call itself.</p></div>
      <div className="card"><b>Two transports</b><p><b>stdio</b>: the client starts your server as a child process. <b>Streamable HTTP</b>: one endpoint, stateless, behind a bearer token and a Host check, answering with SSE so progress streams.</p></div>
      <div className="card"><b>A good citizen</b><p>Progress notifications, cancellation that stops the agent, a deadline, a concurrency cap, a budget, and errors as <code>isError</code> results the caller's model can read.</p></div>
    </div>
    {error && <div className="card warn" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}

    <h3>A · What the caller sees (offline)</h3>
    <p>This is the real <code>tools/list</code> and <code>resources/list</code> of the refund desk, read by an MCP client over an in-memory transport. Nothing here mentions the order database, <code>lookup_order</code> or the inner prompt.</p>
    {desk && <>
      <p className="hint">Server <code>{desk.server.name} {desk.server.version}</code> · instructions: “{desk.instructions}” · resources: {desk.resources.map((r) => <code key={r.uri}>{r.uri}</code>)}</p>
      <details className="card" open><summary>tools/list → review_refund</summary><pre className="wrap" style={{ maxHeight: 360, overflow: "auto" }}>{JSON.stringify(desk.tools[0], null, 2)}</pre></details>
      <p className="hint">The <code>$schema</code> keys come from the MCP SDK and are harmless in <code>tools/list</code> (the support lead in section E connects fine). Only the agent's <code>outputFormat</code> must not have one: Claude Code rejects it there (see the readme).</p>
    </>}
    <details className="card"><summary>Behind the tool: the orders and the inner system prompt (never sent to the caller)</summary>
      <div className="scroll-x"><table className="tools"><thead><tr><th>Order</th><th>Customer</th><th>Item</th><th>Amount</th><th>Days</th><th>Condition</th><th>Policy says</th></tr></thead><tbody>
        {facts?.orders.map((o) => <tr key={o.id}><td><code>{o.id}</code></td><td>{o.customer}</td><td>{o.item}</td><td>{(o.amountCents / 100).toFixed(2)} EUR</td><td>{o.daysSincePurchase}</td><td>{o.condition}</td><td>{o.expected.decision}{o.expected.broken.length > 0 && <span className="hint"> · {o.expected.broken.join(", ")}</span>}</td></tr>)}
      </tbody></table></div>
      <pre className="wrap">{facts?.deskSystemPrompt}</pre>
    </details>

    <h3>B · The contract, call by call (offline)</h3>
    <p>A real MCP client calls the real server. A scripted runner stands in for the agent, so no model runs. Every row is what a caller really receives.</p>
    <div className="scroll-x"><table className="tools compare"><thead><tr><th>Scenario</th><th>Caller gets</th><th>Progress</th><th>Server log</th><th>Agent ran</th></tr></thead><tbody>
      {contract.map((row) => <tr key={row.scenario}><td>{row.scenario}<br /><span className="hint"><code>{row.call.slice(0, 90)}</code></span></td>
        <td>{row.thrown ? <><b>throws</b> <span className="hint">{clip(row.thrown, 200)}</span></> : <><b>{row.isError ? "isError" : "ok"}</b> <span className="hint">{clip(row.text, 200)}</span></>}</td>
        <td className="hint">{row.progress.join(" → ") || "–"}</td><td className="hint">{row.serverLog}</td><td>{row.agentRan ? "yes" : <b>no</b>}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Unknown orders, the concurrency cap ({facts?.limits.maxConcurrent}) and the budget (${facts?.limits.serverBudgetUsd.toFixed(2)} per process) are checked before the agent starts, so a refusal costs nothing. Schema failures come back as <code>isError</code> results too (the MCP SDK converts them), so the caller's model can read the message and fix its call. A cancel from the caller fires the agent's <code>AbortController</code>: the server log says “cancelled”, and no agent keeps running unseen.</p>

    <h3>C · Transports and client configuration (offline)</h3>
    <div className="row">
      <button disabled={!!checking} onClick={() => check("stdio")}>{checking === "stdio" ? "Starting…" : "Check stdio"}</button>
      <button disabled={!!checking} onClick={() => check("http")}>{checking === "http" ? "Checking…" : "Check Streamable HTTP"}</button>
    </div>
    {checks.stdio && <div className="card"><b>stdio {checks.stdio.ok ? "✓" : "✗"}</b>
      <p className="hint">Started <code>{checks.stdio.command}</code> from <code>{checks.stdio.cwd}</code> with <code>REFUND_DESK_FAKE=1</code>: handshake in {checks.stdio.connectedMs} ms, tools {checks.stdio.tools?.join(", ")}, scripted verdict {checks.stdio.result?.decision} for O-205, progress {checks.stdio.progress?.join(" → ")}. stderr: “{checks.stdio.stderr}”.</p></div>}
    {checks.http && <div className="card"><b>Streamable HTTP ✓</b>
      <p className="hint"><code>{checks.http.url}</code> · no token → <b>{checks.http.noToken}</b> · forged Host → <b>{checks.http.badHost}</b> · GET → <b>{checks.http.get}</b> · with the token: initialize + tools/list → {checks.http.tools?.join(", ")}</p></div>}
    {facts && <>
      <p>Connect a client. The token comes from <code>REFUND_DESK_TOKEN</code> in .env{facts.tokenFromEnv ? " (set)" : ". It is not set, so this server made a random one at startup and outside clients cannot connect"}.</p>
      <details className="card"><summary>Claude Code, over HTTP</summary><pre className="wrap">{facts.config.claudeHttp}</pre></details>
      <details className="card"><summary>Claude Code, over stdio (the client starts the server itself)</summary><pre className="wrap">{facts.config.claudeStdio}</pre></details>
      <details className="card"><summary>.mcp.json (project scope, <code>${"{VAR}"}</code> is expanded from the environment)</summary><pre className="wrap">{facts.config.mcpJson}</pre></details>
      <details className="card"><summary>Another Agent SDK agent</summary><pre className="wrap">{facts.config.agentSdk}</pre></details>
    </>}
    <p className="hint">The per-server <code>timeout</code> is a hard wall-clock limit per call. Progress notifications do not extend it, so give an agent-backed tool more time than a plain one.</p>

    <h3>D · Call the desk live (billed)</h3>
    <div className="card config">
      <label>Order<select value={orderId} disabled={!!busy} onChange={(e) => { setOrderId(e.target.value); setMessage(facts?.sampleMessages[e.target.value] ?? ""); }}>
        {facts?.orders.map((o) => <option key={o.id} value={o.id}>{o.id} · {o.customer} · {o.item}</option>)}
      </select></label>
      <label>Customer message<textarea rows={2} maxLength={500} value={message} disabled={!!busy} onChange={(e) => setMessage(e.target.value)} /></label>
    </div>
    <p className="hint">An MCP client in this server calls <code>review_refund</code> over real HTTP. Behind it, {facts?.model} runs with <code>maxBudgetUsd: {facts?.limits.perCallBudgetUsd}</code>. About $0.005 and 5 s per call. O-206's message tries to talk the desk into an approval. Needs <code>ANTHROPIC_API_KEY</code>{facts && !facts.liveAvailable ? " (not set on this server)" : ""}.</p>
    <div className="row">
      <button className="primary" disabled={!!busy || !facts?.liveAvailable || !message.trim()} onClick={call}>{busy === "call" ? "Reviewing…" : "Call review_refund"}</button>
      {busy && <button onClick={() => abortRef.current?.abort()}>Cancel</button>}
    </div>
    {callLog.length > 0 && <pre className="wrap">{callLog.join("\n")}</pre>}
    {verdict && <div className="card">
      {verdict.structured ? <>
        <b>{verdict.structured.orderId}: {verdict.structured.decision}{verdict.structured.brokenRules.length > 0 && ` · ${verdict.structured.brokenRules.join(", ")}`}</b>
        <span style={{ color: verdict.structured.decision === verdict.expected.decision ? undefined : "#c0392b" }}> (policy: {verdict.expected.decision})</span>
        <p>“{verdict.structured.customerReply}”</p>
      </> : <b>isError: {verdict.text}</b>}
      {verdict.usage && <p className="hint">From <code>_meta["refund-desk/usage"]</code>: the inner agent ran {verdict.usage.turns} turns and cost {usd(verdict.usage.costUsd)}. The caller's own bill does not include it.</p>}
      {order && <p className="hint">Order data the agent looked up: {(order.amountCents / 100).toFixed(2)} EUR, {order.daysSincePurchase} days, {order.condition}.</p>}
    </div>}

    <h3>E · An agent that delegates to your agent (billed)</h3>
    <p>An outer <code>query()</code>, the “support lead”, gets the desk as an <code>http</code> MCP server. Its only tool is <code>mcp__refund-desk__review_refund</code>. Two agents, two bills, one protocol between them.</p>
    <div className="card config">
      {facts?.orders.map((o) => <label key={o.id}><input type="checkbox" disabled={!!busy} checked={picked.includes(o.id)} onChange={(e) => setPicked((all) => e.target.checked ? [...all, o.id].slice(0, 4) : all.filter((id) => id !== o.id))} /> {o.id}</label>)}
    </div>
    <p className="hint">Up to 4 requests. With 3 or more, the lead may call in parallel and run into the concurrency cap of {facts?.limits.maxConcurrent}. Watch what it does with a <code>busy</code> result. About $0.02 per run.</p>
    <div className="row">
      <button className="primary" disabled={!!busy || !facts?.liveAvailable || picked.length === 0} onClick={delegate}>{busy === "delegate" ? "Delegating…" : "Run the support lead"}</button>
      {busy && <button onClick={() => abortRef.current?.abort()}>Cancel</button>}
    </div>
    {delegateLog.length > 0 && <pre className="wrap" style={{ maxHeight: 420, overflow: "auto" }}>{delegateLog.join("\n")}</pre>}
    {delegateResult && <div className="card">
      <pre className="wrap">{delegateResult.text}</pre>
      <p className="hint">Outer agent: {delegateResult.turns} turns, <code>total_cost_usd</code> {usd(delegateResult.outerUsd)}. Inner agents: {delegateResult.innerCalls} desk calls, {usd(delegateResult.innerUsd)}. Real total {usd(delegateResult.outerUsd + delegateResult.innerUsd)}. The outer number alone misses {Math.round(100 * delegateResult.innerUsd / Math.max(1e-9, delegateResult.outerUsd + delegateResult.innerUsd))}% of it.</p>
    </div>}

    <h3>F · The server's view</h3>
    <div className="row"><button disabled={!!busy || refreshing} onClick={refreshLog}>{refreshing ? "Refreshing…" : "Refresh"}</button>{serverLog && <span className="hint">Spent by this process: {usd(serverLog.spentUsd)} of ${facts?.limits.serverBudgetUsd.toFixed(2)} · {serverLog.calls.length} calls · updated {new Date(logAt).toLocaleTimeString()}. Calls from outside clients (Claude Code over HTTP) show up here too.</span>}</div>
    {serverLog && serverLog.calls.length > 0 && <div className="scroll-x"><table className="tools"><thead><tr><th>When</th><th>Transport</th><th>Caller</th><th>Order</th><th>Outcome</th><th>Inner agent</th><th>ms</th></tr></thead><tbody>
      {[...serverLog.calls].sort((a, b) => b.at - a.at).map((c, i) => <tr key={i}><td>{new Date(c.at).toLocaleTimeString()}</td><td>{c.transport}</td><td>{c.caller}</td><td><code>{c.orderId}</code></td><td>{c.isError ? <b>{c.outcome}</b> : c.outcome}</td><td className="hint">{c.usage ? `${c.usage.turns} turns · ${usd(c.usage.costUsd)}` : "–"}</td><td>{c.ms}</td></tr>)}
    </tbody></table></div>}

    <h3>G · Apply it to your agent</h3>
    <ol className="steps">
      <li>Expose a task, not your internals. Give it one tool with a clear name, a description that says what it costs in time and side effects, an <code>inputSchema</code>, an <code>outputSchema</code> and honest annotations.</li>
      <li>Generate the agent's <code>outputFormat</code> from the same schema as the tool's <code>outputSchema</code>, and validate again before you answer.</li>
      <li>Isolate the inner agent: <code>settingSources: []</code>, <code>strictMcpConfig</code>, only its own tools, <code>maxTurns</code>, <code>maxBudgetUsd</code>, and no inherited <code>CLAUDE*</code> environment. It must not be able to reach your own server.</li>
      <li>Return every failure as an <code>isError</code> result with a message a model can act on. Never return a stack trace.</li>
      <li>Check cheap things first (unknown ids, concurrency, budget) so a refusal spends no tokens.</li>
      <li>Send progress when the caller sends a <code>progressToken</code>. Wire <code>extra.signal</code> to the agent's <code>AbortController</code>, and add a deadline of your own.</li>
      <li>Over stdio, keep stdout for the protocol and log to stderr. Over HTTP, require a token, check Host, and keep limits in shared state, because stateless servers are built per request.</li>
      <li>Report the inner cost (here in <code>_meta</code>) and bill it. The caller's <code>total_cost_usd</code> does not include it.</li>
    </ol>

    <h3>H · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://modelcontextprotocol.io/specification/2025-06-18/server/tools" target="_blank" rel="noreferrer">MCP tools</a>, <a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/transports" target="_blank" rel="noreferrer">MCP transports</a>, <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">Claude Code MCP</a>, <a href="https://code.claude.com/docs/en/agent-sdk/mcp" target="_blank" rel="noreferrer">Agent SDK MCP</a>. Builds on lessons 5 (custom tools), 10 (structured output), 13 (MCP servers), 43 (remote MCP) and 47 (multi-agent).</p>
  </section>;
}
