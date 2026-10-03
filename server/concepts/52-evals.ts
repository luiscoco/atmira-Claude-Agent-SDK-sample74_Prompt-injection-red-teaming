/**
 * Lesson 52 — Evals in depth: LLM-as-judge and regression baselines. The HTTP layer over server/evals/.
 *
 * Routes: GET /facts, GET /baseline, POST /demo (offline), POST /calibrate (SSE), POST /run (SSE),
 *         POST /promote, POST /pairwise (SSE), GET /code.
 * Live routes call the model (the support agent on Haiku, the judge on Sonnet or Haiku). /demo and the heuristic
 * judge make no model calls.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { MODEL, POLICIES } from "../capstone/agent.js";
import { CASES } from "../capstone/evals.js";
import { seed } from "../capstone/store.js";
import { openSse } from "../sse.js";
import { compare, loadBaseline, loadRun, promotionError, saveBaseline, saveRun, type RunReport } from "../evals/baseline.js";
import { calibrate, GOLDEN, TRUST, trusted } from "../evals/calibration.js";
import { syntheticReport } from "../evals/demo.js";
import { JUDGE_MODELS, pairwise } from "../evals/judge.js";
import { CRITERIA, JUDGE_SYSTEM, RUBRIC_VERSION, VERDICT_SCHEMA } from "../evals/rubric.js";
import { RULES } from "../evals/stats.js";
import { judgeFor, runSuite, VARIANTS, type VariantId } from "../evals/suite.js";

export const concept52 = Router();

const Variant = z.enum(Object.keys(VARIANTS) as [VariantId, ...VariantId[]]);
const Judge = z.enum(["sonnet", "haiku", "heuristic"]);
const runs = new Map<string, RunReport>(); // this server's runs, newest last (also saved under eval-lab/runs/)
let busy = false; // one live job at a time: they are parallel inside, and they cost money

const strip = (r: RunReport) => ({ ...r, records: r.records?.map(({ actions: _a, effects: _e, ...rest }) => rest) });
const bad = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** An SSE route with a body schema and the single-job lock. */
function live<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, signal: AbortSignal, send: (e: string, d: unknown) => void) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: bad(parsed.error) });
    if (busy) return res.status(409).json({ error: "Another eval job is running. Wait for it or stop it." });
    busy = true;
    const { abort, send } = openSse(req, res);
    try {
      await body(parsed.data, abort.signal, (e, d) => !abort.signal.aborted && send(e, d));
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: String((err as Error)?.message ?? err).slice(0, 500) });
    } finally {
      busy = false;
      send("done", {});
      res.end();
    }
  };
}

const baselineSummary = () => {
  const b = loadBaseline();
  return b && { id: b.id, variant: b.variant, trials: b.trials, promotedAt: b.promotedAt, note: b.note, fingerprint: b.fingerprint, totals: b.totals, synthetic: b.createdAt === "synthetic" };
};

concept52.get("/facts", (_req, res) => {
  const data = seed();
  res.json({
    agentModel: MODEL,
    judges: { sonnet: `${JUDGE_MODELS.sonnet}: default judge`, haiku: `${JUDGE_MODELS.haiku}: cheaper; calibrate first`, heuristic: "keyword rules: free, no model call" },
    criteria: CRITERIA,
    rubricVersion: RUBRIC_VERSION,
    judgeSystem: JUDGE_SYSTEM,
    verdictSchema: VERDICT_SCHEMA,
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, { title: v.title, expect: v.expect }])),
    cases: CASES.map((c) => ({ id: c.id, title: c.title, prompt: c.prompt, customer: data.customers.find((x) => x.id === c.customerId)!.name })),
    golden: GOLDEN.map((g) => ({ id: g.id, message: g.message, reply: g.reply, human: g.human, note: g.note, effects: g.effects })),
    trust: TRUST,
    rules: RULES,
    baseline: baselineSummary() ?? null,
    commands: ["npm run eval -- --demo cold-tone", "npm run eval -- --variant cold-tone --trials 3", "npm run eval -- --trials 5 --update-baseline --note \"why\""],
  });
});

concept52.get("/baseline", (_req, res) => {
  const b = loadBaseline();
  b ? res.json(b) : res.status(404).json({ error: "No evals/baseline.json yet." });
});

