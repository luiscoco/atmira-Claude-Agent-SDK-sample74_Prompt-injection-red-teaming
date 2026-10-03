import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import {
  acquireLease, continuePrompt, designInfo, designs, effectFor, effectKey, FileSessionStore, heartbeatMs, jobCostUsd, JournalFiles, leaseTtlMs,
  Ledger, limits, newJournal, nextAction, policyDecision, policyText, refundById, refunds, releaseLease, remaining, simulate, startPrompt,
  systemPrompt, type Journal, type Outcome, type Segment,
} from "../durable/workshop.js";

export const concept60 = Router();

// Everything durable lives under durable-lab/: journals, the ledger and the session store. config/ is the worker's
// local CLAUDE_CONFIG_DIR, the part a recreated container loses.
const LAB = path.resolve("durable-lab");
const journals = new JournalFiles(path.join(LAB, "jobs"));
const ledger = new Ledger(path.join(LAB, "ledger.jsonl"));
const store = new FileSessionStore(path.join(LAB, "store"));
const CONFIG = path.join(LAB, "config"), WORK = path.join(LAB, "work");
const MODEL = "claude-haiku-4-5";
/** This process's worker id. A restarted server is a new worker: it must wait for the old lease to expire. */
const WORKER = `worker-${process.pid}-${randomUUID().slice(0, 4)}`;
const running = new Set<string>(); // jobs this process is driving now

concept60.get("/facts", (_req, res) => res.json({
  refunds: refunds.map((refund) => ({ ...refund, expected: policyDecision(refund) })), policyText, systemPrompt, designs, designInfo, limits,
  leaseTtlMs, heartbeatMs, model: MODEL, worker: WORKER, liveAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
}));
concept60.get("/code", (_req, res) => res.json({
  "60-durable-agents.ts": readFileSync(new URL("./60-durable-agents.ts", import.meta.url), "utf8"),
  "workshop.ts": readFileSync(new URL("../durable/workshop.ts", import.meta.url), "utf8"),
}));
concept60.get("/simulate", (req, res) => {
  const parsed = z.coerce.number().int().min(1).max(refunds.length).safeParse(req.query.crashAfter ?? 3);
  if (!parsed.success) return res.status(400).json({ message: "crashAfter must be an integer from 1 to 8." });
  res.json(designs.map((design) => simulate(design, parsed.data)));
});

/** GET /policy: what nextAction() really decides for typical situations (3 of 8 settled unless stated). */
concept60.get("/policy", (_req, res) => {
  const at = (settled: number, extra: Partial<Journal> = {}, history: number[] = [settled]): Journal => {
    const journal = newJournal("example", 0);
    for (const refund of refunds.slice(0, settled)) journal.settled[refund.id] = { decision: "approve", reason: "", at: 0, segment: 1 };
    journal.segments = history.map((value, i) => ({ n: i + 1, mode: "resume", outcome: "", settledAfter: value }));
    return { ...journal, ...extra };
  };
  const cases: { situation: string; journal: Journal; outcome: Outcome }[] = [
    { situation: "segment hit maxTurns", journal: at(3, { sessionId: "s" }), outcome: { kind: "result", subtype: "error_max_turns", terminalReason: "max_turns" } },
    { situation: "segment hit its maxBudgetUsd", journal: at(3, { sessionId: "s" }), outcome: { kind: "result", subtype: "error_max_budget_usd", terminalReason: "budget_exhausted" } },
    { situation: "agent said DONE too early", journal: at(3, { sessionId: "s" }), outcome: { kind: "result", subtype: "success", terminalReason: "completed" } },
    { situation: "worker killed, session id journaled", journal: at(3, { sessionId: "s" }), outcome: { kind: "crash" } },
    { situation: "worker killed before the first message", journal: at(0, {}, [0]), outcome: { kind: "crash" } },
    { situation: "API error (first time)", journal: at(3, { sessionId: "s" }), outcome: { kind: "error", message: "529 overloaded" } },
    { situation: "API error again", journal: at(3, { sessionId: "s", attempts: 1 }), outcome: { kind: "error", message: "529 overloaded" } },
    { situation: `API error, ${limits.maxAttempts} attempts already failed`, journal: at(3, { sessionId: "s", attempts: limits.maxAttempts }), outcome: { kind: "error", message: "529 overloaded" } },
    { situation: "session cannot be loaded", journal: at(3, { sessionId: "s" }), outcome: { kind: "error", message: "No conversation found with session ID s" } },
    { situation: "two segments without progress", journal: at(3, { sessionId: "s" }, [1, 3, 3, 3]), outcome: { kind: "result", subtype: "error_max_turns" } },
    { situation: `job budget ($${limits.jobBudgetUsd.toFixed(2)}) spent`, journal: at(3, { sessionId: "s", sessionCostUsd: { s: limits.jobBudgetUsd } }), outcome: { kind: "result", subtype: "error_max_turns" } },
    { situation: "all 8 settled", journal: at(8, { sessionId: "s" }), outcome: { kind: "result", subtype: "error_max_turns" } },
  ];
  res.json(cases.map(({ situation, outcome, journal }) => ({ situation, outcome, ...nextAction(journal, outcome) })));
});

