/**
 * CONCEPT 10 — Structured output (`outputFormat`) and interrupting a run
 *
 * Part A: structured output
 *   outputFormat: { type: "json_schema", schema }   -> the SDK adds a `StructuredOutput` tool the model must call.
 *   The CLI validates each call against the schema and makes the model retry on a mismatch.
 *   The parsed value arrives in `result.structured_output`; too many bad calls -> `error_max_structured_output_retries`.
 *   Each schema is written once in zod: `z.toJSONSchema()` feeds the SDK, `safeParse()` checks (and types) the result.
 *
 * Part B: two ways to stop a run
 *   await q.interrupt()        -> stops the current TURN; the session stays alive and can take another message.
 *                                 Control request: only works in streaming input mode (prompt = AsyncIterable).
 *   abortController.abort()    -> kills the Claude Code process; `for await` throws "Operation aborted".
 *
 * Routes: /structured (SSE), /run (SSE) + /interrupt, /abort, /send, /end to control an open run.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept10 = Router();

const MODEL = "claude-haiku-4-5-20251001";

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Prompt = z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" });

// ---------------------------------------------------------------------------------------------
// Part A: structured output
// ---------------------------------------------------------------------------------------------

const schemas = {
  profile: z.object({
    name: z.string(),
    yearsOfExperience: z.number().int().min(0),
    languages: z.array(z.string()).max(5),
    seniority: z.enum(["junior", "mid", "senior"]),
  }),
  review: z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    score: z.number().min(0).max(1).describe("0 = very negative, 1 = very positive"),
    highlights: z.array(z.string()).max(3),
    suggestedReply: z.string(),
  }),
  // Structured output also works after tool calls: the agent reads a file first, then answers.
  tasks: z.object({
    total: z.number().int(),
    done: z.number().int(),
    pending: z.array(z.object({ id: z.number().int(), title: z.string() })),
  }),
  // A schema that contradicts the facts (2 + 3 + 5 is not 1): watch the validation retries.
  conflict: z.object({
    primes: z.array(z.number().int()).length(3),
    sum: z.literal(1),
  }),
};

type SchemaId = keyof typeof schemas;

// The CLI's validator rejects zod's default "$schema": draft 2020-12, so ask zod for draft-07.
const toJsonSchema = (id: SchemaId) => z.toJSONSchema(schemas[id], { target: "draft-07" }) as Record<string, unknown>;

// Lets the tab show every schema, exactly as it is sent to the SDK.
concept10.get("/schemas", (_req, res) => {
  res.json(Object.fromEntries(Object.keys(schemas).map((id) => [id, toJsonSchema(id as SchemaId)])));
});

// An unknown schemaId is refused here, before schemas[schemaId] is ever read.
const StructuredBody = z
  .object({ prompt: Prompt, schemaId: z.enum(Object.keys(schemas) as [SchemaId, ...SchemaId[]]) })
  .strict();

concept10.post("/structured", (req, res) => {
  const parsed = StructuredBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt, schemaId } = parsed.data;

  const options: Options = {
    model: MODEL,
    tools: schemaId === "tasks" ? ["Read"] : [],
    allowedTools: schemaId === "tasks" ? ["Read"] : [],
    cwd: SANDBOX,
    maxTurns: 6,
    settingSources: [],
    strictMcpConfig: true,
    outputFormat: { type: "json_schema", schema: toJsonSchema(schemaId) },
  };
  send("options", options);

  // Pass every message through, and check the final one against the same zod schema.
  async function* withValidation(stream: AsyncIterable<SDKMessage>) {
    for await (const msg of stream) {
      yield msg;
      if (msg.type === "result") {
        const value = msg.subtype === "success" ? msg.structured_output : undefined;
        const parsed = schemas[schemaId].safeParse(value);
        send("validation", parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues });
      }
    }
  }

  pipe(withValidation(query({ prompt, options: { ...options, abortController: abort } })));
});

// ---------------------------------------------------------------------------------------------
// Part B: interrupt() vs abort()
// ---------------------------------------------------------------------------------------------

/**
 * A push queue used as the prompt. Passing an AsyncIterable (instead of a string) switches query()
 * to streaming input mode: the session stays open while the iterable is open, which is what
 * control requests such as interrupt() need. Closing it ends the session.
 */
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

type Run = { q: Query; input: ReturnType<typeof inputQueue>; abort: AbortController; send: (event: string, data: unknown) => void; startedAt: number };
const runs = new Map<string, Run>();

const RunBody = z.object({ prompt: Prompt }).strict();
// The control routes: the run id that /run sent, and for /send the follow-up text.
const RunId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a run id (uuid)");
const ControlBody = z.object({ id: RunId }).strict();
const SendBody = z.object({ id: RunId, text: Prompt }).strict();

concept10.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort: sseClosed, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt } = parsed.data;

  // Our own controller, separate from the SSE one, so a user-pressed abort() still reports the error it causes.
  const abort = new AbortController();
  const input = inputQueue();
  sseClosed.signal.addEventListener("abort", () => abort.abort()); // browser closed the tab

  const options: Options = {
    model: MODEL,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true, // so the text visibly grows, and we can see where it stops
  };

  const id = randomUUID();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  runs.set(id, { q, input, abort, send, startedAt: Date.now() });

  send("run", { id });
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  send("control", { method: "push user message", text: prompt, ms: 0 });
  input.push(prompt);

  pipe(q).finally(() => runs.delete(id));
});

// Every control route needs an open run: a body that is not valid is a 400, an id with no open run a 409.
function getRun(id: string) {
  const run = runs.get(id);
  if (!run) throw new Error("No open run with that id (it already ended).");
  return { ...run, ms: Date.now() - run.startedAt };
}

concept10.post("/interrupt", async (req, res) => {
  const parsed = ControlBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  try {
    const { q, send, ms } = getRun(parsed.data.id);
    const receipt = await q.interrupt(); // resolves once the CLI has accepted the interrupt
    send("control", { method: "q.interrupt()", ms, receipt });
    res.json({ ok: true, receipt });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});

concept10.post("/abort", (req, res) => {
  const parsed = ControlBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  try {
    const { abort, send, ms } = getRun(parsed.data.id);
    send("control", { method: "abortController.abort()", ms });
    abort.abort();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});

// A follow-up message into the SAME session, e.g. after an interrupt.
concept10.post("/send", (req, res) => {
  const parsed = SendBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  try {
    const { input, send, ms } = getRun(parsed.data.id);
    send("control", { method: "push user message", text: parsed.data.text, ms });
    input.push(parsed.data.text);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});

// Closing the input iterable is the normal way to end a streaming-input session.
concept10.post("/end", (req, res) => {
  const parsed = ControlBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  try {
    const { input, send, ms } = getRun(parsed.data.id);
    send("control", { method: "close input", ms });
    input.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});
