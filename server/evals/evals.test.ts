/**
 * Lesson 52 — offline tests of the eval machinery: statistics, the comparison rules, the judge's contract and the
 * HTTP routes that need no model. The live judge itself is measured by calibration, not by unit tests.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import express from "express";
import { concept52 } from "../concepts/52-evals.js";
import { buildReport, compare, loadBaseline, loadRun, promotionError, saveBaseline, saveRun, type TrialRecord } from "./baseline.js";
import { calibrate, GOLDEN, goldenInput, summarize, trusted } from "./calibration.js";
import { syntheticReport } from "./demo.js";
import { grade, heuristicJudge, pairwise, type JudgeCall } from "./judge.js";
import { CRITERION_IDS, judgePrompt, Verdict } from "./rubric.js";
import { agreement, compareMetric, fisherWorse, wilson } from "./stats.js";
import { fingerprintFor } from "./suite.js";

const signal = new AbortController().signal;
const allPass = Object.fromEntries(CRITERION_IDS.map((id) => [id, { evidence: "ok", pass: true }]));

// #region stats-tests
describe("statistics", () => {
  test("Wilson: 3/3 is far from proof of a 100% pass rate", () => {
    const [lo, hi] = wilson(3, 3);
    assert.ok(lo < 0.5 && hi === 1);
  });
  test("Fisher: 3/3 → 0/3 is p = 0.05; 3/3 → 2/3 is noise", () => {
    assert.equal(fisherWorse(3, 3, 0, 3).toFixed(3), "0.050");
    assert.ok(fisherWorse(3, 3, 2, 3) > 0.4);
  });
  test("compareMetric: gates, regressions, suspects and improvements", () => {
    assert.equal(compareMetric({ k: 5, n: 5, kind: "check", critical: true }, { k: 2, n: 3, kind: "check", critical: true }).verdict, "gate-fail");
    assert.equal(compareMetric({ k: 5, n: 5, kind: "judge" }, { k: 0, n: 3, kind: "judge" }).verdict, "regression");
    assert.equal(compareMetric({ k: 5, n: 5, kind: "judge" }, { k: 1, n: 3, kind: "judge" }).verdict, "suspect");
    assert.equal(compareMetric({ k: 5, n: 5, kind: "judge" }, { k: 3, n: 3, kind: "judge" }).verdict, "stable");
    assert.equal(compareMetric({ k: 0, n: 5, kind: "judge" }, { k: 3, n: 3, kind: "judge" }).verdict, "improved");
    assert.equal(compareMetric(undefined, { k: 3, n: 3, kind: "judge" }).verdict, "new");
    assert.equal(compareMetric({ k: 3, n: 3, kind: "judge" }, undefined).verdict, "missing");
  });
  test("kappa: a judge that always says pass agrees 80% of the time and is worth nothing", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ human: i < 8, judge: true }));
    const a = agreement(pairs);
    assert.equal(a.agreement, 0.8);
    assert.equal(a.kappa, 0);
    assert.equal(a.lenient, 2);
  });
});
// #endregion

// #region judge-tests
describe("judge contract", () => {
  test("incomplete calibration cannot authorize a judge", () => {
    const summary = summarize([{ id: GOLDEN[0].id, graded: { ok: true, verdict: allPass as any, model: "fake", costUsd: 0, ms: 0 }, disagreements: [] }]);
    assert.equal(summary.overall.kappa, 1);
    assert.equal(trusted(summary), false);
  });
  test("malformed pairwise results are errors rather than convincing ties", async () => {
    const broken: JudgeCall = async () => ({ output: { winner: "unknown" }, model: "fake", costUsd: 0 });
    const side = { reply: "hello", actions: [], effects: { refunds: [], tickets: [] } };
    await assert.rejects(pairwise(broken, goldenInput(GOLDEN[0]), side, side, signal), /Malformed pairwise/);
  });
  test("the prompt carries the ground truth and fences the reply as data", () => {
    const g = GOLDEN.find((x) => x.id === "impersonation-good")!;
    const p = judgePrompt(goldenInput(g));
    assert.match(p, /B-2001/); // the signed-in customer's facts
    assert.doesNotMatch(p.slice(0, p.indexOf("<customer_message>")), /A-1001/); // not the other customer's
    assert.match(p, /<customer_message>\n[^<]*SYSTEM NOTE[^<]*\n<\/customer_message>/); // the injection stays inside the fence
  });
  test("a malformed verdict is a judge error, not an agent failure", async () => {
    const broken: JudgeCall = async () => ({ output: { grounded: { evidence: "x", pass: true } }, model: "fake", costUsd: 0.001 });
    const r = await grade(broken, goldenInput(GOLDEN[0]), signal);
    assert.equal(r.ok, false);
    assert.equal(Verdict.safeParse(allPass).success, true);
    assert.equal(Verdict.safeParse({ ...allPass, extra: { evidence: "", pass: true } }).success, false);
  });
  test("the keyword judge is free but misses an invented carrier (a lenient miss)", async () => {
    const s = await calibrate(heuristicJudge, signal, () => {});
    assert.equal(s.costUsd, 0);
    assert.equal(s.judgeErrors, 0);
    assert.ok(s.overall.lenient >= 1);
    assert.ok(s.perCriterion.grounded.lenient >= 1);
  });
  test("pairwise: a position-biased judge is caught by swapping the order", async () => {
    const alwaysA: JudgeCall = async () => ({ output: { reasoning: "A is first", winner: "A" }, model: "fake", costUsd: 0 });
    const fair: JudgeCall = async ({ prompt }) => ({ output: { reasoning: "kind", winner: /<reply_a>\n[^<]*sorry/i.test(prompt) ? "A" : "B" }, model: "fake", costUsd: 0 });
    const g = goldenInput(GOLDEN[0]);
    const side = (reply: string) => ({ reply, actions: [], effects: { refunds: [], tickets: [] } });
    const biased = await pairwise(alwaysA, g, side("Here it is."), side("So sorry, here it is."), signal);
    assert.equal(biased.consistent, false);
    assert.equal(biased.winner, "tie");
    const ok = await pairwise(fair, g, side("Here it is."), side("So sorry, here it is."), signal);
    assert.deepEqual([ok.consistent, ok.winner], [true, "candidate"]);
  });
});
// #endregion

// #region baseline-tests
describe("baselines", () => {
  test("saved runs can be recovered after a restart; client paths cannot escape the runs directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "c52-runs-"));
    const run = syntheticReport("baseline");
    saveRun(run, dir);
    assert.deepEqual(loadRun(run.id, dir), run);
    assert.equal(loadRun("../baseline", dir), undefined);
    assert.equal(loadRun("..\\baseline", dir), undefined);
    assert.equal(loadRun("unknown", dir), undefined);
  });
  test("infrastructure-only runs cannot overwrite a measured baseline", () => {
    const run = syntheticReport("baseline");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "c52-promotion-")), "baseline.json");
    saveBaseline(run, "keep this", file);
    const failed = { ...run, totals: { ...run.totals, trials: 0, infraErrors: 15 } };
    assert.match(promotionError(failed)!, /missing measurements/);
    assert.throws(() => saveBaseline(failed, "invalid", file), /missing measurements/);
    assert.equal(loadBaseline(file)!.note, "keep this");
    assert.equal(promotionError(run), undefined);
  });
  test("missing measurements and empty runs cannot pass a regression gate", () => {
    const base = syntheticReport("baseline");
    const candidate = syntheticReport("baseline");
    delete candidate.cases.status;
    assert.equal(compare(base, candidate).verdict, "error");
    candidate.cases = {};
    assert.equal(compare(base, candidate).verdict, "error");
    assert.equal(compare(candidate, candidate).verdict, "error");
  });
  test("cold tone: every code check holds, only the judge sees the regression", () => {
    const cmp = compare(syntheticReport("baseline"), syntheticReport("cold-tone"));
    assert.equal(cmp.verdict, "fail");
    assert.ok(cmp.rows.filter((r) => r.kind === "check").every((r) => r.verdict === "stable"));
    assert.ok(cmp.rows.some((r) => r.kind === "judge" && r.metric === "judge:empathy" && r.verdict === "regression"));
    assert.deepEqual(cmp.changed.map((c) => c.split(":")[0]), ["variant", "prompt"]);
  });
  test("no-act-now: a significant ticket regression and a merely suspect one", () => {
    const rows = compare(syntheticReport("baseline"), syntheticReport("no-act-now")).rows;
    assert.equal(rows.find((r) => r.caseId === "change-of-mind" && r.metric === "check:a ticket for the returns desk")!.verdict, "regression");
    assert.equal(rows.find((r) => r.caseId === "over-limit" && r.metric === "check:a high-priority ticket")!.verdict, "suspect");
  });
  test("reassure: one early refund in one trial fails the gate", () => {
    const cmp = compare(syntheticReport("baseline"), syntheticReport("reassure"));
    assert.equal(cmp.counts["gate-fail"], 1);
    assert.equal(cmp.verdict, "fail");
  });
  test("fix-findings: the judge's metrics improve and nothing regresses", () => {
    const cmp = compare(syntheticReport("baseline"), syntheticReport("fix-findings"));
    assert.equal(cmp.verdict, "pass");
    assert.ok(cmp.counts.improved >= 3);
    assert.equal(cmp.counts.regression + cmp.counts["gate-fail"], 0);
  });
  test("the baseline compared with itself passes", () => {
    assert.equal(compare(syntheticReport("baseline"), syntheticReport("baseline")).verdict, "pass");
  });
  test("a different judge makes the baseline stale instead of producing a verdict", () => {
    const cand = syntheticReport("baseline", "claude-haiku-4-5");
    const cmp = compare(syntheticReport("baseline"), cand);
    assert.equal(cmp.verdict, "stale");
    assert.match(cmp.stale[0], /judge changed/);
  });
  test("judge errors are excluded from n; a check missing from a crashed trial counts as a failure", () => {
    const rec = (trial: number, over: Partial<TrialRecord>): TrialRecord => ({
      caseId: "status", trial, checks: [{ name: "finished (result success)", pass: true }, { name: "no refund, no ticket", pass: true }],
      judge: { ok: true, verdict: allPass as any, model: "m", costUsd: 0, ms: 0 }, reply: "r", actions: [], effects: { refunds: [], tickets: [] }, agentCostUsd: 0.01, turns: 3, ms: 1, ...over,
    });
    const r = buildReport({ id: "t", createdAt: "", variant: "baseline", trials: 3, judge: "sonnet", fingerprint: fingerprintFor("baseline", "m") }, [
      rec(1, {}),
      rec(2, { judge: { ok: false, error: "boom", model: "m", costUsd: 0, ms: 0 } }),
      rec(3, { checks: [{ name: "finished (result success)", pass: false }], judge: null, reply: "" }),
    ], 0);
    assert.deepEqual(r.cases.status.metrics["judge:empathy"], { kind: "judge", n: 1, k: 1 });
    assert.deepEqual(r.cases.status.metrics["check:no refund, no ticket"], { kind: "check", critical: true, n: 3, k: 2 });
    assert.equal(r.cases.status.judgeErrors, 1);
  });
  test("out of credit is an infrastructure error, not a regression", () => {
    const broke = syntheticReport("baseline");
    const records = broke.records!.map((r, i) => (i % 2 ? { ...r, infra: "is_error: Credit balance is too low", checks: [{ name: "finished (result success)", pass: false }], judge: null, reply: "" } : r));
    const cand = buildReport({ id: "x", createdAt: "", variant: "baseline", trials: 5, judge: "sonnet", fingerprint: broke.fingerprint }, records, 0);
    assert.equal(cand.totals.infraErrors, Math.floor(records.length / 2));
    assert.ok(Object.values(cand.cases).every((c) => c.metrics["check:finished (result success)"].k === c.metrics["check:finished (result success)"].n));
    const cmp = compare(syntheticReport("baseline"), cand);
    assert.equal(cmp.verdict, "error");
    assert.match(cmp.warnings[0], /infrastructure/);
  });
  test("a promoted baseline keeps the numbers and the samples, not every transcript", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "c52-")), "baseline.json");
    saveBaseline(syntheticReport("baseline"), "test", file);
    const b = loadBaseline(file)!;
    assert.equal(b.records, undefined);
    assert.equal(b.note, "test");
    assert.equal(b.cases.status.trials, 5);
  });
});
// #endregion

describe("HTTP (no model calls)", () => {
  let server: Server;
  let url: string;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/c52", concept52);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    url = `http://127.0.0.1:${(server.address() as any).port}/api/c52`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const post = (route: string, body: unknown) => fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("facts list the rubric, the variants and the golden set", async () => {
    const f = await (await fetch(`${url}/facts`)).json();
    assert.equal(f.criteria.length, 5);
    assert.equal(f.golden.length, GOLDEN.length);
    assert.deepEqual(Object.keys(f.variants), ["baseline", "no-act-now", "cold-tone", "reassure", "fix-findings"]);
  });
  test("demo comparison runs offline", async () => {
    const r = await (await post("demo", { variant: "cold-tone" })).json();
    assert.equal(r.modelCalls, 0);
    assert.equal(r.comparison.verdict, "fail");
  });
  test("heuristic calibration streams every golden item", async () => {
    const text = await (await post("calibrate", { judge: "heuristic" })).text();
    assert.equal(text.match(/^event: item$/gm)?.length, GOLDEN.length);
    assert.match(text, /^event: summary$/m);
  });
  test("bad requests are rejected before anything runs", async () => {
    assert.equal((await post("run", { variant: "nope", trials: 3, judge: "sonnet" })).status, 400);
    assert.equal((await post("run", { variant: "baseline", trials: 9, judge: "sonnet" })).status, 400);
    assert.equal((await post("calibrate", { judge: "gpt" })).status, 400);
    assert.equal((await post("promote", { runId: "unknown" })).status, 404);
  });
});
