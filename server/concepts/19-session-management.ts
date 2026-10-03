/**
 * CONCEPT 19 — Session management: where the next turn goes, and the sessions on disk
 *
 * Part A: the options that decide which session a query() writes to
 *   (nothing)                        -> a new session
 *   continue: true                   -> the most recent session in cwd (no id needed)
 *   resume: id                       -> that session, same id
 *   resume: id + forkSession: true   -> a copy of it with a new id; the original is not touched
 *   resume: id + resumeSessionAt: uuid -> that session, same id, but the chain is cut after uuid (later turns are dropped)
 *   sessionId: uuid                  -> a new session with the id you chose (with resume, only if forkSession is set)
 *   persistSession: false            -> nothing written to disk: not listed, cannot be resumed
 *
 * Part B: the functions that read and change the transcripts, without starting Claude Code
 *   listSessions({ dir }), getSessionInfo(id), getSessionMessages(id), renameSession, tagSession,
 *   forkSession(id, { upToMessageId }), deleteSession
 *
 * Transcripts live in ~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<sessionId>.jsonl.
 * Every run uses cwd session-lab/ and every function passes { dir: LAB }, so only the lab's sessions are listed.
 * The browser never sends a path: a mode, a session id and a message uuid, each checked here (bodies with zod).
 *
 * Routes: /turn (SSE); /sessions, /sessions/:id (JSON), /sessions/:id/rename, /tag, /fork, /delete; /reset.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
  type Options,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept19 = Router();

const LAB = path.resolve("session-lab");
mkdirSync(LAB, { recursive: true });

// Where Claude Code writes the lab's transcripts. Paths longer than 200 characters get cut and a hash appended;
// this one is shorter, so the plain rule is enough (the UI shows whether the folder really exists).
const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects", LAB.replace(/[^a-zA-Z0-9]/g, "-"));

/**
 * No tools and one turn: the lab is about the conversation, not about what the agent does.
 * Thinking off: with it, each turn has an extra "thinking" assistant entry in the transcript.
 */
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 1,
  thinking: { type: "disabled" },
  cwd: LAB,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["new", "continue", "resume", "fork", "resumeAt", "customId", "ephemeral"] as const;
type Mode = (typeof MODES)[number];
const Uuid = z.string().regex(UUID, "must be a uuid");
const ShortText = z.string().trim().max(80); // titles and tags

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

/** The options each mode adds to BASE. Throws when the browser sent something that does not fit the mode. */
function optionsFor(mode: Mode, sessionId?: string, at?: string): Options {
  const needsId = mode === "resume" || mode === "fork" || mode === "resumeAt";
  if (needsId && !UUID.test(sessionId ?? "")) throw new Error(`${mode} needs a session: select one in Part B.`);
  if (mode === "resumeAt" && !UUID.test(at ?? "")) throw new Error("resumeAt needs a message: pick a turn in the transcript.");

  switch (mode) {
    case "new":
      return {};
    case "continue":
      return { continue: true };
    case "resume":
      return { resume: sessionId };
    case "fork":
      return { resume: sessionId, forkSession: true };
    case "resumeAt":
      return { resume: sessionId, resumeSessionAt: at };
    case "customId":
      return { sessionId: randomUUID() };
    case "ephemeral":
      return { persistSession: false };
  }
}

