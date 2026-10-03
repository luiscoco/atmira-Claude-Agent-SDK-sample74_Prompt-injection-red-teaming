/**
 * CONCEPT 30 — Todo tracking: how the agent plans with a todo list, how your code sees it, and how your code can drive it
 *
 * Claude Code has TWO todo systems, and which one the model gets depends on the model and on two env variables:
 *
 *   Task tools   TaskCreate / TaskUpdate / TaskList / TaskGet. One call per change. Each task is a JSON file in
 *                CLAUDE_CONFIG_DIR/tasks/<session id or CLAUDE_CODE_TASK_LIST_ID>/<id>.json, with blockedBy / blocks.
 *                The TaskCreated and TaskCompleted hooks fire, and can refuse the change. The default.
 *   TodoWrite    The older tool. Every call REWRITES the whole list; tool_use_result has { oldTodos, newTodos }.
 *                Nothing is written to disk: the list lives in the transcript. Used when CLAUDE_CODE_ENABLE_TASKS=false.
 *
 * Neither tool asks for permission (canUseTool is never called for them). In the default tool set they are DEFERRED:
 * the model must load them with ToolSearch first, so it rarely plans unless the prompt asks it to.
 *
 * The lab shows a live "todo board": read from the task files on disk (Task tools) or from tool_use_result (TodoWrite).
 *
 * Routes: POST /tools (SSE, which todo tools each setup gets), POST /run (SSE, a scenario), GET /code.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept30 = Router();

const MODEL = "claude-haiku-4-5-20251001";

// Each run works in its own todo-lab/runs/<run id> folder (so total.txt from the last run is not there yet).
// Transcripts and task lists go to one fake CLAUDE_CONFIG_DIR: todo-lab/config.
const LAB = path.resolve("todo-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [RUNS, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
const PRICES = "item,price\napple,1.20\nbread,2.50\nmilk,0.95\ncheese,4.10\n";
const escaped = JSON.stringify(LAB).slice(1, -1); // the path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) => s.replaceAll(LAB, "todo-lab").replaceAll(escaped, "todo-lab").replace(/todo-lab[\\/]+runs[\\/]+\w+[\\/]+/g, "");
/** True for `dir` itself or a path inside it (not a sibling folder that only starts with the same name). */
const inside = (dir: string, p: string) => {
  const r = path.relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r));
};

type Emit = (event: string, data: object) => void;
type Mode = "tasks" | "todo";
type Item = { id: string; subject: string; status: string; activeForm?: string; blockedBy?: string[]; owner?: string };

/** What one scenario needs: its folder, its mode, and what the board last showed. */
type Run = {
  id: string;
  work: string;
  mode: Mode;
  listId?: string; // CLAUDE_CODE_TASK_LIST_ID: a list the host owns (else the list is named after the session id)
  sessionId?: string;
  gate?: boolean; // Part B's hooks: a creation policy, a real completion check, and a task added by the host
  hostAdded?: boolean;
  board: Item[];
  boardJson: string;
  toolNames: Map<string, string>; // tool_use id → tool name, to label each tool_result
};

const active = new Set<string>();
function newRun(mode: Mode, extra: Partial<Run> = {}): Run {
  // Delete the folders of finished runs, keep the ones still running.
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "prices.csv"), PRICES);
  active.add(id);
  return { id, work, mode, board: [], boardJson: "[]", toolNames: new Map(), ...extra };
}

const TASK_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob"];

