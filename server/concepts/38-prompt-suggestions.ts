/**
 * CONCEPT 38 — Prompt suggestions: Claude Code predicts what the user will type next
 *
 *   options.promptSuggestions = true
 *
 *   … assistant, result  ← the turn is over
 *   { type: "prompt_suggestion", suggestion: "run hello.js", uuid, session_id }   ← about 1 s later, AFTER the result
 *
 * The option is not a CLI flag: it travels in control_request/initialize. After a turn, Claude Code makes one more API
 * call: the whole conversation plus a "[SUGGESTION MODE: …]" user message, with the same model, system prompt and tools,
 * so it reads the turn's prompt cache. Its answer is filtered (too long, "thanks", "(silence)", Claude's own voice, …);
 * only what survives becomes a prompt_suggestion message.
 *
 * No suggestion when: the conversation has fewer than 2 assistant replies, the next message is already queued, plan
 * mode, the last reply was an API error, the last reply was mostly uncached (over 10,000 uncached tokens), the option is
 * off, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false, or the setting promptSuggestionEnabled: false (the env var wins).
 *
 * The suggestion's cost is not in the result it follows: it shows up in the NEXT result's total_cost_usd.
 *
 * The lab puts a wire tap (ANTHROPIC_BASE_URL) between Claude Code and the API, to see each call and its usage.
 * Routes: POST /dry, POST /chat (SSE) + /send + /end, POST /when, /switches, /cache (SSE, one row per case), GET /code.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options, type SDKMessage, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept38 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("suggest-lab");
const RUNS = path.join(LAB, "runs"); // one folder per session: its cwd (and, for some rows, its own CLAUDE_CONFIG_DIR)
const CONFIG = path.join(LAB, "config"); // the fake CLAUDE_CONFIG_DIR of every other session
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

rmSync(LAB, { recursive: true, force: true });
for (const d of [RUNS, CONFIG]) mkdirSync(d, { recursive: true });

const ROOT = process.cwd();
const short = (s: string) =>
  s
    .replaceAll(LAB, "suggest-lab")
    .replace(/suggest-lab[\\/]+runs[\\/]+\w+/g, "<the run folder>")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…"); // a key must never reach the browser

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 500);

// Each session works in its own suggest-lab/runs/<id> folder. Folders of finished sessions are deleted.
const active = new Set<string>();
function newRun() {
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  active.add(id);
  return { id, work, done: () => (active.delete(id), tapRuns.delete(id)) };
}
type Run = ReturnType<typeof newRun>;

// #region wire
// The wire tap: ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<run id>. It forwards every request to the real API and
// records, for each /v1/messages call: what kind of call it is, its usage, its cost and the text it answered.
//   main        a turn of the conversation
//   suggestion  its last user message starts with "[SUGGESTION MODE: …]": the prompt suggestion call
//   title       its prompt starts with "<session>": the side call that names the session
export type WireCall = {
  n: number;
  kind: "main" | "suggestion" | "title";
  model: string;
  messages: number;
  tools: number;
  status: "done" | "aborted" | number; // number: an HTTP error status
  usage?: { input: number; cacheWrite: number; cacheRead: number; output: number };
  cost?: number;
  text?: string;
  instruction?: string; // suggestion calls only: the first lines of the SUGGESTION MODE message
};

// $ per million tokens, Claude Haiku 4.5: input, output, cache write (5 minutes / 1 hour), cache read.
const PRICE = { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 };
const callCost = (u: any) => {
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w = u.cache_creation_input_tokens ?? 0;
  return ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (w - w1h) * PRICE.write5m + w1h * PRICE.write1h + (u.cache_read_input_tokens ?? 0) * PRICE.read) / 1e6;
};

const lastUserText = (messages: any[]) => {
  const c = messages.at(-1)?.content;
  return typeof c === "string" ? c : (c ?? []).map((b: any) => b.text ?? "").join("\n");
};

/** Reads a streamed /v1/messages answer: the text it wrote and its final usage. */
function readStream(sse: string) {
  let usage: any = {};
  let text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type === "message_start") usage = { ...e.message.usage };
      if (e.type === "message_delta" && e.usage) usage = { ...usage, ...e.usage };
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text;
    } catch {}
  }
  return { usage, text };
}

const tapRuns = new Map<string, { calls: WireCall[]; onCall: (c: WireCall) => void }>();

