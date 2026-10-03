/**
 * CONCEPT 2 — Options: controlling a run
 *
 * The second argument of `query({ prompt, options })` configures the agent:
 *   - model                  -> which Claude model runs the agent (omit = CLI default)
 *   - systemPrompt           -> string (custom) or { type: "preset", preset: "claude_code", append }
 *   - maxTurns               -> stop after N turns (result subtype "error_max_turns")
 *   - maxBudgetUsd           -> stop when the cost passes N dollars (result subtype "error_max_budget_usd")
 *   - includePartialMessages -> also emit { type: "stream_event" } messages with token-by-token deltas
 */
import { Router } from "express";
import { z } from "zod";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept02 = Router();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The form the tab sends. Empty fields arrive as undefined (left out of the JSON).
const Body = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(100).optional(),
    systemPromptMode: z.enum(["default", "custom", "preset"]),
    systemPrompt: z.string().max(10000).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    includePartialMessages: z.boolean().optional(),
  })
  .strict();

concept02.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;

  // Only set the options the user actually chose, so "omitted" really means SDK default.
  const options: Options = {
    tools: [], // still no built-in tools (Concept 3)
    includePartialMessages: body.includePartialMessages,
  };
  if (body.model) options.model = body.model;
  if (body.systemPromptMode === "custom") options.systemPrompt = body.systemPrompt ?? "";
  if (body.systemPromptMode === "preset")
    options.systemPrompt = { type: "preset", preset: "claude_code", append: body.systemPrompt || undefined };
  if (body.maxTurns) options.maxTurns = body.maxTurns;
  if (body.maxBudgetUsd) options.maxBudgetUsd = body.maxBudgetUsd;

  // Echo the options (without the AbortController) so the UI shows exactly what query() received.
  send("options", options);

  const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
  pipe(run);
});
