/**
 * CONCEPT 31 — AskUserQuestion: the agent asks YOU multiple-choice questions in the middle of a run
 *
 * AskUserQuestion is a built-in tool. The model calls it with 1–4 questions, each with 2–4 options
 * ({ label, description, preview? }) and multiSelect. Claude Code does not show anything itself: the call goes to the
 * host as a permission request, so YOUR canUseTool renders the questions and returns the answers:
 *
 *   canUseTool("AskUserQuestion", { questions })
 *     → { behavior: "allow", updatedInput: { questions, answers: { "<question text>": "<label>" }, annotations? } }
 *     → { behavior: "deny", message }                    the model gets an is_error result with your message
 *     → { behavior: "deny", message, interrupt: true }   the run stops (error_during_execution, query() throws)
 *
 * With no canUseTool, or with permissionPrompts: "none", the tool is REMOVED from the model's tool list (a PreToolUse
 * hook alone does not bring it back). With bypassPermissions it stays listed, but the SDK warns that canUseTool is then
 * never called. A PreToolUse hook can also answer it (then canUseTool is not called).
 *
 * The lab keeps the run waiting inside canUseTool, sends the questions to the browser (SSE), and resolves the promise
 * when the browser POSTs /answer. Routes: POST /tools (SSE), POST /run (SSE), POST /answer, GET /code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept31 = Router();

const MODEL = "claude-haiku-4-5-20251001";

// Each run works in its own ask-lab/runs/<run id> folder. Transcripts go to a fake CLAUDE_CONFIG_DIR: ask-lab/config.
const LAB = path.resolve("ask-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [RUNS, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
const escaped = JSON.stringify(LAB).slice(1, -1); // the path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) => s.replaceAll(LAB, "ask-lab").replaceAll(escaped, "ask-lab").replace(/ask-lab[\\/]+runs[\\/]+\w+[\\/]+/g, "");

const ANSWER_TIMEOUT_MS = 120_000; // the host's own limit: Claude Code waits for canUseTool forever

type Emit = (event: string, data: object) => void;
type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; preview?: string }[] };
type AnsweredBy = "you" | "hook" | "host (partial)";

/** What one scenario needs: its folder, who answers, and every question and answer so far. */
type Run = {
  id: string;
  work: string;
  answeredBy: AnsweredBy;
  asked: number;
  apiError?: string; // set when the API refused the call (see Concept 28): the model never ran
  log: { question: string; answer: string | null; how: string }[]; // for the host check
  toolNames: Map<string, string>; // tool_use id → tool name, to label each tool_result
};

const active = new Set<string>();
function newRun(answeredBy: AnsweredBy): Run {
  // Delete the folders of finished runs, keep the ones still running.
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  active.add(id);
  return { id, work, answeredBy, asked: 0, log: [], toolNames: new Map() };
}

const FILE_TOOLS = ["Read", "Write"];

// #region options
function baseOptions(run: Run, emit: Emit, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  return {
    model: MODEL,
    cwd: run.work,
    tools: [...FILE_TOOLS, "AskUserQuestion"], // it must be in the list, like any tool
    // canUseTool is the host's "dialog". Without it, the model does not get AskUserQuestion at all.
    canUseTool: async (tool, input, { signal }) => {
      if (tool === "AskUserQuestion") return ask(run, emit, input, signal);
      const inside = path.resolve(run.work, String(input.file_path ?? ".")).startsWith(run.work);
      if (FILE_TOOLS.includes(tool) && inside) return { behavior: "allow", updatedInput: input };
      emit("denied", { tool });
      return { behavior: "deny", message: "Denied by the lab: only Read and Write inside the run folder." };
    },
    // The hook scenario: a PreToolUse hook answers instead of the person. Then canUseTool is not called.
    hooks: run.answeredBy === "hook" ? { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [answerFromProfile(run, emit)] }] } : undefined,
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 12,
    env,
    ...extra,
  };
}
// #endregion

const optionsForBrowser = (run: Run, options: Options) => ({
  ...options,
  env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'ask-lab/config' }",
  canUseTool: "[Function: AskUserQuestion → ask(); Read/Write inside the run folder]",
  hooks: options.hooks && { PreToolUse: [{ matcher: "AskUserQuestion", hooks: ["[Function answerFromProfile]"] }] },
  abortController: options.abortController && "[AbortController]",
  cwd: `ask-lab/runs/${run.id}`,
});

