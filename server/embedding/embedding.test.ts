import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { EmbeddingHost, type Runner } from "./host.js";
import { applyProposal, type HostEvent, type Snapshot } from "./protocol.js";
import { createEmbeddingRouter } from "../concepts/69-embedding-sdk.js";

const snapshot: Snapshot = { uri: "file:///workspace/a.js", version: 3, text: "hello world", start: 6, end: 11 };
const command = { type: "start", action: "rewrite", mode: "live" };
const runner: Runner = async (_command, _snapshot, _abort, delta) => { delta("Review this replacement."); return { replacement: "editor", costUsd: 0.01 }; };

test("typed events preserve order and proposal applies only to the captured selection", async () => {
  const host = new EmbeddingHost(runner), events: HostEvent[] = [];
  await host.start(command, snapshot, true, (event) => events.push(event));
  assert.deepEqual(events.map((e) => e.type), ["started", "delta", "proposal", "done"]);
  assert.equal(new Set(events.map((e) => e.runId)).size, 1);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  const proposal = events.find((e) => e.type === "proposal"); assert.ok(proposal?.type === "proposal");
  assert.equal(applyProposal(snapshot, proposal.proposal), "hello editor");
  for (const current of [{ ...snapshot, version: 4 }, { ...snapshot, text: "HELLO world" }, { ...snapshot, uri: "file:///workspace/b.js" }])
    assert.throws(() => applyProposal(current, proposal.proposal), /Document changed/);
});

test("untrusted workspaces and forged commands never invoke the runner", async () => {
  let calls = 0;
  const host = new EmbeddingHost(async () => { calls++; return { costUsd: 0 }; });
  await assert.rejects(host.start(command, snapshot, false, () => {}), /Trust/);
  await assert.rejects(host.start({ ...command, cwd: "/forged" }, snapshot, true, () => {}));
  await assert.rejects(host.start(command, { ...snapshot, end: 50 }, true, () => {}));
  await assert.rejects(host.start(command, { ...snapshot, text: "a".repeat(24_001) }, true, () => {}));
  assert.equal(calls, 0);
});

test("one active run per panel; cancellation ignores late callbacks and allows a fresh run", async () => {
  let finish!: () => void, lateDelta!: (text: string) => void;
  const host = new EmbeddingHost(async (_command, _snapshot, _abort, delta) => {
    lateDelta = delta; await new Promise<void>((resolve) => { finish = resolve; }); return { replacement: "late", costUsd: 0 };
  });
  const events: HostEvent[] = [];
  const running = host.start(command, snapshot, true, (e) => events.push(e));
  await assert.rejects(host.start(command, snapshot, true, () => {}), /already active/);
  host.cancel(); await running;
  assert.equal(events.at(-1)?.type, "done");
  assert.ok(events.some((e) => e.type === "done" && e.status === "cancelled"));
  const count = events.length; lateDelta("ignored"); finish(); await Promise.resolve();
  assert.equal(events.length, count); assert.equal(events.some((e) => e.type === "proposal"), false);
  await host.start({ ...command, mode: "guided" }, snapshot, true, () => {});
});

test("deadline and panel disposal settle an unresponsive runner", async () => {
  const never: Runner = async () => new Promise(() => {});
  const host = new EmbeddingHost(never, 10), events: HostEvent[] = [];
  await host.start(command, snapshot, true, (e) => events.push(e));
  assert.ok(events.some((e) => e.type === "error" && /deadline/.test(e.message)));
  assert.ok(events.some((e) => e.type === "done" && e.status === "failed"));
  const pending = host.start(command, snapshot, true, () => {});
  host.dispose(); await pending;
  await assert.rejects(host.start(command, snapshot, true, () => {}), /closed/);
});

test("failures and invalid model output produce a final failure with no proposal", async () => {
  for (const bad of [async () => { throw new Error("secret-key-do-not-send"); }, async () => ({ replacement: "x".repeat(24_001), costUsd: 0 })] as Runner[]) {
    const host = new EmbeddingHost(bad), events: HostEvent[] = [];
    await host.start(command, snapshot, true, (e) => events.push(e));
    assert.ok(events.some((e) => e.type === "done" && e.status === "failed"));
    assert.equal(events.some((e) => e.type === "proposal"), false);
    assert.equal(JSON.stringify(events).includes("secret-key"), false);
  }
});

test("HTTP adapter validates input, streams guided events without API, and serves source", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c69", createEmbeddingRouter(async () => { throw new Error("Guided must never call live runner"); }));
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c69`;
  const post = (body: unknown) => fetch(base + "/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ command, snapshot, trusted: false })).status, 403);
    assert.equal((await post({ command: { ...command, executable: "bad" }, snapshot, trusted: true })).status, 400);
    const response = await post({ command: { ...command, mode: "guided" }, snapshot, trusted: true });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const stream = await response.text(); assert.match(stream, /"type":"proposal"/); assert.match(stream, /"status":"completed"/);
    const files = await (await fetch(base + "/code")).json();
    assert.match(files["extension.cjs"], /WorkspaceEdit/); assert.match(files["webview.js"], /textContent/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
