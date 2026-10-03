/**
 * CONCEPT 41 — The V2 session API (unstable_v2_*): what it was, why it went away, and how to write it with query()
 *
 *   V2 (SDK 0.1.54 … 0.2.141)                       Today (SDK 0.3.x)
 *   unstable_v2_prompt(text, opts)             ->    query({ prompt: text, options }) and take the result
 *   unstable_v2_createSession(opts)            ->    query({ prompt: <an input queue>, options })   (Concept 12)
 *     session.send(text)                       ->    push an SDKUserMessage into the queue
 *     session.stream()   (ends at each result) ->    read the Query until the next result
 *     session.close()                          ->    close the queue
 *   unstable_v2_resumeSession(id, opts)        ->    the same with options.resume = id                (Concept 6)
 *
 * V2 was marked @deprecated ("Use query() instead") in 0.2.133 and removed in 0.3.142. The lab installs the last
 * release that had it, 0.2.141, next to 0.3.281 under the npm alias "claude-agent-sdk-v2", and runs both.
 * Inside 0.2.141, SDKSession was already a thin wrapper: an input queue + the same Query that query() returns.
 *
 * The lab uses its own CLAUDE_CONFIG_DIR (v2-lab/config), so both CLIs read and write the same session files.
 * A launcher (41-launcher.mjs) stands in for claude.exe and counts the Claude Code processes each way starts.
 * Routes: GET /facts, GET /state, POST /v2 (SSE), POST /resume (SSE), POST /compare (SSE), GET /code.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKSessionOptions } from "claude-agent-sdk-v2";
import { openSse } from "../sse.js";

export const concept41 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("v2-lab");
const WORK = path.join(LAB, "work"); // cwd of every session
const CONFIG = path.join(LAB, "config"); // CLAUDE_CONFIG_DIR, shared by the old and the new CLI
const SPAWNS = path.join(LAB, "spawns"); // one log per run and way: a line per Claude Code process
const LAST = path.join(LAB, "last-v2-session.txt"); // survives the `node --watch` restarts
const LAUNCHER = fileURLToPath(new URL("./41-launcher.mjs", import.meta.url));
const OLD = "claude-agent-sdk-v2"; // package.json: "claude-agent-sdk-v2": "npm:@anthropic-ai/claude-agent-sdk@0.2.141"
const NEW = "@anthropic-ai/claude-agent-sdk";

const SCRIPT = [
  "My name is Ana and I teach a TypeScript course. Reply in one short line.",
  "Suggest a catchy title for my course. One line.",
  "What is my name, and what do I teach? One line.",
];
const QUESTION = SCRIPT[2];

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const ROOT = process.cwd();
const short = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replaceAll(LAB, "v2-lab").replaceAll(ROOT, ".").replace(/sk-ant-[\w-]+/g, "sk-ant-…");
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const q = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 57) + "…" : s);

// ---------------------------------------------------------------------------------------------
// Where things are: the two SDKs, their binaries, the lab's environment
// ---------------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** The package folder of an installed SDK (the alias too), found from its entry file. */
const sdkDir = (name: string) => path.dirname(require.resolve(name));
const versionOf = (name: string): string => JSON.parse(readFileSync(path.join(sdkDir(name), "package.json"), "utf8")).version;

