// Optional UI check; uses local Chrome. Offline: it never starts Claude Code and never runs a model turn.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept60 } from "../concepts/60-durable-agents.ts";

const app = express(); app.use(express.json()); app.use("/api/c60", concept60);
const api = app.listen(3061, "localhost");
const web = await createServer({ server: { port: 5190, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("durable-lab/browser-smoke"); mkdirSync(output, { recursive: true });
  chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9233", `--user-data-dir=${output}/profile`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.on("error", (error) => console.error(error.message));
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://localhost:9233/json")).json(); if (pages.length) break; } catch {}
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
  await cdp("Page.navigate", { url: "http://localhost:5190/?lesson=60" });
  await waitFor(`document.querySelector('h2')?.textContent === '60. Durable, long-running agents'`);
  await waitFor(`document.body.textContent.includes('60-durable-agents.ts') && document.body.textContent.includes('R-108')`);
  // The crash-window table (default: crash after effect 3) shows 3, 1 and 0 duplicates for naive, journal and durable.
  const duplicates = `Array.from(document.querySelectorAll('table.compare')[0].querySelectorAll('tbody tr')).map(tr => tr.children[4].textContent).join(',')`;
  await waitFor(`${duplicates} === '3,1,0'`);
  // Move the slider: crashing after effect 8 still costs naive 8 duplicates and durable none.
  await evaluate(`(() => { const input = document.querySelector('input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '8'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`${duplicates} === '8,1,0'`);
  // The supervisor table lists every action the policy can take.
  for (const action of ["resume", "retry", "fresh", "fail", "done"]) assert.ok(await evaluate(`Array.from(document.querySelectorAll('td b')).some(b => b.textContent === '${action}')`), `policy row with ${action}`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson60-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 60 browser checks passed: navigation, refund table, crash-window simulation and slider, supervisor policy and mobile width. No model turns.");
} finally { socket?.close(); chrome?.kill(); await web.close(); api.close(); }
