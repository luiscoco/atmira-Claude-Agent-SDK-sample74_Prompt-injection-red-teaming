import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { createScheduledRouter } from "../concepts/68-scheduled-event-driven.js";
import { guidedRunner, ScheduledWorkshop, signEvent, verifyEvent } from "./workshop.js";
import { readJsonResponse } from "../../src/lib/json-response.js";

test("frontend reports empty and invalid responses clearly and preserves JSON API errors", async () => {
  await assert.rejects(readJsonResponse(new Response("", { status: 502 })), /empty response.*502.*Refresh queue/);
  await assert.rejects(readJsonResponse(new Response("<html>Unavailable</html>", { status: 503 })), /invalid response.*503/);
  await assert.rejects(readJsonResponse(new Response('{"message":"Worker already busy."}', { status: 409 })), /409: Worker already busy/);
  assert.deepEqual(await readJsonResponse(new Response('{"worked":true}')), { worked: true });
});

test("schedule coalesces missed ticks and pause preserves queued work", () => {
  const queue = new ScheduledWorkshop(() => 0);
  queue.configure(10); assert.equal(queue.tick().enqueued, false);
  assert.deepEqual(queue.advance(35), { enqueued: true, skipped: 2 });
  assert.equal(queue.snapshot().schedule?.nextAt, 40_000);
  assert.equal(queue.tick().enqueued, false);
  queue.pause(); queue.advance(30); assert.equal(queue.snapshot().jobs.length, 1);
  assert.throws(() => queue.configure(0)); assert.throws(() => queue.advance(-1));
});
test("duplicates cannot queue twice and snapshots cannot mutate queue state", async () => {
  const queue = new ScheduledWorkshop(() => 0);
  queue.enqueue("event:a", "event", "incident");
  assert.equal(queue.enqueue("event:a", "event", "changed").duplicate, true);
  queue.snapshot().jobs[0].state = "succeeded";
  assert.equal(queue.snapshot().jobs[0].state, "queued");
  await queue.work(guidedRunner);
  assert.equal(queue.enqueue("event:a", "event", "again").duplicate, true);
  for (let i = 1; i < 100; i++) queue.enqueue(`event:${i}`, "event", "bounded");
  assert.throws(() => queue.enqueue("event:overflow", "event", "bounded"));
});
test("three failures use exponential retry delay then dead letter", async () => {
  const queue = new ScheduledWorkshop(() => 0), fail = async () => { throw new Error("offline"); };
  queue.enqueue("event:a", "event", "incident");
  await queue.work(fail); assert.equal(queue.snapshot().jobs[0].availableAt, 1000);
  assert.equal((await queue.work(fail)).worked, false);
  queue.advance(1); await queue.work(fail); assert.equal(queue.snapshot().jobs[0].availableAt, 3000);
  queue.advance(2); await queue.work(fail);
  assert.equal(queue.snapshot().jobs[0].state, "dead");
  queue.advance(20); assert.equal((await queue.work(guidedRunner)).worked, false);
});
test("HTTP state remains readable when a due schedule hits full queue history", async () => {
  let now = 0;
  const queue = new ScheduledWorkshop(() => now), app = express();
  queue.configure(10);
  for (let i = 0; i < 100; i++) queue.enqueue(`event:${i}`, "event", "bounded");
  now = 10_000;
  app.use("/api/c68", createScheduledRouter(queue));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c68`;
  try {
    const response = await fetch(base + "/state");
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.jobs.length, 100);
    assert.equal(state.schedule.nextAt, 10_000);
    const worked = await fetch(base + "/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "guided" }) });
    assert.equal((await worked.json()).job.state, "succeeded");
    assert.equal((await fetch(base + "/state")).status, 200);
    assert.throws(() => queue.enqueue("event:overflow", "event", "bounded"), /limit/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("one worker claims atomically; cancellation interrupts a runner", async () => {
  const queue = new ScheduledWorkshop(() => 0);
  const { job } = queue.enqueue("event:a", "event", "incident");
  let calls = 0;
  const pending = queue.work(async () => { calls++; return new Promise<string>(() => {}); });
  assert.equal(queue.snapshot().active, job.id);
  await assert.rejects(queue.work(guidedRunner), /busy/);
  queue.cancel(job.id); await pending;
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().jobs[0].state, "cancelled"); assert.equal(queue.snapshot().active, null);
  assert.throws(() => queue.cancel(job.id), /terminal/);
});
test("cancelling a claim before execution never invokes its runner", async () => {
  const queue = new ScheduledWorkshop(() => 0);
  const { job } = queue.enqueue("event:a", "event", "incident");
  let calls = 0;
  const pending = queue.work(async () => { calls++; return "should not run"; });
  queue.cancel(job.id); await pending;
  assert.equal(calls, 0); assert.equal(queue.snapshot().jobs[0].state, "cancelled");
});
test("deadline releases worker and records retry even if runner ignores abort", async () => {
  const queue = new ScheduledWorkshop(Date.now, 10);
  queue.enqueue("event:a", "event", "incident");
  await queue.work(async () => new Promise<string>(() => {}));
  assert.equal(queue.snapshot().active, null); assert.equal(queue.snapshot().jobs[0].state, "retry");
});
test("raw-body HMAC rejects tampering, stale timestamps and malformed signatures", () => {
  const now = 1_800_000_000_000, timestamp = String(now), raw = Buffer.from('{"x":1}'), signature = signEvent("secret", timestamp, raw);
  verifyEvent("secret", timestamp, signature, raw, now);
  assert.throws(() => verifyEvent("secret", timestamp, signature, Buffer.from('{"x":2}'), now));
  assert.throws(() => verifyEvent("secret", timestamp, signature, raw, now + 300_001));
  assert.throws(() => verifyEvent("secret", timestamp, "invalid", raw, now));
});
test("HTTP signed webhook admission, duplicate replay, strict validation and guided execution", async () => {
  const queue = new ScheduledWorkshop(), app = express();
  app.use("/api/c68", createScheduledRouter(queue, async () => { throw new Error("Live must not run"); }, "test-secret"));
  app.use(express.json());
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c68`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const f = await (await post("/fixture", { eventId: "incident-001", type: "incident.created", message: "Latency" })).json();
    const send = (raw = f.raw, signature = f.signature) => fetch(base + "/webhook", { method: "POST", headers: { "Content-Type": "application/json", "x-event-timestamp": f.timestamp, "x-event-signature": signature }, body: raw });
    assert.equal((await send(f.raw + " ")).status, 401);
    assert.equal((await send(f.raw, "bad")).status, 401);
    const accepted = await send(); assert.equal(accepted.status, 202); assert.equal((await accepted.json()).duplicate, false);
    assert.equal((await (await send()).json()).duplicate, true);
    assert.equal(queue.snapshot().jobs.length, 1);
    assert.equal((await post("/schedule", { everySeconds: 1 })).status, 400);
    assert.equal((await post("/work", { mode: "guided", tenant: "override" })).status, 400);
    const result = await (await post("/work", { mode: "guided" })).json(); assert.equal(result.job.state, "succeeded");
    const code = await (await fetch(base + "/code")).json(); assert.match(code["workshop.ts"], /class ScheduledWorkshop/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
