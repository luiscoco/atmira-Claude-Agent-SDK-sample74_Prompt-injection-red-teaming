/**
 * CONCEPT 27 — Background tasks: work that keeps running while the conversation goes on
 *
 * A TASK is a Bash command, a subagent or a Monitor that Claude Code runs next to the conversation. Concept 26 moved
 * a task to the background from the HOST (q.backgroundTasks, q.stopTask). This concept follows a task's whole life:
 *
 *   who starts it     the model: Bash run_in_background, a Bash timeout, a background subagent, the Monitor tool
 *   how you see it    system/background_tasks_changed (the full set: REPLACE), task_started / task_updated /
 *                     task_progress / task_notification (edges), the Stop hook's background_tasks
 *   how the model     a task_notification starts a NEW turn by itself; meanwhile the model can Read the output file
 *   hears about it
 *   how it ends       completed, TaskStop (the model), q.stopTask (the host), interrupt(), the end of a one-shot run
 *   how to turn it off  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
 *
 * Routes: POST /oneshot (SSE, a string prompt), POST /open (SSE, one live session), POST /call, GET /code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type CanUseTool, type HookCallback, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept27 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const MAX_SESSIONS = 2;
const IDLE_MS = 10 * 60_000; // a session nobody calls for 10 minutes is closed
const KEEP_ENDED_MS = 60_000;

// The agent works in bg-lab/work. slow.mjs prints one line per second: the command to run in the background.
// Background output files go to bg-lab/tmp (CLAUDE_CODE_TMPDIR), not the system temp folder.
const LAB = path.resolve("bg-lab");
const WORK = path.join(LAB, "work");
const CONFIG_DIR = path.join(LAB, "config");
const TMP_DIR = path.join(LAB, "tmp");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [WORK, CONFIG_DIR, TMP_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(WORK, "slow.mjs"),
  `const n = Number(process.argv[2] ?? 10);\nfor (let i = 1; i <= n; i++) {\n  await new Promise((r) => setTimeout(r, 1000));\n  console.log("tick " + i + "/" + n);\n}\nconsole.log("finished");\n`,
);
/** Shortens paths for the browser: bg-lab\tmp\claude\…\<session>\tasks\<id>.output */
const short = (s: string) =>
  s
    .replaceAll(LAB, "bg-lab")
    .replace(/(bg-lab[\\/]+tmp[\\/]+claude[\\/]+)[^\\/"]+/g, "$1…");

// #region canUseTool
// Everything the lab lets the model do. The subagent's Bash comes through here too.
/** True for `dir` itself or a path inside it (not a sibling folder that only starts with the same name). */
const inside = (dir: string, p: string) => {
  const r = path.relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r));
};
const SLOW = /^node slow\.mjs ([1-9]|[1-5]\d|60)$/;
/** `node slow.mjs N`, optionally after `cd "<the work folder>" &&` (subagents like to add that). */
function isSlow(command: string) {
  const m = command.trim().match(/^cd\s+"?([^"&]+?)"?\s*&&\s*(.+)$/);
  if (m && path.resolve(m[1]).toLowerCase() !== WORK.toLowerCase()) return false; // Windows paths: c:\ and C:\ are the same
  return SLOW.test((m ? m[2] : command).trim());
}
function policy(onDecision: (d: { tool: string; input: unknown; allowed: boolean }) => void): CanUseTool {
  return async (tool, input) => {
    let allowed = false;
    if (tool === "Bash" || tool === "Monitor") allowed = isSlow(String(input.command ?? ""));
    if (tool === "Read") allowed = inside(LAB, path.resolve(WORK, String(input.file_path ?? ""))); // the output files are in bg-lab/tmp
    if (tool === "Agent") allowed = input.subagent_type === "waiter";
    if (tool === "TaskStop") allowed = true;
    onDecision({ tool, input, allowed });
    return allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Denied by the lab's canUseTool: only `node slow.mjs N` (N up to 60), Read inside bg-lab, the waiter agent and TaskStop." };
  };
}
// #endregion

// #region options
// What a session may be opened with. Everything else is fixed.
const Profile = z
  .object({
    disableBackground: z.boolean().optional(), // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
    perTaskStopAffordance: z.boolean().optional(), // "my UI has a stop button per task": interrupt() spares background agents
  })
  .strict();
type Profile = z.infer<typeof Profile>;

