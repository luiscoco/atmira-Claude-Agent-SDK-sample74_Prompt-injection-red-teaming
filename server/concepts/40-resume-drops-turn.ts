/**
 * CONCEPT 40 — resumeDropsTurn: a truncating resume that says which turn it means to drop
 *
 *   options.resume          = sessionId
 *   options.resumeSessionAt = <the last chain entry of the turn you KEEP>    ← Concept 19: cut the chain after it
 *   options.resumeDropsTurn = <the prompt uuid of the turn you DROP>         ← this concept: "and only that turn"
 *
 * resumeSessionAt alone cuts whatever is after the fork point. If the session absorbed something the host did not see
 * (a message queued while a tool was running, a task notification, a later turn), it is dropped too, without a word.
 * With resumeDropsTurn, Claude Code checks the discarded range first: it must start with that prompt, and hold only
 * that turn's own entries (its assistant messages, tool results, "furniture" attachments). Otherwise it refuses:
 * an error_during_execution result whose message starts with "Resume rejected by --resume-drops-turn:", at $0.
 *
 * The refusal is deterministic, so a host must not retry: it clears the fork target and resumes plainly.
 * It becomes the CLI flag --resume-drops-turn=<id> (print mode only; it requires --resume-session-at).
 *
 * The lab uses its own CLAUDE_CONFIG_DIR (drops-lab/config), so the tab can read the raw transcript, attachments too.
 * Routes: POST /dry, POST /build (SSE), GET /state, POST /cases (SSE, one row per case), POST /undo (SSE), GET /code.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept40 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("drops-lab");
const WORK = path.join(LAB, "work"); // cwd of every session
const CONFIG = path.join(LAB, "config"); // CLAUDE_CONFIG_DIR: the transcripts are in config/projects/<cwd>/<id>.jsonl
const REFUSED = "Resume rejected by --resume-drops-turn:"; // the prefix sdk.d.ts tells hosts to match on

const ROOT = process.cwd();
const slashes = (s: string) => s.replaceAll("\\", "/");
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "") // colour codes: `npm run dev` (concurrently) sets FORCE_COLOR
    .replaceAll(LAB, "drops-lab")
    .replaceAll(slashes(LAB), "drops-lab")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…");

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #region options
function base(abort: AbortController, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG;
  return {
    model: MODEL,
    cwd: WORK,
    env,
    tools: ["Bash"], // turn 3 used Bash: the resumed history has a tool_use, so the tool stays declared
    settingSources: [],
    thinking: { type: "disabled" },
    maxTurns: 1,
    abortController: abort,
    ...extra, // resume, forkSession, resumeSessionAt, resumeDropsTurn ← the options of this concept
  };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /dry: where the option goes (a fake process records the args), and what the CLI checks at startup
// ---------------------------------------------------------------------------------------------

// #region dry
function recordingProcess(): SpawnedProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const p = {
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    stdout,
    killed: false,
    exitCode: null as number | null,
    kill: () => false,
    on: (e: string, l: (...a: any[]) => void) => (events.on(e, l), p),
    once: (e: string, l: (...a: any[]) => void) => (events.once(e, l), p),
    off: (e: string, l: (...a: any[]) => void) => (events.off(e, l), p),
  };
  setTimeout(() => ((p.exitCode = 0), stdout.end(), events.emit("exit", 0, null)), 200);
  return p as SpawnedProcess;
}

const A = "11111111-1111-4111-8111-111111111111"; // placeholders: the dry run never reads a session
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

async function argsFor(extra: Partial<Options>) {
  let args: string[] = [];
  const q = query({ prompt: "hi", options: { model: MODEL, cwd: WORK, settingSources: [], ...extra, spawnClaudeCodeProcess: (o) => ((args = o.args), recordingProcess()) } });
  try {
    for await (const _ of q) break;
  } catch {}
  return args.filter((a) => /^--(resume|fork-session)/.test(a) || a === A);
}

/** The real Claude Code with a combination it refuses before reading any session: no API call. */
async function startup(extra: Partial<Options>) {
  let stderr = "";
  try {
    for await (const _ of query({ prompt: "hi", options: base(new AbortController(), { ...extra, stderr: (s) => (stderr += s) }) })) break;
    return { ok: true, message: "it started" };
  } catch (err) {
    return { ok: false, message: short(stderr.trim() || errText(err)) };
  }
}
// #endregion

