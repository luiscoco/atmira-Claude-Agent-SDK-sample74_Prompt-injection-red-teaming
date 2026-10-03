import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type CallOut = { ok: boolean; value?: unknown; error?: string; ms: number };
type Profile = { disableBackground?: boolean; perTaskStopAffordance?: boolean };

// A scenario opens a session with a profile, then runs steps against it: send a prompt, call a method, or wait for
// an event. args can be a function of what the session has shown so far.
type Ctx = { lastToolUse?: string; lastAgentTask?: string };
type Wait = "result" | "taskStarted" | "fgBash" | "bgEmpty" | "ended";
type Step = { prompt: string } | { call: string; args?: Record<string, unknown> | ((c: Ctx) => Record<string, unknown>) } | { wait: Wait | number };
const matches: Record<Wait, (e: Ev) => boolean> = {
  result: (e) => e.event === "result",
  taskStarted: (e) => e.event === "task" && e.data.subtype === "task_started",
  // the main thread's own foreground Bash command (not the subagent's)
  fgBash: (e) => e.event === "task" && e.data.subtype === "task_started" && e.data.task_type === "local_bash" && e.data.is_backgrounded === false && !e.data.owned_by_subagent,
  bgEmpty: (e) => e.event === "bgSet" && e.data.tasks.length === 0,
  ended: (e) => e.event === "ended",
};

