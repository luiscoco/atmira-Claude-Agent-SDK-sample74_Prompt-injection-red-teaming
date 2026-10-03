import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type State = { host: { work: string[]; sessions: number }; box: { work: string[]; sessions: number }; runner: { pid: number } | null };
type Ev = { event: string; data: any };

const RUN_PROMPT = "Call the roll tool once. Then write the number it returned into roll.txt. Then reply with one short line.";
const ALIAS_PROMPT = "Use the Bash tool to run exactly: cat where.txt — then reply with only the file content.";
const TOOLS = ["Read", "Write", "Bash"] as const;

// Part H: the summary table.
const table: [string, string, string][] = [
  ["Take over the spawn", "spawnClaudeCodeProcess: (o: SpawnOptions) => SpawnedProcess", "Called once per query(), instead of the SDK's local spawn. Whatever you return is the process the SDK talks to"],
  ["What you receive", "SpawnOptions: { command, args, cwd, env, signal }", "command: the platform package's native binary. args: the CLI flags built from your options (always --output-format stream-json --verbose --input-format stream-json). env: options.env + CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION, without NODE_OPTIONS"],
  ["Not in args", "systemPrompt, SDK MCP servers, canUseTool, hooks…", "They travel over stdin in the first line, control_request/initialize, or come back later as control_requests. Your spawner does not have to carry them"],
  ["What you return", "SpawnedProcess: stdin, stdout, killed, exitCode, kill(), on/once/off('exit' | 'error')", "A ChildProcess is one. So is any object with these members: a socket to a container, a VM API, an SSH channel"],
  ["stderr", "options.stderr", "Only called for the SDK's own spawn. With your spawner, read stderr yourself; the SDK's 'exited with code N' error then has no stderr tail"],
  ["Stopping", "abortController.abort()", "The SDK ends stdin at once. If the process is still running 2 s later: POSIX kill('SIGTERM'), then SIGKILL 5 s later; Windows kill('SIGKILL') after 5 s more. SpawnOptions.signal fires with that kill"],
  ["Your tools stay home", "createSdkMcpServer, canUseTool, hooks", "Their calls come up stdout as control_requests (mcp_message, can_use_tool) and the answers go down stdin: they run in the host process wherever Claude Code runs"],
  ["Redirect a built-in tool", "toolAliases: { Bash: 'mcp__box__bash' }", "The model still sees and calls Bash (with Bash's input schema); the call runs your tool. canUseTool sees the target name. Single hop, no chains"],
  ["Debug log", "debug: true · debugFile: path", "debug: true → CLAUDE_CONFIG_DIR/debug/<session id>.txt; debugFile writes where you say (and turns debug on). Neither writes to stderr"],
  ["Runtime flags", "executableArgs", "Put before every flag. For a JavaScript cli.js (node cli.js) they are node's flags; with the native binary Claude Code rejects unknown ones"],
  ["With a session store", "sessionStore + a spawner", "The SDK mirrors a line only if its file is under the CLAUDE_CONFIG_DIR it knows. A box with its own config dir silently mirrors nothing: keep the same path in both"],
];

const kindTag = (k: string) => (k.startsWith("control") ? "tag-wire" : k.startsWith("result") ? "tag-result" : k.startsWith("system") ? "tag-system" : k.startsWith("assistant") ? "tag-assistant" : "tag-user");

function Machines({ s }: { s: State }) {
  const list = (fs: string[]) => (fs.length ? fs.join(", ") : "empty");
  return (
    <div className="store-panel">
      <div className="card store-machine">
        <b>The host</b> <span className="subtype">this server · cwd spawn-lab/host/work</span>
        <div className="hint">work: {list(s.host.work)}</div>
        <div className="hint">transcripts in its CLAUDE_CONFIG_DIR: {s.host.sessions}</div>
      </div>
      <div className="card store-machine spawn-box">
        <b>The box</b> <span className="subtype">36-runner.mjs · {s.runner ? `running, pid ${s.runner.pid}` : "not started yet"}</span>
        <div className="hint">work: {list(s.box.work)}</div>
        <div className="hint">transcripts in its CLAUDE_CONFIG_DIR: {s.box.sessions}</div>
      </div>
    </div>
  );
}

