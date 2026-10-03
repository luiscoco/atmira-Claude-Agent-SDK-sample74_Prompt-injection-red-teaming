// Offline UI verification using local Chrome; no model calls.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept62 } from "../concepts/62-retrieval-rag.ts";

const app = express(); app.use(express.json()); app.use("/api/c62", concept62);
const api = app.listen(3062, "localhost");
const web = await createServer({ server: { port: 5192, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("retrieval-lab/browser-smoke"); mkdirSync(output, { recursive: true });
  chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9234", `--user-data-dir=${output}/profile`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  chrome.on("error", (error) => console.error(error.message));
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://localhost:9234/json")).json(); if (pages.length) break; } catch {}
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
  const click = (label) => evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: "http://localhost:5192/?lesson=62" });
  await waitFor(`document.querySelector('h2')?.textContent === '62. Retrieval (RAG) through custom tools'`);
  await waitFor(`document.body.textContent.includes('6 documents')`);
  await click("Search offline");
  await waitFor(`document.body.textContent.includes('returns-v2#1 · Return window')`);
  await click("Run retrieval checks");
  await waitFor(`document.querySelectorAll('table.compare tbody tr').length === 5`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('table.compare tbody tr')).filter(row => row.lastChild.textContent === 'PASS').length`), 5);
  // Select the missing-evidence exercise with a real DOM change event.
  await evaluate(`const select = document.querySelector('select'); select.value = 'missing'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
  await waitFor(`document.querySelector('input').value === 'warranty lunar rover'`);
  await click("Search offline");
  await waitFor(`document.body.textContent.includes('No matching passages.')`);
  await click("Load source code");
  await waitFor(`document.body.textContent.includes('makeKnowledgeServer')`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson62-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 62 browser checks passed: navigation, corpus, search, missing evidence, five regression cases, source loading, and mobile width. No model calls.");
} finally { socket?.close(); chrome?.kill(); await web.close(); api.close(); }