concept40.post("/dry", async (_req, res) => {
  try {
    mkdirSync(WORK, { recursive: true });
    const [flags, checks] = await Promise.all([
      Promise.all(
        [
          { key: "at", shown: "resume + resumeSessionAt", value: { resume: A, resumeSessionAt: B } },
          { key: "both", shown: "resume + resumeSessionAt + resumeDropsTurn", value: { resume: A, resumeSessionAt: B, resumeDropsTurn: C } },
          { key: "fork", shown: "… + forkSession: true", value: { resume: A, resumeSessionAt: B, resumeDropsTurn: C, forkSession: true } },
          { key: "empty", shown: "resumeDropsTurn: '' (empty)", value: { resume: A, resumeSessionAt: B, resumeDropsTurn: "" } },
        ].map(async (r) => ({ key: r.key, shown: r.shown, args: await argsFor(r.value) })),
      ),
      Promise.all(
        [
          { key: "noAt", shown: "resume + resumeDropsTurn (no resumeSessionAt)", value: { resume: A, resumeDropsTurn: C } },
          { key: "noResume", shown: "resumeSessionAt + resumeDropsTurn (no resume)", value: { resumeSessionAt: B, resumeDropsTurn: C } },
        ].map(async (r) => ({ key: r.key, shown: r.shown, ...(await startup(r.value)) })),
      ),
    ]);
    res.json({ flags, checks });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// The transcript: read the JSONL itself. getSessionMessages() leaves attachments out, and they are the point here.
// ---------------------------------------------------------------------------------------------

// #region chain
type Entry = { i: number; type: string; kind: string; uuid: string; parentUuid: string | null; text: string; isMeta?: boolean; message?: any; attachment?: any };
type Turn = {
  n: number; // 1, 2, 3…
  prompt: string; // the prompt uuid: what resumeDropsTurn names
  text: string;
  byHost: boolean; // a uuid the host chose on its SDKUserMessage
  from: number; // chain indexes [from, to]
  to: number;
  lastUuid: string; // the turn's last chain entry: the safe resumeSessionAt to KEEP this turn
  assistantUuid: string; // its last assistant message: the uuid a host sees streamed
  toolUseUuid?: string; // an assistant message in the middle of the turn (the tool_use), if any
  queued: string[]; // messages absorbed into this turn while it ran
};

function transcriptFile(id: string) {
  const projects = path.join(CONFIG, "projects");
  if (!existsSync(projects)) return undefined;
  for (const p of readdirSync(projects)) {
    const f = path.join(projects, p, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
}

const textOf = (e: any) => {
  if (e.type === "attachment") return e.attachment?.type === "queued_command" ? String(e.attachment.prompt ?? "") : "";
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (b.type === "text" ? b.text : `[${b.type}${b.name ? " " + b.name : ""}]`)).join(" ");
  return "";
};
const isToolResults = (e: any) => Array.isArray(e.message?.content) && e.message.content.length > 0 && e.message.content.every((b: any) => b.type === "tool_result");
const isPrompt = (e: Entry) => e.type === "user" && !e.isMeta && !isToolResults(e);

/** The chain: from the newest entry, follow parentUuid back to the first one. Branches cut off by a resume are left out. */
function chainOf(id: string): Entry[] {
  const f = transcriptFile(id);
  if (!f) return [];
  const all = readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.uuid && ["user", "assistant", "attachment", "system"].includes(e.type));
  const byUuid = new Map(all.map((e) => [e.uuid, e]));
  const out: any[] = [];
  for (let e = all.at(-1); e; e = byUuid.get(e.parentUuid)) out.unshift(e);
  return out.map((e, i) => ({ ...e, i, kind: e.type === "attachment" ? `attachment/${e.attachment?.type}` : isToolResults(e) ? "user (tool_result)" : e.type, text: short(textOf(e)).slice(0, 120) }));
}

function turnsOf(chain: Entry[], hostUuids: Set<string>): Turn[] {
  const starts = chain.filter(isPrompt).map((e) => e.i);
  return starts.map((from, k) => {
    const to = (starts[k + 1] ?? chain.length) - 1;
    const part = chain.slice(from, to + 1);
    const assistants = part.filter((e) => e.type === "assistant");
    return {
      n: k + 1,
      prompt: chain[from].uuid,
      text: chain[from].text,
      byHost: hostUuids.has(chain[from].uuid),
      from,
      to,
      lastUuid: chain[to].uuid,
      assistantUuid: assistants.at(-1)?.uuid ?? chain[to].uuid,
      toolUseUuid: assistants.find((e) => e.message?.content?.some?.((b: any) => b.type === "tool_use"))?.uuid,
      queued: part.filter((e) => e.kind === "attachment/queued_command").map((e) => e.text),
    };
  });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /build: the session every case forks from. One query(), streaming input, four turns.
// ---------------------------------------------------------------------------------------------

type Built = { id: string; hostUuids: Set<string>; turns: Turn[]; chain: Entry[] };
let built: Built | undefined;
const view = (b: Built) => ({
  sessionId: b.id,
  turns: b.turns,
  chain: b.chain.map(({ i, kind, uuid, text }) => ({ i, kind, uuid, text, turn: b.turns.find((t) => i >= t.from && i <= t.to)?.n })),
});

// #region build
const TURNS = [
  "Remember: my fruit is mango. Reply OK.",
  "Remember: my colour is teal. Reply OK.",
  `Run exactly this with the Bash tool: node -e "setTimeout(()=>console.log('built'),5000)". Then reply with its output.`,
  "Remember: my pet is a cat. Reply OK.",
];
const QUEUED = "Also remember: my city is Oslo."; // sent while turn 3's Bash call is running

async function buildSession(abort: AbortController, emit: Emit): Promise<Built> {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const uuids = TURNS.map(() => randomUUID()); // the host picks each prompt's uuid, so it knows what to name later
  const queuedUuid = randomUUID();
  let results = 0;
  let toolStarted = false;
  const until = async (ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end && !abort.signal.aborted; ) await sleep(100);
  };
  const user = (text: string, uuid: `${string}-${string}-${string}-${string}-${string}`): SDKUserMessage => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: text } });

  async function* input() {
    for (let k = 0; k < TURNS.length; k++) {
      emit("sent", { turn: k + 1, uuid: uuids[k], text: TURNS[k] });
      yield user(TURNS[k], uuids[k]);
      if (k === 2) {
        await until(() => toolStarted, 30_000);
        await sleep(1000); // Bash is still sleeping: the message arrives mid-turn
        emit("sent", { turn: "queued", uuid: queuedUuid, text: QUEUED });
        yield user(QUEUED, queuedUuid);
      }
      await until(() => results > k);
    }
  }

  let id = "";

  for await (const m of query({ prompt: input(), options: base(abort, { allowedTools: ["Bash"], maxTurns: 4 }) })) {
    if (m.type === "system" && m.subtype === "init") (id = m.session_id), emit("init", { sessionId: id });
    if (m.type === "assistant")
      for (const b of m.message.content) {
        if (b.type === "tool_use") (toolStarted = true), emit("tool", { command: short(String((b.input as any).command ?? "")), uuid: m.uuid });
        if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 300), uuid: m.uuid });
      }
    if (m.type === "result") {
      results++;

      emit("result", { turn: results, subtype: m.subtype, cost: m.total_cost_usd });
    }
  }
  if (!id) throw new Error("The session did not start.");
  const chain = chainOf(id);
  const hostUuids = new Set([...uuids, queuedUuid]);
  return { id, hostUuids, chain, turns: turnsOf(chain, hostUuids) };
}
// #endregion

