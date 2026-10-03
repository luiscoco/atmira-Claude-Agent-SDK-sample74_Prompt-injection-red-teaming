import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const builtInTools = ["Read", "Glob", "Write", "Edit", "Bash"];

type HookName = "audit" | "guard" | "stamp" | "lint" | "limit";

// Must match the hooks registered in server/concepts/07-hooks.ts.
const hookInfo: { name: HookName; where: string; does: string }[] = [
  { name: "audit", where: "PreToolUse + PostToolUse, every tool", does: "only observes: returns {}" },
  { name: "guard", where: "PreToolUse, matcher Write|Edit|Bash", does: "permissionDecision allow / deny" },
  { name: "stamp", where: "PreToolUse, matcher Write", does: "updatedInput: adds a header to .md files" },
  { name: "lint", where: "PostToolUse, matcher Write", does: "additionalContext: asks for a Source: line" },
  { name: "limit", where: "PreToolUse, every tool", does: "continue: false + deny after 3 tool calls" },
];

type Form = { prompt: string; tools: string[]; hooks: HookName[] };

type HookCall = { name: HookName; input: any; output: any; at: number };

const WRITE_PROMPT = "Read notes.txt and create summary.md with a 3-bullet summary of it.";

// Each scenario turns on the hooks that show one idea.
const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · No hooks",
    hint: "The baseline from Concept 3: Write needs permission, and with no canUseTool nor hooks it is denied.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], hooks: [] },
  },
  {
    label: "2 · Observe everything",
    hint: "audit sees every call, even read-only ones that canUseTool is never asked about. PostToolUse also gets tool_response and duration_ms.",
    form: { prompt: "Which files are in this folder? Summarize notes.txt in one sentence.", tools: ["Read", "Glob"], hooks: ["audit"] },
  },
  {
    label: "3 · Guard allows",
    hint: "The same prompt as scenario 1, but guard answers permissionDecision: \"allow\", so Write runs without canUseTool.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], hooks: ["audit", "guard"] },
  },
  {
    label: "4 · Guard denies",
    hint: "guard denies a file outside sandbox/ and a command that deletes. The model reads permissionDecisionReason in the tool result.",
    form: { prompt: "Do these three things and report what happened with each: 1) create ok.txt here, 2) create ../outside.txt, 3) run `rm notes.txt`.", tools: ["Write", "Bash"], hooks: ["audit", "guard"] },
  },
  {
    label: "5 · Rewrite the input",
    hint: "stamp returns updatedInput. When the run ends, open summary.md: the first line was added by the hook, not by the model.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], hooks: ["guard", "stamp"] },
  },
  {
    label: "6 · Feedback after a call",
    hint: "lint (PostToolUse) checks the written file for a \"Source:\" line. It can't undo the Write, but its additionalContext makes the model write the file again. Open summary.md afterwards.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], hooks: ["audit", "guard", "lint"] },
  },
  {
    label: "7 · Stop the run",
    hint: "limit returns continue: false on the 4th tool call, so the run ends: see result.terminal_reason. continue: false alone would still let that call run, so limit also denies it. Only a.txt to c.txt are created.",
    form: { prompt: "Create five files, a.txt to e.txt, each containing its own name. Use one Write call per file.", tools: ["Write"], hooks: ["guard", "limit"] },
  },
];

