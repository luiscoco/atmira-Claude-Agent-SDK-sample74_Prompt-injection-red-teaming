/**
 * CONCEPT 14 — Thinking, effort & models
 *
 * Part A: the same prompt, several configurations side by side
 *   options.thinking  -> { type: "adaptive" } (the model decides) | { type: "enabled", budgetTokens } | { type: "disabled" }
 *                        + display: "summarized" (you get the thinking text) | "omitted" (billed, but the text is empty)
 *   options.effort    -> "low" | "medium" | "high" | "xhigh" | "max" (only on models that support it)
 *   options.model     -> which model, e.g. Haiku 4.5 (budget thinking, no effort) vs Sonnet 5 (adaptive + effort)
 *   A Stop hook reports `input.effort.level`: the effort that was REALLY applied (null = no effort sent).
 *
 * Part B: what each model supports, and what happens when a model is not available
 *   q.supportedModels()  -> supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, ...
 *   options.fallbackModel -> used when the primary model is unavailable (a `system/model_fallback` message)
 *
 * Part C: changing them while a session is alive (streaming input, see Concept 12)
 *   q.applyFlagSettings({ effortLevel }), q.setMaxThinkingTokens(n | null), q.setModel(model)
 *
 * Routes: /run (SSE, Parts A and B), /models; /session (SSE) + /send, /effort, /thinking, /model, /end (Part C).
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  query,
  type HookCallback,
  type ModelInfo,
  type Options,
  type Query,
  type SDKUserMessage,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept14 = Router();

/** Every run: no tools, no inherited settings or MCP servers. This concept is only about the model call. */
const BASE: Options = { tools: [], settingSources: [], strictMcpConfig: true };

// Every POST body is checked first: SSE routes answer a bad one with `error` + `done`, JSON routes with 400.
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Id = z.string().uuid();
// Any id or alias is accepted (even one that does not exist: the fallbackModel demo needs that).
const ModelName = z.string().trim().min(1).max(100).regex(/^[\w.:[\]-]+$/, "a model id or alias");
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/**
 * A Stop hook that reports the effort level of the turn that just ended. `input.effort` is set "after any silent
 * downgrade for the selected model", and it is absent when no effort parameter was sent (e.g. on Haiku 4.5).
 */
function effortReporter(send: (event: string, data: unknown) => void): Options["hooks"] {
  const report: HookCallback = async (input) => {
    send("effort", { level: input.effort?.level ?? null });
    return {};
  };
  return { Stop: [{ hooks: [report] }] };
}

// ---------------------------------------------------------------------------------------------
// Parts A and B: one run per configuration (the browser opens one stream per column)
// ---------------------------------------------------------------------------------------------

const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: ModelName.optional(),
    thinking: z.enum(["adaptive", "enabled", "disabled"]).optional(), // undefined = omit the option (the model's default)
    budgetTokens: z.number().int().min(1).max(200_000).optional(),
    display: z.enum(["summarized", "omitted"]).optional(),
    effort: Effort.optional(),
    fallbackModel: ModelName.optional(),
  })
  .strict();
type RunBody = z.infer<typeof RunBody>;

/** Builds `thinking` from the form. Only the fields you chose are set, like in Concept 2. */
function thinkingConfig({ thinking, budgetTokens, display }: RunBody): ThinkingConfig | undefined {
  if (thinking === "disabled") return { type: "disabled" };
  if (thinking === "adaptive") return { type: "adaptive", ...(display && { display }) };
  if (thinking === "enabled") return { type: "enabled", ...(budgetTokens && { budgetTokens }), ...(display && { display }) };
  return undefined;
}

concept14.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const body = parsed.data;

  const options: Options = {
    ...BASE,
    maxTurns: 1,
    includePartialMessages: true, // thinking arrives as thinking_delta stream events, before the answer
  };
  if (body.model) options.model = body.model;
  const thinking = thinkingConfig(body);
  if (thinking) options.thinking = thinking;
  if (body.effort) options.effort = body.effort;
  if (body.fallbackModel) options.fallbackModel = body.fallbackModel;

  send("options", { ...options, hooks: { Stop: ["[Function reportEffort]"] } });
  pipe(query({ prompt: body.prompt, options: { ...options, hooks: effortReporter(send), abortController: abort } }));
});

// The model list does not change while the server runs, so it is asked once and kept.
let models: Promise<ModelInfo[]> | undefined;

/** supportedModels() is a control request, so it needs a live process: a prompt that never yields a message. */
async function loadModels() {
  let close = () => {};
  async function* noMessages(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => (close = resolve));
  }
  const q = query({ prompt: noMessages(), options: BASE });
  try {
    return await q.supportedModels();
  } finally {
    close(); // the generator returns, the input closes, and the process exits
    for await (const _ of q); // drain the stream so the process is gone before we answer
  }
}

concept14.get("/models", async (_req, res) => {
  try {
    const startedAt = Date.now();
    const cached = !!models;
    models ??= loadModels();
    res.json({ models: await models, ms: Date.now() - startedAt, cached });
  } catch (err) {
    models = undefined;
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// Part C: one live session, changed between turns
// ---------------------------------------------------------------------------------------------

/** The push queue from Concepts 10 and 12. */
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

const SessionBody = z.object({ model: ModelName.optional() }).strict();

concept14.post("/session", (req, res) => {
  const parsed = SessionBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const { model = "claude-sonnet-5" } = parsed.data;

  const options: Options = {
    ...BASE,
    model,
    thinking: { type: "adaptive", display: "summarized" }, // so you can read what the model thought
    includePartialMessages: true,
  };

  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, hooks: effortReporter(send), abortController: abort } });
  sessions.set(id, { q, input, send, startedAt: Date.now() });

  send("session", { id });
  send("options", { ...options, hooks: { Stop: ["[Function reportEffort]"] }, prompt: "[AsyncIterable<SDKUserMessage>]" });
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

concept14.post(
  "/send",
  control(z.object({ id: Id, text: z.string().trim().min(1).max(4000) }).strict(), ({ input, send, ms }, { text }) => {
    send("control", { method: "push user message", text, ms });
    input.push(text);
  }),
);

// There is no setEffort(). Effort is a setting, so it goes through the session's flag-settings layer.
// null clears it: the model's default effort applies again.
concept14.post(
  "/effort",
  control(z.object({ id: Id, level: Effort.nullable() }).strict(), async ({ q, send, ms }, { level }) => {
    await q.applyFlagSettings({ effortLevel: level });
    send("control", { method: `q.applyFlagSettings({ effortLevel: ${JSON.stringify(level)} })`, ms });
  }),
);

// 0 turns thinking off, a number sets a budget, null goes back to the session's default.
concept14.post(
  "/thinking",
  control(z.object({ id: Id, tokens: z.number().int().min(0).max(200_000).nullable() }).strict(), async ({ q, send, ms }, { tokens }) => {
    await q.setMaxThinkingTokens(tokens);
    send("control", { method: `q.setMaxThinkingTokens(${JSON.stringify(tokens)})`, ms });
  }),
);

concept14.post(
  "/model",
  control(z.object({ id: Id, model: ModelName }).strict(), async ({ q, send, ms }, { model }) => {
    await q.setModel(model);
    send("control", { method: `q.setModel("${model}")`, ms });
  }),
);

concept14.post(
  "/end",
  control(IdBody, ({ input, send, ms }) => {
    send("control", { method: "close input", ms });
    input.close();
  }),
);
