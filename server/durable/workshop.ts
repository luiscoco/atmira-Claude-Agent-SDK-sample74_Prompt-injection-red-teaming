import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

/**
 * Lesson 60's pure part: a refund batch, the policy that grades it, and the four pieces that make a long agent run
 * durable: a journal (what is done, written atomically), a ledger with idempotency keys (each side effect lands once),
 * a lease with a heartbeat (one worker per job), and a supervisor policy (after each segment, crash or error: what
 * next). Nothing here starts Claude Code; concepts/60-durable-agents.ts drives real query() segments with them.
 */

// ---------------------------------------------------------------------------------------------
// The work: eight refund requests and the policy the agent must apply.
// ---------------------------------------------------------------------------------------------
export type Refund = { id: string; customer: string; amountCents: number; daysSincePurchase: number; condition: "unused" | "used" };
export const refunds: Refund[] = [
  { id: "R-101", customer: "Lena", amountCents: 4_999, daysSincePurchase: 3, condition: "unused" },
  { id: "R-102", customer: "Omar", amountCents: 25_000, daysSincePurchase: 10, condition: "unused" },
  { id: "R-103", customer: "Ines", amountCents: 1_250, daysSincePurchase: 45, condition: "unused" },
  { id: "R-104", customer: "Pau", amountCents: 8_900, daysSincePurchase: 12, condition: "used" },
  { id: "R-105", customer: "Sara", amountCents: 20_000, daysSincePurchase: 30, condition: "unused" },
  { id: "R-106", customer: "Theo", amountCents: 19_999, daysSincePurchase: 31, condition: "unused" },
  { id: "R-107", customer: "Ana", amountCents: 650, daysSincePurchase: 1, condition: "unused" },
  { id: "R-108", customer: "Marc", amountCents: 32_000, daysSincePurchase: 60, condition: "used" },
];
export const refundById = (id: string) => refunds.find((refund) => refund.id === id);
export type Decision = "approve" | "reject";

/** The policy, as code. The agent gets it as text; the tests and the grader use this. 30 days and 200.00 EUR are inclusive. */
export const policyText = "Approve a refund only when the purchase was at most 30 days ago, the amount is at most 200.00 EUR and the item is unused. Otherwise reject it and name the rule it breaks.";
export function policyDecision(refund: Refund): { decision: Decision; broken: string[] } {
  const broken = [
    ...(refund.daysSincePurchase > 30 ? ["older than 30 days"] : []),
    ...(refund.amountCents > 20_000 ? ["over 200.00 EUR"] : []),
    ...(refund.condition !== "unused" ? ["item used"] : []),
  ];
  return { decision: broken.length ? "reject" : "approve", broken };
}

// ---------------------------------------------------------------------------------------------
// Piece 1: the journal. The source of truth for progress, outside the agent and outside the transcript.
// ---------------------------------------------------------------------------------------------
export type Segment = {
  n: number; mode: "start" | "resume" | "fresh" | "retry"; sessionId?: string;
  outcome: string; terminalReason?: string; turns?: number; reportedCostUsd?: number; settledAfter: number; action?: string; why?: string;
};
export type Journal = {
  jobId: string; createdAt: number; status: "running" | "done" | "failed";
  sessionId?: string;
  lease?: { owner: string; expiresAt: number };
  settled: Record<string, { decision: Decision; reason: string; at: number; segment: number }>;
  segments: Segment[];
  /** Consecutive failed attempts (errors, not crashes or normal segment ends). Reset by any progress. */
  attempts: number;
  /** total_cost_usd is cumulative per session, so keep the highest value seen for each session and sum them. */
  sessionCostUsd: Record<string, number>;
  error?: string;
};
export const newJournal = (jobId: string, now = Date.now()): Journal =>
  ({ jobId, createdAt: now, status: "running", settled: {}, segments: [], attempts: 0, sessionCostUsd: {} });
export const remaining = (journal: Journal) => refunds.filter((refund) => !journal.settled[refund.id]);
export const jobCostUsd = (journal: Journal) => Object.values(journal.sessionCostUsd).reduce((sum, cost) => sum + cost, 0);

/** One JSON file per job. save() writes a temporary file and renames it: a crash mid-write leaves the old journal, never half of one. */
export class JournalFiles {
  constructor(readonly root: string) {}
  private file(jobId: string) {
    if (!/^[\w-]+$/.test(jobId)) throw new Error(`unsafe job id ${JSON.stringify(jobId)}`);
    return path.join(this.root, `${jobId}.json`);
  }
  load(jobId: string): Journal | undefined {
    const file = this.file(jobId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  }
  save(journal: Journal) {
    mkdirSync(this.root, { recursive: true });
    const file = this.file(journal.jobId), temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(journal, null, 1));
    renameSync(temp, file);
  }
  list(): Journal[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(this.root, f), "utf8")) as Journal)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

