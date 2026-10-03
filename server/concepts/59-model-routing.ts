import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import {
  answerSchema, assumptions, classifierPrompt, classifierSchema, grade, models, needsEscalation, project, ruleRoute, rules,
  solverPrompt, strategies, strategyInfo, strategySchema, taskById, tasks, type Strategy, type Task, type Tier,
} from "../routing/workshop.js";

export const concept59 = Router();
let active = false; // one live lesson 59 job at a time

concept59.get("/facts", (_req, res) => res.json({
  models, strategies, strategyInfo, assumptions, liveAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
  rules: rules.map((rule) => ({ tier: rule.tier, pattern: String(rule.pattern), why: rule.why })),
  tasks: tasks.map((task) => ({ id: task.id, tier: task.tier, prompt: task.prompt, accept: task.accept, format: String(task.format), note: task.note, rule: ruleRoute(task.prompt) })),
}));
concept59.get("/code", (_req, res) => res.json({
  "59-model-routing.ts": readFileSync(new URL("./59-model-routing.ts", import.meta.url), "utf8"),
  "workshop.ts": readFileSync(new URL("../routing/workshop.ts", import.meta.url), "utf8"),
}));
concept59.get("/plan", (_req, res) => res.json(strategies.map(project)));

type Env = Record<string, string | undefined>;
/**
 * Options for every lesson 59 call: no tools, a tiny system prompt (so the model choice, not Claude Code's default
 * prompt, dominates the bill) and an isolated config. Inherited CLAUDE_* and model-mapping variables are dropped so
 * the route decides which model runs. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC removes an auxiliary small-model
 * call that the probes saw in modelUsage (section E turns it back on to show it).
 */
function baseOptions(abortController: AbortController, extraEnv: Env = {}): Options {
  const configDir = path.resolve("routing-lab/config"); mkdirSync(configDir, { recursive: true });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_DEFAULT_") && !["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].includes(key)));
  const env = { ...inherited, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...extraEnv };
  return {
    tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, abortController, maxTurns: 4, maxBudgetUsd: 0.1,
    // An extraEnv value of undefined removes the variable.
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
  };
}
/** A child controller per query, aborted with the request. */
const child = (parent: AbortSignal) => { const controller = new AbortController(); parent.addEventListener("abort", () => controller.abort(), { once: true }); return controller; };

/** modelUsage is the per-model bill of one query() call: main loop, subagents and auxiliary calls. */
const usageRows = (result: SDKResultMessage) => Object.entries(result.modelUsage).map(([model, row]) => ({
  model, inputTokens: row.inputTokens + row.cacheCreationInputTokens + row.cacheReadInputTokens, outputTokens: row.outputTokens, costUsd: row.costUSD,
}));
type Call = { model: string; status: string; output?: { answer?: string; confidence?: string; tier?: Tier; reason?: string }; costUsd: number; usage: ReturnType<typeof usageRows>; ms: number };

/** One structured-output call on one model. */
async function call(prompt: string, model: string, signal: AbortSignal, opts: { systemPrompt: string; schema: Record<string, unknown>; effort?: Options["effort"] }): Promise<Call> {
  const started = Date.now();
  const q = query({ prompt, options: { ...baseOptions(child(signal)), model, systemPrompt: opts.systemPrompt, outputFormat: { type: "json_schema", schema: opts.schema }, ...(opts.effort ? { effort: opts.effort } : {}) } });
  try {
    for await (const message of q) if (message.type === "result") return {
      model, status: message.subtype, output: message.subtype === "success" ? message.structured_output as Call["output"] : undefined,
      costUsd: message.total_cost_usd, usage: usageRows(message), ms: Date.now() - started,
    };
    return { model, status: "no result", costUsd: 0, usage: [], ms: Date.now() - started };
  } finally { q.close(); }
}

/**
 * The cascade: Haiku answers in a streaming-input session. If needsEscalation() says so, setModel(Opus) switches the
 * SAME session and a second turn asks again; Opus sees Haiku's attempt. The last result's modelUsage covers both.
 */