/** Text of a transcript entry: a string, or the text blocks of a content array. */
function textOf(m: SessionMessage): string {
  const content = (m.message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
  return "";
}

/**
 * Groups the chain into turns: one user prompt and the assistant entries after it.
 * lastUuid is the uuid to give resumeSessionAt / upToMessageId to keep the whole turn.
 */
function turnsOf(messages: SessionMessage[]) {
  const turns: { prompt: string; promptUuid: string; answer: string; lastUuid: string; entries: number }[] = [];
  for (const m of messages) {
    if (m.type === "user") turns.push({ prompt: textOf(m), promptUuid: m.uuid, answer: "", lastUuid: m.uuid, entries: 1 });
    else if (m.type === "assistant" && turns.length) {
      const turn = turns[turns.length - 1];
      turn.answer += textOf(m);
      turn.lastUuid = m.uuid;
      turn.entries++;
    }
  }
  return turns;
}

const labSessions = () => listSessions({ dir: LAB });
const turnCount = async (id: string) => turnsOf(await getSessionMessages(id, { dir: LAB })).length;

// ---------------------------------------------------------------------------------------------
// Part A: run one turn and report which session it went to
// ---------------------------------------------------------------------------------------------

// sessionId: the session selected in Part B (if any); at: the last uuid of the picked turn (if any).
const TurnBody = z
  .object({ prompt: z.string().trim().min(1).max(4000), mode: z.enum(MODES), sessionId: Uuid.optional(), at: Uuid.optional() })
  .strict();

concept19.post("/turn", async (req, res) => {
  const parsed = TurnBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt, mode, sessionId, at } = parsed.data;

  let extra: Options;
  try {
    extra = optionsFor(mode, sessionId, at);
  } catch (err) {
    send("error", { message: String(err) });
    send("done", {});
    return res.end();
  }

  // What existed before the run: to tell "new session" from "existing session", and what continue would pick.
  const before = await labSessions();
  const target = extra.resume;
  const turnsBefore = target ? await turnCount(target) : undefined;

  send("options", { ...BASE, ...extra });
  send("before", { mostRecent: before[0]?.sessionId, count: before.length, turnsBefore });

  const q = query({ prompt, options: { ...BASE, ...extra, abortController: abort } });

  // Pass everything through; after the result, check where the turn really landed.
  async function* run() {
    let written: string | undefined;
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") written = msg.session_id;
      yield msg;
    }
    if (!written) return;
    const info = await getSessionInfo(written, { dir: LAB });
    send("verdict", {
      mode,
      target,
      mostRecent: before[0]?.sessionId,
      sessionId: written,
      isNew: !before.some((s) => s.sessionId === written),
      persisted: Boolean(info),
      turnsBefore,
      turnsAfter: info ? await turnCount(written) : undefined,
    });
  }
  pipe(run());
});

// ---------------------------------------------------------------------------------------------
// Part B: the sessions on disk
// ---------------------------------------------------------------------------------------------

concept19.get("/sessions", async (_req, res) => {
  res.json({ lab: LAB, transcripts: TRANSCRIPTS, transcriptsExist: existsSync(TRANSCRIPTS), sessions: await labSessions() });
});

const NoBody = z.object({}).strict(); // the route reads no body: anything in it is refused

/** Only a session of the lab can be read or changed: the id must be listed by listSessions({ dir: LAB }). */
async function labSession(req: Request) {
  const id = req.params.id;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Not a session id.");
  if (!(await labSessions()).some((s) => s.sessionId === id)) throw new Error("That session is not in session-lab/.");
  return id;
}

/** Wraps a Part B route: checks the body (400) and the id, runs the SDK call, reports errors as 409. */
function manage<S extends z.ZodType>(Body: S, action: (id: string, body: z.infer<S>) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
    try {
      const id = await labSession(req);
      const startedAt = Date.now();
      const result = await action(id, parsed.data);
      res.json({ ok: true, ms: Date.now() - startedAt, result });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  };
}

concept19.get(
  "/sessions/:id",
  manage(NoBody, async (id) => {
    const messages = await getSessionMessages(id, { dir: LAB });
    return {
      info: await getSessionInfo(id, { dir: LAB }),
      turns: turnsOf(messages),
      file: path.join(TRANSCRIPTS, `${id}.jsonl`),
      entries: messages.map((m) => ({ type: m.type, uuid: m.uuid, text: textOf(m).slice(0, 120) })),
    };
  }),
);

concept19.post(
  "/sessions/:id/rename",
  manage(z.object({ title: ShortText.min(1) }).strict(), (id, { title }) => renameSession(id, title, { dir: LAB })),
);

// An empty tag clears it (tagSession(id, null)).
concept19.post(
  "/sessions/:id/tag",
  manage(z.object({ tag: ShortText }).strict(), (id, { tag }) => tagSession(id, tag || null, { dir: LAB })),
);

const ForkBody = z.object({ upToMessageId: Uuid.optional(), title: ShortText.min(1).optional() }).strict();
concept19.post(
  "/sessions/:id/fork",
  manage(ForkBody, (id, { upToMessageId, title }) => forkSession(id, { dir: LAB, upToMessageId, ...(title && { title }) })),
);

concept19.post(
  "/sessions/:id/delete",
  manage(NoBody, (id) => deleteSession(id, { dir: LAB })),
);

/** Deletes every session of the lab, to start the exercises again. */
concept19.post("/reset", async (_req, res) => {
  const sessions = await labSessions();
  for (const s of sessions) await deleteSession(s.sessionId, { dir: LAB });
  res.json({ deleted: sessions.length });
});
