/**
 * CONCEPT 1 — query(): the heart of the SDK
 *
 * `query({ prompt, options })` starts an agent run and returns an async
 * iterable of SDKMessage objects. You consume it with `for await`.
 *
 * A typical run emits, in order:
 *   1. { type: "system", subtype: "init" }  -> session id, model, tools, cwd...
 *   2. { type: "assistant" }                -> Claude's reply (content blocks)
 *   3. { type: "result" }                   -> final text, cost, tokens, duration
 */
import { Router } from "express";
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept01 = Router();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The body the tab sends. Anything else is refused before query() starts.
const QueryBody = z.object({ prompt: z.string().trim().min(1).max(10000) }).strict();

concept01.post("/query", (req, res) => {
  const parsed = QueryBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt } = parsed.data;

  const run = query({
    prompt,
    options: {
      abortController: abort, // stop the agent if the browser disconnects
      tools: [], // no built-in tools yet: pure Q&A (tools come in a later concept)
      maxTurns: 1,
    },
  });

  pipe(run);
});