/** The native Claude Code binary that an SDK would start: each SDK has its own, in its own platform package. */
function realCli(name: string) {
  const from = createRequire(require.resolve(name));
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const suffix of ["", "-musl"]) {
    try {
      return from.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/${exe}`);
    } catch {}
  }
  throw new Error(`No Claude Code binary for ${process.platform}-${process.arch} next to ${name}`);
}

/** process.env without Claude Code's own variables (see Tab16), with the lab's config folder and the launcher's two. */
function labEnv(sdk: string, spawnLog?: string) {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  env.CLAUDE_CONFIG_DIR = CONFIG;
  // Without this, turn 1 often saves "Ana teaches TypeScript" to auto memory (Tab22, with the Write tool: V2 cannot
  // remove tools), and a later session "remembers" it without the transcript. Here, only the session may remember.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.C41_REAL_CLI = realCli(sdk);
  if (spawnLog) env.C41_SPAWN_LOG = spawnLog;
  return env;
}

function ready() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(SPAWNS, { recursive: true });
}

/** The old SDK is loaded only when a route needs it: the other 40 concepts never touch 0.2.141. */
const loadV2 = () => import("claude-agent-sdk-v2");

/** A short line per message, for the timelines. The raw messages go to the tab too. */
function summary(m: any) {
  if (m.type === "system" && m.subtype === "init") return { kind: "system/init", text: `Claude Code ${m.claude_code_version} · ${m.tools.length} tools · session ${String(m.session_id).slice(0, 8)}` };
  if (m.type === "assistant") {
    const parts = (m.message.content as any[]).map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[tool_use ${b.name}]` : `[${b.type}]`));
    return { kind: "assistant", text: parts.join(" ").trim() };
  }
  if (m.type === "user") return { kind: "user", text: "[tool_result]" };
  if (m.type === "result") return { kind: `result/${m.subtype}`, text: m.subtype === "success" ? m.result : (m.errors ?? []).join("; "), cost: m.total_cost_usd };
  return { kind: m.subtype ? `${m.type}/${m.subtype}` : m.type, text: "" };
}

// ---------------------------------------------------------------------------------------------
// GET /facts: the history, what each installed SDK exports, the deprecation notes, the two option types
// ---------------------------------------------------------------------------------------------

// From `npm view @anthropic-ai/claude-agent-sdk time` and a bisect of every release's sdk.d.ts (2026-09-29).
const HISTORY = [
  { version: "0.1.54", date: "2025-11-26", what: "unstable_v2_createSession, unstable_v2_resumeSession and unstable_v2_prompt appear (V2 API - UNSTABLE, @alpha)" },
  { version: "0.2.133", date: "2026-05-07", what: "all five V2 declarations get @deprecated: \"Use query() instead. The V2 session API will be removed in a future release.\"" },
  { version: "0.2.141", date: "2026-05-13", what: "the last release with V2 (the one this lab installs as claude-agent-sdk-v2)" },
  { version: "0.3.142", date: "2026-05-14", what: "V2 is gone: the 0.3 line exports no unstable_v2_* function" },
];

