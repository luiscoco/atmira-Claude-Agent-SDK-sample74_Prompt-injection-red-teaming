import { Router } from "express";
import { z } from "zod";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept06 = Router();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The tab sends resume: null until the first system/init gives it a session id.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    resume: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a session id (uuid)").nullable().optional(),
  })
  .strict();

concept06.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 3,
    settingSources: [],
    ...(body.resume ? { resume: body.resume } : {}),
  };

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});