function Timeline({ events, frames }: { events: Ev[]; frames: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(2)} s</span> : null;
        if (event === "frame") {
          if (!frames) return null;
          return (
            <div key={i} className={`tool-call wire-frame ${data.dir}`}>
              <span className="wire-dir">{data.dir === "in" ? "SDK → stdin" : "stdout → SDK"}</span> <span className={`tag ${kindTag(data.kind)}`}>{data.kind}</span> {t}{" "}
              <button className="link" onClick={() => setOpen(open === i ? null : i)}>
                {data.bytes} B
              </button>
              {data.detail && <div className="snippet">{data.detail}</div>}
              {open === i && <pre className="wrap store-lines">{data.json}</pre>}
            </div>
          );
        }
        if (event === "msg")
          return (
            <div key={i} className={`tool-call ${data.bad ? "denied" : ""}`}>
              <span className="tag tag-result">query() yields</span> <b>{data.kind}</b> {t}
              <div className="snippet">{data.detail}</div>
            </div>
          );
        if (event === "spawn")
          return (
            <div key={i} className="tool-call verdict">
              <span className="tag tag-verdict">spawnClaudeCodeProcess(o)</span> {t}
              <div className="snippet">
                command {data.command} · {data.args} args · cwd {data.cwd}
              </div>
            </div>
          );
        if (event === "runner")
          return (
            <div key={i} className="tool-call spawn-runner">
              <span className="tag tag-runner">runner</span> {t}
              <div className="snippet">{data.line}</div>
            </div>
          );
        if (event === "permission")
          return (
            <div key={i} className="tool-call observer">
              <span className="tag tag-ask">canUseTool, on the host</span> <b>{data.tool}</b> → {data.decision} {t}
              <div className="snippet">{data.input}</div>
            </div>
          );
        if (event === "hostTool")
          return (
            <div key={i} className="tool-call observer">
              <span className="tag tag-mcp-stdio">host tool ran</span> <b>{data.tool}</b> → {data.result} {t}
              <div className="snippet">in {data.ranIn}</div>
            </div>
          );
        if (event === "stderr")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-error">stderr</span> {t}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "outcome")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">after the session</span> <span className="subtype">ran in: {data.where === "box" ? "the box" : "the host"}</span>
              {data.text && <div className="answer thin">{data.text}</div>}
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span>
              <div className="snippet">{data.message}</div>
            </div>
          );
        return null;
      })}
    </div>
  );
}