export function Concept07Hooks() {
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<HookCall[]>([]);
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [opened, setOpened] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  // The sandbox/ folder and its routes come from Concept 3.
  const loadFiles = (method = "GET", url = "/api/c3/files") =>
    fetch(url, { method }).then((r) => r.json()).then(setFiles);
  useEffect(() => void loadFiles(), []);

  async function openFile(path: string) {
    const content = await fetch(`/api/c7/file?path=${encodeURIComponent(path)}`).then((r) => r.text());
    setOpened({ path, content });
  }

  async function run() {
    setMessages([]);
    setCalls([]);
    setSentOptions(null);
    setOpened(null);
    setError(null);
    setRunning(true);
    try {
      await streamPost("/api/c7/query", { ...form, model: "claude-haiku-4-5-20251001", maxTurns: 10 }, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "hook") setCalls((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
    }
  }

  const result = messages.find((m) => m.type === "result");
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return (
    <section>
      <h2>7 · Hooks: PreToolUse / PostToolUse</h2>
      <p className="lead">
        A hook is a function the SDK calls at a fixed point of the agent loop. <code>PreToolUse</code> runs <b>before</b>{" "}
        a tool call (it can allow, deny or rewrite it), <code>PostToolUse</code> runs <b>after</b> it (it can add
        context for the model). Both are set in <code>options.hooks</code>.
      </p>

      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.label} onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }} disabled={running}>
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={2} />

      <table className="tools">
        <thead>
          <tr>
            <th />
            <th>hook</th>
            <th>registered on</th>
            <th>returns</th>
          </tr>
        </thead>
        <tbody>
          {hookInfo.map((h) => (
            <tr key={h.name}>
              <td>
                <input type="checkbox" checked={form.hooks.includes(h.name)} onChange={() => set({ hooks: toggle(form.hooks, h.name) })} />
              </td>
              <td><code>{h.name}</code></td>
              <td>{h.where}</td>
              <td>{h.does}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <small>
          <code>tools</code>:
        </small>
        {builtInTools.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={form.tools.includes(t)} onChange={() => set({ tools: toggle(form.tools, t) })} /> <code>{t}</code>
          </label>
        ))}
      </div>

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with hooks"}
        </button>
        <button onClick={() => loadFiles("POST", "/api/c3/reset")} disabled={running}>
          Reset sandbox/
        </button>
      </div>

      <div className="card">
        <b>sandbox/ on disk</b> <span className="subtype">click a file to see its content</span>
        <ul className="files">
          {files.map((f) => (
            <li key={f.path}>
              <button onClick={() => openFile(f.path)}>{f.path}</button> <span className="subtype">{f.bytes} B</span>
            </li>
          ))}
        </ul>
        {opened && (
          <>
            <small>
              <code>{opened.path}</code>
            </small>
            <pre>{opened.content}</pre>
          </>
        )}
      </div>

      {sentOptions && (
        <div className="card">
          <b>options sent to query()</b>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </div>
      )}
      {calls.length > 0 && (
        <div className="card">
          <b>hook calls ({calls.length})</b>
          {calls.map((c, i) => (
            <HookRow key={i} call={c} />
          ))}
        </div>
      )}
      {text && <div className="card answer">{text}</div>}
      {result && (
        <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)}
          {result.terminal_reason && (
            <div>
              <b>terminal_reason</b>: <code>{result.terminal_reason}</code>
            </div>
          )}
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

/** One hook call: which event, which tool, what it received and what it answered. */
function HookRow({ call }: { call: HookCall }) {
  const { input, output } = call;
  const pre = input.hook_event_name === "PreToolUse";
  const decision = output.hookSpecificOutput?.permissionDecision;
  const stopped = output.continue === false;
  const silent = Object.keys(output).length === 0;
  return (
    <div className={`tool-call ${decision === "deny" || stopped ? "denied" : ""}`}>
      <div>
        <span className={`tag ${pre ? "tag-pre" : "tag-post"}`}>{input.hook_event_name}</span> <code>{call.name}</code> →{" "}
        <code>{input.tool_name}</code> <code className="subtype">{JSON.stringify(input.tool_input)}</code>
        {input.duration_ms !== undefined && <span className="subtype">{input.duration_ms} ms</span>}
      </div>
      <div>
        {decision && <span className={`tag ${decision === "allow" ? "tag-user" : "tag-error"}`}>{decision}</span>}
        {stopped && <span className="tag tag-error">continue: false</span>}{" "}
        <span className="snippet">{silent ? "{}  (no opinion, the call continues)" : JSON.stringify(output)}</span>
      </div>
    </div>
  );
}
