/**
 * Lesson 52 — synthetic runs, so the comparison can be explored (and unit-tested) with zero model calls. They go
 * through the same buildReport() and compare() as a live run; only the trial records are made up, with failure
 * patterns typical of each variant.
 */
import { CASES } from "../capstone/evals.js";
import { seed } from "../capstone/store.js";
import { buildReport, type RunReport, type TrialRecord } from "./baseline.js";
import { CRITERION_IDS, type CriterionId } from "./rubric.js";
import { fingerprintFor, type VariantId } from "./suite.js";

/** The check names of each case, read from the cases themselves (they are closures; call them on an empty run). */
const checkNames = (caseId: string) => ["finished (result success)", ...CASES.find((c) => c.id === caseId)!.checks({ tools: [], reply: "", data: seed(), result: {} }).map((k) => k.name)];

type Fail = { caseId: string; metric: string; trials: number[] }; // metric: a check name or a criterion id
const SPECS: Record<VariantId, { trials: number; cost: number; fails: Fail[] }> = {
  // Shaped like the real baseline in evals/baseline.json: code checks green, the judge finds invented refund times
  // (grounded), curt replies to problems (empathy) and a supervisor "who will process your refund" (honest_outcome).
  baseline: {
    trials: 5, cost: 0.011,
    fails: [
      { caseId: "status", metric: "grounded", trials: [2, 4] },
      { caseId: "damaged", metric: "grounded", trials: [1, 2, 3, 4, 5] },
      { caseId: "damaged", metric: "empathy", trials: [1, 2, 3, 4, 5] },
      { caseId: "over-limit", metric: "empathy", trials: [1, 2, 3, 4, 5] },
      { caseId: "over-limit", metric: "honest_outcome", trials: [2, 5] },
      { caseId: "change-of-mind", metric: "grounded", trials: [1, 3, 4] },
      { caseId: "change-of-mind", metric: "empathy", trials: [5] },
    ],
  },
  "fix-findings": {
    trials: 3, cost: 0.012,
    fails: [{ caseId: "change-of-mind", metric: "grounded", trials: [2] }],
  },
  "no-act-now": {
    trials: 3, cost: 0.01,
    fails: [
      { caseId: "change-of-mind", metric: "a ticket for the returns desk", trials: [1, 2, 3] },
      { caseId: "over-limit", metric: "a high-priority ticket", trials: [1, 3] },
      { caseId: "change-of-mind", metric: "next_steps", trials: [1, 2] },
    ],
  },
  "cold-tone": {
    trials: 3, cost: 0.011,
    fails: ["status", "damaged", "over-limit", "change-of-mind"].flatMap((caseId) => [
      { caseId, metric: "empathy", trials: [1, 2, 3] },
      ...(caseId === "status" ? [] : [{ caseId, metric: "next_steps", trials: caseId === "damaged" ? [1, 3] : [1, 2, 3] }]),
    ]),
  },
  reassure: {
    trials: 3, cost: 0.014,
    fails: [
      { caseId: "change-of-mind", metric: "no refund yet", trials: [2] },
      { caseId: "over-limit", metric: "honest_outcome", trials: [1, 2, 3] },
      { caseId: "change-of-mind", metric: "honest_outcome", trials: [1, 3] },
    ],
  },
};

export function syntheticReport(variant: VariantId, judgeModel = "claude-sonnet (synthetic)"): RunReport {
  const spec = SPECS[variant];
  const failed = (caseId: string, metric: string, trial: number) => spec.fails.some((f) => f.caseId === caseId && f.metric === metric && f.trials.includes(trial));
  const records: TrialRecord[] = CASES.flatMap((c) =>
    Array.from({ length: spec.trials }, (_, i): TrialRecord => {
      const trial = i + 1;
      const verdict = Object.fromEntries(CRITERION_IDS.map((id: CriterionId) => [id, { evidence: "synthetic", pass: !failed(c.id, id, trial) }])) as any;
      return {
        caseId: c.id, trial,
        checks: checkNames(c.id).map((name) => ({ name, pass: !failed(c.id, name, trial) })),
        judge: { ok: true, verdict, model: judgeModel, costUsd: 0.006, ms: 0 },
        reply: `(synthetic ${variant} reply)`, actions: [], effects: { refunds: [], tickets: [] },
        agentCostUsd: spec.cost, turns: 5, ms: 0,
      };
    }),
  );
  return buildReport({ id: `synthetic-${variant}`, createdAt: "synthetic", variant, trials: spec.trials, judge: "sonnet", fingerprint: fingerprintFor(variant, judgeModel) }, records, 0);
}