/** Journals with a summary of what each can tell an operator: progress, owner, cost, and whether it is an orphan. */
function view(journal: Journal, now = Date.now()) {
  const effects = ledger.entries().filter((row) => row.jobId === journal.jobId);
  const correct = Object.entries(journal.settled).filter(([id, row]) => row.decision === policyDecision(refundById(id)!).decision).length;
  return {
    ...journal, settledCount: Object.keys(journal.settled).length, total: refunds.length, correct, costUsd: jobCostUsd(journal), effects,
    leaseLive: Boolean(journal.lease && journal.lease.expiresAt > now), drivenHere: running.has(journal.jobId),
    orphan: journal.status === "running" && !running.has(journal.jobId) && !(journal.lease && journal.lease.expiresAt > now),
  };
}
concept60.get("/jobs", (_req, res) => res.json({ worker: WORKER, jobs: journals.list().map((journal) => view(journal)) }));

/** POST /reset: delete every journal, the ledger and the store. Refused while a job runs here. */
concept60.post("/reset", (_req, res) => {
  if (running.size) return res.status(409).json({ message: "A job is running in this process. Stop it first." });
  rmSync(LAB, { recursive: true, force: true });
  res.json({ ok: true });
});

function agentEnv() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_DEFAULT_") && !["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].includes(key)));
  return { ...inherited, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } as Record<string, string>;
}

type Send = (event: string, data: unknown) => void;
type Drill = { crashAfter?: number; wipeLocal: boolean; applied: number }; // applied: new effects so far in this run

/**
 * The two tools. Both read and write the JOURNAL, not the model's memory: next_refund only returns unsettled refunds,
 * and settle_refund applies its side effect under an idempotency key before it journals the refund. A drill can kill
 * the worker between those two writes, the window that turns a retry into a double payment without the key.
 */
function refundTools(job: { journal: Journal; segment: number }, save: () => void, send: Send, crash: () => void, drill: Drill) {
  return createSdkMcpServer({ name: "refunds", version: "1.0.0", tools: [
    tool("next_refund", "Return the next refund request that is not settled yet, or say the batch is complete.", {}, async () => {
      const next = remaining(job.journal)[0];
      return { content: [{ type: "text", text: next ? JSON.stringify({ ...next, amount: `${(next.amountCents / 100).toFixed(2)} EUR` }) : `Batch complete: all ${refunds.length} refunds are settled.` }] };
    }),
    tool("settle_refund", "Settle one refund: approve (pays the customer) or reject (emails the customer). Give a short reason.", {
      refundId: z.string(), decision: z.enum(["approve", "reject"]), reason: z.string().max(200),
    }, async ({ refundId, decision, reason }) => {
      const refund = refundById(refundId);
      if (!refund) return { content: [{ type: "text", text: `Unknown refund ${refundId}.` }], isError: true };
      if (job.journal.settled[refundId]) return { content: [{ type: "text", text: `${refundId} is already settled. Call next_refund.` }] };
      // 1. The side effect, keyed by job + refund. The key comes from stable ids, so a retry produces the same key.
      const key = effectKey(job.journal.jobId, refundId);
      const effect = ledger.apply({ key, jobId: job.journal.jobId, refundId, effect: effectFor(refund, decision), at: Date.now() });
      send("effect", { refundId, decision, key, applied: effect.applied, effect: effect.applied ? effectFor(refund, decision) : effect.existing!.effect });
      if (effect.applied && ++drill.applied === drill.crashAfter) { crash(); throw new Error("worker killed (drill)"); } // 💥 effect done, journal not
      // 2. The journal write. Once this lands, next_refund never offers the refund again.
      job.journal.settled[refundId] = { decision, reason, at: Date.now(), segment: job.segment };
      save();
      return { content: [{ type: "text", text: effect.applied ? `${refundId} settled (${decision}).` : `${refundId} was already applied under key ${key} (a retry); recorded as settled, nothing was paid twice.` }] };
    }),
  ] });
}

