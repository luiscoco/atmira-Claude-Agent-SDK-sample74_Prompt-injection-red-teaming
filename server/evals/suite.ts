/**
 * Lesson 52 — the live suite: the capstone's five cases × N trials, each graded twice — by the cases' own code checks
 * (effects, tools) and by the LLM judge (the qualities code cannot see) — and folded into a RunReport.
 *
 * The VARIANTS are the "pull requests" the suite has to judge. Each one changes only the system prompt:
 *   baseline     the capstone as shipped
 *   no-act-now   drops the rule "do what the policy says in this same reply" → code checks should catch it (tickets)
 *   cold-tone    terse, no empathy, no next steps                            → only the judge can catch it
 *   reassure     "tell them their money is on the way"                        → dishonest replies, maybe a wrong refund
 *   fix-findings fixes what the judge found in the baseline                   → should IMPROVE, with no regression
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ensureWorkspace, MODEL, POLICIES, systemPrompt } from "../capstone/agent.js";
import { CASES, runCase } from "../capstone/evals.js";
import { seed, Store } from "../capstone/store.js";
import { buildReport, type Fingerprint, type RunReport, type TrialRecord } from "./baseline.js";
import { pool } from "./calibration.js";
import { grade, heuristicJudge, liveJudge, type JudgeCall, type JudgeName } from "./judge.js";
import { rubricHash, type JudgeInput } from "./rubric.js";

// #region variants
const ACT_NOW = /\n- Then DO what the policy says[^\n]*/;
export const VARIANTS = {
  baseline: { title: "Baseline (the capstone as shipped)", expect: "Matches the baseline.", transform: (p: string) => p },
  "no-act-now": { title: "Drop the “act in this same reply” rule", expect: "Tickets go missing: the code checks fail (as in lesson 50's first runs).", transform: (p: string) => p.replace(ACT_NOW, "") },
  "cold-tone": {
    title: "Cold tone: terse, no empathy, no next steps",
    expect: "All code checks still pass. Only the judge sees the regression (empathy, next steps).",
    transform: (p: string) => `${p}\n\nStyle override: answer in ONE short factual sentence. Never apologise, never acknowledge feelings, and do not explain what happens next.`,
  },
  reassure: {
    title: "Reassure: “tell them their money is on the way”",
    expect: "Replies promise refunds that did not happen (judge: honest outcome), or the agent refunds too early (gate).",
    transform: (p: string) => `${p}\n- Customers hate waiting: whenever they ask for money back, reassure them that their refund is on its way.`,
  },
  "fix-findings": {
    title: "Fix what the judge found in the baseline",
    expect: "Grounded and empathy improve (no invented refund times, problems acknowledged) with no code-check regressions.",
    transform: (p: string) =>
      `${p}\n- State only facts from the tools or the policy: never invent dates, delivery or refund times. If the customer will ask "when?", say who will follow up instead.` +
      "\n- When the customer reports a problem (broken, faulty, late), first acknowledge it in a few words." +
      "\n- A ticket is not a refund: never promise the outcome of a decision someone else will make.",
  },
} as const;
export type VariantId = keyof typeof VARIANTS;
// #endregion

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const promptOf = (v: VariantId) => VARIANTS[v].transform(systemPrompt(new Store(), "C-1")).replace(/Today is \d{4}-\d{2}-\d{2}/, "Today is <date>");
const caseOrder = (id: string) => CASES.findIndex((c) => c.id === id);
export const casesHash = () => hash(JSON.stringify(CASES.map((c) => [c.id, c.customerId, c.prompt, c.checks.toString()])));

export const fingerprintFor = (variant: VariantId, judgeModel: string): Fingerprint => ({
  harness: { judge: judgeModel, rubric: rubricHash(), cases: casesHash() },
  sut: { agentModel: MODEL, variant, prompt: hash(promptOf(variant)), policies: hash(JSON.stringify(POLICIES)) },
});

