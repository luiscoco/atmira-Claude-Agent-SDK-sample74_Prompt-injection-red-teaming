import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

// Must match buildHooks() in server/concepts/20-hooks-in-depth.ts.
const hookInfo: { name: string; event: string; matcher?: string; does: string }[] = [
  { name: "context", event: "UserPromptSubmit", does: "additionalContext: amounts in EUR and USD" },
  { name: "block-secrets", event: "UserPromptSubmit", does: 'decision: "block" when the prompt has a password or key' },
  { name: "maintenance", event: "UserPromptSubmit", does: "continue: false + stopReason" },
  { name: "redact", event: "PostToolUse", matcher: "Read", does: "updatedToolOutput: hides sk-live-… keys · systemMessage" },
  { name: "explain-failure", event: "PostToolUseFailure", does: "additionalContext: where the file really is" },
  { name: "approve-writes", event: "PermissionRequest", does: "decision allow inside hooks-lab/, deny + message outside" },
  { name: "stop-gate", event: "Stop", does: 'decision: "block" until the answer ends with "Source: <file>"' },
  { name: "subagent-brief", event: "SubagentStart", does: "additionalContext for the subagent" },
  { name: "crash", event: "PreToolUse", matcher: "Read", does: "meant to deny config.env, but throws" },
  { name: "slow", event: "PreToolUse", matcher: "Read · timeout 2", does: "takes 5 s: the SDK aborts it" },
  { name: "async-log", event: "PostToolUse", does: "{ async: true }: logs 1.5 s later, the run doesn't wait" },
];

const allTools = ["Read", "Glob", "Write", "Agent"];

type Form = { prompt: string; hooks: string[]; tools: string[]; agents: boolean };
type HookCall = { name: string; event: string; input: any; output?: any; error?: string; ms: number; at: number };
type AsyncDone = { tool: string; startedAt: number; finishedAt: number; at: number };

const BUDGET = "What is the budget in notes.txt? One line.";

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · Which events fire?",
    hint: "No hooks picked: only the observer, which is on all the HOOK_EVENTS and returns {}. Look at the grid: which events lit up, and in what order in the timeline. SessionStart and SessionEnd stay grey.",
    form: { prompt: "Which files are here? Then tell me the budget in notes.txt.", hooks: [], tools: ["Read", "Glob"], agents: false },
  },
  {
    label: "2 · Context on every prompt",
    hint: "context adds text the model reads next to the prompt. The prompt says nothing about USD, but the answer gives it.",
    form: { prompt: BUDGET, hooks: ["context"], tools: ["Read"], agents: false },
  },
  {
    label: "3 · Block a prompt",
    hint: 'block-secrets answers decision: "block". The model is never called: 0 turns, $0, and the reason is the result text. context also ran: both UserPromptSubmit hooks see the prompt.',
    form: { prompt: "My password is hunter2. Save it in notes.txt.", hooks: ["block-secrets", "context"], tools: ["Read", "Write"], agents: false },
  },
  {
    label: "4 · Stop everything",
    hint: "continue: false works on any event. On UserPromptSubmit nothing runs, and stopReason arrives as a system/informational message for the user.",
    form: { prompt: BUDGET, hooks: ["maintenance"], tools: ["Read"], agents: false },
  },
  {
    label: "5 · Redact tool output",
    hint: "redact replaces the Read result with updatedToolOutput. The model sees [REDACTED]. Open config.env below: the file still has the key. The systemMessage is for you; the model never sees it.",
    form: { prompt: "Read config.env and list every key with its value.", hooks: ["redact"], tools: ["Read"], agents: false },
  },
  {
    label: "6 · Explain a failure",
    hint: "The file does not exist, so PostToolUse does not fire. PostToolUseFailure does, with the error, and its additionalContext sends the model to notes.txt.",
    form: { prompt: "Read budget-2025.txt and tell me the budget.", hooks: ["explain-failure"], tools: ["Read"], agents: false },
  },
  {
    label: "7 · Approve writes",
    hint: "Write has no allow rule, so it would ask. There is no canUseTool, so PermissionRequest decides: allow for summary.md, deny with a message for ../outside.md. Read never reaches PermissionRequest (allowedTools).",
    form: {
      prompt: "Read notes.txt, write summary.md with a one-line summary, then write the same line to ../outside.md.",
      hooks: ["approve-writes"],
      tools: ["Read", "Write"],
      agents: false,
    },
  },
  {
    label: "8 · Don't stop yet",
    hint: 'stop-gate blocks the first Stop: its reason goes to the model, which answers again. The second Stop has stop_hook_active: true, and the hook lets it go (that check prevents an endless loop).',
    form: { prompt: BUDGET, hooks: ["stop-gate"], tools: ["Read"], agents: false },
  },
  {
    label: "9 · Subagents",
    hint: "SubagentStart and SubagentStop wrap the subagent. The subagent's own tool hooks carry agent_id and agent_type (show the observer's rows). subagent-brief's additionalContext reaches the subagent, so its report has the '<N> files: …' form. Glob is ticked because a subagent's tools must be in the session's pool (Concept 8).",
    form: {
      prompt: "Use the counter agent (not in the background) to count the files here. Wait for its report, then repeat it word for word.",
      hooks: ["subagent-brief"],
      tools: ["Agent", "Glob"],
      agents: true,
    },
  },
  {
    label: "10 · A hook that throws",
    hint: "crash was meant to deny reading config.env, but it throws. A hook that throws is ignored: the Read runs and the model sees the key. Fail open: catch errors inside your guards.",
    form: { prompt: "Read config.env and tell me the API key.", hooks: ["crash"], tools: ["Read"], agents: false },
  },
  {
    label: "11 · A hook that times out",
    hint: "slow takes 5 s, and its matcher has timeout: 2. The SDK aborts signal after 2 s and does NOT run the Read. Fail closed: the opposite of scenario 10.",
    form: { prompt: BUDGET, hooks: ["slow"], tools: ["Read"], agents: false },
  },
  {
    label: "12 · Don't wait for me",
    hint: "async-log returns { async: true } at once and finishes 1.5 s later. The run goes on without it. See where the async row lands in the timeline.",
    form: { prompt: BUDGET, hooks: ["async-log"], tools: ["Read"], agents: false },
  },
];

