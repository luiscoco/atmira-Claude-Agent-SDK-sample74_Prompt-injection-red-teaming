// Optional UI check; uses local Chrome and real Git, never a model API.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept57 } from "../concepts/57-parallel-worktrees.ts";

const app = express(); app.use(express.json()); app.use("/api/c57", concept57);
const api = app.listen(3061, "localhost");
const web = await createServer({ server: { port: 5187, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("worktrees-lab/browser-smoke"); mkdirSync(output, { recursive: true });
  chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9230", `--user-data-dir=${output}/profile`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.on("error", (error) => console.error(error.message));
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://localhost:9230/json")).json(); if (pages.length) break; } catch {}
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
  await cdp("Page.navigate", { url: "http://localhost:5187/?lesson=57" });
  await waitFor(`document.querySelector('h2')?.textContent === '57. Parallel workers in git worktrees'`);
  await waitFor(`document.body.textContent.includes('57-parallel-worktrees.ts')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Run offline worktree lab').click()`);
  await waitFor(`document.body.textContent.includes('Run success. 2 commits integrated. Cleanup complete.')`);
  assert.ok(await evaluate(`document.body.textContent.includes('validated diff')`));
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson57-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate(`(() => { const select = document.querySelector('main select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'conflict'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('main select').value === 'conflict'`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Run offline worktree lab').click()`);
  await waitFor(`document.body.textContent.includes('Run conflict. 1 commits integrated. Cleanup deferred.')`);
  assert.ok(await evaluate(`document.body.textContent.includes('The second cherry-pick was aborted')`));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 57 browser checks passed: navigation, independent integration, conflict evidence and mobile width. No model calls.");
} finally { socket?.close(); chrome?.kill(); await web.close(); api.close(); }