concept40.post("/build", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  try {
    built = await buildSession(abort, emit);
    emit("chain", view(built));
  } catch (err) {
    emit("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// The session lives on the server (and on disk): a reloaded tab gets it back.
concept40.get("/state", (_req, res) => void res.json(built ? view(built) : null));

// ---------------------------------------------------------------------------------------------
// One guarded resume: the case runner of /cases and /undo
// ---------------------------------------------------------------------------------------------

// #region resume
const QUESTION = "What do you know about me: fruit, colour, city, pet? One short line. Do not use tools.";

type Outcome = {
  options: { resumeSessionAt?: string; resumeDropsTurn?: string; forkSession: boolean };
  status: "accepted" | "refused" | "exited" | "error";
  reason?: string; // the text after the prefix, when refused
  answer: string;
  sessionId?: string;
  kept: string[]; // the prompts of the new chain
  cost: number;
};

async function resumeOnce(b: Built, extra: { resumeSessionAt?: string; resumeDropsTurn?: string }, abort: AbortController): Promise<Outcome> {
  const options = { resume: b.id, forkSession: true, ...extra }; // always a fork: the lab session is never changed
  const r: Outcome = { options: { ...extra, forkSession: true }, status: "error", answer: "", kept: [], cost: 0 };
  let stderr = "";
  try {
    for await (const m of query({ prompt: QUESTION, options: base(abort, { ...options, stderr: (s) => (stderr += s) }) })) {
      if (m.type === "system" && m.subtype === "init") r.sessionId = m.session_id;
      if (m.type !== "result") continue;
      r.cost = m.total_cost_usd;
      if (m.subtype === "success") (r.status = "accepted"), (r.answer = short(m.result).slice(0, 300));
      else {
        // The refusal is a result: error_during_execution, errors[0] starts with the prefix. query() throws right after.
        const e = (m.errors ?? []).find((x) => x.startsWith(REFUSED));
        if (e) (r.status = "refused"), (r.reason = short(e.slice(REFUSED.length)).trim());
        else r.answer = short((m.errors ?? [m.subtype]).join("; "));
      }
    }
  } catch (err) {
    if (r.status === "error") (r.status = "exited"), (r.answer = short(stderr.trim().split("\n").at(-1) || errText(err)));
  }
  if (r.status === "accepted" && r.sessionId) r.kept = chainOf(r.sessionId).filter(isPrompt).map((e) => e.text.slice(0, 60));
  return r;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /cases: the table. Every row forks the same session with a different pair of options.
// ---------------------------------------------------------------------------------------------

// #region cases
type Case = { key: string; label: string; pick: (t: Turn[]) => { resumeSessionAt?: string; resumeDropsTurn?: string }; note: (r: Outcome, t: Turn[]) => string };

const CASES: Case[] = [
  {
    key: "plain",
    label: "keep turns 1–2, no guard",
    pick: (t) => ({ resumeSessionAt: t[1].lastUuid }),
    note: () => "resumeSessionAt alone: accepted. Turns 3 and 4 are gone, and so is the city: the message queued during turn 3 went with it, without a word.",
  },
  {
    key: "queued",
    label: "keep turns 1–2, drop turn 3",
    pick: (t) => ({ resumeSessionAt: t[1].lastUuid, resumeDropsTurn: t[2].prompt }),
    note: () => "The host believes it drops turn 3 only. Turn 3 absorbed a queued message (and turn 4 follows): refused.",
  },
  {
    key: "twoTurns",
    label: "keep turn 1, drop turn 2",
    pick: (t) => ({ resumeSessionAt: t[0].lastUuid, resumeDropsTurn: t[1].prompt }),
    note: () => "The range starts with turn 2, but turn 3's prompt follows: not part of the declared turn.",
  },
  {
    key: "last",
    label: "keep turns 1–3, drop turn 4",
    pick: (t) => ({ resumeSessionAt: t[2].lastUuid, resumeDropsTurn: t[3].prompt }),
    note: () => "The range is turn 4 and nothing else: accepted. The city survives, it is in turn 3.",
  },
  {
    key: "streamed",
    label: "the same, at turn 3's streamed assistant uuid",
    pick: (t) => ({ resumeSessionAt: t[2].assistantUuid, resumeDropsTurn: t[3].prompt }),
    // Whether entries follow the assistant message depends on the run: turn 1 always ends with a prompt_snapshot.
    note: (r, t) =>
      t[2].assistantUuid === t[2].lastUuid
        ? "In this build the assistant message IS turn 3's last entry: the same fork point as the row above. (Turn 1 ends with a prompt_snapshot after its assistant: that one would be skipped as furniture.)"
        : r.status === "accepted"
          ? "Also accepted: the entries after the assistant message are 'furniture' (a prompt_snapshot…), skipped by the check."
          : "Refused: an entry after the assistant message is not furniture.",
  },
  {
    key: "midTurn",
    label: "fork in the middle of turn 3 (its tool_use), drop turn 4",
    pick: (t) => ({ resumeSessionAt: t[2].toolUseUuid ?? t[2].assistantUuid, resumeDropsTurn: t[3].prompt }),
    note: () => "The range starts with turn 3's own tool_result, not with turn 4's prompt: refused. Fork at the LAST entry of the turn you keep.",
  },
  {
    key: "wrongTurn",
    label: "keep turns 1–3, but name turn 3",
    pick: (t) => ({ resumeSessionAt: t[2].lastUuid, resumeDropsTurn: t[2].prompt }),
    note: () => "The first discarded entry is turn 4's prompt, not the declared one: refused.",
  },
  {
    key: "notUuid",
    label: "resumeDropsTurn: 'turn-4'",
    pick: (t) => ({ resumeSessionAt: t[2].lastUuid, resumeDropsTurn: "turn-4" }),
    note: () => "The SDK passes any string. Claude Code wants a UUID.",
  },
  {
    key: "nothing",
    label: "keep all four turns, name turn 4",
    pick: (t) => ({ resumeSessionAt: t[3].lastUuid, resumeDropsTurn: t[3].prompt }),
    note: () => "Nothing is discarded, so there is nothing to check: accepted, even though the named turn is kept.",
  },
  {
    key: "noAt",
    label: "resumeDropsTurn without resumeSessionAt",
    pick: (t) => ({ resumeDropsTurn: t[3].prompt }),
    note: () => "Claude Code exits at startup: query() throws, no result.",
  },
];

/** At most `n` sessions at a time: each one is a Claude Code process. */
async function pool<T>(items: T[], n: number, run: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i], i);
    }
  }));
}
// #endregion

