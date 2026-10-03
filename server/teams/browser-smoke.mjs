// Optional browser smoke check: node --import tsx server/teams/browser-smoke.mjs
// Uses local Chrome and only mounts lesson 56. Never invokes a live model.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept56 } from "../concepts/56-agent-teams.ts";

const app = express(); app.use(express.json()); app.use("/api/c56", concept56);
const api = app.listen(3061, "localhost");
const web = await createServer({ server: { port: 5186, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("teams-lab/browser-smoke"); mkdirSync(output, { recursive: true });
  chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9229", `--user-data-dir=${output}/profile`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.on("error", (error) => console.error(error.message));
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://localhost:9229/json")).json(); if (pages.length) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(pages?.length, "Chrome debugging endpoint started");
  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.id) { const pair = pending.get(result.id); pending.delete(result.id); result.error ? pair?.reject(result.error) : pair?.resolve(result.result); } };
  function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
  const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: "http://localhost:5186/?lesson=56" });
  async function waitFor(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); }
  await waitFor(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Run full walkthrough') && !b.disabled)`);
  assert.equal(await evaluate(`document.querySelector('h2').textContent`), "56. Agent teams and inter-agent messaging");
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Run full walkthrough')).click()`);
  await waitFor(`document.body.textContent.includes('Team exercise closed')`);
  assert.ok(await evaluate(`document.body.textContent.includes('verified: 37')`));
  await waitFor(`document.body.textContent.includes('Walkthrough run 1 completed')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Run full walkthrough again').click()`);
  await waitFor(`document.body.textContent.includes('Walkthrough run 2 completed')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Restart walkthrough').click()`);
  await waitFor(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Next walkthrough step (0/16)' && !b.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Next walkthrough step (0/16)').click()`);
  await waitFor(`document.body.textContent.includes('Rejected · step 1')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Run full walkthrough').click()`);
  await waitFor(`document.body.textContent.includes('Walkthrough run 3 completed')`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson56-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Reset exercise').click()`);
  await waitFor(`!document.body.textContent.includes('Team exercise closed')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Queue message').click()`);
  await waitFor(`document.body.textContent.includes('custom-1')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Deliver recipient inbox').click()`);
  await waitFor(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Acknowledge first delivered message' && !b.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Acknowledge first delivered message').click()`);
  await waitFor(`document.body.textContent.includes('Recipient acknowledged receipt')`);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 56 browser checks passed: navigation, full walkthrough, reset, custom messaging, mobile width. No live API calls.");
} finally {
  socket?.close(); chrome?.kill(); await web.close(); api.close();
}
