import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { compareMetrics, inspectStream, inventory, runWorkshop, scenarios, transition } from "./workshop.js";
import { concept55 } from "../concepts/55-upgrading-sdk.js";

test("compatible fixtures pass; each regression is blocked by the relevant gate", () => {
  assert.equal(runWorkshop("compatible").eligible, true);
  const expected = { "removed-export": "Public API contract", "stream-change": "Stream and task evidence", "permission-drift": "Permission boundary", "quality-regression": "Quality, cost and latency", "missing-evidence": "Stream and task evidence" };
  for (const [scenario, name] of Object.entries(expected)) {
    const report = runWorkshop(scenario as typeof scenarios[number]);
    assert.equal(report.eligible, false);
    assert.equal(report.gates.find((gate) => gate.name === name)?.passed, false);
  }
});
test("stream adapter tolerates additive events, rejects missing or erroneous results", () => {
  const success = { type: "result", subtype: "success", is_error: false, result: "evidence" };
  assert.deepEqual(inspectStream([null, { type: "new_event" }, success]), { terminal: true, answer: "evidence", unknownTypes: ["new_event"] });
  for (const messages of [[], [{ ...success, is_error: true }], [{ ...success, subtype: "error_max_turns" }], [{ ...success, result: null }], [success, { type: "result", subtype: "error" }]]) {
    assert.equal(inspectStream(messages).terminal, false);
  }
});
test("eval gate enforces inclusive boundaries and rejects invalid measurements", () => {
  assert.equal(compareMetrics({ correctness: 0.93, costUsd: 0.024, latencyMs: 1250 }), true);
  for (const row of [
    { correctness: 0.929, costUsd: 0.02, latencyMs: 1000 },
    { correctness: 0.95, costUsd: 0.02401, latencyMs: 1000 },
    { correctness: 0.95, costUsd: 0.02, latencyMs: 1251 },
    { correctness: 1.1, costUsd: 0.02, latencyMs: 1000 },
    { correctness: NaN, costUsd: 0.02, latencyMs: 1000 },
    { correctness: 0.95, costUsd: -1, latencyMs: 1000 },
  ]) assert.equal(compareMetrics(row), false);
});
test("promotion requires canary and passing gates; rollback remains available", () => {
  assert.throws(() => transition("baseline", "promote", true));
  assert.throws(() => transition("baseline", "canary", false));
  assert.throws(() => transition("canary", "promote", false));
  assert.equal(transition("baseline", "canary", true), "canary");
  assert.equal(transition("canary", "promote", true), "promoted");
  assert.equal(transition("promoted", "rollback", false), "rolled-back");
  assert.equal(transition("canary", "rollback", false), "rolled-back");
  assert.equal(transition("rolled-back", "canary", true), "canary");
});
test("local inventory verifies locked SDK, alias and installed public exports without query()", async () => {
  const facts = await inventory();
  assert.match(facts.lockSha256, /^[a-f0-9]{64}$/);
  assert.equal(facts.importError, null);
  assert.ok(Object.values(facts.exports).every(Boolean));
  for (const row of facts.packages) { assert.equal(row.exactPin, true); assert.equal(row.matchesLock, true); }
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c55", concept55);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c55`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP lesson material, scenarios and strict input validation", async () => {
  assert.equal((await (await fetch(`${base}/facts`)).json()).modelApiCalls, 0);
  assert.match((await (await fetch(`${base}/code`)).json())["workshop.ts"], /inspectStream/);
  for (const scenario of scenarios) {
    const response = await post("run", { scenario }); assert.equal(response.status, 200);
    assert.equal((await response.json()).eligible, scenario === "compatible");
  }
  for (const body of [{}, { scenario: "latest" }, { scenario: "compatible", command: "npm install" }]) assert.equal((await post("run", body)).status, 400);
});
test("HTTP transitions recompute eligibility and reject forged or invalid requests", async () => {
  assert.equal((await post("transition", { scenario: "permission-drift", state: "baseline", action: "canary" })).status, 409);
  assert.equal((await post("transition", { scenario: "compatible", state: "baseline", action: "promote" })).status, 409);
  assert.equal((await post("transition", { scenario: "compatible", state: "baseline", action: "canary", eligible: true })).status, 400);
  const response = await post("transition", { scenario: "compatible", state: "baseline", action: "canary" });
  assert.deepEqual(await response.json(), { state: "canary", simulated: true });
  assert.equal((await post("transition", { scenario: "permission-drift", state: "canary", action: "rollback" })).status, 200);
});
