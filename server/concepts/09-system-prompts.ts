/**
 * CONCEPT 9 — System prompts: the six ways to shape the agent
 *
 * `options.systemPrompt` (plus `settingSources`) decides what Claude reads before your prompt:
 *   - omitted                                      -> the SDK's minimal default prompt
 *   - "a string"                                   -> replaces the system prompt completely
 *   - ["static", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic"] -> custom prompt split for prompt caching
 *   - { type: "preset", preset: "claude_code" }    -> Claude Code's full system prompt
 *   - { ...preset, append: "..." }                 -> Claude Code's prompt + your extra rules
 *   - preset + settingSources: ["project"] + cwd   -> also loads the CLAUDE.md found in cwd
 *
 * The browser calls /query once per variant, in parallel, with the same user prompt.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept09 = Router();

// A folder of its own (not sandbox/, which Concept 3 resets) with a CLAUDE.md in it.
const PROJECT_DIR = path.resolve("claude-md-project");

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The tab always sends every field; customPrompt and appendText may be empty.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    variant: z.enum(["omitted", "custom", "blocks", "preset", "append", "claudeMd"]),
    customPrompt: z.string().max(4000),
    appendText: z.string().max(4000),
    userName: z.string().max(100),
  })
  .strict();
type Body = z.infer<typeof Body>;

function buildOptions(body: Body): Options {
  // Same base for every variant, so the system prompt is the only difference.
  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    tools: [],
    maxTurns: 1,
    settingSources: [],
  };

  switch (body.variant) {
    case "omitted":
      break;
    case "custom":
      options.systemPrompt = body.customPrompt;
      break;
    case "blocks":
      // Blocks before the boundary are identical for every user, so they can be cached across sessions.
      // Blocks after it change per request (user, date), so they are sent but never cached globally.
      options.systemPrompt = [
        "You are the support bot of Atmira Lab. Answer in at most two sentences.",
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        `The current user is ${body.userName}. Today is ${new Date().toDateString()}.`,
      ];
      break;
    case "preset":
      options.systemPrompt = { type: "preset", preset: "claude_code" };
      break;
    case "append":
      options.systemPrompt = { type: "preset", preset: "claude_code", append: body.appendText };
      break;
    case "claudeMd":
      // CLAUDE.md is only read when settingSources includes "project"; it is looked up from cwd.
      options.systemPrompt = { type: "preset", preset: "claude_code" };
      options.settingSources = ["project"];
      options.cwd = PROJECT_DIR;
      break;
  }
  return options;
}

concept09.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const options = buildOptions(body);

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});

// Lets the tab show the CLAUDE.md that the "claudeMd" variant loads.
concept09.get("/claude-md", async (_req, res) => {
  res.type("text/plain").send(await readFile(path.join(PROJECT_DIR, "CLAUDE.md"), "utf8").catch(() => "(missing)"));
});