// #region options
function baseOptions(run: Run, emit: Emit, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR; // the task files go to CLAUDE_CONFIG_DIR/tasks/
  if (run.mode === "todo") env.CLAUDE_CODE_ENABLE_TASKS = "false"; // TodoWrite instead of the Task tools
  if (run.listId) env.CLAUDE_CODE_TASK_LIST_ID = run.listId; // work on the host's list, not a new one per session
  return {
    model: MODEL,
    cwd: run.work,
    // An explicit list: the todo tool must be in it, or the model does not get it. A short list is also cheaper.
    tools: [...FILE_TOOLS, ...(run.mode === "todo" ? ["TodoWrite"] : TASK_TOOLS)],
    // Only the file tools reach canUseTool: the todo tools never ask for permission.
    canUseTool: async (tool, input) => {
      const inRun = inside(run.work, path.resolve(run.work, String(input.file_path ?? input.path ?? ".")));
      if (FILE_TOOLS.includes(tool) && inRun) return { behavior: "allow", updatedInput: input };
      emit("denied", { tool });
      return { behavior: "deny", message: "Denied by the lab: only file tools inside the run folder." };
    },
    hooks: {
      TaskCreated: [{ hooks: [taskHook(run, emit)] }], // TaskCreate was called (Task tools only)
      TaskCompleted: [{ hooks: [taskHook(run, emit)] }], // TaskUpdate set status "completed" (Task tools only)
    },
    settingSources: [],
    persistSession: true, // the resume scenario needs the transcript
    thinking: { type: "disabled" },
    env,
    ...extra,
  };
}
// #endregion

const optionsForBrowser = (run: Run, options: Options) => ({
  ...options,
  env: [
    "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'todo-lab/config'",
    run.mode === "todo" && "CLAUDE_CODE_ENABLE_TASKS: 'false'",
    run.listId && `CLAUDE_CODE_TASK_LIST_ID: '${run.listId}'`,
  ].filter(Boolean).join(", ") + " }",
  canUseTool: "[Function: file tools inside the run folder only]",
  hooks: { TaskCreated: "[Function taskHook]", TaskCompleted: "[Function taskHook]" },
  abortController: options.abortController && "[AbortController]",
  cwd: `todo-lab/runs/${run.id}`,
});

// #region seed
// The host can write the plan itself: one JSON file per task, in the folder of the list CLAUDE_CODE_TASK_LIST_ID names.
// The model then finds it with TaskList. blockedBy / blocks are the dependencies TaskList shows.
const listDir = (run: Run) => path.join(CONFIG_DIR, "tasks", (run.listId ?? run.sessionId ?? "none").replace(/[^a-zA-Z0-9_-]/g, "-"));

function writeTask(run: Run, id: string, subject: string, description: string, blockedBy: string[] = [], blocks: string[] = []) {
  mkdirSync(listDir(run), { recursive: true });
  const task = { id, subject, description, activeForm: subject.replace(/^Write/, "Writing"), status: "pending", blocks, blockedBy };
  writeFileSync(path.join(listDir(run), `${id}.json`), JSON.stringify(task, null, 2));
}

function seedPlan(run: Run) {
  writeTask(run, "1", "Write total.txt", "Sum the prices in prices.csv and write the number to total.txt", [], ["3"]);
  writeTask(run, "2", "Write cheapest.txt", "Write the name of the cheapest item in prices.csv to cheapest.txt", [], ["3"]);
  writeTask(run, "3", "Write report.txt", "Write report.txt with the total and the cheapest item, read from total.txt and cheapest.txt", ["1", "2"]);
}
// #endregion

// #region hooks
// TaskCreated and TaskCompleted run BEFORE the change is saved. { decision: "block", reason } refuses it:
//   TaskCreated   → the task is deleted, and the model gets an is_error tool_result with the reason.
//   TaskCompleted → the status stays as it was, and TaskUpdate returns { success: false, error: reason }.
// The reason goes to the MODEL, so write it as an instruction it can act on.
function taskHook(run: Run, emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "TaskCreated" && input.hook_event_name !== "TaskCompleted") return {};
    const { hook_event_name: name, task_id, task_subject } = input;
    const verdict = run.gate ? gate(run, emit, name, task_subject, input.task_description ?? "", task_id) : undefined;
    emit("hook", { name, task_id, subject: task_subject, decision: verdict ? "block" : "allow", reason: verdict });
    return verdict ? { decision: "block", reason: verdict } : {};
  };
}