function baseOptions(profile: Profile, extra: Partial<Options>): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  env.CLAUDE_CODE_TMPDIR = TMP_DIR; // <tmp>/claude/<cwd>/<session>/tasks/<task id>.output
  if (profile.disableBackground) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return {
    model: MODEL,
    cwd: WORK,
    tools: ["Read", "Bash", "Agent", "Monitor", "TaskStop"],
    agents: {
      // background: true -> every call of this agent is a background task, whatever the model asks for
      waiter: {
        description: "Runs one slow command and reports its last output line.",
        prompt: "Run exactly the Bash command you are given, as it is (no cd), in the foreground, then report its last output line. If it is denied or fails, say so.",
        tools: ["Bash"],
        model: "haiku",
        background: true,
      },
    },
    agentProgressSummaries: true, // task_progress.summary for subagents, about every 30 s
    perTaskStopAffordance: profile.perTaskStopAffordance ?? false,
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    env,
    ...extra,
  };
}

/** The Stop hook runs when a turn ends. Its input lists the background work that is still running. */
function stopHook(emit: (event: string, data: object) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name === "Stop") emit("stopHook", { background_tasks: input.background_tasks ?? [] });
    return {};
  };
}
// #endregion

const optionsForBrowser = (profile: Profile, options: Options) => ({
  ...options,
  env: `{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'bg-lab/config', CLAUDE_CODE_TMPDIR: 'bg-lab/tmp'${profile.disableBackground ? ", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'" : ""} }`,
  canUseTool: "[Function policy]",
  hooks: { Stop: "[Function stopHook]" },
  abortController: "[AbortController]",
  cwd: short(WORK),
});

// ---------------------------------------------------------------------------------------------
// POST /oneshot: a STRING prompt. The run ends after one turn, and so do its background tasks.
// ---------------------------------------------------------------------------------------------

