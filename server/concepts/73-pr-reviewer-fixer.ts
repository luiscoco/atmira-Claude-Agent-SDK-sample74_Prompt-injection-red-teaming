/**
 * CONCEPT 73 — An autonomous PR reviewer and fixer
 *
 *   A bot that reviews a pull request and fixes what it finds, with nobody watching each step. Autonomy is safe only
 *   because every step that matters belongs to the HOST, not to a model:
 *   - GATE: the host decides whether the bot runs at all (loop guard, forks, drafts, a fix budget per PR);
 *   - REVIEW: a read-only agent (Read/Grep/Glob) returns findings in a schema that has no "approve";
 *   - TRIAGE: the host anchors each finding to the diff and decides who acts on it (bot, person, nobody);
 *   - FIX: a second agent, in its own git worktree, may edit only the PR's files and tests. It has no shell: a host tool
 *     runs the tests with a clean environment, because the PR's code is untrusted;
 *   - VERIFY: the host checks scope, test integrity and runs the tests itself. At most two rounds, then a person;
 *   - PUBLISH: the host commits as the bot on a separate branch and writes the GitHub review. It never approves.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSdkMcpServer, query, tool, type HookCallback, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import { FIX_BRANCH, PR_BRANCH, plantedBugs, pr } from "../prbot/fixture.js";
import {
  FixReportSchema, LAB_ROOT, MAX_AUTOFIX, MAX_BOT_COMMITS, MAX_FIX_LINES, PROTECTED, RUN_TESTS, ReviewSchema, TriggerSchema, applyFiles, commitFix, createWorkspace,
  decide, fixPresets, fixReportJsonSchema, fixerPrompt, fixerSystemPrompt, gate, numberedDiff, publishCommands, removeWorkspace, resetFix, reviewJsonSchema,
  reviewPayload, reviewPresets, reviewerPrompt, reviewerSystemPrompt, runTests, triage, triggerPresets, verifyFix,
  type FixReport, type Phase, type Triage, type Triaged, type Verification, type Workspace,
} from "../prbot/prbot.js";

// The reviewer's judgement is the hard part, so it gets the stronger model; the fixer works against tests (lesson 59).
export const MODELS = { review: "claude-sonnet-5-5", fix: "claude-haiku-4-5" } as const;
export const limits = {
  review: { maxTurns: 12, maxBudgetUsd: 0.3, deadlineMs: 150_000 },
  fix: { maxTurns: 25, maxBudgetUsd: 0.4, deadlineMs: 240_000 },
  maxRounds: 2,
};
const TOOLS = { review: ["Read", "Grep", "Glob"], fix: ["Read", "Grep", "Glob", "Edit", "Write"] };

type Commit = { sha: string; message: string; patch: string };
type Session = { ws: Workspace; expires: number; busy: boolean; triage?: Triage; commit?: Commit & { fixed: string[] } };
export const concept73 = Router();
const sessions = new Map<string, Session>();

concept73.get("/facts", (_req, res) => {
  res.json({
    pr, base: pr.base, head: PR_BRANCH, fixBranch: FIX_BRANCH, reviewPresets, fixPresets: fixPresets.map(({ files, ...rest }) => ({ ...rest, files: Object.keys(files) })),
    triggerPresets, reviewerSystemPrompt, fixerSystemPrompt, reviewJsonSchema, fixReportJsonSchema, models: MODELS, limits, tools: { ...TOOLS, fix: [...TOOLS.fix, RUN_TESTS] },
    rules: { maxAutofix: MAX_AUTOFIX, maxBotCommits: MAX_BOT_COMMITS, maxFixLines: MAX_FIX_LINES, protected: PROTECTED.map((p) => p.source) },
    plantedBugs: plantedBugs.map(({ probe: _probe, ...bug }) => bug),
  });
});
concept73.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["prbot.ts", new URL("../prbot/prbot.ts", import.meta.url)],
  ["fixture.ts", new URL("../prbot/fixture.ts", import.meta.url)],
  ["73-pr-reviewer-fixer.ts", new URL("./73-pr-reviewer-fixer.ts", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));

// The trigger gate needs no workspace: it is a pure function of the webhook event.
concept73.post("/gate", (req, res) => {
  const body = z.object({ event: TriggerSchema }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  res.json(gate(body.data.event));
});

concept73.post("/sessions", async (_req, res) => {
  for (const [id, session] of sessions) if (session.expires < Date.now() && !session.busy) { removeWorkspace(session.ws); sessions.delete(id); }
  if (sessions.size >= 10) return res.status(429).json({ message: "Lab capacity reached; try later." });
  const id = randomUUID();
  try {
    const ws = await createWorkspace(id);
    sessions.set(id, { ws, expires: Date.now() + 3_600_000, busy: false });
    res.json({ id, baseSha: ws.baseSha, headSha: ws.headSha, numbered: numberedDiff(ws.files), files: ws.files.map((f) => ({ path: f.path, status: f.status })) });
  } catch (error) { res.status(500).json({ message: `Could not create the lab repository (is git installed?): ${error instanceof Error ? error.message : error}` }); }
});
concept73.use("/sessions/:id", (req, res, next) => {
  const session = sessions.get(req.params.id);
  if (!session || session.expires < Date.now()) return res.status(404).json({ message: "Lab expired or missing. Start a new lab." });
  if (session.busy && req.method === "POST") return res.status(409).json({ message: "Wait until the live run ends." });
  res.locals.session = session; next();
});

concept73.post("/sessions/:id/policy", (req, res) => {
  const body = z.object({ phase: z.enum(["review", "fix"]), tool: z.string().min(1).max(60), input: z.record(z.string(), z.unknown()) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  const { ws } = res.locals.session as Session;
  res.json(decide(body.data.phase, body.data.tool, body.data.input, body.data.phase === "review" ? ws.review : ws.fix, ws.files));
});

const toResult = (s: Session) => ({ triage: s.triage, payload: s.triage ? reviewPayload(s.triage, s.commit ?? null) : undefined, commands: publishCommands(s.commit ?? null) });

// Offline review: a recorded reviewer output goes through the same schema and triage as a live one.
concept73.post("/sessions/:id/review", (req, res) => {
  const body = z.object({ preset: z.string().max(40).optional(), review: z.unknown().optional() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  const session = res.locals.session as Session;
  const raw = body.data.preset ? reviewPresets.find((p) => p.id === body.data.preset)?.review : body.data.review;
  if (raw === undefined) return res.status(400).json({ message: "Unknown preset." });
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) return res.json({ ok: false, message: `Rejected by the review schema:\n${z.prettifyError(parsed.error)}` });
  session.triage = triage(parsed.data, session.ws.files); session.commit = undefined;
  res.json({ ok: true, ...toResult(session) });
});

const autofixOf = (t: Triage) => t.findings.filter((f) => f.action === "autofix");
const targetsOf = (findings: Triaged[]) => findings.flatMap((f) => f.planted ? [f.planted] : []);

async function accept(session: Session, report: FixReport, findings: Triaged[]) {
  const fixed = findings.filter((f) => report.fixed.includes(f.id));
  const commit = await commitFix(session.ws, fixed.length ? fixed : findings, report.summary);
  session.commit = { ...commit, fixed: (fixed.length ? fixed : findings).map((f) => f.id) };
  return session.commit;
}

// Offline fix: a recorded patch is written into the fix worktree (as if the fixer had made it), then verified.
concept73.post("/sessions/:id/fix", async (req, res) => {
  const body = z.object({ preset: z.string().max(40) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  const session = res.locals.session as Session;
  const preset = fixPresets.find((p) => p.id === body.data.preset);
  if (!preset) return res.status(400).json({ message: "Unknown preset." });
  if (!session.triage) return res.status(409).json({ message: "Run a review first (part C): the fixer only works on findings the host selected." });
  const findings = autofixOf(session.triage);
  if (!findings.length) return res.status(409).json({ message: "This review selected nothing for the fixer. Load the good review." });
  session.busy = true;
  try {
    await resetFix(session.ws); session.commit = undefined;
    applyFiles(session.ws, preset.files);
    const verification = await verifyFix(session.ws, targetsOf(findings));
    const commit = verification.ok ? await accept(session, preset.report, findings) : undefined;
    res.json({ report: preset.report, verification, commit, ...toResult(session) });
  } catch (error) { res.status(500).json({ message: String(error) }); }
  finally { session.busy = false; }
});

concept73.get("/sessions/:id/patch", (_req, res) => {
  const { commit } = res.locals.session as Session;
  if (!commit) return res.status(404).json({ message: "No accepted fix yet." });
  res.setHeader("Content-Type", "text/x-patch; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pr-${pr.number}-pr-bot.patch"`);
  res.send(commit.patch);
});

// ---------------------------------------------------------------------------------------------
// Live: the reviewer, the fixer (up to limits.maxRounds attempts) or the whole pipeline behind the gate.
// ---------------------------------------------------------------------------------------------

type Send = (event: string, data: unknown) => void;

function policyHook(phase: Phase, root: string, ws: Workspace, send: Send): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const verdict = decide(phase, input.tool_name, toolInput, root, ws.files);
    send("policy", { phase, tool: input.tool_name, input: toolInput, ...verdict });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } };
  };
}

/** Runs one agent to its result. The SDK yields an error result and then throws, so the result is kept before the catch. */
async function runAgent(phase: Phase, prompt: string, options: Options, send: Send) {
  let result: Extract<SDKMessage, { type: "result" }> | undefined;
  const run = query({ prompt, options });
  try {
    for await (const message of run) {
      send("message", { ...message, phase });
      if (message.type === "result") result = message;
    }
  } catch (error) { if (!result) throw error; }
  finally { run.close(); }
  if (!result) throw new Error(`The ${phase} agent ended without a result.`);
  send("result", { phase, subtype: result.subtype, costUsd: result.total_cost_usd, turns: result.num_turns });
  return result;
}