/** Part B's rules. Returns the reason to refuse, or undefined to allow. */
function gate(run: Run, emit: Emit, name: string, subject: string, description: string, taskId: string) {
  if (name === "TaskCreated") return /delete|remove/i.test(`${subject} ${description}`) ? "Policy: tasks that delete files are not allowed in this lab." : undefined;
  // TaskCompleted: check the work for real. A task named "Write x.txt" is done only when x.txt exists.
  const file = subject.match(/[\w-]+\.txt/)?.[0];
  if (file && !existsSync(path.join(run.work, file))) return `${file} does not exist yet. Write it, then mark task ${taskId} completed again.`;
  if (file === "report.txt" && !/^END\s*$/m.test(readFileSync(path.join(run.work, file), "utf8")))
    return "report.txt must end with a line that says END. Fix the file, then mark task 3 completed again.";
  // After task 2, the host adds a task of its own. The model sees it the next time it calls TaskList.
  if (taskId === "2" && !run.hostAdded) {
    run.hostAdded = true;
    writeTask(run, "4", "Write dearest.txt", "Added by the host: write the name of the dearest item in prices.csv to dearest.txt");
    emit("call", { method: `the host wrote ${short(listDir(run))}/4.json: “Write dearest.txt”` });
  }
  return undefined;
}
// #endregion

// #region board
// The todo board. Task tools: the host READS THE FILES (polled every 250 ms), the same source TaskList reads.
// TodoWrite: nothing is on disk, so the board comes from tool_use_result.newTodos.
function readDisk(run: Run): Item[] | undefined {
  const dir = listDir(run);
  if (!existsSync(dir)) return undefined;
  const items: Item[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue; // skip .lock and the high-water-mark file
    try {
      const t = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      items.push({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm, blockedBy: t.blockedBy, owner: t.owner });
    } catch {} // being written right now: the next poll reads it
  }
  return items.sort((a, b) => Number(a.id) - Number(b.id));
}

function showBoard(run: Run, items: Item[], source: string, emit: Emit) {
  const json = JSON.stringify(items);
  if (json === run.boardJson) return;
  // One row per status change, so the event list shows the plan moving.
  const before = new Map(run.board.map((i) => [i.id, i.status]));
  const changes = items.filter((i) => before.get(i.id) !== i.status).map((i) => ({ id: i.id, subject: i.subject, from: before.get(i.id) ?? null, to: i.status }));
  const gone = run.board.filter((i) => !items.some((n) => n.id === i.id)).map((i) => ({ id: i.id, subject: i.subject, from: i.status, to: "deleted" }));
  run.board = items;
  run.boardJson = json;
  emit("board", { source, dir: run.mode === "tasks" ? short(listDir(run)) : undefined, items });
  if (changes.length || gone.length) emit("change", { source, changes: [...changes, ...gone] });
}

function watchDisk(run: Run, emit: Emit) {
  const poll = () => {
    const items = run.mode === "tasks" && (run.listId || run.sessionId) ? readDisk(run) : undefined;
    if (items) showBoard(run, items, "disk", emit);
  };
  const timer = setInterval(poll, 250);
  return () => (clearInterval(timer), poll()); // one last read when the run ends
}

const fromTodoWrite = (todos: { content: string; status: string; activeForm: string }[]): Item[] =>
  todos.map((t, i) => ({ id: String(i + 1), subject: t.content, status: t.status, activeForm: t.activeForm }));
// #endregion