// #region demo-route
/** Offline: the baseline and a variant as synthetic runs, through the real buildReport() + compare(). */
concept52.post("/demo", (req, res) => {
  const b = z.object({ variant: Variant }).strict().safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: bad(b.error) });
  const baseline = syntheticReport("baseline");
  const candidate = syntheticReport(b.data.variant);
  res.json({ baseline: strip(baseline), candidate: strip(candidate), comparison: compare(baseline, candidate), modelCalls: 0 });
});
// #endregion

// #region calibrate-route
concept52.post(
  "/calibrate",
  live(z.object({ judge: Judge }).strict(), async (b, signal, send) => {
    send("start", { judge: b.judge, items: GOLDEN.length });
    const summary = await calibrate(judgeFor(b.judge), signal, (item) => send("item", item));
    send("summary", { ...summary, trusted: trusted(summary), trust: TRUST });
  }),
);
// #endregion

// #region run-route
concept52.post(
  "/run",
  live(z.object({ variant: Variant, trials: z.number().int().min(1).max(5), judge: z.enum(["sonnet", "haiku", "heuristic", "none"]) }).strict(), async (b, signal, send) => {
    send("start", { ...b, jobs: CASES.length * b.trials });
    const run = await runSuite({ ...b, signal, emit: (e, d: any) => send(e, e === "trial-end" ? { ...d, actions: undefined, effects: undefined } : d) });
    if (signal.aborted) return;
    runs.set(run.id, run);
    saveRun(run);
    const base = loadBaseline();
    send("report", strip(run));
    send("comparison", base ? { baselineId: base.id, ...compare(base, run) } : { missing: true });
  }),
);

concept52.post("/promote", (req, res) => {
  const b = z.object({ runId: z.string().max(120), note: z.string().trim().max(200).optional() }).strict().safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: bad(b.error) });
  const run = runs.get(b.data.runId) ?? loadRun(b.data.runId);
  if (!run) return res.status(404).json({ error: "This run is no longer available. Run the live suite again." });
  const problem = promotionError(run);
  if (problem) return res.status(409).json({ error: problem });
  const baseline = saveBaseline(run, b.data.note);
  res.json({ ok: true, baseline: { id: baseline.id, promotedAt: baseline.promotedAt } });
});
// #endregion

// #region pairwise-route
concept52.post(
  "/pairwise",
  live(z.object({ runId: z.string().max(120), caseId: z.string().max(40), judge: Judge }).strict(), async (b, signal, send) => {
    const base = loadBaseline();
    const run = runs.get(b.runId) ?? loadRun(b.runId);
    const c = CASES.find((x) => x.id === b.caseId);
    const baseSide = base?.cases[b.caseId]?.sample, candSide = run?.cases[b.caseId]?.sample;
    if (!c) throw new Error("Unknown eval case.");
    if (!run) throw new Error("This run is no longer available. Run the live suite again.");
    if (!candSide?.reply) throw new Error(`No candidate reply for ${b.caseId}. ${run.records?.find((r) => r.caseId === b.caseId)?.infra ?? "Review the failed trials and rerun."}`);
    if (!baseSide?.reply) throw new Error(`The stored baseline has no reply for ${b.caseId}. Resolve the live-run errors and promote a measured run first.`);
    const data = seed();
    const customer = data.customers.find((x) => x.id === c.customerId)!;
    send("sides", { baseline: baseSide.reply, candidate: candSide.reply, baselineVariant: base!.variant, candidateVariant: run!.variant });
    const out = await pairwise(judgeFor(b.judge), { customer: `${customer.name} (${customer.id})`, message: c.prompt, orders: data.orders.filter((o) => o.customerId === c.customerId), policies: POLICIES }, baseSide, candSide, signal);
    send("outcome", out);
  }),
);
// #endregion

const SOURCES = ["rubric.ts", "judge.ts", "calibration.ts", "stats.ts", "baseline.ts", "suite.ts", "cli.ts"].map((f) => path.resolve("server/evals", f)).concat(fileURLToPath(import.meta.url));
concept52.get("/code", (_req, res) => {
  const out: Record<string, string> = {};
  for (const file of SOURCES) {
    const tag = path.basename(file).replace(/\.\w+$/, "").replace(/^52-evals$/, "route");
    const src = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    for (const [, name, c] of src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)) out[`${tag}:${name}`] = c.trimEnd();
  }
  res.json(out);
});
