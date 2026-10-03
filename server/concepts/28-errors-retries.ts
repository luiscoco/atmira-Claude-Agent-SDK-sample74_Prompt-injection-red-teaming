/**
 * CONCEPT 28 — Errors, retries & recovery: what a failure looks like, who retries it, and what your code should do
 *
 * Failures come from three places, and each one reaches your code in a different shape:
 *
 *   the API        Claude Code retries it by itself (system/api_retry). When the retries run out: a synthetic
 *                  assistant message with `error`, the StopFailure hook, a result with subtype "success" but
 *                  is_error: true and terminal_reason "api_error", and then the iterator THROWS.
 *   the run        a tool fails (is_error tool_result, PostToolUseFailure: the run goes on), maxTurns
 *                  (error_max_turns), interrupt() (error_during_execution), abort() (AbortError)
 *   the process    Claude Code cannot start: the iterator throws before any message
 *
 * To make API failures happen on demand, the lab puts a FAULT PROXY at ANTHROPIC_BASE_URL. It forwards every request
 * to the real API, except the ones its fault plan says to fail (529, 429, 500, 401, 400, a dropped connection, a
 * request that never answers).
 *
 * Routes: POST /api (SSE, a fault plan), POST /run (SSE, a run-level case), GET /code.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { AbortError, query, type HookCallback, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept28 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const FALLBACK = "claude-sonnet-4-5";
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

// The agent works in errors-lab/work. Its transcripts (needed to resume) go to a fake CLAUDE_CONFIG_DIR.
const LAB = path.resolve("errors-lab");
const WORK = path.join(LAB, "work");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [WORK, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(WORK, "a.txt"), "alpha\n");
writeFileSync(path.join(WORK, "b.txt"), "bravo\n");
const short = (s: string) => s.replaceAll(LAB, "errors-lab").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<proxy>");
/** True for `dir` itself or a path inside it (not a sibling folder that only starts with the same name). */
const inside = (dir: string, p: string) => {
  const r = path.relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r));
};

type Emit = (event: string, data: object) => void;

// #region proxy
// The fault proxy. Each run gets its own URL prefix (ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/f/<run id>), so
// each run has its own fault plan and its own log.
const Fault = z.enum(["529", "429", "500", "401", "400", "drop", "hang"]);
type Fault = z.infer<typeof Fault>;
const ERROR_TYPE: Record<string, string> = { "529": "overloaded_error", "429": "rate_limit_error", "500": "api_error", "401": "authentication_error", "400": "invalid_request_error" };

type Plan = { faults: Fault[]; repeatLast: boolean; onlyPrimary: boolean; retryAfter?: number };
type ProxyRun = { plan: Plan; used: number; seen: number; emit: Emit; hanging: Set<http.ServerResponse> };
const proxyRuns = new Map<string, ProxyRun>();

/** Claude Code also makes a small side call per run (its user text starts with "<session>"). Faults skip it. */
function isMainLoop(body: Buffer) {
  try {
    const first = JSON.parse(body.toString()).messages?.[0]?.content;
    return !String(typeof first === "string" ? first : first?.[0]?.text ?? "").startsWith("<session>");
  } catch {
    return false;
  }
}