async function cascade(task: Task, signal: AbortSignal, review = false) {
  const started = Date.now();
  // Streaming input: the session stays open after the first result until we push a follow-up or null (= end).
  const inbox: (string | null)[] = []; let wake: (() => void) | undefined;
  const push = (text: string | null) => { inbox.push(text); wake?.(); };
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: task.prompt }, parent_tool_use_id: null };
    while (true) {
      while (!inbox.length) await new Promise<void>((resolve) => { wake = resolve; });
      const text = inbox.shift();
      if (!text) return;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }
  const q = query({ prompt: prompt(), options: { ...baseOptions(child(signal)), model: models.light.id, systemPrompt: solverPrompt, outputFormat: { type: "json_schema", schema: answerSchema } } });
  const steps: { model: string; output?: Call["output"]; decision?: ReturnType<typeof needsEscalation> }[] = [];
  let last: SDKResultMessage | undefined;
  try {
    for await (const message of q) {
      if (message.type !== "result") continue;
      last = message;
      const output = message.subtype === "success" ? message.structured_output as Call["output"] : undefined;
      if (steps.length === 0) {
        const decision = review ? { escalate: true, why: "review mode: Opus checks every draft" } : needsEscalation(task, output);
        steps.push({ model: models.light.id, output, decision });
        if (!decision.escalate) break;
        await q.setModel(models.deep.id); // the routing decision, applied mid-session
        push(review
          ? "Check the previous answer independently. If it is wrong, correct it. Return the final answer."
          : `Your previous answer may be wrong (${decision.why}). Solve the task again carefully and return the final answer.`);
      } else { steps.push({ model: models.deep.id, output }); break; }
    }
  } finally { push(null); q.close(); }
  const final = steps.at(-1);
  return { steps, output: final?.output, status: last?.subtype ?? "no result", costUsd: last?.total_cost_usd ?? 0, usage: last ? usageRows(last) : [], ms: Date.now() - started };
}

const effortFor = (strategy: Strategy): Options["effort"] | undefined => strategy === "opus-low" ? "low" : undefined;
const fixedTier: Partial<Record<Strategy, Tier>> = { haiku: "light", sonnet: "standard", opus: "deep", "opus-low": "deep" };

/** Route one task with one strategy and solve it. Router cost is reported separately so the table can show it. */
async function solve(strategy: Strategy, task: Task, signal: AbortSignal, send: (event: string, data: unknown) => void) {
  if (strategy === "cascade" || strategy === "review") {
    const run = await cascade(task, signal, strategy === "review");
    const answer = run.output?.answer ?? "";
    return { task: task.id, label: task.tier, route: run.steps.map((step) => step.model), why: run.steps[0]?.decision?.why ?? "", answer, correct: grade(task, answer), status: run.status, costUsd: run.costUsd, routerCostUsd: 0, usage: run.usage, ms: run.ms, escalated: run.steps.length > 1 };
  }
  let tier = fixedTier[strategy], why = "fixed model", routerCostUsd = 0, routerMs = 0;
  if (strategy === "rules") ({ tier, why } = ruleRoute(task.prompt));
  if (strategy === "classifier") {
    const routed = await call(`Task to route:\n${task.prompt}`, models.light.id, signal, { systemPrompt: classifierPrompt, schema: classifierSchema });
    routerCostUsd = routed.costUsd; routerMs = routed.ms;
    tier = routed.output?.tier ?? "standard"; why = routed.output?.reason ?? `classifier ${routed.status}: default to standard`;
  }
  send("route", { task: task.id, tier, why });
  const run = await call(task.prompt, models[tier!].id, signal, { systemPrompt: solverPrompt, schema: answerSchema, effort: effortFor(strategy) });
  const answer = run.output?.answer ?? "";
  return { task: task.id, label: task.tier, route: [run.model], why, answer, correct: grade(task, answer), status: run.status, costUsd: run.costUsd + routerCostUsd, routerCostUsd, usage: run.usage, ms: run.ms + routerMs, escalated: false };
}

/** POST /run: one strategy over the selected tasks, live and billed. Three tasks run at a time. */
concept59.post("/run", async (req, res) => {
  const parsed = z.object({ strategy: strategySchema, taskIds: z.array(z.string()).min(1).max(tasks.length).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  const selected = (parsed.data.taskIds ?? tasks.map((task) => task.id)).map(taskById);
  if (selected.some((task) => !task)) return res.status(400).json({ message: "Unknown task id." });
  if (active) return res.status(409).json({ message: "A lesson 59 run is already active." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env (they use an isolated config directory, not your CLI login)." });
  active = true;
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "240-second host deadline reached." }); abort.abort(); }, 240_000);
  const { strategy } = parsed.data;
  const results: Awaited<ReturnType<typeof solve>>[] = [];
  try {
    send("start", { strategy, info: strategyInfo[strategy], tasks: selected.length });
    const queue = [...selected as Task[]];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let task = queue.shift(); task && !abort.signal.aborted; task = queue.shift()) {
        try { const row = await solve(strategy, task, abort.signal, send); results.push(row); send("task", row); }
        catch (error) { if (!abort.signal.aborted) send("error", { message: `${task.id}: ${String(error)}` }); }
      }
    }));
  } finally {
    clearTimeout(deadline); active = false;
    if (!res.destroyed) {
      const correct = results.filter((row) => row.correct).length, costUsd = results.reduce((sum, row) => sum + row.costUsd, 0);
      const byModel: Record<string, number> = {};
      for (const row of results) for (const usage of row.usage) byModel[usage.model] = (byModel[usage.model] ?? 0) + usage.costUsd;
      send("summary", {
        strategy, tasks: results.length, correct, costUsd, costPerCorrect: correct ? costUsd / correct : null,
        routerCostUsd: results.reduce((sum, row) => sum + row.routerCostUsd, 0), escalations: results.filter((row) => row.escalated).length,
        medianMs: results.map((row) => row.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0, byModel,
      });
      send("done", {}); res.end();
    }
  }
});

