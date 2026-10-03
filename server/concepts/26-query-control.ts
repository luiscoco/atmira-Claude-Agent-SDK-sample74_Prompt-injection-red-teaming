/**
 * CONCEPT 26 — Query control methods: the Query object is a remote control for a running session
 *
 * query() returns a Query. It is an async iterator of messages (Concept 1), and it also has METHODS that send
 * control requests to the Claude Code process while the session runs. Each one is a round trip on the same pipe
 * as the messages, so they need streaming input (Concept 12): the process must stay alive between turns.
 *
 *   ask       initializationResult(), supportedModels(), supportedCommands(), supportedAgents(),
 *             mcpServerStatus(), accountInfo(), getContextUsage(), readFile(path)
 *   steer     setModel(model), setPermissionMode(mode)            -> take effect from the next request
 *   stop      interrupt()                                          -> ends the current turn, the session stays
 *             backgroundTasks(toolUseId?)                          -> a running Bash command stops blocking the turn
 *             stopTask(taskId)                                     -> kills a background task
 *             close()                                              -> ends the session and its process
 *
 * Earlier tabs used some of them as side notes (10 interrupt, 12 setModel/setPermissionMode, 13 the MCP ones,
 * 14 applyFlagSettings/setMaxThinkingTokens, 17 rewindFiles, 23 initializationResult). Here the browser drives a
 * LIVE session: it sends prompts and calls methods at any time, and sees the messages each call causes.
 *
 * Routes: GET /catalog (no model calls), POST /open (SSE, one live session), POST /call, GET /code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept26 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const MAX_SESSIONS = 2;
const IDLE_MS = 10 * 60_000; // a session nobody calls for 10 minutes is closed
const KEEP_ENDED_MS = 60_000; // a closed session stays callable for a minute, to show what its methods do after close()

// The agent works in control-lab/work. slow.mjs prints one line per second: the slow command to interrupt,
// background or stop. (A plain `sleep 30` is refused by the Bash tool itself: "Blocked: standalone sleep".)
const LAB = path.resolve("control-lab");
const WORK = path.join(LAB, "work");
const CONFIG_DIR = path.join(LAB, "config");
const TMP_DIR = path.join(LAB, "tmp");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [WORK, CONFIG_DIR, TMP_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(WORK, "notes.txt"), "Release checklist: tag, build, smoke test, announce.\n");
writeFileSync(
  path.join(WORK, "slow.mjs"),
  `const n = Number(process.argv[2] ?? 10);\nfor (let i = 1; i <= n; i++) {\n  await new Promise((r) => setTimeout(r, 1000));\n  console.log("tick " + i + "/" + n);\n}\nconsole.log("finished");\n`,
);
const short = (s: string) => s.replaceAll(LAB, "control-lab");

// #region canUseTool
// Only one Bash command is allowed. Everything else that needs permission is denied here, so in "default" mode a
// Write is denied, and after setPermissionMode("acceptEdits") the same Write never reaches this function.
function policy(onDecision: (d: { tool: string; input: unknown; allowed: boolean }) => void): CanUseTool {
  return async (tool, input) => {
    const allowed = tool === "Bash" && /^node slow\.mjs ([1-9]|[1-5]\d|60)$/.test(String(input.command ?? "").trim());
    onDecision({ tool, input, allowed });
    return allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Denied by the lab's canUseTool: only `node slow.mjs N` (N up to 60) is allowed." };
  };
}
// #endregion

// #region options
function baseOptions(extra: Partial<Options>): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR; // plan mode writes its plan file here, not in the real ~/.claude
  env.CLAUDE_CODE_TMPDIR = TMP_DIR; // background Bash output files go here, not in the system temp folder
  return {
    model: MODEL,
    cwd: WORK,
    tools: ["Read", "Write", "Bash"],
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    env,
    ...extra,
  };
}
// #endregion

/** A prompt that never sends a message: the session starts, answers control requests, and costs nothing. */
async function* silent(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
}

// #region methods
// The control methods the browser may call, each with the arguments it accepts. Values that are too big to show
// (60 slash commands, full model descriptions) are cut down; the call itself is the real one.
type Control = { kind: "ask" | "steer" | "stop"; args?: z.ZodType; run: (q: Query, args: any) => Promise<unknown> | unknown };

const MODELS = [MODEL, "sonnet", "default"] as const; // "default" -> setModel(undefined): Claude Code's default model
const MODES = ["default", "acceptEdits", "plan", "dontAsk"] as const; // bypassPermissions needs allowDangerouslySkipPermissions