const tap = http.createServer(async (req, res) => {
  const m = req.url?.match(/^\/w\/([\w-]+)(\/.*)$/);
  const t = m ? tapRuns.get(m[1]) : undefined;
  if (!m || !t) return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  let call: WireCall | undefined;
  if (req.method === "POST" && m[2].startsWith("/v1/messages") && !m[2].includes("count_tokens")) {
    try {
      const j = JSON.parse(body.toString());
      const last = lastUserText(j.messages ?? []);
      const first = lastUserText((j.messages ?? []).slice(0, 1));
      const kind = last.startsWith("[SUGGESTION MODE") ? "suggestion" : first.startsWith("<session>") ? "title" : "main";
      call = { n: t.calls.length + 1, kind, model: j.model, messages: j.messages.length, tools: (j.tools ?? []).length, status: "aborted" };
      if (kind === "suggestion") call.instruction = last.split("\n").slice(0, 12).join("\n");
      t.calls.push(call);
    } catch {}
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  // When Claude Code gives up on a call (a suggestion made useless by the next message), stop the upstream call too.
  const gone = new AbortController();
  res.on("close", () => res.writableFinished || gone.abort());
  const got: Buffer[] = [];
  try {
    const up = await fetch(UPSTREAM + m[2], { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : body, signal: gone.signal });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    for await (const c of up.body ?? []) res.write(c), got.push(Buffer.from(c));
    res.end();
    if (call) {
      if (up.status !== 200) call.status = up.status;
      else {
        const { usage, text } = readStream(Buffer.concat(got).toString());
        call.status = "done";
        call.usage = { input: usage.input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
        call.cost = callCost(usage);
        call.text = text.slice(0, 400);
      }
    }
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
  if (call) t.onCall(call);
});
const tapPort = new Promise<number>((resolve) => tap.listen(0, "127.0.0.1", () => resolve((tap.address() as { port: number }).port)));

async function openTap(run: Run, onCall: (c: WireCall) => void = () => {}) {
  const t = { calls: [] as WireCall[], onCall };
  tapRuns.set(run.id, t);
  return { url: `http://127.0.0.1:${await tapPort}/w/${run.id}`, calls: t.calls };
}
// #endregion

// #region options
function base(work: string, tapUrl: string, abort: AbortController, extra: Partial<Options> = {}, envExtra: Record<string, string> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG;
  env.ANTHROPIC_BASE_URL = tapUrl; // every API call goes through the wire tap
  return {
    model: MODEL,
    cwd: work,
    env: { ...env, ...envExtra },
    tools: [],
    settingSources: [], // no settings files, unless a row asks for them
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 6,
    promptSuggestions: true, // ← the option of this concept
    abortController: abort,
    ...extra,
  };
}
// #endregion

// #region queue
// Streaming input (Concept 12): the session stays open while this iterable is open, so there is a next turn to suggest.
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    stream: stream(),
    push: (text: string) => (queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } }), wake?.()),
    close: () => ((closed = true), wake?.()),
  };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /dry: where the option goes. A fake process records the args and what the SDK writes to its stdin.
// ---------------------------------------------------------------------------------------------

// #region dry
function recordingProcess(stdinLines: string[]): SpawnedProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const p = {
    stdin: new Writable({ write: (c, _e, cb) => (stdinLines.push(...String(c).split("\n").filter(Boolean)), cb()) }),
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

async function whatIsSent(promptSuggestions: boolean | undefined) {
  let args: string[] = [];
  const stdin: string[] = [];
  const options: Options = { model: MODEL, cwd: RUNS, settingSources: [], ...(promptSuggestions !== undefined && { promptSuggestions }) };
  const input = inputQueue(); // streaming input: the SDK sends control_request/initialize first
  const q = query({ prompt: input.stream, options: { ...options, spawnClaudeCodeProcess: (o) => ((args = o.args), recordingProcess(stdin)) } });
  try {
    for await (const _ of q) break;
  } catch {}
  input.close();
  const init = stdin.map((l) => JSON.parse(l)).find((m) => m.type === "control_request" && m.request?.subtype === "initialize");
  return {
    flag: args.filter((a) => /suggest/i.test(a)),
    value: init ? (init.request.promptSuggestions ?? "(not sent)") : "(no initialize seen)",
    initialize: init ? short(JSON.stringify(init.request)).slice(0, 600) : null,
  };
}
// #endregion

concept38.post("/dry", async (_req, res) => {
  const rows = await Promise.all(
    [
      { key: "omitted", shown: "(no promptSuggestions)", value: undefined },
      { key: "true", shown: "promptSuggestions: true", value: true },
      { key: "false", shown: "promptSuggestions: false", value: false },
    ].map(async (r) => ({ key: r.key, shown: r.shown, ...(await whatIsSent(r.value).catch((err) => ({ error: errText(err) }))) })),
  );
  res.json({ rows });
});

// ---------------------------------------------------------------------------------------------
// POST /chat (SSE) + /send + /end: a live session. Each suggestion can be sent as the next message.
// ---------------------------------------------------------------------------------------------

// #region relay
/** Turns each SDK message into a small event for the browser. */
function relay(m: SDKMessage, emit: Emit) {
  if (m.type === "system" && m.subtype === "init") return emit("init", { tools: m.tools, permissionMode: m.permissionMode });
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 800) });
      if (b.type === "tool_use") emit("toolUse", { name: b.name, input: short(JSON.stringify(b.input)).slice(0, 300) });
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content as any[]) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { is_error: !!b.is_error, text: short(text).slice(0, 300) });
    }
    return;
  }
  if (m.type === "result") return emit("result", { subtype: m.subtype, total: m.total_cost_usd, turns: m.num_turns });
  // The message of this concept. It comes after the result: keep reading the stream.
  if (m.type === "prompt_suggestion") return emit("suggestion", { suggestion: m.suggestion });
}
// #endregion

