/**
 * CONCEPT 49 — Deploy and CI headless
 *
 * Every tab so far ran an agent with a person watching. In CI and in production nobody is: no TTY, no one to answer a
 * permission prompt, no one to notice a run that loops or hangs. A HEADLESS agent has to be:
 *
 *   1. Scriptable       `claude -p --output-format json` or the SDK's query(): one process in, one JSON result out
 *   2. Machine-readable outputFormat (--json-schema): a typed verdict the pipeline can trust, not prose to regex
 *   3. Fail-closed      permissionMode "dontAsk": what is not pre-approved is DENIED at once, never a prompt that hangs
 *   4. Bounded          maxTurns, maxBudgetUsd, an AbortController timeout — each maps to a distinct EXIT CODE
 *   5. Reproducible     settingSources: [], persistSession: false, a temp CLAUDE_CONFIG_DIR, a clean env
 *   6. Deployable       a long-lived service: health/readiness probes, a concurrency cap (429), graceful SIGTERM drain
 *
 * The deliverables live in ci-kit/ (agent-review.mjs, worker.mjs, Dockerfile, workflows/*.yml): real files you copy
 * into a repository. This tab RUNS them the way a CI runner and a container platform would, on a small fixture repo.
 *
 * Routes: GET /facts, POST /headless, /ci, /limits, /deploy (all SSE), GET /files, GET /code.
 */