const proxy = http.createServer(async (req, res) => {
  const m = req.url?.match(/^\/f\/([\w-]+)(\/.*)$/);
  const run = m ? proxyRuns.get(m[1]) : undefined;
  if (!m || !run) return res.writeHead(404).end();
  const rest = m[2];
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);

  const isMessages = req.method === "POST" && rest.startsWith("/v1/messages") && !rest.includes("count_tokens");
  let model = "";
  if (isMessages) try { model = JSON.parse(body.toString()).model; } catch {}
  const aux = isMessages && !isMainLoop(body);
  let fault: Fault | undefined;
  if (isMessages && !aux) run.seen++; // every main-loop request gets a number, whatever its model
  if (isMessages && !aux && (!run.plan.onlyPrimary || model === MODEL)) {
    const { faults, repeatLast } = run.plan;
    fault = run.used < faults.length ? faults[run.used++] : repeatLast ? faults.at(-1) : undefined;
  }
  const log = (action: string, status?: number) => isMessages && run.emit("proxy", { n: run.seen, aux, model, action, status });

  if (fault === "drop") return log("dropped the connection"), req.socket.destroy();
  if (fault === "hang") return log("never answers"), run.hanging.add(res);
  if (fault) {
    const headers: Record<string, string> = { "content-type": "application/json", "request-id": "req_lab_proxy" };
    if (fault === "429" && run.plan.retryAfter) headers["retry-after"] = String(run.plan.retryAfter);
    log(`injected ${fault}${headers["retry-after"] ? ` (retry-after: ${headers["retry-after"]})` : ""}`, Number(fault));
    res.writeHead(Number(fault), headers);
    return res.end(JSON.stringify({ type: "error", error: { type: ERROR_TYPE[fault], message: `Injected ${fault} by the lab proxy` } }));
  }

  // No fault: forward to the real API and stream the answer back.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  const upstream = new AbortController();
  res.on("close", () => upstream.abort());
  try {
    const up = await fetch(UPSTREAM + rest, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : body, signal: upstream.signal });
    log(aux ? "forwarded (side call)" : "forwarded", up.status);
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    if (up.body) Readable.fromWeb(up.body as any).on("error", () => res.destroy()).pipe(res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
  }
});
const proxyPort = new Promise<number>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as { port: number }).port)));

async function openProxyRun(plan: Plan, emit: Emit) {
  const id = randomUUID().slice(0, 8);
  const run: ProxyRun = { plan, used: 0, seen: 0, emit, hanging: new Set() };
  proxyRuns.set(id, run);
  return {
    baseUrl: `http://127.0.0.1:${await proxyPort}/f/${id}`,
    close: () => {
      for (const r of run.hanging) r.destroy();
      proxyRuns.delete(id);
    },
  };
}
// #endregion

// #region options
type Knobs = { baseUrl?: string; maxRetries?: number; apiTimeoutMs?: number; fallbackModel?: boolean };

function baseOptions(knobs: Knobs, emit: Emit, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  if (knobs.baseUrl) env.ANTHROPIC_BASE_URL = knobs.baseUrl; // every API call goes through the fault proxy
  if (knobs.maxRetries !== undefined) env.CLAUDE_CODE_MAX_RETRIES = String(knobs.maxRetries); // default 10
  if (knobs.apiTimeoutMs) env.API_TIMEOUT_MS = String(knobs.apiTimeoutMs); // how long one request may take
  return {
    model: MODEL,
    fallbackModel: knobs.fallbackModel ? FALLBACK : undefined, // used after 3 overloaded (529) answers in a row
    cwd: WORK,
    tools: ["Read", "Bash"],
    canUseTool: async (tool, input) =>
      tool === "Read" && inside(WORK, path.resolve(WORK, String(input.file_path ?? "")))
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Denied by the lab: only Read inside errors-lab/work." },
    hooks: {
      PostToolUseFailure: [{ hooks: [hook(emit)] }], // a tool call failed (the run goes on)
      StopFailure: [{ hooks: [hook(emit)] }], // the turn ended because of an API error
    },
    settingSources: [],
    persistSession: true, // so a failed run can be resumed
    thinking: { type: "disabled" },
    env,
    ...extra,
  };
}

function hook(emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name === "PostToolUseFailure") emit("hook", { name: input.hook_event_name, tool: input.tool_name, error: short(input.error).slice(0, 200), is_interrupt: input.is_interrupt });
    if (input.hook_event_name === "StopFailure") emit("hook", { name: input.hook_event_name, error: input.error, error_details: input.error_details, last: short(input.last_assistant_message ?? "").slice(0, 200) });
    return {};
  };
}
// #endregion

const optionsForBrowser = (knobs: Knobs, options: Options) => ({
  ...options,
  env: [
    "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'errors-lab/config'",
    knobs.baseUrl && "ANTHROPIC_BASE_URL: 'http://127.0.0.1:<proxy>/f/<run>'",
    knobs.maxRetries !== undefined && `CLAUDE_CODE_MAX_RETRIES: '${knobs.maxRetries}'`,
    knobs.apiTimeoutMs && `API_TIMEOUT_MS: '${knobs.apiTimeoutMs}'`,
  ].filter(Boolean).join(", ") + " }",
  canUseTool: "[Function: Read inside errors-lab/work only]",
  hooks: { PostToolUseFailure: "[Function hook]", StopFailure: "[Function hook]" },
  abortController: options.abortController && "[AbortController]",
  cwd: options.cwd && short(options.cwd),
  pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable && short(options.pathToClaudeCodeExecutable),
});

