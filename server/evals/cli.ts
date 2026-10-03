/**
 * Lesson 52 — the suite as a CI step.
 *
 *   npm run eval -- --variant cold-tone --trials 3 --judge sonnet        compare with evals/baseline.json
 *   npm run eval -- --trials 5 --update-baseline --note "after #123"      re-baseline (do it on purpose, in its own commit)
 *   npm run eval -- --demo cold-tone                                      offline: synthetic runs, no model calls
 *
 * Exit codes: 0 pass · 1 regression or gate failure · 2 stale baseline / no baseline / infrastructure error.
 * With GITHUB_STEP_SUMMARY set (GitHub Actions), the Markdown report is appended to the job summary.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compare, loadBaseline, saveBaseline, saveRun, type Comparison, type RunReport } from "./baseline.js";
import { syntheticReport } from "./demo.js";
import { runSuite, VARIANTS, type VariantId } from "./suite.js";

// #region cli
const { values: a } = parseArgs({
  options: {
    variant: { type: "string", default: "baseline" },
    trials: { type: "string", default: "3" },
    judge: { type: "string", default: "sonnet" },
    "update-baseline": { type: "boolean", default: false },
    note: { type: "string" },
    demo: { type: "string" },
    json: { type: "string" },
  },
});

async function main(): Promise<number> {
  if (a.demo) {
    const v = a.demo as VariantId;
    if (!(v in VARIANTS)) return fail(`unknown variant ${v}`);
    const cmp = compare(syntheticReport("baseline"), syntheticReport(v));
    report(cmp, syntheticReport(v));
    return cmp.verdict === "pass" ? 0 : cmp.verdict === "fail" ? 1 : 2;
  }
  const variant = a.variant as VariantId;
  const trials = Number(a.trials);
  if (!(variant in VARIANTS)) return fail(`unknown variant ${variant} (${Object.keys(VARIANTS).join(", ")})`);
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) return fail("--trials must be 1-10");
  if (!["sonnet", "haiku", "heuristic", "none"].includes(a.judge!)) return fail("--judge must be sonnet, haiku, heuristic or none");

  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  console.error(`Running ${variant}: 5 cases × ${trials} trials, judge ${a.judge}…`);
  const run = await runSuite({
    variant, trials, judge: a.judge as any, signal: abort.signal,
    emit: (e, d: any) => e === "trial-end" && console.error(`  ${d.caseId} #${d.trial} ${d.checks.every((c: any) => c.pass) ? "checks ok" : "CHECK FAIL"}${d.judge ? (d.judge.ok ? "" : " (judge error)") : ""}`),
  });
  saveRun(run);
  if (a.json) writeFileSync(a.json, JSON.stringify(run, null, 2));
  console.error(`agent $${run.totals.agentCostUsd.toFixed(4)} · judge $${run.totals.judgeCostUsd.toFixed(4)} · ${(run.totals.ms / 1000).toFixed(0)} s`);

  if (a["update-baseline"]) {
    if (run.judge === "none" || trials < 3) return fail("a baseline needs a judge and at least 3 trials");
    saveBaseline(run, a.note);
    console.log(`Baseline updated: ${run.id} (${run.totals.passAll}/${run.totals.trials} trials fully passing). Commit evals/baseline.json.`);
    return 0;
  }
  const base = loadBaseline();
  if (!base) return fail("no evals/baseline.json: run with --update-baseline first");
  const cmp = compare(base, run);
  report(cmp, run);
  return cmp.verdict === "pass" ? 0 : cmp.verdict === "fail" ? 1 : 2;
}
// #endregion

function report(cmp: Comparison, run: RunReport) {
  const fmt = (m?: { k: number; n: number }) => (m ? `${m.k}/${m.n}` : "—");
  const notable = cmp.rows.filter((r) => r.verdict !== "stable");
  const md = [
    `## Agent evals: ${cmp.verdict.toUpperCase()} (${run.variant}, ${run.trials} trials/case, judge ${run.fingerprint.harness.judge})`,
    ...cmp.stale.map((s) => `- **stale baseline:** ${s}`),
    ...cmp.warnings.map((w) => `- ${w}`),
    cmp.changed.length ? `- changed under test: ${cmp.changed.join("; ")}` : "- nothing changed under test",
    `- cost per trial: $${cmp.cost.base.toFixed(4)} → $${cmp.cost.cand.toFixed(4)} (${cmp.cost.deltaPct >= 0 ? "+" : ""}${cmp.cost.deltaPct.toFixed(0)}%, budget +${cmp.rules.costBudgetPct}%)`,
    "",
    "| case | metric | baseline | candidate | p | verdict |",
    "|---|---|---|---|---|---|",
    ...notable.map((r) => `| ${r.caseId} | ${r.metric}${r.critical ? " 🔒" : ""} | ${fmt(r.base)} | ${fmt(r.cand)} | ${r.p === undefined ? "" : r.p.toFixed(3)} | ${r.verdict} |`),
    notable.length ? "" : "_every metric stable_",
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

function fail(msg: string) {
  console.error(`eval: ${msg}`);
  return 2;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