const CONTROLS: Record<string, Control> = {
  initializationResult: {
    kind: "ask",
    run: async (q) => {
      const r = await q.initializationResult();
      return { commands: r.commands.length, agents: r.agents.map((a) => a.name), models: r.models.map((m) => m.value), output_style: r.output_style, available_output_styles: r.available_output_styles, account: r.account };
    },
  },
  supportedModels: { kind: "ask", run: async (q) => (await q.supportedModels()).map(({ value, resolvedModel, displayName }) => ({ value, resolvedModel, displayName })) },
  supportedCommands: { kind: "ask", run: async (q) => (await q.supportedCommands()).map((c) => `/${c.name}`) },
  supportedAgents: { kind: "ask", run: async (q) => (await q.supportedAgents()).map((a) => a.name) },
  mcpServerStatus: { kind: "ask", run: (q) => q.mcpServerStatus() },
  accountInfo: { kind: "ask", run: (q) => q.accountInfo() },
  getContextUsage: {
    kind: "ask",
    run: async (q) => {
      const u = await q.getContextUsage({ detail: "summary" });
      return { model: u.model, totalTokens: u.totalTokens, maxTokens: u.maxTokens, categories: u.categories.map(({ name, tokens }) => `${name}: ${tokens}`) };
    },
  },
  readFile: {
    kind: "ask",
    args: z.object({ path: z.string().min(1).max(200) }).strict(),
    run: async (q, { path: p }) => {
      const r = await q.readFile(p, { maxBytes: 2000 }); // null outside cwd, when missing, or when a Read rule denies it
      return r && { ...r, absPath: short(r.absPath) };
    },
  },
  setModel: {
    kind: "steer",
    args: z.object({ model: z.enum(MODELS) }).strict(),
    run: (q, { model }) => q.setModel(model === "default" ? undefined : model),
  },
  setPermissionMode: { kind: "steer", args: z.object({ mode: z.enum(MODES) }).strict(), run: (q, { mode }) => q.setPermissionMode(mode) },
  interrupt: { kind: "stop", run: (q) => q.interrupt() },
  backgroundTasks: {
    kind: "stop",
    args: z.object({ toolUseId: z.string().max(100).optional() }).strict(),
    run: (q, { toolUseId }) => q.backgroundTasks(toolUseId),
  },
  stopTask: { kind: "stop", args: z.object({ taskId: z.string().min(1).max(100) }).strict(), run: (q, { taskId }) => q.stopTask(taskId) },
  close: { kind: "stop", run: (q) => q.close() },
};

