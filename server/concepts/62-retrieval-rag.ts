import { Router } from "express";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import { documents, exercises } from "../retrieval/corpus.js";
import { answerSchema, chunks, makeKnowledgeServer, search, searchSchema, systemPrompt, validateAnswer, type Hit } from "../retrieval/retrieval.js";

export const concept62 = Router();
concept62.get("/facts", (_req, res) => res.json({ documents, chunks, exercises, systemPrompt, searchSchema: z.toJSONSchema(searchSchema), model: "claude-haiku-4-5" }));
concept62.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["62-retrieval-rag.ts", new URL("./62-retrieval-rag.ts", import.meta.url)],
  ["retrieval.ts", new URL("../retrieval/retrieval.ts", import.meta.url)],
  ["corpus.ts", new URL("../retrieval/corpus.ts", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));
concept62.post("/search", (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json({ hits: search(parsed.data) });
});
concept62.get("/eval", (_req, res) => res.json(exercises.map((exercise) => {
  const hits = search({ query: exercise.query, topK: 3 });
  return { ...exercise, ids: hits.map((hit) => hit.id), pass: exercise.expected === null ? !hits.length : hits[0]?.id === exercise.expected };
})));

const requestSchema = z.object({ question: z.string().trim().min(1).max(2000) }).strict();
let active = false;
concept62.post("/query", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  if (active) return res.status(409).json({ message: "A lesson 62 run is already active." });
  active = true;
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => abort.abort(), 90_000);
  let run: ReturnType<typeof query> | undefined;
  try {
    const lab = fileURLToPath(new URL("../../retrieval-lab/", import.meta.url));
    const work = path.join(lab, "work"); mkdirSync(work, { recursive: true });
    const retrieved = new Map<string, Hit>();
    const knowledge = makeKnowledgeServer(retrieved, (name, args, result) => send("retrieval", { name, args, result }));
    const { $schema: _schema, ...schema } = z.toJSONSchema(answerSchema);
    send("options", { model: "claude-haiku-4-5", tools: [], allowedTools: ["mcp__knowledge__search_knowledge", "mcp__knowledge__get_passage"], maxTurns: 6, maxBudgetUsd: 0.1 });
    run = query({ prompt: parsed.data.question, options: {
      model: "claude-haiku-4-5", systemPrompt, thinking: { type: "disabled" },
      tools: [], allowedTools: ["mcp__knowledge__search_knowledge", "mcp__knowledge__get_passage"], mcpServers: { knowledge },
      settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", persistSession: false,
      cwd: work, env: agentEnv(path.join(lab, "config")), abortController: abort,
      maxTurns: 6, maxBudgetUsd: 0.1, outputFormat: { type: "json_schema", schema },
    } });
    let completed = false;
    for await (const message of run) {
      send("message", message);
      if (message.type !== "result") continue;
      completed = true;
      if (message.subtype !== "success") throw new Error(`Agent ended with ${message.subtype}.`);
      const answer = validateAnswer(message.structured_output, retrieved);
      send("answer", { ...answer, sources: [...retrieved.values()], costUsd: message.total_cost_usd });
    }
    if (!completed) throw new Error("Agent ended without a result.");
  } catch (error) {
    if (!res.destroyed) send("error", { message: abort.signal.aborted ? "Run stopped or reached the 90-second deadline." : error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(deadline); run?.close(); active = false;
    if (!res.destroyed) { send("done", {}); res.end(); }
  }
});
