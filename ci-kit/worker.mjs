#!/usr/bin/env node
/**
 * worker.mjs — an Agent SDK service you can DEPLOY (Concept 49). This is the process the Dockerfile starts.
 *
 * What a deployed agent needs that a laptop script does not:
 *   GET  /healthz   liveness: the process is up (the orchestrator restarts it when this fails)
 *   GET  /readyz    readiness: it accepts work (503 while draining, so the load balancer stops sending jobs)
 *   POST /run       one agent job: { prompt, tools?, maxTurns? } -> { status, subtype, result, cost, ms }
 *   CONCURRENCY     each job is a Claude Code process; MAX_CONCURRENCY caps them, extra requests get 429 + Retry-After
 *   LIMITS          every job is bounded: maxTurns, maxBudgetUsd, and a wall-clock JOB_TIMEOUT_MS (AbortController)
 *   SHUTDOWN        SIGTERM (Kubernetes, Docker, Cloud Run…) -> stop accepting, let running jobs finish for DRAIN_MS,
 *                   then abort what is left, answer those requests 503, and exit 0 before the platform's SIGKILL
 *   LOGS            one JSON object per line on stdout — what log collectors (CloudWatch, Cloud Logging, Loki) ingest
 *
 * Env: PORT (8080), MAX_CONCURRENCY (2), DRAIN_MS (10000), JOB_TIMEOUT_MS (60000), JOB_MAX_BUDGET_USD (0.05), MODEL (haiku)
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// #region config
const PORT = Number(process.env.PORT ?? 8080);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 2);
const DRAIN_MS = Number(process.env.DRAIN_MS ?? 10_000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 60_000);
const JOB_MAX_BUDGET_USD = Number(process.env.JOB_MAX_BUDGET_USD ?? 0.05);
const MODEL = process.env.MODEL ?? "haiku";
// A container's filesystem is ephemeral and often read-only except /tmp: keep Claude Code's state there.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? mkdtempSync(path.join(os.tmpdir(), "claude-worker-"));
const WORK_DIR = process.env.WORK_DIR ?? process.cwd();

const log = (event, data = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");
// #endregion

// #region jobs
const running = new Map(); // id -> AbortController
let draining = false;
let served = 0;
let seq = 0;

async function runJob(id, body) {
  const abort = new AbortController();
  running.set(id, abort);
  const timer = setTimeout(() => abort.abort("timeout"), JOB_TIMEOUT_MS);
  const started = Date.now();
  const tools = Array.isArray(body.tools) ? body.tools : [];
  let result;
  try {
    for await (const m of query({
      prompt: String(body.prompt ?? ""),
      options: {
        cwd: WORK_DIR,
        model: MODEL,
        tools,
        allowedTools: tools,
        permissionMode: "dontAsk", // nobody is there to click "allow": deny anything not listed
        maxTurns: Math.min(Number(body.maxTurns ?? 4), 10),
        maxBudgetUsd: JOB_MAX_BUDGET_USD,
        settingSources: [],
        persistSession: false,
        thinking: { type: "disabled" },
        abortController: abort,
        env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
      },
    })) {
      if (m.type === "result") result = m;
    }
    const ms = Date.now() - started;
    return { http: result?.subtype === "success" ? 200 : 422, status: result?.subtype === "success" ? "ok" : "incomplete", subtype: result?.subtype, result: result?.subtype === "success" ? result.result : (result?.errors ?? []).join("; "), cost: result?.total_cost_usd, ms };
  } catch (err) {
    const ms = Date.now() - started;
    if (abort.signal.aborted) {
      const reason = abort.signal.reason === "shutdown" ? "cancelled: the worker is shutting down" : `timed out after ${JOB_TIMEOUT_MS} ms`;
      return { http: abort.signal.reason === "shutdown" ? 503 : 504, status: "aborted", reason, ms };
    }
    return { http: 500, status: "error", reason: String(err?.message ?? err).split("\n")[0], ms };
  } finally {
    clearTimeout(timer);
    running.delete(id);
  }
}
// #endregion

// #region http
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true, running: running.size, served, draining, pid: process.pid });
  if (req.method === "GET" && req.url === "/readyz") return draining ? send(res, 503, { ready: false, reason: "draining" }) : send(res, 200, { ready: true, free: MAX_CONCURRENCY - running.size });
  if (req.method === "POST" && req.url === "/run") {
    if (draining) return send(res, 503, { status: "rejected", reason: "draining" }, { connection: "close" });
    // Backpressure instead of an unbounded queue: each job is a whole Claude Code process (~100+ MB of RAM).
    if (running.size >= MAX_CONCURRENCY) { log("job.rejected", { reason: "busy", running: running.size }); return send(res, 429, { status: "rejected", reason: `busy: ${running.size}/${MAX_CONCURRENCY} jobs running` }, { "retry-after": "5" }); }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send(res, 400, { status: "error", reason: "invalid JSON" }); }
      const id = `job-${++seq}`;
      log("job.start", { id, tools: body.tools ?? [], running: running.size + 1 });
      const r = await runJob(id, body);
      served++;
      log("job.end", { id, status: r.status, subtype: r.subtype, reason: r.reason, ms: r.ms, cost: r.cost });
      send(res, r.http, { id, ...r, http: undefined });
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  const port = server.address().port;
  log("listening", { port, maxConcurrency: MAX_CONCURRENCY, drainMs: DRAIN_MS, model: MODEL });
  process.send?.({ type: "ready", port }); // when started by a parent with an IPC channel (the lab), tell it the port
});
// #endregion

// #region shutdown
// The platform sends SIGTERM, waits a grace period (Kubernetes: terminationGracePeriodSeconds, 30 s by default), then
// SIGKILLs. Use that window: refuse new work, let short jobs finish, abort long ones so their callers get a clean 503
// (and can retry elsewhere) instead of a reset connection, and exit 0. Aborting is not instant — the SDK waits for each
// Claude Code process to exit (seconds) — so DRAIN_MS plus that teardown must fit in the platform's grace period.
async function shutdown(signal) {
  if (draining) return;
  draining = true;
  log("shutdown.begin", { signal, running: running.size, drainMs: DRAIN_MS });
  // Keep LISTENING while draining: /readyz now answers 503, so the load balancer takes this instance out of rotation,
  // and a late POST /run gets a clear 503 instead of a refused connection. The listener closes at the very end.
  const deadline = Date.now() + DRAIN_MS;
  while (running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (running.size > 0) {
    log("shutdown.abort", { aborting: [...running.keys()] });
    for (const a of running.values()) a.abort("shutdown"); // AbortController -> the SDK stops its Claude Code process
    while (running.size > 0) await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 200)); // let the last responses flush
  server.close();
  log("shutdown.done", { served });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Windows has no real SIGTERM between processes (kill() terminates at once), so a parent with an IPC channel can ask
// for the same graceful path with a message. On Linux containers, SIGTERM above is what the platform uses.
process.on("message", (m) => m === "shutdown" && shutdown("ipc:shutdown"));
// #endregion