/**
 * drive(): the supervisor. It holds the lease (renewed by a heartbeat), runs the job as a series of query() segments
 * bounded by maxTurns and maxBudgetUsd, journals each segment, and asks nextAction() what to do after each segment,
 * crash or error. Every decision is persisted before it is acted on, so a restarted server can pick the job up.
 */
async function drive(jobId: string, send: Send, signal: AbortSignal, drill: Drill, segmentTurns: number) {
  const loaded = journals.load(jobId);
  if (!loaded) throw new Error(`No journal for ${jobId}.`);
  const lease = acquireLease(loaded, WORKER, Date.now());
  if (!lease.ok) { send("lease", { ok: false, why: lease.why }); return; }
  const job = { journal: lease.journal, segment: loaded.segments.length };
  // A segment still "running" in the journal belonged to a worker that died without writing its end.
  for (const segment of job.journal.segments) if (segment.outcome === "running") segment.outcome = "abandoned: the worker died mid-segment";
  const save = () => { journals.save(job.journal); send("journal", view(job.journal)); };
  save(); send("lease", { ok: true, owner: WORKER, why: lease.why });
  running.add(jobId);
  const heartbeat = setInterval(() => {
    const renewed = acquireLease(job.journal, WORKER, Date.now());
    if (renewed.ok) { job.journal = { ...job.journal, lease: renewed.journal.lease }; journals.save(job.journal); send("heartbeat", { expiresAt: renewed.journal.lease!.expiresAt }); }
  }, heartbeatMs);
  let mode: Segment["mode"] = job.journal.sessionId ? "resume" : "start";
  try {
    while (!signal.aborted) {
      job.segment++;
      const before = Object.keys(job.journal.settled).length;
      const controller = new AbortController(); const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      let crashed = false;
      const crash = () => { crashed = true; drill.crashAfter = undefined; setImmediate(() => controller.abort()); };
      const resume = mode === "resume" || mode === "retry" ? job.journal.sessionId : undefined;
      if (mode === "fresh") job.journal.sessionId = undefined;
      const options: Options = {
        model: MODEL, systemPrompt, tools: [], settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", thinking: { type: "disabled" },
        mcpServers: { refunds: refundTools(job, save, send, crash, drill) }, allowedTools: ["mcp__refunds__next_refund", "mcp__refunds__settle_refund"],
        maxTurns: segmentTurns, maxBudgetUsd: 0.15, cwd: WORK, env: agentEnv(), abortController: controller,
        // The transcript is mirrored to the store on every frame ("eager"): "batched" flushes at the end of a turn, and a
        // worker killed mid-turn would lose that turn's lines. On resume, the SDK load()s the store, not the local disk.
        sessionStore: store, sessionStoreFlush: "eager",
        ...(resume ? { resume } : {}),
      };
      const prompt = mode === "start" ? startPrompt(jobId) : continuePrompt(job.journal);
      send("segment", { n: job.segment, mode, resume: resume ?? null, prompt, maxTurns: segmentTurns });
      let outcome: Outcome = { kind: "error", message: "the stream ended without a result" };
      const segment: Segment = { n: job.segment, mode, outcome: "running", settledAfter: before };
      job.journal.segments.push(segment); save(); // journaled before it runs: a dead worker leaves a visible trace
      const q = query({ prompt, options });
      try {
        for await (const message of q) {
          if ("session_id" in message && message.session_id && message.session_id !== job.journal.sessionId) {
            job.journal.sessionId = message.session_id; segment.sessionId = message.session_id; save(); // journal the id at once: a crash right after still finds it
          }
          if (message.type === "assistant") for (const block of message.message.content)
            if (block.type === "tool_use") send("tool", { name: block.name.replace("mcp__refunds__", ""), input: block.input });
          if (message.type === "result") {
            outcome = { kind: "result", subtype: message.subtype, terminalReason: message.terminal_reason, errors: message.subtype === "success" ? [] : message.errors };
            segment.turns = message.num_turns; segment.reportedCostUsd = message.total_cost_usd; segment.terminalReason = message.terminal_reason;
            const id = message.session_id;
            job.journal.sessionCostUsd[id] = Math.max(job.journal.sessionCostUsd[id] ?? 0, message.total_cost_usd);
          }
        }
      } catch (error) {
        // At a limit the SDK yields the error result AND then throws ("Claude Code returned an error result: Reached
        // maximum number of turns"). The result already says what happened; keep it instead of calling it an error.
        if (outcome.kind !== "result") outcome = crashed ? { kind: "crash" } : { kind: "error", message: String(error) };
      } finally { q.close(); signal.removeEventListener("abort", stop); }
      if (crashed) outcome = { kind: "crash" };
      if (signal.aborted && !crashed) { segment.outcome = "stopped by the operator"; segment.settledAfter = Object.keys(job.journal.settled).length; save(); break; }
      if (crashed) {
        send("crash", { segment: job.segment, wipeLocal: drill.wipeLocal });
        // A recreated container: the worker's local transcripts are gone. Only the session store still has them.
        if (drill.wipeLocal) rmSync(path.join(CONFIG, "projects"), { recursive: true, force: true });
      }
      segment.outcome = outcome.kind === "result" ? outcome.subtype : outcome.kind === "crash" ? "crash" : `error: ${outcome.message.slice(0, 160)}`;
      segment.settledAfter = Object.keys(job.journal.settled).length;
      const progressed = segment.settledAfter > before;
      if (progressed || outcome.kind !== "error" && !(outcome.kind === "result" && outcome.subtype === "error_during_execution")) job.journal.attempts = 0;
      else job.journal.attempts++;
      const next = nextAction(job.journal, outcome);
      segment.action = next.action; segment.why = next.why;
      if (next.action === "done") job.journal.status = "done";
      if (next.action === "fail") { job.journal.status = "failed"; job.journal.error = next.why; }
      save(); send("decision", { segment: job.segment, ...next });
      if (next.action === "done" || next.action === "fail") break;
      mode = next.action;
      if (next.delayMs) await new Promise<void>((resolve) => { const t = setTimeout(resolve, next.delayMs); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
    }
  } finally {
    clearInterval(heartbeat); running.delete(jobId);
    // A clean stop releases the lease so another worker can continue at once. A crashed PROCESS never gets here;
    // its lease simply expires after leaseTtlMs.
    job.journal = releaseLease(journals.load(jobId) ?? job.journal, WORKER); journals.save(job.journal); send("journal", view(job.journal));
  }
}

const runSchema = z.object({
  crashAfter: z.number().int().min(1).max(refunds.length).optional(),
  wipeLocal: z.boolean().default(false),
  segmentTurns: z.number().int().min(3).max(30).default(6),
}).strict();

/** POST /run: start a new job (billed). An optional drill kills the worker after the Nth side effect, then recovery runs. */
concept60.post("/run", async (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  if (running.size) return res.status(409).json({ message: "A lesson 60 job is already running in this process." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env (they use an isolated config directory, not your CLI login)." });
  mkdirSync(WORK, { recursive: true });
  const journal = newJournal(`job-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 4)}`);
  journals.save(journal);
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "300-second host deadline reached. The job stays resumable." }); abort.abort(); }, 300_000);
  try {
    send("start", { jobId: journal.jobId, worker: WORKER, ...parsed.data });
    await drive(journal.jobId, send, abort.signal, { crashAfter: parsed.data.crashAfter, wipeLocal: parsed.data.wipeLocal, applied: 0 }, parsed.data.segmentTurns);
  } catch (error) { if (!abort.signal.aborted) send("error", { message: String(error) }); }
  finally { clearTimeout(deadline); if (!res.destroyed) { send("done", {}); res.end(); } }
});

