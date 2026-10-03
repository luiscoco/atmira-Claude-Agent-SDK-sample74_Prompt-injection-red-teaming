import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import express from "express";
import { createEmbeddingRouter } from "../concepts/69-embedding-sdk.js";

const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");
test("Lesson 69 browser trusts, streams, reviews, rejects stale edits and cancels", { timeout: 60_000 }, async () => {
  const app = express(); app.use(express.json()); app.use("/api/c69", createEmbeddingRouter(async () => { throw new Error("No model calls in browser tests."); }));
  app.use(express.static(path.resolve("dist")));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?lesson=69`);
    const rewrite = page.getByRole("button", { name: "Propose rewrite", exact: true });
    assert.ok(await rewrite.isDisabled());
    await page.getByLabel("Trust the demo workspace").check();
    await page.getByRole("button", { name: "Explain selection", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "completed" }).waitFor();
    assert.match(await page.getByLabel("Streamed response").textContent() || "", /host captured/);
    const original = await page.locator("#embedding-buffer").inputValue();
    await rewrite.click();
    const apply = page.getByRole("button", { name: "Apply reviewed edit", exact: true });
    await apply.waitFor(); await apply.click();
    assert.match(await page.locator("#embedding-buffer").inputValue(), /^\/\/ Reviewed in Lesson 69/);
    await rewrite.click(); await apply.waitFor();
    await page.locator("#embedding-buffer").fill(original + "// User edit\n");
    await apply.click();
    await page.getByRole("status").filter({ hasText: "Document changed" }).waitFor();
    assert.equal(await page.locator("#embedding-buffer").inputValue(), original + "// User edit\n");
    await rewrite.click();
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Run stopped" }).waitFor();
    assert.equal(await apply.count(), 0);
    await page.getByRole("button", { name: "Load source code", exact: true }).click();
    await page.getByText("extension.cjs", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
