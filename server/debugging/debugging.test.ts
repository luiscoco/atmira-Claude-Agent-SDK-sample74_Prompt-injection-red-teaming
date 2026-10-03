import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { concept53 } from "../concepts/53-debugging.js";
import { createTrace, diagnose, redact, replay, scenarios } from "./trace.js";

test("redaction covers nested headers, bearer credentials and stderr secrets", () => {
  const clean = JSON.stringify(redact({ Authorization: "Bearer secret-value", child: [{ "x-api-key": "other-value" }], log: "api_key=abc sk-ant-real-key Bearer hello" }));
  for (const secret of ["secret-value", "other-value", "abc", "sk-ant-real-key", "hello"]) assert.ok(!clean.includes(secret));
  assert.match(clean, /REDACTED/);
});

test("denials are distinct from execution failures and keep their correlation ID", () => {
  const denied = createTrace(); replay("denied", denied);
  const missing = createTrace(); replay("missing", missing);
  assert.ok(diagnose(denied.rows).some((f) => f.title === "A tool was denied"));
  assert.ok(!denied.rows.some((r) => r.kind === "PostToolUseFailure"));
  assert.ok(diagnose(missing.rows).some((f) => f.title.startsWith("A tool failed")));
  assert.ok(!missing.rows.some((r) => r.kind === "denied"));
  assert.equal(missing.rows.find((r) => r.kind === "PostToolUseFailure")?.toolUseId, "synthetic-read-1");
});

test("terminal failure is not mistaken for completion", () => {
  for (const scenario of ["max-turns", "api-error", "startup", "truncated"] as const) {
    const trace = createTrace(); replay(scenario, trace);
    const findings = diagnose(trace.rows);
    assert.ok(findings.length > 0, scenario);
    assert.ok(!findings.some((f) => f.title === "SDK reported completion"), scenario);
    for (const finding of findings) for (const seq of finding.evidence) assert.ok(trace.rows.some((r) => r.seq === seq));
  }
});

test("a recovered tool failure can coexist with successful completion", () => {
  const trace = createTrace(); replay("missing", trace);
  const findings = diagnose(trace.rows);
  assert.ok(findings.some((f) => f.title.startsWith("A tool failed")));
  assert.ok(findings.some((f) => f.title === "SDK reported completion"));
});

test("timeouts and disconnects produce host cancellation diagnoses", () => {
  for (const kind of ["timeout", "cancelled"]) {
    const trace = createTrace(); trace.add("host", kind, {});
    assert.equal(diagnose(trace.rows)[0]?.title, "Host cancelled the run");
  }
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c53", concept53);
  server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c53`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
function post(body: unknown) { return fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

test("HTTP: every offline scenario streams evidence and a recoverable bundle", async () => {
  for (const scenario of scenarios) {
    const response = await post({ scenario, mode: "offline" });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n\n").map((chunk) => ({ event: chunk.match(/^event: (.+)$/m)![1], data: JSON.parse(chunk.match(/^data: (.+)$/m)![1]) }));
    assert.equal(events[0].event, "start");
    const saved = events.at(-1)!; assert.equal(saved.event, "bundle");
    assert.equal(saved.data.mode, "offline");
    assert.ok(saved.data.findings.length);
    assert.deepEqual(saved.data.rows.map((r: any) => r.seq), saved.data.rows.map((_: any, i: number) => i + 1));
    const recovered = await fetch(`${base}/runs/${saved.data.id}`);
    assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), saved.data);
    assert.ok(!JSON.stringify(saved.data).includes("sk-ant-demo-secret"));
  }
});

test("HTTP: reject invalid options before SSE or process launch", async () => {
  for (const body of [{ scenario: "unknown" }, { maxTurns: 0 }, { maxTurns: 99 }, { mode: "live", scenario: "startup" }, { mode: "offline", cwd: "../../" }, { debug: "yes" }]) assert.equal((await post(body)).status, 400);
  assert.equal((await fetch(`${base}/runs/not-an-id`)).status, 400);
  assert.equal((await fetch(`${base}/runs/00000000-0000-0000-0000-000000000000`)).status, 404);
});

test("HTTP: facts and source expose the new lesson", async () => {
  const facts = await (await fetch(`${base}/facts`)).json(); assert.equal(facts.scenarios.length, 7);
  const code = await (await fetch(`${base}/code`)).json(); assert.match(code["53-debugging.ts"], /debugFile/); assert.match(code["trace.ts"], /diagnose/);
});