// #region ask
// canUseTool("AskUserQuestion") waits here until the browser answers, the host's timeout fires, or the run is aborted.
type Pending = { run: Run; questions: Question[]; input: Record<string, unknown>; done: (r: PermissionResult, how: string) => void };
const pending = new Map<string, Pending>(); // "<run id>:<question id>" → the open question

function ask(run: Run, emit: Emit, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
  const questions = input.questions as Question[];
  const id = String(++run.asked);
  emit("question", { run: run.id, id, questions, answeredBy: run.answeredBy === "you" ? undefined : run.answeredBy, timeoutMs: ANSWER_TIMEOUT_MS });

  if (run.answeredBy === "host (partial)") {
    // Part B: the host answers only the FIRST question, to show what the model does with the others.
    const answers = { [questions[0].question]: questions[0].options[0].label };
    record(run, questions, answers, "host");
    emit("answer", { id, how: "partial", result: { behavior: "allow", updatedInput: { answers } } });
    return Promise.resolve({ behavior: "allow", updatedInput: { ...input, answers } });
  }

  return new Promise((resolve) => {
    const key = `${run.id}:${id}`;
    const done = (result: PermissionResult, how: string) => {
      if (!pending.delete(key)) return; // already answered
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const answers = result.behavior === "allow" ? (result.updatedInput?.answers as Record<string, string>) : {};
      record(run, questions, answers, how);
      const shown = result.behavior === "allow" ? { behavior: "allow", updatedInput: { answers, annotations: result.updatedInput?.annotations } } : result;
      emit("answer", { id, how, result: shown });
      resolve(result);
    };
    const onAbort = () => done({ behavior: "deny", message: "The run was aborted." }, "aborted");
    // Nobody answered in time: tell the model to go on with defaults, and to SAY which ones it chose.
    const timer = setTimeout(
      () => done({ behavior: "deny", message: "The user did not answer within 2 minutes. Choose sensible defaults yourself and say which ones you chose." }, "timeout"),
      ANSWER_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, { run, questions, input, done });
  });
}

function record(run: Run, questions: Question[], answers: Record<string, string>, how: string) {
  for (const q of questions) run.log.push({ question: q.question, answer: answers[q.question] ?? null, how });
}
// #endregion

// #region answer
// The browser's answer becomes the PermissionResult that canUseTool returns.
//   answer  → allow + updatedInput.answers (question text → label; several labels joined by ", "; or the user's own text)
//             + updatedInput.annotations (question text → { notes }) when the user added a note
//   skip    → deny: the model gets an is_error tool_result with this message, and goes on
//   cancel  → deny + interrupt: the run stops
const AnswerBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["answer", "skip", "cancel"]),
    answers: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
    notes: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
  })
  .strict();

function toResult(p: Pending, body: z.infer<typeof AnswerBody>): PermissionResult | string {
  if (body.action === "skip") return { behavior: "deny", message: "The user skipped these questions. Choose sensible defaults yourself and say which ones you chose." };
  if (body.action === "cancel") return { behavior: "deny", message: "The user cancelled the job.", interrupt: true };
  // Every question needs an answer: a missing one is NOT an error for the model, it just makes one up (Part B, 6).
  const texts = p.questions.map((q) => q.question);
  const answers = body.answers ?? {};
  const missing = texts.filter((t) => !answers[t]);
  if (missing.length) return `No answer for: ${missing.join(" | ")}`;
  const extra = Object.keys({ ...answers, ...body.notes }).filter((k) => !texts.includes(k));
  if (extra.length) return `Not a question of this call: ${extra.join(" | ")}`;
  const annotations = body.notes && Object.fromEntries(Object.entries(body.notes).map(([q, notes]) => [q, { notes }]));
  return { behavior: "allow", updatedInput: { ...p.input, answers, ...(annotations && { annotations }) } };
}

