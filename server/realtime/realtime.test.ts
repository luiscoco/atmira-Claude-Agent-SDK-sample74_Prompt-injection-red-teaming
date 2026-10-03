import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { attachRealtime, type Runner } from "./socket.js";
import type { Frame } from "./protocol.js";

async function fixture(live: Runner = async () => { throw new Error("Injected live failure"); }) {
  const server = createServer();
  const host = attachRealtime(server, live);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const clients: WebSocket[] = [];
  async function connect() {
    const ws = new WebSocket(origin.replace("http", "ws") + "/api/c66/socket", { origin }); clients.push(ws);
    const frames: Frame[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await once(ws, "open");
    async function wait(predicate: (frame: Frame) => boolean) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const match = frames.find(predicate); if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Frame timeout: ${JSON.stringify(frames)}`);
    }
    await wait((frame) => frame.type === "ready");
    return { ws, frames, wait };
  }
  async function close() {
    for (const ws of clients) ws.terminate();
    host.dispose(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { connect, close, origin };
}

test("guided output streams in order with authoritative text and a terminal event", async () => {
  const host = await fixture();
  try {
    const client = await host.connect(); const runId = randomUUID();
    client.ws.send(JSON.stringify({ type: "start", runId, mode: "guided", prompt: "Hello" }));
    const done = await client.wait((frame) => frame.type === "done");
    assert.equal(done.data.status, "completed");
    const chunks = client.frames.filter((frame) => frame.type === "delta"); assert.ok(chunks.length > 1);
    assert.equal(chunks.map((frame) => frame.data.text).join(""), client.frames.find((frame) => frame.type === "result")?.data.text);
    assert.deepEqual(client.frames.map((frame) => frame.seq), client.frames.map((_, index) => index + 1));
    assert.ok(client.frames.filter((frame) => frame.type !== "ready").every((frame) => frame.runId === runId));
    client.ws.send(JSON.stringify({ type: "start", runId, mode: "guided", prompt: "duplicate" }));
    await client.wait((frame) => frame.type === "error" && frame.data.status === "failed");
    assert.equal(client.frames.filter((frame) => frame.type === "started").length, 1);
  } finally { await host.close(); }
});

test("cancel interrupts a run, a second socket cannot cancel it, and a fresh run is accepted", async () => {
  const host = await fixture();
  try {
    const a = await host.connect(), b = await host.connect(); const runId = randomUUID();
    a.ws.send(JSON.stringify({ type: "start", runId, mode: "guided", prompt: "Cancel me" }));
    await a.wait((frame) => frame.type === "delta");
    b.ws.send(JSON.stringify({ type: "cancel", runId }));
    await b.wait((frame) => frame.type === "error");
    assert.equal(b.frames.some((frame) => frame.type === "delta"), false);
    a.ws.send(JSON.stringify({ type: "cancel", runId }));
    assert.equal((await a.wait((frame) => frame.type === "done")).data.status, "cancelled");
    assert.equal(a.frames.some((frame) => frame.type === "result"), false);
    const next = randomUUID(); a.ws.send(JSON.stringify({ type: "start", runId: next, mode: "live", prompt: "fail" }));
    assert.equal((await a.wait((frame) => frame.type === "done" && frame.runId === next)).data.status, "failed");
  } finally { await host.close(); }
});

test("disconnect aborts the runner and reconnect does not replay the request", async () => {
  let aborted = false, calls = 0;
  const host = await fixture(async (_command, abort) => {
    calls++;
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  });
  try {
    const a = await host.connect(); a.ws.send(JSON.stringify({ type: "start", runId: randomUUID(), mode: "live", prompt: "Wait" }));
    await a.wait((frame) => frame.type === "started");
    a.ws.close(); await once(a.ws, "close");
    const b = await host.connect(); assert.equal(aborted, true); assert.equal(calls, 1);
    assert.deepEqual(b.frames.map((frame) => frame.type), ["ready"]);
  } finally { await host.close(); }
});

test("bad JSON and schema fail without starting a runner; hostile origins are rejected", async () => {
  const host = await fixture();
  try {
    const a = await host.connect(); a.ws.send("{");
    await a.wait((frame) => frame.type === "error");
    a.ws.send(JSON.stringify({ type: "start", runId: "bad", mode: "live", prompt: "" }));
    await a.wait((frame) => frame.type === "error" && frame.data.message?.startsWith("Invalid command") === true);
    assert.equal(a.frames.some((frame) => frame.type === "started"), false);
    const attacker = new WebSocket(host.origin.replace("http", "ws") + "/api/c66/socket", { origin: "https://evil.example" });
    await new Promise<void>((resolve, reject) => {
      attacker.on("unexpected-response", (_request, response) => { assert.equal(response.statusCode, 403); response.resume(); attacker.terminate(); resolve(); });
      attacker.on("error", () => {}); attacker.on("open", () => { attacker.terminate(); reject(new Error("Accepted hostile origin")); });
    });
  } finally { await host.close(); }
});
