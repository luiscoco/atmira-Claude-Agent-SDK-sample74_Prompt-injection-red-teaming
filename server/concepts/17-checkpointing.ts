/**
 * CONCEPT 17 — File checkpointing & rewind: undo what the agent did to your files
 *
 *   enableFileCheckpointing: true  -> before Write / Edit / NotebookEdit change a file, a backup is taken,
 *                                    one checkpoint per user message
 *   q.rewindFiles(userMessageUuid) -> puts every tracked file back as it was when that user message arrived
 *                                    (before its turn ran). Files created later are deleted.
 *   q.rewindFiles(uuid, { dryRun: true }) -> the same answer (filesChanged, insertions, deletions) without touching disk
 *
 * Where the uuid comes from:
 *   streaming input -> you set `uuid` on the SDKUserMessage you push; that uuid is the checkpoint id
 *   string prompt   -> extraArgs: { "replay-user-messages": null } echoes the user message back with its uuid
 *
 * Part A: a live session (streaming input). Every turn is a checkpoint; preview or rewind to any of them.
 *   Not tracked: changes made through Bash. Not rewound: the conversation (the model still remembers).
 *   Without enableFileCheckpointing, rewindFiles() throws "File rewinding is not enabled."
 *
 * Part B: after the session ended. A string prompt closes the query after its result, so rewindFiles() on it throws.
 *   Resume the session (resume: sessionId) with an input that sends nothing, and call rewindFiles() on the new Query.
 *
 * Routes: /session (SSE) + /send, /rewind, /end; /oneshot (SSE), /resume-rewind (JSON).
 * The browser never sends a path: every run works in checkpoint-lab/, which the server recreates. Bodies are checked with zod.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options, type Query, type RewindFilesResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept17 = Router();

const LAB = path.resolve("checkpoint-lab");
const LIVE = path.join(LAB, "live"); // Part A
const ONESHOT = path.join(LAB, "oneshot"); // Part B

// The files every run starts with.
const SEED: Record<string, string> = {
  "plan.md": "# Release plan\n- write the tests\n",
  "config.json": '{\n  "version": "1.0.0"\n}\n',
};

/** Empties the folder (the folder itself stays: a Claude Code process may still have it as cwd) and writes the seed files. */
async function reset(dir: string) {
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) await rm(path.join(dir, f), { recursive: true, force: true });
  for (const [name, content] of Object.entries(SEED)) await writeFile(path.join(dir, name), content);
}

/** What is on disk right now, so the browser can see what a rewind really did. */
async function snapshot(dir: string) {
  const names = (await readdir(dir).catch(() => [])).sort();
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(dir, name), "utf8").catch(() => "(not a file)") })));
}

/** filesChanged has absolute paths; the UI only needs the names. */
function relative(result: RewindFilesResult, dir: string): RewindFilesResult {
  return { ...result, ...(result.filesChanged && { filesChanged: result.filesChanged.map((f) => path.relative(dir, f)) }) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.string().regex(UUID, "must be a uuid");
const Prompt = z.string().trim().min(1).max(4000);

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

/**
 * Write and Edit are tracked by checkpoints; Bash is there to show a change that is NOT tracked.
 * "acceptEdits" approves edits and filesystem commands (echo > file, sed -i, rm…) inside cwd; anything else would
 * need canUseTool, and there is none, so it is denied.
 * "replay-user-messages" makes the CLI echo each user message back with its uuid (the id to rewind to).
 */
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: ["Read", "Write", "Edit", "Bash"],
  allowedTools: ["Read"],
  permissionMode: "acceptEdits",
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 8,
  extraArgs: { "replay-user-messages": null },
};

/** The push queue from Concept 12. */
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

/** Passes every message through, and sends a snapshot of the folder after each result. */
async function* withFiles(stream: AsyncIterable<SDKMessage>, dir: string, send: (event: string, data: unknown) => void) {
  for await (const msg of stream) {
    yield msg;
    if (msg.type === "result") send("files", await snapshot(dir));
  }
}

// ---------------------------------------------------------------------------------------------
// Part A: a live session, one checkpoint per user message
// ---------------------------------------------------------------------------------------------

type Session = { q: Query; input: ReturnType<typeof inputQueue>; send: (event: string, data: unknown) => void; turns: number };
const sessions = new Map<string, Session>();

const SessionBody = z.object({ checkpointing: z.boolean().optional() }).strict();

concept17.post("/session", async (req, res) => {
  const parsed = SessionBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { checkpointing = true } = parsed.data;

  // Only one live session at a time works in this folder: end the previous one first.
  for (const s of sessions.values()) s.input.close();
  await reset(LIVE);

  const options: Options = { ...BASE, cwd: LIVE, enableFileCheckpointing: checkpointing };
  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  sessions.set(id, { q, input, send, turns: 0 });

  send("session", { id });
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  send("files", await snapshot(LIVE));
  pipe(withFiles(q, LIVE, send)).finally(() => sessions.delete(id));
});

/** Wraps a control route: checks the body (400), finds the session, runs the action, reports errors as 409. */
function control<S extends z.ZodType<{ id: string }>>(Body: S, action: (s: Session, body: z.infer<S>) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
    try {
      const session = sessions.get(parsed.data.id);
      if (!session) throw new Error("No open session with that id (it already ended).");
      res.json({ ok: true, result: await action(session, parsed.data) });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  };
}

// The uuid we give the message is the checkpoint id: no need to wait for the echo.
concept17.post(
  "/send",
  control(z.object({ id: Uuid, text: Prompt }).strict(), (session, { text }) => {
    const uuid = randomUUID();
    session.turns++;
    session.send("checkpoint", { uuid, text, turn: session.turns });
    session.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, uuid });
    return { uuid };
  }),
);