concept31.post("/answer", (req, res) => {
  const parsed = AnswerBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const p = pending.get(`${parsed.data.run}:${parsed.data.id}`);
  if (!p) return res.status(404).json({ error: "No open question with that id (already answered, timed out, or the run ended)." });
  const result = toResult(p, parsed.data);
  if (typeof result === "string") return res.status(400).json({ error: result });
  p.done(result, parsed.data.action === "answer" ? "you" : parsed.data.action);
  res.json({ ok: true });
});
// #endregion

// #region hook
// A PreToolUse hook can answer AskUserQuestion itself: permissionDecision "allow" + updatedInput with the answers.
// Useful for saved preferences, tests, or a bot. canUseTool is then not called for this tool call.
const PROFILE = ["haiku", "nature", "short", "small", "blue"]; // the "saved preferences"

function answerFromProfile(run: Run, emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool_input = input.tool_input as { questions: Question[] };
    const questions = tool_input.questions;
    const pick = (q: Question) => q.options.find((o) => PROFILE.some((w) => o.label.toLowerCase().includes(w)))?.label ?? q.options[0].label;
    const answers = Object.fromEntries(questions.map((q) => [q.question, pick(q)]));
    const id = String(++run.asked);
    emit("question", { run: run.id, id, questions, answeredBy: "hook" });
    record(run, questions, answers, "hook");
    emit("answer", { id, how: "hook", result: { permissionDecision: "allow", updatedInput: { answers } } });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...tool_input, answers } } };
  };
}
// #endregion

// #region messages
/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, run: Run, emit: Emit) {
  const m = msg as any;
  if (m.type === "system" && m.subtype === "init") return emit("init", { model: m.model, tools: m.tools, hasAsk: m.tools.includes("AskUserQuestion") });
  if (m.type === "assistant") {
    // When the API fails (no credit, bad key, overloaded…), Claude Code writes a SYNTHETIC assistant message with
    // `error` set, and the result still says "success". Without this, the run looks like "the model asked nothing".
    if (m.error) {
      run.apiError = m.error;
      const text = m.message.content.map((b: any) => b.text ?? "").join("");
      return emit("apiError", { error: m.error, text: short(text).slice(0, 300) });
    }
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 600) });
      if (b.type === "tool_use") {
        run.toolNames.set(b.id, b.name);
        // The questions are shown on their own row ("question"), so here only a summary.
        const input = b.name === "AskUserQuestion" ? `${b.input.questions?.length} question(s): ${b.input.questions?.map((q: Question) => q.header).join(", ")}` : short(JSON.stringify(b.input)).slice(0, 300);
        emit("toolUse", { name: b.name, input });
      }
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const name = run.toolNames.get(b.tool_use_id) ?? "?";
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      // tool_use_result: for AskUserQuestion, { questions, answers, annotations? } — what your code can store.
      const tur = m.tool_use_result;
      const answers = name === "AskUserQuestion" && tur && typeof tur === "object" ? { answers: tur.answers, annotations: tur.annotations } : undefined;
      emit("toolResult", { name, is_error: !!b.is_error, text: short(text).slice(0, 500), tool_use_result: answers });
    }
    return;
  }
  if (m.type === "result") {
    emit("result", {
      subtype: m.subtype, is_error: m.is_error, apiError: run.apiError, num_turns: m.num_turns, cost: m.total_cost_usd, denials: m.permission_denials?.map((d: any) => d.tool_name) ?? [],
      text: typeof m.result === "string" ? short(m.result).slice(0, 600) : undefined,
    });
  }
}