/** The top-level keys of `export declare type <name> = { … };` in a .d.ts (nested objects are indented deeper). */
function keysOf(dts: string, name: string) {
  const start = dts.indexOf(`export declare type ${name} = {`);
  if (start < 0) return [];
  const block = dts.slice(start, dts.indexOf("\n};", start));
  return [...block.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Each "V2 API - UNSTABLE" doc comment and the declaration it belongs to. */
function deprecations(dts: string) {
  return [...dts.matchAll(/\/\*\*\n \* V2 API - UNSTABLE\n([\s\S]*?)\*\/\nexport declare (function|type|interface) (\w+)/g)].map(([, doc, kind, name]) => {
    const lines = doc.split("\n").map((l) => l.replace(/^\s*\* ?/, "").trim());
    const tag = (t: string) => lines.find((l) => l.startsWith(`@${t}`))?.slice(t.length + 1).trim();
    return { kind, name, what: lines.slice(0, lines.findIndex((l) => l.startsWith("@"))).join(" "), deprecated: tag("deprecated"), alpha: tag("alpha") !== undefined };
  });
}

concept41.get("/facts", async (_req, res) => {
  try {
    const [oldMod, newMod] = await Promise.all([loadV2(), import(NEW)]);
    // The published .d.ts files use CRLF line ends.
    const oldDts = readFileSync(path.join(sdkDir(OLD), "sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const newDts = readFileSync(path.join(sdkDir(NEW), "sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const v2Keys = keysOf(oldDts, "SDKSessionOptions");
    const optionKeys = keysOf(newDts, "Options");
    const v2Exports = (m: object) => Object.keys(m).filter((k) => k.startsWith("unstable_v2"));
    res.json({
      history: HISTORY,
      installed: [
        { name: `${OLD} (npm:${NEW}@${versionOf(OLD)})`, version: versionOf(OLD), v2: v2Exports(oldMod), exports: Object.keys(oldMod).length },
        { name: NEW, version: versionOf(NEW), v2: v2Exports(newMod), exports: Object.keys(newMod).length },
      ],
      deprecations: deprecations(oldDts),
      options: {
        v2: v2Keys,
        both: v2Keys.filter((k) => optionKeys.includes(k)),
        v2Only: v2Keys.filter((k) => !optionKeys.includes(k)),
        queryOnly: optionKeys.filter((k) => !v2Keys.includes(k)),
        optionCount: optionKeys.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

concept41.get("/state", (_req, res) => {
  res.json({ lastV2Session: existsSync(LAST) ? readFileSync(LAST, "utf8").trim() || null : null });
});

// ---------------------------------------------------------------------------------------------
// POST /v2: the real V2 API of 0.2.141, call by call
// ---------------------------------------------------------------------------------------------

// #region v2options
function v2Options(spawnLog?: string): SDKSessionOptions {
  return {
    model: MODEL, // the only required field
    cwd: WORK,
    env: labEnv(OLD, spawnLog),
    pathToClaudeCodeExecutable: LAUNCHER, // only to count processes; without it, 0.2.141 starts its own claude.exe
    // settingSources defaults to [] in V2 (sdk.d.ts: "query() has the opposite default")
    // no tools, maxTurns, systemPrompt, mcpServers, abortController…: SDKSessionOptions has 14 fields
  };
}
// #endregion

// #region v2session
/** Three turns in one V2 session: send() queues a message, stream() yields until that turn's result, then returns. */
async function v2Session(emit: Emit, signal: AbortSignal) {
  const { unstable_v2_createSession } = await loadV2();
  emit("call", { code: "const session = unstable_v2_createSession(options)" });
  const session: SDKSession = unstable_v2_createSession(v2Options());
  signal.addEventListener("abort", () => session.close()); // V2 has no abortController: close() is the only way out
  try {
    try {
      emit("call", { code: "session.sessionId", note: session.sessionId });
    } catch (err) {
      emit("call", { code: "session.sessionId", error: errText(err) }); // no id until the first message
    }
    for (const text of SCRIPT) {
      emit("call", { code: `await session.send(${q(text)})` });
      await session.send(text);
      emit("call", { code: "for await (const m of session.stream())" });
      for await (const m of session.stream()) emit("message", { raw: m, ...summary(m) });
      emit("call", { code: "// stream() returned by itself after the result", quiet: true });
    }
    const id = session.sessionId;
    emit("call", { code: "session.sessionId", note: id });
    writeFileSync(LAST, id);
    session.close();
    emit("call", { code: "session.close()" });
    try {
      await session.send("One more?");
    } catch (err) {
      emit("call", { code: 'await session.send("One more?")', error: errText(err) });
    }
    emit("session", { id });
  } finally {
    session.close();
  }
}
// #endregion

// #region v2prompt
/** One-shot: inside 0.2.141 it is createSession + send + the first result + close (with `await using`). */
async function v2Prompt(emit: Emit) {
  const { unstable_v2_prompt } = await loadV2();
  const text = "In one line: what is a session in the Claude Agent SDK?";
  emit("call", { code: `const result = await unstable_v2_prompt(${q(text)}, options)` });
  const result = await unstable_v2_prompt(text, v2Options());
  emit("message", { raw: result, ...summary(result) });
  emit("call", { code: "result.type, result.session_id", note: `${result.type} · ${result.session_id}` });
}
// #endregion

const V2Body = z.object({ step: z.enum(["prompt", "session"]) }).strict();

concept41.post("/v2", async (req, res) => {
  const parsed = V2Body.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  try {
    if (!parsed.success) throw new Error(badRequest(parsed.error));
    ready();
    if (parsed.data.step === "prompt") await v2Prompt(emit);
    else await v2Session(emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) emit("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// The replacement: createSession() on top of query() with streaming input
// ---------------------------------------------------------------------------------------------

// #region wrapper
/** The push queue of Concept 12: an async generator that waits while the queue is empty. */
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push: (m: SDKUserMessage) => (queue.push(m), wake?.()),
    close: () => ((closed = true), wake?.()),
  };
}

/** What unstable_v2_createSession did, on today's query(): same send/stream/close, but any Options, and the Query. */
export function createSession(options: Options) {
  const input = inputQueue();
  const live: Query = query({ prompt: input.stream, options });
  const messages = live[Symbol.asyncIterator]();
  let sessionId = options.resume ?? null;
  let closed = false;
  return {
    get sessionId(): string {
      if (!sessionId) throw new Error("Session ID not available until after receiving messages");
      return sessionId;
    },
    query: live, // V2 hid it: here interrupt(), setModel(), getContextUsage()… (Concept 26) still work
    async send(message: string | SDKUserMessage) {
      if (closed) throw new Error("Cannot send to closed session");
      input.push(typeof message === "string" ? { type: "user", parent_tool_use_id: null, message: { role: "user", content: message } } : message);
    },
    /** Yields the messages of ONE turn: it returns after the result, like V2's stream(). */
    async *stream(): AsyncGenerator<SDKMessage> {
      while (true) {
        const { value, done } = await messages.next();
        if (done) return;
        if (value.type === "system" && value.subtype === "init") sessionId = value.session_id;
        yield value;
        if (value.type === "result") return;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      input.close(); // the normal end: Claude Code finishes and exits
    },
  };
}

export const resumeSession = (id: string, options: Options) => createSession({ ...options, resume: id });

/** unstable_v2_prompt: a single-message query() is already that. */
export async function prompt(text: string, options: Options): Promise<SDKResultMessage> {
  for await (const m of query({ prompt: text, options })) if (m.type === "result") return m;
  throw new Error("Session ended without result message");
}
// #endregion

// #region queryoptions
/** The same settings V2 used (all built-in tools, no settings files), unless `extra` changes them. */
function queryOptions(abort: AbortController, spawnLog?: string, extra: Partial<Options> = {}): Options {
  return {
    model: MODEL,
    cwd: WORK,
    env: labEnv(NEW, spawnLog),
    pathToClaudeCodeExecutable: LAUNCHER, // only to count processes
    settingSources: [], // V2's default; query() alone would load user, project and local settings
    abortController: abort, // V2 had none
    ...extra,
  };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /resume: an upgrade keeps the stored session ids. Resume the V2 session with V2, or with today's query()
// ---------------------------------------------------------------------------------------------

// #region resume
async function resumeLast(how: "v2" | "query", emit: Emit, abort: AbortController) {
  const id = existsSync(LAST) ? readFileSync(LAST, "utf8").trim() : "";
  if (!id) throw new Error("No V2 session yet: run 2 first.");
  if (how === "v2") {
    const { unstable_v2_resumeSession } = await loadV2();
    emit("call", { code: `const session = unstable_v2_resumeSession("${id}", options)` });
    const session = unstable_v2_resumeSession(id, v2Options());
    abort.signal.addEventListener("abort", () => session.close());
    emit("call", { code: "session.sessionId", note: session.sessionId }); // known at once: it is the id you passed
    emit("call", { code: `await session.send(${q(QUESTION)})` });
    await session.send(QUESTION);
    for await (const m of session.stream()) emit("message", { raw: m, ...summary(m) });
    session.close();
    emit("call", { code: "session.close()" });
    return;
  }
  // Today: the Concept 6 way. The session was written by Claude Code 2.1.141 and is read by the newer CLI.
  emit("call", { code: `query({ prompt: ${q(QUESTION)}, options: { ...options, resume: "${id}" } })` });
  for await (const m of query({ prompt: QUESTION, options: queryOptions(abort, undefined, { resume: id }) })) emit("message", { raw: m, ...summary(m) });
}
// #endregion

const ResumeBody = z.object({ how: z.enum(["v2", "query"]) }).strict();

concept41.post("/resume", async (req, res) => {
  const parsed = ResumeBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  try {
    if (!parsed.success) throw new Error(badRequest(parsed.error));
    ready();
    await resumeLast(parsed.data.how, emit, abort);
  } catch (err) {
    if (!abort.signal.aborted) emit("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /compare: the same three turns, four ways, at the same time
// ---------------------------------------------------------------------------------------------

type Way = "v2" | "wrapper" | "lean" | "resume";
type Turn = { answer: string; ms: number; cost: number };
type Run = { turns: Turn[]; sessionIds: Set<string>; cli?: string; tools?: number };

// #region compare
/** The script through any object with send() and stream(): V2's SDKSession and createSession() both fit. */
async function drive(session: { send(t: string): Promise<void>; stream(): AsyncGenerator<any> }, run: Run, emit: Emit) {
  for (const text of SCRIPT) {
    const t0 = Date.now();
    await session.send(text);
    for await (const m of session.stream()) track(m, run, emit, t0);
  }
}

async function runWay(way: Way, spawnLog: string, abort: AbortController, emit: Emit): Promise<Run> {
  const run: Run = { turns: [], sessionIds: new Set() };
  if (way === "v2") {
    const { unstable_v2_createSession } = await loadV2();
    const session = unstable_v2_createSession(v2Options(spawnLog));
    abort.signal.addEventListener("abort", () => session.close());
    try {
      await drive(session, run, emit);
    } finally {
      session.close();
    }
  } else if (way === "wrapper" || way === "lean") {
    // "lean" does what SDKSessionOptions could not: no tools, no thinking
    const extra: Partial<Options> = way === "lean" ? { tools: [], thinking: { type: "disabled" } } : {};
    const session = createSession(queryOptions(abort, spawnLog, extra));
    try {
      await drive(session, run, emit);
    } finally {
      session.close();
    }
  } else {
    // Concept 6: one query() per turn, each a new Claude Code process that reloads the session from disk
    let resume: string | undefined;
    for (const text of SCRIPT) {
      const t0 = Date.now();
      for await (const m of query({ prompt: text, options: queryOptions(abort, spawnLog, resume ? { resume } : {}) })) {
        track(m, run, emit, t0);
        if (m.type === "system" && m.subtype === "init") resume = m.session_id;
      }
    }
  }
  return run;
}
// #endregion

function track(m: any, run: Run, emit: Emit, t0: number) {
  if (m.type === "system" && m.subtype === "init") {
    run.sessionIds.add(m.session_id);
    run.cli ??= m.claude_code_version;
    run.tools ??= m.tools.length;
  }
  if (m.type === "result") run.turns.push({ answer: m.subtype === "success" ? m.result : m.subtype, ms: Date.now() - t0, cost: m.total_cost_usd });
  const s = summary(m);
  if (m.type !== "system" || m.subtype === "init") emit("message", s); // no raw here: four streams at once
}

const WAYS: { way: Way; label: string; sdk: string }[] = [
  { way: "v2", label: "unstable_v2_createSession()", sdk: OLD },
  { way: "wrapper", label: "createSession() on query()", sdk: NEW },
  { way: "lean", label: "createSession() + tools: [], thinking off", sdk: NEW },
  { way: "resume", label: "query() + resume, one per turn", sdk: NEW },
];

concept41.post("/compare", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  try {
    ready();
    const stamp = Date.now();
    await Promise.all(
      WAYS.map(async ({ way, label, sdk }) => {
        const emit: Emit = (e, d) => send(e, { ...d, way, at: Date.now() - startedAt });
        const spawnLog = path.join(SPAWNS, `${stamp}-${way}.log`);
        writeFileSync(spawnLog, "");
        const t0 = Date.now();
        try {
          const run = await runWay(way, spawnLog, abort, emit);
          const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
          // Every result carries the session's running total, after a resume too (Claude Code 2.1.281): take the last.
          const cost = run.turns.at(-1)?.cost ?? 0;
          const sdkVersion = versionOf(sdk);
          send("row", { way, label, sdk: sdkVersion, cli: run.cli, tools: run.tools, processes: spawns.length, resumed: spawns.filter((p) => p.resume).length, sessionIds: [...run.sessionIds], turns: run.turns, cost, ms: Date.now() - t0 });
        } catch (err) {
          if (!abort.signal.aborted) send("row", { way, label, error: errText(err), ms: Date.now() - t0 });
        }
      }),
    );
    // Old logs only fill the folder: keep this run's.
    for (const f of readdirSync(SPAWNS)) if (!f.startsWith(String(stamp))) rmSync(path.join(SPAWNS, f), { force: true });
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept41.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
