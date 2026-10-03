import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const builtInTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "TodoWrite"];
const permissionModes = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

type Form = {
  prompt: string;
  toolsMode: "list" | "preset";
  tools: string[];
  allowedTools: string[];
  rules: string; // extra allowedTools entries with a pattern, e.g. Bash(ls:*)
  permissionMode: string;
  cwd: "sandbox" | "project";
  maxTurns: string;
};

const WRITE_PROMPT = "Read notes.txt and create summary.md with a 3-bullet summary of it.";

// Each scenario changes one thing, so you can compare the runs side by side.
const scenarios: { label: string; hint: string; form: Partial<Form> }[] = [
  {
    label: "1 · Read-only",
    hint: "Read, Glob and Grep are read-only, so they run without asking.",
    form: { prompt: "Which files are in this folder? Summarize notes.txt in one sentence.", tools: ["Read", "Glob", "Grep"], allowedTools: [], rules: "", permissionMode: "", maxTurns: "" },
  },
  {
    label: "2 · Write, denied",
    hint: "Write needs permission. With no canUseTool, 'ask' means deny: see result.permission_denials.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: [], rules: "", permissionMode: "default", maxTurns: "" },
  },
  {
    label: "3 · Write + allowedTools",
    hint: "Same run, but Write is pre-approved in allowedTools.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: ["Write"], rules: "", permissionMode: "default", maxTurns: "" },
  },
  {
    label: "4 · acceptEdits",
    hint: "No allowedTools, but permissionMode acceptEdits approves file edits.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: [], rules: "", permissionMode: "acceptEdits", maxTurns: "" },
  },
  {
    label: "5 · plan",
    hint: "Plan mode reads but doesn't change sandbox/, even with Write allowed. Its only write is the plan file in ~/.claude/plans/.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: ["Write"], rules: "", permissionMode: "plan", maxTurns: "" },
  },
  {
    label: "6 · Bash rule + dontAsk",
    hint: "Only commands matching Bash(ls:*) are pre-approved; dontAsk denies the rest.",
    form: { prompt: "Run `ls -la`, then run `touch hello.txt`. Report what happened with each command.", tools: ["Bash"], allowedTools: [], rules: "Bash(ls:*)", permissionMode: "dontAsk", maxTurns: "" },
  },
  {
    label: "7 · maxTurns: 2",
    hint: "Each tool call costs a turn, so now maxTurns (Concept 2) can actually stop the run.",
    form: { prompt: "Read every file in this folder, one by one, then summarize them all.", tools: ["Read", "Glob"], allowedTools: [], rules: "", permissionMode: "", maxTurns: "2" },
  },
];

