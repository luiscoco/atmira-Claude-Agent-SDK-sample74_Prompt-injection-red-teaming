/**
 * CONCEPT 32 — Plan mode: the agent explores read-only, writes a plan, and waits for YOUR approval before changing anything
 *
 * permissionMode: "plan" tells the model to look around (Read, Glob, Grep), write a plan file, and then call the built-in
 * ExitPlanMode tool with the plan. Claude Code does not show the plan: the call goes to the host as a permission request,
 * so YOUR canUseTool is the approval dialog:
 *
 *   canUseTool("ExitPlanMode", { plan, planFilePath })
 *     → { behavior: "allow", updatedInput, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }
 *          approved: the mode switches (system/status) and the model starts coding in the SAME run
 *     → { behavior: "allow", updatedInput: { ...input, plan: "<your edited plan>" } }   approved, with your version
 *     → { behavior: "deny", message: "<feedback>" }            keep planning: the model revises and asks again
 *     → { behavior: "deny", message, interrupt: true }         cancel: the run stops (query() throws)
 *
 * Plan mode is NOT a sandbox. With no canUseTool, the CLI denies writes itself ("Cannot write … while in plan mode"),
 * but it also removes ExitPlanMode, so the agent can never leave plan mode. With a canUseTool, every call that is not
 * read-only goes to YOUR function, which is not told the mode: if it says allow, the file is written. So the host tracks
 * the mode (system/init, system/status, its own approvals) and denies changes while it is "plan".
 *
 * Routes: POST /who (SSE), POST /run (SSE), POST /decide, GET /code.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options, type PermissionMode, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept32 = Router();

const MODEL = "claude-haiku-4-5-20251001";

// Each run works on its own copy of a tiny project in plan-lab/runs/<run id>. Transcripts and plan files go to a fake
// CLAUDE_CONFIG_DIR: plan-lab/config (plans land in plan-lab/config/plans/ unless plansDirectory says otherwise).
const LAB = path.resolve("plan-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [RUNS, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
const escaped = JSON.stringify(LAB).slice(1, -1); // the path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) => s.replaceAll(LAB, "plan-lab").replaceAll(escaped, "plan-lab").replace(/plan-lab[\\/]+runs[\\/]+\w+[\\/]+/g, "");

// The project every run starts from.
const PROJECT: Record<string, string> = {
  "cart.js": "export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return sum;\n}\n",
  "README.md": "# Shop\n\nA tiny cart module. `total(items)` returns the cart total.\n",
};

const REVIEW_TIMEOUT_MS = 180_000; // the host's own limit: Claude Code waits for canUseTool forever

type Emit = (event: string, data: object) => void;
type Decision = { id: string; how: string; mode?: PermissionMode; edited?: boolean; feedback?: string };

/** What one run needs: its folder, the mode as the host knows it, and every plan and decision so far. */
type Run = {
  id: string;
  work: string;
  mode: PermissionMode;
  modes: { mode: PermissionMode; why: string }[]; // the mode timeline, for the host check
  plans: number; // ExitPlanMode calls
  approvedPlan?: string; // the plan the host approved (maybe edited)
  decisions: Decision[];
  blocked: { tool: string; target: string }[]; // calls the host denied because the mode was still "plan"
  apiError?: string; // set when the API refused the call (see Concept 28): the model never ran
  planFile?: string; // where the model wrote its plan (a Write into a plans/ folder)
  toolNames: Map<string, string>; // tool_use id → tool name, to label each tool_result
};

const active = new Set<string>();
function newRun(mode: PermissionMode): Run {
  // Delete the folders of finished runs, keep the ones still running.
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  for (const [f, c] of Object.entries(PROJECT)) writeFileSync(path.join(work, f), c);
  active.add(id);
  return { id, work, mode, modes: [{ mode, why: "permissionMode option" }], plans: 0, decisions: [], blocked: [], toolNames: new Map() };
}

function setMode(run: Run, mode: PermissionMode, why: string, emit: Emit) {
  if (run.mode === mode) return;
  run.mode = mode;
  run.modes.push({ mode, why });
  emit("mode", { mode, why });
}

const PLAN_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "ExitPlanMode"];

// #region options
function baseOptions(run: Run, emit: Emit, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  return {
    model: MODEL,
    cwd: run.work,
    permissionMode: run.mode, // "plan": explore read-only, write the plan, call ExitPlanMode
    tools: PLAN_TOOLS, // ExitPlanMode must be in the list, like any tool (no Bash: see Tab32 Step 4)
    // canUseTool is the host's approval dialog. Without it, the model does not get ExitPlanMode at all.
    canUseTool: guard(run, emit),
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 30,
    env,
    ...extra,
  };
}
// #endregion

