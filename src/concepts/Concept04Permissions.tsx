import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const builtInTools = ["Read", "Glob", "Write", "Edit", "Bash"];
const permissionModes = ["default", "acceptEdits", "dontAsk"];

type Form = {
  prompt: string;
  tools: string[];
  allowedTools: string; // comma separated, e.g. Write, Bash(ls:*)
  permissionMode: string;
  approver: "ui" | "policy";
};

type Request = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: unknown[];
};

type Decision = { id: string; toolName: string; input?: Record<string, unknown>; decision: any; auto?: boolean };

const WRITE_PROMPT = "Read notes.txt and create summary.md with a 3-bullet summary of it.";

// Each scenario shows one way to answer canUseTool.
const scenarios: { label: string; hint: string; form: Partial<Form> }[] = [
  {
    label: "1 · Approve a write",
    hint: "Read is read-only, so it runs without asking. Write would be denied in Concept 3; now it waits for you: press Allow.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: "", permissionMode: "default", approver: "ui" },
  },
  {
    label: "2 · Deny with a message",
    hint: "Type a reason such as \"Name it SUMMARY.txt instead\" and press Deny. The model receives your message and usually tries again.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: "", permissionMode: "default", approver: "ui" },
  },
  {
    label: "3 · Edit the input",
    hint: "Change file_path or content in the JSON, then Allow. That is updatedInput: the tool runs with YOUR input, not the model's.",
    form: { prompt: "Create hello.txt containing the text 'Hello from the agent'.", tools: ["Write"], allowedTools: "", permissionMode: "default", approver: "ui" },
  },
  {
    label: "4 · Always allow",
    hint: "Press \"Allow always (session)\" on the first request. It returns the SDK's suggestions as updatedPermissions (for Write: setMode acceptEdits), so the next writes don't ask.",
    form: { prompt: "Create three files, a.txt, b.txt and c.txt, each containing its own name. Use one Write call per file.", tools: ["Write"], allowedTools: "", permissionMode: "default", approver: "ui" },
  },
  {
    label: "5 · Bash + interrupt",
    hint: "ls matches the Bash(ls:*) rule, so it never reaches canUseTool. Allow the touch, then answer the rm with \"Deny + interrupt\": the whole run stops.",
    form: { prompt: "Run `ls`, then `touch hello.txt`, then `rm notes.txt`. Report what happened with each command.", tools: ["Bash"], allowedTools: "Bash(ls:*)", permissionMode: "default", approver: "ui" },
  },
  {
    label: "6 · Policy in code",
    hint: "No human: the server's policy function allows files inside sandbox/, and denies files outside it and Bash commands that delete.",
    form: { prompt: "Do these three things and report what happened with each: 1) create ok.txt here, 2) create ../outside.txt, 3) run `rm notes.txt`.", tools: ["Write", "Bash"], allowedTools: "", permissionMode: "default", approver: "policy" },
  },
  {
    label: "7 · allowedTools wins",
    hint: "Write is in allowedTools, so it is approved before the callback is consulted. No approval card appears.",
    form: { prompt: WRITE_PROMPT, tools: ["Read", "Write"], allowedTools: "Write", permissionMode: "default", approver: "ui" },
  },
];

