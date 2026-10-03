/**
 * Lesson 52 — regression baselines. A run of the suite becomes a REPORT (pass counts per case and metric, cost,
 * turns, a sample reply, and a fingerprint of what was measured and how). A report you trust is promoted to the
 * BASELINE, a file committed next to the code. Every later change is compared with it, metric by metric.
 *
 * The fingerprint has two halves, and the difference matters:
 *   harness — the judge model, the rubric, the cases. If one of these changed, the numbers are not comparable:
 *             the comparison is STALE. Re-run the baseline agent under the new harness first.
 *   sut     — the system under test: agent model, prompt, policies. These are SUPPOSED to change; the comparison
 *             tells you what the change did.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Graded, PairSide } from "./judge.js";
import { CRITERION_IDS } from "./rubric.js";
import { compareMetric, mean, RULES, type Metric, type MetricVerdict } from "./stats.js";

export type TrialRecord = {
  caseId: string;
  trial: number;
  infra?: string; // set when the run stopped for a reason that is not the agent's (no credit, network): not a data point
  checks: { name: string; pass: boolean; detail?: string }[];
  judge: Graded | null; // null: judge disabled or nothing to judge (the agent did not finish)
  reply: string;
  actions: string[];
  effects: PairSide["effects"];
  agentCostUsd: number;
  turns: number;
  ms: number;
};
export type CaseStats = { trials: number; passAll: number; metrics: Record<string, Metric>; meanCostUsd: number; meanTurns: number; judgeErrors: number; infraErrors: number; sample?: PairSide };
export type Fingerprint = { harness: { judge: string; rubric: string; cases: string }; sut: { agentModel: string; variant: string; prompt: string; policies: string } };
export type RunReport = {
  id: string;
  createdAt: string;
  variant: string;
  trials: number;
  judge: string;
  fingerprint: Fingerprint;
  cases: Record<string, CaseStats>;
  totals: { trials: number; passAll: number; agentCostUsd: number; judgeCostUsd: number; ms: number; infraErrors: number; judgeErrors: number };
  records?: TrialRecord[];
};
export type Baseline = RunReport & { promotedAt: string; note?: string };

// #region critical
/** Money and privacy checks are gates: they must pass on EVERY trial, no statistics. */
export const isCritical = (checkName: string) => /refund|leak/i.test(checkName);
// #endregion

// #region build-report
export function buildReport(meta: Omit<RunReport, "cases" | "totals" | "records">, records: TrialRecord[], ms: number): RunReport {
  const cases: Record<string, CaseStats> = {};
  for (const caseId of [...new Set(records.map((r) => r.caseId))]) {
    const all = records.filter((r) => r.caseId === caseId);
    const rs = all.filter((r) => !r.infra); // an infrastructure failure is not evidence about the agent
    const metrics: Record<string, Metric> = {};
    // A check missing from a trial (the agent crashed before it could be evaluated) counts as a failure.
    for (const name of [...new Set(rs.flatMap((r) => r.checks.map((c) => c.name)))])
      metrics[`check:${name}`] = { kind: "check", critical: isCritical(name), n: rs.length, k: rs.filter((r) => r.checks.some((c) => c.name === name && c.pass)).length };
    // A judge error is NOT an agent failure: those trials are left out of the judge metrics' n.
    const judged = rs.filter((r) => r.judge?.ok);
    if (judged.length)
      for (const id of CRITERION_IDS) metrics[`judge:${id}`] = { kind: "judge", n: judged.length, k: judged.filter((r) => r.judge?.ok && r.judge.verdict[id].pass).length };
    const passed = (r: TrialRecord) => r.checks.every((c) => c.pass) && (!r.judge?.ok || CRITERION_IDS.every((id) => (r.judge as any).verdict[id].pass));
    const good = rs.find((r) => r.reply && passed(r)) ?? rs.find((r) => r.reply);
    cases[caseId] = {
      trials: rs.length,
      passAll: rs.filter(passed).length,
      metrics,
      meanCostUsd: mean(rs.map((r) => r.agentCostUsd)),
      meanTurns: mean(rs.map((r) => r.turns)),
      judgeErrors: rs.filter((r) => r.judge && !r.judge.ok).length,
      infraErrors: all.length - rs.length,
      sample: good && { reply: good.reply, actions: good.actions, effects: good.effects },
    };
  }
  const valid = records.filter((r) => !r.infra);
  return {
    ...meta,
    cases,
    totals: {
      trials: valid.length,
      passAll: Object.values(cases).reduce((s, c) => s + c.passAll, 0),
      agentCostUsd: valid.reduce((s, r) => s + r.agentCostUsd, 0),
      judgeCostUsd: records.reduce((s, r) => s + (r.judge?.costUsd ?? 0), 0),
      ms,
      infraErrors: records.length - valid.length,
      judgeErrors: records.filter((r) => r.judge && !r.judge.ok).length,
    },
    records,
  };
}
// #endregion

export type Row = { caseId: string; metric: string; kind: "check" | "judge"; critical: boolean; base?: Metric; cand?: Metric; verdict: MetricVerdict; p?: number; delta?: number };
export type Comparison = {
  verdict: "pass" | "fail" | "stale" | "error";
  stale: string[];
  changed: string[];
  warnings: string[];
  rows: Row[];
  counts: Record<MetricVerdict, number>;
  cost: { base: number; cand: number; deltaPct: number; over: boolean };
  reliability: { caseId: string; base: string; cand: string }[];
  rules: typeof RULES & { costBudgetPct: number };
};

// #region compare
export const COST_BUDGET_PCT = 50; // mean agent cost per trial may grow at most this much
export const MAX_LOST_SHARE = 0.2; // above this share of lost trials (infra + judge errors) the run is an "error"

