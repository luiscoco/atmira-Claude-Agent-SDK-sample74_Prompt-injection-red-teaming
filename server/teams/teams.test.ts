import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { concept56 } from "../concepts/56-agent-teams.js";
import { replay, walkthrough, type Command } from "./workshop.js";

const send: Command = { type: "send", actor: "researcher", to: "reviewer", id: "finding-1", text: "Total is 37" };
const claim: Command = { type: "claim", actor: "researcher", task: "research" };
const complete: Command = { type: "complete", actor: "researcher", task: "research", evidence: "12 + 18 + 7 = 37" };
test("walkthrough closes the team and retains all expected failure evidence", () => {
  const { state, receipts } = replay(walkthrough);
  assert.equal(state.cleaned, true);
  assert.ok(state.tasks.every((task) => task.status === "completed"));
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].status, "acknowledged");
  assert.deepEqual(receipts.filter((receipt) => !receipt.ok).map((receipt) => receipt.step), [1, 3, 4, 7, 10]);
});
test("one owner wins and a rejected competing claim preserves state", () => {
  const winner = replay([claim]);
  const conflict = replay([claim, { ...claim, actor: "reviewer" }]);
  assert.deepEqual(conflict.state, winner.state);
  assert.equal(conflict.receipts.at(-1)?.ok, false);
});
test("dependency and owner gates cannot be bypassed with correct evidence", () => {
  assert.equal(replay([{ type: "claim", actor: "reviewer", task: "review" }]).receipts[0].ok, false);
  assert.equal(replay([claim, { ...complete, actor: "reviewer" }]).receipts.at(-1)?.ok, false);
  assert.equal(replay([claim, complete, { type: "claim", actor: "reviewer", task: "review" }]).receipts.at(-1)?.ok, true);
});
test("bad evidence keeps a task busy and blocks shutdown", () => {
  const result = replay([claim, { ...complete, evidence: "30" }, { type: "shutdown", actor: "lead", to: "researcher" }]);
  assert.equal(result.state.tasks[0].status, "in-progress");
  assert.equal(result.state.members.researcher, "busy");
  assert.equal(result.receipts[1].ok, false);
  assert.equal(result.receipts[2].ok, false);
});
test("queued, delivered and acknowledged are distinct; no message completes a task", () => {
  assert.equal(replay([send]).state.messages[0].status, "queued");
  const earlyAck = replay([send, { type: "ack", actor: "reviewer", id: send.id }]);
  assert.equal(earlyAck.receipts[1].ok, false);
  const delivered = [send, { type: "deliver", actor: "reviewer" } as Command];
  assert.equal(replay(delivered).state.messages[0].status, "delivered");
  const result = replay([...delivered, { type: "ack", actor: "reviewer", id: send.id }]);
  assert.equal(result.state.messages[0].status, "acknowledged");
  assert.ok(result.state.tasks.every((task) => task.status === "pending"));
});
test("retry is idempotent and changed payload or sender conflicts with the same ID", () => {
  const result = replay([send, send, { ...send, text: "Changed" }, { ...send, actor: "lead" }]);
  assert.equal(result.state.messages.length, 1);
  assert.deepEqual(result.receipts.map((receipt) => receipt.ok), [true, true, false, false]);
});
test("an unrelated agent cannot acknowledge a peer message", () => {
  const result = replay([send, { type: "deliver", actor: "reviewer" }, { type: "ack", actor: "lead", id: send.id }]);
  assert.equal(result.receipts.at(-1)?.ok, false);
  assert.equal(result.state.messages[0].status, "delivered");
});
test("pending messages block shutdown and stopped agents cannot send or receive", () => {
  assert.equal(replay([send, { type: "shutdown", actor: "lead", to: "reviewer" }]).receipts.at(-1)?.ok, false);
  const shutdown: Command = { type: "shutdown", actor: "lead", to: "researcher" };
  assert.equal(replay([shutdown, send]).receipts.at(-1)?.ok, false);
  assert.equal(replay([shutdown, { ...send, actor: "lead", to: "researcher" }]).receipts.at(-1)?.ok, false);
});
test("cleanup requires the lead, stopped workers, completed tasks and acknowledged inboxes", () => {
  assert.equal(replay([{ type: "cleanup", actor: "lead" }]).receipts[0].ok, false);
  const stopped: Command[] = [{ type: "shutdown", actor: "lead", to: "researcher" }, { type: "shutdown", actor: "lead", to: "reviewer" }];
  assert.equal(replay([...stopped, { type: "cleanup", actor: "lead" }]).state.cleaned, false);
  assert.equal(replay([...walkthrough, send]).receipts.at(-1)?.ok, false);
});
test("replays are isolated and deterministic", () => {
  assert.deepEqual(replay(walkthrough), replay(walkthrough));
  assert.equal(replay([]).state.tasks[0].status, "pending");
});

let server: Server;
let url: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c56", concept56);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/api/c56`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP facts and source expose the lesson without a model", async () => {
  const facts = await (await fetch(`${url}/facts`)).json();
  assert.equal(facts.modelApiCalls, 0); assert.equal(facts.walkthrough.length, 16);
  const source = await (await fetch(`${url}/code`)).json();
  assert.match(source["workshop.ts"], /export function replay/);
  assert.match(source["56-agent-teams.ts"], /session\?\.close\(\)/);
});
test("HTTP replay returns checked state and rejection receipts", async () => {
  const response = await post("replay", { commands: walkthrough }); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.state.cleaned, true); assert.equal(body.modelApiCalls, 0);
  assert.equal(body.receipts.filter((receipt: { ok: boolean }) => !receipt.ok).length, 5);
});
test("HTTP rejects unknown members, malformed commands and excessive history", async () => {
  for (const body of [{ commands: [{ ...send, actor: "stranger" }] }, { commands: [{ ...send, extra: true }] }, { commands: Array(101).fill(send) }, { commands: [], state: {} }, { commands: [{ ...send, text: " " }] }, { commands: [{ type: "delete" }] }]) {
    assert.equal((await post("replay", body)).status, 400);
  }
  assert.equal((await post("live", { prompt: "arbitrary input" })).status, 400);
});
