import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const serverNames = ["tasks", "clock"];
const builtInTools = ["Read", "Write", "Bash"];

type Form = {
  prompt: string;
  servers: string[];
  tools: string[]; // built-in tools
  allowedTools: string; // comma separated, e.g. mcp__tasks, mcp__clock__now
};

type ToolInfo = { name: string; description: string; annotations?: Record<string, unknown>; inputSchema: unknown };
type HandlerCall = { server: string; toolName: string; args: unknown; result: { content: { type: string; text?: string }[]; isError?: boolean } };

// Each scenario shows one thing about custom tools.
const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · Something the model can't know",
    hint: "The model has no clock. mcp__clock__now is a function in the server process: watch the \"handler ran\" card.",
    form: { prompt: "What time is it now in Madrid?", servers: ["clock"], tools: [], allowedTools: "mcp__clock" },
  },
  {
    label: "2 · Allow one tool",
    hint: "Both servers are attached (see system/init → tools), but only mcp__tasks__list_tasks is in allowedTools. That is all this question needs.",
    form: { prompt: "Which tasks are still open?", servers: ["tasks", "clock"], tools: [], allowedTools: "mcp__tasks__list_tasks" },
  },
  {
    label: "3 · Tools that change data",
    hint: "\"mcp__tasks\" allows every tool of the server. The handlers write sandbox/data/tasks.json with YOUR code, not the Write tool.",
    form: { prompt: "Add a task called \"Write custom tools\", then mark task 3 as done, then list all tasks.", servers: ["tasks"], tools: [], allowedTools: "mcp__tasks" },
  },
  {
    label: "4 · Handler returns isError",
    hint: "There is no task 99. The handler returns { isError: true } with a message, and the model explains it instead of pretending it worked.",
    form: { prompt: "Mark task 99 as done.", servers: ["tasks"], tools: [], allowedTools: "mcp__tasks" },
  },
  {
    label: "5 · zod rejects the input",
    hint: "add_task requires a title of 3 to 60 characters. The SDK checks the zod schema first, so the handler never runs (no \"handler ran\" entry).",
    form: { prompt: "Call add_task with the title \"x\" exactly as written, do not change it. If it fails, tell me the exact error message.", servers: ["tasks"], tools: [], allowedTools: "mcp__tasks" },
  },
  {
    label: "6 · Not in allowedTools",
    hint: "Custom tools use the same permission check as built-in ones. readOnlyHint does not skip it: with no allow rule (and no canUseTool) the call is denied.",
    form: { prompt: "What time is it now in Madrid?", servers: ["clock"], tools: [], allowedTools: "" },
  },
  {
    label: "7 · Server not attached",
    hint: "The tasks server is not in mcpServers, so its tools don't exist. Allowing them is not enough: allowedTools never adds tools.",
    form: { prompt: "Which tasks are still open?", servers: ["clock"], tools: [], allowedTools: "mcp__clock, mcp__tasks" },
  },
  {
    label: "8 · Built-in + custom",
    hint: "Read (built-in, read-only) and add_task (custom) in the same run. The model picks whatever tool fits each step.",
    form: { prompt: "Read notes.txt and add one task for every line that starts with TODO.", servers: ["tasks"], tools: ["Read"], allowedTools: "mcp__tasks__add_task" },
  },
];