// #region classify
// What one query() call left behind, and what the host should do about it.
type Outcome = { result?: any; assistantError?: string; thrown?: unknown; retries: number; fallback?: string };
type Verdict = { where: "ok" | "api" | "run" | "process" | "you"; what: string; retry: "no" | "resume" | "fix first"; why: string };

const TRANSIENT = new Set(["overloaded", "rate_limit", "server_error", "unknown"]); // the outage may be over later
const FIX_FIRST = new Set(["authentication_failed", "oauth_org_not_allowed", "billing_error", "account_on_hold", "model_not_found", "invalid_request", "cloud_credential_error"]);

function classify(o: Outcome): Verdict {
  const r = o.result;
  const extra = [o.retries && `${o.retries} API retr${o.retries === 1 ? "y" : "ies"} by Claude Code`, o.fallback && `fell back to ${o.fallback}`].filter(Boolean).join(", ");
  if (o.thrown instanceof AbortError || (o.thrown instanceof Error && o.thrown.message === "Operation aborted"))
    return { where: "you", what: "AbortError", retry: "no", why: "Your code aborted the run." };
  if (!r) {
    const msg = String((o.thrown as Error)?.message ?? o.thrown);
    return { where: "process", what: "Claude Code did not start", retry: "fix first", why: /binary/.test(msg) ? "Check pathToClaudeCodeExecutable, and that cwd exists: a missing cwd shows the same 'failed to launch' message." : msg };
  }
  if (!r.is_error) return { where: "ok", what: "success", retry: "no", why: extra ? `It worked, after: ${extra}.` : "It worked." };
  if (r.subtype === "error_max_turns") return { where: "run", what: "error_max_turns", retry: "resume", why: "The work is saved in the session: resume it with a larger maxTurns." };
  if (r.subtype === "error_max_budget_usd") return { where: "run", what: "error_max_budget_usd", retry: "fix first", why: "Ask the user before spending more (Concept 15)." };
  if (r.subtype === "error_during_execution") return { where: "you", what: `error_during_execution (${r.terminal_reason})`, retry: "no", why: "The turn was interrupted: nothing failed." };
  if (r.terminal_reason === "api_error") {
    const e = o.assistantError ?? "unknown";
    // A 400 is tagged "unknown" too. The synthetic text starts with "API Error: <status>": a 4xx (but 408/429) will not heal.
    const status = Number(String(r.result ?? "").match(/API Error: (\d{3})/)?.[1]);
    if (status >= 400 && status < 500 && status !== 408 && status !== 429)
      return { where: "api", what: `${e} (HTTP ${status})`, retry: "fix first", why: "Claude Code did not retry it, and neither should you: the same request gets the same answer." };
    if (TRANSIENT.has(e)) return { where: "api", what: e, retry: "resume", why: `Transient, and Claude Code already retried it${extra ? ` (${extra})` : ""}. Wait, then resume the session.` };
    if (FIX_FIRST.has(e)) return { where: "api", what: e, retry: "fix first", why: "Retrying the same request gives the same answer: fix the key, the model or the request." };
    return { where: "api", what: e, retry: "no", why: "See the synthetic assistant message." };
  }
  return { where: "run", what: `${r.subtype} (${r.terminal_reason})`, retry: "no", why: (r.errors ?? []).join("; ") };
}
// #endregion

