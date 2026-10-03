import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { concept51 } from "../concepts/51-unit-testing.js";

// Local HTTP integration tests. Mount only lesson 51; importing server/index.ts would start every live lab.
let server: Server;
let url: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/c51", concept51);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/api/c51`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function post(route: string, body: unknown) {
  return fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function events(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  return (await response.text()).trim().split("\n\n").map((chunk) => ({
    event: chunk.match(/^event: (.+)$/m)![1], data: JSON.parse(chunk.match(/^data: (.+)$/m)![1]),
  }));
}

test("HTTP: facts and source expose executable lesson material", async () => {
  const facts = await (await fetch(`${url}/facts`)).json();
  assert.equal(facts.cases.length, 25);
  assert.equal(facts.modelApiCalls, 0);
  const code = await (await fetch(`${url}/code`)).json();
  assert.match(code["offline.test.ts"], /mock.timers.enable/);
  assert.match(code["mcp.ts"], /InMemoryTransport.createLinkedPair/);
});
test("HTTP: all cases stream a passing summary", async () => {
  const rows = await events(await post("run", { group: "all", mutation: false }));
  assert.equal(rows.filter((row) => row.event === "case").length, 25);
  assert.equal(rows.at(-1)!.event, "summary");
  assert.equal(rows.at(-1)!.data.passed, 25);
  assert.equal(rows.at(-1)!.data.failed, 0);
});
test("HTTP: the mutation exposes one failed assertion", async () => {
  const rows = await events(await post("run", { group: "streams", mutation: true }));
  const failures = rows.filter((row) => row.event === "case" && !row.data.passed);
  assert.deepEqual(failures.map((row) => row.data.id), ["stream-text"]);
  assert.equal(rows.at(-1)!.data.failed, 1);
});
test("HTTP: malformed requests are rejected before streaming", async () => {
  assert.equal((await post("run", { group: "unknown" })).status, 400);
  assert.equal((await post("replay", { scenario: "unknown" })).status, 400);
  assert.equal((await post("run", { group: "all", extra: true })).status, 400);
});
test("HTTP: replay preserves deltas and the structured result", async () => {
  const rows = await events(await post("replay", { scenario: "success" }));
  assert.equal(rows.filter((row) => row.event === "delta").map((row) => row.data.text).join(""), "Refund approved.");
  assert.equal(rows.at(-1)!.data.status, "success");
  assert.equal(rows.at(-1)!.data.summary.refundCents, 1800);
});
test("HTTP: waiting fixture terminates at the host deadline", async () => {
  const rows = await events(await post("replay", { scenario: "wait" }));
  assert.equal(rows.at(-1)!.data.status, "timeout");
});
