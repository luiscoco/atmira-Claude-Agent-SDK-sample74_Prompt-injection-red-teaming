import assert from "node:assert/strict";
import { test } from "node:test";
import { cases } from "./cases.js";
import { fakeQuery } from "./fixtures.js";
import { runAgent } from "./host.js";

// #region node-tests
for (const testCase of cases) {
  test(`${testCase.group}: ${testCase.name}`, { timeout: 5000 }, async () => {
    await testCase.check(false);
  });
}

test("mutation: duplicate-text regression is caught by the unchanged assertion", async () => {
  const textCase = cases.find((c) => c.id === "stream-text")!;
  await assert.rejects(() => textCase.check(true), { name: "AssertionError" });
});

test("timeout: virtual time aborts the stream without a real delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: 0 });
  const pending = runAgent(fakeQuery("wait"), { prompt: "Hello", timeoutMs: 60_000 });
  t.mock.timers.tick(60_000);
  assert.equal((await pending).status, "timeout");
  // The test context automatically restores the timers after this test.
});

test("cleanup: consuming a terminal result closes the iterator", async () => {
  let closed = false;
  async function* stream() {
    try { yield* fakeQuery("success")({ prompt: "Hello", signal: new AbortController().signal }); }
    finally { closed = true; }
  }
  await runAgent(stream, { prompt: "Hello" });
  assert.equal(closed, true);
});
// #endregion
