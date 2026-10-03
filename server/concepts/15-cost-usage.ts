/**
 * CONCEPT 15 — Cost & usage tracking
 *
 * Part A: where the numbers are in one run
 *   assistant.message.usage  -> per API call, but repeated on every streamed block of that call (same message.id)
 *                               and NOT final (output_tokens is a placeholder). Group by message.id, read input/cache.
 *   result.usage             -> the main agent loop only (no subagents, no auxiliary calls), per turn
 *   result.modelUsage        -> every model call of this query(), per model: tokens, cache, thinking, costUSD
 *   result.total_cost_usd    -> the estimated cost of this query(); duration_ms vs duration_api_ms; num_turns
 *   rate_limit_event         -> plan utilization (claude.ai login only; not sent with an API key)
 *
 * Part B: limits that stop a run
 *   maxTurns     -> result subtype "error_max_turns"
 *   maxBudgetUsd -> result subtype "error_max_budget_usd", checked AFTER each API call (a run can overshoot)
 *   taskBudget   -> @alpha: the model is told its token budget so it can pace itself (nothing is enforced here)
 *
 * Part C: a live cost meter (streaming input, see Concept 12)
 *   total_cost_usd and modelUsage are cumulative across turns: the cost of one turn is the difference.
 *   q.getContextUsage()                                  -> how full the context window is
 *   q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() -> the data behind /usage (session totals + plan limits)
 *
 * Routes: /run (SSE, Parts A and B); /session (SSE) + /send, /context, /usage, /end (Part C).
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept15 = Router();

/**
 * Read-only tools in the Concept 3 sandbox, so a run makes several API calls (one per tool round-trip).
 * No inherited settings or MCP servers: every token you see comes from this request.
 */
const READ_ONLY = ["Read", "Glob", "Grep"];
const BASE: Options = { cwd: SANDBOX, tools: READ_ONLY, allowedTools: READ_ONLY, settingSources: [], strictMcpConfig: true };

// Every POST body is checked first: SSE routes answer a bad one with `error` + `done`, JSON routes with 400.
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Id = z.string().uuid();
const ModelName = z.string().trim().min(1).max(100).regex(/^[\w.:[\]-]+$/, "a model id or alias");
const Budget = z.number().positive().max(10); // dollars

// ---------------------------------------------------------------------------------------------
// Parts A and B: one run
// ---------------------------------------------------------------------------------------------

const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: ModelName.optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxBudgetUsd: Budget.optional(),
    taskBudget: z.number().int().min(1).max(1_000_000).optional(), // tokens, sent as { total }
    agentTool: z.boolean().optional(), // adds the Agent tool: a bigger system prompt, which makes prompt caching kick in
  })
  .strict();

concept15.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const body = parsed.data;

  // Only the fields you chose are set, like in Concept 2.
  const options: Options = { ...BASE };
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;
  if (body.maxBudgetUsd) options.maxBudgetUsd = body.maxBudgetUsd;
  if (body.taskBudget) options.taskBudget = { total: body.taskBudget };
  if (body.agentTool) {
    options.tools = [...READ_ONLY, "Agent"];
    options.allowedTools = [...READ_ONLY, "Agent"];
  }

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});

// ---------------------------------------------------------------------------------------------
// Part C: a live session with a cost meter
// ---------------------------------------------------------------------------------------------

/** The push queue from Concepts 10, 12 and 14. */
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    stream: stream(),
    push(text: string) {
      queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

type Session = { q: Query; input: ReturnType<typeof inputQueue>; send: (event: string, data: unknown) => void; startedAt: number };
const sessions = new Map<string, Session>();

const SessionBody = z.object({ model: ModelName.optional(), maxBudgetUsd: Budget.optional() }).strict();

concept15.post("/session", (req, res) => {
  const parsed = SessionBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const { model = "claude-haiku-4-5-20251001", maxBudgetUsd } = parsed.data;

  const options: Options = { ...BASE, model };
  if (maxBudgetUsd) options.maxBudgetUsd = maxBudgetUsd; // for the whole session, not per turn

  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  sessions.set(id, { q, input, send, startedAt: Date.now() });

  send("session", { id });
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  pipe(q).finally(() => sessions.delete(id));
});

function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error("No open session with that id (it already ended).");
  return { ...session, ms: Date.now() - session.startedAt };
}

/** Wraps a control route: checks the body (400), finds the session, runs the action, reports errors as 409. */
function control<T extends z.ZodType<{ id: string }>>(schema: T, action: (s: ReturnType<typeof getSession>, body: z.infer<T>) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: badRequest(parsed.error) });
      return;
    }
    try {
      const result = await action(getSession(parsed.data.id), parsed.data);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  };
}

const IdBody = z.object({ id: Id }).strict();

concept15.post(
  "/send",
  control(z.object({ id: Id, text: z.string().trim().min(1).max(4000) }).strict(), ({ input, send, ms }, { text }) => {
    send("control", { method: "push user message", text, ms });
    input.push(text);
  }),
);

// "summary" answers from the last response's usage, without extra token-count calls (so it costs nothing).
concept15.post(
  "/context",
  control(IdBody, async ({ q, send, ms }) => {
    const startedAt = Date.now();
    const { categories, totalTokens, maxTokens, percentage, autoCompactThreshold, apiUsage } = await q.getContextUsage({ detail: "summary" });
    const context = { categories, totalTokens, maxTokens, percentage, autoCompactThreshold, apiUsage };
    send("control", { method: 'q.getContextUsage({ detail: "summary" })', ms, took: Date.now() - startedAt, context });
    return context;
  }),
);

// The data behind the /usage command. The name says it: the shape may change in any release.
// skipBehaviors skips a scan of the last seven days of local transcripts that we do not need.
concept15.post(
  "/usage",
  control(IdBody, async ({ q, send, ms }) => {
    const startedAt = Date.now();
    const { session, subscription_type, rate_limits_available, rate_limits } = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    // rate_limits has many more windows (most of them null); keep the two every plan has.
    const usage = {
      session,
      subscription_type,
      rate_limits_available,
      rate_limits: rate_limits && { five_hour: rate_limits.five_hour ?? null, seven_day: rate_limits.seven_day ?? null },
    };
    send("control", { method: "q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })", ms, took: Date.now() - startedAt, usage });
    return usage;
  }),
);

concept15.post(
  "/end",
  control(IdBody, ({ input, send, ms }) => {
    send("control", { method: "close input", ms });
    input.close();
  }),
);