function DryResult({ d }: { d: any }) {
  if (d.error) return <div className="snippet bad">{d.error}</div>;
  return (
    <div className="card">
      <b>SpawnOptions</b> <span className="subtype">what the SDK passed to the spawner · no process, no API call</span>
      <table className="tools compare">
        <tbody>
          <tr>
            <td>
              <code>command</code>
            </td>
            <td colSpan={2}>
              <code>{d.command}</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>cwd</code>
            </td>
            <td colSpan={2}>
              <code>{d.cwd}</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>signal</code>
            </td>
            <td colSpan={2} className="hint">
              {d.signal}
            </td>
          </tr>
          <tr>
            <th>
              <code>args</code> ({d.argCount})
            </th>
            <th>value</th>
            <th>from the option</th>
          </tr>
          {d.args.map((a: any, i: number) => (
            <tr key={i}>
              <td>
                <code>{a.flag}</code>
              </td>
              <td>{a.value !== undefined && <code>{a.value === "" ? '""' : a.value}</code>}</td>
              <td className="hint">{a.from}</td>
            </tr>
          ))}
          <tr>
            <th>
              <code>env</code>
            </th>
            <th colSpan={2}>
              {d.env.total} variables ({d.env.fromOptions} from options.env)
            </th>
          </tr>
          {d.env.added.map((e: any) => (
            <tr key={e.key}>
              <td>
                <code>{e.key}</code>
              </td>
              <td>
                <code>{e.value}</code>
              </td>
              <td className="hint">added by the SDK</td>
            </tr>
          ))}
          {d.env.removed.map((k: string) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td />
              <td className="hint">in options.env, removed by the SDK</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.systemPromptInArgs === false && <div className="hint">The system prompt is not in args: it goes in the first stdin line, control_request/initialize (see 2).</div>}
    </div>
  );
}

function AliasTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>the model called</th>
          <th>canUseTool saw</th>
          <th>what ran</th>
          <th>the answer</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <b>{r.label}</b>
              <div>
                <code>{r.shown}</code>
              </div>
            </td>
            <td>
              {r.emitted.map((e: string, i: number) => (
                <div key={i}>
                  <code>{e}</code>
                </div>
              ))}
            </td>
            <td className="hint">{r.asked.length ? r.asked.join(", ") : "not asked: Claude Code treats this read-only command as safe"}</td>
            <td className="hint">
              {r.ran.length
                ? r.ran.map((x: any, i: number) => (
                    <div key={i}>
                      mcp__box__bash on the host, got <code>{JSON.stringify(x.received)}</code>
                    </div>
                  ))
                : r.emitted.length
                  ? "the built-in Bash, in the host's cwd"
                  : ""}
            </td>
            <td>
              {r.error ? <code className="bad">{r.error}</code> : <code className={/HOST/.test(r.text) ? "" : "good"}>{r.text}</code>}
              <div className="subtype">${r.cost.toFixed(4)}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DEBUG_FILTERS: [string, RegExp][] = [
  ["everything", /./],
  ["API requests", /\[API/],
  ["startup", /\[STARTUP\]|\[init\]|\[Bootstrap\]/],
  ["MCP", /MCP|mcp/],
  ["settings & plugins", /settings|plugin|skills/i],
  ["warnings & errors", /\[(WARN|ERROR)\]/],
];

function DebugResult({ d }: { d: any }) {
  const [filter, setFilter] = useState(0);
  const [text, setText] = useState("");
  if (d.error) return <div className="snippet bad">{d.error}</div>;
  const lines = d.excerpt.filter((l: string) => DEBUG_FILTERS[filter][1].test(l) && (!text || l.toLowerCase().includes(text.toLowerCase())));
  return (
    <div className="card">
      <b>debugFile</b> <code>{d.debugFile.path}</code>{" "}
      <span className="subtype">
        {d.debugFile.lines} lines · {(d.debugFile.bytes / 1024).toFixed(1)} KB · {Object.entries(d.debugFile.levels).map(([k, v]) => `${k} ${v}`).join(", ")} · ${d.cost.toFixed(4)} for both runs
      </span>
      <div className="hint">
        <b>debug: true</b> (the other run, at the same time): <code>{d.debugTrue.file}</code> {d.debugTrue.exists ? `exists, ${d.debugTrue.lines} lines` : "not found"} · the <code>stderr</code> callback was called{" "}
        {d.debugTrue.stderrChunks} times
      </div>
      <div className="row">
        {d.debugFile.tags.map(([tag, n]: [string, number]) => (
          <span key={tag} className="file-chip">
            {tag} ×{n}
          </span>
        ))}
      </div>
      <div className="row">
        <select value={filter} onChange={(e) => setFilter(Number(e.target.value))}>
          {DEBUG_FILTERS.map(([l], i) => (
            <option key={l} value={i}>
              {l}
            </option>
          ))}
        </select>
        <input className="inline-input" placeholder="contains…" maxLength={60} value={text} onChange={(e) => setText(e.target.value)} />
        <span className="subtype">{lines.length} lines shown</span>
      </div>
      <pre className="wrap store-lines">{lines.join("\n")}</pre>
    </div>
  );
}

function FailTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>setup</th>
          <th>what the host sees</th>
          <th>why</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td>
              <code>{r.shown}</code>
            </td>
            <td>
              <code className={/threw/.test(r.outcome) ? "bad" : ""}>{r.outcome}</code>
              {r.timeline && <pre className="wrap snippet">{r.timeline.join("\n")}</pre>}
            </td>
            <td className="hint">{r.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept36ProcessSpawning() {
  const [st, setSt] = useState<State | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ part: string; text: string } | null>(null);
  const [cost, setCost] = useState(0);
  // Part A
  const [knobs, setKnobs] = useState({ model: "claude-haiku-4-5-20251001", maxTurns: 3, tools: ["Read"] as string[], permissionMode: "default", canUseTool: true, sdkMcp: true, debugFile: false, systemPrompt: "You are terse.", executableArgs: "" });
  const [dry, setDry] = useState<any>(null);
  // Parts B and C
  const [prompt, setPrompt] = useState(RUN_PROMPT);
  const [events, setEvents] = useState<Ev[]>([]);
  const [showFrames, setShowFrames] = useState(true);
  // Part D
  const [aliasPrompt, setAliasPrompt] = useState(ALIAS_PROMPT);
  const [aliasRows, setAliasRows] = useState<any[]>([]);
  // Part E, F
  const [debug, setDebug] = useState<any>(null);
  const [failRows, setFailRows] = useState<any[]>([]);

  const fail = () => setError("Could not reach /api/c36 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together; while the server is loading, Vite's proxy answers 502.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const [s, c] = await Promise.all(["/api/c36/state", "/api/c36/code"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))));
        if (!stop) (setSt(s), setCode(c), setError(null));
      } catch {
        if (stop) return;
        if (tries > 1) setTimeout(() => load(tries - 1), 1000);
        else fail();
      }
    };
    load();
    return () => void (stop = true);
  }, []);

  // Each hint shows under the part whose button was pressed.
  const PART: Record<string, string> = { dry: "A", host: "B", box: "B", alias: "D", debug: "E", failures: "F" };
  const begin = (id: string, h: string) => (setRunning(id), setHint({ part: PART[id], text: h }), setError(null));
  const hintAt = (part: string) => hint?.part === part && <p className="hint">{hint.text}</p>;
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  async function dryRun() {
    begin("dry", "A spawner that only records its SpawnOptions and returns a fake process that exits at once. Change the options and run it again to see which flag each one becomes. The lab adds NODE_OPTIONS to options.env to show that the SDK removes it.");
    try {
      const executableArgs = knobs.executableArgs.split(/\s+/).filter(Boolean);
      setDry(await post("/api/c36/dry", { ...knobs, executableArgs }));
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function run(where: "host" | "box", h: string) {
    begin(where, h);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c36/run", { where, prompt }, (event, data) => {
        if (event === "done") return data.state && setSt(data.state);
        if (event === "outcome") setCost((c) => c + (data.cost ?? 0));
        if (event === "error") setError(data.message);
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function alias() {
    begin("alias", "Three sessions in parallel, the same prompt. The host's cwd and the box both have a where.txt with different text, so the answer shows which tool really ran. mcp__box__bash is an SDK MCP tool that only knows pwd, ls and cat inside spawn-lab/box/work. About $0.025.");
    const rows: any[] = [];
    setAliasRows([]);
    try {
      await streamPost("/api/c36/alias", { prompt: aliasPrompt }, (event, data) => {
        if (event === "aliasRow") setAliasRows((rows.push(data), [...rows])), setCost((c) => c + (data.cost ?? 0));
        if (event === "error") setError(data.message);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function debugRun() {
    begin("debug", "Two one-turn sessions at the same time: one with debugFile (a path the host chooses), one with debug: true and a stderr callback. About $0.001.");
    try {
      const r = await post("/api/c36/debug", {});
      setDebug(r);
      if (r.cost) setCost((c) => c + r.cost);
      if (r.state) setSt(r.state);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function failures() {
    begin("failures", "Seven cases in parallel. The abort row takes about 9 s on Windows (the SDK's grace periods). About $0.002.");
    const rows: any[] = [];
    setFailRows([]);
    try {
      await streamPost("/api/c36/failures", {}, (event, data) => {
        if (event === "failRow") setFailRows((rows.push(data), [...rows])), setCost((c) => c + (data.cost ?? 0));
      });
      setSt(await fetch("/api/c36/state").then((r) => r.json()));
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function reset() {
    const r = await post("/api/c36/reset", {}).catch(fail);
    if (r) setSt(r), setEvents([]), setAliasRows([]), setDebug(null), setFailRows([]);
  }

  const btn = (id: string, label: string, onClick: () => void) => (
    <button disabled={!!running} className={running === id ? "active" : ""} onClick={onClick}>
      {running === id ? "Running…" : label}
    </button>
  );
  const knob = <K extends keyof typeof knobs>(k: K, v: (typeof knobs)[K]) => setKnobs({ ...knobs, [k]: v });

  return (
    <section>
      <h2>36 · Custom process spawning</h2>
      <p className="lead">
        <code>query()</code> does not call the API itself: it starts a <b>Claude Code process</b> and talks to it over <b>stdin/stdout</b>, one JSON line at
        a time. <code>spawnClaudeCodeProcess</code> lets you start that process yourself: log it, wrap it, or run it <b>somewhere else</b> (a container, a VM,
        another server). This tab has a host (this server) and a <b>box</b>: <code>36-runner.mjs</code>, a separate process that runs Claude Code in its own
        folder with its own environment, reached over TCP.
      </p>

      {st && <Machines s={st} />}
      <div className="row">
        <button className="link" disabled={!!running} onClick={reset}>
          reset both machines
        </button>
        <span className="subtype">spent ${cost.toFixed(4)}</span>
      </div>

      <h3>A · What your spawner receives</h3>
      <div className="form-grid">
        <label>
          model
          <select value={knobs.model} onChange={(e) => knob("model", e.target.value)}>
            <option>claude-haiku-4-5-20251001</option>
            <option>claude-sonnet-5-5</option>
          </select>
        </label>
        <label>
          maxTurns
          <input type="number" min={1} max={50} value={knobs.maxTurns} onChange={(e) => knob("maxTurns", Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </label>
        <label>
          permissionMode
          <select value={knobs.permissionMode} onChange={(e) => knob("permissionMode", e.target.value)}>
            {["default", "acceptEdits", "plan", "dontAsk"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          systemPrompt
          <input maxLength={200} value={knobs.systemPrompt} onChange={(e) => knob("systemPrompt", e.target.value)} />
        </label>
        <label>
          executableArgs (space separated)
          <input maxLength={120} placeholder="--inspect" value={knobs.executableArgs} onChange={(e) => knob("executableArgs", e.target.value)} />
        </label>
      </div>
      <div className="row">
        tools:
        {TOOLS.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={knobs.tools.includes(t)} onChange={(e) => knob("tools", e.target.checked ? [...knobs.tools, t] : knobs.tools.filter((x) => x !== t))} /> {t}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={knobs.canUseTool} onChange={(e) => knob("canUseTool", e.target.checked)} /> canUseTool
        </label>
        <label className="check">
          <input type="checkbox" checked={knobs.sdkMcp} onChange={(e) => knob("sdkMcp", e.target.checked)} /> an SDK MCP server
        </label>
        <label className="check">
          <input type="checkbox" checked={knobs.debugFile} onChange={(e) => knob("debugFile", e.target.checked)} /> debugFile
        </label>
      </div>
      <div className="scenarios">{btn("dry", "1 · Dry run: show the SpawnOptions", dryRun)}</div>
      {hintAt("A")}
      {dry && <DryResult d={dry} />}

      <h3>B · The wire, and C · Claude Code in the box</h3>
      <label className="hint">prompt for 2 and 3 (tools: Write and the host's roll tool; canUseTool allows only those two)</label>
      <textarea rows={2} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="scenarios">
        {btn("host", "2 · On the host, with a tap on stdin/stdout", () =>
          run("host", "The spawner starts Claude Code like the SDK would, and wraps stdin and stdout in a tap. Every JSON line of the protocol shows: initialize, the prompt, the messages, and the control_requests of canUseTool and of the host's MCP tool. Click a size to see the line. About $0.006."),
        )}
        {btn("box", "3 · In the box (the remote runner)", () =>
          run("box", "The spawner sends the SpawnOptions over TCP to 36-runner.mjs. The runner uses its own Claude Code, its own folder (box/work) and its own CLAUDE_CONFIG_DIR, and keeps 3 of the host's variables. roll.txt lands in the box, but the roll tool and canUseTool still run on the host: their calls come back over the same stream. About $0.006."),
        )}
        <label className="check">
          <input type="checkbox" checked={showFrames} onChange={(e) => setShowFrames(e.target.checked)} /> show the wire lines
        </label>
      </div>
      {hintAt("B")}
      {(running === "host" || running === "box" || events.length > 0) && (
        <div className="card">
          <b>Spawn, wire lines, host callbacks and messages, in order</b> <span className="subtype">{running === "host" || running === "box" ? "running…" : "done"}</span>
          <Timeline events={events} frames={showFrames} />
        </div>
      )}

      <h3>D · toolAliases: the model calls Bash, your tool runs</h3>
      <label className="hint">prompt for 4</label>
      <textarea rows={2} maxLength={2000} value={aliasPrompt} onChange={(e) => setAliasPrompt(e.target.value)} />
      <div className="scenarios">{btn("alias", "4 · Three sessions: without, with, with and no built-in Bash", alias)}</div>
      {hintAt("D")}
      {aliasRows.length > 0 && <AliasTable rows={aliasRows} />}

      <h3>E · Claude Code's debug log</h3>
      <div className="scenarios">{btn("debug", "5 · debugFile and debug: true", debugRun)}</div>
      {hintAt("E")}
      {debug && <DebugResult d={debug} />}

      <h3>F · When the spawn goes wrong</h3>
      <div className="scenarios">{btn("failures", "6 · Seven failures", failures)}</div>
      {hintAt("F")}
      {failRows.length > 0 && <FailTable rows={failRows} />}


      <h3>G · The code</h3>
      <div className="row">
        {["spawner", "wire", "remote", "runner", "dry", "host", "alias", "debug", "failures"].map(
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

      <h3>H · What a custom spawner changes, and what it does not</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>What</th>
            <th>How</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([k, a, b]) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>
                <code>{a}</code>
              </td>
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
