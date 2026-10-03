import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import express from "express";
import { createServer, type ViteDevServer } from "vite";
import viteConfig from "../../vite.config.js";
import { concept65 } from "../concepts/65-human-approval.js";

for (const mode of ["built", "development"] as const) test(`${mode} lesson UI: Slack review page, Teams rejection, email approval, expiry and cancellation`, { timeout: 60000 }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");
  const app = express(); app.use(express.json()); app.use("/api/c65", concept65);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let web: ViteDevServer | undefined;
  try {
    // Exercise the real development proxy: direct Express tests miss Host/Origin mismatches.
    const proxy = viteConfig.server!.proxy!["/api"];
    const target = `http://127.0.0.1:${address.port}`;
    web = await createServer({ configFile: false, root: path.resolve(mode === "built" ? "dist" : "."), plugins: viteConfig.plugins?.slice(0, 1),
      server: { host: "127.0.0.1", port: 0, watch: viteConfig.server?.watch, proxy: { "/api": typeof proxy === "string" ? target : { ...proxy, target } } } });
    await web.listen();
    const webAddress = web.httpServer!.address(); assert.ok(webAddress && typeof webAddress !== "string");
    const frontend = `http://127.0.0.1:${webAddress.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true,
      ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); const errors: string[] = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${frontend}/?lesson=65`);
    await page.getByRole("heading", { name: "65. Human approval over Slack, Teams or email", exact: true }).waitFor();
    const start = () => page.getByRole("button", { name: "Run guided approval (no model API)", exact: true }).click();
    await start();
    const link = page.getByRole("link", { name: "Open approval page" }); await link.waitFor();
    const review = await browser.newPage(); review.on("pageerror", (error) => errors.push(error.message));
    await review.goto((await link.getAttribute("href"))!);
    await review.getByRole("button", { name: "Approve refund", exact: true }).waitFor();
    assert.equal(new URL(review.url()).hash, "");
    assert.ok((await page.getByRole("status").first().textContent())?.includes("pending"));
    await review.getByRole("button", { name: "Approve refund", exact: true }).click();
    await page.getByText("Host ledger: one fictional refund executed", { exact: true }).waitFor();
    await review.close();
    await page.getByLabel("Channel", { exact: true }).selectOption("teams"); await start();
    // A failed POST must be visible beside the buttons and leave the request retryable.
    await page.route("**/api/c65/decision", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Cross-origin decision blocked" }) }));
    await page.getByRole("button", { name: "Reject refund", exact: true }).click();
    await page.locator(".approval-actions").getByRole("alert").filter({ hasText: "Cross-origin decision blocked" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Reject refund", exact: true }).isEnabled(), true);
    await page.unroute("**/api/c65/decision");
    const rejection = page.waitForResponse((response) => response.url().endsWith("/api/c65/decision") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Reject refund", exact: true }).click();
    assert.equal((await rejection).status(), 200);
    await page.getByText("Host ledger: no refund executed", { exact: true }).waitFor();
    assert.ok((await page.getByRole("status").first().textContent())?.includes("rejected"));
    await page.getByText("Rejection recorded. No refund will execute.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Reject refund", exact: true }).count(), 0);
    await page.getByLabel("Channel", { exact: true }).selectOption("email"); await start();
    const approval = page.waitForResponse((response) => response.url().endsWith("/api/c65/decision") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Approve refund", exact: true }).click();
    assert.equal((await approval).status(), 200);
    await page.getByText("Host ledger: one fictional refund executed", { exact: true }).waitFor();
    assert.equal(new URL((await link.getAttribute("href"))!).origin, frontend);
    await page.getByLabel("Approval expiry in seconds").fill("5"); await start();
    await page.getByText("Host ledger: no refund executed", { exact: true }).waitFor({ timeout: 10000 });
    assert.ok((await page.getByRole("status").first().textContent())?.includes("expired"));
    await page.getByText("This request expired. Start a new run to approve or reject a fresh request.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Approve refund", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Start a new approval request", exact: true }).waitFor();
    await start(); await link.waitFor();
    const url = new URL((await link.getAttribute("href"))!); const credential = Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Run stopped" }).waitFor();
    // The host cancels the pending request when the SSE response closes.
    const status = await page.evaluate(async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch('/api/c65/decision', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,approve:true})});
      return response.status;
    }, credential);
    assert.equal(status, 409); assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await web?.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
