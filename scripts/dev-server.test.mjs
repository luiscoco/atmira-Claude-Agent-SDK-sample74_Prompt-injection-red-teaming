import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { watchSources } from "./dev-server.mjs";

test("source watcher ignores dependency and lab activity but detects edits, additions and deletions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lesson-dev-watch-"));
  const file = (name) => path.join(root, name);
  for (const directory of ["server", "mcp-servers", "node_modules", "suggest-lab"]) mkdirSync(file(directory));
  writeFileSync(file("server/index.ts"), "original");
  let changes = 0;
  const stop = watchSources(root, () => { changes++; }, 20);
  async function expectChanges(count) {
    for (let attempts = 0; attempts < 50 && changes !== count; attempts++) await delay(20);
    assert.equal(changes, count);
  }
  try {
    readFileSync(file("server/index.ts"));
    writeFileSync(file("node_modules/cache.js"), "changed");
    writeFileSync(file("suggest-lab/generated.ts"), "changed");
    await delay(100);
    assert.equal(changes, 0);
    // Same length: detect actual contents, even without relying on file size.
    writeFileSync(file("server/index.ts"), "modified");
    await expectChanges(1);
    writeFileSync(file("mcp-servers/new.mjs"), "new");
    await expectChanges(2);
    rmSync(file("mcp-servers/new.mjs"));
    await expectChanges(3);
    await delay(100);
    assert.equal(changes, 3);
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
});