type Chat = { input: ReturnType<typeof inputQueue>; emit: Emit; busy: boolean };
const chats = new Map<string, Chat>();
const CHAT_LIMIT_MS = 15 * 60_000; // a forgotten tab does not keep a session open forever

const ChatBody = z.object({ promptSuggestions: z.boolean(), first: z.string().trim().min(1).max(4000) }).strict();

concept38.post("/chat", async (req, res) => {
  const parsed = ChatBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), end();
  const run = newRun();
  const id = run.id;
  const input = inputQueue();
  const chat: Chat = { input, emit, busy: true };
  chats.set(id, chat);
  const limit = setTimeout(() => abort.abort(), CHAT_LIMIT_MS);
  let dropTimer: NodeJS.Timeout | undefined;
  try {
    // A suggestion call that brings no prompt_suggestion was dropped by Claude Code's filters. The SDK does not say so,
    // so the lab waits 2 s after the call and tells the browser, which would otherwise wait for a chip forever.
    const { url } = await openTap(run, (c) => {
      emit("wire", c);
      if (c.kind === "suggestion" && c.status === "done") dropTimer = setTimeout(() => emit("dropped", { n: c.n, text: c.text ?? "" }), 2000);
    });
    // Tools so that the model has something to do, and the suggestion something to predict ("run it").
    const options = base(run.work, url, abort, {
      promptSuggestions: parsed.data.promptSuggestions,
      tools: ["Read", "Write", "Edit", "Bash"],
      allowedTools: ["Read", "Write", "Edit", "Bash(node:*)", "Bash(ls:*)", "Bash(cat:*)"],
      maxTurns: 12,
    });
    emit("opened", { chat: id, options: { model: options.model, tools: options.tools, allowedTools: options.allowedTools, promptSuggestions: options.promptSuggestions, prompt: "[AsyncIterable<SDKUserMessage>]" } });
    emit("user", { text: parsed.data.first, from: "typed" });
    input.push(parsed.data.first);
    for await (const m of query({ prompt: input.stream, options })) {
      if (m.type === "result") chat.busy = false;
      if (m.type === "prompt_suggestion") clearTimeout(dropTimer);
      relay(m, emit);
    }
  } catch (err) {
    if (!abort.signal.aborted) emit("error", { message: errText(err) });
  } finally {
    clearTimeout(limit);
    clearTimeout(dropTimer);
    chats.delete(id);
    run.done();
    end();
  }
});

const SendBody = z.object({ chat: z.string().regex(/^[0-9a-f]{8}$/), text: z.string().trim().min(1).max(4000), from: z.enum(["typed", "suggestion"]) }).strict();
concept38.post("/send", (req: Request, res: Response) => {
  const parsed = SendBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: badRequest(parsed.error) });
  const c = chats.get(parsed.data.chat);
  if (!c) return res.status(404).json({ error: "No open chat with that id (it already ended)." });
  c.emit("user", { text: parsed.data.text, from: parsed.data.from, queued: c.busy });
  c.busy = true;
  c.input.push(parsed.data.text);
  res.json({ ok: true });
});

