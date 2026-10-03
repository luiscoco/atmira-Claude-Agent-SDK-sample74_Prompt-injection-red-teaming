import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type ServerName = "notes" | "inventory" | "clock" | "broken";
type Token = "right" | "wrong" | "none";

// The four servers of this concept, and the transport each one uses.
const servers: { name: ServerName; type: string; what: string }[] = [
  { name: "notes", type: "stdio", what: "mcp-servers/notes-server.ts, started by Claude Code as a child process" },
  { name: "inventory", type: "http", what: "/api/c13/mcp on this lab server, needs a bearer token" },
  { name: "clock", type: "sdk", what: "in-process, as in Concept 5 (for comparison)" },
  { name: "broken", type: "stdio", what: "a command that does not exist" },
];

type Form = { prompt: string; servers: ServerName[]; allowedTools: string; token: Token };
type McpLog = { server: string; transport: string; method: string; pid?: number; status?: number; detail?: unknown };

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · stdio: a child process",
    hint: "Claude Code starts notes-server.ts with `command` + `args`, and passes NOTES_DIR through `env`. server_process shows its own pid: a different process from this server.",
    form: { prompt: "Which notes mention TODO? Then call server_process and tell me its pid and parent pid.", servers: ["notes"], allowedTools: "mcp__notes", token: "right" },
  },
  {
    label: "2 · http: a running server",
    hint: "Nothing is started: Claude Code connects to the URL. Watch the handshake the server sees: initialize → notifications/initialized → tools/list, then tools/call.",
    form: { prompt: "How many 27-inch monitors are in stock?", servers: ["inventory"], allowedTools: "mcp__inventory", token: "right" },
  },
  {
    label: "3 · Wrong token",
    hint: "The server answers 401. The server is `failed`, its tools don't exist, and the run still succeeds: the model just answers without them. Check mcp_servers yourself.",
    form: { prompt: "How many 27-inch monitors are in stock? If you have no inventory tool, say so in one line.", servers: ["inventory"], allowedTools: "mcp__inventory", token: "wrong" },
  },
  {
    label: "4 · A server that can't start",
    hint: "`broken` points to a command that doesn't exist. It is `failed` in system/init, and the other server works normally.",
    form: { prompt: "List the note files.", servers: ["notes", "broken"], allowedTools: "mcp__notes", token: "right" },
  },
  {
    label: "5 · Allow one tool",
    hint: "External tools use the same permission check as built-in and custom tools. Only list_products is allowed, so reserve is denied and the stock does not change.",
    form: { prompt: "Reserve 2 units of MN-27.", servers: ["inventory"], allowedTools: "mcp__inventory__list_products", token: "right" },
  },
  {
    label: "6 · All transports together",
    hint: "stdio, http and sdk in one query(). For the model they are all just mcp__<server>__<tool> tools. Look at `source` in mcp_servers: dynamic vs sdk.",
    form: { prompt: "Which notes mention TODO? How many 27-inch monitors are in stock? What time is it?", servers: ["notes", "inventory", "clock", "broken"], allowedTools: "mcp__notes, mcp__inventory, mcp__clock", token: "right" },
  },
];