/** Validates and runs one control method. Never throws: the error is part of what the lab shows. */
async function callControl(q: Query, method: string, rawArgs: unknown) {
  const control = Object.hasOwn(CONTROLS, method) ? CONTROLS[method] : undefined;
  if (!control) return { ok: false, error: `Unknown method. Allowed: ${Object.keys(CONTROLS).join(", ")}.`, ms: 0 };
  const parsed = (control.args ?? z.object({}).strict()).safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Bad arguments for ${method}: ${parsed.error.issues.map((i) => i.message).join("; ")}`, ms: 0 };
  const t = Date.now();
  try {
    const value = await control.run(q, parsed.data);
    return { ok: true, value: value === undefined ? "undefined" : value, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: String(err), ms: Date.now() - t };
  }
}
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /catalog: every "ask" method on a session that never sends a prompt. No model calls.
// ---------------------------------------------------------------------------------------------

concept26.get("/catalog", async (_req, res) => {
  const stop = new AbortController();
  const q = query({ prompt: silent(stop.signal), options: baseOptions({ abortController: stop, canUseTool: policy(() => {}) }) });
  const calls: [string, unknown][] = [
    ["initializationResult", {}],
    ["supportedModels", {}],
    ["supportedCommands", {}],
    ["supportedAgents", {}],
    ["mcpServerStatus", {}],
    ["accountInfo", {}],
    ["getContextUsage", {}],
    ["readFile", { path: "notes.txt" }],
    ["readFile", { path: "../../package.json" }],
  ];
  const out = [];
  try {
    for (const [method, args] of calls) out.push({ method, args, ...(await callControl(q, method, args)) });
  } finally {
    stop.abort();
    q.close();
  }
  res.json(out);
});

// ---------------------------------------------------------------------------------------------
// POST /open: one live session, streamed until it ends. POST /call acts on it.
// ---------------------------------------------------------------------------------------------

type Live = { q: Query; push: (text: string) => void; send: (event: string, data: object) => void; touch: () => void; ended: boolean };
const sessions = new Map<string, Live>();

concept26.post("/open", (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const at = () => Date.now() - startedAt;
  const emit = (event: string, data: object) => send(event, { ...data, at: at() });
  if ([...sessions.values()].filter((s) => !s.ended).length >= MAX_SESSIONS) {
    send("error", { message: `Already ${MAX_SESSIONS} live sessions. Close one first.` });
    send("done", {});
    return res.end();
  }

  // Streaming input: a queue the browser fills with POST /call { method: "prompt" }. A prompt sent while a turn
  // runs waits in the queue and starts when the turn ends.
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!abort.signal.aborted) {
      while (queue.length) yield queue.shift()!;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const id = randomUUID().slice(0, 8);
  const options = baseOptions({ abortController: abort, canUseTool: policy((d) => emit("canUseTool", d)) });
  const q = query({ prompt: input(), options });
  let idle: NodeJS.Timeout | undefined;
  const live: Live = {
    q,
    push: (text) => {
      queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } });
      wake?.();
    },
    send: emit,
    touch: () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        emit("error", { message: `Closed by the server after ${IDLE_MS / 60_000} idle minutes.` });
        q.close();
      }, IDLE_MS);
    },
    ended: false,
  };
  sessions.set(id, live);
  live.touch();
  console.log(`[c26] session ${id} opened`);
  emit("opened", { id, options: { ...options, env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'control-lab/config', CLAUDE_CODE_TMPDIR: 'control-lab/tmp' }", canUseTool: "[Function policy]", abortController: "[AbortController]", cwd: short(WORK) } });

  (async () => {
    try {
      for await (const msg of q) relay(msg, emit);
      emit("ended", { how: "the message iterator finished" });
    } catch (err) {
      emit("ended", { how: abort.signal.aborted ? "the browser disconnected" : `the iterator threw: ${String(err)}` });
    } finally {
      live.ended = true;
      clearTimeout(idle);
      console.log(`[c26] session ${id} ended`);
      setTimeout(() => sessions.delete(id), KEEP_ENDED_MS);
      send("done", {});
      res.end();
    }
  })();
});

// The body of POST /call. Each method's own arguments are checked later, by its entry in CONTROLS.
const CallBody = z
  .object({
    id: z.string().max(40).nullable(), // null: the tab has no session yet (a 404 below)
    method: z.string().min(1).max(40),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

concept26.post("/call", async (req, res) => {
  const parsed = CallBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
  const { id, method, args } = parsed.data;
  const live = id ? sessions.get(id) : undefined;
  if (!live) return res.status(404).json({ ok: false, error: "No such session (it ended more than a minute ago, or never existed)." });
  live.touch();

  // Sending a prompt is not a control method: it writes to the input stream.
  if (method === "prompt") {
    const text = (args as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return res.status(400).json({ ok: false, error: "Send args.text (1 to 2000 characters)." });
    if (live.ended) return res.json({ ok: false, error: "The session has ended: nothing reads the input stream any more.", ms: 0 });
    live.push(text);
    live.send("call", { method, args: { text }, ok: true, value: "queued in the input stream", ms: 0 });
    return res.json({ ok: true, value: "queued in the input stream", ms: 0 });
  }
  const out = await callControl(live.q, method, args);
  // After the session ended its event stream is closed, so the browser adds this call to its list itself.
  const streamed = !live.ended;
  if (streamed) live.send("call", { method, args: args ?? {}, ...out });
  res.json({ ...out, streamed });
});

// #region messages
/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, emit: (event: string, data: object) => void) {
  if (msg.type === "system") {
    if (msg.subtype === "init") emit("init", { model: msg.model, permissionMode: msg.permissionMode }); // once per turn
    if (msg.subtype === "status") emit("status", { status: msg.status, permissionMode: msg.permissionMode }); // after setPermissionMode
    if (msg.subtype === "task_started") emit("task", { subtype: msg.subtype, task_id: msg.task_id, tool_use_id: msg.tool_use_id, description: msg.description, is_backgrounded: msg.is_backgrounded });
    if (msg.subtype === "task_updated") emit("task", { subtype: msg.subtype, task_id: msg.task_id, patch: msg.patch });
    if (msg.subtype === "task_notification") emit("task", { subtype: msg.subtype, task_id: msg.task_id, tool_use_id: msg.tool_use_id, status: msg.status });
    return;
  }
  if (msg.type === "assistant" && !msg.parent_tool_use_id) {
    for (const b of msg.message.content) {
      if (b.type === "text") emit("assistant", { model: msg.message.model, text: b.text });
      if (b.type === "tool_use") emit("toolUse", { model: msg.message.model, id: b.id, name: b.name, input: b.input });
    }
    return;
  }
  if (msg.type === "user") {
    const content = msg.message.content;
    // setModel() answers with a local command's output, like /model in the terminal.
    if (typeof content === "string") return emit("local", { text: content });
    for (const b of content as any[]) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: short(text).slice(0, 500) });
    }
    return;
  }
  if (msg.type === "result") {
    emit("result", { subtype: msg.subtype, num_turns: msg.num_turns, cost: msg.total_cost_usd, stop_reason: msg.stop_reason, text: msg.subtype === "success" ? msg.result : undefined });
  }
}
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers (Concepts 24 and 25 do the same)
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept26.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
