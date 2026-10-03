import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { createPythonRouter } from "../concepts/70-python-sdk.js";

test("built lesson runs all guided exercises, source viewer and mobile layout", { timeout: 60_000 }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");
  const app = express(); app.use(express.json()); app.use("/api/c70", createPythonRouter()); app.use(express.static(path.resolve("dist")));
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?lesson=70`);
    await page.getByRole("heading", { name: "70. The Python SDK", exact: true }).waitFor();
    for (const exercise of ["query", "conversation", "tool"]) {
      await page.getByLabel("Exercise", { exact: true }).selectOption(exercise);
      await page.getByRole("button", { name: "Run Python exercise", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Exercise completed." }).waitFor();
      const output = await page.getByLabel("Python output").textContent();
      assert.match(output!, exercise === "tool" ? /returned 42/ : exercise === "conversation" ? /Turn 2:/ : /query\(\)/);
    }
    await page.getByRole("button", { name: "Load Python and bridge source" }).click();
    await page.getByText("lesson.py", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise<void>((r) => server.close(() => r())); }
});
