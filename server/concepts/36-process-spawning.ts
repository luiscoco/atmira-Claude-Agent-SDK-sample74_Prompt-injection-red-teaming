/**
 * CONCEPT 36 — Custom process spawning: decide HOW and WHERE Claude Code runs
 *
 * query() does not talk to the API itself. It starts a Claude Code process (the native binary of the SDK's platform
 * package) and talks to it over stdin/stdout, one JSON object per line. Normally the SDK spawns it on this machine.
 *
 *   options.spawnClaudeCodeProcess = (o: SpawnOptions) => SpawnedProcess
 *
 *   SpawnOptions     { command, args, cwd, env, signal }: everything the SDK would have run. args are the CLI flags
 *                    built from your options; env is options.env plus CLAUDE_CODE_ENTRYPOINT (minus NODE_OPTIONS…).
 *   SpawnedProcess   { stdin, stdout, killed, exitCode, kill(), on/once/off('exit' | 'error') }. A ChildProcess is
 *                    one, but anything with these members works: here, a TCP connection to a "remote runner".
 *
 * Things that go with it:
 *   toolAliases      { Bash: 'mcp__box__bash' }: the model's call of a built-in tool runs one of YOUR tools instead.
 *   debug, debugFile Claude Code's own debug log (debug: true → CLAUDE_CONFIG_DIR/debug/<session>.txt).
 *   executableArgs   put BEFORE the flags: with the native binary they are CLI flags, not runtime flags.
 *   stderr           the SDK only reads stderr from its own spawn. A custom spawner must read it itself.
 *
 * The lab: the host (spawn-lab/host) and a "box" (spawn-lab/box) run by 36-runner.mjs, a separate process that
 * spawns Claude Code in its own folder with its own environment. Routes: GET /state, POST /reset, POST /dry,
 * POST /run (SSE), POST /alias (SSE), POST /debug, POST /failures (SSE), GET /code.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PassThrough, Transform, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import {
  createSdkMcpServer,
  InMemorySessionStore,
  query,
  tool,
  type CanUseTool,
  type Options,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept36 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("spawn-lab");
const HOST = { work: path.join(LAB, "host", "work"), config: path.join(LAB, "host", "config") }; // this machine
const BOX = path.join(LAB, "box"); // the runner's machine: box/work is its cwd, box/config its CLAUDE_CONFIG_DIR
const DEBUG = path.join(LAB, "debug"); // the debugFile of Part E
const RUNNER = fileURLToPath(new URL("./36-runner.mjs", import.meta.url));

function resetLab() {
  // Best effort: on Windows a Claude Code process that just closed can still hold a file (EPERM).
  for (const d of [path.join(LAB, "host"), BOX, DEBUG]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  for (const d of [HOST.work, HOST.config, path.join(BOX, "work"), path.join(BOX, "config"), DEBUG]) mkdirSync(d, { recursive: true });
  // The same file name on both machines, with different text: the answer shows where a tool really ran.
  writeFileSync(path.join(HOST.work, "where.txt"), "I am the HOST machine.\n");
  writeFileSync(path.join(BOX, "work", "where.txt"), "I am the BOX (the remote runner).\n");
}
resetLab();

const ROOT = process.cwd();
const TMP = os.tmpdir();
const escaped = (p: string) => JSON.stringify(p).slice(1, -1); // a path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) =>
  s
    .replaceAll(LAB, "spawn-lab")
    .replaceAll(escaped(LAB), "spawn-lab")
    .replaceAll(ROOT, ".")
    .replaceAll(escaped(ROOT), ".")
    .replaceAll(TMP, "%TEMP%")
    .replaceAll(escaped(TMP), "%TEMP%")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…"); // a key must never reach the browser
const secret = (k: string) => /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k);

/** process.env without CLAUDE* (see Tab16), and this machine's own CLAUDE_CONFIG_DIR. */
function hostEnv(): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  env.CLAUDE_CONFIG_DIR = HOST.config;
  return env;
}

const base = (abort: AbortController, extra: Partial<Options> = {}): Options => ({
  model: MODEL,
  cwd: HOST.work,
  env: hostEnv(),
  tools: [],
  settingSources: [],
  thinking: { type: "disabled" },
  maxTurns: 1,
  abortController: abort,
  ...extra,
});

type Emit = (event: string, data: object) => void;