export function Concept20HooksInDepth() {
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [allEvents, setAllEvents] = useState<string[]>([]);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<HookCall[]>([]);
  const [asyncDone, setAsyncDone] = useState<AsyncDone[]>([]);
  const [showObserver, setShowObserver] = useState(false);
  const [files, setFiles] = useState<{ name: string; bytes: number }[]>([]);
  const [opened, setOpened] = useState<{ name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [controller, setController] = useState<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // A live counter, so a slow run is visibly different from a stuck one.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);

  const set =(patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const loadFiles = () =>
    fetch("/api/c20/files")
      .then((r) => r.json())
      .then(setFiles)
      .catch(() => setError("Could not list hooks-lab/ — is this sample's server running on port 3001?"));
  useEffect(() => void loadFiles(), []);

  async function openFile(name: string) {
    const content = await fetch(`/api/c20/file?name=${encodeURIComponent(name)}`).then((r) => r.text());
    setOpened({ name, content });
  }

  async function reset() {
    await fetch("/api/c20/reset", { method: "POST" });
    setOpened(null);
    loadFiles();
  }

  async function run() {
    setMessages([]);
    setCalls([]);
    setAsyncDone([]);
    setSentOptions(null);
    setOpened(null);
    setError(null);
    setElapsed(0);
    setRunning(true);
    // Stop closes the request; the server's SSE helper then aborts the query.
    const ctrl = new AbortController();
    setController(ctrl);
    try {
      await streamPost(
        "/api/c20/run",
        form,
        (event, data) => {
          if (event === "options") setSentOptions(data);
          if (event === "events") setAllEvents(data.all);
          if (event === "message") setMessages((prev) => [...prev, data]);
          if (event === "hook") setCalls((prev) => [...prev, data]);
          if (event === "async") setAsyncDone((prev) => [...prev, data]);
          if (event === "error") setError(data.message);
        },
        ctrl.signal,
      );
    } catch (err) {
      setError(ctrl.signal.aborted ? "Stopped from the browser." : `${String(err)} — is this sample's server running on port 3001?`);
    } finally {
      setRunning(false);
      setController(null);
      loadFiles();
    }
  }

  // The observer fires once per event, so its rows are the count of each event.
  const fired = new Map<string, number>();
  for (const c of calls) if (c.name === "observer") fired.set(c.event, (fired.get(c.event) ?? 0) + 1);
  const order = [...new Set(calls.filter((c) => c.name === "observer").map((c) => c.event))];

  const shown = calls.filter((c) => showObserver || c.name !== "observer");
  const forUser = messages.filter((m) => m.type === "system" && (m.subtype === "informational" || m.subtype === "permission_denied"));
  const result = messages.find((m) => m.type === "result");
  const text = messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n");

  return (
    <section>
      <h2>20 · Hooks in depth: the whole agent loop</h2>
      <p className="lead">
        Concept 7 hooked tool calls. <code>options.hooks</code> takes any of the <code>HOOK_EVENTS</code>: the prompt (
        <code>UserPromptSubmit</code>), permission prompts (<code>PermissionRequest</code>), failed calls (
        <code>PostToolUseFailure</code>), subagents, and the moment the model wants to <b>stop</b>. Every run registers an{" "}
        <code>observer</code> on all events, so you see everything that fired, plus the hooks you tick. Haiku, no thinking,{" "}
        <code>cwd: hooks-lab/</code>.
      </p>

      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
            disabled={running}
          >
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
            <th>event</th>
            <th>matcher</th>
            <th>returns</th>
          </tr>
        </thead>
        <tbody>
          {hookInfo.map((h) => (
            <tr key={h.name}>
              <td>
                <input type="checkbox" checked={form.hooks.includes(h.name)} onChange={() => set({ hooks: toggle(form.hooks, h.name) })} />
              </td>
              <td>
                <code>{h.name}</code>
              </td>
              <td>
                <code>{h.event}</code>
              </td>
              <td>{h.matcher ?? ""}</td>
              <td>{h.does}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <small>
          <code>tools</code>:
        </small>
        {allTools.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={form.tools.includes(t)} onChange={() => set({ tools: toggle(form.tools, t) })} /> <code>{t}</code>
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={form.agents} onChange={() => set({ agents: !form.agents })} /> <code>agents: {"{ counter }"}</code>
        </label>
      </div>

      <div className="row">
        <button className="primary" onClick={run} disabled={running || !form.prompt.trim()}>
          {running ? `Running… ${elapsed} s` : "Run query() with hooks"}
        </button>
        {running && <button onClick={() => controller?.abort()}>Stop</button>}
        <button onClick={reset} disabled={running}>
          Reset hooks-lab/
        </button>
      </div>

      <div className="card">
        <b>hooks-lab/ on disk</b> <span className="subtype">click a file to see what is really in it</span>
        <ul className="files">
          {files.map((f) => (
            <li key={f.name}>
              <button onClick={() => openFile(f.name)}>{f.name}</button> <span className="subtype">{f.bytes} B</span>
            </li>
          ))}
        </ul>
        {opened && <pre>{opened.content}</pre>}
      </div>

      {allEvents.length > 0 && (
        <div className="card">
          <b>HOOK_EVENTS</b>{" "}
          <span className="subtype">
            {fired.size} of {allEvents.length} fired{order.length > 0 && <> · first-fire order: {order.join(" → ")}</>}
          </span>
          <div className="events-grid">
            {allEvents.map((e) => (
              <span key={e} className={`ev ${fired.has(e) ? "fired" : ""}`}>
                {e}
                {fired.has(e) && <b> ×{fired.get(e)}</b>}
              </span>
            ))}
          </div>
        </div>
      )}

      {calls.length > 0 && (
        <div className="card">
          <b>hook calls</b> <span className="subtype">ms since the run started</span>
          <label className="check">
            <input type="checkbox" checked={showObserver} onChange={() => setShowObserver(!showObserver)} /> show the observer's rows (
            {calls.length - shown.length} hidden)
          </label>
          {shown.map((c, i) => (
            <HookRow key={i} call={c} />
          ))}
          {asyncDone.map((a, i) => (
            <div key={`a${i}`} className="tool-call">
              <span className="subtype">{a.at} ms</span> <span className="tag tag-post">async</span> <code>async-log</code> finished its work for{" "}
              <code>{a.tool}</code>, {a.finishedAt - a.startedAt} ms after it returned <code>{"{ async: true }"}</code>
            </div>
          ))}
        </div>
      )}

      {forUser.length > 0 && (
        <div className="card warn">
          <b>shown to the user, not to the model</b>
          {forUser.map((m) => (
            <div key={m.uuid ?? m.tool_use_id} className="snippet">
              system/{m.subtype}
              {m.level ? ` (${m.level})` : ""}: {m.content ?? m.message}
            </div>
          ))}
        </div>
      )}

      {text && <div className="card answer">{text}</div>}
      {result && (
        <div className={`card ${result.subtype === "success" && result.num_turns > 0 ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · ${result.total_cost_usd.toFixed(4)}
          {result.terminal_reason && (
            <div>
              <b>terminal_reason</b>: <code>{result.terminal_reason}</code>
            </div>
          )}
          {!text && result.result && (
            <div>
              <b>result</b>: <span className="snippet">{result.result}</span>
            </div>
          )}
          {result.permission_denials?.length > 0 && (
            <div>
              <b>permission_denials</b>:{" "}
              {result.permission_denials.map((d: any) => (
                <code key={d.tool_use_id}>
                  {d.tool_name} {d.tool_input?.file_path ? d.tool_input.file_path.split(/[\\/]/).slice(-2).join("/") : ""}{" "}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}

      {sentOptions && (
        <details className="card">
          <summary>
            <b>options sent to query()</b>
          </summary>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </details>
      )}

      <MessageLog messages={messages} />
    </section>
  );
}

/** The part of a hook input worth showing for each event. */
function summary(input: any): string {
  if (input.tool_name) {
    const args = JSON.stringify(input.tool_input ?? {}).replace(/"[A-Z]:\\\\[^"]*?hooks-lab\\\\/g, '"');
    return `${input.tool_name} ${args.slice(0, 140)}${input.error ? `  ✗ ${input.error.slice(0, 120)}` : ""}${
      input.duration_ms !== undefined ? `  (${input.duration_ms} ms)` : ""
    }`;
  }
  if (input.tool_calls) return `${input.tool_calls.length} call(s): ${input.tool_calls.map((c: any) => c.tool_name).join(", ")}`;
  if (input.prompt !== undefined) return `prompt: ${input.prompt}`;
  if (input.hook_event_name === "Stop") return `stop_hook_active: ${input.stop_hook_active} · last: ${(input.last_assistant_message ?? "").slice(0, 120)}`;
  if (input.agent_type) return `agent_type: ${input.agent_type} · agent_id: ${input.agent_id}${input.last_assistant_message ? ` · last: ${input.last_assistant_message.slice(0, 100)}` : ""}`;
  if (input.delta !== undefined) return `delta: ${input.delta.slice(0, 120)}`;
  return "";
}

/** One hook call: when, which event and hook, what it received, and what it answered (or threw). */
function HookRow({ call }: { call: HookCall }) {
  const { input, output, error } = call;
  const o = output ?? {};
  const blocked =
    Boolean(error) ||
    o.decision === "block" ||
    o.continue === false ||
    o.hookSpecificOutput?.permissionDecision === "deny" ||
    o.hookSpecificOutput?.decision?.behavior === "deny";
  const tag = call.event.startsWith("Pre") || call.event === "UserPromptSubmit" || call.event === "PermissionRequest" ? "tag-pre" : "tag-post";
  const sub = input.agent_type && input.tool_name ? ` (in ${input.agent_type})` : "";
  return (
    <div className={`tool-call ${blocked ? "denied" : ""} ${call.name === "observer" ? "observer" : ""}`}>
      <div>
        <span className="subtype">{call.at} ms</span> <span className={`tag ${tag}`}>{call.event}</span> <code>{call.name}</code>
        {sub} <span className="subtype">{call.ms} ms</span>
      </div>
      <div className="snippet">{summary(input)}</div>
      <div className="snippet report">
        {error ? `threw → ${error}` : Object.keys(o).length === 0 ? "→ {}  (no opinion)" : `→ ${JSON.stringify(o).slice(0, 400)}`}
      </div>
    </div>
  );
}
