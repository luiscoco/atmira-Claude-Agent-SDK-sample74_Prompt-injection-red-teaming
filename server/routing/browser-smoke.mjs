// Optional UI check; uses local Chrome and starts Claude Code once for supportedModels(), but never runs a model turn.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept59 } from "../concepts/59-model-routing.ts";

const app = express(); app.use(express.json()); app.use("/api/c59", concept59);
const api = app.listen(3061, "localhost");
const web = await createServer({ server: { port: 5189, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("routing-lab/browser-smoke"); mkdirSync(output, { recursive: true });
  chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9232", `--user-data-dir=${output}/profile`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.on("error", (error) => console.error(error.message));
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://localhost:9232/json")).json(); if (pages.length) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(pages?.length, "Chrome debugging endpoint started");
  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.id) { const pair = pending.get(result.id); pending.delete(result.id); result.error ? pair?.reject(result.error) : pair?.resolve(result.result); } };
  function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
  const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  async function waitFor(expression) { for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); }
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: "http://localhost:5189/?lesson=59" });
  await waitFor(`document.querySelector('h2')?.textContent === '59. Model routing'`);
  await waitFor(`document.body.textContent.includes('59-model-routing.ts') && document.body.textContent.includes('claude-opus-5-5')`);
  // The task table marks the rule router's three misroutes, and the projection lists all 8 strategies.
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('td')).filter(td => td.textContent.endsWith(' ✗')).length`), 3);
  assert.ok(await evaluate(`document.body.textContent.includes('review') && document.body.textContent.includes('opus-low')`));
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.startsWith('supportedModels()')).click()`);
  await waitFor(`Array.from(document.querySelectorAll('code')).some(c => c.textContent === 'sonnet')`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson59-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 59 browser checks passed: navigation, task table, projection, a real supportedModels() call and mobile width. No model turns.");
} finally { socket?.close(); chrome?.kill(); await web.close(); api.close(); }
