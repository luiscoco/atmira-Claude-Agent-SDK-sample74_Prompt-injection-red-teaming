import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type CallOut = { ok: boolean; value?: unknown; error?: string; ms: number };
type Catalog = ({ method: string; args: Record<string, unknown> } & CallOut)[];

// Must match MODELS and MODES in server/concepts/26-query-control.ts.
const MODELS = ["claude-haiku-4-5-20251001", "sonnet", "default"];
const MODES = ["default", "acceptEdits", "plan", "dontAsk"];
const ASK = ["initializationResult", "supportedModels", "supportedCommands", "supportedAgents", "mcpServerStatus", "accountInfo", "getContextUsage"];

// A scenario is a list of steps the browser runs against the live console: send a prompt, call a method, or wait
// for an event. args can be a function of what the session has shown so far (the last tool_use id, the last task id).
type Ctx = { lastToolUse?: string; lastTask?: string };
type Wait = "result" | "toolUse" | "taskStarted" | "taskEnded" | "ended";
type Step = { prompt: string } | { call: string; args?: Record<string, unknown> | ((c: Ctx) => Record<string, unknown>) } | { wait: Wait | number };
const matches: Record<Wait, (e: Ev) => boolean> = {
  result: (e) => e.event === "result",
  toolUse: (e) => e.event === "toolUse",
  taskStarted: (e) => e.event === "task" && e.data.subtype === "task_started",
  taskEnded: (e) => e.event === "task" && e.data.subtype === "task_notification",
  ended: (e) => e.event === "ended",
};

const scenarios: { label: string; hint: string; steps: Step[] }[] = [
  {
    label: "1 · Swap the model",
    hint: "Three one-word turns in ONE session. setModel('sonnet') between turns 1 and 2, back to Haiku before turn 3. Each setModel shows up as a user message with <local-command-stdout>, and the next turn's system/init names the new model. The session and its history stay the same. About $0.03.",
    steps: [
      { prompt: "Reply with one word: alpha" },
      { wait: "result" },
      { call: "setModel", args: { model: "sonnet" } },
      { prompt: "Reply with one word: beta" },
      { wait: "result" },
      { call: "setModel", args: { model: "claude-haiku-4-5-20251001" } },
      { prompt: "Reply with one word: gamma. Then say which words you replied before." },
      { wait: "result" },
    ],
  },
  {
    label: "2 · Flip the permission mode",
    hint: "The same Write in three modes. 'default': the lab's canUseTool denies it. setPermissionMode('acceptEdits'): the Write runs and canUseTool is never asked. 'plan': the model writes a plan instead of the file. Each change emits system/status with the new permissionMode. readFile() checks the result. About $0.01.",
    steps: [
      { prompt: "Use the Write tool to create a.txt containing: hello" },
      { wait: "result" },
      { call: "setPermissionMode", args: { mode: "acceptEdits" } },
      { prompt: "Try the same Write again now." },
      { wait: "result" },
      { call: "readFile", args: { path: "a.txt" } },
      { call: "setPermissionMode", args: { mode: "plan" } },
      { prompt: "Use the Write tool to create b.txt containing: hello" },
      { wait: "result" },
      { call: "readFile", args: { path: "b.txt" } },
      { call: "setPermissionMode", args: { mode: "default" } },
    ],
  },
  {
    label: "3 · Interrupt a slow command",
    hint: "The model runs `node slow.mjs 30` (one line per second). 3 seconds in, interrupt(): the tool call is rejected, the turn ends with result 'error_during_execution', and the SAME session answers the next prompt. About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 30`, then say done." },
      { wait: "toolUse" },
      { wait: 3000 },
      { call: "interrupt" },
      { wait: "result" },
      { prompt: "In one line: did the command finish?" },
      { wait: "result" },
    ],
  },
  {
    label: "4 · Send it to the background",
    hint: "`node slow.mjs 15` in the foreground. A foreground command only becomes a task about 3 s after it starts (task_started, is_backgrounded: false). Then backgroundTasks(toolUseId): task_updated is_backgrounded: true, the tool returns 'manually backgrounded' at once, and the turn ends while the command keeps running. About 12 s later its task_notification arrives, and Claude Code starts a NEW turn by itself, with no prompt, to tell the model. About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 15`, then tell me in one line what happened." },
      { wait: "taskStarted" },
      { call: "backgroundTasks", args: (c) => ({ toolUseId: c.lastToolUse }) },
      { wait: "result" },
      { wait: "taskEnded" },
      { wait: "result" },
    ],
  },
  {
    label: "5 · Stop a background task",
    hint: "The model starts `node slow.mjs 60` with run_in_background: true and the turn ends at once. stopTask(taskId) kills it: task_updated status 'killed', then task_notification status 'stopped'. No model call is needed to stop it. About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 60` with run_in_background set to true, then reply: started" },
      { wait: "result" },
      { wait: 2000 },
      { call: "stopTask", args: (c) => ({ taskId: c.lastTask ?? "" }) },
      { wait: "taskEnded" },
    ],
  },
  {
    label: "6 · Interrupt with a queued prompt",
    hint: "A second prompt is sent while the first turn is still running, so it waits in the input stream. interrupt() stops only the CURRENT turn: its receipt lists nothing in still_queued, and the queued prompt still runs right after. To drop it, don't send it. About $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 10`, then say done." },
      { wait: "toolUse" },
      { prompt: "Second message: reply with one word: queued" },
      { wait: 1500 },
      { call: "interrupt" },
      { wait: "result" },
      { wait: "result" },
    ],
  },
  {
    label: "7 · close() mid-turn",
    hint: "close() while a command runs: the message iterator just ends (no error, no result message), and the process is gone. After that, accountInfo() still answers (the SDK cached it at startup) but setModel() rejects with 'Query closed before response received'. Under $0.01.",
    steps: [
      { prompt: "Run the Bash command `node slow.mjs 20`, then say done." },
      { wait: "toolUse" },
      { wait: 2000 },
      { call: "close" },
      { wait: "ended" },
      { call: "accountInfo" },
      { call: "setModel", args: { model: "sonnet" } },
    ],
  },
];

