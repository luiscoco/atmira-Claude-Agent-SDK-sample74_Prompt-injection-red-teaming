import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { catalog, estimateTokens, handle, needle, plan, sdkTools, search } from "./catalog.js";
import { concept58 } from "../concepts/58-tool-search.js";

const data = (result: ReturnType<typeof handle>) => JSON.parse(result.content[0].text);
test("the catalog has 64 unique tools and exactly one needle per metadata profile", () => {
  for (const metadata of ["clear", "vague"] as const) {
    const rows = catalog(metadata);
    assert.equal(rows.length, 64);
    assert.equal(new Set(rows.map((row) => row.name)).size, 64);
    assert.equal(rows.filter((row) => row.needle).length, 1);
  }
  assert.equal(catalog("clear").find((row) => row.needle)!.name, "billing_refund_invoice");
  assert.equal(catalog("vague").find((row) => row.needle)!.searchHint, undefined);
});
test("the needle refunds only the duplicate charge and returns recovery errors otherwise", () => {
  const refund = catalog().find((row) => row.needle)!;
  assert.equal(data(handle(refund, { invoiceId: needle.invoiceId, amountCents: needle.amountCents })).refundId, needle.refundId);
  assert.equal(data(handle(refund, { invoiceId: "INV-0001", amountCents: 4900 })).code, "NOT_FOUND");
  const wrong = handle(refund, { invoiceId: needle.invoiceId, amountCents: 490 });
  assert.equal(wrong.isError, true); assert.equal(data(wrong).code, "AMOUNT_MISMATCH");
});
test("clear metadata is found by intent words; vague metadata is not; select: is exact", () => {
  assert.equal(search("refund duplicate charge", "clear").hits[0].name, "billing_refund_invoice");
  assert.equal(search("money back for a double charge", "clear").hits[0].name, "billing_refund_invoice");
  assert.ok(!search("refund duplicate charge", "vague").hits.some((hit) => hit.name === "billing_op_7"));
  // Filler words such as "for" must not rank unrelated tools.
  assert.deepEqual(search("money back for a double charge", "vague").hits, []);
  assert.deepEqual(search("money back for a double charge", "vague").terms, ["money", "back", "double", "charge"]);
  assert.deepEqual(search("select:mcp__ops__billing_refund_invoice,crm_get").hits.map((hit) => hit.name), ["billing_refund_invoice", "crm_get"]);
  assert.deepEqual(search("select:does_not_exist").hits, []);
});
test("the planner applies the documented ENABLE_TOOL_SEARCH rules", () => {
  const all = catalog().reduce((sum, row) => sum + estimateTokens(row), 0);
  assert.equal(plan("false").upfrontTokens, all);
  assert.equal(plan("false").deferredCount, 0);
  assert.equal(plan("true").upfrontTokens, 0);
  assert.equal(plan("true").deferredCount, 64);
  assert.deepEqual(plan("true", { pinNeedle: true }).upfront, ["billing_refund_invoice"]);
  // auto = 10%: about 16k estimated tokens stay under 20k in a 200k window, but exceed it in a 100k window.
  assert.equal(plan("auto").defer, false);
  assert.equal(plan("auto", { contextWindow: 100_000 }).defer, true);
  assert.equal(plan("auto:0").defer, true);
  assert.equal(plan("auto:100").defer, false);
});
test("SDK definitions carry searchHint and the per-tool alwaysLoad pin", () => {
  const pinned = sdkTools("clear", true, () => {}).find((row) => row.name === "billing_refund_invoice") as any;
  const unpinned = sdkTools("clear", false, () => {}).find((row) => row.name === "billing_refund_invoice") as any;
  assert.equal(JSON.stringify(pinned).includes("alwaysLoad"), true);
  assert.equal(JSON.stringify(unpinned).includes("alwaysLoad"), false);
  assert.match(JSON.stringify(pinned), /searchHint/);
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c58", concept58);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c58`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP offline endpoints answer; malformed configs fail before Claude Code starts", async () => {
  const facts = await (await fetch(`${base}/facts`)).json();
  assert.equal(facts.tools.length, 64);
  assert.match((await (await fetch(`${base}/code`)).json())["catalog.ts"], /searchHint/);
  assert.equal((await (await post("search", { query: "refund", metadata: "clear" })).json()).hits[0].name, "billing_refund_invoice");
  assert.equal((await (await post("plan", { mode: "auto:5", metadata: "clear", pinNeedle: false, contextWindow: 200_000 })).json()).defer, true);
  for (const route of ["measure", "run"]) {
    assert.equal((await post(route, { mode: "auto:101", metadata: "clear", pinNeedle: false })).status, 400);
    assert.equal((await post(route, { mode: "maybe", metadata: "clear", pinNeedle: false })).status, 400);
    assert.equal((await post(route, { mode: "true", metadata: "clear", pinNeedle: false, prompt: "anything" })).status, 400);
  }
});
