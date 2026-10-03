import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Router } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { runWorkshop, sourceFiles, type Worker } from "../worktrees/workshop.js";

export const concept57 = Router();
concept57.get("/code", async (_req, res, next) => { try { res.json(await sourceFiles()); } catch (error) { next(error); } });
const requestSchema = z.object({ mode: z.enum(["offline", "live"]), scenario: z.enum(["independent", "conflict"]) }).strict();
let active = false;
concept57.post("/run", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Expected mode offline/live and scenario independent/conflict." });
  if (active) return res.status(409).json({ message: "A lesson 57 run is already active. Wait for it to finish." });
  if (parsed.data.mode === "live" && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ message: "The live exercise requires ANTHROPIC_API_KEY in .env." });
  active = true;
  const { abort, send } = openSse(req, res);
  const deadline = setTimeout(() => { send("error", { message: "Run deadline reached; cancelling workers and retaining evidence." }); abort.abort(); }, parsed.data.mode === "live" ? 90_000 : 30_000);
  const liveWorker: Worker = async (assignment, signal) => {
    const config = path.join(path.dirname(assignment.cwd), `config-${assignment.id}`); await mkdir(config);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && !key.startsWith("GIT_") && key !== "ANTHROPIC_BASE_URL"));
    const controller = new AbortController(); const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    const session = query({ prompt: `Edit only ${assignment.file} in ${assignment.cwd}. Replace it with this exact source:\n${assignment.expected}\nDo not commit. The coordinator runs validation and commits.`, options: {
      cwd: assignment.cwd, env: { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      model: "haiku", tools: ["Read", "Edit", "Write"],
      hooks: { PreToolUse: [{ hooks: [async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const fields = input.tool_input as Record<string, unknown>;
        const target = typeof fields.file_path === "string" ? path.resolve(assignment.cwd, fields.file_path) : "";
        const allowed = ["Read", "Edit", "Write"].includes(input.tool_name) && target === path.join(assignment.cwd, assignment.file);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: "Worker tools are restricted to the assigned file." } };
      }] }] },
      canUseTool: async (name, input) => {
        const target = typeof input.file_path === "string" ? path.resolve(assignment.cwd, input.file_path) : "";
        if (["Read", "Edit", "Write"].includes(name) && target === path.join(assignment.cwd, assignment.file)) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: "Only the assigned file is available to this worker." };
      },
      settingSources: [], strictMcpConfig: true, persistSession: false, maxTurns: 4, maxBudgetUsd: 0.08, abortController: controller,
    } });
    let success = false;
    try {
      for await (const message of session) {
        if (message.type === "result") {
          send("worker-result", { worker: assignment.id, subtype: message.subtype, cost: message.total_cost_usd });
          if (message.subtype !== "success" || message.is_error) throw new Error(`SDK worker failed: ${message.subtype}`);
          success = true;
        }
      }
      if (!success) throw new Error("Worker ended without a successful SDK result.");
    } finally { session.close(); signal.removeEventListener("abort", stop); }
  };
  try {
    const report = await runWorkshop({ root: path.resolve("worktrees-lab"), scenario: parsed.data.scenario, signal: abort.signal, worker: parsed.data.mode === "live" ? liveWorker : undefined, onEvent: (event) => { if (!res.destroyed) send("progress", event); } });
    if (!res.destroyed) send("report", report);
  } catch (error) { if (!res.destroyed) send("error", { message: String(error) }); }
  finally { clearTimeout(deadline); active = false; if (!res.destroyed) { send("done", {}); res.end(); } }
});
