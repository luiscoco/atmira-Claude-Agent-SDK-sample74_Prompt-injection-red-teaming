import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { concept62 } from "../concepts/62-retrieval-rag.js";
import { exercises } from "./corpus.js";
import { chunks, makeKnowledgeServer, search, validateAnswer, type Hit } from "./retrieval.js";

test("chunks have unique stable IDs and the regression queries retrieve expected sources", () => {
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
  for (const exercise of exercises) {
    const hits = search({ query: exercise.query, topK: 3 });
    assert.equal(hits[0]?.id ?? null, exercise.expected, exercise.id);
  }
});
test("tenant and current-version filters apply before ranking, with bounded deterministic results", () => {
  const hits = search({ query: "return unused products days", topK: 5 });
  assert.ok(hits.some((hit) => hit.id === "returns-v2#1"));
  assert.ok(hits.every((hit) => !hit.id.startsWith("returns-v1") && !hit.id.startsWith("other-")));
  assert.deepEqual(hits, search({ query: "return unused products days", topK: 5 }));
  assert.equal(search({ query: "return unused products days", topK: 1 }).length, 1);
  assert.deepEqual(search({ query: "return unused products days", topK: 5 }, "other").map((hit) => hit.id), ["other-returns#1"]);
  assert.throws(() => search({ query: " ", topK: 0 }));
});
test("citations require sources retrieved in this run and verbatim quotes", () => {
  const hit = search({ query: "unused products return", topK: 1 })[0];
  const evidence = new Map([[hit.id, hit]]);
  const answer = { status: "answered", answer: "30 days.", citations: [{ sourceId: hit.id, quote: "within 30 days of delivery" }] };
  assert.deepEqual(validateAnswer(answer, evidence), answer);
  assert.throws(() => validateAnswer(answer, new Map()), /not retrieved/);
  assert.throws(() => validateAnswer({ ...answer, citations: [{ sourceId: hit.id, quote: "90 days" }] }, evidence), /Quote/);
  assert.throws(() => validateAnswer({ ...answer, citations: [] }, evidence), /at least one/);
  assert.throws(() => validateAnswer({ ...answer, status: "insufficient_evidence" }, evidence), /no citations/);
  assert.equal(validateAnswer({ status: "insufficient_evidence", answer: "No warranty evidence.", citations: [] }, evidence).status, "insufficient_evidence");
});
test("real MCP client validates inputs, searches, and restricts passage lookup to retrieved IDs", async () => {
  const evidence = new Map<string, Hit>(); const logs: string[] = [];
  const server = makeKnowledgeServer(evidence, (name) => logs.push(name));
  const client = new Client({ name: "retrieval-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(a); await client.connect(b);
    assert.deepEqual((await client.listTools()).tools.map((item) => item.name), ["search_knowledge", "get_passage"]);
    assert.equal((await client.callTool({ name: "search_knowledge", arguments: { query: "refund", topK: 99 } })).isError, true);
    assert.equal(logs.length, 0);
    assert.equal((await client.callTool({ name: "get_passage", arguments: { sourceId: "returns-v2#1" } })).isError, true);
    const result = await client.callTool({ name: "search_knowledge", arguments: { query: "return unused products" } });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.ok(evidence.has("returns-v2#1"));
    assert.equal((await client.callTool({ name: "get_passage", arguments: { sourceId: "returns-v2#1" } })).isError, false);
    assert.equal((await client.callTool({ name: "get_passage", arguments: { sourceId: "other-returns#1" } })).isError, true);
  } finally { await client.close(); await server.instance.close(); }
});
test("HTTP routes serve facts, ranking, checks, code and reject malformed live requests without a model", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c62", concept62);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c62`;
  try {
    assert.equal((await (await fetch(`${base}/facts`)).json()).exercises.length, exercises.length);
    assert.ok((await (await fetch(`${base}/eval`)).json()).every((row: { pass: boolean }) => row.pass));
    assert.ok((await (await fetch(`${base}/code`)).json())["retrieval.ts"].includes("makeKnowledgeServer"));
    const post = (endpoint: string, body: unknown) => fetch(`${base}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("search", { query: "refund", topK: 0 })).status, 400);
    assert.equal((await post("query", { question: " " })).status, 400);
    assert.equal((await (await post("search", { query: "password reset", topK: 1 })).json()).hits[0].id, "security#1");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