const scenarios: { label: string; hint: string; profile?: Profile; steps: Step[] }[] = [
  {
    label: "1 · run_in_background",
    hint: "The MODEL asks for the background: Bash with run_in_background: true. The tool returns at once with a task id and an output file, and the turn ends. 4 s later a second prompt asks the model to Read that file: it sees the ticks so far. When the command ends, task_notification arrives and Claude Code starts a turn BY ITSELF, with no prompt. About $0.02.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 12` with run_in_background set to true. Then reply: started" },
      { wait: "result" },
      { wait: 4000 },
      { prompt: "Read the background task's output file with the Read tool and tell me its last tick line. One line." },
      { wait: "result" },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "2 · A timeout moves it",
    hint: "A FOREGROUND Bash call with timeout: 3000. The command does not fail when the timeout hits: it is moved to the background (tool_use_result.timedOutAfterMs: 3000) and keeps running. Its end starts a turn by itself, like scenario 1. About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 10` with the timeout parameter set to 3000 (milliseconds), NOT in the background. Then tell me in one line what happened." },
      { wait: "result" },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "3 · A background subagent",
    hint: "The 'waiter' agent is defined with background: true, so the Agent tool returns 'Async agent launched' at once and the turn ends. The subagent's own Bash is a second task (owned_by_subagent, in the foreground of the SUBAGENT). agentProgressSummaries: true adds a task_progress with an AI summary about every 30 s. About 55 s, $0.02.",
    steps: [
      { prompt: "Use the waiter agent to run `node slow.mjs 40`. While it works, reply: delegated" },
      { wait: "result" },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "4 · Monitor: one turn per line",
    hint: "The Monitor tool runs a command in the background and turns EACH stdout line into an event for the model. Every event starts a new turn: count the result rows. Lines less than 200 ms apart are batched. Cheap here with 3 lines; a chatty command would cost a turn per line. About $0.01.",
    steps: [
      { prompt: "Use the Monitor tool with command `node slow.mjs 3` and timeout_ms 60000. Reply: watching. For each event you get, reply with one short line." },
      { wait: "result" },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "5 · The model stops it (TaskStop)",
    hint: "The model starts `node slow.mjs 60` in the background, then is asked to stop it. It calls its own TaskStop tool with the task id: task_updated 'killed', task_notification 'stopped'. That notification can start one more short turn. (Concept 26 did the same from the host with q.stopTask.) About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 60` with run_in_background set to true. Then reply: started" },
      { wait: "result" },
      { wait: 3000 },
      { prompt: "Stop that background task now with the TaskStop tool. Reply in one line." },
      { wait: "bgEmpty" },
      { wait: "result" },
      { wait: 3000 },
    ],
  },
  {
    label: "6 · interrupt(): who survives?",
    hint: "Three tasks: a background subagent, a background Bash and a foreground Bash. interrupt() during the foreground one: the foreground Bash is stopped (it belongs to the turn), the background Bash KEEPS RUNNING, and the background subagent is KILLED, because this session did not declare perTaskStopAffordance. Watch the Tasks panel. When the background Bash ends, its notification turn often makes the model RUN THE INTERRUPTED COMMAND AGAIN: a task can undo your Stop. About 45 s, $0.02.",
    steps: [
      { prompt: "Do these three things: 1) use the waiter agent to run `node slow.mjs 30`; 2) run the Bash command `node slow.mjs 15` with run_in_background set to true; 3) then run the Bash command `node slow.mjs 20` in the foreground. Then say done." },
      { wait: "fgBash" },
      { wait: 2000 },
      { call: "interrupt" },
      { wait: "result" },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "7 · …with perTaskStopAffordance",
    hint: "The same three tasks, in a session opened with perTaskStopAffordance: true ('my UI has a stop button per task'). Now interrupt() spares the background subagent too. Then the host stops it itself with q.stopTask(agent task id). Each notification (the stop, the Bash end) starts a turn by itself. About 45 s, $0.02.",
    profile: { perTaskStopAffordance: true },
    steps: [
      { prompt: "Do these three things: 1) use the waiter agent to run `node slow.mjs 30`; 2) run the Bash command `node slow.mjs 15` with run_in_background set to true; 3) then run the Bash command `node slow.mjs 20` in the foreground. Then say done." },
      { wait: "fgBash" },
      { wait: 2000 },
      { call: "interrupt" },
      { wait: "result" },
      { wait: 3000 },
      { call: "stopTask", args: (c) => ({ taskId: c.lastAgentTask ?? "" }) },
      { wait: "bgEmpty" },
      { wait: "result" },
    ],
  },
  {
    label: "8 · Background disabled",
    hint: "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 in env. The Bash tool loses its run_in_background parameter, so the same request runs in the foreground and blocks the turn (the model says the parameter does not exist). q.backgroundTasks() throws 'Background tasks are disabled in this session.' About $0.01.",
    profile: { disableBackground: true },
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 4` with run_in_background set to true. Then tell me in one line what happened." },
      { wait: "result" },
      { call: "backgroundTasks" },
    ],
  },
];

// Part D: every way a task starts and ends.
const lifecycle: [string, string, string][] = [
  ["Bash run_in_background: true", "The model asks for it. Returns at once with the task id and the output file", "1, 5, 6"],
  ["Bash timeout", "A foreground command that runs past its timeout is moved to the background (timedOutAfterMs)", "2"],
  ["Agent (background: true, or run_in_background)", "A subagent that runs next to the conversation. task_type local_agent", "3, 6, 7"],
  ["Monitor", "A background command whose every stdout line is an event: one turn each", "4"],
  ["q.backgroundTasks(toolUseId?)", "The host moves a running foreground command or subagent (Ctrl+B)", "Concept 26"],
  ["completed / failed", "task_notification → Claude Code starts a turn by itself", "1–4"],
  ["TaskStop tool", "The model stops a task by id", "5"],
  ["q.stopTask(taskId)", "The host stops a task by id", "7 · Concept 26"],
  ["q.interrupt()", "Stops the turn and its foreground task. Background Bash survives; background agents die unless perTaskStopAffordance", "6, 7"],
  ["end of a one-shot run", "A string prompt closes the input: background tasks are killed once the result is out", "A"],
  ["q.close() / abort", "The process ends and every task with it", "Concept 26"],
];

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const argText = (a: Record<string, unknown> | undefined) => (a && Object.keys(a).length ? JSON.stringify(a) : "");

type TaskRow = { task_id: string; task_type?: string; description?: string; status: string; is_backgrounded?: boolean; owned_by_subagent?: boolean; summary?: string; usage?: any };

/** The task map, merged from the edges (task_started, task_updated, task_progress, task_notification). */
function taskMap(events: Ev[]): TaskRow[] {
  const map = new Map<string, TaskRow>();
  for (const { event, data } of events) {
    if (event !== "task") continue;
    const row: TaskRow = map.get(data.task_id) ?? { task_id: data.task_id, status: "running" };
    if (data.subtype === "task_started") Object.assign(row, { task_type: data.task_type, description: data.description, is_backgrounded: data.is_backgrounded, owned_by_subagent: data.owned_by_subagent });
    if (data.subtype === "task_updated") {
      if (data.patch.status) row.status = data.patch.status;
      if (data.patch.is_backgrounded !== undefined) row.is_backgrounded = data.patch.is_backgrounded;
    }
    if (data.subtype === "task_progress") Object.assign(row, { summary: data.summary ?? row.summary, usage: data.usage });
    if (data.subtype === "task_notification") Object.assign(row, { status: data.status, usage: data.usage ?? row.usage });
    map.set(data.task_id, row);
  }
  return [...map.values()];
}

function TasksPanel({ events }: { events: Ev[] }) {
  const level = [...events].reverse().find((e) => e.event === "bgSet")?.data.tasks as { task_id: string; task_type: string; description: string }[] | undefined;
  const rows = taskMap(events);
  if (!rows.length && !level) return null;
  return (
    <div className="card compare-grid bg-panel">
      <div>
        <b>Live background set</b> <span className="subtype">last background_tasks_changed (replace)</span>
        {!level?.length && <p className="hint">{level ? "empty: nothing runs in the background" : "none received yet"}</p>}
        {level?.map((t) => (
          <div key={t.task_id} className="tool-call task">
            <span className="tag tag-mcp-http">{t.task_type}</span> <code>{t.task_id}</code>
            <div className="snippet">{t.description}</div>
          </div>
        ))}
      </div>
      <div>
        <b>Every task</b> <span className="subtype">merged from task_* edges</span>
        {rows.map((t) => (
          <div key={t.task_id} className="tool-call task">
            <span className="tag tag-mcp-http">{t.task_type ?? "?"}</span> <code>{t.task_id}</code> <span className={`tag st-${t.status}`}>{t.status}</span>{" "}
            <span className="subtype">
              {t.is_backgrounded ? "background" : "foreground"}
              {t.owned_by_subagent && " · owned by subagent"}
            </span>
            <div className="snippet">
              {t.description}
              {t.summary && ` — “${t.summary}”`}
              {t.usage && ` · ${t.usage.tool_uses} tool uses, ${(t.usage.duration_ms / 1000).toFixed(0)} s`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  let turns = 0;
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        const sub = data.sub ? <span className="tag tag-sub">subagent</span> : null;
        switch (event) {
          case "call":
            return (
              <div key={i} className={`tool-call call ${data.ok ? "" : "denied"}`}>
                <span className="tag tag-call">{data.method === "prompt" ? "prompt" : `q.${data.method}(${argText(data.args)})`}</span> {t}
                <div className="snippet">{data.method === "prompt" ? data.args.text : `${data.ok ? "→ " + fmt(data.value) : "✗ " + data.error}  (${data.ms} ms)`}</div>
              </div>
            );
          case "init": {
            // A turn with no prompt sent since the previous turn started was started by a task, not by you.
            const before = events.slice(0, i);
            const prevInit = before.map((e) => e.event).lastIndexOf("init");
            const auto = turns > 0 && !before.slice(prevInit + 1).some((e) => e.event === "call" && e.data.method === "prompt");
            turns++;
            return (
              <div key={i} className={`tool-call ${auto ? "auto-turn" : ""}`}>
                <span className="tag tag-system">system/init</span> <code>turn {turns}</code> {auto && <b className="subtype bad">started by a task notification, not a prompt</b>} {t}
              </div>
            );
          }
          case "bgSet":
            return (
              <div key={i} className="tool-call task level">
                <span className="tag tag-mcp-http">system/background_tasks_changed</span> {t}
                <div className="snippet">[{data.tasks.map((x: any) => `${x.task_id} (${x.task_type})`).join(", ")}]</div>
              </div>
            );
          case "task":
            return (
              <div key={i} className="tool-call task">
                <span className="tag tag-mcp-http">system/{data.subtype}</span> <code>{data.task_id}</code> {t}
                <div className="snippet">
                  {data.subtype === "task_started" &&
                    `${data.task_type}${data.subagent_type ? ` (${data.subagent_type})` : ""} · is_backgrounded: ${data.is_backgrounded}${data.owned_by_subagent ? " · owned_by_subagent" : ""} · ${data.description}`}
                  {data.subtype === "task_updated" && `patch ${JSON.stringify(data.patch)}`}
                  {data.subtype === "task_progress" && `${data.summary ? `summary: “${data.summary}” · ` : ""}last tool ${data.last_tool_name ?? "–"} · ${data.usage.total_tokens} tokens`}
                  {data.subtype === "task_notification" && `status: ${data.status}${data.output_file ? ` · ${data.output_file}` : ""}`}
                </div>
              </div>
            );
          case "stopHook":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-post">Stop hook</span> {t}
                <div className="snippet">background_tasks: {data.background_tasks.length ? data.background_tasks.map((b: any) => `${b.id} ${b.type} ${b.status}`).join(", ") : "[]"}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={i} className={`tool-call ${data.sub ? "observer" : ""}`}>
                <span className="tag tag-assistant">assistant</span> {sub} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className={`tool-call ${data.sub ? "observer" : ""}`}>
                <span className="tag tag-pre">tool_use {data.name}</span> {sub} {t}
                <div className="snippet">{JSON.stringify(data.input)}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""} ${data.sub ? "observer" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> {sub} {data.is_error && <code>is_error</code>}{" "}
                {Object.keys(data.meta).length > 0 && <code>{JSON.stringify(data.meta)}</code>} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolProgress":
            return (
              <div key={i} className="tool-call observer">
                <span className="tag">tool_progress</span> <code>{data.tool_name}</code> {sub} <span className="subtype">{data.elapsed} s</span> {t}
              </div>
            );
          case "canUseTool":
            return data.allowed ? null : (
              <div key={i} className="tool-call denied">
                <span className="tag tag-post">canUseTool</span> <code>{data.tool}</code> deny {t}
              </div>
            );
          case "result":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                <span className="subtype">
                  num_turns {data.num_turns} · total ${data.cost.toFixed(4)}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "ended":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-error">session ended</span> <code>{data.how}</code> {t}
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

export function Concept27BackgroundTasks() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [oneshot, setOneshot] = useState<Ev[] | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [options, setOptions] = useState<unknown>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [text, setText] = useState("Run the Bash command `node slow.mjs 20` with run_in_background set to true. Then reply: started");
  const [profile, setProfile] = useState<Profile>({});
  const [error, setError] = useState<string | null>(null);

  const evRef = useRef<Ev[]>([]);
  const idRef = useRef<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const cursor = useRef(0);
  const waiter = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    fetch("/api/c27/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c27 — is this sample's server running on port 3001?"));
    return () => ctrlRef.current?.abort();
  }, []);

  async function runOneshot() {
    setRunning("one-shot");
    const got: Ev[] = [];
    setOneshot([]);
    try {
      await streamPost("/api/c27/oneshot", {}, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data.options);
        got.push({ event, data });
        setOneshot([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  function onEvent(event: string, data: any) {
    if (event === "done") return;
    if (event === "opened") {
      idRef.current = data.id;
      setSessionId(data.id);
      setOptions(data.options);
    }
    evRef.current = [...evRef.current, { event, data }];
    setEvents(evRef.current);
    waiter.current?.();
  }

  function open(p: Profile): Promise<string> {
    evRef.current = [];
    idRef.current = null;
    cursor.current = 0;
    setEvents([]);
    setError(null);
    setLive(true);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    return new Promise((resolve, reject) => {
      streamPost(
        "/api/c27/open",
        p,
        (event, data) => {
          onEvent(event, data);
          if (event === "opened") resolve(data.id);
          if (event === "error" && !idRef.current) reject(new Error(data.message));
        },
        ctrl.signal,
      )
        .catch((err) => {
          if (!ctrl.signal.aborted) setError(String(err));
          reject(err);
        })
        .finally(() => {
          if (ctrlRef.current === ctrl) setLive(false);
        });
    });
  }

  async function call(method: string, args?: Record<string, unknown>): Promise<CallOut> {
    const r = await fetch("/api/c27/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: idRef.current, method, args }) });
    const out = (await r.json()) as CallOut & { streamed?: boolean };
    if (!r.ok) setError(out.error ?? `HTTP ${r.status}`);
    else if (out.streamed === false) onEvent("call", { method, args: args ?? {}, ...out });
    return out;
  }

  function waitFor(name: string, test: (e: Ev) => boolean, ms = 150_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        const i = evRef.current.findIndex((e, k) => k >= cursor.current && test(e));
        if (i < 0) return false;
        cursor.current = i + 1;
        waiter.current = null;
        clearTimeout(timer);
        resolve();
        return true;
      };
      if (check()) return;
      waiter.current = check;
      timer = setTimeout(() => {
        waiter.current = null;
        reject(new Error(`Timed out waiting for ${name}.`));
      }, ms);
    });
  }

  const ctx = (): Ctx => {
    const last = (f: (e: Ev) => boolean) => [...evRef.current].reverse().find(f)?.data;
    return {
      lastToolUse: last((e) => e.event === "toolUse" && !e.data.sub)?.id,
      lastAgentTask: last((e) => e.event === "task" && e.data.subtype === "task_started" && e.data.task_type === "local_agent")?.task_id,
    };
  };

  async function runScenario(s: (typeof scenarios)[number]) {
    setRunning(s.label);
    setHint(s.hint);
    const p = s.profile ?? {};
    setProfile(p);
    try {
      if (live) ctrlRef.current?.abort();
      await open(p);
      for (const step of s.steps) {
        if ("wait" in step) {
          if (typeof step.wait === "number") await new Promise((r) => setTimeout(r, step.wait as number));
          else await waitFor(step.wait, matches[step.wait]);
          continue;
        }
        cursor.current = evRef.current.length;
        if ("prompt" in step) await call("prompt", { text: step.prompt });
        else await call(step.call, typeof step.args === "function" ? step.args(ctx()) : step.args);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const last = (f: (e: Ev) => boolean) => [...events].reverse().find(f)?.data;
  const state = {
    cost: last((e) => e.event === "result")?.cost as number | undefined,
    lastToolUse: ctx().lastToolUse,
    tasks: taskMap(events).filter((t) => t.status === "running"),
  };
  const can = live && !!sessionId && !running;

  return (
    <section>
      <h2>27 · Background tasks</h2>
      <p className="lead">
        A <b>task</b> is a Bash command, a subagent or a Monitor that Claude Code runs <b>next to</b> the conversation. The turn ends, the task keeps
        running, and when it settles Claude Code <b>starts a new turn by itself</b> to tell the model. This tab follows a task's whole life: who starts
        it, how your code sees it, how the model hears about it, and every way it can end.
      </p>

      <h3>A · One-shot: the run ends, and the task with it</h3>
      <p className="hint">
        A <b>string</b> prompt: <code>query({"{ prompt: \"Run node slow.mjs 15 with run_in_background…\" }"})</code>. The result arrives at once, the Stop
        hook sees the task still running, and then the task is <b>killed</b> (<code>status: stopped</code>): with the input closed nothing could ever hear
        about it. For background work you need streaming input (Part B). About $0.01.
      </p>
      <div className="row">
        <button className="primary" disabled={!!running} onClick={runOneshot}>
          {running === "one-shot" ? "Running…" : "Run the one-shot"}
        </button>
      </div>
      {oneshot && (
        <div className="card">
          <Timeline events={oneshot} />
        </div>
      )}

      <h3>B · A live session and its tasks</h3>
      <p className="hint">
        Haiku in <code>bg-lab/work</code> with the tools Read, Bash, Agent, Monitor and TaskStop, and a <code>waiter</code> agent defined with{" "}
        <code>background: true</code>. <code>canUseTool</code> allows only <code>node slow.mjs N</code> (one line per second), Read inside{" "}
        <code>bg-lab</code>, the waiter and TaskStop. Each scenario opens a fresh session and clicks for you; the Tasks panel updates from the stream.
      </p>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.label} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => runScenario(s)}>
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <div className="card config">
        <div className="row">
          {!live ? (
            <>
              <button className="primary" disabled={!!running} onClick={() => open(profile).catch(() => {})}>
                Open a session
              </button>
              <label className="check">
                <input type="checkbox" checked={!!profile.perTaskStopAffordance} onChange={(e) => setProfile({ ...profile, perTaskStopAffordance: e.target.checked })} />
                perTaskStopAffordance
              </label>
              <label className="check">
                <input type="checkbox" checked={!!profile.disableBackground} onChange={(e) => setProfile({ ...profile, disableBackground: e.target.checked })} />
                CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
              </label>
            </>
          ) : (
            <button onClick={() => ctrlRef.current?.abort()}>Disconnect</button>
          )}
          <span className="subtype">
            {live ? `session ${sessionId ?? "…"} · open` : sessionId ? `session ${sessionId} · ended` : "no session"}
            {state.cost !== undefined && ` · $${state.cost.toFixed(4)}`}
            {running && running !== "one-shot" && ` · running "${running}"`}
          </span>
        </div>
        <label>prompt</label>
        <div className="row">
          <input value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, margin: 0 }} />
          <button disabled={!can || !text.trim()} onClick={() => call("prompt", { text })}>
            Send
          </button>
        </div>
        <label>host controls (Concept 26)</label>
        <div className="row">
          <button disabled={!sessionId || !!running} onClick={() => call("backgroundTasks", state.lastToolUse ? { toolUseId: state.lastToolUse } : {})}>
            backgroundTasks({state.lastToolUse ? "last tool_use" : ""})
          </button>
          {state.tasks.map((t) => (
            <button key={t.task_id} disabled={!sessionId || !!running} onClick={() => call("stopTask", { taskId: t.task_id })}>
              stopTask({t.task_id})
            </button>
          ))}
          <button disabled={!sessionId || !!running} onClick={() => call("interrupt")}>
            interrupt()
          </button>
          <button disabled={!sessionId || !!running} onClick={() => call("close")}>
            close()
          </button>
        </div>
      </div>

      <TasksPanel events={events} />
      {events.length > 0 && (
        <div className="card">
          <b>Events</b> <span className="subtype">teal: tasks · orange: your calls · faded: the subagent's own messages</span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">options sent to query()</summary>
          <pre className="wrap">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["options", "canUseTool", "messages"].map(
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

      <h3>D · How a task starts and ends</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>what</th>
            <th>effect</th>
            <th>scenario</th>
          </tr>
        </thead>
        <tbody>
          {lifecycle.map(([w, e, s]) => (
            <tr key={w}>
              <td>
                <code>{w}</code>
              </td>
              <td>{e}</td>
              <td>{s}</td>
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
