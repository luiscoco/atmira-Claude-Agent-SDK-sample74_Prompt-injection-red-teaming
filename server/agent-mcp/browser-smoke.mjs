// Optional UI check; uses local Chrome. Offline: it never starts Claude Code and never runs a model turn.
import express from "express";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { concept61 } from "../concepts/61-agent-as-mcp-server.ts";

const app = express(); app.use(express.json()); app.use("/api/c61", concept61);
const api = app.listen(3061, "localhost");
const web = await createServer({ server: { port: 5190, strictPort: true } });
let chrome, socket;
try {
  await web.listen();
  const output = path.resolve("agent-mcp-lab/browser-smoke"); mkdirSync(output, { recursive: true });
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
  await cdp("Page.navigate", { url: "http://localhost:5190/?lesson=61" });
  await waitFor(`document.querySelector('h2')?.textContent === '61. Exposing your agent as an MCP server'`);
  // A: the real tools/list, with the output schema, and nothing of the inner agent in it.
  await waitFor(`document.body.textContent.includes('"name": "review_refund"') && document.body.textContent.includes('outputSchema') && document.body.textContent.includes('refund-desk://policy')`);
  // B: the contract table, every scenario, and the pre-checks that never start the agent.
  const rows = `Array.from(document.querySelectorAll('table.compare')[0].querySelectorAll('tbody tr'))`;
  await waitFor(`${rows}.length === 10`);
  assert.equal(await evaluate(`${rows}.filter(tr => tr.children[4].textContent === 'no').length`), 5, "five refusals before the agent starts");
  assert.ok(await evaluate(`${rows}[0].children[1].textContent.startsWith('ok')`), "the valid call is ok");
  // C: both transport checks, run from the page (stdio starts a child process with the scripted runner).
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Check Streamable HTTP').click()`);
  await waitFor(`document.body.textContent.includes('no token → 401') && document.body.textContent.includes('forged Host → 403')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Check stdio').click()`);
  await waitFor(`document.body.textContent.includes('stdio ✓') && document.body.textContent.includes('scripted verdict approve for O-205')`);
  // F: Refresh fetches the log again and says so, even when nothing changed.
  const updated = `document.body.textContent.match(/updated ([^.]+)\./)?.[1]`;
  await waitFor(`${updated}`);
  const before = await evaluate(updated);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Refresh').click()`);
  await waitFor(`${updated} && ${updated} !== ${JSON.stringify(before)}`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(output, "lesson61-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), "No horizontal overflow on mobile");
  console.log("Lesson 61 browser checks passed: navigation, tools/list, the contract table, the HTTP and stdio checks, Refresh of the server log and mobile width. No model turns.");
} finally { socket?.close(); chrome?.kill(); await web.close(); api.close(); }