const optionsForBrowser = (run: Run, options: Options) => ({
  ...options,
  env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'plan-lab/config' }",
  canUseTool: "[Function guard: ExitPlanMode → review(); in plan mode deny every other call; after approval allow inside the run folder]",
  hooks: options.hooks && { PreToolUse: [{ matcher: "ExitPlanMode", hooks: ["[Function planPolicy]"] }] },
  abortController: options.abortController && "[AbortController]",
  cwd: `plan-lab/runs/${run.id}`,
});

// #region guard
// canUseTool is NOT told the permission mode. The CLI approves read-only calls (Read, Glob, Grep, the plan file) by
// itself, so in plan mode anything that still reaches this function would change something: deny it.
function guard(run: Run, emit: Emit) {
  return async (tool: string, input: Record<string, unknown>, { signal }: { signal: AbortSignal }): Promise<PermissionResult> => {
    if (tool === "ExitPlanMode") return review(run, emit, input, signal);
    const target = String(input.file_path ?? input.path ?? input.pattern ?? "");
    if (!path.resolve(run.work, target || ".").startsWith(run.work)) {
      emit("blocked", { tool, target: short(target), why: "outside the run folder" });
      return { behavior: "deny", message: "Denied by the lab: only files inside the project folder." };
    }
    if (run.mode === "plan") {
      run.blocked.push({ tool, target: short(target) });
      emit("blocked", { tool, target: short(target), why: "plan mode" });
      return { behavior: "deny", message: "Plan mode is read-only: nothing may change until the user approves your plan. Put this change in the plan instead." };
    }
    // After a plain approval (mode "default"), every edit comes here. The lab allows it and shows it.
    emit("asked", { tool, target: short(target), mode: run.mode });
    return { behavior: "allow", updatedInput: input };
  };
}
// #endregion

// #region review
// canUseTool("ExitPlanMode") waits here until the browser decides, the host's timeout fires, or the run is aborted.
type Pending = { run: Run; input: Record<string, unknown>; done: (r: PermissionResult, d: Decision) => void };
const pending = new Map<string, Pending>(); // "<run id>:<plan id>" → the plan waiting for a decision

function review(run: Run, emit: Emit, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
  const id = String(++run.plans);
  const plan = String(input.plan ?? "");
  if (input.planFilePath) run.planFile = String(input.planFilePath);
  emit("plan", { run: run.id, id, plan, planFilePath: short(String(input.planFilePath ?? "")), timeoutMs: REVIEW_TIMEOUT_MS });
  return new Promise((resolve) => {
    const key = `${run.id}:${id}`;
    const done = (result: PermissionResult, d: Decision) => {
      if (!pending.delete(key)) return; // already decided
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run.decisions.push(d);
      if (result.behavior === "allow") {
        run.approvedPlan = String(result.updatedInput?.plan ?? plan);
        // Set the mode NOW: the model's first edit can reach canUseTool before system/status is read.
        setMode(run, d.mode ?? "default", d.mode === "acceptEdits" ? "approved with setMode" : "approved (no setMode: plan mode ends in 'default')", emit);
      }
      const shown = result.behavior === "allow" ? { behavior: "allow", updatedInput: d.edited ? { plan: "(your edited plan)" } : "(unchanged)", updatedPermissions: result.updatedPermissions } : result;
      emit("decision", { id, how: d.how, result: shown });
      resolve(result);
    };
    const onAbort = () => done({ behavior: "deny", message: "The run was aborted.", interrupt: true }, { id, how: "aborted" });
    // Nobody reviewed in time: never implement an unreviewed plan. Stop the run.
    const timer = setTimeout(() => done({ behavior: "deny", message: "Nobody reviewed the plan in time. Do not implement it.", interrupt: true }, { id, how: "timeout" }), REVIEW_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, { run, input, done });
  });
}
// #endregion

// #region decide
// The browser's decision becomes the PermissionResult that canUseTool returns.
//   approve  → allow; mode "acceptEdits" adds updatedPermissions [setMode]; plan (optional) replaces the model's plan
//   revise   → deny with the feedback: the model stays in plan mode, revises, and calls ExitPlanMode again
//   cancel   → deny + interrupt: the run stops
const DecideBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["approve", "revise", "cancel"]),
    mode: z.enum(["acceptEdits", "default"]).optional(), // approve only
    plan: z.string().trim().min(1).max(20_000).optional(), // approve only: the user's edited plan
    feedback: z.string().trim().min(1).max(2000).optional(), // revise only (required there)
  })
  .strict()
  .refine((b) => b.action === "approve" || (b.mode === undefined && b.plan === undefined), { message: "mode and plan are only for 'approve'" })
  .refine((b) => (b.action === "revise") === (b.feedback !== undefined), { message: "feedback is required for 'revise', and only for it" })
  .refine((b) => b.action !== "approve" || b.mode !== undefined, { message: "approve needs a mode: 'acceptEdits' or 'default'" });

