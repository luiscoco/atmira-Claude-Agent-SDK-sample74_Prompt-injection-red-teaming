import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import { guidedRun } from "./browser.js";
import { startFixture } from "./fixture.js";
import { concept64 } from "../concepts/64-browser-playwright-mcp.js";

test("real Playwright MCP: discover, navigate, snapshot refs, fill, submit, verify and screenshot", { timeout: 90_000 }, async () => {
  const fixture = await startFixture(); const abort = new AbortController(); const events: string[] = [];
  const timer = setTimeout(() => abort.abort(), 80_000);
  try {
    const result = await guidedRun(fixture.url, randomUUID(), "Alex Learner", abort.signal, (name) => events.push(name));
    assert.equal(fixture.bookings.length, 1); assert.equal(fixture.bookings[0].name, "Alex Learner");
    assert.equal(fixture.bookings[0].workshop, "playwright");
    assert.match(result.snapshot, /Confirmed: Alex Learner — Playwright MCP/);
    assert.deepEqual([...readFileSync(result.screenshot).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    for (const tool of ["catalog", "browser_type", "browser_select_option", "browser_click", "browser_wait_for", "browser_take_screenshot", "browser_close"]) assert.ok(events.includes(tool));
  } finally { clearTimeout(timer); await fixture.close(); }
});

test("built lesson UI runs the guided workflow and renders verified evidence", { timeout: 90_000 }, async () => {
  // Use the same Playwright dependency as the pinned MCP package.
  const require = createRequire(import.meta.url);
  const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");
  const app = express(); app.use(express.json()); app.use("/api/c64", concept64); app.use(express.static(path.resolve("dist")));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true,
      ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?lesson=64`);
    await page.getByRole("heading", { name: "64. Browser automation with Playwright MCP", exact: true }).waitFor();
    await page.getByLabel("Fictional attendee name").fill("Taylor Learner");
    await page.getByRole("button", { name: "Run guided browser", exact: true }).click();
    await page.getByText("PASS · host verified the expected booking", { exact: true }).waitFor({ timeout: 70_000 });
    assert.equal(await page.getByRole("alert").count(), 0);
    const image = page.getByAltText("Browser screenshot of the practice desk after submission");
    await image.waitFor();
    assert.equal(await image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
