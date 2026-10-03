import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const builtInTools = ["Agent", "Read", "Glob", "Grep", "Write"];

type AgentName = "researcher" | "writer" | "critic";
const agentNames: AgentName[] = ["researcher", "writer", "critic"];

type Form = { prompt: string; tools: string[]; agents: AgentName[]; forwardSubagentText: boolean; foreground: boolean };

const ALL_TOOLS = builtInTools;

// Each scenario shows one idea about subagents.
const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · Delegate",
    hint: "The main agent hands the question to researcher with the Agent tool. The researcher's Read/Glob calls have parent_tool_use_id set; its report comes back as the Agent tool_result.",
    form: { prompt: "Use the researcher subagent to find which tasks in data/tasks.json are not done yet, then tell me.", tools: ALL_TOOLS, agents: ["researcher"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "2 · Pick by description",
    hint: "The prompt names no agent. The main agent reads each AgentDefinition.description and chooses the writer, the only one that can create files. Remove \"Delegate to the best-suited subagent:\" and it usually does the job itself: it has the same tools.",
    form: { prompt: "Delegate to the best-suited subagent: create todo.txt listing, one per line, the titles of the tasks in data/tasks.json that are not done.", tools: ALL_TOOLS, agents: ["researcher", "writer", "critic"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "3 · Chain",
    hint: "Three delegations in a row. Each subagent starts with a fresh context, so the main agent has to copy the text it needs into the next prompt (look at the critic's prompt).",
    form: { prompt: "1) Ask the researcher for the open items in notes.txt and data/tasks.json. 2) Ask the writer to put them in next-steps.txt as a numbered list. 3) Send that list to the critic and tell me its verdict.", tools: ALL_TOOLS, agents: ["researcher", "writer", "critic"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "4 · Parallel",
    hint: "Two Agent tool_use blocks in the same turn (same message.id in the raw stream): both task_started messages arrive before either task_notification, so the subagents run at the same time.",
    form: { prompt: "In one turn, launch two researcher subagents in parallel: one summarizes notes.txt, the other data/tasks.json. Then combine both answers in 4 lines.", tools: ALL_TOOLS, agents: ["researcher"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "5 · Tool isolation",
    hint: "researcher's tools are Read, Glob and Grep, so it has no Write, even though the main session does. It can only report that it can't do it.",
    form: { prompt: "Ask the researcher subagent to create a file hello.txt containing \"hi\". Do not create it yourself. Report what the researcher said.", tools: ALL_TOOLS, agents: ["researcher"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "6 · Forward text",
    hint: "Same as scenario 1 with forwardSubagentText: true. Now the subagent's own text blocks are in the stream too, not only its tool calls.",
    form: { prompt: "Use the researcher subagent to find which tasks in data/tasks.json are not done yet, then tell me.", tools: ALL_TOOLS, agents: ["researcher"], forwardSubagentText: true, foreground: true },
  },
  {
    label: "7 · No Agent tool",
    hint: "The agents are defined, but \"Agent\" is not in tools, so the main agent can't delegate and does the work itself. No task_started, no parent_tool_use_id.",
    form: { prompt: "Use the researcher subagent to find which tasks in data/tasks.json are not done yet, then tell me.", tools: ["Read", "Glob", "Grep", "Write"], agents: ["researcher"], forwardSubagentText: false, foreground: true },
  },
  {
    label: "8 · Background",
    hint: "Scenario 1 without the foreground hook: the subagent runs in the background (the SDK default). The Agent tool_result is only a placeholder, the first result comes before the subagent finishes, and the report arrives in task_notification.summary, followed by a second turn and a second result.",
    form: { prompt: "Use the researcher subagent to find which tasks in data/tasks.json are not done yet, then tell me.", tools: ALL_TOOLS, agents: ["researcher"], forwardSubagentText: false, foreground: false },
  },
];

/** One Agent tool call of the main agent, with everything its subagent did. */
type Delegation = {
  id: string;
  input: { subagent_type?: string; description?: string; prompt?: string; model?: string };
  steps: { kind: "tool" | "text"; name?: string; detail: string }[];
  report?: string;
  started?: any;
  notification?: any;
};

export function Concept08Subagents() {
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [definitions, setDefinitions] = useState<Record<string, any>>({});
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  // The sandbox/ folder and its routes come from Concept 3.
  const loadFiles = (method = "GET", url = "/api/c3/files") =>
    fetch(url, { method }).then((r) => r.json()).then(setFiles);
  useEffect(() => {
    loadFiles();
    fetch("/api/c8/agents").then((r) => r.json()).then(setDefinitions);
  }, []);

  async function run() {
    setMessages([]);
    setHooks([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    try {
      await streamPost("/api/c8/query", { ...form, model: "claude-haiku-4-5-20251001", maxTurns: 15 }, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "hook") setHooks((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
    }
  }

  const delegations = buildDelegations(messages);
  // A background subagent wakes the main agent up again after the first result, so there can be several.
  const results = messages.filter((m) => m.type === "result");
  // Only the main thread's text is the answer; subagent text (with forwardSubagentText) has a parent_tool_use_id.
  const text = messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return (
    <section>
      <h2>8 · Subagents: options.agents + the Agent tool</h2>
      <p className="lead">
        A subagent is a separate agent loop with its own system prompt, tools and model. You define them in{" "}
        <code>options.agents</code>; the main agent starts one with the <code>Agent</code> tool and gets back a single
        report. Everything the subagent does is tagged with <code>parent_tool_use_id</code>.
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

      <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={3} />

      <table className="tools">
        <thead>
          <tr>
            <th />
            <th>agent</th>
            <th>tools</th>
            <th>model</th>
            <th>description (what the main agent reads)</th>
          </tr>
        </thead>
        <tbody>
          {agentNames.map((name) => {
            const d = definitions[name];
            return (
              <tr key={name}>
                <td>
                  <input type="checkbox" checked={form.agents.includes(name)} onChange={() => set({ agents: toggle(form.agents, name) })} />
                </td>
                <td><code>{name}</code></td>
                <td><code>{d ? JSON.stringify(d.tools) : ""}</code></td>
                <td><code>{d?.model ?? "(default)"}</code></td>
                <td>{d?.description}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="row">
        <small>
          <code>tools</code> (session pool):
        </small>
        {builtInTools.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={form.tools.includes(t)} onChange={() => set({ tools: toggle(form.tools, t) })} /> <code>{t}</code>
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={form.forwardSubagentText} onChange={(e) => set({ forwardSubagentText: e.target.checked })} />
        <code>forwardSubagentText</code> <span className="subtype">also stream the subagents' text, not only their tool calls</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.foreground} onChange={(e) => set({ foreground: e.target.checked })} />
        <code>foreground</code> <span className="subtype">PreToolUse hook on Agent: updatedInput run_in_background: false</span>
      </label>

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run query() with subagents"}
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
      {delegations.length > 0 && (
        <div className="card">
          <b>delegations ({delegations.length})</b> <span className="subtype">one per Agent tool_use of the main agent</span>
          {delegations.map((d) => (
            <DelegationRow key={d.id} d={d} />
          ))}
        </div>
      )}
      {hooks.length > 0 && (
        <div className="card">
          <b>hook calls ({hooks.length})</b>
          {hooks.map((h, i) => (
            <div key={i} className="tool-call">
              <span className={`tag ${h.input.hook_event_name === "SubagentStop" ? "tag-post" : "tag-pre"}`}>{h.input.hook_event_name}</span>{" "}
              {h.input.hook_event_name === "PreToolUse" ? (
                <>
                  <code>foreground</code> → <code>{h.input.tool_name}</code>{" "}
                  <span className="snippet">{JSON.stringify(h.output.hookSpecificOutput?.updatedInput)}</span>
                </>
              ) : (
                <>
                  <code>{h.input.agent_type}</code> <span className="subtype">agent_id {h.input.agent_id}</span>
                </>
              )}
              {h.input.last_assistant_message && <div className="snippet">last_assistant_message: {h.input.last_assistant_message}</div>}
            </div>
          ))}
        </div>
      )}
      {text && <div className="card answer">{text}</div>}
      {results.map((result, i) => (
        <div key={i} className={`card ${result.subtype === "success" ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)}
          {result.modelUsage && (
            <div>
              <b>modelUsage</b>:{" "}
              {Object.entries(result.modelUsage).map(([model, u]: [string, any]) => (
                <code key={model}>
                  {model} ${u.costUSD.toFixed(4)}{" "}
                </code>
              ))}
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
      ))}
      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
        </div>
      )}

      <MessageLog messages={messages} />
    </section>
  );
}

/**
 * Groups the flat message stream by subagent. The key is the id of the main agent's Agent tool_use:
 * every message the subagent produced carries it as parent_tool_use_id, and the report is the tool_result for it.
 */
function buildDelegations(messages: any[]): Delegation[] {
  const byId = new Map<string, Delegation>();
  for (const m of messages) {
    if (m.type === "assistant" && !m.parent_tool_use_id) {
      for (const b of m.message.content) {
        if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) byId.set(b.id, { id: b.id, input: b.input, steps: [] });
      }
    }
  }
  for (const m of messages) {
    if (m.type === "system" && m.tool_use_id && byId.has(m.tool_use_id)) {
      if (m.subtype === "task_started") byId.get(m.tool_use_id)!.started = m;
      if (m.subtype === "task_notification") byId.get(m.tool_use_id)!.notification = m;
    }
    const d = m.parent_tool_use_id && byId.get(m.parent_tool_use_id);
    if (d && (m.type === "assistant" || m.type === "user") && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_use") d.steps.push({ kind: "tool", name: b.name, detail: JSON.stringify(b.input) });
        if (b.type === "text" && m.type === "assistant") d.steps.push({ kind: "text", detail: b.text });
      }
    }
    if (m.type === "user" && !m.parent_tool_use_id && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_result" && byId.has(b.tool_use_id)) byId.get(b.tool_use_id)!.report = resultText(b.content);
      }
    }
  }
  // A background subagent's tool_result is only "Async agent launched"; its real report is the notification summary.
  for (const d of byId.values()) {
    if (d.started?.is_backgrounded && d.notification) d.report = d.notification.summary;
  }
  return [...byId.values()];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return JSON.stringify(content);
}

function DelegationRow({ d }: { d: Delegation }) {
  const usage = d.notification?.usage;
  return (
    <div className="tool-call delegation">
      <div>
        <span className="tag tag-assistant">Agent</span> <code>{d.input.subagent_type ?? "general-purpose"}</code>{" "}
        <span className="subtype">{d.input.description}</span>
        {d.started && <span className="subtype">{d.started.is_backgrounded ? "background" : "foreground"}</span>}
        {d.notification && <span className="subtype">status {d.notification.status}</span>}
        {usage && (
          <span className="subtype">
            {usage.tool_uses} tool use(s) · {usage.total_tokens} tokens · {usage.duration_ms} ms
          </span>
        )}
      </div>
      <div className="snippet">
        <b>prompt</b> (all the subagent knows): {d.input.prompt}
      </div>
      <ol className="steps">
        {d.steps.map((s, i) => (
          <li key={i}>
            {s.kind === "tool" ? (
              <>
                <code>{s.name}</code> <code className="subtype">{s.detail}</code>
              </>
            ) : (
              <span className="snippet">text: {s.detail}</span>
            )}
          </li>
        ))}
        {d.steps.length === 0 && <li className="subtype">(no tool calls)</li>}
      </ol>
      {d.report !== undefined && (
        <div className="snippet report">
          <b>report → main agent</b>
          {d.started?.is_backgrounded ? " (from task_notification.summary)" : " (the Agent tool_result)"}: {d.report}
        </div>
      )}
    </div>
  );
}
