import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import {
  acquireLease, backoffMs, continuePrompt, designs, effectKey, FileSessionStore, JournalFiles, Ledger, limits, newJournal, nextAction,
  policyDecision, refunds, releaseLease, simulate, type Journal, type Segment,
} from "./workshop.js";
import { concept60 } from "../concepts/60-durable-agents.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "lesson60-"));
after(() => rmSync(temp, { recursive: true, force: true }));

test("the policy key is computed rule by rule, with inclusive limits", () => {
  const expected = refunds.map((r) => (r.daysSincePurchase <= 30 && r.amountCents <= 20_000 && r.condition === "unused" ? "approve" : "reject"));
  assert.deepEqual(refunds.map((r) => policyDecision(r).decision), expected);
  assert.deepEqual(expected, ["approve", "reject", "reject", "reject", "approve", "reject", "approve", "reject"]);
  assert.equal(policyDecision(refunds.find((r) => r.id === "R-105")!).decision, "approve"); // exactly 30 days and 200.00 EUR
  assert.deepEqual(policyDecision(refunds.find((r) => r.id === "R-108")!).broken, ["older than 30 days", "over 200.00 EUR", "item used"]);
});

test("the simulation: only journal + idempotency keys survive a crash in the effect/journal window", () => {
  const [naive, journal, durable] = designs.map((design) => simulate(design, 3));
  assert.deepEqual([naive.duplicates, journal.duplicates, durable.duplicates], [3, 1, 0]);
  assert.equal(durable.suppressed, 1);
  assert.equal(durable.applied, refunds.length);
  for (let crashAfter = 1; crashAfter <= refunds.length; crashAfter++) {
    const run = simulate("durable", crashAfter);
    assert.equal(run.applied, refunds.length, `crashAfter ${crashAfter}`);
    assert.equal(run.duplicates, 0);
    assert.equal(simulate("journal", crashAfter).duplicates, 1); // the window costs exactly one double effect without keys
  }
});

test("the ledger applies a key once; the journal is written atomically", () => {
  const ledger = new Ledger(path.join(temp, "ledger.jsonl"));
  const row = { key: effectKey("j1", "R-101"), jobId: "j1", refundId: "R-101", effect: "pay", at: 1 };
  assert.equal(ledger.apply(row).applied, true);
  const again = ledger.apply({ ...row, at: 2 });
  assert.equal(again.applied, false);
  assert.equal(again.existing?.at, 1);
  assert.equal(ledger.entries().length, 1);
  const files = new JournalFiles(path.join(temp, "jobs"));
  const journal = newJournal("job-a", 10);
  files.save(journal); files.save({ ...journal, attempts: 2 });
  assert.equal(files.load("job-a")?.attempts, 2);
  assert.deepEqual(readdirSync(path.join(temp, "jobs")), ["job-a.json"]); // no temporary file left behind
  assert.throws(() => files.load("../escape"));
});

test("the lease: one live owner, renewal, takeover after expiry, release by the owner only", () => {
  const journal = newJournal("job-l", 0);
  const a = acquireLease(journal, "A", 1_000, 15_000);
  assert.ok(a.ok);
  const held = a.journal;
  const b = acquireLease(held, "B", 5_000, 15_000);
  assert.equal(b.ok, false);
  assert.match(b.why, /leased by A for 11 more s/);
  const renewed = acquireLease(held, "A", 10_000, 15_000);
  assert.ok(renewed.ok && renewed.journal.lease?.expiresAt === 25_000);
  const takeover = acquireLease(held, "B", 16_000, 15_000);
  assert.ok(takeover.ok && takeover.journal.lease?.owner === "B" && /taken over/.test(takeover.why));
  assert.equal(releaseLease(held, "B").lease?.owner, "A");
  assert.equal(releaseLease(held, "A").lease, undefined);
});

/** A journal with n refunds settled and the given segments (settledAfter values). */
function journalWith(n: number, settledAfter: number[] = [n], extra: Partial<Journal> = {}): Journal {
  const journal = newJournal("job-p", 0);
  for (const refund of refunds.slice(0, n)) journal.settled[refund.id] = { decision: "approve", reason: "", at: 0, segment: 1 };
  journal.segments = settledAfter.map((value, i): Segment => ({ n: i + 1, mode: "resume", outcome: "x", settledAfter: value }));
  return { ...journal, ...extra };
}

