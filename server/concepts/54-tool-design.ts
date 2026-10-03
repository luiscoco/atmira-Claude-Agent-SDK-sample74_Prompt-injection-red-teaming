import { readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { contracts, definitions, invoke, profiles, taskPrompt, type Call } from "../tool-design/catalog.js";

export const concept54 = Router();
const model = "claude-haiku-4-5-20251001";
concept54.get("/facts", (_req, res) => res.json({ profiles, contracts: Object.fromEntries(profiles.map((profile) => [profile, contracts(profile)])), taskPrompt, model, timeoutMs: 60_000 }));
concept54.get("/code", (_req, res) => res.json({
  "54-tool-design.ts": readFileSync(new URL("./54-tool-design.ts", import.meta.url), "utf8"),
  "catalog.ts": readFileSync(new URL("../tool-design/catalog.ts", import.meta.url), "utf8"),
}));
concept54.post("/call", async (req, res) => {
  const parsed = z.object({ profile: z.enum(profiles), name: z.string().min(1).max(80), input: z.unknown() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json(await invoke(parsed.data.profile, parsed.data.name, parsed.data.input));
});
concept54.post("/run", async (req, res) => {
  const parsed = z.object({ profile: z.enum(profiles), mode: z.enum(["offline", "live"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  const { profile, mode } = parsed.data;
  const { abort, send } = openSse(req, res);
  const calls: Call[] = [];
  const log = (call: Call) => { calls.push(call); if (!abort.signal.aborted) send("call", call); };
  const timer = setTimeout(() => abort.abort(new Error("60-second host deadline")), 60_000);
  let status = "incomplete", answer = "", costUsd = 0;
  try {
    send("start", { profile, mode, prompt: taskPrompt, model: mode === "live" ? model : null });
    if (mode === "offline") {
      // Scripted calls demonstrate contracts. They make no claim about a model's choices or answer quality.
      if (profile === "vague") log(await invoke(profile, "lookup", { query: "camping" }));
      else {
        let cursor: string | undefined;
        do {
          const call = await invoke(profile, "catalog_search", { category: "camping", maxPriceCents: 3000, inStockOnly: true, limit: 2, ...(cursor ? { cursor } : {}) });
          log(call); cursor = JSON.parse(call.result.content[0].text).nextCursor ?? undefined;
        } while (cursor);
      }
      status = "scripted";
    } else {
      const wrapped = definitions(profile).map((definition) => tool(definition.name, definition.description, definition.inputSchema, async (args) => {
        abort.signal.throwIfAborted();
        const call = await invoke(profile, definition.name, args); log(call); return call.result;
      }, { annotations: definition.annotations }));
      const run = query({ prompt: taskPrompt, options: {
        model, tools: [], settingSources: [], strictMcpConfig: true,
        mcpServers: { catalog: createSdkMcpServer({ name: "catalog", version: "1.0.0", tools: wrapped }) },
        allowedTools: wrapped.map((definition) => `mcp__catalog__${definition.name}`),
        canUseTool: async () => ({ behavior: "deny", message: "Only the explicitly allowed read-only catalog tools are available." }),
        systemPrompt: "Use the provided catalog to answer the user. Prices are EUR cents. Do not use external information.",
        maxTurns: 8, maxBudgetUsd: 0.25, persistSession: false, abortController: abort,
      } });
      try {
        for await (const message of run) {
          if (abort.signal.aborted) break;
          send("message", message);
          if (message.type === "result") {
            status = message.is_error ? "error" : message.subtype;
            costUsd = message.total_cost_usd;
            if (message.subtype === "success") answer = message.result;
          }
        }
      } finally { run.close(); }
    }
  } catch (error) {
    status = abort.signal.aborted ? "cancelled" : "error";
    if (!res.destroyed) send("error", { message: String(error) });
  } finally {
    clearTimeout(timer);
    if (abort.signal.aborted) status = "cancelled";
    if (!res.destroyed) {
      send("summary", { profile, mode, status, answer, costUsd, calls: calls.length, errors: calls.filter((call) => call.result.isError).length, responseBytes: calls.reduce((sum, call) => sum + call.bytes, 0) });
      send("done", {}); res.end();
    }
  }
});