// #region spawner
// The smallest custom spawner: do what the SDK would do, and read stderr yourself (the SDK never sees it).
function localSpawn(onStderr?: (text: string) => void): (o: SpawnOptions) => ChildProcessWithoutNullStreams {
  return (o) => {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: o.signal, // safe: the SDK aborts it only after stdin EOF and a grace period
      windowsHide: true,
    });
    child.stderr.on("data", (d) => onStderr?.(String(d)));
    return child; // a ChildProcess with its three pipes is a SpawnedProcess
  };
}
// #endregion

// #region wire
// A tap between the SDK and Claude Code: every JSON line that goes down stdin or comes up stdout.
type Frame = { dir: "in" | "out"; kind: string; detail: string; bytes: number; json: string; at: number };

function frameOf(dir: Frame["dir"], line: string, at: number): Frame {
  const f: Frame = { dir, kind: "not JSON", detail: "", bytes: Buffer.byteLength(line), json: short(line).slice(0, 4000), at };
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return { ...f, detail: short(line).slice(0, 200) };
  }
  f.kind = m.type + (m.subtype ? `/${m.subtype}` : "");
  if (m.type === "control_request") {
    const r = m.request ?? {};
    f.kind = `control_request/${r.subtype}`;
    f.detail = r.subtype === "initialize" ? `carries: ${Object.keys(r).filter((k) => k !== "subtype").join(", ")}` : [r.tool_name, r.server_name, r.message?.method, r.message?.params?.name].filter(Boolean).join(" ");
  } else if (m.type === "control_response") {
    const r = m.response ?? {};
    f.kind = `control_response/${r.subtype}`;
    const inner = r.response?.mcp_response?.result;
    f.detail = r.response?.commands ? `the CLI's answer to initialize: ${Object.keys(r.response).join(", ")}` : r.response?.behavior ?? (inner?.tools ? `${inner.tools.length} tool(s)` : inner?.content ? JSON.stringify(inner.content).slice(0, 120) : "");
  } else if (m.type === "assistant" || m.type === "user") {
    const c = m.message?.content;
    f.detail = (typeof c === "string" ? c : (c ?? []).map((b: any) => (b.type === "text" ? b.text : b.type === "tool_use" ? `tool_use ${b.name}` : b.type === "tool_result" ? "tool_result" : `[${b.type}]`)).join(" · ")).slice(0, 160);
  } else if (m.type === "system" && m.subtype === "init") f.detail = `cwd ${short(m.cwd)} · tools ${m.tools?.join(", ")}`;
  else if (m.type === "result") f.detail = `${String(m.result ?? m.subtype).slice(0, 100)} · $${m.total_cost_usd?.toFixed(4)}`;
  return f;
}

function tapped(p: SpawnedProcess, onFrame: (f: Frame) => void): SpawnedProcess {
  const t0 = Date.now();
  const lines = (dir: Frame["dir"]) => {
    const dec = new StringDecoder("utf8");
    let rest = "";
    return (chunk: Buffer) => {
      rest += dec.write(chunk);
      const parts = rest.split("\n");
      rest = parts.pop()!;
      for (const l of parts) if (l.trim()) onFrame(frameOf(dir, l, Date.now() - t0));
    };
  };
  const toCli = lines("in");
  const fromCli = lines("out");
  const stdin = new Transform({ transform: (c, _e, cb) => (toCli(c), cb(null, c)) });
  const stdout = new Transform({ transform: (c, _e, cb) => (fromCli(c), cb(null, c)) });
  p.stdin.on("error", () => {}); // the child may be gone before the SDK stops writing
  stdin.pipe(p.stdin);
  p.stdout.pipe(stdout);
  // Everything else is the wrapped process's.
  return {
    stdin,
    stdout,
    get killed() {
      return p.killed;
    },
    get exitCode() {
      return p.exitCode;
    },
    get signalCode() {
      return p.signalCode;
    },
    kill: (s) => p.kill(s),
    on: (e: any, l: any) => p.on(e, l),
    once: (e: any, l: any) => p.once(e, l),
    off: (e: any, l: any) => p.off(e, l),
  };
}
// #endregion

// #region remote
// A SpawnedProcess that is not a process: a TCP connection to 36-runner.mjs, which runs Claude Code in the box.
// Frames: [type][length][payload]; H header, I stdin, E end of stdin, K kill · O stdout, R stderr, X exit, L log.
const frame = (type: string, payload: Buffer | string = Buffer.alloc(0)) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