const needBuilt = () => {
  if (!built || !transcriptFile(built.id)) throw new Error("No lab session yet: run scenario 2 first.");
  return built;
};

concept40.post("/cases", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  try {
    const b = needBuilt();
    await pool(CASES, 4, async (c, order) => {
      const r = await resumeOnce(b, c.pick(b.turns), abort);
      send("row", { key: c.key, label: c.label, order, ...r, note: c.note(r, b.turns), at: Date.now() - startedAt });
    });
  } catch (err) {
    send("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /undo: "undo turn N" the way a host should do it
// ---------------------------------------------------------------------------------------------

// #region undo
/**
 * Drop turn n: fork at the last entry of turn n-1 and name turn n's prompt. On a refusal, do NOT retry (it would fail
 * the same way forever): clear the fork target and resume plainly, keeping everything, and tell the user why.
 */
async function undoTurn(b: Built, n: number, at: "last" | "assistant" | "toolUse", recover: boolean, abort: AbortController, emit: Emit) {
  const kept = b.turns[n - 2]; // the turn before the one to drop
  const drop = b.turns[n - 1];
  const resumeSessionAt = at === "assistant" ? kept.assistantUuid : at === "toolUse" ? (kept.toolUseUuid ?? kept.assistantUuid) : kept.lastUuid;
  emit("attempt", { resume: b.id, forkSession: true, resumeSessionAt, resumeDropsTurn: drop.prompt, keeps: `turns 1–${n - 1}`, drops: `turn ${n}: ${drop.text}` });
  const first = await resumeOnce(b, { resumeSessionAt, resumeDropsTurn: drop.prompt }, abort);
  emit("outcome", { step: "guarded", ...first });
  if (first.status !== "refused" || !recover) return [first];
  // The rewind-recovery path: no fork target, no guard. The evidence (the absorbed content) stays in the session.
  emit("recover", { why: first.reason, resume: b.id, forkSession: true });
  const second = await resumeOnce(b, {}, abort);
  emit("outcome", { step: "recovered", ...second });
  return [first, second];
}
// #endregion

const UndoBody = z
  .object({ turn: z.number().int().min(2).max(4), at: z.enum(["last", "assistant", "toolUse"]), recover: z.boolean() })
  .strict();

concept40.post("/undo", async (req, res) => {
  const parsed = UndoBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  try {
    if (!parsed.success) throw new Error(badRequest(parsed.error));
    const { turn, at, recover } = parsed.data;
    const outs = await undoTurn(needBuilt(), turn, at, recover, abort, emit);
    emit("summary", { cost: outs.reduce((s, o) => s + o.cost, 0) });
  } catch (err) {
    emit("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept40.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
