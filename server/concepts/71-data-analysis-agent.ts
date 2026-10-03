/**
 * CONCEPT 71 — A data-analysis agent
 *
 *   The model plans the analysis; the host computes every number.
 *   - Four read-only MCP tools (profile, aggregate, compare, chart) over a CSV parsed in code. No Bash, no code, no SQL.
 *   - Every tool result is recorded in a ledger with a computationId (C1, C2…); charts get a chartId (G1…).
 *   - outputFormat forces a JSON report whose findings cite computationIds.
 *   - verifyReport() checks each cited number against the ledger: schema-valid is not the same as true.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import {
  AnalysisLab, PolicyRejection, ReportSchema, aggregateSchema, chartSchema, compareSchema, csvText, makeAnalysisServer,
  reportJsonSchema, scriptedAnalysis, systemPrompt, tamperedReport, verifyReport,
} from "../analysis/analysis.js";

export const MODEL = "claude-haiku-4-5";
export const limits = { maxTurns: 14, maxBudgetUsd: 0.25, deadlineMs: 120_000 };
const TOOLS = ["profile_dataset", "aggregate", "compare_periods", "make_chart"] as const;

type Session = { lab: AnalysisLab; expires: number; busy: boolean };
export const concept71 = Router();
const sessions = new Map<string, Session>();

concept71.get("/facts", (_req, res) => res.json({
  systemPrompt, model: MODEL, limits, csv: csvText,
  schemas: { aggregate: z.toJSONSchema(aggregateSchema), compare_periods: z.toJSONSchema(compareSchema), make_chart: z.toJSONSchema(chartSchema), report: reportJsonSchema },
}));
concept71.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["analysis.ts", new URL("../analysis/analysis.ts", import.meta.url)],
  ["71-data-analysis-agent.ts", new URL("./71-data-analysis-agent.ts", import.meta.url)],
  ["sales.csv", new URL("../analysis/sales.csv", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));

concept71.post("/sessions", (_req, res) => {
  for (const [id, session] of sessions) if (session.expires < Date.now() && !session.busy) sessions.delete(id);
  if (sessions.size >= 50) return res.status(429).json({ message: "Lab capacity reached; try later." });
  const id = randomUUID(); const lab = new AnalysisLab();
  sessions.set(id, { lab, expires: Date.now() + 3_600_000, busy: false });
  res.json({ id, ...lab.snapshot() });
});
concept71.use("/sessions/:id", (req, res, next) => {
  const session = sessions.get(req.params.id);
  if (!session || session.expires < Date.now()) return res.status(404).json({ message: "Lab expired or missing. Start a new lab." });
  res.locals.session = session; next();
});
concept71.get("/sessions/:id", (_req, res) => res.json((res.locals.session as Session).lab.snapshot()));

// Call one tool by hand: exactly the function and validation the model gets, without a model.
// A rejected input is an exercise result (ok: false), the same message the model would read.
concept71.post("/sessions/:id/tool", (req, res) => {
  const session = res.locals.session as Session;
  const body = z.object({ name: z.enum(TOOLS), input: z.unknown() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: body.error.message });
  if (session.busy) return res.status(409).json({ message: "Wait until the agent run ends." });
  const { lab } = session; const { name, input } = body.data;
  try {
    const result = name === "profile_dataset" ? lab.profile(input ?? {}) : name === "aggregate" ? lab.aggregate(input)
      : name === "compare_periods" ? lab.compare(input) : lab.chart(input);
    res.json({ ok: true, result, ...lab.snapshot() });
  } catch (error) {
    if (error instanceof z.ZodError) return res.json({ ok: false, message: `Invalid input: ${z.prettifyError(error)}`, ...lab.snapshot() });
    if (error instanceof PolicyRejection) return res.json({ ok: false, message: error.message, ...lab.snapshot() });
    throw error;
  }
});

// Offline analyst: same tools, fixed plan. Also returns a tampered copy to feed the verifier.
concept71.post("/sessions/:id/scripted", (_req, res) => {
  const session = res.locals.session as Session;
  if (session.busy) return res.status(409).json({ message: "Wait until the agent run ends." });
  const calls: { name: string; input: unknown; result: unknown }[] = [];
  try {
    const report = scriptedAnalysis(session.lab, (name, input, result) => calls.push({ name, input, result }));
    res.json({ ok: true, calls, report, verification: verifyReport(report, session.lab), tampered: tamperedReport(report), ...session.lab.snapshot() });
  } catch (error) {
    if (error instanceof PolicyRejection) return res.json({ ok: false, message: error.message, ...session.lab.snapshot() });
    throw error;
  }
});

// Verify any report (edited by hand, tampered, or from the model) against this lab's ledger.
concept71.post("/sessions/:id/verify", (req, res) => {
  const session = res.locals.session as Session;
  const parsed = z.object({ report: ReportSchema }).strict().safeParse(req.body);
  if (!parsed.success) return res.json({ ok: false, message: `Not a valid report: ${z.prettifyError(parsed.error)}` });
  res.json({ ok: true, verification: verifyReport(parsed.data.report, session.lab) });
});

let active = false;
concept71.post("/sessions/:id/query", async (req, res) => {
  const input = z.object({ question: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: input.error.message });
  const session = res.locals.session as Session;
  if (active || session.busy) return res.status(409).json({ message: "A lesson 71 agent is already running." });
  active = true; session.busy = true;
  const { abort, send } = openSse(req, res);
  const timer = setTimeout(() => abort.abort(), limits.deadlineMs);
  let run: ReturnType<typeof query> | undefined;
  try {
    const root = fileURLToPath(new URL("../../analysis-lab/", import.meta.url));
    const work = path.join(root, "work"); mkdirSync(work, { recursive: true });
    run = query({ prompt: input.data.question, options: {
      model: MODEL, systemPrompt, thinking: { type: "disabled" },
      tools: [], // no Read, Bash or code execution: the analysis tools are the whole surface
      allowedTools: TOOLS.map((name) => `mcp__analysis__${name}`),
      mcpServers: { analysis: makeAnalysisServer(session.lab, (name, toolInput, result) => send("tool", { name, input: toolInput, result })) },
      outputFormat: { type: "json_schema", schema: reportJsonSchema },
      settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", persistSession: false,
      cwd: work, env: agentEnv(path.join(root, "config")), abortController: abort,
      maxTurns: limits.maxTurns, maxBudgetUsd: limits.maxBudgetUsd,
    } });
    let completed = false;
    for await (const message of run) {
      send("message", message);
      if (message.type !== "result") continue;
      completed = true;
      if (message.subtype !== "success") throw new Error(`Agent ended with ${message.subtype}.`);
      // The SDK validated the shape; parse again (never trust a boundary) and then check the numbers.
      const report = ReportSchema.safeParse(message.structured_output);
      send("report", report.success
        ? { report: report.data, verification: verifyReport(report.data, session.lab), costUsd: message.total_cost_usd, turns: message.num_turns }
        : { invalid: z.prettifyError(report.error), raw: message.structured_output, costUsd: message.total_cost_usd, turns: message.num_turns });
    }
    if (!completed) throw new Error("Agent ended without a result.");
  } catch (error) { if (!res.destroyed) send("error", { message: abort.signal.aborted ? "Run stopped or deadline reached." : String(error) }); }
  finally {
    clearTimeout(timer); run?.close(); session.busy = false; active = false;
    if (!res.destroyed) { send("snapshot", session.lab.snapshot()); send("done", {}); res.end(); }
  }
});