concept17.post(
  "/rewind",
  control(z.object({ id: Uuid, uuid: Uuid, dryRun: z.boolean() }).strict(), async ({ q, send }, { uuid, dryRun }) => {
    const startedAt = Date.now();
    const result = relative(await q.rewindFiles(uuid, { dryRun: Boolean(dryRun) }), LIVE);
    const ms = Date.now() - startedAt;
    if (!dryRun) send("files", await snapshot(LIVE));
    return { result, ms };
  }),
);

concept17.post(
  "/end",
  control(z.object({ id: Uuid }).strict(), ({ input }) => input.close()),
);

// ---------------------------------------------------------------------------------------------
// Part B: rewind after the query has ended
// ---------------------------------------------------------------------------------------------

const OneshotBody = z.object({ prompt: Prompt }).strict();

concept17.post("/oneshot", async (req, res) => {
  const parsed = OneshotBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt } = parsed.data;
  await reset(ONESHOT);

  const options: Options = { ...BASE, cwd: ONESHOT, enableFileCheckpointing: true };
  send("options", options);
  send("files", await snapshot(ONESHOT));
  const q = query({ prompt, options: { ...options, abortController: abort } });

  // Stream everything; remember the echoed user message; after the loop, try rewindFiles() on the finished Query.
  async function* run() {
    let checkpoint: { uuid: string; sessionId: string } | undefined;
    for await (const msg of withFiles(q, ONESHOT, send)) {
      if (msg.type === "user" && "isReplay" in msg && msg.isReplay && !checkpoint) {
        checkpoint = { uuid: msg.uuid, sessionId: msg.session_id };
        send("checkpoint", checkpoint);
      }
      yield msg;
    }
    if (!checkpoint) return;
    try {
      await q.rewindFiles(checkpoint.uuid, { dryRun: true });
      send("control", { method: "q.rewindFiles() after the loop", ok: true });
    } catch (err) {
      send("control", { method: "q.rewindFiles() after the loop", error: String(err) });
    }
  }
  pipe(run());
});

const ResumeRewindBody = z.object({ sessionId: Uuid, uuid: Uuid, dryRun: z.boolean() }).strict();

// A new query() on the same session: an input that sends nothing, so there is no turn and no model call.
concept17.post("/resume-rewind", async (req, res) => {
  const parsed = ResumeRewindBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  const { sessionId, uuid, dryRun } = parsed.data;

  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...BASE, cwd: ONESHOT, enableFileCheckpointing: true, resume: sessionId } });
  const startedAt = Date.now();
  try {
    const result = relative(await q.rewindFiles(uuid, { dryRun: Boolean(dryRun) }), ONESHOT);
    res.json({ ms: Date.now() - startedAt, result, files: await snapshot(ONESHOT) });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  } finally {
    input.close();
    q.close();
  }
});