// #region messages
/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, run: Run, emit: Emit) {
  const m = msg as any;
  if (m.type === "system" && m.subtype === "init") {
    run.sessionId = m.session_id;
    return emit("init", { model: m.model, session_id: m.session_id, todoTools: m.tools.filter((t: string) => /^(Task(Create|Get|List|Update)|TodoWrite|ToolSearch)$/.test(t)) });
  }
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 500) });
      if (b.type === "tool_use") {
        run.toolNames.set(b.id, b.name);
        emit("toolUse", { name: b.name, input: JSON.parse(short(JSON.stringify(b.input))) });
      }
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const name = run.toolNames.get(b.tool_use_id) ?? "?";
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      // tool_use_result: the tool's full output object. For TodoWrite it holds the list before and after.
      const tur = m.tool_use_result;
      const isTodo = /^(Task|TodoWrite)/.test(name);
      emit("toolResult", { name, is_error: !!b.is_error, text: short(text).slice(0, 300), tool_use_result: isTodo && tur && typeof tur === "object" ? compact(tur) : undefined });
      if (name === "TodoWrite" && tur?.newTodos) showBoard(run, fromTodoWrite(tur.newTodos), "TodoWrite", emit);
    }
    return;
  }
  if (m.type === "result") {
    emit("result", {
      subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, cost: m.total_cost_usd, output_tokens: m.usage?.output_tokens,
      text: typeof m.result === "string" ? short(m.result).slice(0, 400) : undefined,
    });
  }
}

/** TodoWrite's old and new lists are long: show them as "status content" lines. */
function compact(tur: any) {
  if (!tur.newTodos) return tur;
  const line = (t: any) => `${t.status}: ${t.content}`;
  return { oldTodos: tur.oldTodos.map(line), newTodos: tur.newTodos.map(line) };
}