export function compare(base: RunReport, cand: RunReport): Comparison {
  const fb = base.fingerprint, fc = cand.fingerprint;
  const stale: string[] = [];
  const warnings: string[] = [];
  if (fb.harness.cases !== fc.harness.cases) stale.push(`cases changed (${fb.harness.cases} → ${fc.harness.cases})`);
  if (cand.judge === "none") warnings.push("This run has no judge: only the code checks were compared.");
  else {
    if (fb.harness.rubric !== fc.harness.rubric) stale.push(`rubric changed (${fb.harness.rubric} → ${fc.harness.rubric})`);
    if (fb.harness.judge !== fc.harness.judge) stale.push(`judge changed (${fb.harness.judge} → ${fc.harness.judge})`);
  }
  if (cand.trials < 3) warnings.push(`Only ${cand.trials} trial(s) per case: only a large break can be significant.`);
  const changed = (Object.keys(fb.sut) as (keyof Fingerprint["sut"])[]).filter((k) => fb.sut[k] !== fc.sut[k]).map((k) => `${k}: ${fb.sut[k]} → ${fc.sut[k]}`);

  const rows: Row[] = [];
  for (const caseId of [...new Set([...Object.keys(base.cases), ...Object.keys(cand.cases)])]) {
    const bm = base.cases[caseId]?.metrics ?? {}, cm = cand.cases[caseId]?.metrics ?? {};
    for (const metric of [...new Set([...Object.keys(bm), ...Object.keys(cm)])]) {
      if (metric.startsWith("judge:") && cand.judge === "none") continue;
      const b = bm[metric], c = cm[metric];
      rows.push({ caseId, metric, kind: (b ?? c)!.kind, critical: !!(b ?? c)!.critical, base: b, cand: c, ...compareMetric(b, c) });
    }
  }
  const counts = Object.fromEntries((["gate-fail", "regression", "suspect", "improved", "stable", "new", "missing"] as MetricVerdict[]).map((v) => [v, rows.filter((r) => r.verdict === v).length])) as Comparison["counts"];
  const perTrial = (r: RunReport) => r.totals.agentCostUsd / Math.max(1, r.totals.trials);
  const cost = { base: perTrial(base), cand: perTrial(cand), deltaPct: 0, over: false };
  cost.deltaPct = cost.base ? ((cost.cand - cost.base) / cost.base) * 100 : 0;
  cost.over = cost.deltaPct > COST_BUDGET_PCT;
  const reliability = Object.keys(cand.cases).filter((caseId) => cand.cases[caseId].trials).map((caseId) => ({
    caseId,
    base: base.cases[caseId] ? `${base.cases[caseId].passAll}/${base.cases[caseId].trials}` : "—",
    cand: `${cand.cases[caseId].passAll}/${cand.cases[caseId].trials}`,
  }));
  // Too many runs that measured nothing (no credit, judge failures): the comparison is not evidence either way.
  const lost = cand.totals.infraErrors + cand.totals.judgeErrors;
  const broken = lost > MAX_LOST_SHARE * (cand.totals.trials + cand.totals.infraErrors);
  if (lost) warnings.unshift(`${cand.totals.infraErrors} trial(s) lost to infrastructure errors, ${cand.totals.judgeErrors} judge error(s).`);
  const failed = counts["gate-fail"] + counts.regression > 0 || cost.over;
  if (counts.missing) warnings.push(`${counts.missing} metric(s) have no candidate measurement; rerun before accepting the change.`);
  const verdict = stale.length ? "stale" : broken || counts.missing > 0 || !rows.length ? "error" : failed ? "fail" : "pass";
  return { verdict, stale, changed, warnings, rows, counts, cost, reliability, rules: { ...RULES, costBudgetPct: COST_BUDGET_PCT } };
}
// #endregion

// #region files
export const BASELINE_FILE = path.resolve("evals/baseline.json"); // committed with the code it measures
export const RUNS_DIR = path.resolve("eval-lab/runs"); // scratch: every run, git-ignored

/** Recover completed runs after the development server restarts, without accepting file paths from clients. */
export function loadRun(id: string, dir = RUNS_DIR): RunReport | undefined {
  if (!/^[\w-]{1,120}$/.test(id)) return undefined;
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  const run = JSON.parse(readFileSync(file, "utf8")) as RunReport;
  if (run.id !== id || !run.cases || !run.totals || !run.fingerprint) throw new Error("Invalid saved eval report.");
  return run;
}

export function promotionError(run: RunReport): string | undefined {
  if (run.judge === "none" || run.trials < 3) return "A baseline needs a judge and at least 3 trials per case.";
  if (!run.totals.trials || run.totals.infraErrors || run.totals.judgeErrors || !Object.keys(run.cases).length || Object.values(run.cases).some((c) => c.trials < 3 || !Object.entries(c.metrics).some(([id, m]) => id.startsWith("judge:") && m.n >= 3)))
    return "Cannot promote a run with missing measurements, infrastructure failures or judge errors. Review the trial errors and rerun the suite.";
}

export function loadBaseline(file = BASELINE_FILE): Baseline | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveBaseline(run: RunReport, note?: string, file = BASELINE_FILE): Baseline {
  const problem = promotionError(run);
  if (problem) throw new Error(problem);
  const { records: _drop, ...rest } = run; // the baseline keeps the numbers and one sample per case, not every transcript
  const baseline: Baseline = { ...rest, promotedAt: new Date().toISOString(), ...(note && { note }) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}

export function saveRun(run: RunReport, dir = RUNS_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
}
// #endregion
