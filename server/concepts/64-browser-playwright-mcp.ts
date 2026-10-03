import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import { browserConfig, guidedRun, LAB, systemPrompt, toolNames, toolPolicy } from "../browser/browser.js";
import { startFixture } from "../browser/fixture.js";

export const concept64 = Router();
let active = false;
const artifacts = new Map<string, string>();
const inputSchema = z.object({ mode: z.enum(["guided", "live"]), name: z.string().trim().regex(/^[A-Za-z][A-Za-z -]{0,39}$/, "Use 1–40 letters, spaces or hyphens.") }).strict();
concept64.get("/facts", (_req, res) => res.json({ version: "0.0.83", toolNames, systemPrompt,
  config: { command: "node", args: ["<installed @playwright/mcp>/cli.js", "--headless", "--isolated", "--browser", "chrome", "--allowed-origins", "<fixture origin>"] } }));
concept64.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["browser.ts", new URL("../browser/browser.ts", import.meta.url)], ["fixture.ts", new URL("../browser/fixture.ts", import.meta.url)],
  ["64-browser-playwright-mcp.ts", new URL("./64-browser-playwright-mcp.ts", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));
concept64.get("/artifacts/:id/proof.png", (req, res) => {
  const file = artifacts.get(req.params.id);
  if (!file) return res.status(404).json({ message: "Artifact not available" });
  res.setHeader("Cache-Control", "no-store"); res.sendFile(file);
});
concept64.post("/run", async (req, res) => {
  const input = inputSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: input.error.message });
  if (active) return res.status(409).json({ message: "A lesson 64 browser is already running." });
  active = true;
  const { abort, send } = openSse(req, res);
  const timer = setTimeout(() => abort.abort(), input.data.mode === "live" ? 120_000 : 90_000);
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let run: ReturnType<typeof query> | undefined;
  const id = randomUUID();
  try {
    fixture = await startFixture();
    const config = browserConfig(fixture.url, id);
    send("setup", { id, url: fixture.url, mode: input.data.mode, command: config.command, args: config.args });
    let snapshot: string | undefined; let costUsd = 0;
    if (input.data.mode === "guided") {
      const evidence = await guidedRun(fixture.url, id, input.data.name, abort.signal, (name, result) => send("tool", { name, result }));
      snapshot = evidence.snapshot;
    } else {
      run = query({ prompt: `Book the Playwright MCP workshop for ${input.data.name} at ${fixture.url}. Expected confirmation: Confirmed: ${input.data.name} — Playwright MCP`, options: {
        model: "claude-haiku-4-5", systemPrompt, thinking: { type: "disabled" }, tools: [], settingSources: [], strictMcpConfig: true,
        permissionMode: "dontAsk", allowedTools: toolNames.map((name) => `mcp__playwright__${name}`),
        mcpServers: { playwright: { type: "stdio", command: config.command, args: config.args, env: config.env } },
        hooks: { PreToolUse: [{ hooks: [async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const reason = toolPolicy(input.tool_name, input.tool_input, fixture!.url);
          send("tool", { name: input.tool_name, result: { input: input.tool_input, policy: reason ?? "allowed" } });
          return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : {};
        }] }] },
        cwd: config.work, env: agentEnv(path.join(LAB, "config")), persistSession: false, abortController: abort, maxTurns: 16, maxBudgetUsd: 0.25,
      } });
      let completed = false;
      for await (const message of run) {
        send("message", message);
        if (message.type === "result") {
          if (message.subtype !== "success") throw new Error(`Agent ended with ${message.subtype}`);
          completed = true; costUsd = message.total_cost_usd; send("answer", { text: message.result, costUsd });
        }
      }
      if (!completed) throw new Error("Agent ended without a result");
    }
    const proof = path.join(config.work, "proof.png");
    const screenshotExists = existsSync(proof);
    const verified = fixture.bookings.length === 1 && fixture.bookings[0].name === input.data.name && fixture.bookings[0].workshop === "playwright";
    if (screenshotExists) { artifacts.set(id, proof); if (artifacts.size > 50) artifacts.delete(artifacts.keys().next().value!); }
    send("evidence", { verified, bookings: fixture.bookings, snapshot, screenshotUrl: screenshotExists ? `/api/c64/artifacts/${id}/proof.png` : null, costUsd });
  } catch (error) {
    if (!res.destroyed) { send("evidence", { verified: false, bookings: fixture?.bookings ?? [] }); send("error", { message: abort.signal.aborted ? "Run stopped or deadline reached." : `${String(error)}. Chrome must be installed, or set PLAYWRIGHT_MCP_EXECUTABLE_PATH to a browser executable.` }); }
  } finally {
    clearTimeout(timer);
    try { run?.close(); } finally {
      try { await fixture?.close(); } finally { active = false; if (!res.destroyed) { send("done", {}); res.end(); } }
    }
  }
});
