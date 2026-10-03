import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { createTrace, diagnose, redact, replay, scenarios, type Bundle } from "../debugging/trace.js";

export const concept53 = Router();
const LAB = path.resolve("debug-lab");
const MODEL = "claude-haiku-4-5-20251001";
const liveScenarios = ["success", "denied", "missing", "max-turns"] as const;
const request = z.object({ mode: z.enum(["offline", "live"]).default("offline"), scenario: z.enum(scenarios).default("success"), debug: z.boolean().default(true), maxTurns: z.number().int().min(1).max(8).default(4) }).strict();

concept53.get("/facts", (_req, res) => res.json({ scenarios, liveScenarios, model: MODEL, timeoutMs: 60_000 }));
concept53.get("/code", (_req, res) => res.json({
  "53-debugging.ts": readFileSync(new URL("./53-debugging.ts", import.meta.url), "utf8"),
  "trace.ts": readFileSync(new URL("../debugging/trace.ts", import.meta.url), "utf8"),
}));

/** Read a bounded prefix; CLI debug files can be large. */
function debugPrefix(file: string) {
  if (!existsSync(file)) return "No CLI debug file was produced.";
  const size = statSync(file).size;
  const buffer = Buffer.alloc(Math.min(size, 128_000));
  const fd = openSync(file, "r");
  try { const count = readSync(fd, buffer, 0, buffer.length, 0); return String(redact(buffer.subarray(0, count).toString("utf8"))) + (size > buffer.length ? "\n[debug log truncated]" : ""); }
  finally { closeSync(fd); }
}

concept53.post("/run", async (req, res) => {
  const parsed = request.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const input = parsed.data;
  if (input.mode === "live" && !(liveScenarios as readonly string[]).includes(input.scenario)) { res.status(400).json({ error: "This scenario is available only as an offline replay." }); return; }
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const root = path.join(LAB, id);
  const work = path.join(root, "work");
  const debugFile = path.join(root, "cli-debug.log");
  mkdirSync(work, { recursive: true });
  const { abort, send } = openSse(req, res);
  const trace = createTrace((row) => { if (!abort.signal.aborted) send("trace", row); });
  const maxTurns = input.scenario === "max-turns" ? 1 : input.mode === "offline" ? 4 : input.maxTurns;
  const target = path.join(work, input.scenario === "missing" ? "missing.txt" : "notes.txt");
  const prompt = `Use Read once to inspect ${target}. Report the release and status from that file. If access is denied or the file is absent, explain the failure without guessing or retrying.`;
  const config = { model: input.mode === "live" ? MODEL : "synthetic-model", cwd: work, prompt, tools: ["Read"], settingSources: [], permissionMode: "default", maxTurns, debug: input.mode === "live" && input.debug, timeoutMs: 60_000 };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: ReturnType<typeof query> | undefined;
  send("start", { id, mode: input.mode, scenario: input.scenario });
  try {
    if (input.mode === "offline") replay(input.scenario, trace);
    else {
      writeFileSync(path.join(work, "notes.txt"), "Release: 53\nStatus: ready\n");
      const recordHook: HookCallback = async (event, toolUseId) => {
        trace.add("hook", event.hook_event_name, event, toolUseId);
        if (event.hook_event_name === "PreToolUse") {
          // Read may be auto-approved before canUseTool is called. Enforce the path here too.
          const args = event.tool_input as Record<string, unknown>;
          const inScope = event.tool_name === "Read" && typeof args.file_path === "string" && path.resolve(work, args.file_path) === target;
          if (input.scenario === "denied" || !inScope) {
            const reason = input.scenario === "denied" ? "Lab policy blocks Read" : "Only the exact lab fixture may be read";
            trace.add("hook", "denied", { reason }, toolUseId);
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason}. Explain this restriction; do not retry.` } };
          }
        }
        return {};
      };
      const options: Options = {
        model: MODEL, cwd: work, tools: ["Read"], settingSources: [], permissionMode: "default", maxTurns, abortController: abort,
        includePartialMessages: true, ...(input.debug ? { debugFile } : {}),
        stderr: (chunk) => trace.add("stderr", "chunk", chunk.slice(0, 8000)),
        canUseTool: async (name, args, context) => {
          const allowed = name === "Read" && typeof args.file_path === "string" && path.resolve(work, args.file_path) === target;
          trace.add("permission", allowed ? "allowed" : "denied", { tool_name: name, input: args, reason: allowed ? "Exact lab fixture path" : "Only the exact lab fixture may be read" }, context.toolUseID);
          return allowed ? { behavior: "allow", updatedInput: args } : { behavior: "deny", message: "Only the exact lab fixture may be read" };
        },
        hooks: Object.fromEntries(["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"].map((name) => [name, [{ hooks: [recordHook] }]])),
      };
      trace.add("host", "config", config);
      timer = setTimeout(() => { timedOut = true; abort.abort(); }, 60_000);
      stream = query({ prompt, options });
      // The async iterator can throw after a result: keep both pieces of evidence.
      for await (const msg of stream) {
        const kind = msg.type === "system" ? msg.subtype : msg.type;
        trace.add("sdk", kind, msg);
        if (msg.type === "user" && Array.isArray(msg.message.content)) for (const block of msg.message.content) {
          if (block.type === "tool_result") trace.add("sdk", block.is_error ? "tool-error" : "tool-result", block, block.tool_use_id);
        }
      }
      trace.add("host", "end", {});
    }
  } catch (error) {
    trace.add("host", timedOut ? "timeout" : abort.signal.aborted ? "cancelled" : "exception", { message: String(error) });
  } finally {
    if (timer) clearTimeout(timer);
    try { stream?.close(); } catch { /* already closed */ }
    if (abort.signal.aborted && !trace.rows.some((row) => ["timeout", "cancelled"].includes(row.kind))) trace.add("host", timedOut ? "timeout" : "cancelled", {});
    try {
      const bundle: Bundle = { id, mode: input.mode, scenario: input.scenario, startedAt, config, rows: trace.rows, findings: diagnose(trace.rows),
        debugLog: input.mode === "offline" ? "Offline replay: no Claude Code process or debug file." : input.debug ? debugPrefix(debugFile) : "CLI debug logging disabled. stderr is still captured.",
        limitations: "Diagnoses are evidence-based suggestions. Redaction is best effort; inspect exports before sharing. Raw CLI logs stay local. Offline messages are synthetic; live model behaviour can vary." };
      writeFileSync(path.join(root, "bundle.json"), JSON.stringify(redact(bundle), null, 2));
      if (!abort.signal.aborted) send("bundle", bundle);
    } catch (error) { if (!abort.signal.aborted) send("error", { message: `Could not save diagnostics: ${String(error)}` }); }
    res.end();
  }
});

concept53.get("/runs/:id", (req, res) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(req.params.id)) { res.status(400).json({ error: "Invalid run ID" }); return; }
  const file = path.join(LAB, req.params.id, "bundle.json");
  if (!existsSync(file)) { res.status(404).json({ error: "Run not found" }); return; }
  res.type("json").send(readFileSync(file, "utf8"));
});