// Part C: every method of Query, and where the lab shows it.
const methods: [string, string, string][] = [
  ["interrupt()", "End the current turn; the session stays open. Resolves to { still_queued }", "B · 3, 6 · Concept 10"],
  ["close()", "End the session and kill its process. The iterator just finishes", "B · 7"],
  ["setModel(model?)", "Next request uses this model. No argument: Claude Code's default model", "B · 1 · Concepts 12, 14"],
  ["setPermissionMode(mode)", "default · acceptEdits · plan · dontAsk · auto · bypassPermissions", "B · 2 · Concept 12"],
  ["backgroundTasks(toolUseId?)", "A running foreground Bash command or subagent stops blocking the turn", "B · 4"],
  ["stopTask(taskId)", "Kill a background task; emits task_notification 'stopped'", "B · 5"],
  ["initializationResult()", "What the session started with: commands, agents, models, account, output styles", "A · Concept 23"],
  ["supportedModels() / supportedCommands() / supportedAgents()", "The same lists, one at a time (cached at startup)", "A · Concepts 11, 14, 23"],
  ["accountInfo()", "Who is paying: apiKeySource, apiProvider, email for a Claude login", "A · B · 7"],
  ["mcpServerStatus()", "Each MCP server's status and tools", "A · Concepts 13, 23, 25"],
  ["getContextUsage({ detail })", "The context window, category by category", "A · Concepts 15, 22, 25"],
  ["readFile(path, { maxBytes, encoding })", "Read a file as the session sees it. null outside cwd or when denied", "A · B · 2"],
  ["applyFlagSettings(settings) / setMaxThinkingTokens(n)", "Change settings (effortLevel…) or thinking mid-session", "Concept 14"],
  ["setMcpServers() / toggleMcpServer() / reconnectMcpServer()", "Add, remove, disable or restart MCP servers mid-session", "Concept 13"],
  ["rewindFiles(userMessageId, { dryRun })", "Put files back as they were at a user message", "Concept 17"],
  ["reloadPlugins() / reloadSkills() / reloadOutputStyles()", "Re-read plugins, skills or output styles from disk", "Concept 23 (plugins)"],
  ["streamInput(stream)", "Feed more user messages (the prompt iterable does this)", "Concept 12"],
  ["updateSettings() · setMcpPermissionModeOverride() · seedReadState() · reinitialize() · readMcpResource() · usage_EXPERIMENTAL…()", "Niche or unstable: settings files, per-server modes, reconnecting hosts, MCP Apps, /usage data", "not in the lab"],
];

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));
const argText = (a: Record<string, unknown> | undefined) => (a && Object.keys(a).length ? JSON.stringify(a) : "");

