/**
 * CONCEPT 47 — Multi-agent orchestration
 *
 * Two ways to make several agents work on one job:
 *
 *   MODEL-DRIVEN: one query(), the model orchestrates. A lead agent calls the Agent tool, Claude Code runs the workers.
 *     query({ prompt, options: { agent: "lead", agents: { lead, analyst }, hooks: { SubagentStop: [gate] } } })
 *
 *   CODE-DRIVEN: your code orchestrates. Every agent is its own query(); your code decides the order, runs them in
 *   parallel, checks their structured output, retries, stops them, and passes the data from one to the next.
 *     const tickets = await runAgent("extractor", …, { outputFormat })          // a pipeline stage
 *     await Promise.all(tickets.map((t) => limit(() => runAgent(t.category, …))))  // a fan-out with a concurrency limit
 *
 * The tab shows:
 *   1. orchestrator-workers: a lead (the main-thread agent) starts one analyst per region IN PARALLEL; a SubagentStop
 *      hook checks every report against the real data and sends a wrong one back to work;
 *   2. the hierarchy: a manager that starts its own analysts (spawn_depth 2, seen only by hooks and task_* messages),
 *      and a background worker that the main agent steers with SendMessage;
 *   3. a code-driven pipeline: extract (structured output) → route in code → specialists in parallel → edit;
 *   4. a code-driven fan-out: six workers, a concurrency limit, a missing file, verification, a budget guard;
 *   5. evaluator-optimizer: a writer session and a strict critic, in a loop until both the code checks and the critic pass.
 * Routes: GET /facts, POST /orchestrator, /hierarchy, /pipeline, /fanout, /evaluator (SSE), GET /code.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type AgentDefinition, type HookCallback, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept47 = Router();

const MODEL = "haiku";
const LAB = path.resolve("orchestra-lab");
const ROOT = process.cwd();
const short = (s: string) =>
  s
    .replaceAll(LAB, "orchestra-lab")
    .replaceAll(LAB.replaceAll("\\", "\\\\"), "orchestra-lab")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…");

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const clip = (v: unknown, n = 300) => cut(short(typeof v === "string" ? v : JSON.stringify(v ?? "")), n);

// ---------------------------------------------------------------------------------------------
// The data: units sold per product in five regions (one CSV each), and an inbox of customer emails.
// The server knows the right answers, so it can check what the agents report.
// ---------------------------------------------------------------------------------------------

// #region data
export const SALES: Record<string, [string, number][]> = {
  north: [["P1", 120], ["P2", 340], ["P3", 90], ["P4", 205], ["P5", 60]],
  south: [["P1", 410], ["P2", 55], ["P3", 230], ["P4", 130], ["P5", 95]],
  east: [["P1", 75], ["P2", 610], ["P3", 180], ["P4", 45], ["P5", 220]],
  west: [["P1", 260], ["P2", 140], ["P3", 300], ["P4", 310], ["P5", 85]],
  central: [["P1", 150], ["P2", 150], ["P3", 95], ["P4", 420], ["P5", 70]],
};
/** The truth: what a correct analyst reports. "islands" has no file: a worker that looks for it must say so. */
export const truth = (region: string) => {
  const rows = SALES[region];
  if (!rows) return undefined;
  const best = rows.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { total: rows.reduce((a, [, u]) => a + u, 0), best: best[0] };
};
export const GRAND_TOTAL = Object.keys(SALES).reduce((a, r) => a + truth(r)!.total, 0);

export const INBOX = [
  "From: Ana Ruiz (ACME)\nSubject: Charged twice\nI was charged twice for invoice 1042 (89 EUR). Please refund one of the two payments.",
  "From: Ben Okafor (Globex)\nSubject: Export broken\nSince this morning the Export button returns error 500. Our whole team is blocked, please help quickly.",
  "From: Chloe Martin (Initech)\nSubject: 50 seats\nWe are thinking of moving 50 people to your Team plan. Is there a volume discount?",
  "From: Dan Weber (Umbrella)\nSubject: Refund of the annual plan\nI bought the annual plan 45 days ago (480 EUR) and we no longer use it. I want a refund.",
  "From: Eva Lindqvist (Hooli)\nSubject: Password\nThe password reset link I got yesterday says it has expired. How do I reset my password?",
];

function writeLabFiles(cwd: string) {
  for (const [region, rows] of Object.entries(SALES)) writeFileSync(path.join(cwd, `${region}.csv`), `product,units\n${rows.map(([p, u]) => `${p},${u}`).join("\n")}\n`);
  writeFileSync(path.join(cwd, "inbox.txt"), INBOX.map((m, i) => `--- email ${i + 1} ---\n${m}`).join("\n\n") + "\n");
}
// #endregion

// ---------------------------------------------------------------------------------------------
// Options: a clean env (Tab16), a config dir and a work folder per lane, no settings from disk
// ---------------------------------------------------------------------------------------------

// #region options
// Claude Code always offers its built-in subagents too (Tab8). A deny rule per type keeps the Agent tool for ours.
const BUILT_IN_AGENTS = ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"];

function laneOptions(lane: string, abort: AbortController, extra: Partial<Options> = {}): Options {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_BASE_URL)/.test(k)));
  const config = path.join(LAB, "config", lane);
  const cwd = path.join(LAB, "work", lane);
  // Fresh folders for every run: the agents must not see what the previous run left behind.
  for (const d of [config, cwd]) rmSync(d, { recursive: true, force: true, maxRetries: 3 }), mkdirSync(d, { recursive: true });
  writeLabFiles(cwd);
  return {
    model: MODEL,
    cwd,
    env: { ...clean, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    tools: [],
    allowedTools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 8,
    abortController: abort,
    ...extra,
    disallowedTools: [...BUILT_IN_AGENTS.map((n) => `Agent(${n})`), ...(extra.disallowedTools ?? [])],
  };
}

