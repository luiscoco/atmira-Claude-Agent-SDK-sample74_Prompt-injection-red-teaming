/**
 * Lesson 52 — the small amount of statistics an eval suite needs. Pure functions, unit-tested offline.
 *
 * An agent eval is a measurement of a random process. "It passed" means "it passed this time". So a suite runs each
 * case several times and compares PASS RATES, and the comparison must say how sure it is: 3/3 → 2/3 can be noise;
 * 5/5 → 0/3 is not.
 */

/** Wilson score interval for k successes out of n (default 95%). Better than k/n ± … for small n and rates near 0/1. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const logFact = (() => {
  const cache = [0];
  return (n: number) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();
const logChoose = (n: number, k: number) => logFact(n) - logFact(k) - logFact(n - k);

// #region fisher
/**
 * One-sided Fisher exact test: the probability of seeing the candidate do this badly (or worse) if candidate and
 * baseline had the same true pass rate. Exact, so it is valid for the tiny n of an agent suite (3-10 trials).
 */
export function fisherWorse(kBase: number, nBase: number, kCand: number, nCand: number): number {
  const N = nBase + nCand;
  const K = kBase + kCand; // total passes
  const lo = Math.max(0, nCand - (N - K));
  let p = 0;
  for (let x = lo; x <= kCand; x++) p += Math.exp(logChoose(K, x) + logChoose(N - K, nCand - x) - logChoose(N, nCand));
  return Math.min(1, p);
}
// #endregion

export type Metric = { k: number; n: number; kind: "check" | "judge"; critical?: boolean };
export type MetricVerdict = "gate-fail" | "regression" | "suspect" | "improved" | "stable" | "new" | "missing";

// #region compare-metric
export const RULES = { tolerance: 0.2, alpha: 0.1 };

/**
 * One metric, baseline vs candidate.
 *   critical (money, privacy): ANY failure fails the gate. No statistics: one wrong refund is one too many.
 *   everything else: a drop of at least `tolerance` that is unlikely to be noise (Fisher p < alpha) is a regression;
 *   the same drop without significance is only "suspect": rerun with more trials before you believe it.
 */
export function compareMetric(base: Metric | undefined, cand: Metric | undefined, rules = RULES): { verdict: MetricVerdict; p?: number; delta?: number } {
  if (cand && cand.critical && cand.n > 0 && cand.k < cand.n) return { verdict: "gate-fail", delta: base ? cand.k / cand.n - base.k / base.n : undefined };
  if (!cand || cand.n === 0) return { verdict: "missing" };
  if (!base || base.n === 0) return { verdict: "new" };
  const delta = cand.k / cand.n - base.k / base.n;
  if (delta <= -rules.tolerance) {
    const p = fisherWorse(base.k, base.n, cand.k, cand.n);
    return { verdict: p < rules.alpha ? "regression" : "suspect", p, delta };
  }
  if (delta >= rules.tolerance) {
    const p = fisherWorse(cand.k, cand.n, base.k, base.n); // the same test, the other way round
    return { verdict: p < rules.alpha ? "improved" : "stable", p, delta };
  }
  return { verdict: "stable", delta };
}
// #endregion

// #region kappa
/**
 * Agreement between the judge and the human labels on binary verdicts. Raw agreement flatters a judge when most
 * labels are "pass" (a judge that always says pass agrees 80% of the time on an 80%-pass set). Cohen's kappa
 * subtracts the agreement expected by chance: 0 = no better than chance, 1 = perfect.
 */
export function agreement(pairs: { human: boolean; judge: boolean }[]) {
  const n = pairs.length;
  const tp = pairs.filter((p) => p.human && p.judge).length; // both pass
  const tn = pairs.filter((p) => !p.human && !p.judge).length; // both fail
  const lenient = pairs.filter((p) => !p.human && p.judge).length; // judge passed what a human failed: the dangerous one
  const harsh = pairs.filter((p) => p.human && !p.judge).length; // judge failed what a human passed: noisy, safe
  if (n === 0) return { n, agreement: 0, kappa: 0, tp, tn, lenient, harsh };
  const po = (tp + tn) / n;
  const humanPass = (tp + harsh) / n;
  const judgePass = (tp + lenient) / n;
  const pe = humanPass * judgePass + (1 - humanPass) * (1 - judgePass);
  return { n, agreement: po, kappa: pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe), tp, tn, lenient, harsh };
}
// #endregion

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