export function Concept03Tools() {
  const [form, setForm] = useState<Form>({ toolsMode: "list", cwd: "sandbox", ...scenarios[0].form } as Form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (list: "tools" | "allowedTools", tool: string) =>
    set({ [list]: form[list].includes(tool) ? form[list].filter((t) => t !== tool) : [...form[list], tool] });

  const loadFiles = (method = "GET", url = "/api/c3/files") =>
    fetch(url, { method }).then((r) => r.json()).then(setFiles);
  useEffect(() => void loadFiles(), []);

  async function run() {
    setMessages([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    const rules = form.rules.split(",").map((r) => r.trim()).filter(Boolean);
    const body = {
      prompt: form.prompt,
      model: "claude-haiku-4-5-20251001", // fast and cheap: tool runs take several turns
      toolsMode: form.toolsMode,
      tools: form.tools,
      allowedTools: [...form.allowedTools, ...rules],
      permissionMode: form.permissionMode || undefined,
      cwd: form.cwd,
      maxTurns: Number(form.maxTurns) || undefined,
    };
    try {
      await streamPost("/api/c3/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
    }
  }

  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");

  // tool_use blocks come in assistant messages; the matching tool_result arrives in the next user message.
  const toolResults = new Map<string, any>(
    messages
      .filter((m) => m.type === "user" && Array.isArray(m.message.content))
      .flatMap((m) => m.message.content)
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => [b.tool_use_id, b]),
  );
  const toolCalls = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ ...b, result: toolResults.get(b.id) }));
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return (
    <section>
      <h2>3 · Built-in tools</h2>
      <p className="lead">
        <code>tools</code> decides which tools <b>exist</b>, <code>allowedTools</code> which ones run <b>without asking</b>,{" "}
        <code>permissionMode</code> what happens to <b>everything else</b>, and <code>cwd</code> <b>where</b> the agent works.
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

      <div className="form-grid">
        <label>
          <code>permissionMode</code>
          <select value={form.permissionMode} onChange={(e) => set({ permissionMode: e.target.value })}>
            {permissionModes.map((m) => (
              <option key={m} value={m}>
                {m || "(omit: default)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <code>cwd</code>
          <select value={form.cwd} onChange={(e) => set({ cwd: e.target.value as Form["cwd"] })}>
            <option value="sandbox">sandbox/ (safe playground)</option>
            <option value="project">project root (this app's code)</option>
          </select>
        </label>
        <label>
          <code>maxTurns</code>
          <input type="number" min={1} value={form.maxTurns} onChange={(e) => set({ maxTurns: e.target.value })} placeholder="(omit)" />
        </label>
        <label>
          <code>tools</code>
          <select value={form.toolsMode} onChange={(e) => set({ toolsMode: e.target.value as Form["toolsMode"] })}>
            <option value="list">string[]: only the ticked tools</option>
            <option value="preset">preset "claude_code": all of them</option>
          </select>
        </label>
      </div>

      <table className="tools">
        <thead>
          <tr>
            <th>Tool</th>
            <th>
              in <code>tools</code>
            </th>
            <th>
              in <code>allowedTools</code>
            </th>
          </tr>
        </thead>
        <tbody>
          {builtInTools.map((t) => (
            <tr key={t}>
              <td>
                <code>{t}</code>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={form.toolsMode === "preset" || form.tools.includes(t)}
                  disabled={form.toolsMode === "preset"}
                  onChange={() => toggle("tools", t)}
                />
              </td>
              <td>
                <input type="checkbox" checked={form.allowedTools.includes(t)} onChange={() => toggle("allowedTools", t)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        <small>
          Extra <code>allowedTools</code> rules (comma separated), e.g. <code>Bash(ls:*)</code>
        </small>
        <input value={form.rules} onChange={(e) => set({ rules: e.target.value })} placeholder="(none)" />
      </label>
      {form.permissionMode === "bypassPermissions" && (
        <div className="card warn">
          <b>bypassPermissions</b> approves every call, including any Bash command, and <code>cwd</code> does not jail Bash.
          The server also sets <code>allowDangerouslySkipPermissions: true</code>, which the SDK requires for this mode.
        </div>
      )}

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with tools"}
        </button>
        <button onClick={() => loadFiles("POST", "/api/c3/reset")} disabled={running}>
          Reset sandbox/
        </button>
      </div>

      <div className="card">
        <b>sandbox/ on disk</b>
        <ul className="files">
          {files.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> <span className="subtype">{f.bytes} B</span>
            </li>
          ))}
        </ul>
      </div>

      {sentOptions && (
        <div className="card">
          <b>options sent to query()</b>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </div>
      )}
      {init && (
        <div className="card">
          <b>system/init</b> — permissionMode <code>{init.permissionMode}</code>, cwd <code>{init.cwd}</code>
          <div>
            tools ({init.tools.length}): <code>{init.tools.join(", ") || "(none)"}</code>
          </div>
        </div>
      )}
      {toolCalls.length > 0 && (
        <div className="card">
          <b>Tool calls ({toolCalls.length})</b>
          {toolCalls.map((c) => (
            <div key={c.id} className={`tool-call ${c.result?.is_error ? "denied" : ""}`}>
              <div>
                <span className="tag tag-assistant">tool_use</span> <code>{c.name}</code> <code className="subtype">{JSON.stringify(c.input)}</code>
              </div>
              <div>
                <span className={`tag ${c.result?.is_error ? "tag-error" : "tag-user"}`}>tool_result</span>{" "}
                {c.result ? <span className="snippet">{resultText(c.result)}</span> : <i>(no result)</i>}
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
          {result.subtype === "error_max_turns" && <div>The run stopped because it reached <code>maxTurns</code>.</div>}
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

/** tool_result content is either a string or an array of content blocks. */
function resultText(block: any): string {
  const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c: any) => c.text ?? "").join("");
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}
