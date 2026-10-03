import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../agent-mcp/agent.js";
import type { Runner } from "./socket.js";

export const liveRunner: Runner = async ({ prompt }, abortController, emit) => {
  const root = fileURLToPath(new URL("../../realtime-lab/", import.meta.url));
  const work = path.join(root, "work"), config = path.join(root, "config");
  mkdirSync(work, { recursive: true }); mkdirSync(config, { recursive: true });
  const run = query({ prompt, options: {
    model: "claude-haiku-4-5", systemPrompt: "You teach real-time frontends. Answer concisely in plain text, at most 150 words.",
    includePartialMessages: true, thinking: { type: "disabled" }, tools: [], allowedTools: [], mcpServers: {},
    settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", persistSession: false,
    maxTurns: 1, maxBudgetUsd: 0.05, cwd: work, env: agentEnv(config), abortController,
  } });
  let completed = false;
  try {
    for await (const message of run) {
      if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
        emit("delta", { text: message.event.delta.text });
      }
      // Authoritative final text replaces accumulated deltas; never append it twice.
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) throw new Error(`Agent ended with ${message.subtype}${message.is_error ? " (error)" : ""}`);
        completed = true; emit("result", { text: message.result, costUsd: message.total_cost_usd });
      }
    }
    if (!completed && !abortController.signal.aborted) throw new Error("Agent ended without a result.");
  } finally { run.close(); }
};