function toResult(p: Pending, b: z.infer<typeof DecideBody>): { result: PermissionResult; decision: Decision } {
  const d: Decision = { id: b.id, how: b.action };
  if (b.action === "cancel") return { result: { behavior: "deny", message: "The user rejected the plan and cancelled the job.", interrupt: true }, decision: d };
  if (b.action === "revise") return { result: { behavior: "deny", message: `The user wants changes to the plan before approving it: ${b.feedback}` }, decision: { ...d, feedback: b.feedback } };
  const edited = b.plan !== undefined && b.plan !== String(p.input.plan ?? "").trim();
  return {
    result: {
      behavior: "allow",
      updatedInput: edited ? { ...p.input, plan: b.plan } : p.input,
      ...(b.mode === "acceptEdits" && { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }),
    },
    decision: { ...d, mode: b.mode, edited },
  };
}

concept32.post("/decide", (req, res) => {
  const parsed = DecideBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const p = pending.get(`${parsed.data.run}:${parsed.data.id}`);
  if (!p) return res.status(404).json({ error: "No plan waiting with that id (already decided, timed out, or the run ended)." });
  const { result, decision } = toResult(p, parsed.data);
  p.done(result, decision);
  res.json({ ok: true });
});
// #endregion

// #region hook
// A PreToolUse hook sees ExitPlanMode BEFORE canUseTool: a policy the plan must pass before a person looks at it.
// Its "deny" reaches the model as "PreToolUse:ExitPlanMode hook error: <reason>". Its "allow" does NOT skip canUseTool
// for ExitPlanMode (unlike AskUserQuestion, Concept 31): the person still decides. So return {} to pass it on.
function planPolicy(emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const plan = String((input.tool_input as { plan?: string }).plan ?? "");
    const ok = /cart\.test\.js/.test(plan);
    emit("policy", { ok, rule: "the plan must name a test file, cart.test.js" });
    if (ok) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Policy: every plan must include a test step that adds cart.test.js." } };
  };
}
// #endregion

// #region messages
/** Turns each SDK message into a small event for the browser, and keeps the host's view of the mode up to date. */
function relay(msg: SDKMessage, run: Run, emit: Emit) {
  const m = msg as any;
  if (m.type === "system" && m.subtype === "init")
    return emit("init", { model: m.model, permissionMode: m.permissionMode, tools: m.tools, hasExit: m.tools.includes("ExitPlanMode"), hasEnter: m.tools.includes("EnterPlanMode") });
  // Every mode change (ExitPlanMode approved, EnterPlanMode, setPermissionMode) arrives as system/status.
  if (m.type === "system" && m.subtype === "status" && m.permissionMode) return emit("status", { permissionMode: m.permissionMode }), setMode(run, m.permissionMode, "system/status", emit);
  // With no canUseTool, the CLI itself denies writes in plan mode, and says so here.
  if (m.type === "system" && m.subtype === "permission_denied") return emit("cliDenied", { tool: m.tool_name, reason: m.decision_reason_type, message: short(m.message ?? "") });
  if (m.type === "assistant") {
    // When the API fails (no credit, bad key, overloaded…), Claude Code writes a SYNTHETIC assistant message with
    // `error` set, and the result still says "success" (see Concept 28).
    if (m.error) {
      run.apiError = m.error;
      const text = m.message.content.map((b: any) => b.text ?? "").join("");
      return emit("apiError", { error: m.error, text: short(text).slice(0, 300) });
    }
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 600) });
      if (b.type === "tool_use") {
        run.toolNames.set(b.id, b.name);
        if (b.name === "Write" && /[\\/]plans[\\/]/.test(String(b.input.file_path ?? ""))) run.planFile = path.resolve(run.work, String(b.input.file_path));
        // The plan is shown on its own row ("plan"), so here only a summary.
        const input =
          b.name === "ExitPlanMode" ? `plan: ${String(b.input.plan ?? "").length} characters` : b.name === "Write" ? short(`${b.input.file_path} (${String(b.input.content ?? "").length} characters)`) : short(JSON.stringify(b.input)).slice(0, 300);
        emit("toolUse", { name: b.name, input, planFile: /[\\/]plans[\\/]/.test(String(b.input.file_path ?? "")) });
      }
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const name = run.toolNames.get(b.tool_use_id) ?? "?";
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      // tool_use_result: for ExitPlanMode, { plan, isAgent, filePath, planWasEdited? } — what your code can store.
      const tur = m.tool_use_result;
      const extra = name === "ExitPlanMode" && tur && typeof tur === "object" ? { filePath: short(String(tur.filePath ?? "")), planWasEdited: tur.planWasEdited ?? false } : undefined;
      emit("toolResult", { name, is_error: !!b.is_error, text: short(text).slice(0, name === "ExitPlanMode" ? 900 : 400), tool_use_result: extra });
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
// The host compares the project with how it started, and the changed files with the plan it approved.
// Trust what your code saw, not what the model says it did.
function changedFiles(run: Run) {
  const out: { file: string; change: "modified" | "created" | "deleted" }[] = [];
  const now = readdirSync(run.work).filter((f) => f !== "plans" && statSync(path.join(run.work, f)).isFile());
  for (const f of Object.keys(PROJECT)) {
    if (!now.includes(f)) out.push({ file: f, change: "deleted" });
    else if (readFileSync(path.join(run.work, f), "utf8") !== PROJECT[f]) out.push({ file: f, change: "modified" });
  }
  for (const f of now) if (!(f in PROJECT)) out.push({ file: f, change: "created" });
  return out;
}