concept38.post("/end", (req, res) => {
  const c = chats.get(String(req.body?.chat));
  if (!c) return res.status(404).json({ error: "No open chat with that id (it already ended)." });
  c.input.close(); // closing the input is the normal way to end a streaming session
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// POST /when, /switches, /cache: scripted sessions in parallel, one table row each
// ---------------------------------------------------------------------------------------------

// #region rows
type RowSpec = {
  key: string;
  label: string;
  shown: string;
  /** A string: one prompt, single message mode. An array: streaming input, one turn per item. */
  turns: string | string[];
  /** "wait": the next turn is sent once the suggestion came (or 6 s passed). "now": right after the result. */
  pace?: "wait" | "now";
  options?: (run: Run) => Partial<Options>;
  env?: Record<string, string> | ((run: Run) => Record<string, string>);
  /** Runs before the session, e.g. to make a session to resume. */
  before?: (run: Run, tapUrl: string, abort: AbortController) => Promise<Partial<Options>>;
  note?: (r: RowOut) => string;
};
type TurnOut = { n: number; replies: number; result?: string; total?: number; suggestion: string | null };
type RowOut = { key: string; label: string; shown: string; turns: TurnOut[]; wire: WireCall[]; outcome: string; cost: number; wireCost: number; note?: string };

const SUGGESTION_WAIT_MS = 6000; // the suggestion came about 1 s after the result in every probe

async function runRow(spec: RowSpec, abort: AbortController): Promise<RowOut> {
  const run = newRun();
  const r: RowOut = { key: spec.key, label: spec.label, shown: spec.shown, turns: [], wire: [], outcome: "", cost: 0, wireCost: 0 };
  try {
    const { url, calls } = await openTap(run);
    const extra = spec.before ? await spec.before(run, url, abort) : {};
    calls.length = 0; // the wire of `before` is not part of the row
    const script = typeof spec.turns === "string" ? [spec.turns] : spec.turns;
    const input = inputQueue();
    let next = 1;
    let timer: NodeJS.Timeout | undefined;
    const advance = () => {
      clearTimeout(timer);
      if (next < script.length) {
        r.turns.push({ n: next + 1, replies: 0, suggestion: null });
        input.push(script[next++]);
      } else input.close();
    };
    r.turns.push({ n: 1, replies: 0, suggestion: null });
    input.push(script[0]);
    const ids = new Set<string>();
    const prompt = typeof spec.turns === "string" ? spec.turns : input.stream;
    const env = typeof spec.env === "function" ? spec.env(run) : spec.env;
    const options = base(run.work, url, abort, { ...spec.options?.(run), ...extra }, env);
    for await (const m of query({ prompt, options })) {
      const turn = r.turns.at(-1)!;
      // One API reply can arrive as several assistant messages (one per content block): count the message ids.
      if (m.type === "assistant" && !ids.has(m.message.id)) ids.add(m.message.id), turn.replies++;
      if (m.type === "result") {
        turn.result = m.subtype;
        turn.total = m.total_cost_usd;
        r.cost = m.total_cost_usd;
        if (typeof spec.turns !== "string") (timer = setTimeout(advance, spec.pace === "now" ? 0 : SUGGESTION_WAIT_MS));
      }
      if (m.type === "prompt_suggestion") {
        // It belongs to the last finished turn.
        [...r.turns].reverse().find((t) => t.result)!.suggestion = m.suggestion;
        if (typeof spec.turns !== "string" && spec.pace !== "now") clearTimeout(timer), (timer = setTimeout(advance, 300));
      }
    }
    clearTimeout(timer);
    r.outcome = "the session ended";
    r.wire = calls.map((c) => ({ ...c, instruction: undefined }));
    r.wireCost = calls.reduce((sum, c) => sum + (c.cost ?? 0), 0); // everything that was paid, the last suggestion too
  } catch (err) {
    r.outcome = `query() threw: ${errText(err)}`;
  }
  r.note = spec.note?.(r);
  run.done();
  return r;
}

function rowsRoute(specs: RowSpec[]) {
  return async (req: Request, res: Response) => {
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    try {
      // order: the row's place in the list. The rows finish in any order; the tab sorts them back.
      await Promise.all(specs.map(async (s, order) => send("row", { ...(await runRow(s, abort)), order, at: Date.now() - startedAt })));
    } finally {
      send("done", {});
      res.end();
    }
  };
}
// #endregion

const suggestionCalls = (r: RowOut) => r.wire.filter((c) => c.kind === "suggestion");
const said = (r: RowOut) => suggestionCalls(r).map((c) => JSON.stringify(c.text ?? "")).join(", ");

// #region when
// When is a suggestion emitted? Only the shape of the conversation changes between the rows.
const PT = ["I am learning Portuguese. Tell me the word for 'thank you'. One line.", "And how do I say 'good morning'? One line."];

const WHEN: RowSpec[] = [
  {
    key: "oneReply",
    label: "one prompt, one reply",
    shown: "query({ prompt: 'Tell me …', options: { promptSuggestions: true } })",
    turns: PT[0],
    note: (r) => `${suggestionCalls(r).length ? "A suggestion call was made." : "No suggestion call at all."} The conversation has 1 assistant reply: Claude Code wants at least 2 (early_conversation). This is the "first turn" rule.`,
  },
  {
    key: "withTool",
    label: "one prompt, with a tool call",
    shown: "query({ prompt: 'Create hello.js … with the Write tool', options: { tools: ['Write'], … } })",
    turns: "Create hello.js that prints hello, with the Write tool. Then reply with one line.",
    options: () => ({ tools: ["Write"], allowedTools: ["Write"] }),
    note: (r) => `The same single prompt, but the tool call makes ${r.turns[0]?.replies} assistant replies, so the first turn already gets a suggestion. Single message mode still emits it before the process exits.`,
  },
  {
    key: "twoTurns",
    label: "streaming input, two turns",
    shown: "prompt: AsyncIterable (turn 2 is sent once the suggestion of turn 1 had its chance)",
    turns: PT,
    note: () => "Turn 1: 1 reply, no suggestion. Turn 2: 2 replies in the conversation, so a suggestion.",
  },
  {
    key: "resume",
    label: "one prompt, resuming a session",
    shown: "query({ prompt: 'What colour …?', options: { resume: '<an earlier session>' } })",
    turns: "What colour did I ask you to remember? One word.",
    before: async (run, tapUrl, abort) => {
      let id = "";
      for await (const m of query({ prompt: "Remember the colour teal. Reply OK.", options: base(run.work, tapUrl, abort, { persistSession: true, promptSuggestions: false }) }))
        if (m.type === "result") id = m.session_id;
      return { resume: id, persistSession: true };
    },
    note: (r) => `One reply in THIS query, but the resumed history has another one: ${suggestionCalls(r).length ? `the suggestion call was made (it answered ${said(r)}: its instruction is written for coding sessions)` : "no suggestion call"}.`,
  },
  {
    key: "queued",
    label: "the next message is already waiting",
    shown: "three turns, each pushed right after the previous result",
    turns: [...PT, "And 'good night'? One line."],
    pace: "now",
    note: (r) => {
      const calls = suggestionCalls(r);
      const aborted = calls.filter((c) => c.status !== "done").length;
      return `${calls.length} suggestion call(s) for ${r.turns.length} turns${aborted ? ` (${aborted} aborted)` : ""}. When the next message is already waiting, there is nothing to predict: Claude Code skips the suggestion of that turn. Only the last turn, with nothing queued after it, gets one.`;
    },
  },
  {
    key: "bye",
    label: "a conversation that is over",
    shown: "turn 2: 'Perfect, that is all I needed. Bye!'",
    turns: [PT[0], "Perfect, that is all I needed. Bye!"],
    note: (r) =>
      suggestionCalls(r).length
        ? `The suggestion call was made and answered ${said(r)}. ${r.turns.some((t) => t.suggestion) ? "It passed the filters." : "Claude Code's filters dropped it (Part F), so no prompt_suggestion message came, but the call was paid."}`
        : "No suggestion call.",
  },
  {
    key: "plan",
    label: "plan mode",
    shown: "permissionMode: 'plan'",
    turns: PT,
    options: () => ({ permissionMode: "plan" }),
    note: (r) => `${suggestionCalls(r).length ? "A suggestion call was made." : "No suggestion call at all"}: suggestions are off in plan mode (plan_mode).`,
  },
];
// #endregion

// #region switches
// Who can switch suggestions off? The same two turns; only the switch changes.
const userSettings = (run: Run, settings: object) => {
  // A CLAUDE_CONFIG_DIR of the row's own, with a settings.json in it: the "user" setting source.
  const dir = path.join(run.work, ".config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
};

const SWITCHES: RowSpec[] = [
  { key: "on", label: "the option", shown: "promptSuggestions: true", turns: PT },
  { key: "omitted", label: "no option", shown: "(promptSuggestions not set)", turns: PT, options: () => ({ promptSuggestions: undefined }) },
  { key: "false", label: "the option, false", shown: "promptSuggestions: false", turns: PT, options: () => ({ promptSuggestions: false }) },
  { key: "envFalse", label: "the env var", shown: "promptSuggestions: true + env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false", turns: PT, env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" } },
  { key: "flagSetting", label: "a setting (the flag layer)", shown: "promptSuggestions: true + settings: { promptSuggestionEnabled: false }", turns: PT, options: () => ({ settings: { promptSuggestionEnabled: false } }) },
  {
    key: "userSetting",
    label: "a setting in the user's settings.json",
    shown: "promptSuggestions: true + CLAUDE_CONFIG_DIR/settings.json { promptSuggestionEnabled: false } + settingSources: ['user']",
    turns: PT,
    options: () => ({ settingSources: ["user"] }),
    env: (run) => ({ CLAUDE_CONFIG_DIR: userSettings(run, { promptSuggestionEnabled: false }) }),
  },
  {
    key: "envWins",
    label: "the setting off, the env var on",
    shown: "settings: { promptSuggestionEnabled: false } + env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true",
    turns: PT,
    options: () => ({ settings: { promptSuggestionEnabled: false } }),
    env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" },
    note: () => "The env var wins over the setting.",
  },
];
// #endregion

// #region cache
// "Suggestions piggyback on the parent's prompt cache." The suggestion call sends the same prefix as the turn, so it
// reads what the turn cached. And when the last reply was mostly NOT cached, Claude Code does not make the call.
const filler = (lines: number) => Array.from({ length: lines }, (_, i) => `Note ${i + 1}: the tram to Belém leaves from Praça da Figueira every twelve minutes.`).join("\n");
const TUTOR = "You are a concise Portuguese tutor. Answer in one line.\n\nReference notes (ignore unless asked):\n" + filler(190); // about 5,000 tokens: over Haiku 4.5's minimum cacheable prompt (4,096)

const CACHE: RowSpec[] = [
  {
    key: "small",
    label: "a small conversation",
    shown: "the two turns, the SDK's short default system prompt",
    turns: PT,
    note: () => "Under the model's minimum cacheable size, so nothing is cached at all. The suggestion call pays every input token, but there are few.",
  },
  {
    key: "cached",
    label: "a big, cached system prompt",
    shown: "systemPrompt: '<about 5,000 tokens>'",
    turns: PT,
    options: () => ({ systemPrompt: TUTOR }),
    note: (r) => {
      const s = suggestionCalls(r)[0];
      if (!s?.usage) return "No suggestion call.";
      const all = s.usage.input + s.usage.cacheWrite + s.usage.cacheRead;
      return `The suggestion call read ${s.usage.cacheRead} of its ${all} input tokens from the cache: $${s.cost!.toFixed(5)} instead of about $${((all * PRICE.input + s.usage.output * PRICE.output) / 1e6).toFixed(5)} uncached.`;
    },
  },
  {
    key: "uncached",
    label: "the same, with caching off",
    shown: "systemPrompt: '<about 5,000 tokens>' + a 7,000-token turn 2 + env DISABLE_PROMPT_CACHING=1",
    turns: [PT[0], "Here are more notes, just read them:\n" + filler(260) + "\n\nNow: how do I say 'good morning'? One line."],
    options: () => ({ systemPrompt: TUTOR }),
    env: { DISABLE_PROMPT_CACHING: "1" },
    note: (r) => `The last reply had ${lastMain(r)?.usage?.input ?? "?"} uncached input tokens, over Claude Code's limit of 10,000: ${suggestionCalls(r).length ? "a suggestion call was still made" : "no suggestion call (cache_cold: uncached)"}.`,
  },
  {
    key: "bigWrite",
    label: "a turn that writes a lot to the cache",
    shown: "turn 2 pastes about 12,000 tokens of new text",
    turns: [PT[0], "Here are more notes, just read them:\n" + filler(450) + "\n\nNow: how do I say 'good morning'? One line."],
    note: (r) => `The last reply wrote ${lastMain(r)?.usage?.cacheWrite ?? "?"} tokens to the cache (over 10,000): ${suggestionCalls(r).length ? "a suggestion call was still made" : "no suggestion call (cache_cold: cache_write)"}.`,
  },
];
const lastMain = (r: RowOut) => r.wire.filter((c) => c.kind === "main").at(-1);
// #endregion

concept38.post("/when", rowsRoute(WHEN));
concept38.post("/switches", rowsRoute(SWITCHES));
concept38.post("/cache", rowsRoute(CACHE));

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept38.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
