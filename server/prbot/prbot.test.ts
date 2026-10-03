import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { BOT, FIX_BRANCH, PR_BRANCH, plantedBugs } from "./fixture.js";
import {
  RUN_TESTS, ReviewSchema, fixReportJsonSchema, reviewJsonSchema, applyFiles, commentable, commitFix, createWorkspace, decide, fixPresets, gate, git, numberedDiff, parseDiff, removeWorkspace,
  resetFix, reviewPayload, reviewPresets, runProbe, runTests, triage, triggerPresets, verifyFix, type Workspace,
} from "./prbot.js";
import { concept73 } from "../concepts/73-pr-reviewer-fixer.js";

let ws: Workspace;
before(async () => { ws = await createWorkspace("test-prbot"); });
after(() => removeWorkspace(ws));
const review = (id: string) => ReviewSchema.parse(reviewPresets.find((p) => p.id === id)!.review);

test("the fixture: CI is green on the PR, yet both planted bugs are real", async () => {
  assert.equal(await git(ws.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(await git(ws.fix, "rev-parse", "--abbrev-ref", "HEAD"), FIX_BRANCH);
  assert.equal(await git(ws.review, "rev-parse", "HEAD"), ws.headSha);
  assert.deepEqual(ws.files.map((f) => `${f.path}:${f.status}`), ["src/cart.mjs:modified", "src/coupons.mjs:added", "test/coupons.test.mjs:added"]);
  const tests = await runTests(ws.review);
  assert.equal(tests.ok, true, tests.output); assert.equal(tests.tests, 5);
  for (const bug of plantedBugs) assert.equal((await runProbe(ws.review, bug.probe)).ok, false, `${bug.id} is present on the PR head`);
});

test("parseDiff numbers new-side lines; only lines inside a hunk can carry a comment", () => {
  const cart = ws.files.find((f) => f.path === "src/cart.mjs")!;
  const lines = commentable(cart);
  assert.ok(lines.has(plantedBugs[0].line)); assert.ok(lines.has(1), "context lines count"); assert.ok(!lines.has(40));
  assert.match(numberedDiff(ws.files), new RegExp(`\\n\\s+${plantedBugs[0].line} \\+   return item\\.quantity > BULK_THRESHOLD`));
  const parsed = parseDiff("diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -3,2 +3,3 @@\n a\n-b\n+c\n+d\n");
  assert.deepEqual([...commentable(parsed[0])], [3, 4, 5]);
});

test("the review schema has no approve; the host triages, anchors, dedupes and grades", () => {
  assert.equal(ReviewSchema.safeParse(reviewPresets.find((p) => p.id === "injected")!.review).success, false);
  assert.equal(ReviewSchema.safeParse({ ...review("good"), extra: 1 }).success, false);
  assert.equal("$schema" in reviewJsonSchema, false); assert.equal("$schema" in fixReportJsonSchema, false); // Claude Code rejects it
  assert.deepEqual((reviewJsonSchema.properties as { verdict: { enum: string[] } }).verdict.enum, ["comment", "request_changes"]);
  const good = triage(review("good"), ws.files);
  assert.deepEqual(good.findings.map((f) => [f.id, f.action, f.planted ?? ""]), [["F1", "autofix", "B1"], ["F2", "autofix", "B2"], ["F3", "comment", ""], ["F4", "human", ""], ["F5", "comment", ""]]);
  assert.deepEqual(good.grade, { found: ["B1", "B2"], missed: [] });
  const anchors = triage(review("anchors"), ws.files);
  assert.equal(anchors.dropped.length, 1);
  assert.deepEqual(anchors.findings.map((f) => f.placement), ["inline", "summary", "summary", "summary"]);
  assert.ok(anchors.findings.slice(1).every((f) => f.action !== "autofix"), "the bot only fixes changed lines");
  const ci = triage({ summary: "s", verdict: "comment", findings: [{ file: ".github/workflows/ci.yml", line: 1, severity: "critical", category: "security", confidence: "high", title: "t", body: "b" }] }, ws.files);
  assert.equal(ci.findings[0].action, "human");
  assert.deepEqual(triage(review("shallow"), ws.files).grade.missed, ["B1", "B2"]);
});

test("the trigger gate: loop guard, forks, drafts, labels and the fix budget", () => {
  const run = (label: string) => gate(triggerPresets.find((p) => p.label === label)!.event).run;
  assert.equal(run("PR opened by a teammate"), "review+fix");
  assert.equal(run("Push of the bot's own fix"), "skip");
  assert.equal(run("PR from a fork"), "review");
  assert.equal(run("Fix budget spent"), "review");
  assert.equal(run("Draft PR"), "skip");
  assert.equal(run("Labelled bot:skip"), "skip");
  assert.equal(gate({ ...triggerPresets[0].event, action: "closed" }).run, "skip");
});

test("the policy: a read-only reviewer and a fixer scoped to the PR's files and tests", () => {
  const allow = (phase: "review" | "fix", tool: string, input: Record<string, unknown>) => decide(phase, tool, input, phase === "review" ? ws.review : ws.fix, ws.files).decision === "allow";
  assert.ok(allow("review", "Read", { file_path: path.join(ws.review, "src", "cart.mjs") }));
  assert.ok(allow("review", "Grep", { pattern: "query" })); assert.ok(allow("review", "Glob", { pattern: "**/*.mjs" }));
  assert.ok(!allow("review", "Glob", { pattern: "../../**" })); assert.ok(!allow("review", "Read", { file_path: "../../../.env" }));
  assert.ok(!allow("review", "Read", { file_path: ".git/config" }));
  assert.ok(!allow("review", "Edit", { file_path: "src/cart.mjs" })); assert.ok(!allow("review", RUN_TESTS, {}));
  assert.ok(allow("fix", "Edit", { file_path: path.join(ws.fix, "src", "cart.mjs") }));
  assert.ok(allow("fix", "Write", { file_path: "test/pr-bot-fixes.test.mjs" })); assert.ok(allow("fix", RUN_TESTS, {}));
  for (const file of [".github/workflows/ci.yml", "package.json", "README.md", "test/helper.mjs", "../review/src/cart.mjs", ".git/hooks/pre-commit"]) assert.ok(!allow("fix", "Write", { file_path: file }), file);
  assert.match(decide("fix", "Bash", { command: "node --test" }, ws.fix, ws.files).reason, /run_tests/);
  assert.ok(!allow("fix", "WebFetch", { url: "https://example.com" }));
  assert.ok(allow("review", "StructuredOutput", {}) && allow("fix", "StructuredOutput", {}), "outputFormat arrives as a tool call");
});

test("PR code runs without the bot's secrets", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-canary";
  try {
    await resetFix(ws);
    writeFileSync(path.join(ws.fix, "test", "env.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no key", () => assert.equal(process.env.ANTHROPIC_API_KEY, undefined));\n');
    const run = await runTests(ws.fix);
    assert.equal(run.ok, true, run.output); assert.equal(run.tests, 6);
  } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; await resetFix(ws); }
});

test("host verification: each recorded fix is accepted or rejected for the right reason", async () => {
  const expected: Record<string, string | null> = { good: null, ci: "Only files in the fix scope", skip: "Tests not weakened", broken: "Test suite passes (run by the host)", gamed: "Lab probe B1: Off-by-one: 10 units get no bulk discount" };
  for (const preset of fixPresets) {
    await resetFix(ws); applyFiles(ws, preset.files);
    const v = await verifyFix(ws, ["B1", "B2"]);
    const failed = v.checks.filter((c) => !c.ok && c.severity === "error").map((c) => c.name);
    if (expected[preset.id] === null) assert.equal(v.ok, true, JSON.stringify(failed));
    else { assert.equal(v.ok, false, preset.id); assert.ok(failed.includes(expected[preset.id]!), `${preset.id}: ${failed.join(", ")}`); }
    if (preset.id === "gamed") assert.ok(v.tests!.ok && failed.length === 1, "green tests, only the probe fails");
    if (!v.ok) assert.equal(await git(ws.fix, "diff", "--cached", "--name-only"), "", "a rejected fix is unstaged, never committed");
  }
  await resetFix(ws);
  assert.throws(() => applyFiles(ws, { "../review/src/cart.mjs": "x" }), /Bad path/);
});

test("an accepted fix: committed by the bot on its own branch, a patch that applies, a review that never approves", async () => {
  const t = triage(review("good"), ws.files);
  await resetFix(ws); applyFiles(ws, fixPresets[0].files);
  assert.equal((await verifyFix(ws, ["B1", "B2"])).ok, true);
  const commit = await commitFix(ws, t.findings.filter((f) => f.action === "autofix"), fixPresets[0].report.summary);
  assert.equal(await git(ws.fix, "log", "-1", "--format=%an"), BOT.name);
  assert.match(commit.message, /Fixes-Finding: F1, F2/); assert.match(commit.message, new RegExp(`Reviewed-Head: ${ws.headSha}`));
  assert.equal(await git(ws.repo, "rev-parse", PR_BRANCH), ws.headSha, "the contributor's branch is untouched");
  const patchFile = path.join(ws.run, "fix.patch"); writeFileSync(patchFile, commit.patch);
  await git(ws.review, "apply", "--check", patchFile);

  const payload = reviewPayload(t, { sha: commit.sha, fixed: ["F1", "F2"] });
  assert.equal(payload.event, "REQUEST_CHANGES", "the PR itself still has the bugs until the fix PR is merged");
  assert.ok(payload.comments.every((c) => commentable(ws.files.find((f) => f.path === c.path)!).has(c.line) && c.side === "RIGHT"));
  assert.match(payload.comments[0].body, /proposed a verified fix/);
  assert.match(reviewPayload(t, null).comments[0].body, /```suggestion\n/);
  assert.equal(reviewPayload(triage(review("shallow"), ws.files), null).event, "COMMENT");
  for (const preset of reviewPresets) {
    const parsed = ReviewSchema.safeParse(preset.review);
    if (parsed.success) assert.notEqual(reviewPayload(triage(parsed.data, ws.files), null).event, "APPROVE");
  }
  await resetFix(ws);
});

test("HTTP routes: facts, gate, sessions, review, fix, patch and validation", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c73", concept73);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c73`;
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let id = "";
  try {
    const facts = await (await fetch(`${base}/facts`)).json();
    assert.equal(facts.pr.number, 42); assert.equal(facts.reviewPresets.length, reviewPresets.length);
    assert.ok(!JSON.stringify(facts.plantedBugs).includes("assert"), "probes stay on the server");
    assert.ok((await (await fetch(`${base}/code`)).json())["prbot.ts"].includes("verifyFix"));
    assert.equal((await (await post("gate", { event: triggerPresets[1].event })).json()).run, "skip");
    assert.equal((await post("gate", { event: { action: "opened" } })).status, 400);
    const session = await (await post("sessions", {})).json(); id = session.id;
    assert.match(session.numbered, /src\/coupons\.mjs \(added\)/);
    assert.equal((await post("sessions/missing/review", { preset: "good" })).status, 404);
    assert.equal((await post(`sessions/${id}/fix`, { preset: "good" })).status, 409, "no review yet");
    assert.equal((await (await post(`sessions/${id}/review`, { preset: "injected" })).json()).ok, false);
    const reviewed = await (await post(`sessions/${id}/review`, { preset: "good" })).json();
    assert.equal(reviewed.ok, true); assert.equal(reviewed.payload.event, "REQUEST_CHANGES");
    assert.equal((await fetch(`${base}/sessions/${id}/patch`)).status, 404);
    const bad = await (await post(`sessions/${id}/fix`, { preset: "ci" })).json();
    assert.equal(bad.verification.ok, false); assert.equal(bad.commit, undefined);
    const good = await (await post(`sessions/${id}/fix`, { preset: "good" })).json();
    assert.equal(good.verification.ok, true); assert.match(good.commit.sha, /^[0-9a-f]{40}$/);
    assert.equal(good.commands.length, 3);
    const patch = await fetch(`${base}/sessions/${id}/patch`);
    assert.equal(patch.status, 200); assert.match(await patch.text(), /Fixes-Finding: F1, F2/);
    assert.equal((await post(`sessions/${id}/run`, { stages: "all" })).status, 400, "the autopilot needs an event");
    assert.equal((await post(`sessions/${id}/policy`, { phase: "fix", tool: "Bash", input: { command: "rm -rf ." } })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (id) removeWorkspace({ run: path.join(ws.run, "..", id) });
  }
});