// ---------------------------------------------------------------------------------------------
// Piece 2: the ledger. Every side effect carries an idempotency key built from stable ids, never from the model.
// ---------------------------------------------------------------------------------------------
export type Effect = { key: string; jobId: string; refundId: string; effect: string; at: number };
export const effectKey = (jobId: string, refundId: string) => `settle:${jobId}:${refundId}`;
export const effectFor = (refund: Refund, decision: Decision) => decision === "approve"
  ? `pay ${(refund.amountCents / 100).toFixed(2)} EUR to ${refund.customer}` : `email ${refund.customer} a rejection`;

/** An append-only JSONL file. apply() is "insert if the key is new": a retried call adds nothing and says so. */
export class Ledger {
  constructor(readonly file: string) {}
  entries(): Effect[] {
    return existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  }
  apply(effect: Effect): { applied: boolean; existing?: Effect } {
    const existing = this.entries().find((row) => row.key === effect.key);
    if (existing) return { applied: false, existing };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(effect) + "\n");
    return { applied: true };
  }
}

// ---------------------------------------------------------------------------------------------
// Piece 3: the lease. A job has at most one live worker; a dead worker's lease expires and another may take over.
// ---------------------------------------------------------------------------------------------
export const leaseTtlMs = 15_000, heartbeatMs = 5_000;
export function acquireLease(journal: Journal, owner: string, now: number, ttlMs = leaseTtlMs): { ok: true; journal: Journal; why: string } | { ok: false; why: string } {
  const lease = journal.lease;
  if (lease && lease.owner !== owner && lease.expiresAt > now)
    return { ok: false, why: `leased by ${lease.owner} for ${Math.ceil((lease.expiresAt - now) / 1000)} more s` };
  const why = !lease ? "no lease: taken" : lease.owner === owner ? "own lease: renewed" : `expired lease of ${lease.owner}: taken over`;
  return { ok: true, journal: { ...journal, lease: { owner, expiresAt: now + ttlMs } }, why };
}
export const releaseLease = (journal: Journal, owner: string): Journal =>
  journal.lease?.owner === owner ? { ...journal, lease: undefined } : journal;

// ---------------------------------------------------------------------------------------------
// Piece 4: the supervisor policy. Called after every segment, crash or error. Pure, so every branch has a test.
// ---------------------------------------------------------------------------------------------
export type Outcome =
  | { kind: "result"; subtype: string; terminalReason?: string; errors?: string[] }
  | { kind: "crash" }
  | { kind: "error"; message: string };
export type Action = { action: "done" | "resume" | "fresh" | "retry" | "fail"; why: string; delayMs: number };
export const limits = { maxSegments: 10, jobBudgetUsd: 0.6, maxAttempts: 3, stallSegments: 2 };
export const backoffMs = (attempt: number, baseMs = 1_000, capMs = 8_000) => Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
const sessionLost = /no conversation found|session .*not found|could not (load|find) session/i;

export function nextAction(journal: Journal, outcome: Outcome, limit = limits): Action {
  const left = remaining(journal).length;
  if (left === 0) return { action: "done", why: "every refund is settled in the journal", delayMs: 0 };
  if (journal.segments.length >= limit.maxSegments) return { action: "fail", why: `${limit.maxSegments}-segment limit reached with ${left} left`, delayMs: 0 };
  if (jobCostUsd(journal) >= limit.jobBudgetUsd) return { action: "fail", why: `job budget $${limit.jobBudgetUsd.toFixed(2)} spent with ${left} left`, delayMs: 0 };
  // Two segments in a row that settled nothing: more segments will not help. Stop and let a human look.
  const recent = journal.segments.slice(-limit.stallSegments - 1).map((segment) => segment.settledAfter);
  if (recent.length === limit.stallSegments + 1 && recent.every((value) => value === recent[0])) return { action: "fail", why: `no progress in ${limit.stallSegments} segments`, delayMs: 0 };
  if (outcome.kind === "crash") return journal.sessionId
    ? { action: "resume", why: "the worker died mid-segment: resume the same session (its transcript is in the session store)", delayMs: 0 }
    : { action: "fresh", why: "the worker died before a session id was journaled: start a new session from the journal", delayMs: 0 };
  const failed = outcome.kind === "error" || outcome.subtype === "error_during_execution";
  if (!failed) {
    const ended = outcome.subtype === "success" ? "the agent stopped early" : `the segment hit its limit (${outcome.terminalReason ?? outcome.subtype})`;
    return { action: "resume", why: `${ended} with ${left} left: resume the same session`, delayMs: 0 };
  }
  const message = outcome.kind === "error" ? outcome.message : (outcome.errors ?? []).join("; ");
  if (sessionLost.test(message)) return { action: "fresh", why: "the session cannot be loaded: start a new one, the journal says what is done", delayMs: 0 };
  const attempt = journal.attempts + 1;
  if (attempt > limit.maxAttempts) return { action: "fail", why: `${limit.maxAttempts} failed attempts in a row: ${message.slice(0, 120)}`, delayMs: 0 };
  // Retry the same session first; if it fails again, the session itself may be the problem, so start fresh.
  return attempt === 1
    ? { action: "retry", why: `error, attempt ${attempt}: retry the same session after a backoff (${message.slice(0, 80)})`, delayMs: backoffMs(attempt) }
    : { action: "fresh", why: `error, attempt ${attempt}: start a fresh session after a backoff`, delayMs: backoffMs(attempt) };
}