function check(run: Run, emit: Emit) {
  const changes = changedFiles(run).map((c) => ({ ...c, inPlan: run.approvedPlan ? run.approvedPlan.includes(c.file) : false }));
  emit("check", {
    apiError: run.apiError,
    plans: run.plans,
    decisions: run.decisions,
    modes: run.modes,
    finalMode: run.mode,
    blocked: run.blocked,
    changes,
    approved: !!run.approvedPlan,
    planFile: run.planFile && existsSync(run.planFile) ? short(run.planFile) : undefined, // this run's plan (the folder is shared)
  });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /run: one scenario
// ---------------------------------------------------------------------------------------------

const TASK = "Add a discount feature to cart.js: total(items, discountPercent) applies a percentage discount from 0 to 100. Update README.md too.";
// Name the tool: with "ask me to approve it", the model often ended its turn and asked in plain text instead.
const ASK = " When the plan is ready, submit it for my approval with the ExitPlanMode tool.";
const PROMPTS: Record<string, string> = {
  review: TASK + ASK,
  instructions: TASK + ASK,
  policy: TASK + ASK,
  enter: "First enter plan mode with the EnterPlanMode tool, look at the project, and plan this: " + TASK + ASK,
};
// planModeInstructions replaces the default workflow body of the plan-mode reminder (the read-only preamble and the
// ExitPlanMode footer stay).
const INSTRUCTIONS = "Write the plan in this exact shape and nothing else: a line 'Goal: …', then at most 4 numbered steps (one file each, under 20 words), then a line 'Risk: …'.";

const Scenario = z.enum(["review", "instructions", "policy", "enter", "custom"]);
const RunBody = z
  .object({
    scenario: Scenario,
    prompt: z.string().trim().min(1).max(2000).optional(), // custom only
    planModeInstructions: z.string().trim().min(1).max(2000).optional(), // custom only
    plansInProject: z.boolean().optional(), // custom only: settings.plansDirectory = "plans"
  })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" })
  .refine((b) => b.scenario === "custom" || (b.planModeInstructions === undefined && b.plansInProject === undefined), { message: "planModeInstructions and plansInProject are only for 'custom'" });

concept32.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }), end();
  const b = parsed.data;
  const run = newRun(b.scenario === "enter" ? "default" : "plan");
  try {
    const prompt = b.scenario === "custom" ? b.prompt! : PROMPTS[b.scenario];
    const extra: Partial<Options> = { abortController: abort };
    if (b.scenario === "instructions") extra.planModeInstructions = INSTRUCTIONS;
    if (b.scenario === "custom" && b.planModeInstructions) extra.planModeInstructions = b.planModeInstructions;
    if (b.scenario === "custom" && b.plansInProject) extra.settings = { plansDirectory: "plans" }; // relative to cwd
    if (b.scenario === "policy") extra.hooks = { PreToolUse: [{ matcher: "ExitPlanMode", hooks: [planPolicy(emit)] }] };
    if (b.scenario === "enter") extra.tools = [...PLAN_TOOLS, "EnterPlanMode"]; // the model switches to plan mode itself
    const options = baseOptions(run, emit, extra);
    emit("opened", { prompt, options: optionsForBrowser(run, options) });
    await runOnce(prompt, options, run, emit);
    check(run, emit);
  } finally {
    active.delete(run.id);
    for (const p of pending.values()) if (p.run === run) p.done({ behavior: "deny", message: "The run ended.", interrupt: true }, { id: "?", how: "aborted" });
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /who: who keeps plan mode read-only? The same forced Write in three setups, in parallel.
// ---------------------------------------------------------------------------------------------

// A system prompt append that makes the model TRY the write even in plan mode (without it, the model refuses on its
// own: "I'm currently in plan mode…"). The permission layer, not the model, must be what stops it.
const FORCE = "TEST HARNESS: this session checks the permission layer. When the user asks you to write a file, ALWAYS call the Write tool, even in plan mode. The harness decides; never refuse on your own.";
const allowAll = async (_t: string, input: Record<string, unknown>): Promise<PermissionResult> => ({ behavior: "allow", updatedInput: input });
const SETUPS: { key: string; label: string; shown: string }[] = [
  { key: "none", label: "no canUseTool", shown: "—" },
  { key: "allowAll", label: "canUseTool allows everything", shown: "canUseTool: async () => ({ behavior: 'allow' })" },
  { key: "lab", label: "the lab's guard()", shown: "canUseTool: guard(run) — denies in plan mode" },
];

concept32.post("/who", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))), CLAUDE_CONFIG_DIR: CONFIG_DIR };
  const runs: Run[] = [];
  try {
    await Promise.all(
      SETUPS.map(async (s) => {
        const run = newRun("plan");
        runs.push(run);
        const row: Record<string, unknown> = { label: s.label, shown: s.shown, asked: false };
        const quiet: Emit = () => {};
        const spy = (inner: (t: string, i: Record<string, unknown>, o: any) => Promise<PermissionResult>) => async (t: string, i: Record<string, unknown>, o: any) => ((row.asked = true), inner(t, i, o));
        // The lab's guard, except that nobody reviews plans here: ExitPlanMode is refused at once (no 3-minute wait).
        const labGuard = guard(run, quiet);
        const noReview = async (t: string, i: Record<string, unknown>, o: any): Promise<PermissionResult> =>
          t === "ExitPlanMode" ? ((row.stoppedAtPlan = true), { behavior: "deny", message: "This check does not review plans.", interrupt: true }) : labGuard(t, i, o);
        const canUseTool = s.key === "none" ? undefined : spy(s.key === "allowAll" ? allowAll : noReview);
        try {
          const options: Options = {
            model: MODEL, cwd: run.work, permissionMode: "plan", tools: ["Read", "Write", "ExitPlanMode"], canUseTool, settingSources: [], maxTurns: 3, persistSession: false,
            thinking: { type: "disabled" }, systemPrompt: { type: "preset", preset: "claude_code", append: FORCE }, abortController: abort, env,
          };
          const names = new Map<string, string>();
          for await (const m of query({ prompt: "Use the Write tool to create hello.txt containing hi, then reply DONE.", options }) as AsyncIterable<any>) {
            if (m.type === "system" && m.subtype === "init") row.hasExit = m.tools.includes("ExitPlanMode");
            if (m.type === "system" && m.subtype === "permission_denied") row.cliDenied = m.decision_reason_type;
            if (m.type === "assistant") {
              if (m.error) row.error = m.error;
              for (const b of m.message.content) if (b.type === "tool_use") names.set(b.id, b.name), (row.triedWrite ||= b.name === "Write");
            }
            if (m.type === "user" && Array.isArray(m.message.content))
              for (const b of m.message.content)
                if (b.type === "tool_result" && names.get(b.tool_use_id) === "Write" && !row.result) {
                  const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
                  row.result = short(text).slice(0, 160);
                }
            if (m.type === "result") row.cost = m.total_cost_usd;
          }
        } catch (err) {
          // A denied model may retry until maxTurns: that is not a failure of the setup.
          const message = String((err as Error)?.message ?? err);
          if (/max(imum)?( number of)? turns/i.test(message)) row.maxTurns = true;
          else if (!row.stoppedAtPlan) row.error = message.slice(0, 200); // after our own interrupt, query() throws too
        }
        row.written = existsSync(path.join(run.work, "hello.txt"));
        send("whoRow", { ...row, at: Date.now() - startedAt });
      }),
    );
  } finally {
    for (const r of runs) active.delete(r.id);
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept32.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