async function runOnce(prompt: string, options: Options, run: Run, emit: Emit) {
  const stop = watchDisk(run, emit);
  try {
    for await (const msg of query({ prompt, options })) relay(msg, run, emit);
  } catch (err) {
    emit("error", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  } finally {
    stop();
  }
}
// #endregion

// #region check
// The model saying "DONE" proves nothing: a blocked completion can be ignored. The host checks the board itself.
function check(run: Run, emit: Emit) {
  const left = run.board.filter((i) => i.status !== "completed");
  emit("check", {
    items: run.board.length,
    done: run.board.length - left.length,
    left: left.map((i) => `#${i.id} ${i.subject} (${i.status})`),
    files: readdirSync(run.work).filter((f) => f !== "prices.csv"),
  });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /run: one scenario
// ---------------------------------------------------------------------------------------------

const PLAN =
  "Plan this job with your todo tool first (TaskCreate, one task per step, or TodoWrite if that is the tool you have), then do it, marking each task in_progress before you start it and completed when it is done: " +
  "1) read prices.csv, 2) write total.txt with the sum of the prices, 3) write cheapest.txt with the cheapest item, 4) write report.txt with both. Reply DONE at the end.";
const PROMPTS = {
  unprompted: "Read prices.csv. Write total.txt with the sum of the prices, cheapest.txt with the cheapest item, dearest.txt with the dearest item, and report.txt with all three. Reply DONE.",
  seeded: "Your task list already holds the plan. Use TaskList, then work through it in order, respecting blockedBy, marking each task in_progress and then completed. Reply DONE.",
  gate: "Your task list already holds the plan. Use TaskList, then work through it, marking each task in_progress and then completed. At the end, also add a task to delete prices.csv. Before you reply, call TaskList again and finish anything left. Reply DONE.",
  resume1: `${PLAN.replace(" Reply DONE at the end.", "")} Do ONLY step 1 now and mark it completed, then stop and reply PAUSED.`,
  resume2: "Continue: finish the remaining tasks of your list. Reply DONE.",
};

const Scenario = z.enum(["tasks", "todo", "defaultTools", "unprompted", "seeded", "gate", "resume", "custom"]);
const RunBody = z
  .object({
    scenario: Scenario,
    prompt: z.string().trim().min(1).max(2000).optional(), // custom only
    mode: z.enum(["tasks", "todo"]).optional(), // custom only
  })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" });

concept30.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }), end();
  const b = parsed.data;
  const mode: Mode = b.scenario === "todo" ? "todo" : (b.mode ?? "tasks");
  const hostList = ["seeded", "gate"].includes(b.scenario);
  const run = newRun(mode, { gate: b.scenario === "gate" });
  if (hostList) run.listId = `plan-${run.id}`;
  const opened = (prompt: string, options: Options) => emit("opened", { prompt, options: optionsForBrowser(run, options) });
  try {
    if (hostList) {
      seedPlan(run);
      emit("call", { method: `the host wrote 3 tasks to ${short(listDir(run))}/ (task 3 blockedBy 1, 2)` });
    }
    if (b.scenario === "resume") {
      const first = baseOptions(run, emit, { abortController: abort });
      opened(PROMPTS.resume1, first);
      await runOnce(PROMPTS.resume1, first, run, emit);
      if (!run.sessionId || abort.signal.aborted) return;
      emit("call", { method: `query({ resume: "${run.sessionId.slice(0, 8)}…" }) — a new query() on the same session` });
      await runOnce(PROMPTS.resume2, baseOptions(run, emit, { abortController: abort, resume: run.sessionId }), run, emit);
    } else {
      const prompt = b.scenario === "custom" ? b.prompt! : b.scenario === "unprompted" || b.scenario === "seeded" || b.scenario === "gate" ? PROMPTS[b.scenario] : PLAN;
      // defaultTools: no `tools` option, so the model gets Claude Code's full set, where the todo tools are deferred.
      const extra: Partial<Options> = b.scenario === "defaultTools" ? { tools: undefined, disallowedTools: ["Bash", "Agent", "Task", "WebFetch", "WebSearch"] } : {};
      const options = baseOptions(run, emit, { abortController: abort, ...extra });
      opened(prompt, options);
      await runOnce(prompt, options, run, emit);
    }
    check(run, emit);
  } finally {
    active.delete(run.id);
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /tools: which todo tools does each setup get? One short turn each ("Reply with ok"), in parallel.
// ---------------------------------------------------------------------------------------------

const SETUPS: { label: string; model: string; env: Record<string, string>; tools?: string[] }[] = [
  { label: "Haiku 4.5, default tool set", model: MODEL, env: {} },
  { label: "Haiku 4.5, CLAUDE_CODE_ENABLE_TASKS=false", model: MODEL, env: { CLAUDE_CODE_ENABLE_TASKS: "false" } },
  { label: "Sonnet 5, default tool set", model: "claude-sonnet-5", env: {} },
  { label: "Sonnet 5, tools lists them", model: "claude-sonnet-5", env: {}, tools: ["Read", ...TASK_TOOLS, "TodoWrite"] },
  { label: "Haiku 4.5, tools: ['Read', 'Write']", model: MODEL, env: {}, tools: ["Read", "Write"] },
];

concept30.post("/tools", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  await Promise.all(
    SETUPS.map(async (s) => {
      const row: Record<string, unknown> = { label: s.label, model: s.model, env: s.env, tools: s.tools ?? "(default)" };
      try {
        const options: Options = { model: s.model, tools: s.tools, cwd: RUNS, settingSources: [], maxTurns: 1, persistSession: false, thinking: { type: "disabled" }, abortController: abort, env: { ...base, CLAUDE_CONFIG_DIR: CONFIG_DIR, ...s.env } };
        for await (const m of query({ prompt: "Reply with the single word: ok", options }) as AsyncIterable<any>) {
          if (m.type === "system" && m.subtype === "init") row.todoTools = m.tools.filter((t: string) => /^(Task(Create|Get|List|Update)|TodoWrite)$/.test(t));
          if (m.type === "result") row.cost = m.total_cost_usd;
        }
      } catch (err) {
        row.error = String((err as Error)?.message ?? err).slice(0, 200);
      }
      send("toolsRow", { ...row, at: Date.now() - startedAt });
    }),
  );
  send("done", {});
  res.end();
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept30.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
