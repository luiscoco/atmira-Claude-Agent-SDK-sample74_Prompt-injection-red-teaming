import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { snapshotRef, resultText, toolPolicy } from "./browser.js";
import { startFixture } from "./fixture.js";
import { concept64 } from "../concepts/64-browser-playwright-mcp.js";

test("live host policy blocks foreign navigation, arbitrary files and code tools", () => {
  const url = "http://127.0.0.1:54321/";
  assert.equal(toolPolicy("mcp__playwright__browser_navigate", { url }, url), null);
  for (const destination of ["https://example.com/", "file:///etc/passwd", `${url}redirect`, "javascript:alert(1)"])
    assert.ok(toolPolicy("mcp__playwright__browser_navigate", { url: destination }, url));
  for (const tool of ["browser_evaluate", "browser_run_code", "browser_file_upload", "browser_tabs", "browser_install"])
    assert.ok(toolPolicy(`mcp__playwright__${tool}`, {}, url));
  assert.ok(toolPolicy("Bash", { command: "curl example.com" }, url));
  assert.ok(toolPolicy("mcp__playwright__browser_snapshot", { filename: "../../secret" }, url));
  assert.ok(toolPolicy("mcp__playwright__browser_take_screenshot", { filename: "../../proof.png" }, url));
  assert.equal(toolPolicy("mcp__playwright__browser_take_screenshot", { filename: "proof.png", type: "png" }, url), null);
});

test("snapshot references are observed; MCP errors cannot appear successful", () => {
  assert.equal(snapshotRef('- textbox "Your name" [ref=e9]', "textbox", "Your name"), "e9");
  assert.throws(() => snapshotRef('- textbox "Other name" [ref=e9]', "textbox", "Your name"), /do not guess/);
  assert.throws(() => resultText({ isError: true, content: [{ type: "text", text: "Stale reference" }] }), /Stale reference/);
});

test("real fixture enforces one valid submission and isolates runs", async () => {
  const a = await startFixture(); const b = await startFixture();
  try {
    const page = await fetch(a.url); assert.match(page.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.match(await page.text(), /Imported note/);
    const book = (body: unknown) => fetch(`${a.url}book`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await book({ name: "", workshop: "playwright" })).status, 400);
    assert.equal((await book({ name: "Alex", workshop: "other" })).status, 400);
    const response = await book({ name: "Alex", workshop: "playwright" }); assert.equal(response.status, 200);
    assert.equal((await response.json()).confirmation, "Confirmed: Alex — Playwright MCP");
    assert.equal((await book({ name: "Alex", workshop: "playwright" })).status, 409);
    assert.equal(a.bookings.length, 1); assert.equal(b.bookings.length, 0);
  } finally { await a.close(); await b.close(); }
});

test("HTTP validates before starting a browser and hides unknown artifacts", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c64", concept64);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c64`;
  try {
    assert.equal((await fetch(`${base}/facts`)).status, 200);
    for (const body of [{ mode: "unknown", name: "Alex" }, { mode: "guided", name: "<script>" }, { mode: "guided", name: "Alex", url: "https://example.com" }]) {
      const response = await fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(`${base}/artifacts/unknown/proof.png`)).status, 404);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