test("the supervisor policy covers done, resume, crash, fresh, retry, stall and the limits", () => {
  const ok = { kind: "result", subtype: "success" } as const;
  assert.equal(nextAction(journalWith(8), ok).action, "done");
  assert.equal(nextAction(journalWith(3, [3]), { kind: "result", subtype: "error_max_turns", terminalReason: "max_turns" }).action, "resume");
  assert.equal(nextAction(journalWith(3, [3]), ok).action, "resume"); // stopped early: nudge it on
  assert.equal(nextAction(journalWith(3, [3], { sessionId: "s" }), { kind: "crash" }).action, "resume");
  assert.equal(nextAction(journalWith(3, [3]), { kind: "crash" }).action, "fresh"); // no session id was journaled
  assert.equal(nextAction(journalWith(3, [3]), { kind: "error", message: "No conversation found with session ID abc" }).action, "fresh");
  const first = nextAction(journalWith(3, [3]), { kind: "error", message: "overloaded" });
  assert.deepEqual([first.action, first.delayMs], ["retry", 1_000]);
  assert.equal(nextAction(journalWith(3, [3], { attempts: 1 }), { kind: "error", message: "overloaded" }).action, "fresh");
  assert.equal(nextAction(journalWith(3, [3], { attempts: limits.maxAttempts }), { kind: "error", message: "overloaded" }).action, "fail");
  assert.equal(nextAction(journalWith(3, [1, 3, 3, 3]), ok).action, "fail"); // two segments without progress
  assert.equal(nextAction(journalWith(3, Array(limits.maxSegments).fill(0).map((_, i) => i)), ok).action, "fail");
  assert.equal(nextAction(journalWith(3, [3], { sessionCostUsd: { a: 0.4, b: 0.3 } }), ok).action, "fail"); // job budget
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(n)), [1_000, 2_000, 4_000, 8_000, 8_000]);
});

test("the continuation prompt is rebuilt from the journal; the file store round-trips and dedupes by uuid", async () => {
  assert.match(continuePrompt(journalWith(2)), /2 of 8 refunds settled \(R-101, R-102\)/);
  const store = new FileSessionStore(path.join(temp, "store"));
  const key = { projectKey: "work", sessionId: "s-1" };
  assert.equal(await store.load(key), null);
  await store.append(key, [{ type: "user", uuid: "u1" }, { type: "title" }]);
  await store.append(key, [{ type: "user", uuid: "u1" }, { type: "assistant", uuid: "u2" }]);
  assert.deepEqual((await store.load(key))!.map((entry) => entry.type), ["user", "title", "assistant"]);
  assert.deepEqual((await store.listSessions("work")).map((row) => row.sessionId), ["s-1"]);
  await assert.rejects(store.append({ projectKey: "..", sessionId: "x" }, []));
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c60", concept60);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c60`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("HTTP offline endpoints answer; malformed live requests fail before Claude Code starts", async () => {
  const facts = await (await fetch(`${base}/facts`)).json();
  assert.equal(facts.refunds.length, refunds.length);
  assert.equal(facts.refunds[4].expected.decision, "approve");
  assert.match((await (await fetch(`${base}/code`)).json())["workshop.ts"], /nextAction/);
  const sims = await (await fetch(`${base}/simulate?crashAfter=3`)).json();
  assert.deepEqual(sims.map((row: { duplicates: number }) => row.duplicates), [3, 1, 0]);
  assert.equal((await fetch(`${base}/simulate?crashAfter=9`)).status, 400);
  assert.equal((await fetch(`${base}/jobs`)).status, 200);
  assert.equal((await post("run", { crashAfter: 0 })).status, 400);
  assert.equal((await post("run", { segmentTurns: 6, model: "claude-opus-5-5" })).status, 400);
  assert.equal((await post("recover", { jobId: "../etc" })).status, 400);
  assert.equal((await post("recover", { jobId: "job-does-not-exist" })).status, 404);
});