async function runOnce(prompt: string, options: Options, run: Run, emit: Emit) {
  try {
    for await (const msg of query({ prompt, options })) relay(msg, run, emit);
  } catch (err) {
    // A deny with interrupt: true ends the run with error_during_execution, and then query() throws.
    emit("error", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  }
}
// #endregion

// #region check
// The host lists every question and the answer it sent. A question with no answer is a warning: the model
// did not get one, so anything it says about it was made up.
function check(run: Run, emit: Emit) {
  emit("check", {
    apiError: run.apiError,
    questions: run.log,
    unanswered: run.log.filter((l) => l.answer === null).length,
    files: readdirSync(run.work),
  });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /run: one scenario
// ---------------------------------------------------------------------------------------------

const POEM =
  "I want a short poem written to poem.txt. Before you write anything, use the AskUserQuestion tool ONCE with two questions: the topic (offer 3 topics) and the form (haiku or limerick). Then write the poem and reply with it.";
const PROMPTS: Record<string, string> = {
  ask: POEM,
  multi:
    "Write a pizza order to order.txt. Before writing, use the AskUserQuestion tool ONCE with two questions: the size (small, medium or large) and the toppings (multiSelect: true, offer 4 toppings). Then write the order and reply with it.",
  preview:
    "Write a one-section landing page to page.html. Before writing, use the AskUserQuestion tool to ask me which of 3 visual styles I want, and give each option a preview of the heading in that style. Then write the page in the style I pick and reply DONE.",
  unprompted: "Write a poem to poem.txt.",
  hook: POEM,
  partial:
    "Before doing anything else, use the AskUserQuestion tool ONCE with two questions: my favorite color (red, green or blue) and my favorite fruit (apple or pear). Then write both to favorites.txt and reply with them.",
};

const Scenario = z.enum(["ask", "multi", "preview", "unprompted", "hook", "partial", "custom"]);
const RunBody = z
  .object({
    scenario: Scenario,
    prompt: z.string().trim().min(1).max(2000).optional(), // custom only
    previewFormat: z.enum(["markdown", "html"]).optional(), // custom only
  })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" })
  .refine((b) => b.scenario === "custom" || b.previewFormat === undefined, { message: "previewFormat is only for 'custom'" });

concept31.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }), end();
  const b = parsed.data;
  const run = newRun(b.scenario === "hook" ? "hook" : b.scenario === "partial" ? "host (partial)" : "you");
  try {
    const prompt = b.scenario === "custom" ? b.prompt! : PROMPTS[b.scenario];
    // toolConfig.askUserQuestion.previewFormat: what the model is told to put in `preview` (default "markdown").
    const format = b.scenario === "preview" ? "html" : b.previewFormat;
    const options = baseOptions(run, emit, { abortController: abort, ...(format && { toolConfig: { askUserQuestion: { previewFormat: format } } }) });
    emit("opened", { prompt, options: optionsForBrowser(run, options) });
    await runOnce(prompt, options, run, emit);
    check(run, emit);
  } finally {
    active.delete(run.id);
    for (const p of pending.values()) if (p.run === run) p.done({ behavior: "deny", message: "The run ended." }, "aborted");
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /tools: which setups give the model AskUserQuestion? One short turn each ("Reply ok"), in parallel.
// ---------------------------------------------------------------------------------------------

const allow = async (_t: string, input: Record<string, unknown>): Promise<PermissionResult> => ({ behavior: "allow", updatedInput: input });
const noopHook: HookCallback = async () => ({});
const SETUPS: { label: string; options: Partial<Options>; shown: string }[] = [
  { label: "canUseTool set", options: { canUseTool: allow }, shown: "canUseTool: fn" },
  { label: "no canUseTool", options: {}, shown: "—" },
  { label: "canUseTool + bypassPermissions", options: { canUseTool: allow, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, shown: "canUseTool: fn, permissionMode: 'bypassPermissions'" },
  { label: "canUseTool + permissionPrompts: 'none'", options: { canUseTool: allow, permissionPrompts: "none" }, shown: "canUseTool: fn, permissionPrompts: 'none'" },
  { label: "a PreToolUse hook, no canUseTool", options: { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [noopHook] }] } }, shown: "hooks: { PreToolUse }" },
  { label: "canUseTool, default tool set", options: { canUseTool: allow, tools: undefined }, shown: "canUseTool: fn, no tools option" },
];

concept31.post("/tools", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))), CLAUDE_CONFIG_DIR: CONFIG_DIR };
  await Promise.all(
    SETUPS.map(async (s) => {
      const row: Record<string, unknown> = { label: s.label, shown: s.shown };
      try {
        const options: Options = { model: MODEL, tools: ["Read", "AskUserQuestion"], cwd: RUNS, settingSources: [], maxTurns: 1, persistSession: false, thinking: { type: "disabled" }, abortController: abort, env, ...s.options };
        for await (const m of query({ prompt: "Reply with the single word: ok", options }) as AsyncIterable<any>) {
          if (m.type === "system" && m.subtype === "init") (row.hasAsk = m.tools.includes("AskUserQuestion")), (row.toolCount = m.tools.length);
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

concept31.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