type Runner = { port: number; token: string; pid?: number };

function remoteSpawn(runner: Runner, on: { stderr?: (t: string) => void; log?: (l: string) => void } = {}): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const sock = net.connect(runner.port, "127.0.0.1");
    let exited = false;
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      p.exitCode = code;
      p.signalCode = signal;
      stdout.end();
      events.emit("exit", code, signal);
    };
    const p = {
      stdin: new Writable({
        write: (c, _e, cb) => (sock.writable ? sock.write(frame("I", c), () => cb()) : cb()),
        final: (cb) => (sock.writable ? sock.write(frame("E"), () => cb()) : cb()),
      }),
      stdout,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        if (exited || !sock.writable) return false;
        p.killed = true;
        sock.write(frame("K", signal));
        return true;
      },
      on: (e: string, l: (...a: any[]) => void) => (events.on(e, l), p),
      once: (e: string, l: (...a: any[]) => void) => (events.once(e, l), p),
      off: (e: string, l: (...a: any[]) => void) => (events.off(e, l), p),
    };
    // What the SDK built for a local spawn, sent to the runner. It picks its own command, cwd and environment.
    sock.write(frame("H", JSON.stringify({ token: runner.token, args: o.args, cwd: o.cwd, env: o.env })));
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const type = buf.toString("latin1", 0, 1);
        const data = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (type === "O") stdout.write(data);
        else if (type === "R") on.stderr?.(data.toString("utf8"));
        else if (type === "L") on.log?.(data.toString("utf8"));
        else if (type === "X") {
          const x = JSON.parse(data.toString("utf8"));
          exit(x.code, x.signal);
        }
      }
    });
    sock.on("error", (err) => events.emit("error", err)); // e.g. ECONNREFUSED: the runner is not there
    sock.on("close", () => exit(null, "SIGKILL")); // the connection dropped before an exit frame
    o.signal.addEventListener("abort", () => p.kill("SIGKILL")); // the SDK's forwarded abort, after its grace period
    return p as SpawnedProcess;
  };
}
// #endregion

// #region dry
// What would the SDK run? A spawner that only records SpawnOptions, and a fake process that exits at once.
function fakeProcess(): SpawnedProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const p = {
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    stdout,
    killed: false,
    exitCode: null as number | null,
    kill: () => false,
    on: (e: string, l: (...a: any[]) => void) => (events.on(e, l), p),
    once: (e: string, l: (...a: any[]) => void) => (events.once(e, l), p),
    off: (e: string, l: (...a: any[]) => void) => (events.off(e, l), p),
  };
  setTimeout(() => ((p.exitCode = 0), stdout.end(), events.emit("exit", 0, null)), 10);
  return p as SpawnedProcess;
}

async function spawnOptionsOf(options: Options): Promise<SpawnOptions | undefined> {
  let got: SpawnOptions | undefined;
  const q = query({ prompt: "(dry run)", options: { ...options, spawnClaudeCodeProcess: (o) => ((got = o), fakeProcess()) } });
  try {
    for await (const _ of q) break;
  } catch {} // "process exited": expected, nothing ran
  return got;
}
// #endregion

// The runner's Claude Code is "its own install". Here it is the same binary the SDK would start: ask a dry run.
let claudeBinary: Promise<string> | undefined;
const binary = () => (claudeBinary ??= spawnOptionsOf(base(new AbortController())).then((o) => o?.command ?? Promise.reject(new Error("no command"))));