/** POST /delegate: routing inside one agent. A Haiku orchestrator keeps easy work and hands the puzzle to an Opus subagent. */
concept59.post("/delegate", async (req, res) => {
  const parsed = z.object({ expertModel: z.enum([models.standard.id, models.deep.id]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  if (active) return res.status(409).json({ message: "A lesson 59 run is already active." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env." });
  active = true;
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "120-second host deadline reached." }); abort.abort(); }, 120_000);
  const puzzle = taskById("lineup")!;
  const prompt = `Two jobs.\n1. Classify the sentiment of "The parcel arrived broken." yourself.\n2. Delegate this puzzle to the expert agent and report its answer: ${puzzle.prompt}`;
  const q = query({ prompt, options: {
    ...baseOptions(abort), tools: ["Agent"], maxTurns: 6, maxBudgetUsd: 0.15, model: models.light.id,
    systemPrompt: "You are a router. Do easy work yourself. Delegate reasoning puzzles to the expert agent with the Agent tool, then report its answer.",
    // Only our expert: the built-in agents would inherit the main model and blur the comparison.
    disallowedTools: ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"].map((name) => `Agent(${name})`),
    agents: { expert: { description: "Solves multi-constraint reasoning puzzles carefully.", prompt: "Solve the puzzle. Reply with the answer and one sentence of reasoning.", tools: [], model: parsed.data.expertModel } },
    canUseTool: async (name, input) => name === "Agent" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the Agent tool is available." },
  } });
  try {
    send("start", { prompt, main: models.light.id, expert: parsed.data.expertModel });
    for await (const message of q) {
      send("message", message);
      if (message.type === "assistant") for (const block of message.message.content)
        if (block.type === "tool_use") send("delegation", { by: message.message.model, subagent: (block.input as any).subagent_type, prompt: String((block.input as any).prompt ?? "").slice(0, 300) });
      if (message.type === "result") send("summary", {
        status: message.subtype, answer: message.subtype === "success" ? message.result : "", costUsd: message.total_cost_usd, usage: usageRows(message),
        correct: message.subtype === "success" && /cai\W+ana\W+ben\W+eli\W+dee/i.test(message.result),
      });
    }
  } catch (error) { if (!abort.signal.aborted) send("error", { message: String(error) }); }
  finally { clearTimeout(deadline); q.close(); active = false; if (!res.destroyed) { send("done", {}); res.end(); } }
});

/**
 * GET /models: supportedModels() maps each alias to the concrete model it resolves to in THIS CLI version.
 * It is a control request, so the process starts, but no prompt is sent and no model turn runs.
 */
concept59.get("/models", async (_req, res) => {
  if (active) return res.status(409).json({ message: "A lesson 59 run is already active." });
  active = true;
  const stop = new AbortController(); const deadline = setTimeout(() => stop.abort(), 30_000);
  async function* silent(): AsyncGenerator<SDKUserMessage> { await new Promise((resolve) => stop.signal.addEventListener("abort", resolve)); }
  const q = query({ prompt: silent(), options: baseOptions(stop) });
  try { res.json((await q.supportedModels()).map(({ value, resolvedModel, displayName, supportsEffort }) => ({ value, resolvedModel: resolvedModel ?? null, displayName, supportsEffort: Boolean(supportsEffort) }))); }
  catch (error) { res.status(500).json({ message: stop.signal.aborted ? "supportedModels() took more than 30 seconds." : String(error) }); }
  finally { clearTimeout(deadline); stop.abort(); q.close(); active = false; }
});

/** POST /resolution: three tiny billed calls that show where a model name really resolves, and the hidden auxiliary call. */
concept59.post("/resolution", async (_req, res) => {
  if (active) return res.status(409).json({ message: "A lesson 59 run is already active." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env." });
  active = true;
  const stop = new AbortController(); const deadline = setTimeout(() => stop.abort(), 90_000);
  const cases = [
    { label: "model: \"sonnet\" (alias)", model: "sonnet", env: {} },
    { label: "model: \"sonnet\" + ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5", model: "sonnet", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: models.standard.id } },
    { label: "model: \"claude-sonnet-5-5\", nonessential traffic allowed", model: models.standard.id, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined } },
  ];
  try {
    const rows = [];
    for (const row of cases) {
      const q = query({ prompt: "Reply with the single word OK.", options: { ...baseOptions(child(stop.signal), row.env), model: row.model, maxTurns: 1, systemPrompt: "Be brief." } });
      try { for await (const message of q) if (message.type === "result") rows.push({ label: row.label, requested: row.model, costUsd: message.total_cost_usd, usage: usageRows(message) }); }
      finally { q.close(); }
    }
    res.json(rows);
  } catch (error) { if (!res.headersSent) res.status(500).json({ message: stop.signal.aborted ? "Resolution check exceeded 90 seconds." : String(error) }); }
  finally { clearTimeout(deadline); active = false; }
});
