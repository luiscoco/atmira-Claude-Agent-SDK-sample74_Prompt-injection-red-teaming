import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Item = { id: string; subject: string; status: string; activeForm?: string; blockedBy?: string[]; owner?: string };
type Board = { source: string; dir?: string; items: Item[] };

// Part A: the two todo tools, and when the model uses them. Each one is a scenario for POST /run.
const partA: { id: string; label: string; hint: string }[] = [
  {
    id: "tasks",
    label: "1 · Task tools",
    hint: "The default todo system. The prompt asks for a plan of 4 steps. The model calls TaskCreate once per task, then TaskUpdate (in_progress, completed) for each one. The TaskCreated and TaskCompleted hooks fire. The board is read from the task FILES on disk (todo-lab/config/tasks/<session id>/1.json …), polled every 250 ms. About $0.02.",
  },
  {
    id: "todo",
    label: "2 · TodoWrite",
    hint: "The same prompt with CLAUDE_CODE_ENABLE_TASKS=false, so the model gets the older TodoWrite. Each call REWRITES the whole list: tool_use_result holds { oldTodos, newTodos }. No file is written, and the hooks do not fire. Compare the output tokens with scenario 1. About $0.03.",
  },
  {
    id: "defaultTools",
    label: "3 · Default tool set: deferred",
    hint: "No `tools` option: the model gets Claude Code's full tool set, where the todo tools are DEFERRED. Watch the first tool call: ToolSearch { query: 'select:TaskCreate' } loads the tool before the model can call it. About $0.03.",
  },
  {
    id: "unprompted",
    label: "4 · Not asked to plan",
    hint: "The same kind of job, but the prompt does not mention a plan. Haiku just does the work: no TaskCreate, an empty board. In the probes it did not plan even with the claude_code system prompt. If you want a todo list, ask for one. About $0.01.",
  },
];

// Part B: the host owns the plan.
const partB: { id: string; label: string; hint: string }[] = [
  {
    id: "seeded",
    label: "5 · The host writes the plan",
    hint: "Before query(), the host writes 3 task files to todo-lab/config/tasks/plan-<run>/ and sets CLAUDE_CODE_TASK_LIST_ID=plan-<run>. Task 3 is blockedBy 1 and 2. The model finds the plan with TaskList (“#3 [pending] Write report.txt [blocked by #1, #2]”) and follows it. About $0.03.",
  },
  {
    id: "gate",
    label: "6 · Hooks gate the plan",
    hint: "The same plan, with rules in the hooks. TaskCompleted checks the work for real: 'Write x.txt' is done only if x.txt exists, and report.txt must end with END (the task does not say so, so the first try is refused). TaskCreated refuses a task that deletes files. After task 2, the host adds task 4 itself. About $0.05.",
  },
  {
    id: "resume",
    label: "7 · Resume keeps the list",
    hint: "Run 1 plans 4 tasks, does only the first one and stops. Run 2 is a new query() with resume: the same session id, so the same task folder. The model goes on from task 2 without planning again. About $0.05.",
  },
];

// Part D: the two tools side by side.
const table: [string, string, string][] = [
  ["When", "The default (CLAUDE_CODE_ENABLE_TASKS unset)", "CLAUDE_CODE_ENABLE_TASKS=false"],
  ["A change is", "One call: TaskCreate, TaskUpdate { taskId, status }", "A new copy of the whole list: TodoWrite { todos: [...] }"],
  ["Stored in", "CLAUDE_CONFIG_DIR/tasks/<list>/<id>.json", "Only the transcript"],
  ["The list is named", "The session id, or CLAUDE_CODE_TASK_LIST_ID", "—"],
  ["Your code reads it from", "The files, or tool_use_result of each call", "tool_use_result: { oldTodos, newTodos }"],
  ["The host can write it", "Yes: write the JSON files", "No"],
  ["Dependencies", "blockedBy / blocks, shown by TaskList", "No"],
  ["Hooks", "TaskCreated, TaskCompleted (can refuse)", "None (use PreToolUse on TodoWrite)"],
  ["Permission", "Never asked", "Never asked"],
  ["Default tool set", "Deferred: ToolSearch first", "Deferred: ToolSearch first"],
];

const ICON: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●", deleted: "×" };

