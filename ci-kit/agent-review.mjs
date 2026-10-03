#!/usr/bin/env node
/**
 * agent-review.mjs — a headless code-review GATE for CI (Concept 49).
 *
 * Runs one Agent SDK query() with no human in the loop, asks for a JSON verdict that matches a schema, and turns it
 * into the three things a CI job understands:
 *   - an EXIT CODE         0 = pass, 1 = blocking findings, 2 = the agent could not finish (turns/budget/error), 124 = timeout
 *   - ANNOTATIONS          `::error file=…,line=…::…` lines on stdout (GitHub Actions shows them on the diff)
 *   - a JOB SUMMARY        Markdown appended to $GITHUB_STEP_SUMMARY, and key=value pairs appended to $GITHUB_OUTPUT
 *
 * Usage:   node ci-kit/agent-review.mjs [--diff <file>] [--cwd <repo>]
 *          (without --diff it runs `git diff --unified=3 $BASE_REF...HEAD`, BASE_REF defaulting to origin/main)
 * Env:     ANTHROPIC_API_KEY (secret), REVIEW_MODEL (haiku), REVIEW_MAX_TURNS (6), REVIEW_MAX_BUDGET_USD (0.10),
 *          REVIEW_TIMEOUT_MS (120000), GITHUB_STEP_SUMMARY / GITHUB_OUTPUT (set by the runner; optional locally)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// #region inputs
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const cwd = path.resolve(arg("--cwd") ?? process.cwd());
const diffFile = arg("--diff");
const diff = diffFile
  ? readFileSync(path.resolve(cwd, diffFile), "utf8")
  : execFileSync("git", ["diff", "--unified=3", `${process.env.BASE_REF ?? "origin/main"}...HEAD`], { cwd, encoding: "utf8" });
const MODEL = process.env.REVIEW_MODEL ?? "haiku";
const MAX_TURNS = Number(process.env.REVIEW_MAX_TURNS ?? 6);
const MAX_BUDGET = Number(process.env.REVIEW_MAX_BUDGET_USD ?? 0.1);
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 120_000);

// Logs go to STDERR; stdout is reserved for the annotations the runner parses. (A CI log is the only UI you get.)
const log = (msg) => process.stderr.write(`[agent-review] ${msg}\n`);
// #endregion

// #region schema
// The contract between the agent and the pipeline. With outputFormat, the result carries `structured_output`
// already validated against this schema — no regex over prose, no "the model said LGTM so it passed".
const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["error", "warning", "notice"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["file", "line", "severity", "title", "detail"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};
// #endregion

// #region run
// Headless means: nobody can answer a permission prompt. So the run must be FAIL-CLOSED and BOUNDED:
//   permissionMode "dontAsk"  anything not pre-approved is denied instantly (never a prompt that hangs the job)
//   tools / allowedTools      read-only tools only — a reviewer never needs Bash or Write
//   maxTurns / maxBudgetUsd   hard ceilings: a loop or a huge diff cannot burn the budget
//   AbortController           a wall-clock timeout, independent of the runner's own job timeout
//   settingSources: []        reproducible: no user/project settings from the runner image change behaviour
//   persistSession: false     an ephemeral runner keeps no transcripts; CLAUDE_CONFIG_DIR points at a temp dir
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
const prompt =
  `You are a strict code reviewer in a CI pipeline. Review ONLY the changes in this unified diff. ` +
  `You may Read/Grep files in the repository for context. Report real defects (bugs, security issues, crashes) as "error", ` +
  `risky code as "warning", style as "notice". Report each defect ONCE, at its root cause: code that merely calls a buggy ` +
  `function is not a separate finding. Use the NEW file's line numbers. verdict is "fail" if any finding is an error.\n\n` +
  "```diff\n" + diff + "\n```";

let result;
const started = Date.now();
log(`model=${MODEL} maxTurns=${MAX_TURNS} maxBudgetUsd=${MAX_BUDGET} timeoutMs=${TIMEOUT_MS} diff=${diff.split("\n").length} lines`);
try {
  for await (const m of query({
    prompt,
    options: {
      cwd,
      model: MODEL,
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: SCHEMA },
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_BUDGET,
      settingSources: [],
      persistSession: false,
      thinking: { type: "disabled" },
      abortController: abort,
      env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? mkdtempSync(path.join(os.tmpdir(), "claude-ci-")) },
    },
  })) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") log(`tool ${b.name} ${JSON.stringify(b.input).replaceAll(JSON.stringify(cwd + path.sep).slice(1, -1), "").slice(0, 120)}`);
    if (m.type === "result") result = m;
  }
} catch (err) {
  clearTimeout(timer);
  if (abort.signal.aborted) {
    log(`timeout after ${TIMEOUT_MS} ms`);
    process.stdout.write(`::error title=agent-review::timed out after ${TIMEOUT_MS} ms\n`);
    process.exit(124); // the conventional "timed out" status (same as GNU timeout)
  }
  // The SDK YIELDS the error result (error_max_turns, error_max_budget_usd…) and THEN throws. If we already hold a
  // result, fall through and report it below — it says exactly which bound was hit.
  if (result) log(`query ended with: ${String(err?.message ?? err).split("\n")[0]}`);
  else {
    log(`agent crashed: ${err?.message ?? err}`);
    process.stdout.write(`::error title=agent-review::${String(err?.message ?? err).split("\n")[0]}\n`);
    process.exit(2);
  }
}
clearTimeout(timer);
// #endregion

// #region report
// A result that is not "success" means the agent did NOT finish its review: that is an infrastructure failure (2),
// never a pass. Treating "could not review" as "nothing found" is the classic way an AI gate silently lets bugs through.
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const summary = (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
const cost = result?.total_cost_usd ?? 0;
log(`result subtype=${result?.subtype} turns=${result?.num_turns} cost=$${cost.toFixed(4)} in ${Date.now() - started} ms`);
out("cost_usd", cost.toFixed(4));

if (!result || result.subtype !== "success" || !result.structured_output) {
  const why = result ? `${result.subtype}: ${(result.errors ?? []).join("; ") || "no structured output"}` : "no result message";
  process.stdout.write(`::error title=agent-review::review incomplete (${why})\n`);
  out("verdict", "error");
  summary(`## Agent review\n\n:warning: The review did not complete (\`${why}\`). Treating as a failure, not a pass.\n`);
  process.exit(2);
}

const report = result.structured_output;
// GitHub workflow-command escaping: the message escapes % CR LF; a PROPERTY (file=, title=) must also escape ":" and
// ",", otherwise a title like "Injection: eval()" ends the property list early. GitHub decodes both on display.
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
for (const f of report.findings)
  process.stdout.write(`::${f.severity} file=${escProp(f.file)},line=${f.line},title=${escProp(f.title)}::${esc(f.detail)}\n`);

const errors = report.findings.filter((f) => f.severity === "error").length;
out("verdict", report.verdict);
out("errors", errors);
out("findings", report.findings.length);
summary(
  `## Agent review — ${report.verdict === "pass" ? ":white_check_mark: pass" : ":x: fail"}\n\n${report.summary}\n\n` +
    (report.findings.length
      ? `| severity | location | finding |\n|---|---|---|\n` + report.findings.map((f) => `| ${f.severity} | \`${f.file}:${f.line}\` | **${f.title}** — ${f.detail.replace(/\|/g, "\\|")} |`).join("\n") + "\n"
      : "_No findings._\n") +
    `\n<sub>${MODEL} · ${result.num_turns} turns · $${cost.toFixed(4)}</sub>\n`,
);
process.exit(errors > 0 || report.verdict === "fail" ? 1 : 0);
// #endregion