import { fork, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept49 = Router();

const MODEL = "haiku";
const LAB = path.resolve("deploy-lab");
const KIT = path.resolve("ci-kit");
const ROOT = process.cwd();

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const short = (s: string) =>
  s
    .replaceAll(LAB.replaceAll("\\", "\\\\"), "deploy-lab") // the JSON-escaped form, inside tool inputs
    .replaceAll(LAB, "deploy-lab")
    .replaceAll(LAB.replaceAll("\\", "/"), "deploy-lab")
    .replaceAll(ROOT.replaceAll("\\", "\\\\"), ".")
    .replaceAll(ROOT, ".")
    .replaceAll(ROOT.replaceAll("\\", "/"), ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…");
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The native Claude Code binary the SDK starts (the same one `claude -p` is): in the SDK's platform package. */
function cliPath() {
  const require = createRequire(import.meta.url);
  const from = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const suffix of ["", "-musl"]) {
    try {
      return from.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/${exe}`);
    } catch {}
  }
  throw new Error(`No Claude Code binary for ${process.platform}-${process.arch}`);
}

// ---------------------------------------------------------------------------------------------
// #region env
// A CI runner's environment is full of things the agent must not inherit: cloud credentials, GITHUB_TOKEN, and — when
// the job itself was started from Claude Code — CLAUDECODE / CLAUDE_CODE_* variables that make the child think it is a
// nested session (in our test that alone turned a valid API key into "Not logged in"). Build the env from an
// allow-list of OS plumbing, then add exactly what the job needs. Never spread process.env into a headless agent.
// ---------------------------------------------------------------------------------------------
function cleanEnv(extra: Record<string, string> = {}) {
  const safe = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL", "HOME", "USERPROFILE"];
  const base = Object.fromEntries(safe.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
  // With no API key the SDK falls back to the Claude Code login on this machine (HOME/USERPROFILE above); in real
  // CI there is no login, so the key comes from the platform's secret store.
  const key = process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {};
  return { ...base, ...key, ...extra } as Record<string, string>;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// #region fixture
// A tiny repository to review. "buggy" changes applyDiscount to treat 0-100 as a fraction (a 100x bug) and adds an
// eval() of user input; "clean" adds an input check. Each variant writes the NEW file and the unified diff that a CI
// job would get from `git diff origin/main...HEAD` (written as a file, so the lab does not need git).
// ---------------------------------------------------------------------------------------------
const BASE = `// Prices are in cents. percent is 0-100.
export function applyDiscount(price, percent) {
  return Math.round(price * (1 - percent / 100));
}

export function total(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`;
const VARIANTS = {
  buggy: {
    file: `// Prices are in cents. percent is 0-100.
export function applyDiscount(price, percent) {
  return Math.round(price - price * percent);
}

export function total(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function applyCoupon(price, couponJson) {
  const coupon = eval("(" + couponJson + ")");
  return applyDiscount(price, coupon.percent);
}
`,
    diff: `diff --git a/src/pricing.js b/src/pricing.js
--- a/src/pricing.js
+++ b/src/pricing.js
@@ -1,7 +1,12 @@
 // Prices are in cents. percent is 0-100.
 export function applyDiscount(price, percent) {
-  return Math.round(price * (1 - percent / 100));
+  return Math.round(price - price * percent);
 }

 export function total(items) {
   return items.reduce((sum, i) => sum + i.price * i.qty, 0);
 }
+
+export function applyCoupon(price, couponJson) {
+  const coupon = eval("(" + couponJson + ")");
+  return applyDiscount(price, coupon.percent);
+}
`,
  },
  clean: {
    file: `// Prices are in cents. percent is 0-100.
export function applyDiscount(price, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be 0-100");
  return Math.round(price * (1 - percent / 100));
}

export function total(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`,
    diff: `diff --git a/src/pricing.js b/src/pricing.js
--- a/src/pricing.js
+++ b/src/pricing.js
@@ -1,7 +1,8 @@
 // Prices are in cents. percent is 0-100.
 export function applyDiscount(price, percent) {
+  if (percent < 0 || percent > 100) throw new RangeError("percent must be 0-100");
   return Math.round(price * (1 - percent / 100));
 }

 export function total(items) {
   return items.reduce((sum, i) => sum + i.price * i.qty, 0);
 }
`,
  },
} as const;

/** A fresh run folder: repo/ (the checkout), config/ (CLAUDE_CONFIG_DIR) and runner/ (the files GitHub would give). */
function makeRun(name: string, variant: keyof typeof VARIANTS | "base" = "base") {
  let root = path.join(LAB, name);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // On Windows a folder stays locked while any process has it as cwd — e.g. a Bash command from an aborted job
    // that is still finishing. Use a fresh folder instead of failing the run.
    root = path.join(LAB, `${name}-${Date.now()}`);
  }
  const repo = path.join(root, "repo");
  const config = path.join(root, "config");
  const runner = path.join(root, "runner");
  for (const d of [path.join(repo, "src"), config, runner]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# shop\nPricing helpers. Prices are integers in cents.\n");
  writeFileSync(path.join(repo, "src", "pricing.js"), variant === "base" ? BASE : VARIANTS[variant].file);
  if (variant !== "base") writeFileSync(path.join(repo, "change.diff"), VARIANTS[variant].diff);
  return { root, repo, config, runner };
}
// #endregion

/** An SSE route: parse the body, stream every event with the time since the start, and always end cleanly. */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await body(parsed.data, abort, emit);
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: errText(err) });
    } finally {
      send("done", {});
      res.end();
    }
  };
}

/** The fields of a result message a pipeline actually branches on. */
const resultView = (r: Partial<SDKResultMessage> & Record<string, any>) => ({
  subtype: r.subtype,
  is_error: r.is_error,
  terminal_reason: r.terminal_reason,
  num_turns: r.num_turns,
  structured_output: r.structured_output,
  result: typeof r.result === "string" ? cut(short(r.result), 400) : undefined,
  errors: r.errors,
  permission_denials: (r.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: cut(short(JSON.stringify(d.tool_input)), 140) })),
  total_cost_usd: r.total_cost_usd,
  duration_ms: r.duration_ms,
});

// ---------------------------------------------------------------------------------------------
// GET /facts — the headless flags and the SDK options they map to, read live from the installed SDK
// ---------------------------------------------------------------------------------------------

concept49.get("/facts", (_req, res) => {
  try {
    const dir = path.resolve("node_modules/@anthropic-ai/claude-agent-sdk");
    const dts = readFileSync(path.join(dir, "sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const flat = (d: string) => d.split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join(" ").split(/ @(?:example|default)\b/)[0].replace(/\s+/g, " ").trim();
    // The LAST doc comment before `name?:` inside the Options type (the first ones belong to other types).
    const doc = (name: string) => {
      const opts = dts.slice(dts.indexOf("export declare type Options = {"));
      const d = opts.match(new RegExp(`\\/\\*\\*((?:(?!\\*\\/)[\\s\\S])*?)\\*\\/\\s*${name}\\??:`))?.[1];
      return d ? cut(flat(d), 260) : "";
    };
    res.json({
      sdkVersion: pkg.version,
      claudeCodeVersion: pkg.claudeCodeVersion,
      cli: short(cliPath()),
      flags: [
        { cli: "-p, --print", sdk: "query({ prompt })", doc: "Run once and exit: no TTY, no interactive UI. The SDK always runs Claude Code this way." },
        { cli: "--output-format json | stream-json", sdk: "(the message stream)", doc: "json: ONE result object on stdout. stream-json: every message as a JSON line (what the SDK reads internally)." },
        { cli: "--json-schema '<schema>'", sdk: "outputFormat: { type: 'json_schema', schema }", doc: doc("outputFormat") || "Structured output, validated: result.structured_output." },
        { cli: "--permission-mode dontAsk", sdk: "permissionMode: 'dontAsk'", doc: "Don't prompt for permissions, deny if not pre-approved — the only safe default when nobody can answer a prompt." },
        { cli: "--tools / --allowedTools", sdk: "tools / allowedTools", doc: "The pool the model may call, and what is auto-approved inside it (Concept 48)." },
        { cli: "--max-turns N", sdk: "maxTurns", doc: doc("maxTurns") },
        { cli: "--max-budget-usd X", sdk: "maxBudgetUsd", doc: doc("maxBudgetUsd") },
        { cli: "(timeout in your script)", sdk: "abortController", doc: "A wall-clock limit you own. The runner's job timeout is a last resort that kills without a report." },
        { cli: "--no-session-persistence", sdk: "persistSession: false", doc: doc("persistSession") },
        { cli: "--setting-sources ''", sdk: "settingSources: []", doc: doc("settingSources") },
        { cli: "CLAUDE_CONFIG_DIR=<tmp>", sdk: "env: { CLAUDE_CONFIG_DIR }", doc: "Claude Code's state (config, caches, transcripts) in a throw-away folder: nothing leaks between jobs." },
      ],
      exitCodes: [
        { code: 0, when: "result.subtype success (and, for a gate, no blocking findings)" },
        { code: 1, when: "the review succeeded and found blocking issues — the check fails on purpose" },
        { code: 2, when: "the agent did not finish: error_max_turns, error_max_budget_usd, error_during_execution, no structured output" },
        { code: 3, when: "finished, but permission_denials is not empty: the job needed a capability it was not granted" },
        { code: 124, when: "your AbortController timeout fired (GNU timeout's convention)" },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /headless — the same job two ways: the CLI in print mode, and the SDK. Both are headless; compare what you get.
// ---------------------------------------------------------------------------------------------

// #region scenario-headless
const FUNCS_SCHEMA = {
  type: "object",
  properties: { functions: { type: "array", items: { type: "string" } }, centsBased: { type: "boolean" } },
  required: ["functions", "centsBased"],
};
const FUNCS_TASK = "List the exported function names in src/pricing.js, and say whether prices are in cents.";

/** `claude -p` as a CI step would run it: argv in, stdout JSON out, the exit code decides the step. */
function runCli(args: string[], cwd: string, env: Record<string, string>, abort: AbortController) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    // stdin "ignore": in CI, stdin is often an open pipe; print mode would wait for piped input that never comes.
    const child = spawn(cliPath(), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const kill = () => child.kill();
    abort.signal.addEventListener("abort", kill, { once: true });
    child.on("close", (code) => { abort.signal.removeEventListener("abort", kill); resolve({ code, stdout, stderr, ms: Date.now() - t0 }); });
  });
}

concept49.post(
  "/headless",
  sseRoute(z.object({ format: z.enum(["json", "stream-json"]).default("json") }).strict(), async (b, abort, emit) => {
    const run = makeRun("headless");
    const env = cleanEnv({ CLAUDE_CONFIG_DIR: run.config });

    // 1. The CLI. Every option is a flag; the result is whatever lands on stdout.
    const args = [
      "-p", FUNCS_TASK,
      "--output-format", b.format, ...(b.format === "stream-json" ? ["--verbose"] : []),
      "--model", MODEL,
      "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
      "--permission-mode", "dontAsk",
      "--json-schema", JSON.stringify(FUNCS_SCHEMA),
      "--max-turns", "5", "--max-budget-usd", "0.05",
      "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
    ];
    emit("cli-start", { argv: ["claude", ...args.map((a) => (/[\s{"]/.test(a) || a === "" ? `'${a}'` : a))].join(" ") });
    const cli = await runCli(args, run.repo, env, abort);
    const lines = cli.stdout.split("\n").filter((l) => l.trim());
    const parsed = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const result = [...parsed].reverse().find((m) => m.type === "result") ?? {};
    emit("cli-end", {
      exitCode: cli.code,
      ms: cli.ms,
      stdoutLines: lines.length,
      lineTypes: parsed.map((m) => (m.subtype ? `${m.type}:${m.subtype}` : m.type)),
      firstLine: cut(short(lines[0] ?? ""), 300),
      stderr: cut(short(cli.stderr.trim()), 300),
      result: resultView(result),
    });

    // 2. The SDK. The same options as typed fields; the result is a typed message in the stream.
    const options: Options = {
      cwd: run.repo,
      model: MODEL,
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: FUNCS_SCHEMA },
      maxTurns: 5,
      maxBudgetUsd: 0.05,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      env,
      abortController: abort,
    };
    emit("sdk-start", { options: { ...options, env: "cleanEnv({ CLAUDE_CONFIG_DIR })", abortController: "AbortController", cwd: "deploy-lab/headless/repo" } });
    const t0 = Date.now();
    const types: string[] = [];
    let sdkResult: any = {};
    for await (const m of query({ prompt: FUNCS_TASK, options })) {
      types.push("subtype" in m && m.subtype ? `${m.type}:${m.subtype}` : m.type);
      if (m.type === "result") sdkResult = m;
    }
    emit("sdk-end", { ms: Date.now() - t0, messageTypes: types, exitCode: sdkResult.subtype === "success" ? 0 : 2, result: resultView(sdkResult) });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /ci — run ci-kit/agent-review.mjs exactly as a GitHub Actions step would: a child process with a clean env,
// GITHUB_STEP_SUMMARY / GITHUB_OUTPUT pointing at files, stdout (annotations) and stderr (logs) streamed, exit code read.
// ---------------------------------------------------------------------------------------------

// #region scenario-ci
concept49.post(
  "/ci",
  sseRoute(z.object({ variant: z.enum(["buggy", "clean"]).default("buggy") }).strict(), async (b, abort, emit) => {
    const run = makeRun(`ci-${b.variant}`, b.variant);
    const summaryFile = path.join(run.runner, "step_summary.md");
    const outputFile = path.join(run.runner, "output.txt");
    writeFileSync(summaryFile, "");
    writeFileSync(outputFile, "");
    const env = cleanEnv({
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      CLAUDE_CONFIG_DIR: run.config,
      REVIEW_MODEL: MODEL,
      REVIEW_MAX_TURNS: "6",
      REVIEW_MAX_BUDGET_USD: "0.10",
      REVIEW_TIMEOUT_MS: "120000",
    });
    const script = path.join(KIT, "agent-review.mjs");
    emit("step", { run: "node ci-kit/agent-review.mjs --diff change.diff", diff: VARIANTS[b.variant].diff, env: Object.keys(env).filter((k) => !/^(PATH|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/.test(k)) });

    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [script, "--diff", "change.diff", "--cwd", run.repo], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const lines = (stream: NodeJS.ReadableStream, kind: "stdout" | "stderr") => {
        let buf = "";
        stream.on("data", (c) => {
          buf += c;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop()!;
          for (const l of parts) if (l.trim()) emit(kind, { line: short(l) });
        });
        stream.on("end", () => buf.trim() && emit(kind, { line: short(buf) }));
      };
      lines(child.stdout, "stdout");
      lines(child.stderr, "stderr");
      const kill = () => child.kill();
      abort.signal.addEventListener("abort", kill, { once: true });
      child.on("close", (c) => { abort.signal.removeEventListener("abort", kill); resolve(c); });
    });
    emit("exit", {
      code,
      summary: readFileSync(summaryFile, "utf8"),
      outputs: Object.fromEntries(readFileSync(outputFile, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))),
    });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /limits — what a bounded run looks like when it hits each bound. Four unattended runs, each with one guard set
// tight on purpose, and the exit code a pipeline should give it. None of them hangs, none of them pretends to pass.
// ---------------------------------------------------------------------------------------------

// #region scenario-limits
/** The one place a pipeline turns a run's ending into its exit code. */
function exitCodeFor(r: any, timedOut: boolean) {
  if (timedOut) return { code: 124, why: "the wall-clock timeout fired (AbortController)" };
  if (!r || r.subtype !== "success") return { code: 2, why: `did not finish: ${r?.subtype ?? "no result"}` };
  if ((r.permission_denials ?? []).length) return { code: 3, why: `finished, but ${r.permission_denials.length} tool call(s) were denied — the job lacked a capability` };
  return { code: 0, why: "success" };
}

const SLOW = `node -e "setTimeout(()=>console.log('done'),30000)"`;
const LIMIT_LANES = [
  { id: "turns", title: "maxTurns: 1", prompt: "Read README.md, then read src/pricing.js, then summarize both in one line.", opts: { tools: ["Read"], allowedTools: ["Read"], maxTurns: 1 } },
  { id: "budget", title: "maxBudgetUsd: 0.0001", prompt: "Read src/pricing.js and explain every line in detail.", opts: { tools: ["Read"], allowedTools: ["Read"], maxBudgetUsd: 0.0001 } },
  { id: "timeout", title: "timeout: 8 s (AbortController)", prompt: `Run this exact Bash command and report its output: ${SLOW}`, opts: { tools: ["Bash"], allowedTools: ["Bash"] }, timeoutMs: 8000 },
  { id: "denied", title: "dontAsk: Write not pre-approved", prompt: "Create the file CHANGELOG.md containing '# v1.1 - discount fix'. Use the Write tool.", opts: { tools: ["Read", "Write"], allowedTools: ["Read"] } },
] satisfies { id: string; title: string; prompt: string; opts: Partial<Options>; timeoutMs?: number }[];

concept49.post(
  "/limits",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    // The four lanes are independent, so they run in parallel — just as parallel CI jobs would.
    await Promise.all(
      LIMIT_LANES.map(async (lane) => {
        const run = makeRun(`limits-${lane.id}`);
        const own = new AbortController();
        abort.signal.addEventListener("abort", () => own.abort(), { once: true });
        let timedOut = false;
        const t0 = Date.now();
        let abortedAt: number | undefined;
        const timer = lane.timeoutMs ? setTimeout(() => { timedOut = true; abortedAt = Date.now() - t0; own.abort(); }, lane.timeoutMs) : undefined;
        emit("lane-start", { lane: lane.id, title: lane.title, prompt: lane.prompt });
        let r: any;
        let thrown = "";
        try {
          for await (const m of query({
            prompt: lane.prompt,
            options: { cwd: run.repo, model: MODEL, permissionMode: "dontAsk", settingSources: [], persistSession: false, thinking: { type: "disabled" }, env: cleanEnv({ CLAUDE_CONFIG_DIR: run.config }), abortController: own, maxTurns: 6, ...lane.opts },
          })) {
            if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") emit("tool", { lane: lane.id, name: b.name, input: cut(short(JSON.stringify(b.input)), 160) });
            if (m.type === "result") r = m;
          }
        } catch (err) {
          // Two kinds of throw: after an error RESULT (max turns/budget — r is already set), and on abort (no result).
          thrown = errText(err);
        } finally {
          clearTimeout(timer);
        }
        emit("lane-end", { lane: lane.id, ms: Date.now() - t0, abortedAt, thrown: thrown && cut(thrown, 200), result: r ? resultView(r) : null, exit: exitCodeFor(r, timedOut) });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /deploy — run ci-kit/worker.mjs as a container platform would, and put it through its life cycle:
// start → probes → a long job → a second job while full (429) → SIGTERM while the long job runs → drain → exit.
// ---------------------------------------------------------------------------------------------

// #region scenario-deploy
const LONG_JOB = { prompt: `Run this exact Bash command and report its output in one line: node -e "setTimeout(()=>console.log('nightly report generated'),12000)"`, tools: ["Bash"] };
const QUICK_JOB = { prompt: "Reply with the single word: pong", tools: [] };

concept49.post(
  "/deploy",
  sseRoute(z.object({ drainMs: z.number().int().min(0).max(60000).default(3000) }).strict(), async (b, abort, emit) => {
    const run = makeRun("deploy");
    // fork(): a Node child with an IPC channel. execArgv: [] matters — otherwise the child inherits this server's
    // `--watch --import tsx` flags. The env is what the Dockerfile's ENV lines would set, plus the secret.
    const child = fork(path.join(KIT, "worker.mjs"), [], {
      cwd: ROOT,
      execArgv: [],
      env: cleanEnv({ PORT: "0", MAX_CONCURRENCY: "1", DRAIN_MS: String(b.drainMs), JOB_TIMEOUT_MS: "60000", MODEL, WORK_DIR: run.repo, CLAUDE_CONFIG_DIR: run.config }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    abort.signal.addEventListener("abort", () => child.kill(), { once: true });
    let buf = "";
    child.stdout!.on("data", (c) => {
      buf += c;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop()!;
      for (const l of parts) if (l.trim()) { try { emit("wlog", JSON.parse(l)); } catch { emit("wlog", { event: "stdout", line: short(l) }); } }
    });
    child.stderr!.on("data", (c) => emit("wlog", { event: "stderr", line: cut(short(String(c)), 300) }));

    try {
      const port = await Promise.race([
        new Promise<number>((resolve) => child.on("message", (m: any) => m?.type === "ready" && resolve(m.port))),
        exited.then((c) => { throw new Error(`worker exited with ${c} before it was ready`); }),
        sleep(20000).then(() => { throw new Error("worker not ready after 20 s"); }),
      ]);
      const base = `http://127.0.0.1:${port}`;
      const call = async (label: string, method: "GET" | "POST", p: string, body?: object) => {
        const t0 = Date.now();
        try {
          const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: abort.signal });
          const data = await r.json().catch(() => ({}));
          emit("http", { label, method, path: p, status: r.status, retryAfter: r.headers.get("retry-after"), body: data, ms: Date.now() - t0 });
          return r.status;
        } catch (err) {
          emit("http", { label, method, path: p, status: 0, body: { error: cut(errText((err as any)?.cause ?? err), 120) }, ms: Date.now() - t0 });
          return 0;
        }
      };

      emit("phase", { step: "1 · the platform probes the new instance" });
      await call("liveness", "GET", "/healthz");
      await call("readiness", "GET", "/readyz");

      emit("phase", { step: "2 · traffic: a long job, then a second job while the only slot is busy" });
      const long = call("long job", "POST", "/run", LONG_JOB);
      await sleep(1500);
      await call("second job (instance full)", "POST", "/run", QUICK_JOB);

      await sleep(2500);
      emit("phase", { step: `3 · the platform sends SIGTERM (rolling deploy / scale-in) — drain ${b.drainMs} ms` });
      // On Linux this is child.kill("SIGTERM"). Windows has no catchable SIGTERM between processes, so the worker also
      // accepts the same request over IPC and runs the identical graceful path.
      if (process.platform === "win32") child.send("shutdown");
      else child.kill("SIGTERM");
      await sleep(400);
      await call("readiness while draining", "GET", "/readyz");
      await call("new job while draining", "POST", "/run", QUICK_JOB);

      emit("phase", { step: "4 · the in-flight job ends: finished in time, or aborted at the drain deadline" });
      await long;
      const code = await Promise.race([exited, sleep(b.drainMs + 15000).then(() => "still running")]);
      emit("exit", { code, graceful: code === 0 });
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /files — the ci-kit deliverables, verbatim. GET /code — this file and the kit, cut at the #region markers.
// ---------------------------------------------------------------------------------------------

concept49.get("/files", (_req, res) => {
  const files = ["workflows/agent-review.yml", "workflows/claude-cli-headless.yml", "Dockerfile", "Dockerfile.dockerignore", "agent-review.mjs", "worker.mjs"];
  res.json(Object.fromEntries(files.map((f) => { try { return [f, readFileSync(path.join(KIT, f), "utf8").replaceAll("\r\n", "\n")]; } catch { return [f, "(missing)"]; } })));
});

const SOURCES = [fileURLToPath(import.meta.url), path.join(KIT, "agent-review.mjs"), path.join(KIT, "worker.mjs")];
concept49.get("/code", (_req, res) => {
  const out: Record<string, string> = {};
  for (const file of SOURCES) {
    const tag = path.basename(file).replace(/\.\w+$/, "").replace(/^49-deploy-ci-headless$/, "server");
    const src = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    for (const [, name, c] of src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)) out[`${tag}:${name}`] = c.trimEnd();
  }
  res.json(out);
});