function baseOptions(phase: Phase, ws: Workspace, abort: AbortController, send: Send): Options {
  const root = phase === "review" ? ws.review : ws.fix;
  return {
    model: MODELS[phase], cwd: root, thinking: { type: "disabled" },
    settingSources: [], strictMcpConfig: true, persistSession: false,
    hooks: { PreToolUse: [{ hooks: [policyHook(phase, root, ws, send)] }] },
    permissionMode: "dontAsk", // anything the hook does not allow is denied, never prompted: nobody is watching
    env: agentEnv(path.join(LAB_ROOT, "config")), abortController: abort,
    maxTurns: limits[phase].maxTurns, maxBudgetUsd: limits[phase].maxBudgetUsd,
  };
}

async function liveReview(session: Session, abort: AbortController, send: Send) {
  const { ws } = session;
  send("stage", { stage: "review", detail: `${MODELS.review}, read-only, in review/ (a detached checkout of ${PR_BRANCH})` });
  const options: Options = { ...baseOptions("review", ws, abort, send), systemPrompt: reviewerSystemPrompt, tools: TOOLS.review, outputFormat: { type: "json_schema", schema: reviewJsonSchema } };
  send("options", { phase: "review", ...options, hooks: "{ PreToolUse: [policy(review)] }", env: "agentEnv(prbot-lab/config)", abortController: undefined });
  const result = await runAgent("review", reviewerPrompt(ws.files), options, send);
  const parsed = ReviewSchema.safeParse(result.subtype === "success" ? result.structured_output : undefined);
  if (!parsed.success) { send("stage", { stage: "review-failed", detail: `No valid review (${result.subtype}). Nothing is posted; the run fails closed.` }); return null; }
  session.triage = triage(parsed.data, ws.files); session.commit = undefined;
  send("review", toResult(session));
  return session.triage;
}