// ---------------------------------------------------------------------------------------------
// Prompts. The continuation prompt is rebuilt from the journal, so a fresh session knows as much as a resumed one.
// ---------------------------------------------------------------------------------------------
export const systemPrompt = [
  "You process a refund batch with two tools.",
  `Policy: ${policyText}`,
  "Loop: call next_refund, decide, call settle_refund for that refund with a short reason. Repeat until next_refund says the batch is complete, then reply DONE.",
  "Settle one refund per settle_refund call. Never skip a refund.",
].join("\n");
export const startPrompt = (jobId: string) => `Process refund batch ${jobId}.`;
export function continuePrompt(journal: Journal) {
  const done = Object.keys(journal.settled);
  return `Continue refund batch ${journal.jobId}. The job journal shows ${done.length} of ${refunds.length} refunds settled${done.length ? ` (${done.join(", ")})` : ""}. ` +
    "Call next_refund: it only returns refunds that are not settled yet.";
}

// ---------------------------------------------------------------------------------------------
// The offline simulation: the same crash under three designs. The crash lands in the classic window: the side
// effect has happened, the journal write has not.
// ---------------------------------------------------------------------------------------------
export const designs = ["naive", "journal", "durable"] as const;
export type Design = typeof designs[number];
export const designInfo: Record<Design, string> = {
  naive: "No journal, no keys. After a crash the job starts again from the first refund.",
  journal: "A journal records each settled refund. After a crash the job continues from the first refund the journal lacks.",
  durable: "Journal plus an idempotency key on every side effect. The ledger refuses a key it has already applied.",
};
export function simulate(design: Design, crashAfter: number) {
  const ledger = new Map<string, number>(); const journaled = new Set<string>(); const timeline: string[] = [];
  let issued = 0, applied = 0, suppressed = 0, crashed = false;
  for (let start = 0; ; ) {
    let crashedNow = false;
    for (const refund of refunds.slice(start)) {
      if (design !== "naive" && journaled.has(refund.id)) continue;
      issued++;
      const key = effectKey("sim", refund.id);
      if (design === "durable" && ledger.has(key)) { suppressed++; timeline.push(`${refund.id}: duplicate key, effect suppressed`); }
      else { ledger.set(key, (ledger.get(key) ?? 0) + 1); applied++; timeline.push(`${refund.id}: ${ledger.get(key)! > 1 ? "effect applied AGAIN" : "effect applied"}`); }
      if (!crashed && issued === crashAfter) { crashed = crashedNow = true; timeline.push(`💥 crash after ${refund.id}'s effect, before its journal write`); break; }
      journaled.add(refund.id);
    }
    if (!crashedNow) break;
    start = 0; timeline.push(design === "naive" ? "restart from the first refund" : "restart: skip what the journal has");
  }
  const duplicates = [...ledger.values()].reduce((sum, count) => sum + count - 1, 0);
  return { design, crashAfter, issued, applied, suppressed, duplicates, timeline };
}

// ---------------------------------------------------------------------------------------------
// A SessionStore on plain files (lesson 35's adapter, trimmed): the transcript outlives the worker's disk.
// ---------------------------------------------------------------------------------------------
export class FileSessionStore implements SessionStore {
  constructor(readonly root: string) {}
  private file(key: SessionKey) {
    const parts = [key.projectKey, key.sessionId, ...(key.subpath ? key.subpath.split("/") : [])];
    if (parts.some((p) => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) throw new Error(`unsafe key ${JSON.stringify(key)}`);
    const [projectKey, sessionId, ...sub] = parts;
    return sub.length ? path.join(this.root, projectKey, sessionId, ...sub) + ".jsonl" : path.join(this.root, projectKey, `${sessionId}.jsonl`);
  }
  private read(file: string): SessionStoreEntry[] {
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    const file = this.file(key); mkdirSync(path.dirname(file), { recursive: true });
    const seen = new Set(this.read(file).map((entry) => entry.uuid).filter(Boolean)); // uuid = idempotency key
    appendFileSync(file, entries.filter((entry) => !entry.uuid || !seen.has(entry.uuid)).map((entry) => JSON.stringify(entry) + "\n").join(""));
  }
  async load(key: SessionKey) { const file = this.file(key); return existsSync(file) ? this.read(file) : null; }
  async listSessions(projectKey: string) {
    const dir = path.join(this.root, projectKey);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ sessionId: f.slice(0, -6), mtime: Math.floor(statSync(path.join(dir, f)).mtimeMs) })) : [];
  }
  async listSubkeys(key: { projectKey: string; sessionId: string }) {
    const dir = path.join(this.root, key.projectKey, key.sessionId);
    return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6).replaceAll("\\", "/")) : [];
  }
}
