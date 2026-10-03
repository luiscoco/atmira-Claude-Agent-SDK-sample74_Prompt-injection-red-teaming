import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPython, inputSchema, type PythonEvent } from "./bridge.js";
import { createPythonRouter } from "../concepts/70-python-sdk.js";

const input = { mode: "guided", exercise: "query", prompt: "hello" } as const;
test("real Python bridge runs all guided exercises and preserves event order", async () => {
  for (const exercise of ["query", "conversation", "tool"] as const) {
    const events: PythonEvent[] = [];
    await runPython({ ...input, exercise }, new AbortController().signal, (event) => events.push(event));
    assert.equal(events.at(-1)?.status, "completed");
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    if (exercise === "tool") assert.deepEqual(events.map((e) => e.type), ["system", "hook", "tool", "text", "result", "done"]);
    if (exercise === "conversation") assert.deepEqual(events.filter((e) => e.type === "result").map((e) => e.turn), [1, 2]);
  }
});

test("strict input prevents caller-selected executables and options", () => {
  for (const body of [{ ...input, executable: "other" }, { ...input, prompt: " " }, { ...input, prompt: "a".repeat(2001) }, { ...input, exercise: "shell" }])
    assert.equal(inputSchema.safeParse(body).success, false);
});

test("missing interpreter produces one sanitized terminal failure", async () => {
  const events: PythonEvent[] = [];
  await runPython(input, new AbortController().signal, (e) => events.push(e), { executable: "missing-lesson70-python-executable" });
  assert.deepEqual(events.map((e) => e.type), ["error", "done"]);
  assert.equal(events.at(-1)?.status, "failed");
});

const fixtures = mkdtempSync(path.join(tmpdir(), "lesson70-"));
function fixture(name: string, source: string) { const file = path.join(fixtures, name); writeFileSync(file, source); return file; }
test("deadline kills an unresponsive process and reports failure", async () => {
  const events: PythonEvent[] = [];
  await runPython(input, new AbortController().signal, (e) => events.push(e), {
    script: fixture("slow.py", "import time\ntime.sleep(30)\n"), deadlineMs: 500,
  });
  assert.deepEqual(events.map((e) => e.type), ["error", "done"]);
  assert.match(events[0].text!, /deadline/);
});

test("cancellation closes the process without publishing late output", async () => {
  const controller = new AbortController(), events: PythonEvent[] = [];
  const timer = setTimeout(() => controller.abort(), 500);
  try { await runPython(input, controller.signal, (e) => events.push(e), { script: fixture("cancel.py", "import time\ntime.sleep(30)\n") }); }
  finally { clearTimeout(timer); }
  assert.deepEqual(events, []);
});

test("malformed and incomplete output are failures; stderr stays private", async () => {
  for (const source of ["print('bad-json')", "import sys\nprint('SECRET',file=sys.stderr)"]) {
    const events: PythonEvent[] = [];
    await runPython(input, new AbortController().signal, (e) => events.push(e), { script: fixture("bad.py", source) });
    assert.equal(events.at(-1)?.status, "failed");
    assert.equal(JSON.stringify(events).includes("SECRET"), false);
  }
});

test("HTTP rejects invalid bodies, streams actual Python and serves source", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c70", createPythonRouter());
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c70`;
  try {
    const bad = await fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, cwd: "forged" }) });
    assert.equal(bad.status, 400);
    const good = await fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.match(good.headers.get("content-type")!, /text\/event-stream/);
    assert.match(await good.text(), /"status":"completed"/);
    const code = await (await fetch(`${base}/code`)).json() as Record<string, string>;
    assert.match(code["lesson.py"], /ClaudeSDKClient/);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