function TodoBoard({ board }: { board: Board | null }) {
  if (!board)
    return (
      <div className="card todo-board">
        <b>Todo board</b> <span className="subtype">empty: no task files and no TodoWrite call yet</span>
      </div>
    );
  const done = board.items.filter((i) => i.status === "completed").length;
  // A blocker counts only while it is not completed (TaskList shows the same).
  const open = (i: Item) => (i.blockedBy ?? []).filter((b) => board.items.find((x) => x.id === b)?.status !== "completed");
  return (
    <div className="card todo-board">
      <b>Todo board</b>{" "}
      <span className="subtype">
        {done}/{board.items.length} completed · from {board.source === "disk" ? <code>{board.dir}/*.json</code> : <code>TodoWrite tool_use_result.newTodos</code>}
      </span>
      <div className="todo-bar">
        <div style={{ width: `${board.items.length ? (100 * done) / board.items.length : 0}%` }} />
      </div>
      <ul className="todo-list">
        {board.items.map((i) => (
          <li key={i.id} className={`todo-item todo-${i.status}`}>
            <span className="todo-icon">{ICON[i.status] ?? "?"}</span>
            <span className="todo-id">#{i.id}</span>
            <span className="todo-subject">{i.status === "in_progress" && i.activeForm ? `${i.activeForm}…` : i.subject}</span>
            {open(i).length > 0 && <span className="subtype">blocked by {open(i).map((b) => `#${b}`).join(", ")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const todoTool = (name: string) => /^(Task(Create|Get|List|Update)|TodoWrite|ToolSearch)$/.test(name);

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "init":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/init</span> <code>{data.model}</code>{" "}
                <span className="subtype">
                  todo tools: {data.todoTools.filter((n: string) => n !== "ToolSearch").join(", ") || "none"}
                  {data.todoTools.includes("ToolSearch") && " · + ToolSearch (some tools are deferred)"}
                </span>{" "}
                {t}
              </div>
            );
          case "call":
            return (
              <div key={i} className="tool-call call">
                <span className="tag tag-call">host</span> {t}
                <div className="snippet">{data.method}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-assistant">assistant</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className={`tool-call ${todoTool(data.name) ? "todo" : ""}`}>
                <span className={`tag ${todoTool(data.name) ? "tag-todo" : "tag-pre"}`}>tool_use {data.name}</span> {t}
                <div className="snippet">{JSON.stringify(data.input)}</div>
              </div>
            );
          case "toolResult": {
            // A refused TaskUpdate is NOT an is_error result: only tool_use_result.success says so.
            const refused = data.tool_use_result?.success === false;
            return (
              <div key={i} className={`tool-call ${data.is_error || refused ? "denied" : ""} ${todoTool(data.name) ? "todo" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> <code>{data.name}</code> {data.is_error && <code className="bad">is_error</code>}{" "}
                {refused && <code className="bad">success: false</code>} {t}
                <div className="snippet">{data.text || "(empty)"}</div>
                {data.tool_use_result && <pre className="wrap tur">tool_use_result: {JSON.stringify(data.tool_use_result)}</pre>}
              </div>
            );
          }
          case "hook":
            return (
              <div key={i} className={`tool-call ${data.decision === "block" ? "denied" : ""}`}>
                <span className="tag tag-post">{data.name} hook</span> <code>
                  #{data.task_id} {data.subject}
                </code>{" "}
                <span className={`tag ${data.decision === "block" ? "st-killed" : "st-completed"}`}>{data.decision}</span> {t}
                {data.reason && <div className="snippet">reason: {data.reason}</div>}
              </div>
            );
          case "change":
            return (
              <div key={i} className="tool-call board-change">
                <span className="tag tag-todo">board</span> <span className="subtype">{data.source === "disk" ? "task files" : "TodoWrite"}</span> {t}
                {data.changes.map((c: any) => (
                  <div key={c.id} className="snippet">
                    #{c.id} {c.subject}: {c.from ?? "new"} → <b>{c.to}</b>
                  </div>
                ))}
              </div>
            );
          case "denied":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">canUseTool denied</span> <code>{data.tool}</code> {t}
              </div>
            );
          case "result":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                <span className="subtype">
                  num_turns {data.num_turns} · output_tokens {data.output_tokens} · ${data.cost.toFixed(4)}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "check":
            return (
              <div key={i} className="tool-call verdict">
                <span className="tag tag-verdict">host check</span>{" "}
                <code className={data.left.length ? "bad" : ""}>
                  {data.done}/{data.items} completed
                </code>{" "}
                <span className="subtype">files written: {data.files.join(", ") || "none"}</span>
                <div className="snippet">{data.items === 0 ? "No todo list was made." : data.left.length ? `Not done: ${data.left.join("; ")}` : "Every task is completed."}</div>
              </div>
            );
          case "error":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">error</span>
                <div className="snippet">{data.message}</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function ToolsTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>env</th>
          <th>tools option</th>
          <th>todo tools in system/init</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>
              <code>{Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</code>
            </td>
            <td>
              <code>{Array.isArray(r.tools) ? `[${r.tools.join(", ")}]` : r.tools}</code>
            </td>
            <td>{r.error ? <code className="bad">{r.error}</code> : <code>{r.todoTools?.join(", ") || "none"}</code>}</td>
            <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept30TodoTracking() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [options, setOptions] = useState<{ prompt: string; options: unknown } | null>(null);
  const [toolsRows, setToolsRows] = useState<any[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Plan with your todo tool, then: write a haiku about milk to poem.txt, count its words into count.txt, and write the poem backwards to reversed.txt.");
  const [mode, setMode] = useState<"tasks" | "todo">("tasks");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c30/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c30 — is this sample's server running on port 3001?"));
  }, []);

  async function run(label: string, body: unknown, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    setBoard(null);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c30/run", body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data);
        if (event === "board") return setBoard(data);
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function checkTools() {
    setRunning("tools");
    setError(null);
    const rows: any[] = [];
    setToolsRows([]);
    try {
      await streamPost("/api/c30/tools", {}, (event, data) => {
        if (event === "toolsRow") setToolsRows((rows.push(data), [...rows]));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = events.filter((e) => e.event === "result").reduce((s, e) => s + e.data.cost, 0);
  const todoCalls = events.filter((e) => e.event === "toolUse" && todoTool(e.data.name) && e.data.name !== "ToolSearch").length;
  const button = (s: { id: string; label: string; hint: string }) => (
    <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, { scenario: s.id }, s.hint)}>
      {s.label}
    </button>
  );

  return (
    <section>
      <h2>30 · Todo tracking</h2>
      <p className="lead">
        On a job with several steps, the agent can keep a <b>todo list</b>: it writes the plan, marks a task <code>in_progress</code>, then{" "}
        <code>completed</code>. Claude Code has <b>two</b> todo tools: the <b>Task tools</b> (<code>TaskCreate</code>, <code>TaskUpdate</code>,{" "}
        <code>TaskList</code>, <code>TaskGet</code>), which keep each task in a JSON file, and the older <b>TodoWrite</b>, which rewrites the whole list on each
        call. This tab shows which one the model gets, what your code sees, and how the host can write the plan, check it and refuse changes to it.
      </p>

      <h3>A · Which todo tool, and when the model uses it</h3>
      <div className="row">
        <button disabled={!!running} className={running === "tools" ? "active" : ""} onClick={checkTools}>
          {running === "tools" ? "Checking…" : "0 · Which todo tools does each setup get?"}
        </button>
        <span className="subtype">5 short turns in parallel (“Reply ok”) · about $0.10 the first time (it writes the prompt cache), about $0.015 after</span>
      </div>
      {toolsRows.length > 0 && <ToolsTable rows={toolsRows} />}
      <div className="scenarios">{partA.map(button)}</div>

      <h3>B · The host owns the plan (Task tools)</h3>
      <p className="hint">
        The task files are plain JSON, so the host can write them, read them and change them. The hooks <code>TaskCreated</code> and <code>TaskCompleted</code>{" "}
        run before a change is saved, and can refuse it.
      </p>
      <div className="scenarios">{partB.map(button)}</div>

      <div className="card config">
        <label>your own job (the agent works in a fresh folder that holds prices.csv)</label>
        <textarea rows={3} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%" }} />
        <div className="row">
          <label className="check">
            <input type="radio" checked={mode === "tasks"} onChange={() => setMode("tasks")} /> Task tools
          </label>
          <label className="check">
            <input type="radio" checked={mode === "todo"} onChange={() => setMode("todo")} /> TodoWrite
          </label>
          <button className="primary" disabled={!!running || !prompt.trim()} onClick={() => run("custom", { scenario: "custom", prompt, mode }, null)}>
            {running === "custom" ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {(events.length > 0 || running) && running !== "tools" && (
        <>
          <TodoBoard board={board} />
          <div className="card">
            <b>Events</b>{" "}
            <span className="subtype">
              {running ? `running "${running}"…` : "done"} · {todoCalls} todo tool calls · ${cost.toFixed(4)}
            </span>
            <Timeline events={events} />
          </div>
        </>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["options", "board", "hooks", "seed", "check", "messages"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>D · Task tools vs TodoWrite</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th></th>
            <th>Task tools</th>
            <th>TodoWrite</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([k, a, b]) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>{a}</td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
