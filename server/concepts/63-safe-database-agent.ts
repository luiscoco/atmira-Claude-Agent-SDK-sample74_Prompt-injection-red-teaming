import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import { DatabaseLab, PolicyRejection, makeDatabaseServer, readSchema, proposalSchema, systemPrompt } from "../database/database.js";

export const concept63 = Router();
const sessions = new Map<string, { lab: DatabaseLab; expires: number; busy: boolean }>();
concept63.get("/facts", (_req, res) => res.json({ systemPrompt, readSchema: z.toJSONSchema(readSchema), proposalSchema: z.toJSONSchema(proposalSchema), model: "claude-haiku-4-5" }));
concept63.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["database.ts", new URL("../database/database.ts", import.meta.url)], ["63-safe-database-agent.ts", new URL("./63-safe-database-agent.ts", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));
concept63.post("/sessions", (_req, res) => {
  for (const [id, session] of sessions) if (session.expires < Date.now() && !session.busy) { session.lab.close(); sessions.delete(id); }
  if (sessions.size >= 50) return res.status(429).json({ message: "Lab capacity reached; try later." });
  const id = randomUUID(); const lab = new DatabaseLab();
  sessions.set(id, { lab, expires: Date.now() + 3_600_000, busy: false });
  res.json({ id, ...lab.snapshot() });
});
concept63.use("/sessions/:id", (req, res, next) => {
  const session = sessions.get(req.params.id);
  if (!session || session.expires < Date.now()) return res.status(404).json({ message: "Lab expired or missing. Start a new lab." });
  res.locals.session = session; next();
});
concept63.get("/sessions/:id", (_req, res) => res.json(res.locals.session.lab.snapshot()));
// The deliberate schema violation is an exercise result, not a failed HTTP request.
concept63.post("/sessions/:id/blocked-sql", (_req, res) => {
  const session = res.locals.session as { lab: DatabaseLab; busy: boolean };
  if (session.busy) return res.status(409).json({ message: "Wait until the agent run ends." });
  try {
    session.lab.list({ sql: "DELETE FROM orders" });
    res.status(500).json({ message: "The SQL guard unexpectedly accepted the exercise." });
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    res.json({ ok: false, message: "Blocked: arbitrary SQL is not allowed. No rows were changed.", ...session.lab.snapshot() });
  }
});
for (const operation of ["read", "propose", "decide"] as const) {
  concept63.post(`/sessions/:id/${operation}`, (req, res) => {
    const session = res.locals.session as { lab: DatabaseLab; busy: boolean };
    if (session.busy) return res.status(409).json({ message: "Wait until the agent run ends." });
    try {
      let result: unknown;
      if (operation === "read") result = session.lab.list(req.body);
      else if (operation === "propose") result = session.lab.propose(req.body);
      else { const input = z.object({ proposalId: z.string().uuid(), approve: z.boolean() }).strict().parse(req.body); result = session.lab.decide(input.proposalId, input.approve); }
      res.json({ ok: true, result, ...session.lab.snapshot() });
    } catch (error) {
      if (error instanceof PolicyRejection) return res.json({ ok: false, message: error.message, ...session.lab.snapshot() });
      if (error instanceof z.ZodError) return res.status(400).json({ message: error.message });
      throw error;
    }
  });
}
let active = false;
concept63.post("/sessions/:id/query", async (req, res) => {
  const input = z.object({ question: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: input.error.message });
  const session = res.locals.session as { lab: DatabaseLab; busy: boolean };
  if (active || session.busy) return res.status(409).json({ message: "A lesson 63 agent is already running." });
  active = true; session.busy = true;
  const { abort, send } = openSse(req, res);
  const timer = setTimeout(() => abort.abort(), 90_000);
  let run: ReturnType<typeof query> | undefined;
  try {
    const root = fileURLToPath(new URL("../../database-lab/", import.meta.url));
    const work = path.join(root, "work"); mkdirSync(work, { recursive: true });
    run = query({ prompt: input.data.question, options: {
      model: "claude-haiku-4-5", systemPrompt, thinking: { type: "disabled" }, tools: [],
      allowedTools: ["mcp__database__list_orders", "mcp__database__propose_cancellation"],
      mcpServers: { database: makeDatabaseServer(session.lab, (name, result) => send("tool", { name, result })) },
      settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", persistSession: false,
      cwd: work, env: agentEnv(path.join(root, "config")), abortController: abort, maxTurns: 6, maxBudgetUsd: 0.1,
    } });
    let completed = false;
    for await (const message of run) {
      send("message", message);
      if (message.type === "result") {
        completed = true;
        if (message.subtype !== "success") throw new Error(`Agent ended with ${message.subtype}.`);
        send("answer", { text: message.result, costUsd: message.total_cost_usd });
      }
    }
    if (!completed) throw new Error("Agent ended without a result.");
  } catch (error) { if (!res.destroyed) send("error", { message: abort.signal.aborted ? "Run stopped or deadline reached." : String(error) }); }
  finally {
    clearTimeout(timer); run?.close(); session.busy = false; active = false;
    if (!res.destroyed) { send("snapshot", session.lab.snapshot()); send("done", {}); res.end(); }
  }
});