async function liveFix(session: Session, abort: AbortController, send: Send) {
  const { ws } = session;
  const findings = session.triage ? autofixOf(session.triage) : [];
  if (!findings.length) { send("stage", { stage: "fix-skipped", detail: "Triage selected nothing for the fixer." }); return; }
  await resetFix(ws); session.commit = undefined;
  // The only way the fixer runs code: a host tool with a clean env (no API key, no tokens) and a time limit.
  const ci = createSdkMcpServer({ name: "ci", version: "1.0.0", tools: [
    tool("run_tests", "Run the repository's test suite (node --test) in your checkout. Clean environment, 30-second limit. Returns pass/fail counts and the TAP output.", {}, async () => {
      const run = await runTests(ws.fix);
      send("tests", { ok: run.ok, tests: run.tests, pass: run.pass, fail: run.fail, skipped: run.skipped });
      return { content: [{ type: "text" as const, text: JSON.stringify(run) }] };
    }),
  ] });
  let feedback: string | undefined;
  for (let round = 1; round <= limits.maxRounds; round++) {
    send("stage", { stage: "fix", detail: `Round ${round}/${limits.maxRounds}: ${MODELS.fix} fixes ${findings.map((f) => f.id).join(", ")} in fix/ (branch ${FIX_BRANCH})` });
    const options: Options = {
      ...baseOptions("fix", ws, abort, send), systemPrompt: fixerSystemPrompt, tools: TOOLS.fix,
      mcpServers: { ci }, allowedTools: [RUN_TESTS], outputFormat: { type: "json_schema", schema: fixReportJsonSchema },
    };
    if (round === 1) send("options", { phase: "fix", ...options, mcpServers: "{ ci: run_tests }", hooks: "{ PreToolUse: [policy(fix)] }", env: "agentEnv(prbot-lab/config)", abortController: undefined });
    const result = await runAgent("fix", fixerPrompt(ws, findings, feedback), options, send);
    const report = FixReportSchema.safeParse(result.subtype === "success" ? result.structured_output : undefined);
    // The report is a claim. The host verifies the working tree whatever the fixer says.
    const verification: Verification = await verifyFix(ws, targetsOf(findings));
    const fixReport: FixReport = report.success ? report.data : { fixed: [], notFixed: [], summary: `Fixer ended with ${result.subtype}.` };
    if (verification.ok) {
      const commit = await accept(session, fixReport, findings);
      send("verification", { round, report: fixReport, verification, commit });
      return;
    }
    send("verification", { round, report: fixReport, verification });
    // Feedback is the generic checks only. The lab probes are an answer key the fixer must never see.
    const failed = verification.checks.filter((c) => !c.ok && c.severity === "error" && !c.name.startsWith("Lab probe"));
    if (!failed.length) { send("stage", { stage: "fix-rejected", detail: "Only a lab probe failed. A real bot has no answer key and would have proposed this fix: that is why a person reviews the fix PR." }); return; }
    feedback = failed.map((c) => `- ${c.name}: ${c.detail}`).join("\n") + (verification.tests && !verification.tests.ok ? `\n\nTest output:\n${verification.tests.output.slice(-2000)}` : "");
  }
  send("stage", { stage: "fix-gave-up", detail: `No verified fix after ${limits.maxRounds} rounds. The bot stops and leaves the findings to a person.` });
}