/** POST /recover: pick up a job that no live worker holds: stopped, cut off by a deadline, or left by a restarted server. */
concept60.post("/recover", async (req, res) => {
  const parsed = z.object({ jobId: z.string().regex(/^[\w-]+$/), segmentTurns: z.number().int().min(3).max(30).default(6) }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  const journal = journals.load(parsed.data.jobId);
  if (!journal) return res.status(404).json({ message: "No such job." });
  if (journal.status !== "running") return res.status(409).json({ message: `The job is ${journal.status}.` });
  if (running.has(journal.jobId)) return res.status(409).json({ message: "This process is already driving the job." });
  const lease = acquireLease(journal, WORKER, Date.now());
  if (!lease.ok) return res.status(409).json({ message: `Lease refused: ${lease.why}.` });
  if (running.size) return res.status(409).json({ message: "Another lesson 60 job is running in this process." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env." });
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "300-second host deadline reached. The job stays resumable." }); abort.abort(); }, 300_000);
  try {
    send("start", { jobId: journal.jobId, worker: WORKER, recover: true });
    await drive(journal.jobId, send, abort.signal, { wipeLocal: false, applied: 0 }, parsed.data.segmentTurns);
  } catch (error) { if (!abort.signal.aborted) send("error", { message: String(error) }); }
  finally { clearTimeout(deadline); if (!res.destroyed) { send("done", {}); res.end(); } }
});