function Value({ v }: { v: unknown }) {
  const s = fmt(v);
  if (s.length < 160) return <code>{s}</code>;
  return (
    <details>
      <summary className="subtype">{s.slice(0, 100).replaceAll("\n", " ")}…</summary>
      <pre className="wrap">{s}</pre>
    </details>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "call":
            return (
              <div key={i} className={`tool-call call ${data.ok ? "" : "denied"}`}>
                <span className="tag tag-call">{data.method === "prompt" ? "prompt" : `q.${data.method}(${argText(data.args)})`}</span> {t}
                {data.method === "prompt" ? (
                  <div className="snippet">{data.args.text}</div>
                ) : (
                  <div className="snippet">
                    {data.ok ? "→ " : "✗ "}
                    {data.ok ? <Value v={data.value} /> : data.error}
                    <span className="subtype">{data.ms} ms</span>
                  </div>
                )}
              </div>
            );
          case "init":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/init</span> <code>model: {data.model}</code> <code>permissionMode: {data.permissionMode}</code> {t}
              </div>
            );
          case "status":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/status</span> <code>permissionMode: {data.permissionMode}</code> {t}
              </div>
            );
          case "local":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-user">user (local command)</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-assistant">assistant</span> <span className="subtype">{data.model}</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-pre">tool_use {data.name}</span> <span className="subtype">{data.id}</span> {t}
                <div className="snippet">{JSON.stringify(data.input)}</div>
              </div>
            );
          case "canUseTool":
            return (
              <div key={i} className={`tool-call ${data.allowed ? "" : "denied"}`}>
                <span className="tag tag-post">canUseTool</span> <code>{data.tool}</code> {t}
                <div className="snippet">{data.allowed ? "allow" : "deny"}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> {data.is_error && <code>is_error</code>} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "task":
            return (
              <div key={i} className="tool-call task">
                <span className="tag tag-mcp-http">system/{data.subtype}</span> <code>{data.task_id}</code> {t}
                <div className="snippet">
                  {data.subtype === "task_started" && `${data.description} · is_backgrounded: ${data.is_backgrounded} · tool_use_id: ${data.tool_use_id}`}
                  {data.subtype === "task_updated" && `patch ${JSON.stringify(data.patch)}`}
                  {data.subtype === "task_notification" && `status: ${data.status}`}
                </div>
              </div>
            );
          case "result":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                <span className="subtype">
                  num_turns {data.num_turns} · stop_reason {String(data.stop_reason)} · total ${data.cost.toFixed(4)}
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

export function Concept26QueryControl() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [options, setOptions] = useState<unknown>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [text, setText] = useState("Run the Bash command `node slow.mjs 20`, then say done.");
  const [readPath, setReadPath] = useState("notes.txt");
  const [model, setModel] = useState(MODELS[1]);
  const [mode, setMode] = useState(MODES[1]);
  const [error, setError] = useState<string | null>(null);

  const evRef = useRef<Ev[]>([]);
  const idRef = useRef<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const cursor = useRef(0); // scenario waits only look at events after this index
  const waiter = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    const fail = () => setError("Could not reach /api/c26 — is this sample's server running on port 3001?");
    fetch("/api/c26/catalog")
      .then((r) => r.json())
      .then(setCatalog)
      .catch(fail);
    fetch("/api/c26/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(fail);
    return () => ctrlRef.current?.abort(); // leaving the tab closes the session (the server sees the disconnect)
  }, []);

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

  /** Opens a live session. Resolves with its id; the stream keeps running until the session ends. */
  function open(): Promise<string> {
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
        "/api/c26/open",
        {},
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
    const r = await fetch("/api/c26/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: idRef.current, method, args }) });
    const out = (await r.json()) as CallOut & { streamed?: boolean };
    if (!r.ok) setError(out.error ?? `HTTP ${r.status}`);
    else if (out.streamed === false) onEvent("call", { method, args: args ?? {}, ...out }); // the session's stream has ended
    return out;
  }

  /** Waits for the first event after the cursor that matches, including one that already arrived. */
  function waitFor(name: string, test: (e: Ev) => boolean, ms = 120_000): Promise<void> {
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
    return { lastToolUse: last((e) => e.event === "toolUse")?.id, lastTask: last((e) => e.event === "task" && e.data.subtype === "task_started")?.task_id };
  };

  async function runScenario(s: (typeof scenarios)[number]) {
    setRunning(s.label);
    setHint(s.hint);
    try {
      if (live) ctrlRef.current?.abort(); // a fresh session for each scenario
      await open();
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
    model: last((e) => e.event === "init")?.model ?? (options as any)?.model,
    permissionMode: last((e) => e.event === "status" || e.event === "init")?.permissionMode ?? "default",
    cost: last((e) => e.event === "result")?.cost as number | undefined,
    lastToolUse: last((e) => e.event === "toolUse")?.id as string | undefined,
    lastTask: last((e) => e.event === "task" && e.data.subtype === "task_started")?.task_id as string | undefined,
  };
  const can = live && !!sessionId && !running;

  return (
    <section>
      <h2>26 · Query control methods</h2>
      <p className="lead">
        <code>query()</code> returns a <b>Query</b>: an async iterator of messages, and also a <b>remote control</b>. Its methods send control requests to
        the running Claude Code process: ask it what it has, change its model or permission mode, stop a turn, move a command to the background, kill a
        task, or end the session. They need streaming input (Concept 12), because the process has to stay alive between turns.
      </p>

      <h3>A · Ask a session that has not said anything</h3>
      <p className="hint">
        The "ask" methods on a session whose prompt never sends a message, so <b>no model call is made</b>. The first call waits for the session to
        start; the lists after it come from the answer to the SDK's <code>initialize</code> request and take 0 ms. <code>readFile</code> is a real round
        trip, and returns <code>null</code> for a path outside the cwd.
      </p>
      {catalog && (
        <table className="tools compare">
          <tbody>
            {catalog.map((c, i) => (
              <tr key={i}>
                <td>
                  <code>
                    q.{c.method}({argText(c.args)})
                  </code>
                </td>
                <td className="subtype">{c.ms} ms</td>
                <td>{c.ok ? <Value v={c.value} /> : <span className="subtype bad">{c.error}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!catalog && !error && <p className="hint">Starting a silent session and asking it…</p>}

      <h3>B · Drive a live session</h3>
      <p className="hint">
        One session with Haiku in <code>control-lab/work</code> (tools: Read, Write, Bash). The lab's <code>canUseTool</code> allows only{" "}
        <code>node slow.mjs N</code>, a script that prints one line per second. Open a session, send prompts, and call any method at any time: before a
        turn, during a tool call, or after the session has ended. Or run a scenario, which does the same clicks for you.
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
            <button className="primary" disabled={!!running} onClick={() => open().catch(() => {})}>
              Open a session
            </button>
          ) : (
            <button onClick={() => ctrlRef.current?.abort()} title="Disconnects the stream; the server's abortController ends the session">
              Disconnect
            </button>
          )}
          <span className="subtype">
            {live ? `session ${sessionId ?? "…"} · open` : sessionId ? `session ${sessionId} · ended` : "no session"}
            {state.model && ` · model ${state.model}`} · permissionMode {state.permissionMode}
            {state.cost !== undefined && ` · $${state.cost.toFixed(4)}`}
            {running && ` · running "${running}"`}
          </span>
        </div>

        <label>prompt (written to the input stream: not a control method)</label>
        <div className="row">
          <input value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, margin: 0 }} />
          <button disabled={!can || !text.trim()} onClick={() => call("prompt", { text })}>
            Send
          </button>
        </div>

        <label>ask</label>
        <div className="row">
          {ASK.map((m) => (
            <button key={m} disabled={!sessionId || !!running} onClick={() => call(m)}>
              {m}()
            </button>
          ))}
          <span>
            <button disabled={!sessionId || !!running} onClick={() => call("readFile", { path: readPath })}>
              readFile(
            </button>
            <input value={readPath} onChange={(e) => setReadPath(e.target.value)} style={{ width: 150, margin: "0 4px", padding: "4px 6px" }} />)
          </span>
        </div>

        <label>steer (from the next request on)</label>
        <div className="row">
          <button disabled={!sessionId || !!running} onClick={() => call("setModel", { model })}>
            setModel(
          </button>
          <select className="inline" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m === "default" ? "undefined → default model (Opus, pricier)" : m}
              </option>
            ))}
          </select>
          )
          <button disabled={!sessionId || !!running} onClick={() => call("setPermissionMode", { mode })}>
            setPermissionMode(
          </button>
          <select className="inline" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          )
        </div>

        <label>stop</label>
        <div className="row">
          <button disabled={!sessionId || !!running} onClick={() => call("interrupt")}>
            interrupt()
          </button>
          <button disabled={!sessionId || !!running} onClick={() => call("backgroundTasks", state.lastToolUse ? { toolUseId: state.lastToolUse } : {})}>
            backgroundTasks({state.lastToolUse ? "last tool_use" : ""})
          </button>
          <button disabled={!sessionId || !!running} onClick={() => call("backgroundTasks")}>
            backgroundTasks()
          </button>
          <button disabled={!sessionId || !!running || !state.lastTask} onClick={() => call("stopTask", { taskId: state.lastTask })}>
            stopTask({state.lastTask ?? "no task yet"})
          </button>
          <button disabled={!sessionId || !!running} onClick={() => call("close")}>
            close()
          </button>
        </div>
      </div>

      {events.length > 0 && (
        <div className="card">
          <b>Events</b> <span className="subtype">control calls (orange) between the messages they caused</span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">options sent to query()</summary>
          <pre className="wrap">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}
      <div className="row">
        {["methods", "canUseTool", "options", "messages"].map(
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

      <h3>C · Every method of Query</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>method</th>
            <th>what it does</th>
            <th>where</th>
          </tr>
        </thead>
        <tbody>
          {methods.map(([m, what, where]) => (
            <tr key={m}>
              <td>
                <code>{m}</code>
              </td>
              <td>{what}</td>
              <td>{where}</td>
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