// #region messages
/** Turns each SDK message into a small event for the browser, and collects the Outcome. */
function relay(msg: SDKMessage, emit: Emit, o: Outcome) {
  const m = msg as any;
  if (m.type === "system") {
    if (m.subtype === "init") return emit("init", { model: m.model, session_id: m.session_id });
    if (m.subtype === "api_retry") {
      o.retries++;
      return emit("apiRetry", { attempt: m.attempt, max_retries: m.max_retries, retry_delay_ms: m.retry_delay_ms, error_status: m.error_status, error: m.error });
    }
    // Not in sdk.d.ts (0.3.281), but sent: { trigger, original_model, fallback_model, content }
    if (m.subtype === "model_fallback") {
      o.fallback = m.fallback_model;
      return emit("fallback", { trigger: m.trigger, original_model: m.original_model, fallback_model: m.fallback_model, content: m.content });
    }
    return;
  }
  if (m.type === "assistant") {
    if (m.error) o.assistantError = m.error; // set on the SYNTHETIC message Claude Code writes when the API fails
    for (const b of m.message.content) {
      if (b.type === "text") emit("assistant", { text: short(b.text).slice(0, 600), error: m.error, model: m.message.model });
      if (b.type === "tool_use") emit("toolUse", { name: b.name, input: b.input });
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { is_error: !!b.is_error, text: short(text).slice(0, 300) });
    }
    return;
  }
  if (m.type === "result") {
    o.result = m;
    emit("result", {
      subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason, stop_reason: m.stop_reason, num_turns: m.num_turns,
      cost: m.total_cost_usd, errors: m.errors, text: typeof m.result === "string" ? short(m.result).slice(0, 400) : undefined,
      permission_denials: m.permission_denials?.length ?? 0, models: Object.keys(m.modelUsage ?? {}),
    });
  }
}