let runnerProcess: ChildProcess | undefined;
let runnerInfo: Promise<Runner> | undefined;
function ensureRunner(): Promise<Runner> {
  return (runnerInfo ??= binary().then(
    (claude) =>
      new Promise<Runner>((resolve, reject) => {
        const token = randomBytes(16).toString("hex");
        const child = spawn(process.execPath, [RUNNER, BOX, token, claude], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        runnerProcess = child;
        child.stdout.on("data", (d) => {
          const m = /listening (\d+)/.exec(String(d));
          if (m) resolve({ port: Number(m[1]), token, pid: child.pid });
        });
        child.on("exit", () => ((runnerInfo = undefined), (runnerProcess = undefined), reject(new Error("the runner stopped"))));
      }),
  ));
}
process.on("exit", () => runnerProcess?.kill());

/** Files under a folder, relative to it, "/" separated. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .map((f) => f.replaceAll("\\", "/"));
}

function state() {
  const sessions = (dir: string) => files(path.join(dir, "projects")).filter((f) => f.endsWith(".jsonl")).length;
  return {
    host: { work: files(HOST.work), sessions: sessions(HOST.config) },
    box: { work: files(path.join(BOX, "work")), sessions: sessions(path.join(BOX, "config")) },
    runner: runnerProcess ? { pid: runnerProcess.pid } : null,
  };
}

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 500);

concept36.get("/state", (_req, res) => res.json(state()));
concept36.post("/reset", (_req, res) => (resetLab(), res.json(state())));

// ---------------------------------------------------------------------------------------------
// POST /dry: the SpawnOptions the SDK builds from some options. No process, no API call.
// ---------------------------------------------------------------------------------------------

// Which option produced which flag. The lab only lists the flags its form can produce.
const FLAGS: Record<string, string> = {
  "--output-format": "always: Claude Code writes JSON lines on stdout",
  "--verbose": "always: every message, not only the result",
  "--input-format": "always: the SDK writes JSON lines on stdin",
  "--model": "model",
  "--max-turns": "maxTurns",
  "--thinking": "thinking",
  "--tools": "tools",
  "--allowedTools": "allowedTools",
  "--setting-sources": "settingSources",
  "--setting-sources=": "settingSources: [] (none)",
  "--permission-mode": "permissionMode",
  "--permission-prompt-tool": "canUseTool: permission requests come back to the SDK as control_requests on stdout",
  "--mcp-config": "mcpServers (an SDK server is only a name here: its tools run in YOUR process)",
  "--debug-file": "debugFile",
  "--debug": "debug",
  "--effort": "effort",
};

function annotate(args: string[], executableArgs: string[]) {
  const out: { flag: string; value?: string; from: string }[] = [];
  for (const a of executableArgs) out.push({ flag: a, from: "executableArgs: put first, before every flag" });
  for (let i = executableArgs.length; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq + (a.endsWith("=") ? 1 : 0)) : a;
    const next = args[i + 1];
    const hasValue = eq < 0 && next !== undefined && !next.startsWith("--");
    out.push({ flag: a.endsWith("=") ? a : eq > 0 ? a.slice(0, eq) : a, value: eq > 0 && !a.endsWith("=") ? a.slice(eq + 1) : hasValue ? short(next).slice(0, 300) : undefined, from: FLAGS[name] ?? FLAGS[a.slice(0, eq > 0 ? eq : undefined)] ?? "(another option)" });
    if (hasValue) i++;
  }
  return out;
}

const DryBody = z
  .object({
    model: z.enum(["claude-haiku-4-5-20251001", "claude-sonnet-5-5"]),
    maxTurns: z.number().int().min(1).max(50),
    tools: z.array(z.enum(["Read", "Write", "Bash"])).max(3),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk"]),
    canUseTool: z.boolean(),
    sdkMcp: z.boolean(),
    debugFile: z.boolean(),
    systemPrompt: z.string().max(200),
    executableArgs: z.array(z.string().regex(/^--?[\w.=-]{1,60}$/, "a flag like --inspect")).max(3),
  })
  .strict();

concept36.post("/dry", async (req, res) => {
  const parsed = DryBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: badRequest(parsed.error) });
  const b = parsed.data;
  // NODE_OPTIONS is added to show that the SDK removes it before the spawn.
  const env = { ...hostEnv(), NODE_OPTIONS: "--max-old-space-size=4096" };
  const options = base(new AbortController(), {
    model: b.model,
    maxTurns: b.maxTurns,
    tools: b.tools,
    permissionMode: b.permissionMode,
    env,
    ...(b.canUseTool && { canUseTool: async () => ({ behavior: "deny", message: "dry run" }) }),
    ...(b.sdkMcp && { mcpServers: { host: hostTools(() => {}) } }),
    ...(b.debugFile && { debugFile: path.join(DEBUG, "dry.log") }),
    ...(b.systemPrompt && { systemPrompt: b.systemPrompt }),
    ...(b.executableArgs.length && { executableArgs: b.executableArgs }),
  });
  const o = await spawnOptionsOf(options);
  if (!o) return res.json({ error: "the spawner was not called" });
  const added = Object.keys(o.env).filter((k) => !(k in env));
  const removed = Object.keys(env).filter((k) => !(k in o.env));
  const changed = Object.keys(env).filter((k) => k in o.env && o.env[k] !== env[k as keyof typeof env]);
  const show = (k: string, v: string | undefined) => ({ key: k, value: secret(k) ? "(hidden)" : short(String(v)).slice(0, 120) });
  res.json({
    command: short(o.command),
    args: annotate(o.args, b.executableArgs),
    argCount: o.args.length,
    cwd: short(o.cwd ?? ""),
    env: {
      total: Object.keys(o.env).length,
      fromOptions: Object.keys(env).length,
      added: added.map((k) => show(k, o.env[k])),
      removed,
      changed: changed.map((k) => show(k, o.env[k])),
    },
    signal: "a forwarded AbortSignal (not your abortController's): it fires after the SDK's graceful close",
    systemPromptInArgs: b.systemPrompt ? o.args.some((a) => a.includes(b.systemPrompt)) : undefined,
  });
});

// ---------------------------------------------------------------------------------------------
// POST /run: one session on the host or in the box, with the stdio tap. A host tool and canUseTool.
// ---------------------------------------------------------------------------------------------

// #region host
// An SDK MCP server and canUseTool live in THIS process. Wherever Claude Code runs, their calls come back over the
// same stdin/stdout as control_request lines, so they still run here, on the host.
function hostTools(onRun: (d: object) => void) {
  return createSdkMcpServer({
    name: "host",
    tools: [
      tool("roll", "Roll a six-sided die. Returns the number.", {}, async () => {
        const n = randomInt(1, 7);
        onRun({ tool: "mcp__host__roll", ranIn: `the host's Node process (pid ${process.pid})`, result: n });
        return { content: [{ type: "text", text: String(n) }] };
      }),
    ],
  });
}

function hostPermissions(onAsk: (d: object) => void): CanUseTool {
  return async (name, input) => {
    const ok = name === "mcp__host__roll" || name === "Write";
    onAsk({ tool: name, input: short(JSON.stringify(input)).slice(0, 300), decision: ok ? "allow" : "deny" });
    return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the roll tool and Write are allowed in this lab." };
  };
}
// #endregion

const RunBody = z.object({ where: z.enum(["host", "box"]), prompt: z.string().trim().min(1).max(2000) }).strict();

concept36.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send: raw } = openSse(req, res);
  const startedAt = Date.now();
  const send: Emit = (e, d) => raw(e, { ...d, at: Date.now() - startedAt });
  const end = () => (raw("done", { state: state() }), res.end());
  if (!parsed.success) return raw("error", { message: badRequest(parsed.error) }), end();
  const b = parsed.data;
  try {
    const onFrame = (f: Frame) => send("frame", f); // on the same clock as the other events
    const stderr = (t: string) => send("stderr", { text: short(t).slice(0, 400) });
    let spawner: (o: SpawnOptions) => SpawnedProcess;
    if (b.where === "box") {
      const runner = await ensureRunner();
      const remote = remoteSpawn(runner, { stderr, log: (l) => send("runner", { line: short(l) }) });
      spawner = (o) => tapped(remote(o), onFrame);
    } else {
      const local = localSpawn(stderr);
      spawner = (o) => tapped(local(o), onFrame);
    }
    const options = base(abort, {
      tools: ["Write"],
      maxTurns: 5,
      mcpServers: { host: hostTools((d) => send("hostTool", d)) },
      canUseTool: hostPermissions((d) => send("permission", d)),
      spawnClaudeCodeProcess: (o) => {
        send("spawn", { command: short(o.command), args: o.args.length, cwd: short(o.cwd ?? "") });
        return spawner(o);
      },
    });
    let text = "";
    let cost = 0;
    for await (const m of query({ prompt: b.prompt, options })) {
      if (m.type === "system" && m.subtype === "init") send("msg", { kind: "system/init", detail: `cwd ${short(m.cwd)}` });
      else if (m.type === "assistant") {
        for (const c of m.message.content) {
          if (c.type === "text") (text += (text ? "\n" : "") + c.text), send("msg", { kind: "assistant", detail: c.text.slice(0, 300) });
          if (c.type === "tool_use") send("msg", { kind: "assistant", detail: `tool_use ${c.name} ${short(JSON.stringify(c.input)).slice(0, 200)}` });
        }
      } else if (m.type === "result") {
        cost = m.total_cost_usd;
        send("msg", { kind: `result/${m.subtype}`, detail: `${m.subtype === "success" ? m.result.slice(0, 200) : m.subtype} · $${m.total_cost_usd.toFixed(4)}`, bad: m.is_error });
      }
    }
    send("outcome", { text, cost, where: b.where });
  } catch (err) {
    send("msg", { kind: "error (query threw)", detail: errText(err), bad: true });
  }
  end();
});

// ---------------------------------------------------------------------------------------------
// POST /alias: the model calls Bash; toolAliases decides what runs. 3 rows in parallel.
// ---------------------------------------------------------------------------------------------

// #region alias
// "bash" of the box: NOT a shell. It only knows pwd, ls and cat, and only inside box/work.
function boxShell(onRun: (d: object) => void) {
  const root = path.join(BOX, "work");
  return createSdkMcpServer({
    name: "box",
    tools: [
      tool("bash", "Run a command in the remote box. Supports pwd, ls and cat <file>.", { command: z.string() }, async (input) => {
        const [cmd, arg] = input.command.trim().split(/\s+/);
        let out: string;
        if (cmd === "pwd") out = "/box/work";
        else if (cmd === "ls") out = readdirSync(root).join("\n");
        else if (cmd === "cat" && arg && /^[\w.-]+$/.test(arg) && existsSync(path.join(root, arg))) out = readFileSync(path.join(root, arg), "utf8");
        else out = `box: '${input.command}' is not available here (only pwd, ls, cat <file>)`;
        onRun({ received: input, out });
        return { content: [{ type: "text", text: out }] };
      }),
    ],
  });
}

const ALIAS_ROWS = [
  { key: "none", label: "no alias", shown: "tools: ['Bash']", extra: { tools: ["Bash"] } },
  { key: "alias", label: "toolAliases", shown: "tools: ['Bash'], toolAliases: { Bash: 'mcp__box__bash' }", extra: { tools: ["Bash"], toolAliases: { Bash: "mcp__box__bash" } } },
  { key: "only", label: "toolAliases, no built-in Bash", shown: "tools: [], toolAliases: { Bash: 'mcp__box__bash' }", extra: { tools: [], toolAliases: { Bash: "mcp__box__bash" } } },
] satisfies { key: string; label: string; shown: string; extra: Partial<Options> }[];
// #endregion

const AliasBody = z.object({ prompt: z.string().trim().min(1).max(2000) }).strict();

concept36.post("/alias", async (req, res) => {
  const parsed = AliasBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  try {
    await Promise.all(
      ALIAS_ROWS.map(async (row) => {
        const r = { key: row.key, label: row.label, shown: row.shown, emitted: [] as string[], asked: [] as string[], ran: [] as object[], results: [] as string[], text: "", cost: 0, error: "" };
        // Only reading where.txt (or ls/pwd) is allowed, whichever tool the call ends up in.
        const canUseTool: CanUseTool = async (name, input) => {
          r.asked.push(name);
          const ok = /^(cat where\.txt|ls|pwd)$/.test(String((input as any).command ?? "").trim());
          return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only 'cat where.txt', 'ls' or 'pwd' in this lab." };
        };
        const options = base(abort, { ...row.extra, maxTurns: 3, mcpServers: { box: boxShell((d) => r.ran.push(d)) }, canUseTool });
        try {
          for await (const m of query({ prompt: parsed.data.prompt, options })) {
            if (m.type === "assistant") for (const c of m.message.content) if (c.type === "tool_use") r.emitted.push(`${c.name} ${JSON.stringify(c.input)}`);
            if (m.type === "user" && Array.isArray(m.message.content))
              for (const c of m.message.content as any[]) if (c.type === "tool_result") r.results.push(short(typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join(" ")).slice(0, 200));
            if (m.type === "result") (r.cost = m.total_cost_usd), (r.text = m.subtype === "success" ? m.result.slice(0, 200) : m.subtype);
          }
        } catch (err) {
          r.error = errText(err);
        }
        send("aliasRow", r);
      }),
    );
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /debug: Claude Code's debug log. debugFile (a path you choose) and debug: true (its own folder).
// ---------------------------------------------------------------------------------------------

// #region debug
async function debugRuns(abort: AbortController) {
  const file = path.join(DEBUG, `run-${Date.now()}.log`);
  let stderrChunks = 0;
  const run = async (extra: Partial<Options>) => {
    let sessionId = "";
    let cost = 0;
    for await (const m of query({ prompt: "Reply only OK.", options: base(abort, extra) })) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      if (m.type === "result") cost = m.total_cost_usd;
    }
    return { sessionId, cost };
  };
  const [a, b] = await Promise.all([
    run({ debugFile: file }), // --debug-file <path>
    run({ debug: true, stderr: () => stderrChunks++ }), // --debug: the log goes to CLAUDE_CONFIG_DIR/debug/<session>.txt
  ]);
  const own = path.join(HOST.config, "debug", `${b.sessionId}.txt`);
  return { file, a, b, own, stderrChunks };
}
// #endregion

concept36.post("/debug", async (_req, res) => {
  const abort = new AbortController();
  res.on("close", () => !res.writableFinished && abort.abort());
  try {
    const r = await debugRuns(abort);
    const text = existsSync(r.file) ? readFileSync(r.file, "utf8") : "";
    const lines = text.split("\n").filter(Boolean);
    const levels: Record<string, number> = {};
    const tags: Record<string, number> = {};
    for (const l of lines) {
      const lv = /\[(DEBUG|INFO|WARN|ERROR)\]/.exec(l)?.[1] ?? "other";
      levels[lv] = (levels[lv] ?? 0) + 1;
      const tag = /\] (\[[^\]]{2,30}\])/.exec(l)?.[1];
      if (tag) tags[tag] = (tags[tag] ?? 0) + 1;
    }
    res.json({
      debugFile: { path: short(r.file), sessionId: r.a.sessionId, lines: lines.length, bytes: Buffer.byteLength(text), levels, tags: Object.entries(tags).sort((x, y) => y[1] - x[1]).slice(0, 14) },
      excerpt: lines.slice(0, 1500).map((l) => short(l).slice(0, 300)),
      debugTrue: { sessionId: r.b.sessionId, file: short(r.own), exists: existsSync(r.own), lines: existsSync(r.own) ? readFileSync(r.own, "utf8").split("\n").filter(Boolean).length : 0, stderrChunks: r.stderrChunks },
      cost: r.a.cost + r.b.cost,
      state: state(),
    });
  } catch (err) {
    res.json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /failures: what the host sees when the spawn goes wrong. Rows in parallel.
// ---------------------------------------------------------------------------------------------

type Row = { key: string; label: string; shown: string; run: (abort: AbortController) => Promise<{ outcome: string; note?: string; timeline?: string[]; cost?: number }> };

async function outcomeOf(options: Options, prompt = "Reply only OK.") {
  let cost = 0;
  try {
    let result = "";
    for await (const m of query({ prompt, options })) if (m.type === "result") (cost = m.total_cost_usd), (result = m.subtype === "success" ? m.result.slice(0, 120) : m.subtype);
    return { outcome: `result: ${result}`, cost };
  } catch (err) {
    return { outcome: `query() threw: ${errText(err)}`, cost };
  }
}

// #region failures
const FAILS: Row[] = [
  {
    key: "throws",
    label: "the spawner throws",
    shown: "spawnClaudeCodeProcess: () => { throw new Error('no VM available') }",
    run: async (abort) =>
      outcomeOf(
        base(abort, {
          spawnClaudeCodeProcess: () => {
            throw new Error("no VM available");
          },
        }),
      ),
  },
  {
    key: "enoent",
    label: "a command that does not exist",
    shown: "spawn('no-such-runner', o.args, …)",
    run: async (abort) => ({
      ...(await outcomeOf(base(abort, { spawnClaudeCodeProcess: (o) => spawn("no-such-runner", o.args, { env: o.env, windowsHide: true }) }))),
      note: "The message names the SDK's own binary, not the command your spawner ran: log the command yourself.",
    }),
  },
  {
    key: "exit",
    label: "the process exits with an error",
    shown: "a process that writes 'container quota exceeded' on stderr and exits 3",
    run: async (abort) => {
      let stderr = "";
      const local = localSpawn((t) => (stderr += t));
      const failing = ["-e", "console.error('container quota exceeded'); process.exit(3)"];
      const r = await outcomeOf(base(abort, { spawnClaudeCodeProcess: (o) => local({ ...o, command: process.execPath, args: failing }) }));
      return { ...r, note: `The SDK's error has no stderr: only your spawner saw it. It captured: "${stderr.trim()}"` };
    },
  },
  {
    key: "execargs",
    label: "executableArgs with the native binary",
    shown: "executableArgs: ['--max-old-space-size=512'] (the SDK's own spawn)",
    run: async (abort) => ({
      ...(await outcomeOf(base(abort, { executableArgs: ["--max-old-space-size=512"] }))),
      note: "They go before the flags. With a JavaScript cli.js they are node's flags; with the native binary, Claude Code's. Here the SDK spawned it, so its error has the stderr tail.",
    }),
  },
  {
    key: "runner",
    label: "the runner is not there",
    shown: "remoteSpawn({ port: <a closed port> })",
    run: async (abort) => {
      const closed = await new Promise<number>((r) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
          const port = (s.address() as net.AddressInfo).port;
          s.close(() => r(port));
        });
      });
      return outcomeOf(base(abort, { spawnClaudeCodeProcess: remoteSpawn({ port: closed, token: "x" }) }));
    },
  },
  {
    key: "abort",
    label: "abort during the answer",
    shown: "abortController.abort() 1.5 s after the spawn, the answer still streaming",
    run: async () => {
      const own = new AbortController();
      const t: string[] = [];
      let t0 = 0;
      const mark = (what: string) => t.push(`+${((Date.now() - t0) / 1000).toFixed(1)} s ${what}`);
      const r = await outcomeOf(
        base(own, {
          maxTurns: 1,
          spawnClaudeCodeProcess: (o) => {
            t0 = Date.now();
            setTimeout(() => (mark("abortController.abort()"), own.abort()), 1500);
            o.signal.addEventListener("abort", () => mark("SpawnOptions.signal fired"));
            const child = localSpawn()({ ...o, signal: new AbortController().signal }); // no automatic kill: see every step
            child.stdin.on("finish", () => mark("the SDK ended stdin"));
            const kill = child.kill.bind(child);
            child.kill = (s?: NodeJS.Signals | number) => (mark(`kill('${s}')`), kill(s));
            child.on("exit", (code, sig) => mark(`exit (${code ?? sig})`));
            return child;
          },
        }),
        "Write a 600-word story about a lighthouse.",
      );
      await new Promise((ok) => setTimeout(ok, 300)); // the exit event can come just after query() threw
      return { ...r, timeline: t, note: process.platform === "win32" ? "Windows: no SIGTERM. The SDK waits 2 s, then 5 s more, then kill('SIGKILL')" : "POSIX: SIGTERM after 2 s, SIGKILL 5 s later if it is still running" };
    },
  },
  {
    key: "store",
    label: "a sessionStore, Claude Code in the box",
    shown: "sessionStore + remoteSpawn (the box has its own CLAUDE_CONFIG_DIR)",
    run: async (abort) => {
      const store = new InMemorySessionStore();
      let appended = 0;
      const append = store.append.bind(store);
      store.append = async (k, e) => ((appended += e.length), append(k, e));
      const r = await outcomeOf(base(abort, { sessionStore: store, spawnClaudeCodeProcess: remoteSpawn(await ensureRunner()) }));
      return { ...r, note: `store.append() received ${appended} lines. The SDK mirrors lines by their file path under ITS CLAUDE_CONFIG_DIR; the box writes under another one, so the lines are dropped. No message in the stream says so, and the result is a success.` };
    },
  },
];
// #endregion

concept36.post("/failures", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  try {
    await Promise.all(
      FAILS.map(async (row) => {
        try {
          send("failRow", { key: row.key, label: row.label, shown: row.shown, ...(await row.run(abort)), at: Date.now() - startedAt });
        } catch (err) {
          send("failRow", { key: row.key, label: row.label, shown: row.shown, outcome: `the host threw: ${errText(err)}`, at: Date.now() - startedAt });
        }
      }),
    );
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file and in the runner, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept36.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  const regions = Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()]));
  res.json({ ...regions, runner: readFileSync(RUNNER, "utf8").replaceAll("\r\n", "\n") });
});