let active = false;
concept73.post("/sessions/:id/run", async (req, res) => {
  const body = z.object({ stages: z.enum(["review", "fix", "all"]), event: TriggerSchema.optional() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  const session = res.locals.session as Session;
  if (body.data.stages === "fix" && !(session.triage && autofixOf(session.triage).length)) return res.status(409).json({ message: "Run a review first: the fixer only works on findings the host selected." });
  if (body.data.stages === "all" && !body.data.event) return res.status(400).json({ message: "The autopilot needs the webhook event for the gate." });
  if (active) return res.status(409).json({ message: "A lesson 73 agent is already running." });
  active = true; session.busy = true;
  const { abort, send } = openSse(req, res);
  const timer = setTimeout(() => abort.abort(), limits.review.deadlineMs + limits.maxRounds * limits.fix.deadlineMs);
  try {
    let fix = body.data.stages === "fix";
    if (body.data.stages === "all") {
      const decision = gate(body.data.event!);
      send("gate", decision);
      if (decision.run === "skip") return;
      fix = decision.run === "review+fix";
    }
    if (body.data.stages !== "fix" && !(await liveReview(session, abort, send))) return;
    if (fix) await liveFix(session, abort, send);
  } catch (error) { if (!res.destroyed) send("error", { message: abort.signal.aborted ? "Run stopped or deadline reached. Nothing was committed." : String(error) }); }
  finally {
    clearTimeout(timer);
    if (!res.destroyed) { send("final", toResult(session)); send("done", {}); res.end(); }
    session.busy = false; active = false;
  }
});