/** One query() call: relays its messages, catches its throw, returns what happened. */
async function runOnce(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, emit: Emit, onQuery?: (q: ReturnType<typeof query>) => void) {
  const o: Outcome = { retries: 0 };
  try {
    const q = query({ prompt, options });
    onQuery?.(q);
    for await (const msg of q) relay(msg, emit, o);
    emit("finished", {});
  } catch (err) {
    o.thrown = err;
    emit("thrown", { name: err instanceof AbortError ? "AbortError" : (err as Error)?.constructor?.name, message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  }
  const verdict = classify(o);
  emit("verdict", verdict);
  return { o, verdict, sessionId: o.result?.session_id as string | undefined };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /api: API errors. A fault plan for the proxy, plus the knobs that change how Claude Code retries.
// ---------------------------------------------------------------------------------------------

const ApiBody = z
  .object({
    faults: z.array(Fault).max(6),
    repeatLast: z.boolean().optional(), // after the list, keep failing with the last fault
    onlyPrimary: z.boolean().optional(), // fail only requests for the primary model (so the fallback can work)
    retryAfter: z.number().int().min(1).max(10).optional(), // 429 only
    maxRetries: z.number().int().min(0).max(10).optional(),
    apiTimeoutMs: z.number().int().min(2000).max(60_000).optional(),
    fallbackModel: z.boolean().optional(),
    badModel: z.boolean().optional(), // ask for a model that does not exist (no proxy fault needed)
    hostRetries: z.number().int().min(0).max(2).optional(), // the host's own retry: resume the session after a transient error
  })
  .strict();

// #region recovery
// The host's own retry, ON TOP of Claude Code's: when the verdict says "resume", wait and resume the SAME session.
// The failed turn's prompt is already in the transcript, so the resumed prompt only says "Continue."
async function withRecovery(first: string, hostRetries: number, make: (extra: Partial<Options>) => Options, emit: Emit) {
  let out = await runOnce(first, make({}), emit);
  for (let attempt = 1; attempt <= hostRetries && out.verdict.retry === "resume" && out.sessionId; attempt++) {
    const delayMs = 2000 * attempt;
    emit("hostRetry", { attempt, of: hostRetries, delayMs, resume: out.sessionId });
    await new Promise((r) => setTimeout(r, delayMs));
    out = await runOnce("Continue.", make({ resume: out.sessionId }), emit);
  }
  return out;
}
// #endregion

concept28.post("/api", async (req, res) => {
  const parsed = ApiBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  if (!parsed.success) {
    send("error", { message: `Bad fault plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    send("done", {});
    return res.end();
  }
  const b = parsed.data;
  // A request that never answers needs a request timeout, or the run would wait for minutes.
  const apiTimeoutMs = b.apiTimeoutMs ?? (b.faults.includes("hang") ? 5000 : undefined);
  const proxyRun = await openProxyRun({ faults: b.faults, repeatLast: !!b.repeatLast, onlyPrimary: !!b.onlyPrimary, retryAfter: b.retryAfter }, emit);
  const knobs: Knobs = { baseUrl: proxyRun.baseUrl, maxRetries: b.maxRetries, apiTimeoutMs, fallbackModel: b.fallbackModel };
  const make = (extra: Partial<Options>) => baseOptions(knobs, emit, { tools: [], abortController: abort, ...(b.badModel ? { model: "claude-no-such-model" } : {}), ...extra });
  const prompt = "My code word is PELICAN. Reply in one line: noted, and the code word.";
  emit("opened", { prompt, options: optionsForBrowser(knobs, make({})) });
  try {
    await withRecovery(prompt, b.hostRetries ?? 0, make, emit);
  } finally {
    proxyRun.close();
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /run: errors that are not the API's: tools, limits, stopping, starting.
// ---------------------------------------------------------------------------------------------

const RunBody = z.object({ case: z.enum(["toolErrors", "maxTurns", "abort", "interrupt", "badExecutable", "badCwd"]) }).strict();

concept28.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: `Unknown case. Allowed: ${RunBody.shape.case.options.join(", ")}.` }), end();
  const c = parsed.data.case;
  const knobs: Knobs = {};
  const opened = (prompt: string, options: Options) => emit("opened", { prompt, options: optionsForBrowser(knobs, options) });
  // The browser disconnecting aborts `abort`; the "abort" case aborts `own` itself. Either one stops the run.
  const own = new AbortController();
  abort.signal.addEventListener("abort", () => own.abort());
  const timers: NodeJS.Timeout[] = [];
  try {
    if (c === "toolErrors") {
      const prompt = "Read the file missing.txt. If that fails, run the Bash command `dir`. If that fails too, read a.txt. Reply with its content only.";
      const options = baseOptions(knobs, emit, { abortController: own });
      opened(prompt, options);
      await runOnce(prompt, options, emit);
    }
    if (c === "maxTurns") {
      const prompt = "Read a.txt, then read b.txt, then reply with both words joined by a dash.";
      const options = baseOptions(knobs, emit, { abortController: own, maxTurns: 1 });
      opened(prompt, options);
      const first = await runOnce(prompt, options, emit);
      if (first.verdict.retry === "resume" && first.sessionId) {
        emit("hostRetry", { attempt: 1, of: 1, delayMs: 0, resume: first.sessionId, maxTurns: 6 });
        await runOnce("Continue where you stopped and give me the final answer.", baseOptions(knobs, emit, { abortController: own, maxTurns: 6, resume: first.sessionId }), emit);
      }
    }
    if (c === "abort") {
      const prompt = "Write a 250-word poem about the sea.";
      const options = baseOptions(knobs, emit, { abortController: own, tools: [] });
      opened(prompt, options);
      timers.push(setTimeout(() => (emit("call", { method: "abortController.abort()" }), own.abort()), 1500));
      await runOnce(prompt, options, emit);
    }
    if (c === "interrupt") {
      // interrupt() needs streaming input (Concept 12): an input stream that stays open.
      let close: () => void = () => {};
      const closed = new Promise<void>((r) => (close = r));
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: "Write a 250-word poem about the sea." } };
        await closed;
      }
      const options = baseOptions(knobs, emit, { abortController: own, tools: [] });
      opened("Write a 250-word poem about the sea.", options);
      await runOnce(input(), options, emit, (q) => {
        timers.push(
          setTimeout(async () => {
            emit("call", { method: "q.interrupt()" });
            await q.interrupt().catch(() => {});
            emit("call", { method: "the input stream ends (the session closes)" });
            close();
          }, 1500),
        );
      });
    }
    if (c === "badExecutable") {
      const options = baseOptions(knobs, emit, { abortController: own, pathToClaudeCodeExecutable: path.join(LAB, "no-such-claude.exe") });
      opened("hi", options);
      await runOnce("hi", options, emit);
    }
    if (c === "badCwd") {
      const options = baseOptions(knobs, emit, { abortController: own, cwd: path.join(LAB, "no-such-folder") });
      opened("hi", options);
      await runOnce("hi", options, emit);
    }
  } finally {
    timers.forEach(clearTimeout);
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept28.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