export function Concept05CustomTools() {
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [catalog, setCatalog] = useState<{ server: string; tools: ToolInfo[] }[]>([]);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [handlerCalls, setHandlerCalls] = useState<HandlerCall[]>([]);
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [tasksJson, setTasksJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: "servers" | "tools", value: string) =>
    set({ [key]: form[key].includes(value) ? form[key].filter((v) => v !== value) : [...form[key], value] });

  // The sandbox/ folder and its routes come from Concept 3; the tasks server edits sandbox/data/tasks.json.
  const loadFiles = (method = "GET", url = "/api/c3/files") =>
    fetch(url, { method })
      .then((r) => r.json())
      .then(setFiles)
      .then(() => fetch("/api/c5/tasks"))
      .then((r) => r.text())
      .then(setTasksJson);
  useEffect(() => {
    fetch("/api/c5/tools").then((r) => r.json()).then(setCatalog);
    void loadFiles();
  }, []);

  async function run() {
    setMessages([]);
    setHandlerCalls([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    const body = {
      prompt: form.prompt,
      model: "claude-haiku-4-5-20251001",
      servers: form.servers,
      tools: form.tools,
      allowedTools: form.allowedTools.split(",").map((r) => r.trim()).filter(Boolean),
      permissionMode: "default",
    };
    try {
      await streamPost("/api/c5/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "tool_handler") setHandlerCalls((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
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

  // Pair each tool_use (assistant message) with its tool_result (next user message), as in Concept 3.
  const results = new Map<string, any>();
  for (const m of messages.filter((m) => m.type === "user" && Array.isArray(m.message?.content)))
    for (const b of m.message.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const calls = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ use: b, result: results.get(b.id) }));

  return (
    <section>
      <h2>5 · Custom tools: createSdkMcpServer + tool()</h2>
      <p className="lead">
        Built-in tools are Claude Code's. Custom tools are <b>yours</b>: a function in this Node server, described with a
        zod schema and served by an in-process MCP server. The model sees it as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
      </p>

      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.label} onClick={() => {
              set(s.form);
              setHint(s.hint);
            }} disabled={running}>
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={2} />

      <label>
        <small>
          <code>allowedTools</code> (comma separated: <code>mcp__server</code> for a whole server, <code>mcp__server__tool</code> for one tool)
        </small>
        <input value={form.allowedTools} onChange={(e) => set({ allowedTools: e.target.value })} placeholder="(none)" />
      </label>
      <div className="row">
        <small>
          <code>mcpServers</code>:
        </small>
        {serverNames.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={form.servers.includes(s)} onChange={() => toggle("servers", s)} /> <code>{s}</code>
          </label>
        ))}
        <small>
          built-in <code>tools</code>:
        </small>
        {builtInTools.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={form.tools.includes(t)} onChange={() => toggle("tools", t)} /> <code>{t}</code>
          </label>
        ))}
      </div>

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with mcpServers"}
        </button>
        <button onClick={() => loadFiles("POST", "/api/c3/reset")} disabled={running}>
          Reset sandbox/
        </button>
      </div>

      <details className="card">
        <summary>
          <b>Tool definitions</b> — what the model receives (the zod shape as JSON Schema)
        </summary>
        {catalog.map((s) => (
          <div key={s.server}>
            <h4>
              server <code>{s.server}</code> {!form.servers.includes(s.server) && <span className="subtype">(not attached)</span>}
            </h4>
            {s.tools.map((t) => (
              <div key={t.name} className="tool-call">
                <code>{t.name}</code> — {t.description}
                {t.annotations && <span className="subtype">{JSON.stringify(t.annotations)}</span>}
                <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
              </div>
            ))}
          </div>
        ))}
      </details>

      <div className="card">
        <b>sandbox/data/tasks.json</b> <span className="subtype">{files.length} file(s) in sandbox/</span>
        <pre>{tasksJson}</pre>
      </div>

      {sentOptions && (
        <div className="card">
          <b>options sent to query()</b>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </div>
      )}
      {init && (
        <div className="card">
          <b>system/init</b>
          <div>
            <code>mcp_servers</code>: {init.mcp_servers.length === 0 && <i>none</i>}
            {init.mcp_servers.map((s: any) => (
              <code key={s.name} className="subtype">
                {s.name} ({s.status})
              </code>
            ))}
          </div>
          <div>
            <code>tools</code>: {init.tools.map((t: string) => <code key={t} className="subtype">{t}</code>)}
          </div>
        </div>
      )}
      {calls.length > 0 && (
        <div className="card">
          <b>Tool calls ({calls.length})</b>
          {calls.map(({ use, result }) => (
            <div key={use.id} className={`tool-call ${result?.is_error ? "denied" : ""}`}>
              <div>
                <span className="tag tag-assistant">tool_use</span> <code>{use.name}</code>{" "}
                <code className="subtype">{JSON.stringify(use.input)}</code>
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
      )}
      {(calls.length > 0 || handlerCalls.length > 0) && (
        <div className="card">
          <b>Handler ran in the server ({handlerCalls.length})</b>
          {handlerCalls.length === 0 && <div className="hint">None of your handlers ran in this run.</div>}
          {handlerCalls.map((h, i) => (
            <div key={i} className={`tool-call ${h.result.isError ? "denied" : ""}`}>
              <div>
                <span className="tag tag-system">{h.server}</span> <code>{h.toolName}</code>(
                <code className="subtype">{JSON.stringify(h.args)}</code>)
              </div>
              <div>
                <span className={`tag ${h.result.isError ? "tag-error" : "tag-user"}`}>{h.result.isError ? "isError: true" : "returned"}</span>{" "}
                <span className="snippet">{toText(h.result.content)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {text && <div className="card answer">{text}</div>}
      {result && (
        <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)}
          {result.permission_denials?.length > 0 && (
            <div>
              <b>permission_denials</b>:{" "}
              {result.permission_denials.map((d: any) => (
                <code key={d.tool_use_id}>{d.tool_name} </code>
              ))}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
        </div>
      )}

      <MessageLog messages={messages} />
    </section>
  );
}

/** A tool result's content is a string or a list of content blocks; show the text parts. */
function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return JSON.stringify(content);
}