concept27.post("/oneshot", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit = (event: string, data: object) => send(event, { ...data, at: Date.now() - startedAt });
  const prompt = "Run the Bash command `node slow.mjs 15` with run_in_background set to true. Then reply: started";
  const profile: Profile = {};
  const options = baseOptions(profile, {
    abortController: abort,
    canUseTool: policy((d) => emit("canUseTool", d)),
    hooks: { Stop: [{ hooks: [stopHook(emit)] }] },
  });
  emit("opened", { id: "one-shot", prompt, options: optionsForBrowser(profile, options) });
  try {
    for await (const msg of query({ prompt, options })) relay(msg, emit);
    emit("ended", { how: "the message iterator finished" });
  } catch (err) {
    emit("ended", { how: abort.signal.aborted ? "the browser disconnected" : `the iterator threw: ${String(err)}` });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /open: one live session (streaming input), streamed until it ends. POST /call acts on it.
// ---------------------------------------------------------------------------------------------

type Live = { q: Query; push: (text: string) => void; send: (event: string, data: object) => void; touch: () => void; ended: boolean };
const sessions = new Map<string, Live>();

concept27.post("/open", (req, res) => {
  const parsed = Profile.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit = (event: string, data: object) => send(event, { ...data, at: Date.now() - startedAt });
  const refuse = (message: string) => {
    send("error", { message });
    send("done", {});
    res.end();
  };
  if (!parsed.success) return refuse(`Bad profile: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if ([...sessions.values()].filter((s) => !s.ended).length >= MAX_SESSIONS) return refuse(`Already ${MAX_SESSIONS} live sessions. Close one first.`);
  const profile = parsed.data;

  // Streaming input: a push queue. Without it the process would end after one turn, and its tasks with it.
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!abort.signal.aborted) {
      while (queue.length) yield queue.shift()!;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const id = randomUUID().slice(0, 8);
  const options = baseOptions(profile, {
    abortController: abort,
    canUseTool: policy((d) => emit("canUseTool", d)),
    hooks: { Stop: [{ hooks: [stopHook(emit)] }] },
  });
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
  console.log(`[c27] session ${id} opened`, profile);
  emit("opened", { id, profile, options: optionsForBrowser(profile, options) });

  (async () => {
    try {
      for await (const msg of q) relay(msg, emit);
      emit("ended", { how: "the message iterator finished" });
    } catch (err) {
      emit("ended", { how: abort.signal.aborted ? "the browser disconnected" : `the iterator threw: ${String(err)}` });
    } finally {
      live.ended = true;
      clearTimeout(idle);
      console.log(`[c27] session ${id} ended`);
      setTimeout(() => sessions.delete(id), KEEP_ENDED_MS);
      send("done", {});
      res.end();
    }
  })();
});

// The host side of a task: the methods from Concept 26 that act on tasks.
const CONTROLS: Record<string, { args?: z.ZodType; run: (q: Query, args: any) => Promise<unknown> }> = {
  backgroundTasks: { args: z.object({ toolUseId: z.string().max(100).optional() }).strict(), run: (q, { toolUseId }) => q.backgroundTasks(toolUseId) },
  stopTask: { args: z.object({ taskId: z.string().min(1).max(100) }).strict(), run: (q, { taskId }) => q.stopTask(taskId) },
  interrupt: { run: (q) => q.interrupt() },
  close: { run: async (q) => q.close() },
};

// The body of POST /call. Each method's own arguments are checked later, by its entry in CONTROLS.
const CallBody = z
  .object({
    id: z.string().max(40).nullable(), // null: the tab has no session yet (a 404 below)
    method: z.string().min(1).max(40),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

concept27.post("/call", async (req, res) => {
  const parsed = CallBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
  const { id, method, args } = parsed.data;
  const live = id ? sessions.get(id) : undefined;
  if (!live) return res.status(404).json({ ok: false, error: "No such session (it ended more than a minute ago, or never existed)." });
  live.touch();

  if (method === "prompt") {
    const text = (args as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return res.status(400).json({ ok: false, error: "Send args.text (1 to 2000 characters)." });
    if (live.ended) return res.json({ ok: false, error: "The session has ended: nothing reads the input stream any more.", ms: 0 });
    live.push(text);
    live.send("call", { method, args: { text }, ok: true, value: "queued in the input stream", ms: 0 });
    return res.json({ ok: true, value: "queued in the input stream", ms: 0 });
  }
  const control = Object.hasOwn(CONTROLS, method) ? CONTROLS[method] : undefined;
  if (!control) return res.status(400).json({ ok: false, error: `Unknown method. Allowed: prompt, ${Object.keys(CONTROLS).join(", ")}.` });
  const argsParsed = (control.args ?? z.object({}).strict()).safeParse(args ?? {});
  if (!argsParsed.success) return res.status(400).json({ ok: false, error: `Bad arguments for ${method}: ${argsParsed.error.issues.map((i) => i.message).join("; ")}` });
  const t = Date.now();
  let out: { ok: boolean; value?: unknown; error?: string; ms: number };
  try {
    const value = await control.run(live.q, argsParsed.data);
    out = { ok: true, value: value === undefined ? "undefined" : value, ms: Date.now() - t };
  } catch (err) {
    out = { ok: false, error: String(err), ms: Date.now() - t };
  }
  const streamed = !live.ended;
  if (streamed) live.send("call", { method, args: args ?? {}, ...out });
  res.json({ ...out, streamed });
});

// #region messages
// The tool_use_result fields that say a tool call went to the background.
const BG_KEYS = ["backgroundTaskId", "timedOutAfterMs", "backgroundedByUser", "isAsync", "status", "agentId", "taskId", "timeoutMs"];

/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, emit: (event: string, data: object) => void) {
  if (msg.type === "system") {
    switch (msg.subtype) {
      case "init":
        return emit("init", { model: msg.model, tools: msg.tools }); // once per turn, including the turns a task_notification starts
      // The LEVEL: every live background task after a change. Replace your set with it.
      case "background_tasks_changed":
        return emit("bgSet", { tasks: msg.tasks });
      // The EDGES of one task's life.
      case "task_started":
        return emit("task", { subtype: msg.subtype, task_id: msg.task_id, tool_use_id: msg.tool_use_id, task_type: msg.task_type, subagent_type: msg.subagent_type, description: msg.description, is_backgrounded: msg.is_backgrounded, owned_by_subagent: (msg as { owned_by_subagent?: boolean }).owned_by_subagent });
      case "task_updated":
        return emit("task", { subtype: msg.subtype, task_id: msg.task_id, patch: msg.patch });
      case "task_progress":
        return emit("task", { subtype: msg.subtype, task_id: msg.task_id, description: msg.description, summary: msg.summary, usage: msg.usage, last_tool_name: msg.last_tool_name });
      case "task_notification":
        return emit("task", { subtype: msg.subtype, task_id: msg.task_id, tool_use_id: msg.tool_use_id, status: msg.status, summary: msg.summary, usage: msg.usage, output_file: short(msg.output_file ?? "") });
    }
    return;
  }
  if (msg.type === "tool_progress") return emit("toolProgress", { tool_name: msg.tool_name, elapsed: msg.elapsed_time_seconds, sub: !!msg.parent_tool_use_id });
  if (msg.type === "assistant") {
    const sub = !!msg.parent_tool_use_id; // a subagent's own messages
    for (const b of msg.message.content) {
      if (b.type === "text") emit("assistant", { sub, text: b.text });
      if (b.type === "tool_use") emit("toolUse", { sub, id: b.id, name: b.name, input: b.input });
    }
    return;
  }
  if (msg.type === "user") {
    const content = msg.message.content;
    if (typeof content === "string") return;
    const r = (msg.tool_use_result ?? {}) as Record<string, unknown>;
    const meta = Object.fromEntries(BG_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
    for (const b of content as any[]) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { sub: !!msg.parent_tool_use_id, tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: short(text).slice(0, 400), meta });
    }
    return;
  }
  if (msg.type === "result") {
    emit("result", { subtype: msg.subtype, num_turns: msg.num_turns, cost: msg.total_cost_usd, text: msg.subtype === "success" ? msg.result : undefined });
  }
}
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept27.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
