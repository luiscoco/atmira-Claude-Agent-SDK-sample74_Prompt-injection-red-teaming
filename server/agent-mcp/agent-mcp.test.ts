import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import os from "node:os";
import type { Server } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DeskState, orders, policyDecision, scriptedRunner, verdictJsonSchema, Verdict } from "./desk.js";
import { connectInMemory, describeDesk, runContract } from "./contract.js";
import { createConcept61 } from "../concepts/61-agent-as-mcp-server.js";

test("the answer key is computed rule by rule, with inclusive limits", () => {
  assert.deepEqual(orders.map((o) => policyDecision(o).decision), ["approve", "reject", "reject", "reject", "approve", "reject"]);
  assert.deepEqual(policyDecision(orders.find((o) => o.id === "O-205")!).broken, []); // exactly 30 days and 200.00 EUR
  assert.deepEqual(policyDecision(orders.find((o) => o.id === "O-206")!).broken, ["older than 30 days", "over 200.00 EUR", "item used"]);
});

test("callers see one tool with input/output schemas and annotations, plus the policy resource; nothing of the inner agent", async () => {
  const desk = await describeDesk();
  assert.deepEqual(desk.tools.map((t) => t.name), ["review_refund"]);
  const [tool] = desk.tools;
  assert.deepEqual(tool.inputSchema.required, ["orderId", "customerMessage"]);
  assert.deepEqual((tool.outputSchema as any).required, ["orderId", "decision", "brokenRules", "customerReply"]);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.idempotentHint, true);
  assert.deepEqual(desk.resources.map((r) => r.uri), ["refund-desk://policy"]);
  assert.doesNotMatch(JSON.stringify(desk), /lookup_order|daysSincePurchase|Ana Ruiz|Fay Gómez/); // the inner tool and the data stay private
  assert.equal("$schema" in verdictJsonSchema, false); // Claude Code rejects an outputFormat schema with $schema
});

test("the contract: every failure is an isError result, and pre-checks never start the agent", async () => {
  const rows = Object.fromEntries((await runContract()).map((row) => [row.scenario, row]));
  const ok = rows["valid call"];
  assert.equal(ok.isError, false);
  assert.ok(Verdict.safeParse(ok.structured).success);
  assert.deepEqual(ok.progress, ["agent started", "lookup_order O-201", "verdict ready"]);
  assert.match(rows["input fails the schema"].text, /Input validation error/);
  for (const name of ["input fails the schema", "unknown order", "2 reviews already running", "server budget spent", "tool that does not exist"]) {
    assert.equal(rows[name].isError, true, name);
    assert.equal(rows[name].agentRan, false, `${name}: no tokens spent`);
  }
  assert.match(rows["agent output breaks the output schema"].text, /does not match the verdict schema/);
  assert.doesNotMatch(rows["agent crashes"].text, /at .*\.ts:\d+/); // no stack trace leaks to the caller
  assert.match(rows["caller cancels after 100 ms"].thrown ?? "", /caller gave up/);
  assert.equal(rows["caller cancels after 100 ms"].serverLog, "cancelled by the caller (isError)"); // the agent was stopped, not left running
  assert.match(rows["server deadline (150 ms here)"].text, /timed out/);
  assert.match(rows["2 reviews already running"].text, /busy/);
});

test("failed and successful runs both count against the server budget", async () => {
  const state = new DeskState();
  const { client, close } = await connectInMemory(async ({ orderId }) => ({ output: { orderId, decision: "approve", brokenRules: [], customerReply: "ok" }, usage: { costUsd: 0.3, turns: 3, durationMs: 1 } }), state);
  const args = { name: "review_refund", arguments: { orderId: "O-201", customerMessage: "x" } };
  assert.equal((await client.callTool(args)).isError, undefined);
  assert.equal((await client.callTool(args)).isError, undefined);
  const third = await client.callTool(args);
  assert.equal(third.isError, true);
  assert.equal(state.spentUsd, 0.6);
  await close();
});

let server: Server; let base = ""; const token = "test-token";
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c61", createConcept61({ runner: scriptedRunner("ok", 5), token }));
  server = app.listen(0); await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${(server.address() as any).port}/api/c61`;
});
after(() => server.close());

test("Streamable HTTP: bearer token, Host check, POST only, and progress streamed inside the call", async () => {
  const post = (headers: Record<string, string>) => fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  const check = await (await fetch(`${base}/http-check`)).json();
  assert.deepEqual([check.noToken, check.badHost, check.get, check.tools], [401, 403, 405, ["review_refund"]]);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, "x-caller": "test" } } }));
  const progress: string[] = [];
  const result = await client.callTool({ name: "review_refund", arguments: { orderId: "O-203", customerMessage: "Does not fit." } }, undefined, { onprogress: (p) => progress.push(p.message ?? "") });
  assert.deepEqual(result.structuredContent, { orderId: "O-203", decision: "reject", brokenRules: ["over 200.00 EUR"], customerReply: "We cannot refund this order: over 200.00 EUR." });
  assert.deepEqual(progress, ["agent started", "lookup_order O-203", "verdict ready"]);
  const log = await (await fetch(`${base}/log`)).json();
  assert.equal(log.calls[0].caller, "test");
  await client.close();
});

test("stdio: the entry point starts from another folder, keeps stdout clean and serves the scripted agent", { timeout: 30_000 }, async () => {
  const facts = await (await fetch(`${base}/facts`)).json();
  let stderr = "";
  const transport = new StdioClientTransport({ command: process.execPath, args: facts.config.stdio.args, cwd: os.tmpdir(), env: { ...process.env, REFUND_DESK_FAKE: "1" } as Record<string, string>, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "test-stdio", version: "1.0.0" });
  await client.connect(transport); // a stray console.log on stdout would break this handshake
  const result = await client.callTool({ name: "review_refund", arguments: { orderId: "O-202", customerMessage: "Unopened." } });
  assert.equal((result.structuredContent as Verdict).decision, "reject");
  assert.match(stderr, /scripted runner/);
  await client.close();
});

test("live routes validate their input before spending anything", async () => {
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("call", { orderId: "O-999", customerMessage: "x" })).status, 400);
  assert.equal((await post("call", { orderId: "O-201", customerMessage: "x", extra: 1 })).status, 400);
  assert.equal((await post("delegate", { orderIds: [] })).status, 400);
  assert.equal((await post("delegate", { orderIds: ["O-201", "O-202", "O-203", "O-204", "O-205"] })).status, 400);
});
