import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { contracts, invoke } from "./catalog.js";
import { concept54 } from "../concepts/54-tool-design.js";

const data = (call: Awaited<ReturnType<typeof invoke>>) => JSON.parse(call.result.content[0].text);
test("search filters by units and availability; pagination preserves stable IDs", async () => {
  const args = { category: "camping", maxPriceCents: 3000, limit: 1 };
  const first = data(await invoke("focused", "catalog_search", args));
  assert.deepEqual(first.items.map((row: any) => row.id), ["SKU-101"]);
  assert.equal(first.nextCursor, "offset:1");
  const second = data(await invoke("focused", "catalog_search", { ...args, cursor: first.nextCursor }));
  assert.deepEqual(second.items.map((row: any) => row.id), ["SKU-104"]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.totalMatches, 2);
  assert.equal(second.currency, "EUR");
});
test("concise results retain evidence fields and use fewer bytes", async () => {
  const args = { category: "camping", maxPriceCents: 3000 };
  const concise = await invoke("focused", "catalog_search", args);
  const detailed = await invoke("focused", "catalog_search", { ...args, responseFormat: "detailed" });
  assert.ok(concise.bytes < detailed.bytes);
  assert.deepEqual(data(concise).items.map((row: any) => row.id), data(detailed).items.map((row: any) => row.id));
  assert.equal(data(concise).items[0].description, undefined);
  assert.match(data(detailed).items[0].description, /350 ml/);
});
test("empty results are success; invalid input, IDs and cursors give recovery errors", async () => {
  const empty = await invoke("focused", "catalog_search", { category: "office", maxPriceCents: 0 });
  assert.equal(empty.result.isError, undefined);
  assert.deepEqual(data(empty).items, []);
  assert.equal(data(empty).nextCursor, null);
  for (const [name, input, code] of [
    ["catalog_get", { productId: "SKU-999" }, "NOT_FOUND"],
    ["catalog_get", { productId: "Trail mug" }, "INVALID_INPUT"],
    ["catalog_search", { category: "camping", maxPriceCents: 3000, cursor: "offset:99" }, "INVALID_CURSOR"],
    ["catalog_search", { category: "camping", maxPriceCents: 3000, limit: 4 }, "INVALID_INPUT"],
    ["catalog_search", { category: "camping", maxPriceCents: 3000, surprise: true }, "INVALID_INPUT"],
    ["delete_product", {}, "UNKNOWN_TOOL"],
  ] as const) {
    const call = await invoke("focused", name, input);
    assert.equal(call.result.isError, true);
    assert.equal(data(call).code, code);
    assert.ok(data(call).nextAction.length);
  }
});
test("vague lookup returns irrelevant evidence; focused schema exposes defaults and units", async () => {
  assert.equal(data(await invoke("vague", "lookup", { query: "camping" })).length, 4);
  const schema = contracts("focused")[0].inputSchema as any;
  assert.equal(schema.properties.limit.default, 2);
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.properties.maxPriceCents.description, /cents/);
  const record = data(await invoke("focused", "catalog_get", { productId: "SKU-101" }));
  assert.equal(record.name, "Trail mug");
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c54", concept54);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c54`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP contracts and source are accessible; malformed requests fail before running", async () => {
  const facts = await (await fetch(`${base}/facts`)).json();
  assert.equal(facts.contracts.focused.length, 2);
  assert.match((await (await fetch(`${base}/code`)).json())["catalog.ts"], /maxPriceCents/);
  assert.equal((await post("run", { mode: "live", profile: "unknown" })).status, 400);
  assert.equal((await post("run", { mode: "offline", profile: "focused", extra: true })).status, 400);
  const call = await (await post("call", { profile: "focused", name: "catalog_get", input: { productId: "SKU-999" } })).json();
  assert.equal(call.result.isError, true);
});
test("HTTP offline comparisons report actual handler metrics with no synthetic model answers", async () => {
  for (const profile of ["vague", "focused"]) {
    const response = await post("run", { mode: "offline", profile });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const events = (await response.text()).trim().split("\n\n").map((chunk) => ({ event: chunk.match(/^event: (.+)$/m)![1], data: JSON.parse(chunk.match(/^data: (.+)$/m)![1]) }));
    assert.equal(events.filter((event) => event.event === "message").length, 0);
    const summary = events.find((event) => event.event === "summary")!.data;
    assert.equal(summary.status, "scripted"); assert.equal(summary.costUsd, 0); assert.equal(summary.answer, "");
    assert.equal(summary.responseBytes, events.filter((event) => event.event === "call").reduce((sum, event) => sum + event.data.bytes, 0));
    assert.equal(events.at(-1)!.event, "done");
  }
});
