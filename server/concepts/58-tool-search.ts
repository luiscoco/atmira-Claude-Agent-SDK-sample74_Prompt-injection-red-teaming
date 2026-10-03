import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { createSdkMcpServer, query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { catalog, estimateTokens, metadataProfiles, modeSchema, needle, plan, sdkTools, search, server, taskPrompt } from "../tool-search/catalog.js";

export const concept58 = Router();
const model = "claude-haiku-4-5-20251001"; // tool search needs tool_reference support: Haiku/Sonnet/Opus 4.5 and later
const configSchema = z.object({ mode: modeSchema, metadata: z.enum(metadataProfiles), pinNeedle: z.boolean() }).strict();
type Config = z.infer<typeof configSchema>;
let active = false; // one Claude Code process for this lesson at a time

concept58.get("/facts", (_req, res) => {
  const rows = catalog();
  res.json({ server, model, taskPrompt, needle, liveAvailable: Boolean(process.env.ANTHROPIC_API_KEY), tools: rows.map((row) => ({ name: row.name, domain: row.domain, tokens: estimateTokens(row), searchHint: row.searchHint ?? null })) });
});
concept58.get("/code", (_req, res) => res.json({
  "58-tool-search.ts": readFileSync(new URL("./58-tool-search.ts", import.meta.url), "utf8"),
  "catalog.ts": readFileSync(new URL("../tool-search/catalog.ts", import.meta.url), "utf8"),
}));
concept58.post("/search", (req, res) => {
  const parsed = z.object({ query: z.string().min(1).max(200), metadata: z.enum(metadataProfiles) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json(search(parsed.data.query, parsed.data.metadata));
});
concept58.post("/plan", (req, res) => {
  const parsed = configSchema.extend({ contextWindow: z.number().int().min(10_000).max(1_000_000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json(plan(parsed.data.mode, parsed.data));
});

/** Options shared by /measure and /run. Only ToolSearch is enabled among the built-ins: with tools: [] it is gone too, and nothing can be deferred. */
function options(config: Config, onCall: Parameters<typeof sdkTools>[2], abortController: AbortController): Options {
  const configDir = path.resolve("toolsearch-lab/config"); mkdirSync(configDir, { recursive: true });
  // Drop inherited CLAUDE_* (for example CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, which forces tool search off) and set the mode explicitly.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && key !== "ENABLE_TOOL_SEARCH"));
  return {
    model, tools: ["ToolSearch"], settingSources: [], strictMcpConfig: true, persistSession: false, abortController,
    env: { ...env, ENABLE_TOOL_SEARCH: config.mode, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    mcpServers: { [server]: createSdkMcpServer({
      name: server, version: "1.0.0", tools: sdkTools(config.metadata, config.pinNeedle, onCall),
      // With tool search, server instructions are what tells the model WHEN to search this server.
      instructions: "Operations back office: billing (invoices, refunds), CRM, shipping, inventory, HR, analytics, support and marketing. Search these tools for any request about customers' orders, invoices or money.",
    }) },
    // Not in allowedTools: a bare allow rule would skip this callback. Only ToolSearch and the catalog are allowed.
    canUseTool: async (name, input) => name === "ToolSearch" || name.startsWith(`mcp__${server}__`)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Only ToolSearch and the operations catalog are available." },
  };
}
async function waitForServer(q: ReturnType<typeof query>) {
  for (let i = 0; i < 50; i++) {
    if ((await q.mcpServerStatus()).some((status) => status.name === server && status.status === "connected")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The in-process MCP server did not connect within 5 seconds.");
}
const summarize = (usage: Awaited<ReturnType<ReturnType<typeof query>["getContextUsage"]>>) => ({
  totalTokens: usage.totalTokens, maxTokens: usage.maxTokens,
  categories: usage.categories.filter((row) => row.tokens > 0).map(({ name, tokens, kind }) => ({ name, tokens, kind })),
  mcpToolTokens: usage.mcpTools.reduce((sum, row) => sum + row.tokens, 0), mcpToolCount: usage.mcpTools.length,
  loaded: usage.mcpTools.filter((row) => row.isLoaded).map((row) => row.name),
});

/** POST /measure: start Claude Code, wait for the MCP server, read getContextUsage(). No prompt is sent, so no model turn runs. */
concept58.post("/measure", async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  if (active) return res.status(409).json({ message: "A lesson 58 run is already active." });
  active = true;
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), 30_000);
  res.on("close", () => stop.abort());
  // A prompt stream that never yields: the session stays open for control requests only.
  async function* silent(): AsyncGenerator<SDKUserMessage> { await new Promise((resolve) => stop.signal.addEventListener("abort", resolve)); }
  const q = query({ prompt: silent(), options: options(parsed.data, () => {}, stop) });
  try {
    await waitForServer(q);
    res.json({ config: parsed.data, ...summarize(await q.getContextUsage()) });
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ message: stop.signal.aborted ? "Measurement cancelled or exceeded 30 seconds." : String(error) });
  } finally { clearTimeout(deadline); stop.abort(); q.close(); active = false; }
});

/** POST /run: the refund task, live and billed. Streams ToolSearch calls, handler calls and the SDK result. */
concept58.post("/run", async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  if (active) return res.status(409).json({ message: "A lesson 58 run is already active." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "The live run requires ANTHROPIC_API_KEY in .env (it uses an isolated config directory, not your CLI login)." });
  active = true;
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "90-second host deadline reached." }); abort.abort(); }, 90_000);
  const handlerCalls: { name: string; args: unknown; isError: boolean }[] = [];
  const searches: { input: unknown; loaded: string[]; raw: string }[] = [];
  const pending = new Map<string, unknown>();
  let status = "incomplete", answer = "", costUsd = 0, inputTokens = 0, turns = 0, after: ReturnType<typeof summarize> | null = null;
  let finished!: () => void; const done = new Promise<void>((resolve) => { finished = resolve; });
  // Streaming input keeps the session open after the result, so getContextUsage() can show what was loaded.
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: taskPrompt }, parent_tool_use_id: null };
    await done;
  }
  const q = query({ prompt: prompt(), options: { ...options(parsed.data, (name, args, result) => {
    handlerCalls.push({ name, args, isError: Boolean(result.isError) });
    send("call", { name, args, result: JSON.parse(result.content[0].text), isError: Boolean(result.isError) });
  }, abort), maxTurns: 8, maxBudgetUsd: 0.15 } });
  try {
    send("start", { config: parsed.data, model, prompt: taskPrompt });
    for await (const message of q) {
      send("message", message);
      if (message.type === "system" && message.subtype === "init") send("init", { tools: message.tools.length, toolSearch: message.tools.includes("ToolSearch") });
      if (message.type === "assistant") for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name === "ToolSearch") pending.set(block.id, block.input);
      }
      if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) {
        if (block.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
        // ToolSearch answers with tool_reference blocks: those are the definitions loaded into context from now on.
        const loaded = (Array.isArray(block.content) ? block.content : []).flatMap((item: any) => item.type === "tool_reference" ? [item.tool_name] : []);
        // The raw excerpt stays as evidence in case a CLI version encodes the result differently.
        const entry = { input: pending.get(block.tool_use_id), loaded, raw: JSON.stringify(block.content).slice(0, 600) }; searches.push(entry); send("search", entry);
      }
      if (message.type === "result") {
        status = message.is_error ? `error:${message.subtype}` : message.subtype;
        costUsd = message.total_cost_usd; turns = message.num_turns;
        inputTokens = message.usage.input_tokens + message.usage.cache_creation_input_tokens + message.usage.cache_read_input_tokens;
        if (message.subtype === "success") answer = message.result;
        try { after = summarize(await q.getContextUsage({ detail: "summary" })); } catch { /* evidence is optional */ }
        finished();
      }
    }
  } catch (error) {
    status = abort.signal.aborted ? "cancelled" : "error";
    if (!res.destroyed) send("error", { message: String(error) });
  } finally {
    finished(); clearTimeout(deadline); q.close(); active = false;
    const refunded = handlerCalls.some((call) => !call.isError && /refund|op_7/.test(call.name));
    if (!res.destroyed) {
      send("summary", { config: parsed.data, status, answer, costUsd, inputTokens, turns, searches, handlerCalls, after, correct: refunded && answer.includes(needle.refundId) });
      send("done", {}); res.end();
    }
  }
});