/** A child AbortController: aborted when the route's is (the browser went away) or on its own (a budget guard). */
function childAbort(parent: AbortController) {
  const c = new AbortController();
  if (parent.signal.aborted) c.abort();
  else parent.signal.addEventListener("abort", () => c.abort(), { once: true });
  return c;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// Model-driven runs: turn the message stream and the hooks into one event per agent (start, tool, progress, end)
// ---------------------------------------------------------------------------------------------

// #region observe
// $ per million tokens (list prices), to estimate one worker's cost from the usage in its Agent tool_use_result.
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku-4-5/, input: 1, output: 5 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /opus-5-5/, input: 4, output: 20 },
];
function estimate(model: string | undefined, u: any) {
  const p = PRICES.find((x) => x.match.test(model ?? ""));
  if (!p || !u) return undefined;
  return ((u.input_tokens ?? 0) * p.input + (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 + (u.cache_read_input_tokens ?? 0) * p.input * 0.1 + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/**
 * One row per agent, keyed by the id of the Agent tool_use that started it ("main" for the main thread).
 * - The STREAM carries depth-1 subagents only: their messages have parent_tool_use_id = that id.
 * - task_started / task_progress / task_notification come for EVERY depth, with spawn_depth.
 * - HOOKS fire at every depth too, with agent_id (absent on the main thread): so a PreToolUse hook sees the tool calls
 *   of a depth-2 agent that never reach the stream, and tells us who started whom.
 */
function orchestration(emit: Emit, opts: { foreground?: boolean } = {}) {
  const callerOf = new Map<string, string>(); // Agent tool_use id → agent_id of the agent that made the call ("main")
  const rowOf = new Map<string, string>(); // agent_id (= task_id) → its row (the Agent tool_use id)
  const typeOf = new Map<string, string>(); // row → subagent_type
  const row = (agentId?: string) => (agentId ? (rowOf.get(agentId) ?? agentId) : "main");

  const preToolUse: HookCallback = async (input: any) => {
    if (/^(Agent|Task)$/.test(input.tool_name)) {
      callerOf.set(input.tool_use_id, input.agent_id ?? "main");
      emit("delegate", { row: row(input.agent_id), to: input.tool_input.subagent_type, background: input.tool_input.run_in_background, name: input.tool_input.name });
      // Concept 8's trick: the Agent tool runs workers in the background unless told otherwise. Force the foreground,
      // so the lead waits for its workers and gets their reports as the tool_result.
      if (opts.foreground && input.tool_input.run_in_background !== false)
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, run_in_background: false } } };
      return {};
    }
    emit("tool", { row: row(input.agent_id), name: input.tool_name, input: clip(input.tool_input, 300) });
    return {};
  };

  async function consume(q: AsyncIterable<any>) {
    const results: any[] = [];
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") emit("init", { model: m.model, tools: m.tools, agents: m.agents });
      if (m.type === "system" && m.subtype === "task_started" && m.task_type === "local_agent") {
        rowOf.set(m.task_id, m.tool_use_id);
        typeOf.set(m.tool_use_id, m.subagent_type);
        const caller = callerOf.get(m.tool_use_id) ?? "main";
        emit("agent-start", { row: m.tool_use_id, name: m.subagent_type, depth: m.spawn_depth ?? 1, parent: caller === "main" ? "main" : row(caller), background: m.is_backgrounded, description: m.description, prompt: clip(m.prompt, 500) });
      }
      if (m.type === "system" && m.subtype === "task_progress" && rowOf.get(m.task_id))
        emit("agent-progress", { row: m.tool_use_id, text: clip(m.summary ?? m.description, 120), tokens: m.usage?.total_tokens, toolUses: m.usage?.tool_uses });
      if (m.type === "system" && m.subtype === "task_notification" && rowOf.get(m.task_id))
        emit("agent-end", { row: m.tool_use_id, status: m.status, summary: clip(m.summary, 400), tokens: m.usage?.total_tokens, toolUses: m.usage?.tool_uses, durationMs: m.usage?.duration_ms });
      if (m.type === "system" && m.subtype === "background_tasks_changed") emit("background", { running: m.tasks.length });
      if (m.type === "user" && m.tool_use_result?.agentId) {
        // The Agent tool's structured output (AgentOutput in sdk-tools.d.ts): the report plus the worker's totals.
        const r = m.tool_use_result;
        const id = (m.message.content as any[]).find((b) => b.type === "tool_result")?.tool_use_id;
        if (r.status === "completed")
          emit("agent-report", { row: id, model: r.resolvedModel, tokens: r.totalTokens, toolUses: r.totalToolUseCount, durationMs: r.totalDurationMs, costEstimate: estimate(r.resolvedModel, r.usage), text: clip(r.content?.map((c: any) => c.text).join("\n"), 500) });
        // A background worker: the tool_result comes at once and says nothing; the report arrives as a task_notification.
        if (r.status === "async_launched") emit("agent-launched", { row: id, agentId: r.agentId });
      }
      if (m.type === "assistant" && !m.parent_tool_use_id)
        for (const b of m.message.content) if (b.type === "text" && b.text.trim()) emit("say", { row: "main", text: clip(b.text, 1500) });
      if (m.type === "result") {
        const r = { n: results.length + 1, subtype: m.subtype, isError: m.is_error, text: clip(m.subtype === "success" ? m.result : (m.errors ?? []).join("; "), 1500), cost: m.total_cost_usd, turns: m.num_turns, modelUsage: Object.fromEntries(Object.entries<any>(m.modelUsage ?? {}).map(([k, u]) => [k, u.costUSD])) };
        results.push(r);
        emit("result", r);
      }
    }
    return results;
  }
  return { preToolUse, consume, rowOf, typeOf, row };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// Code-driven runs: one query() per agent, with its own prompt, tools, schema and budget