export function Concept04Permissions() {
  const [form, setForm] = useState<Form>(scenarios[0].form as Form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (tool: string) =>
    set({ tools: form.tools.includes(tool) ? form.tools.filter((t) => t !== tool) : [...form.tools, tool] });

  // The sandbox/ folder and its routes come from Concept 3.
  const loadFiles = (method = "GET", url = "/api/c3/files") =>
    fetch(url, { method }).then((r) => r.json()).then(setFiles);
  useEffect(() => void loadFiles(), []);

  async function run() {
    setMessages([]);
    setRequests([]);
    setDecisions([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    const body = {
      prompt: form.prompt,
      model: "claude-haiku-4-5-20251001",
      tools: form.tools,
      allowedTools: form.allowedTools.split(",").map((r) => r.trim()).filter(Boolean),
      permissionMode: form.permissionMode,
      approver: form.approver,
    };
    try {
      await streamPost("/api/c4/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "permission_request") setRequests((prev) => [...prev, data]);
        if (event === "permission_decision") setDecisions((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
    }
  }

  const answered = new Set(decisions.map((d) => d.id));
  const open = requests.filter((r) => !answered.has(r.id));
  const result = messages.find((m) => m.type === "result");
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return (
    <section>
      <h2>4 · Permissions: canUseTool</h2>
      <p className="lead">
        In Concept 3, "ask" meant "deny", because nobody was there to answer. <code>canUseTool</code> is that somebody: an
        async function the SDK <b>awaits</b> before running a call that needs permission. Here it waits for <b>you</b>.
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
          <code>canUseTool</code>
          <select value={form.approver} onChange={(e) => set({ approver: e.target.value as Form["approver"] })}>
            <option value="ui">askTheUser: wait for the UI</option>
            <option value="policy">policy: decide in code</option>
          </select>
        </label>
        <label>
          <code>permissionMode</code>
          <select value={form.permissionMode} onChange={(e) => set({ permissionMode: e.target.value })}>
            {permissionModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <code>allowedTools</code> (comma separated)
          <input value={form.allowedTools} onChange={(e) => set({ allowedTools: e.target.value })} placeholder="(none)" />
        </label>
      </div>
      <div className="row">
        <small>
          <code>tools</code>:
        </small>
        {builtInTools.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={form.tools.includes(t)} onChange={() => toggle(t)} /> <code>{t}</code>
          </label>
        ))}
      </div>

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with canUseTool"}
        </button>
        <button onClick={() => loadFiles("POST", "/api/c3/reset")} disabled={running}>
          Reset sandbox/
        </button>
      </div>

      {open.map((r) => (
        <PermissionCard key={r.id} request={r} />
      ))}

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
      {(requests.length > 0 || decisions.length > 0) && (
        <div className="card">
          <b>canUseTool calls ({Math.max(requests.length, decisions.length)})</b>
          {decisions.map((d) => {
            const req = requests.find((r) => r.id === d.id);
            const allowed = d.decision.behavior === "allow";
            return (
              <div key={d.id} className={`tool-call ${allowed ? "" : "denied"}`}>
                <div>
                  <span className="tag tag-assistant">{d.auto ? "policy" : "you"}</span> <code>{d.toolName}</code>{" "}
                  <code className="subtype">{JSON.stringify(req?.input ?? d.input)}</code>
                </div>
                <div>
                  <span className={`tag ${allowed ? "tag-user" : "tag-error"}`}>{d.decision.behavior}</span>{" "}
                  <span className="snippet">{JSON.stringify(withoutEcho(d.decision, req?.input ?? d.input))}</span>
                </div>
              </div>
            );
          })}
          {open.map((r) => (
            <div key={r.id} className="tool-call">
              <span className="tag">waiting</span> <code>{r.toolName}</code> — answer it in the card above
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

/** One pending canUseTool call. Every button POSTs to /api/c4/decide, which resolves the callback's promise. */
function PermissionCard({ request }: { request: Request }) {
  const original = JSON.stringify(request.input, null, 2);
  const [inputJson, setInputJson] = useState(original);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(inputJson);
  } catch {}
  const edited = inputJson !== original;

  async function decide(choice: string) {
    setBusy(true);
    const res = await fetch("/api/c4/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: request.id, choice, message, updatedInput: edited ? parsed : undefined }),
    });
    // A refused decision (400) or a request that is gone (404): say why and let the user try again.
    if (!res.ok) {
      alert((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      setBusy(false);
    }
  }

  return (
    <div className="card permission">
      <b>{request.title ?? `Claude wants to use ${request.toolName}`}</b>
      {request.description && <div className="hint">{request.description}</div>}
      {request.decisionReason && (
        <div className="hint">
          decisionReason: <code>{request.decisionReason}</code>
        </div>
      )}
      {request.blockedPath && (
        <div className="hint">
          blockedPath: <code>{request.blockedPath}</code>
        </div>
      )}
      <small>
        <code>input</code> {edited && <b>(edited: sent as updatedInput)</b>}
      </small>
      <textarea value={inputJson} onChange={(e) => setInputJson(e.target.value)} rows={Math.min(10, original.split("\n").length + 1)} />
      <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Deny message the model will read (optional)" />
      <div className="row">
        <button className="primary" onClick={() => decide("allow")} disabled={busy || !parsed}>
          {edited ? "Allow with edited input" : "Allow"}
        </button>
        <button onClick={() => decide("allow_always")} disabled={busy || !parsed || !request.suggestions?.length}
          title={request.suggestions?.length ? JSON.stringify(request.suggestions) : "The SDK sent no suggestions for this call"}>
          Allow always (session)
        </button>
        <button onClick={() => decide("deny")} disabled={busy}>
          Deny
        </button>
        <button onClick={() => decide("deny_interrupt")} disabled={busy}>
          Deny + interrupt
        </button>
      </div>
    </div>
  );
}

/** Hide an updatedInput that is just the original input echoed back, so real edits stand out. */
function withoutEcho(decision: any, input: unknown) {
  if (decision.updatedInput && JSON.stringify(decision.updatedInput) === JSON.stringify(input)) {
    const { updatedInput, ...rest } = decision;
    return rest;
  }
  return decision;
}
