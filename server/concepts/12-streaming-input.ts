/**
 * CONCEPT 12 — Streaming input mode: one live session, many turns
 *
 *   query({ prompt: "text" })                    -> single message mode: one turn, then the input closes and the process exits.
 *   query({ prompt: AsyncIterable<SDKUserMessage> }) -> streaming input mode: the process stays alive while the iterable is open.
 *
 * Part A: a chat on top of one query()
 *   Every pushed SDKUserMessage is a new turn in the SAME session (no `resume` needed, see Concept 6).
 *   A message pushed while a turn is running waits in a queue; `priority: "now"` cancels the running turn instead.
 *   `message.content` can be an array of content blocks, e.g. text + image.
 *
 * Part B: changing the session while it is alive (control requests)
 *   q.setModel(model), q.setPermissionMode(mode), q.supportedModels(), q.getContextUsage()
 *
 * Part C: two ways to write the prompt
 *   An `async function*` generator that yields scripted messages vs. a plain string.
 *
 * Routes: /session (SSE) + /send, /model, /permission-mode, /context, /end to drive an open session; /script (SSE).
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept12 = Router();

const MODEL = "claude-haiku-4-5-20251001";

// Every POST body is checked first: SSE routes answer a bad one with `error` + `done`, JSON routes with 400.
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Id = z.string().uuid();
const MODES = ["default", "acceptEdits", "plan", "dontAsk"] as const; // the modes the tab offers
const ModelName = z.string().trim().min(1).max(100).regex(/^[\w.:[\]-]+$/, "a model id or alias");
const PriorityName = z.enum(["now", "next", "later"]);
// The browser refuses files over 5 MB; in base64 that is under 7 million characters.
const ImageInput = z
  .object({
    media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+=*$/, "base64 data"),
  })
  .strict();

type Priority = z.infer<typeof PriorityName>;
type Image = z.infer<typeof ImageInput>;

/** Builds the SDKUserMessage for a text (and an optional image). */
function userMessage(text: string, image?: Image, priority?: Priority): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = image
    ? [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
      ]
    : text;
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content }, ...(priority && { priority }) };
}

/** The push queue from Concept 10: an async generator that waits while the queue is empty. */
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
    push(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Parts A and B: a live session driven from the browser
// ---------------------------------------------------------------------------------------------

type Session = { q: Query; input: ReturnType<typeof inputQueue>; send: (event: string, data: unknown) => void; startedAt: number };
const sessions = new Map<string, Session>();

const SessionBody = z.object({ permissionMode: z.enum(MODES).optional() }).strict();

concept12.post("/session", async (req, res) => {
  const parsed = SessionBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const permissionMode: PermissionMode = parsed.data.permissionMode ?? "default";

  // The permission demo creates this file, so every session starts without it.
  await rm(path.join(SANDBOX, "hello.txt"), { force: true });

  const options: Options = {
    model: MODEL,
    tools: ["Read", "Write", "Glob"],
    allowedTools: ["Read", "Glob"], // Write is NOT pre-approved: the permission mode decides
    permissionMode,
    cwd: SANDBOX,
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true, // the answer grows as it streams, so you can send while it is busy
  };

  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  sessions.set(id, { q, input, send, startedAt: Date.now() });

  send("session", { id });
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  pipe(q).finally(() => sessions.delete(id));

  // A control request works as soon as the process is up, even before the first message.
  q.supportedModels()
    .then((models) => send("models", models))
    .catch(() => {});
});

// Every control route needs an open session.
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
const SendBody = z
  .object({
    id: Id,
    text: z.string().trim().min(1).max(10_000),
    priority: PriorityName.optional(),
    clientId: Id, // the browser keeps the image preview under this id
    image: ImageInput.optional(),
    imageName: z.string().max(260).optional(),
  })
  .strict();

// A new user message. It becomes a new turn, or waits in the queue if a turn is running.
concept12.post(
  "/send",
  control(SendBody, ({ input, send, ms }, { text, image, imageName, priority, clientId }) => {
    send("control", { method: "push user message", text, image: imageName, priority, clientId, ms });
    input.push(userMessage(text, image, priority));
  }),
);

concept12.post(
  "/model",
  control(z.object({ id: Id, model: ModelName }).strict(), async ({ q, send, ms }, { model }) => {
    await q.setModel(model);
    send("control", { method: `q.setModel("${model}")`, ms });
  }),
);

concept12.post(
  "/permission-mode",
  control(z.object({ id: Id, mode: z.enum(MODES) }).strict(), async ({ q, send, ms }, { mode }) => {
    await q.setPermissionMode(mode);
    send("control", { method: `q.setPermissionMode("${mode}")`, ms });
  }),
);

concept12.post(
  "/context",
  control(IdBody, async ({ q, send, ms }) => {
    // "summary" answers from the last response's usage, without extra token-count API calls.
    const { categories, totalTokens, maxTokens, percentage } = await q.getContextUsage({ detail: "summary" });
    const usage = { categories: categories.map(({ name, tokens }) => ({ name, tokens })), totalTokens, maxTokens, percentage };
    send("control", { method: "q.getContextUsage()", ms, usage });
    return usage;
  }),
);

// Closing the input iterable is the normal way to end the session.
concept12.post(
  "/end",
  control(IdBody, ({ input, send, ms }) => {
    send("control", { method: "close input", ms });
    input.close();
  }),
);

// ---------------------------------------------------------------------------------------------
// Part C: two ways to write the prompt
// ---------------------------------------------------------------------------------------------

const SCRIPT = [
  "My name is Ana and I teach a TypeScript course. Reply in one short line.",
  "Suggest a catchy title for my course. One line.",
  "What is my name, and what do I teach? One line.",
];

const ScriptBody = z.object({ variant: z.enum(["generator", "string"]) }).strict();

concept12.post("/script", async (req, res) => {
  const parsed = ScriptBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const { variant } = parsed.data;
  const startedAt = Date.now();
  const ms = () => Date.now() - startedAt;

  const options: Options = { model: MODEL, tools: [], settingSources: [], strictMcpConfig: true, abortController: abort };

  if (variant === "string") {
    // Single message mode: the input is closed right after this one message.
    send("control", { method: "push user message", text: SCRIPT[0], ms: 0 });
    const q = query({ prompt: SCRIPT[0], options });

    // Stream every message, then (once the loop has ended and the process is gone) try a control request.
    async function* thenTryControl() {
      yield* q;
      try {
        await q.setModel("claude-sonnet-5");
        send("control", { method: 'q.setModel("claude-sonnet-5") after the loop', ms: ms() });
      } catch (err) {
        send("control", { method: 'q.setModel("claude-sonnet-5") after the loop', ms: ms(), error: String(err) });
      }
    }
    pipe(thenTryControl());
    return;
  }

  // Streaming input mode with a generator: yield a message, wait for its result, yield the next one.
  let turnDone = () => {};
  async function* conversation(): AsyncGenerator<SDKUserMessage> {
    for (const text of SCRIPT) {
      const done = new Promise<void>((resolve) => (turnDone = resolve));
      send("control", { method: "yield user message", text, ms: ms() });
      yield userMessage(text);
      await done;
    }
    send("control", { method: "generator returned (input closed)", ms: ms() });
  }

  // Pass every message through, and tell the generator when a turn ends.
  async function* signalTurns(stream: AsyncIterable<SDKMessage>) {
    for await (const msg of stream) {
      yield msg;
      if (msg.type === "result") turnDone();
    }
  }

  pipe(signalTurns(query({ prompt: conversation(), options })));
});