// ---------------------------------------------------------------------------------------------

// #region run-agent
export type AgentRun = { row: string; ok: boolean; text: string; structured?: any; cost: number; ms: number; turns: number; error?: string };

/**
 * Runs one agent to its end and reports it as a row of the timeline (parent "code": your code started it).
 * With `outputFormat`, `result.structured_output` is the value the model had to produce (Tab10); your code checks it.
 */
async function runAgent(row: string, name: string, prompt: string, options: Options, emit: Emit, info: object = {}): Promise<AgentRun> {
  const started = Date.now();
  emit("agent-start", { row, name, depth: 1, parent: "code", prompt: clip(prompt, 600), ...info });
  const out: AgentRun = { row, ok: false, text: "", cost: 0, ms: 0, turns: 0 };
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use" && b.name !== "StructuredOutput") emit("tool", { row, name: b.name, input: clip(b.input, 300) });
      if (m.type === "result") {
        out.cost = m.total_cost_usd;
        out.turns = m.num_turns;
        // An API error (no credit, overloaded…) ends the run as subtype "success" with is_error: true and the error as
        // its text. Never pass that on as an answer.
        out.ok = m.subtype === "success" && !m.is_error;
        out.text = m.subtype === "success" ? short(m.result) : (m.errors ?? [m.subtype]).join("; ");
        if (out.ok && m.subtype === "success") out.structured = m.structured_output;
        else out.error = m.subtype === "success" ? cut(out.text, 200) : m.subtype;
      }
    }
  } catch (err) {
    // An abort that lands after the result (the budget guard, a moment too late) does not undo the answer.
    if (!out.ok) out.error = options.abortController?.signal.aborted ? "aborted" : errText(err);
  }
  out.ms = Date.now() - started;
  emit("agent-end", { row, status: out.ok ? "completed" : out.error === "aborted" ? "stopped" : "failed", summary: clip(out.structured ?? out.text, 600), cost: out.cost, durationMs: out.ms, error: out.error });
  return out;
}

/** At most `n` agents at a time. Each worker is a Claude Code process: the limit protects your machine and your rate limits. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** A streaming-input session (Tab12) you can ask one turn at a time: the writer of Scenario 5 keeps its context. */
function chatSession(options: Options) {
  const inbox: (SDKUserMessage | null)[] = [];
  let wake = () => {};
  const push = (m: SDKUserMessage | null) => (inbox.push(m), wake());
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (!inbox.length) await new Promise<void>((r) => (wake = r));
      const m = inbox.shift();
      if (!m) return;
      yield m;
    }
  }
  const it = query({ prompt: input(), options })[Symbol.asyncIterator]();
  let spent = 0;
  return {
    async ask(text: string) {
      push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
      for (;;) {
        const { value: m, done } = await it.next();
        if (done) throw new Error("the session ended");
        if (m.type === "result") {
          const cost = m.total_cost_usd - spent; // the result carries the running total (Tab15)
          spent = m.total_cost_usd;
          return { text: m.subtype === "success" ? short(m.result) : (m.errors ?? [m.subtype]).join("; "), cost, ok: m.subtype === "success" && !m.is_error };
        }
      }
    },
    close() {
      push(null);
      (async () => {
        while (!(await it.next()).done);
      })().catch(() => {});
    },
  };
}
// #endregion

/** A prompt whose input stays open until close(): background tasks live as long as the session does. */
function heldOpenPrompt(text: string, abort: AbortController, maxMs = 120_000) {
  const inbox: (string | null)[] = [text];
  let wake = () => {};
  const push = (m: string | null) => (inbox.push(m), wake());
  const timer = setTimeout(() => push(null), maxMs);
  abort.signal.addEventListener("abort", () => push(null), { once: true });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (!inbox.length) await new Promise<void>((r) => (wake = r));
      const m = inbox.shift();
      if (m === null || m === undefined) break;
      yield { type: "user", message: { role: "user", content: m }, parent_tool_use_id: null } as SDKUserMessage;
    }
    clearTimeout(timer);
  }
  // push(text): one more user turn in the same session (your code talking to the orchestrator); close(): end the input.
  return { prompt: prompt(), push: (m: string) => push(m), close: () => push(null) };
}