export function Concept13McpServers() {
  return (
    <section>
      <h2>13 · External MCP servers: stdio, http, and managing them at run time</h2>
      <p className="lead">
        Concept 5 served tools from <b>inside</b> this Node process (<code>type: "sdk"</code>). An external MCP server is
        a <b>separate program</b>: Claude Code starts it (<code>stdio</code>) or connects to it (<code>http</code>), and
        talks MCP with it. The model can't tell the difference: every tool is <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
      </p>
      <OneQuery />
      <hr />
      <LiveServers />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A
// ---------------------------------------------------------------------------------------------

function OneQuery() {
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [logs, setLogs] = useState<McpLog[]>([]);
  const [stock, setStock] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (name: ServerName) => set({ servers: form.servers.includes(name) ? form.servers.filter((s) => s !== name) : [...form.servers, name] });
  const loadStock = (method = "GET", url = "/api/c13/stock") => fetch(url, { method }).then((r) => r.json()).then(setStock);
  useEffect(() => void loadStock(), []);

  async function run() {
    setMessages([]);
    setLogs([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    const body = { ...form, allowedTools: form.allowedTools.split(",").map((r) => r.trim()).filter(Boolean) };
    try {
      await streamPost("/api/c13/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "mcp_log") setLogs((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadStock();
    }
  }

  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  const calls = toolCalls(messages);

  return (
    <>
      <h3>A · One query() with external servers</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.label} onClick={() => (set(s.form), setHint(s.hint))} disabled={running}>
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={2} />
      <label>
        <small>
          <code>allowedTools</code> (comma separated: <code>mcp__server</code> or <code>mcp__server__tool</code>)
        </small>
        <input value={form.allowedTools} onChange={(e) => set({ allowedTools: e.target.value })} placeholder="(none)" />
      </label>
      <table className="tools">
        <thead>
          <tr>
            <th>mcpServers</th>
            <th>type</th>
            <th>what it is</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <tr key={s.name}>
              <td>
                <label className="check">
                  <input type="checkbox" checked={form.servers.includes(s.name)} onChange={() => toggle(s.name)} /> <code>{s.name}</code>
                </label>
              </td>
              <td>
                <span className={`tag tag-mcp-${s.type}`}>{s.type}</span>
              </td>
              <td>
                {s.what}
                {s.name === "inventory" && (
                  <select value={form.token} onChange={(e) => set({ token: e.target.value as Token })} className="inline">
                    <option value="right">headers: right token</option>
                    <option value="wrong">headers: wrong token</option>
                    <option value="none">no headers</option>
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with mcpServers"}
        </button>
        <button onClick={() => loadStock("POST", "/api/c13/stock/reset")} disabled={running}>
          Reset stock
        </button>
      </div>

      <div className="card">
        <b>Inventory stock</b> <span className="subtype">lives in the lab server: the http MCP server is YOUR process</span>
        <div>
          {stock.map((p) => (
            <code key={p.sku} className="subtype">
              {p.sku} {p.name}: {p.qty}
            </code>
          ))}
        </div>
      </div>

      {sentOptions && (
        <details className="card" open>
          <summary>
            <b>options.mcpServers sent to query()</b>
          </summary>
          <pre>{JSON.stringify(sentOptions.mcpServers, null, 2)}</pre>
        </details>
      )}
      {init && <InitCard init={init} />}
      {logs.length > 0 && (
        <div className="card">
          <b>What the MCP servers saw ({logs.length})</b>
          <span className="subtype">logged by the servers themselves, not by query()</span>
          {logs.map((l, i) => (
            <LogLine key={i} log={l} />
          ))}
        </div>
      )}
      {calls.length > 0 && <ToolCalls calls={calls} />}
      {text && <div className="card answer">{text}</div>}
      {result && <ResultCard result={result} />}
      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
        </div>
      )}
      <MessageLog messages={messages} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B
// ---------------------------------------------------------------------------------------------

type Status = { name: string; status: string; source?: string; error?: string; serverInfo?: { name: string; version: string }; tools?: { name: string }[]; config?: { type?: string } };
type Item = { kind: "control" | "mcp_log" | "message"; data: any };

const presets = [
  "List the products and their stock. One line.",
  "Call server_process and tell me the pid and uptimeMs only.",
  "What time is it?",
  "Which tools do you have right now? Just the names.",
];

function LiveServers() {
  const [startWith, setStartWith] = useState<ServerName[]>(["notes", "inventory", "broken"]);
  const [nextSet, setNextSet] = useState<ServerName[]>(["notes", "clock"]);
  const [id, setId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [text, setText] = useState(presets[0]);
  const [busy, setBusy] = useState(false); // a turn is running
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);

  const push = (item: Item) => setItems((prev) => [...prev, item]);

  async function start() {
    setItems([]);
    setStatuses([]);
    setError(null);
    try {
      await streamPost("/api/c13/session", { servers: startWith }, (event, data) => {
        if (event === "session") {
          idRef.current = data.id;
          setId(data.id);
          void control("status");
        }
        if (event === "control") push({ kind: "control", data });
        if (event === "mcp_log") push({ kind: "mcp_log", data });
        if (event === "message") {
          if (data.type === "result") setBusy(false);
          if (data.type !== "system" || data.subtype !== "thinking_tokens") push({ kind: "message", data });
        }
        if (event === "error") setError(data.message);
      });
    } finally {
      idRef.current = null;
      setId(null);
      setBusy(false);
    }
  }

  async function control(route: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`/api/c13/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: idRef.current, ...body }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setError(null);
    if (route === "status" && json.result) setStatuses(json.result);
    // Every change is followed by a fresh status, so the table always matches the session.
    else if (route !== "send" && route !== "end") void control("status");
    return json;
  }

  const send = () => {
    setBusy(true);
    void control("send", { text });
  };
  const toggleNext = (name: ServerName) => setNextSet((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));

  return (
    <>
      <h3>B · Managing MCP servers while a session runs</h3>
      <p className="hint">
        A streaming-input session (Concept 12) lives long enough to change its servers: <code>q.mcpServerStatus()</code>,{" "}
        <code>q.toggleMcpServer()</code>, <code>q.reconnectMcpServer()</code> and <code>q.setMcpServers()</code>. Each change applies from the next turn: its{" "}
        <code>system/init</code> lists the new tools.
      </p>

      {!id ? (
        <div className="row">
          <small>start with:</small>
          {servers.map((s) => (
            <label key={s.name} className="check">
              <input type="checkbox" checked={startWith.includes(s.name)} onChange={() => setStartWith((v) => (v.includes(s.name) ? v.filter((n) => n !== s.name) : [...v, s.name]))} />{" "}
              <code>{s.name}</code>
            </label>
          ))}
          <button className="primary" onClick={start}>
            Start session
          </button>
        </div>
      ) : (
        <>
          <div className="scenarios">
            {presets.map((p) => (
              <button key={p} onClick={() => setText(p)}>
                {p}
              </button>
            ))}
          </div>
          <div className="row">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} style={{ flex: 1, marginBottom: 0 }} />
            <button className="primary" onClick={send}>
              {busy ? "Send (busy: it will wait)" : "Send"}
            </button>
            <button onClick={() => control("status")}>await q.mcpServerStatus()</button>
            <button onClick={() => control("end")}>End session</button>
          </div>

          <div className="card">
            <b>q.mcpServerStatus()</b>
            <table className="tools">
              <thead>
                <tr>
                  <th>name</th>
                  <th>status</th>
                  <th>source / type</th>
                  <th>serverInfo · tools · error</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {statuses.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <code>{s.name}</code>
                    </td>
                    <td>
                      <span className={`tag st-${s.status}`}>{s.status}</span>
                    </td>
                    <td>
                      <code>{s.source}</code> <code className="subtype">{s.config?.type ?? (s.source === "sdk" ? "sdk" : "")}</code>
                    </td>
                    <td>
                      {s.serverInfo && <code>{s.serverInfo.name}@{s.serverInfo.version}</code>}{" "}
                      {s.tools?.map((t) => (
                        <code key={t.name} className="subtype">
                          {t.name}
                        </code>
                      ))}
                      {s.error && <code className="snippet"> {s.error}</code>}
                    </td>
                    <td>
                      <div className="row" style={{ marginBottom: 0 }}>
                        <button onClick={() => control("toggle", { name: s.name, enabled: s.status === "disabled" })}>
                          toggle({s.status === "disabled" ? "true" : "false"})
                        </button>
                        <button onClick={() => control("reconnect", { name: s.name })}>reconnect</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <small>
                <code>q.setMcpServers(&#123;</code>
              </small>
              {servers.map((s) => (
                <label key={s.name} className="check">
                  <input type="checkbox" checked={nextSet.includes(s.name)} onChange={() => toggleNext(s.name)} /> <code>{s.name}</code>
                </label>
              ))}
              <small>
                <code>&#125;)</code>
              </small>
              <button onClick={() => control("set-servers", { servers: nextSet })}>Apply</button>
            </div>
          </div>
        </>
      )}
      {error && (
        <div className="card warn">
          <code>{error}</code>
        </div>
      )}
      {items.length > 0 && <Timeline items={items} />}
    </>
  );
}

function Timeline({ items }: { items: Item[] }) {
  return (
    <div className="card">
      <b>Session timeline</b>
      {items.map((it, i) => {
        if (it.kind === "control")
          return (
            <div key={i} className={`delegation ${it.data.error ? "warn" : ""}`}>
              <span className="tag tag-system">control</span> <code>{it.data.method}</code> <span className="subtype">{it.data.ms} ms</span>
              {it.data.error && <code className="snippet"> → {it.data.error}</code>}
              {it.data.result && it.data.method.startsWith("q.setMcpServers") && <code className="snippet"> → {JSON.stringify(it.data.result)}</code>}
            </div>
          );
        if (it.kind === "mcp_log") return <LogLine key={i} log={it.data} />;
        const m = it.data;
        if (m.type === "system" && m.subtype === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span>{" "}
              {m.mcp_servers.map((s: any) => (
                <span key={s.name} className={`tag st-${s.status}`} style={{ marginRight: 4 }}>
                  {s.name}: {s.status}
                </span>
              ))}
              <div className="subtype">tools: {m.tools.join(", ") || "(none)"}</div>
            </div>
          );
        if (m.type === "assistant")
          return m.message.content.map((b: any, j: number) =>
            b.type === "text" ? (
              <div key={`${i}-${j}`} className="tool-call">
                <span className="tag tag-assistant">assistant</span> {b.text}
              </div>
            ) : b.type === "tool_use" ? (
              <div key={`${i}-${j}`} className="tool-call">
                <span className="tag tag-assistant">tool_use</span> <code>{b.name}</code> <code className="subtype">{JSON.stringify(b.input)}</code>
              </div>
            ) : null,
          );
        if (m.type === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result/{m.subtype}</span> <span className="subtype">session total ${m.total_cost_usd?.toFixed(4)}</span>
            </div>
          );
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared cards
// ---------------------------------------------------------------------------------------------

function InitCard({ init }: { init: any }) {
  return (
    <div className="card">
      <b>system/init</b>
      <div>
        <code>mcp_servers</code>:{" "}
        {init.mcp_servers.map((s: any) => (
          <span key={s.name} className={`tag st-${s.status}`} style={{ marginRight: 6 }}>
            {s.name}: {s.status} · {s.source}
          </span>
        ))}
      </div>
      <div>
        <code>tools</code>: {init.tools.length === 0 && <i>none</i>}
        {init.tools.map((t: string) => (
          <code key={t} className="subtype">
            {t}
          </code>
        ))}
      </div>
    </div>
  );
}

function LogLine({ log }: { log: McpLog }) {
  return (
    <div className="tool-call">
      <span className={`tag tag-mcp-${log.transport}`}>{log.server}</span> <code>{log.method}</code>
      {log.pid && <span className="subtype">pid {log.pid}</span>}
      {log.status && <span className={`subtype ${log.status >= 400 ? "bad" : ""}`}>HTTP {log.status}</span>}
      {log.detail !== undefined && Object.keys(log.detail as object).length > 0 && <code className="subtype">{JSON.stringify(log.detail)}</code>}
    </div>
  );
}

function ToolCalls({ calls }: { calls: { use: any; result: any }[] }) {
  return (
    <div className="card">
      <b>Tool calls ({calls.length})</b>
      {calls.map(({ use, result }) => (
        <div key={use.id} className={`tool-call ${result?.is_error ? "denied" : ""}`}>
          <div>
            <span className="tag tag-assistant">tool_use</span> <code>{use.name}</code> <code className="subtype">{JSON.stringify(use.input)}</code>
          </div>
          {result && (
            <div>
              <span className={`tag ${result.is_error ? "tag-error" : "tag-user"}`}>{result.is_error ? "is_error" : "tool_result"}</span>{" "}
              <span className="snippet">{toText(result.content)}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ResultCard({ result }: { result: any }) {
  return (
    <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
      <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · ${result.total_cost_usd.toFixed(4)}
      {result.permission_denials?.length > 0 && (
        <div>
          <b>permission_denials</b>:{" "}
          {result.permission_denials.map((d: any) => (
            <code key={d.tool_use_id}>{d.tool_name} </code>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pair each tool_use (assistant message) with its tool_result (next user message), as in Concepts 3 and 5. */
function toolCalls(messages: any[]) {
  const results = new Map<string, any>();
  for (const m of messages.filter((m) => m.type === "user" && Array.isArray(m.message?.content)))
    for (const b of m.message.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  return messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ use: b, result: results.get(b.id) }));
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return JSON.stringify(content);
}
