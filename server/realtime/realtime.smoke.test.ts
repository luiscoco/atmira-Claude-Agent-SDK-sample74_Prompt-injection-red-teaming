import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import express from "express";
import { createServer as createViteServer } from "vite";
import config from "../../vite.config.js";
import { concept66 } from "../concepts/66-realtime-websocket.js";
import { attachRealtime } from "./socket.js";

const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright") as typeof import("playwright");

test("browser renders streamed text, cancels, reconnects, and loads source without model calls", { timeout: 60000 }, async () => {
  const app = express(); app.use("/api/c66", concept66); app.use(express.static(path.resolve("dist")));
  const server = createServer(app);
  const host = attachRealtime(server, async () => { throw new Error("Live mode must not run in smoke tests"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true,
      ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?lesson=66`);
    await page.getByText("Connection: connected · Run: ready", { exact: true }).waitFor();
    const start = page.getByRole("button", { name: "Stream guided response (no model API)", exact: true });
    const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
    // An idle drop must remain visible instead of immediately reconnecting.
    await page.getByRole("button", { name: "Drop connection", exact: true }).click();
    await page.getByText("Connection: disconnected · Run: ready", { exact: true }).waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await start.isEnabled(), false);
    assert.equal(await page.getByText("Connection: disconnected · Run: ready", { exact: true }).count(), 1);
    await reconnect.click();
    await page.getByText("Connection: connected · Run: ready", { exact: true }).waitFor();
    await start.click();
    await page.getByText("Connection: connected · Run: completed", { exact: true }).waitFor();
    assert.match(await page.locator("pre").first().innerText(), /Guided response to:/);
    await start.click(); await page.getByText("Connection: connected · Run: streaming", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByText("Connection: connected · Run: cancelled", { exact: true }).waitFor();
    await start.click(); await page.getByText("Connection: connected · Run: streaming", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Drop connection", exact: true }).click();
    await page.getByText("Connection: disconnected · Run: disconnected — run cancelled by host", { exact: true }).waitFor();
    assert.equal(await start.isEnabled(), false);
    await reconnect.click();
    await page.getByText("Connection: connected · Run: disconnected — run cancelled by host", { exact: true }).waitFor();
    assert.equal(await start.isEnabled(), true);
    await start.click(); await page.getByText("Connection: connected · Run: completed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Load source code", exact: true }).click();
    await page.locator("summary").filter({ hasText: /^socket.ts$/ }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally {
    await browser?.close(); host.dispose();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test("Vite development proxy forwards browser WebSocket upgrades and preserves origin", { timeout: 60000 }, async () => {
  const server = createServer(); const host = attachRealtime(server, async () => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  // Keep the actual project's WebSocket and Host proxy settings, replacing only its test target.
  const proxy = (config.server!.proxy!["/api"] as { ws?: boolean; changeOrigin?: boolean; target: string });
  assert.equal(proxy.ws, true); assert.equal(proxy.changeOrigin, false);
  const vite = await createViteServer({ ...config, configFile: false, server: { ...config.server, port: 0, host: "127.0.0.1",
    proxy: { "/api": { ...proxy, target: `http://127.0.0.1:${address.port}` } } } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen(); const webAddress = vite.httpServer!.address(); assert.ok(webAddress && typeof webAddress === "object");
    browser = await chromium.launch({ channel: "chrome", headless: true,
      ...(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${webAddress.port}/?lesson=66`);
    await page.getByText("Connection: connected · Run: ready", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stream guided response (no model API)", exact: true }).click();
    await page.getByText("Connection: connected · Run: completed", { exact: true }).waitFor();
    // Unexpected host-side loss still reconnects automatically through Vite.
    for (const ws of host.wss.clients) ws.terminate();
    await page.getByText(/Connection: reconnecting/).waitFor();
    await page.getByText("Connection: connected · Run: completed", { exact: true }).waitFor();
  } finally {
    await browser?.close(); await vite.close(); host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
