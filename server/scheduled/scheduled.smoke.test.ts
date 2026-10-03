import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { createScheduledRouter } from "../concepts/68-scheduled-event-driven.js";
import { ScheduledWorkshop } from "./workshop.js";

const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");
test("lesson browser queues scheduled and signed work, deduplicates and recovers retries", { timeout: 60000 }, async () => {
  const queue = new ScheduledWorkshop(), app = express();
  app.use("/api/c68", createScheduledRouter(queue, async () => { throw new Error("No model calls"); }));
  app.use(express.static(path.resolve("dist")));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    // Startup can outlast the former 15-second browser timeout while Vite waits
    // for the backend. The clock must load without an abort or error banner.
    await page.route("**/api/c68/state", async (route) => {
      await delay(16_000);
      await route.fulfill({ json: queue.snapshot() });
    });
    await page.goto(`http://127.0.0.1:${address.port}/?lesson=68`);
    await page.getByText("No jobs yet. Enable a schedule or send an event.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.unroute("**/api/c68/state");
    await page.getByRole("button", { name: "Enable schedule", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Schedule enabled" }).waitFor();
    await page.getByRole("button", { name: "Advance clock 30 seconds", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Clock advanced" }).waitFor();
    assert.equal(queue.snapshot().jobs.length, 1);
    await page.getByRole("button", { name: "Pause schedule", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Schedule paused" }).waitFor();
    assert.match(await page.locator("#scheduled-clock").innerText(), /paused; no new occurrences/);
    assert.ok(!(await page.locator("#scheduled-clock").innerText()).includes("next occurrence"));
    await page.getByRole("button", { name: "Run next job", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Attempt 1: succeeded" }).waitFor();
    // Feedback belongs beside the webhook button, even if no job is added.
    await page.route("**/api/c68/fixture", async (route) => {
      await delay(500);
      await route.continue();
    });
    await page.getByRole("button", { name: "Send signed webhook", exact: true }).click();
    await page.getByRole("button", { name: "Sending signed webhook…", exact: true }).waitFor();
    await page.locator("#scheduled-event-status").filter({ hasText: "Signing and sending" }).waitFor();
    await page.locator("#scheduled-event-status").filter({ hasText: "Signed event incident-001 accepted" }).waitFor();
    await page.unroute("**/api/c68/fixture");
    await page.getByRole("button", { name: "Send signed webhook", exact: true }).click();
    await page.locator("#scheduled-event-status").filter({ hasText: "Duplicate incident-001" }).waitFor();
    assert.match(await page.locator("#scheduled-event-status").innerText(), /Change the Event ID/);
    await page.locator("#scheduled-event-status").filter({ hasText: "Current job status: queued" }).waitFor();
    assert.equal(queue.snapshot().jobs.length, 2);
    // A sender failure remains next to the button across successful background
    // polling. Use an empty response to exercise failure without console errors.
    await page.route("**/api/c68/fixture", (route) => route.fulfill({ status: 200, body: "" }));
    await page.getByRole("button", { name: "Send signed webhook", exact: true }).click();
    await page.locator("#scheduled-event-error").filter({ hasText: "empty response" }).waitFor();
    await page.waitForResponse((response) => response.url().endsWith("/api/c68/state"));
    assert.match(await page.locator("#scheduled-event-error").innerText(), /empty response/);
    await page.unroute("**/api/c68/fixture");
    await page.getByRole("button", { name: "Send signed webhook", exact: true }).click();
    await page.locator("#scheduled-event-status").filter({ hasText: "Duplicate incident-001" }).waitFor();
    assert.equal(await page.locator("#scheduled-event-error").count(), 0);
    await page.getByLabel("Execution mode").selectOption("fail");
    await page.getByRole("button", { name: "Run next job", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Attempt 1: retry" }).waitFor();
    await page.locator("#scheduled-event-status").filter({ hasText: "Current job status: retry" }).waitFor();
    await page.getByRole("button", { name: "Advance clock 30 seconds", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Clock advanced" }).waitFor();
    await page.getByLabel("Execution mode").selectOption("guided");
    await page.getByRole("button", { name: "Run next job", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Attempt 2: succeeded" }).waitFor();
    await page.locator("#scheduled-event-status").filter({ hasText: "Current job status: succeeded" }).waitFor();
    await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Queue refreshed" }).waitFor();
    const completedNotice = await page.locator("#scheduled-event-status").innerText();
    assert.match(completedNotice, /Duplicate incident-001.*Current job status: succeeded/);
    assert.ok(!completedNotice.includes("Current job status: queued"));
    assert.ok(!completedNotice.includes("Click Run next job"));
    await page.getByLabel("Event ID", { exact: true }).fill("incident-002");
    await page.getByRole("button", { name: "Send signed webhook", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Signed event incident-002 accepted" }).waitFor();
    await page.getByRole("button", { name: "Cancel job", exact: true }).click();
    await page.getByText("event · cancelled · attempt 0/3", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Load source code", exact: true }).click();
    await page.getByText("workshop.ts", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    // A restarting proxy can return an empty body. Recover without a JSON SyntaxError or stuck controls.
    await page.route("**/api/c68/state", (route) => route.fulfill({ status: 200, body: "" }));
    await page.reload();
    await page.getByRole("alert").filter({ hasText: "empty response" }).waitFor();
    await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "empty response" }).waitFor();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Refresh queue")?.disabled);
    assert.ok(!(await page.getByRole("alert").innerText()).includes("SyntaxError"));
    await page.unroute("**/api/c68/state");
    await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Queue refreshed" }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