// Started from inside Claude Code, the server inherits CLAUDECODE / CLAUDE_CODE_* variables (Concept 49): drop them.
export const agentEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDECODE|^CLAUDE_CODE_/.test(k))) as Record<string, string>;
export const WORKSPACE = path.resolve("capstone-lab/workspace");

export function judgeFor(name: JudgeName): JudgeCall {
  if (name === "heuristic") return heuristicJudge;
  ensureWorkspace(WORKSPACE);
  return liveJudge(name, agentEnv(), WORKSPACE);
}

export type SuiteEvent = (event: string, data: object) => void;

// #region run-suite
export async function runSuite(o: { variant: VariantId; trials: number; judge: JudgeName | "none"; signal: AbortSignal; emit?: SuiteEvent; judgeCall?: JudgeCall; concurrency?: number }): Promise<RunReport> {
  ensureWorkspace(WORKSPACE);
  const emit = o.emit ?? (() => {});
  const call = o.judge === "none" ? undefined : (o.judgeCall ?? judgeFor(o.judge));
  const transform = VARIANTS[o.variant].transform;
  const tweak = (opts: Options): Options => ({ ...opts, systemPrompt: transform(opts.systemPrompt as string) });
  const data = seed();
  const jobs = CASES.flatMap((c) => Array.from({ length: o.trials }, (_, t) => ({ c, trial: t + 1 })));
  const records: TrialRecord[] = [];
  const t0 = Date.now();

  await pool(jobs, o.concurrency ?? 5, async ({ c, trial }) => {
    if (o.signal.aborted) return;
    emit("trial-start", { caseId: c.id, trial });
    const r = await runCase(c, WORKSPACE, agentEnv(), o.signal, (_e, d: any) => emit("tool", { caseId: c.id, trial, name: d.name, agent: d.agent }), tweak);
    const actions = r.tools.map((t) => `${t.agent} ${t.name.replace("mcp__desk__", "")} ${JSON.stringify(t.input)}${t.result ? ` → ${t.result}` : ""}`);
    const effects = {
      // Give the judge every fact the agent saw: without the refund id, "your reference is R-1" looked invented.
      refunds: r.refunds.map((x) => ({ id: x.id, orderId: x.orderId, amountCents: x.amountCents, approvedBy: x.approvedBy })),
      tickets: r.tickets.map((x) => ({ id: x.id, priority: x.priority, subject: x.subject })),
    };
    const finished = r.checks[0]?.pass;
    // The agent running out of turns or budget is the agent's failure. Anything else that stops a run (no credit, a
    // network error, an exception) says nothing about the agent: that trial is infrastructure, not a data point.
    const infra = finished ? undefined : /^error_max/.test(r.checks[0]?.detail ?? "") ? undefined : (r.checks[0]?.detail || "no result");
    let judge: TrialRecord["judge"] = null;
    if (call && finished && r.reply && !o.signal.aborted) {
      const customer = data.customers.find((x) => x.id === c.customerId)!;
      const input: JudgeInput = {
        customer: `${customer.name} (${customer.id})`, message: c.prompt, reply: r.reply,
        orders: data.orders.filter((x) => x.customerId === c.customerId), actions, effects, policies: POLICIES,
      };
      judge = await grade(call, input, o.signal);
    }
    const rec: TrialRecord = { caseId: c.id, trial, ...(infra && { infra }), checks: r.checks, judge, reply: r.reply, actions, effects, agentCostUsd: r.costUsd ?? 0, turns: r.turns ?? 0, ms: r.ms };
    records.push(rec);
    emit("trial-end", rec);
  });

  const judgeModel = o.judge === "none" ? "none" : (records.find((r) => r.judge?.ok)?.judge?.model ?? o.judge);
  return buildReport(
    {
      id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${o.variant}-${randomUUID().slice(0, 4)}`,
      createdAt: new Date().toISOString(),
      variant: o.variant,
      trials: o.trials,
      judge: o.judge,
      fingerprint: fingerprintFor(o.variant, judgeModel),
    },
    records.sort((a, b) => caseOrder(a.caseId) - caseOrder(b.caseId) || a.trial - b.trial),
    Date.now() - t0,
  );
}
// #endregion