/** The code's check of an orchestrator's final answer: every region's line, compared with the data. */
function checkReport(final: string, regions: string[]) {
  return regions.map((region) => {
    const t = truth(region)!;
    // The region's report line: "REGION=<region>…" if there is one, else the LAST line that names the region with a number
    // (not "Here are the results for the west and central regions:", not a remark above the report).
    const lines = final.split("\n").filter((l: string) => new RegExp(`\\b${region}\\b`, "i").test(l) && /\d/.test(l));
    const line = lines.find((l: string) => new RegExp(`REGION=${region}\\b`, "i").test(l)) ?? lines.at(-1) ?? "";
    const nums = (line.match(/\d[\d,]*/g) ?? []).map((n: string) => Number(n.replace(/,/g, "")));
    const best = line.match(/\bP\d\b/)?.[0];
    return { region, line: cut(line.replace(/[*|`]/g, " ").replace(/\s+/g, " ").trim(), 80), total: !line ? "missing" : nums.includes(t.total) ? "ok" : `wrong (${t.total})`, best: !line || !best ? "missing" : best === t.best ? "ok" : `wrong (${t.best})` };
  });
}

/** An SSE route: parse the body, stream every event with the time since the start of the route (and its lane). */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, lane: (name: string) => Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const lane = (name: string): Emit => (e, d) => send(e, { ...d, lane: name, at: Date.now() - startedAt });
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await body(parsed.data, abort, lane);
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: errText(err) });
    } finally {
      send("done", {});
      res.end();
    }
  };
}

// ---------------------------------------------------------------------------------------------
// GET /facts
// ---------------------------------------------------------------------------------------------

concept47.get("/facts", (_req, res) => {
  try {
    const dir = path.resolve("node_modules/@anthropic-ai/claude-agent-sdk");
    const dts = readFileSync(path.join(dir, "sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const tools = readFileSync(path.join(dir, "sdk-tools.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    // The doc comment right above a field: `/** … */ name?:` (or `name:`), as one line.
    // A doc comment as one line: the leading "*" of every line removed, the @example cut off.
    const flat = (d: string) => d.split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join(" ").split(" @example")[0].replace(/\s+/g, " ").trim();
    const doc = (src: string, name: string) => {
      const d = src.match(new RegExp(`\\/\\*\\*((?:(?!\\*\\/)[\\s\\S])*?)\\*\\/\\s*${name}\\??:`))?.[1];
      return d ? flat(d) : "not found";
    };
    const agentInput = tools.match(/export interface AgentInput \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const fields = [...agentInput.matchAll(/\/\*\*([\s\S]*?)\*\/\s*(\w+)\??:/g)].map(([, d, name]) => ({ name, doc: flat(d) }));
    const stopDoc = dts.match(/\/\*\*\s*\n\s*\* (Hook-specific output for the SubagentStop event[^\n]*)/)?.[1] ?? "not found";
    res.json({
      sdkVersion: pkg.version,
      claudeCodeVersion: pkg.claudeCodeVersion,
      agentOption: doc(dts, "agent"),
      agentProgressSummaries: doc(dts, "agentProgressSummaries"),
      spawnDepth: doc(dts, "spawn_depth"),
      subagentStop: stopDoc,
      agentInput: fields,
      grandTotal: GRAND_TOTAL,
      sales: Object.fromEntries(Object.keys(SALES).map((r) => [r, truth(r)])),
    });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /orchestrator: model-driven. The lead is the main-thread agent; it starts three analysts in parallel.
// A SubagentStop hook checks each report against the data and sends a wrong one back to work.
// ---------------------------------------------------------------------------------------------

// #region gate
// The whole report, one line: a worker's output is the next agent's input, so the format is part of the contract.
const REPORT = /^REGION=(\w+);\s*TOTAL=(\d+);\s*BEST=(P\d)$/i;

/**
 * The quality gate. SubagentStop fires when a worker wants to finish; `last_assistant_message` is its report.
 * `decision: "block"` + `reason` sends the reason to the WORKER, which keeps working (probe: it fixed its report).
 * On the second stop `stop_hook_active` is true: let it go then, or a stubborn worker loops forever.
 */
function qualityGate(emit: Emit, row: (agentId: string) => string): HookCallback {
  return async (input: any) => {
    if (input.agent_type !== "analyst") return {};
    const report = String(input.last_assistant_message ?? "");
    const m = report.trim().match(REPORT);
    const t = m && truth(m[1].toLowerCase());
    const problem = !m
      ? "Your report must be ONE line in exactly this format: REGION=<region>; TOTAL=<sum of the units>; BEST=<product>."
      : !t
        ? `There is no region "${m[1]}".`
        : Number(m[2]) !== t.total
          ? `TOTAL=${m[2]} is wrong. Read the file again and add up every row of the units column.`
          : m[3].toUpperCase() !== t.best
            ? `BEST=${m[3]} is wrong: it is the product with the MOST units.`
            : null;
    const verdict = !problem ? "pass" : input.stop_hook_active ? "let through (second stop)" : "block";
    emit("gate", { row: row(input.agent_id), verdict, reason: problem, report: clip(report, 300) });
    if (verdict !== "block") return {};
    return { decision: "block", reason: problem! };
  };
}
// #endregion

// #region scenario-orchestrator
export const LEAD_AGENTS: Record<string, AgentDefinition> = {
  lead: {
    description: "Coordinates the regional analysts and writes the sales report.",
    prompt:
      "You are the lead of a sales-analysis team. You never read files yourself. For every region you are given, start ONE analyst " +
      "subagent (subagent_type: analyst). Start all of them in the SAME message so they work in parallel. Give each one only its region name. " +
      "When every report is back, reply with a markdown table region | total units | best product, sorted by total, then one sentence naming the top region.",
    tools: ["Agent(analyst)"], // the lead may only start analysts: an Agent(type) rule in its own tool list
    model: "haiku",
  },
  analyst: {
    description: "Analyses the sales CSV of ONE region.",
    prompt:
      "You analyse one region. Read <region>.csv in the working folder (columns: product,units). Add up the units of every row. " +
      "Reply with ONE line and nothing else: REGION=<region>; TOTAL=<sum of the units>; BEST=<product with the most units>. Never print file paths.",
    tools: ["Read"],
    model: "haiku",
    maxTurns: 4,
  },
};

concept47.post(
  "/orchestrator",
  sseRoute(z.object({ gate: z.boolean().default(true) }).strict(), async (b, abort, lane) => {
    const emit = lane("lead");
    const o = orchestration(emit, { foreground: true });
    const options = laneOptions("lead", abort, {
      agent: "lead", // the main thread IS the lead: its prompt, its tools, its model (the --agent CLI flag)
      agents: LEAD_AGENTS,
      tools: ["Agent", "Read"], // the pool: the lead gets Agent(analyst), the analysts get Read
      allowedTools: ["Agent", "Read"],
      hooks: {
        PreToolUse: [{ hooks: [o.preToolUse] }],
        ...(b.gate && { SubagentStop: [{ hooks: [qualityGate(emit, o.row)] }] }),
      },
      maxTurns: 6,
    });
    emit("options", { agent: "lead", agents: LEAD_AGENTS, tools: options.tools, hooks: { PreToolUse: ["[Function observe + foreground]"], ...(b.gate && { SubagentStop: ["[Function qualityGate]"] }) } });
    const results = await o.consume(query({ prompt: "Produce the sales report for the regions north, south and east.", options }));
    emit("verdict", { results, truth: Object.fromEntries(["north", "south", "east"].map((r) => [r, truth(r)])) });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /hierarchy: two lanes. A director → a manager → analysts (depth 2); a dispatcher that steers a background
// worker with SendMessage.
// ---------------------------------------------------------------------------------------------

// #region scenario-hierarchy
export const TREE_AGENTS: Record<string, AgentDefinition> = {
  director: {
    description: "Hands the regional analysis to the manager and reports its answer.",
    prompt: "You are the director. Hand the whole job to ONE manager subagent (subagent_type: manager) with the list of regions, then reply with a markdown table with exactly these columns: region | total units | best product. Copy the numbers and products from the manager's answer; do not rename or reinterpret them.",
    // Plain "Agent", not "Agent(manager)": on the MAIN-THREAD agent an Agent(type) rule holds for the whole tree. The probe
    // with Agent(manager) here: the manager got "Agent type 'analyst' not found. Available agents: manager" and started
    // managers instead, down to spawn_depth 3.
    tools: ["Agent"],
    model: "haiku",
  },
  manager: {
    description: "Manages several regional analysts: starts one per region and merges their reports.",
    prompt: "You are a manager. For every region you are given, start ONE analyst subagent (subagent_type: analyst), all in the SAME message. Then reply with the analysts' lines exactly as they sent them, one per region: REGION=<region>; TOTAL=<units>; BEST=<product>.",
    tools: ["Agent(analyst)"], // a subagent may start subagents too: its analysts run at spawn_depth 2
    model: "haiku",
    maxTurns: 4,
  },
  analyst: LEAD_AGENTS.analyst,
  // A slow worker (five files, one Read per step), so a message can reach it while it works.
  surveyor: {
    description: "Surveys the five regional files one by one.",
    prompt:
      "Read north.csv, south.csv, east.csv, west.csv and central.csv ONE AT A TIME, in this order, one Read per step. " +
      "After each file write one line: REGION=<region>; TOTAL=<sum of the units>. A new instruction may arrive while you work: apply it to the lines you write from then on and KEEP GOING. Never stop to ask for confirmation. " +
      "Never leave a field empty: if you do not know a value, Read that file again. " +
      "At the end reply with all the lines. Never print file paths.",
    tools: ["Read"],
    model: "haiku",
    maxTurns: 8,
  },
  dispatcher: {
    description: "Starts a background surveyor and steers it while it works.",
    prompt:
      "You are a dispatcher. 1) Start ONE surveyor subagent IN THE BACKGROUND: subagent_type 'surveyor', run_in_background: true, name: 'surveyor'. " +
      "2) In your very next message, use SendMessage to 'surveyor' with the message: 'From now on also add BEST=<product with the most units> to every line. Keep going, do not reply to this message.' " +
      "3) Say that you are waiting. 4) When its report arrives, check it: there must be a line for ALL FIVE regions, and EVERY line must have BEST=. " +
      "If it is complete, reply with the report only. If not, use SendMessage to 'surveyor' again, telling it to READ the file of every region with a missing field again (for example: 'Read north.csv again, find the product with the most units, then send all five lines, each with BEST=.'), " +
      "and say that you are waiting. Do this at most twice.",
    tools: ["Agent", "SendMessage"],
    model: "haiku",
  },
};

concept47.post(
  "/hierarchy",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    const run = async (name: string, agent: string, prompt: string, foreground: boolean) => {
      // A one-shot run (a string prompt) closes Claude Code's input, and then "kills hold-back tasks at the held-result
      // release" (sdk.d.ts): a background worker the dispatcher resumes after its first result never gets to run.
      // So the background lane keeps its input open (streaming input, Tab12) until nothing has happened for 4 s while no
      // background task is running, or for at most 120 s.
      const held = foreground ? undefined : heldOpenPrompt(prompt, abort);
      const regions = name === "send" ? Object.keys(SALES) : ["west", "central"];
      let running = 0;
      let lastAnswer = "";
      let corrections = 0;
      let idle: ReturnType<typeof setTimeout> | undefined;
      // The code supervises the orchestrator: when the session goes quiet, it checks the last answer against the data.
      // Wrong or missing → ONE more user turn in the same session that says exactly what is wrong; right → close the input.
      // (Probes: the worker guessed north's BEST as P1, twice; the dispatcher cannot know, only the data can.)
      const onIdle = () => {
        if (!held || running > 0) return;
        const problems = checkReport(lastAnswer, regions).filter((c) => c.total !== "ok" || c.best !== "ok");
        if (!problems.length || corrections >= 1) return held.close();
        corrections++;
        const text = `Your code checked your report against the data. Wrong or missing: ${problems.map((p) => `${p.region} (total ${p.total}, best ${p.best})`).join("; ")}. Have the surveyor READ those files again and send the corrected lines, then reply with all five lines.`;
        emit("supervisor", { text, problems });
        held.push(text);
      };
      const emit: Emit = (e, d) => {
        lane(name)(e, d);
        if (!held) return;
        if (e === "background") running = (d as any).running;
        if (e === "result" && !(d as any).isError) lastAnswer = (d as any).text;
        clearTimeout(idle);
        idle = setTimeout(onIdle, 4000);
      };
      const o = orchestration(emit, { foreground });
      const options = laneOptions(name, abort, {
        agent,
        agents: TREE_AGENTS,
        tools: ["Agent", "Read", "SendMessage"],
        allowedTools: ["Agent", "Read", "SendMessage"],
        // No SubagentStop gate here: the hooks only observe (and PreToolUse is the only way to see depth 2's tool calls).
        hooks: { PreToolUse: [{ hooks: [o.preToolUse] }] },
      });
      emit("options", { agent, tools: options.tools, subagents: Object.keys(TREE_AGENTS).filter((a) => a !== agent) });
      const results = await o.consume(query({ prompt: held?.prompt ?? prompt, options }));
      clearTimeout(idle);
      // Model-driven does not mean unchecked: the code reads the orchestrator's final answer and compares it with the data
      // (a probe dispatcher wrote "BEST for each region" above a north line without BEST).
      const final = results.filter((r) => r.subtype === "success" && !r.isError).at(-1)?.text ?? "";
      emit("verdict", { results, reportCheck: checkReport(final, regions), corrections });
    };
    await Promise.all([
      run("tree", "director", "Analyse the regions west and central.", true),
      run("send", "dispatcher", "Get me the survey of the five regions.", false),
    ]);
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /pipeline: code-driven. extract → route (code) → specialists in parallel → edit. Structured output between stages.
// ---------------------------------------------------------------------------------------------

// #region scenario-pipeline
const Ticket = z.object({
  id: z.number().int(),
  customer: z.string().describe("name and company"),
  category: z.enum(["billing", "technical", "sales"]),
  urgency: z.enum(["low", "high"]),
  summary: z.string().describe("the request in at most 15 words"),
});
const Tickets = z.object({ tickets: z.array(Ticket) });
const Reply = z.object({ reply: z.string().describe("the answer to the customer, at most 50 words"), escalate: z.boolean(), reason: z.string().describe("why it is or is not escalated, one sentence") });
const Digest = z.object({ digest: z.string().describe("the shift summary for the team lead, at most 60 words; name every ticket a human must handle as #<id>"), escalations: z.array(z.number().int()).describe("ticket ids a human must handle") });
const schema = (s: z.ZodTypeAny) => ({ type: "json_schema" as const, schema: z.toJSONSchema(s, { target: "draft-07" }) as Record<string, unknown> }); // as in Tab10

// The router is plain code: a map from category to a specialist. Each has its own policy (system prompt) and model.
export const SPECIALISTS: Record<string, { model: string; systemPrompt: string }> = {
  billing: { model: "haiku", systemPrompt: "You are the billing specialist. Policy: duplicate charges are refunded at once. Refunds of a plan are allowed up to 30 days after purchase; after 30 days a human must decide (escalate). Never promise what the policy does not allow." },
  technical: { model: "haiku", systemPrompt: "You are the technical support specialist. Password links expire after 24 hours: tell the user to request a new one from the login page. Any error 500 that blocks a team is an incident: escalate it and say the engineers are looking at it." },
  sales: { model: "haiku", systemPrompt: "You are the sales specialist. Volume discounts: 10% from 25 seats, 15% from 50 seats. A human sales rep follows up every offer above 40 seats (escalate)." },
};

concept47.post(
  "/pipeline",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    const emit = lane("pipeline");
    const stage = (n: number, name: string, data: object) => emit("stage", { n, name, ...data });

    // Stage 1: one agent with Read and a JSON schema. Its output is data, not prose: the next stage can use it.
    stage(1, "extract", { note: "one agent · Read · outputFormat: Tickets" });
    const ex = await runAgent("extract", "extractor", "Read inbox.txt. Turn every email into a ticket. Number them from 1 in the order of the file.", laneOptions("pl-extract", abort, { tools: ["Read"], allowedTools: ["Read"], outputFormat: schema(Tickets), systemPrompt: "You triage a support inbox. Categories: billing (payments, invoices, refunds), technical (errors, login, bugs), sales (prices, plans, discounts). Urgency is high ONLY when the customer was charged wrongly or a whole team cannot work; everything else (a single user, a question, a refund request) is low." }), emit, { stage: 1 });
    const parsed = Tickets.safeParse(ex.structured);
    // Your code checks the handoff: a stage that returns the wrong shape stops the pipeline here, not three stages later.
    if (!ex.ok) return void stage(1, "extract", { error: `the extractor failed: ${ex.error}` });
    if (!parsed.success) return void stage(1, "extract", { error: `the extractor's output does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    const tickets = parsed.data.tickets;
    stage(1, "extract", { output: tickets, cost: ex.cost, ms: ex.ms });

    // Stage 2: the ROUTER is code (a switch on category), the specialists run in parallel, at most 3 at a time.
    stage(2, "route + answer", { note: `${tickets.length} tickets → ${[...new Set(tickets.map((t) => t.category))].join(", ")} · at most 3 at a time`, routes: tickets.map((t) => ({ id: t.id, to: t.category })) });
    const limit = limiter(3);
    const answers = await Promise.all(
      tickets.map((t) =>
        limit(async () => {
          const s = SPECIALISTS[t.category];
          const r = await runAgent(`t${t.id}`, `${t.category} #${t.id}`, `Ticket #${t.id} from ${t.customer} (${t.urgency} urgency): ${t.summary}\n\nThe original email:\n${INBOX[t.id - 1] ?? "(not found)"}`, laneOptions(`pl-${t.id}`, abort, { model: s.model, systemPrompt: s.systemPrompt, outputFormat: schema(Reply), maxTurns: 3 }), emit, { stage: 2 });
          const reply = Reply.safeParse(r.structured);
          return { id: t.id, category: t.category, ok: reply.success, ...(reply.success ? reply.data : { reply: "", escalate: true, reason: `no valid answer (${r.error ?? "schema"})` }), cost: r.cost };
        }),
      ),
    );
    stage(2, "route + answer", { output: answers, cost: answers.reduce((a, x) => a + x.cost, 0) });

    // Stage 3: the editor only sees the data of stage 2 (in its prompt), not the conversations that produced it.
    stage(3, "edit", { note: "one agent · no tools · outputFormat: Digest" });
    const ed = await runAgent("edit", "editor", `The answered tickets of this shift, as JSON:\n${JSON.stringify(answers.map(({ cost, ...a }) => a), null, 1)}\n\nWrite the shift digest for the team lead and list the tickets a human must handle.`, laneOptions("pl-edit", abort, { outputFormat: schema(Digest), maxTurns: 3 }), emit, { stage: 3 });
    const digest = Digest.safeParse(ed.structured);
    stage(3, "edit", digest.success ? { output: digest.data, cost: ed.cost, ms: ed.ms } : { error: "the editor's output does not match the schema" });
    // The code can also check the answer: every ticket a specialist escalated must be in the digest's list.
    // A probe digest said "Two critical escalations" next to a list of three: check the text against the data too.
    const escalated = answers.filter((a) => a.escalate).map((a) => a.id);
    const missing = escalated.filter((id) => !(digest.data?.escalations ?? []).includes(id));
    const notInText = escalated.filter((id) => !new RegExp(`#${id}\\b`).test(digest.data?.digest ?? ""));
    const extra = (digest.data?.escalations ?? []).filter((id) => !escalated.includes(id));
    emit("verdict", { agents: 2 + tickets.length, cost: ex.cost + answers.reduce((a, x) => a + x.cost, 0) + ed.cost, escalated, missingEscalations: missing, notInText, extraEscalations: extra });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /fanout: code-driven. Six workers (one file is missing), a concurrency limit, verification, a budget guard.
// ---------------------------------------------------------------------------------------------

// #region scenario-fanout
const RegionReport = z.object({ region: z.string(), found: z.boolean().describe("false when the file does not exist"), total: z.number().int(), best: z.string() });
export const FANOUT_REGIONS = ["north", "south", "east", "west", "central", "islands"];

concept47.post(
  "/fanout",
  sseRoute(z.object({ limit: z.number().int().min(1).max(6).default(3), budgetUsd: z.number().min(0.001).max(1).default(0.1) }).strict(), async (b, abort, lane) => {
    const emit = lane("fanout");
    const limit = limiter(b.limit);
    let spent = 0;
    const guard = childAbort(abort); // one switch for every worker: the budget guard pulls it
    emit("options", { limit: b.limit, budgetUsd: b.budgetUsd, workers: FANOUT_REGIONS.length, perWorker: { tools: ["Read"], outputFormat: "RegionReport", maxTurns: 4, maxBudgetUsd: 0.03 } });

    const settled = await Promise.allSettled(
      FANOUT_REGIONS.map((region) =>
        limit(async () => {
          if (guard.signal.aborted) {
            emit("agent-skip", { row: region, name: `worker ${region}`, reason: "budget reached: never started" });
            throw new Error("skipped: budget reached");
          }
          const r = await runAgent(region, `worker ${region}`, `Region: ${region}. Read ${region}.csv in the working folder (columns: product,units) and report its total units and the product with the most units. If the file does not exist, report found: false, total 0 and best "".`, laneOptions(`fo-${region}`, childAbort(guard), { tools: ["Read"], allowedTools: ["Read"], outputFormat: schema(RegionReport), maxTurns: 4, maxBudgetUsd: 0.03 }), emit);
          spent += r.cost;
          if (spent > b.budgetUsd && !guard.signal.aborted) {
            emit("guard", { spent, budgetUsd: b.budgetUsd, text: `spent $${spent.toFixed(4)} > budget $${b.budgetUsd}: stopping the workers still running and skipping the rest` });
            guard.abort();
          }
          const rep = RegionReport.safeParse(r.structured);
          if (!r.ok || !rep.success) throw new Error(r.error ?? "no valid report");
          // Trust, then verify: the code knows the data, so it checks every number before it is used.
          const t = truth(region);
          const check = !t ? (rep.data.found ? "claims a file that does not exist" : "ok: reports the file as missing") : !rep.data.found ? "says missing, but the file exists" : rep.data.total !== t.total ? `wrong total (${t.total} expected)` : rep.data.best !== t.best ? `wrong best (${t.best} expected)` : "ok";
          emit("check", { row: region, check, good: check.startsWith("ok") });
          return { ...rep.data, check, cost: r.cost };
        }),
      ),
    );
    const good = settled.flatMap((s) => (s.status === "fulfilled" && s.value.check === "ok" ? [s.value] : []));
    const failed = FANOUT_REGIONS.filter((_, i) => { const s = settled[i]; return s.status === "rejected" || s.value.check !== "ok"; });

    // Fan-in: one more agent writes the summary of the VERIFIED results. The arithmetic is code's job (a probe aggregator
    // wrote "4,845 (north, south, east and west)", leaving out central): the code computes the total and the top region,
    // the aggregator only words them, and the code checks its text afterwards.
    let merge: AgentRun | undefined;
    let mergeCheck: { rule: string; ok: boolean }[] = [];
    if (good.length && !abort.signal.aborted) {
      const sumVerified = good.reduce((a, r) => a + r.total, 0);
      const top = good.reduce((a, r) => (r.total > a.total ? r : a));
      merge = await runAgent("merge", "aggregator", `Verified regional results (JSON): ${JSON.stringify(good.map(({ region, total, best }) => ({ region, total, best })))}\nComputed by the code: the total of the verified regions is ${sumVerified.toLocaleString("en-US")} units; the top region is ${top.region} (${top.total.toLocaleString("en-US")}).\nRegions without a verified result: ${failed.join(", ") || "none"}.\nWrite a 3-line summary: 1) the total, naming EVERY verified region; 2) the top region; 3) which regions are missing. Use the numbers above exactly; do not compute anything.`, laneOptions("fo-merge", abort, { maxTurns: 2 }), emit);
      const text = merge.text;
      const has = (n: number) => text.includes(n.toLocaleString("en-US")) || text.includes(String(n));
      mergeCheck = [
        { rule: `states the total ${sumVerified.toLocaleString("en-US")}`, ok: has(sumVerified) },
        { rule: `names the top region (${top.region})`, ok: new RegExp(`\\b${top.region}\\b`, "i").test(text) },
        ...good.map((r) => ({ rule: `names the verified region ${r.region}`, ok: new RegExp(`\\b${r.region}\\b`, "i").test(text) })),
        ...failed.map((r) => ({ rule: `says ${r} is missing`, ok: new RegExp(`\\b${r}\\b`, "i").test(text) })),
      ];
    }
    emit("verdict", { settled: settled.map((s, i) => ({ region: FANOUT_REGIONS[i], status: s.status, ...(s.status === "fulfilled" ? s.value : { error: errText(s.reason) }) })), spent: spent + (merge?.cost ?? 0), merge: merge?.text, mergeCheck });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /evaluator: a writer session and a critic with a schema, in a loop, with exact code checks next to the critic.
// ---------------------------------------------------------------------------------------------

// #region scenario-evaluator
const Verdict = z.object({ approved: z.boolean(), score: z.number().int().min(1).max(10), issues: z.array(z.string()).describe("what must change, one short item each; empty when approved") });
export const FACTS = `Quarterly units sold: north ${truth("north")!.total}, south ${truth("south")!.total}, east ${truth("east")!.total}, west ${truth("west")!.total}, central ${truth("central")!.total}. Total ${GRAND_TOTAL.toLocaleString("en-US")}. East is the top region.`;
// Split by who can judge it. A probe critic rejected a draft of exactly 60 words as "approximately 67 words": what code
// can measure is checked by code only (codeChecks), and the critic is told not to judge it.
export const RUBRIC = [
  "a sober, professional tone: no superlatives or hype words (amazing, incredible, crushing it, record-breaking…), no emojis",
  "every number matches the facts",
  "adds no fact that is not in the facts: no quarter name (Q1–Q4), no percentages, no growth claims, no comparison with earlier periods",
];

/**
 * The checks your code can do for free and exactly. The critic still runs every round (it judges what code cannot: tone,
 * hype words), but a count is code's job: in the probe the critic guessed "about 130 words" for a draft of 100.
 */
function codeChecks(draft: string) {
  const words = draft.split(/\s+/).filter(Boolean).length;
  return [
    { rule: "at most 60 words", ok: words <= 60, detail: `${words} words` },
    { rule: `mentions ${GRAND_TOTAL.toLocaleString("en-US")}`, ok: draft.includes(GRAND_TOTAL.toLocaleString("en-US")) || draft.includes(String(GRAND_TOTAL)), detail: "" },
    { rule: "names East", ok: /\beast\b/i.test(draft), detail: "" },
    { rule: "no exclamation marks", ok: !draft.includes("!"), detail: `${(draft.match(/!/g) ?? []).length} found` },
  ];
}

concept47.post(
  "/evaluator",
  sseRoute(z.object({ maxRounds: z.number().int().min(1).max(4).default(3) }).strict(), async (b, abort, lane) => {
    const emit = lane("loop");
    // The generator and the evaluator want different things: that is what makes the loop useful.
    const writer = chatSession(laneOptions("ev-writer", abort, { systemPrompt: "You are an enthusiastic marketing copywriter. You write short, punchy announcements that make people excited.", maxTurns: 2 }));
    let ask = `Write the announcement of our quarterly sales results for the company newsletter. The facts: ${FACTS}`;
    let total = 0;
    try {
      for (let round = 1; round <= b.maxRounds && !abort.signal.aborted; round++) {
        emit("agent-start", { row: `w${round}`, name: `writer · round ${round}`, depth: 1, parent: "code", prompt: clip(ask, 600) });
        const t0 = Date.now();
        const draft = await writer.ask(ask);
        total += draft.cost;
        emit("agent-end", { row: `w${round}`, status: draft.ok ? "completed" : "failed", summary: clip(draft.text, 800), cost: draft.cost, durationMs: Date.now() - t0 });
        // A loop must stop on a failure, not feed an error message to the critic as if it were a draft.
        if (!draft.ok) {
          emit("stopped", { text: `the writer failed in round ${round}: ${cut(draft.text, 200)}` });
          break;
        }
        const checks = codeChecks(draft.text);
        const failedChecks = checks.filter((c) => !c.ok);
        // The critic is a NEW query() every round: it sees only the rubric, the facts and this draft, never the earlier ones.
        const critic = await runAgent(`c${round}`, `critic · round ${round}`, `Rubric:\n${RUBRIC.map((r) => `- ${r}`).join("\n")}\n\nFacts: ${FACTS}\n\nDraft:\n"""${draft.text}"""\n\nApprove only if the draft meets EVERY rule of the rubric. Do NOT judge the length, the word count, the exclamation marks or whether it names the total and East: code checks those exactly.`, laneOptions(`ev-critic-${round}`, abort, { systemPrompt: "You are a strict corporate editor. You judge a draft against a rubric. You do not rewrite it.", outputFormat: schema(Verdict), maxTurns: 3 }), emit);
        total += critic.cost;
        const v = Verdict.safeParse(critic.structured);
        if (!v.success) {
          emit("stopped", { text: `the critic gave no valid verdict in round ${round}: ${critic.error ?? "schema"}` });
          break;
        }
        const approved = failedChecks.length === 0 && v.data.approved;
        emit("round", { n: round, draft: draft.text, checks, critic: v.data, approved, cost: draft.cost + critic.cost });
        if (approved) break;
        // The feedback goes back into the SAME writer session: it remembers its draft and the brief.
        ask = `Revise your announcement. Fix all of this:\n${[...failedChecks.map((c) => `- ${c.rule} (${c.detail || "missing"})`), ...v.data.issues.map((i) => `- ${i}`)].join("\n")}\nReply with the new announcement only.`;
        if (round < b.maxRounds) emit("feedback", { n: round, text: ask });
      }
    } finally {
      writer.close();
    }
    emit("verdict", { cost: total });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept47.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
