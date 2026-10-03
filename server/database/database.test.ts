import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DatabaseLab, makeDatabaseServer } from "./database.js";
import { concept63 } from "../concepts/63-safe-database-agent.js";

test("reads enforce tenant, column and row boundaries; reject SQL and filter injection", () => {
  const lab = new DatabaseLab();
  try {
    const rows = lab.list({}); assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.id.startsWith("A-") && !("tenant" in row)));
    assert.equal(lab.list({ limit: 1 }).length, 1);
    for (const input of [{ sql: "DELETE FROM orders" }, { tenant: "other" }, { limit: 11 }, { status: "pending' OR 1=1 --" }]) assert.throws(() => lab.list(input));
    assert.equal(lab.list({}).length, 3);
    assert.throws(() => lab.propose({ orderId: "B-201", reason: "cancel" }));
    assert.throws(() => lab.propose({ orderId: "A-102", reason: "cancel" }));
    assert.throws(() => lab.propose({ orderId: "A-101", reason: "cancel", approve: true }));
  } finally { lab.close(); }
});
test("preview does not write; approval is exact, one use and rejects stale previews", () => {
  const lab = new DatabaseLab();
  try {
    const first = lab.propose({ orderId: "A-101", reason: "requested" });
    const second = lab.propose({ orderId: "A-101", reason: "duplicate" });
    first.orderId = "A-103"; // Public return value cannot alter the stored preview.
    assert.equal(lab.list({})[0].status, "pending");
    lab.decide(first.id, true);
    assert.equal(lab.list({})[0].status, "cancelled"); assert.equal(lab.list({})[0].version, 2);
    assert.equal(lab.list({})[2].status, "pending");
    assert.throws(() => lab.decide(first.id, true), /consumed/);
    assert.throws(() => lab.decide(second.id, true), /Stale/);
    assert.equal(lab.proposals[1].state, "stale");
    assert.ok(lab.audit.some((item) => item.outcome === "rolled back"));
  } finally { lab.close(); }
});
test("rejection and expiry cannot write; sessions do not share changes", () => {
  let now = 1_000; const a = new DatabaseLab(() => now); const b = new DatabaseLab();
  try {
    const reject = a.propose({ orderId: "A-101", reason: "cancel" }); a.decide(reject.id, false);
    assert.throws(() => a.decide(reject.id, true), /consumed/);
    const expire = a.propose({ orderId: "A-103", reason: "cancel" }); now += 300_000;
    assert.throws(() => a.decide(expire.id, true), /expired/);
    assert.equal(a.list({})[2].status, "pending");
    const commit = a.propose({ orderId: "A-101", reason: "cancel" }); a.decide(commit.id, true);
    assert.equal(b.list({})[0].status, "pending");
  } finally { a.close(); b.close(); }
});
test("MCP exposes no SQL or approval tool and proposals remain uncommitted", async () => {
  const lab = new DatabaseLab(); const server = makeDatabaseServer(lab, () => {});
  const client = new Client({ name: "db-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(a); await client.connect(b);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["list_orders", "propose_cancellation"]);
    assert.equal((await client.callTool({ name: "list_orders", arguments: { limit: 100 } })).isError, true);
    assert.equal((await client.callTool({ name: "propose_cancellation", arguments: { orderId: "A-101", reason: "cancel" } })).isError, undefined);
    assert.equal(lab.list({})[0].status, "pending");
  } finally { await client.close(); await server.instance.close(); lab.close(); }
});
test("HTTP workflow validates inputs, rejects cross-session approval and consumes a preview", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c63", concept63);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c63`;
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/facts`)).status, 200);
    assert.ok((await (await fetch(`${base}/code`)).json())["database.ts"].includes("BEGIN IMMEDIATE"));
    const a = await (await post("sessions", {})).json(); const b = await (await post("sessions", {})).json();
    assert.equal((await post(`sessions/${a.id}/read`, { sql: "DROP TABLE orders" })).status, 400);
    const blocked = await post(`sessions/${a.id}/blocked-sql`, {});
    assert.equal(blocked.status, 200);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.ok, false); assert.match(blockedBody.message, /Blocked/);
    assert.equal(blockedBody.orders.length, 3); assert.equal(blockedBody.orders[0].status, "pending");
    assert.equal((await post(`sessions/${a.id}/query`, { question: " " })).status, 400);
    assert.equal((await post("sessions/missing/read", {})).status, 404);
    const preview = await (await post(`sessions/${a.id}/propose`, { orderId: "A-101", reason: "cancel" })).json();
    const decision = { proposalId: preview.result.id, approve: true };
    const foreign = await post(`sessions/${b.id}/decide`, decision);
    assert.equal(foreign.status, 200); assert.equal((await foreign.json()).ok, false);
    assert.equal((await post(`sessions/${a.id}/decide`, { ...decision, approve: "true" })).status, 400);
    const duplicate = await (await post(`sessions/${a.id}/propose`, { orderId: "A-101", reason: "second preview" })).json();
    const committed = await (await post(`sessions/${a.id}/decide`, decision)).json(); assert.equal(committed.ok, true); assert.equal(committed.orders[0].status, "cancelled");
    const replay = await post(`sessions/${a.id}/decide`, decision);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).ok, false);
    const stale = await post(`sessions/${a.id}/decide`, { proposalId: duplicate.result.id, approve: true });
    assert.equal(stale.status, 200);
    const staleBody = await stale.json(); assert.equal(staleBody.ok, false); assert.match(staleBody.message, /Stale/);
    assert.equal(staleBody.proposals[1].state, "stale"); assert.equal(staleBody.orders[0].version, 2);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
