/**
 * CONCEPT 33 — MCP elicitation: an MCP server asks the USER for input in the middle of a tool call
 *
 * Until now an MCP tool got everything from the model's arguments (Concept 13). With elicitation the SERVER sends an
 * `elicitation/create` request back to its client, Claude Code, which passes it to YOUR host:
 *
 *   Options.onElicitation = async (request, { signal }) => ElicitationResult
 *     request: { serverName, message, mode: "form", requestedSchema }   (or mode "url" + url + elicitationId)
 *     return   { action: "accept", content: { ... } }                   the values the user typed (must match the schema)
 *              { action: "decline" }                                    the user said no
 *              { action: "cancel" }                                     the user dismissed it
 *
 * The model does not see the form or the values: it only sees what the tool puts in its result. So a server can ask for
 * details, or for a confirmation, that the model cannot invent.
 *
 * Who answers, in order (Claude Code 2.1.281): a COMMAND hook on "Elicitation" (settings.hooks) → onElicitation → if
 * neither, the request is declined at once. Then a command hook on "ElicitationResult" may rewrite the answer. SDK callback
 * hooks (Options.hooks) for these two events are called, but their answer is ignored.
 *
 * The external server: mcp-servers/rooms-server.ts (stdio). Its log lines come back through POST /log, and the command
 * hook (elicit-hooks/hook.mjs) reports through POST /hooklog.
 * Routes: POST /who (SSE), POST /run (SSE), POST /respond, POST /log, POST /hooklog, GET+POST /consent/:id,
 * GET /consent/:id/status, GET /code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type ElicitationRequest,
  type ElicitationResult,
  type HookCallback,
  type McpServerConfig,
  type OnElicitation,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept33 = Router();

const MODEL = "claude-haiku-4-5-20251001";
// The rooms server (a child process of Claude Code) posts its log and reads the sign-in page here.
// sample52's server listens on 3052: set LAB_PORT only when mounting this router on another port.
const LAB_URL = `http://localhost:${process.env.LAB_PORT ?? 3052}`;
const ROOMS_SERVER = path.resolve("mcp-servers", "rooms-server.ts");
const HOOK = path.resolve("elicit-hooks", "hook.mjs");

// Each run has its own bookings file in elicit-lab/runs/<run id>. Transcripts go to a fake CLAUDE_CONFIG_DIR.
const LAB = path.resolve("elicit-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [RUNS, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
const escaped = JSON.stringify(LAB).slice(1, -1);
const short = (s: string) => s.replaceAll(LAB, "elicit-lab").replaceAll(escaped, "elicit-lab");

// The rooms server waits this long for an answer (then elicitInput throws "Request timed out" and Claude Code aborts
// onElicitation's signal). The host gives up a little earlier, so the user sees a clean "cancel" instead.
const SERVER_TIMEOUT_MS = 150_000;
const HOST_TIMEOUT_MS = 120_000;

type Emit = (event: string, data: object) => void;
type Booking = { id: string; room: string; date: string; attendees: number; projector: boolean };
type Answer = { id: string; how: string; action: string; content?: Record<string, unknown> };

/** What one run needs: its folder, and every form, answer and server log line so far. */
type Run = {
  id: string;
  work: string;
  roomsFile: string;
  before: Booking[];
  emit: Emit;
  forms: number; // onElicitation calls
  sent: Answer[]; // what the host answered
  received: { action: string; content?: unknown; message?: string }[]; // what the rooms server says it got
  hooks: { kind: string; event: string; answer?: unknown }[];
  toolNames: Map<string, string>;
  toolCalls: string[];
  apiError?: string;
};

const runs = new Map<string, Run>(); // run id → run, so POST /log can find the run of a log line

function newRun(emit: Emit, seed: Booking[] = []): Run {
  for (const d of readdirSync(RUNS)) if (!runs.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  const roomsFile = path.join(work, "rooms.json");
  writeFileSync(roomsFile, JSON.stringify(seed, null, 2));
  const run: Run = { id, work, roomsFile, before: seed, emit, forms: 0, sent: [], received: [], hooks: [], toolNames: new Map(), toolCalls: [] };
  runs.set(id, run);
  return run;
}
const bookings = (run: Run): Booking[] => (existsSync(run.roomsFile) ? JSON.parse(readFileSync(run.roomsFile, "utf8")) : []);

// #region server
// The rooms server is an ordinary stdio MCP server (Concept 13). Nothing in the config turns elicitation on: Claude Code
// declares `capabilities.elicitation` in initialize, and the server's tools call server.elicitInput() when they need to.
function roomsServer(run: Run): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", ROOMS_SERVER],
    env: { LAB_URL, LAB_RUN: run.id, ROOMS_FILE: run.roomsFile, ELICIT_TIMEOUT_MS: String(SERVER_TIMEOUT_MS) },
  };
}
// #endregion

// #region options
function baseOptions(run: Run, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  return {
    model: MODEL,
    cwd: run.work,
    tools: [], // no built-in tools: only the rooms server's tools
    mcpServers: { rooms: roomsServer(run) },
    strictMcpConfig: true,
    allowedTools: ["mcp__rooms__*"], // the tools run without a permission prompt; the SERVER still asks the user
    onElicitation: ask(run), // without it, every elicitation is declined
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 8,
    env,
    ...extra,
  };
}
// #endregion

const optionsForBrowser = (run: Run, o: Options) => ({
  ...o,
  env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'elicit-lab/config' }",
  mcpServers: { rooms: { ...roomsServer(run), command: "node", args: ["--import", "tsx", "mcp-servers/rooms-server.ts"], env: { LAB_URL, LAB_RUN: run.id, ROOMS_FILE: `elicit-lab/runs/${run.id}/rooms.json`, ELICIT_TIMEOUT_MS: String(SERVER_TIMEOUT_MS) } } },
  onElicitation: o.onElicitation && "[Function ask: shows the form in the browser and waits for /respond]",
  hooks: o.hooks && Object.fromEntries(Object.keys(o.hooks).map((k) => [k, [{ matcher: "rooms", hooks: ["[Function observe]"] }]])),
  settings: o.settings && JSON.parse(short(JSON.stringify(o.settings)).replaceAll(JSON.stringify(process.execPath).slice(1, -1), "node")),
  abortController: o.abortController && "[AbortController]",
  cwd: `elicit-lab/runs/${run.id}`,
});

// #region ask
// onElicitation waits here until the browser answers, the host's timeout fires, or the server gives up (signal).
type Pending = { run: Run; request: ElicitationRequest; done: (r: ElicitationResult, how: string) => void };
const pending = new Map<string, Pending>(); // "<run id>:<form id>" → the form waiting for an answer

function ask(run: Run): OnElicitation {
  return (request, { signal }) => {
    const id = String(++run.forms);
    run.emit("form", { run: run.id, id, serverName: request.serverName, message: request.message, mode: request.mode ?? "form", requestedSchema: request.requestedSchema, url: request.url, timeoutMs: HOST_TIMEOUT_MS });
    return new Promise((resolve) => {
      const key = `${run.id}:${id}`;
      const done = (result: ElicitationResult, how: string) => {
        if (!pending.delete(key)) return; // already answered
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        run.sent.push({ id, how, action: result.action, content: result.content as Record<string, unknown> | undefined });
        run.emit("answer", { id, how, result });
        resolve(result);
      };
      // The server timed out (or the run was aborted): Claude Code no longer waits for this answer.
      const onAbort = () => done({ action: "cancel" }, "the server gave up (signal aborted)");
      // Nobody answered in time: cancel, never guess values for the user.
      const timer = setTimeout(() => done({ action: "cancel" }, "host timeout"), HOST_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(key, { run, request, done });
    });
  };
}
// #endregion

// #region respond
// The browser's answer becomes the ElicitationResult. The host checks `content` against requestedSchema first: the MCP
// server validates it again (elicitInput throws -32602 on a mismatch), but a bad answer should be fixed in the form.
function validate(schema: any, content: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const props: Record<string, any> = schema?.properties ?? {};
  for (const k of schema?.required ?? []) if (content[k] === undefined || content[k] === "") errors.push(`${k}: required`);
  for (const [k, v] of Object.entries(content)) {
    const p = props[k];
    if (!p) errors.push(`${k}: not in the schema`);
    else if (p.type === "string") {
      if (typeof v !== "string") errors.push(`${k}: must be text`);
      else {
        if (p.enum && !p.enum.includes(v)) errors.push(`${k}: must be one of ${p.enum.join(", ")}`);
        if (p.minLength !== undefined && v.length < p.minLength) errors.push(`${k}: at least ${p.minLength} characters`);
        if (p.maxLength !== undefined && v.length > p.maxLength) errors.push(`${k}: at most ${p.maxLength} characters`);
        if (p.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`${k}: must be a date, YYYY-MM-DD`);
        if (p.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors.push(`${k}: must be an email address`);
      }
    } else if (p.type === "integer" || p.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${k}: must be a number`);
      else {
        if (p.type === "integer" && !Number.isInteger(v)) errors.push(`${k}: must be a whole number`);
        if (p.minimum !== undefined && v < p.minimum) errors.push(`${k}: at least ${p.minimum}`);
        if (p.maximum !== undefined && v > p.maximum) errors.push(`${k}: at most ${p.maximum}`);
      }
    } else if (p.type === "boolean" && typeof v !== "boolean") errors.push(`${k}: must be true or false`);
  }
  return errors;
}

const RespondBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string().max(50), z.union([z.string().max(500), z.number(), z.boolean()])).optional(), // accept only
    skipCheck: z.boolean().optional(), // accept only: send the content even if it breaks the schema (to see the server refuse it)
  })
  .strict()
  .refine((b) => b.action === "accept" || b.content === undefined, { message: "content is only for 'accept'" })
  .refine((b) => b.action === "accept" || b.skipCheck === undefined, { message: "skipCheck is only for 'accept'" });

concept33.post("/respond", (req, res) => {
  const parsed = RespondBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const b = parsed.data;
  const p = pending.get(`${b.run}:${b.id}`);
  if (!p) return res.status(404).json({ error: "No form waiting with that id (already answered, timed out, or the run ended)." });
  const form = (p.request.mode ?? "form") === "form";
  if (b.action === "accept" && form !== (b.content !== undefined)) return res.status(400).json({ error: form ? "accept needs content for a form" : "a url elicitation takes no content" });
  if (b.action === "accept" && form && !b.skipCheck) {
    const errors = validate(p.request.requestedSchema, b.content!);
    if (errors.length) return res.status(422).json({ error: "The answer does not match requestedSchema.", errors });
  }
  p.done(b.action === "accept" && form ? { action: "accept", content: b.content } : { action: b.action }, b.skipCheck ? "the user (host check skipped)" : "the user");
  res.json({ ok: true });
});
// #endregion

// #region hooks
// A COMMAND hook is a program Claude Code runs; it answers on stdout. This is the only kind whose answer counts for
// Elicitation / ElicitationResult in 2.1.281. `matcher` is compared with the MCP server's name.
const hookCmd = (mode: "autofill" | "policy", run: Run) => `"${process.execPath}" "${HOOK}" ${mode} ${run.id} ${LAB_URL}`;

// An SDK CALLBACK hook for the same events: it is called with the full input, but what it returns is ignored.
function observe(run: Run): HookCallback {
  return async (input) => {
    const i = input as any;
    run.hooks.push({ kind: "callback", event: i.hook_event_name });
    run.emit("callbackHook", { event: i.hook_event_name, server: i.mcp_server_name, mode: i.mode, action: i.action, content: i.content, fields: Object.keys(i.requested_schema?.properties ?? {}) });
    return {};
  };
}
// #endregion

// POST /hooklog: the command hook (elicit-hooks/hook.mjs) says what it saw and answered.
const HookLogBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    mode: z.enum(["autofill", "policy"]),
    event: z.enum(["Elicitation", "ElicitationResult"]),
    server: z.string().max(200).optional(),
    action: z.enum(["accept", "decline", "cancel"]).optional(), // ElicitationResult only
    content: z.record(z.string(), z.unknown()).optional(),
    answer: z.record(z.string(), z.unknown()).nullable(), // the hook's hookSpecificOutput, or null
  })
  .strict();

concept33.post("/hooklog", (req, res) => {
  const parsed = HookLogBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const b = parsed.data;
  const run = runs.get(b.run);
  if (run) {
    run.hooks.push({ kind: "command", event: b.event, answer: b.answer });
    run.emit("commandHook", b);
  }
  res.sendStatus(204);
});

// POST /log: the rooms server's own log lines (it runs in another process). The body is what its log() posts.
const LogBody = z
  .object({
    run: z.string().regex(/^([0-9a-f]{8})?$/), // empty when the server runs without LAB_RUN
    pid: z.number().int().positive(),
    method: z.string().min(1).max(200),
    detail: z.record(z.string(), z.unknown()).optional(), // every detail the server sends is an object
  })
  .strict();

concept33.post("/log", (req, res) => {
  const parsed = LogBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const b = parsed.data;
  const d = b.detail as { message?: string; elicitationId?: string; url?: string } | undefined;
  const run = runs.get(b.run);
  if (run) {
    const m = b.method;
    if (m.startsWith("elicitation result: ")) run.received.push({ action: m.slice(20), content: b.detail });
    if (m === "elicitation error") run.received.push({ action: "error", message: d?.message });
    if (m.includes("url")) for (const id of [d?.elicitationId, String(d?.url ?? "").split("/").pop()]) if (id) consentRun.set(id, run.id);
    run.emit("server", { pid: b.pid, method: m, detail: b.detail });
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------------------------
// The sign-in page of connect_calendar. The password is typed HERE, never in the form, the host or the model.
// ---------------------------------------------------------------------------------------------

const consents = new Map<string, { state: "granted" | "denied"; account?: string }>();
const consentRun = new Map<string, string>(); // elicitation id → run id
const Uuid = z.string().uuid();

concept33.get("/consent/:id/status", (req, res) => {
  if (!Uuid.safeParse(req.params.id).success) return res.status(400).json({ error: "bad id" });
  res.json(consents.get(req.params.id) ?? { state: "pending" });
});

concept33.get("/consent/:id", (req, res) => {
  if (!Uuid.safeParse(req.params.id).success) return res.status(400).send("bad id");
  const c = consents.get(req.params.id);
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lab calendar sign-in</title>
<style>body{font:15px system-ui;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}input,button{font:inherit;padding:8px;margin:4px 0;width:100%;box-sizing:border-box}button{cursor:pointer}.muted{color:#666;font-size:13px}</style>
<h2>Lab calendar</h2>
${c ? `<p>Done: access <b>${c.state}</b>${c.account ? ` for ${c.account.replace(/[<>&"]/g, "")}` : ""}. You can close this tab and go back to the lab.</p>` : `
<p>The <b>rooms</b> MCP server wants to read your free slots.</p>
<form method="post"><input name="account" value="you@lab.example" maxlength="100" aria-label="account"><input name="password" type="password" placeholder="password (not checked, never stored)" aria-label="password">
<button name="decision" value="grant">Allow access</button><button name="decision" value="deny">Deny</button></form>
<p class="muted">This page belongs to the MCP server, not to Claude Code. Neither Claude Code, the host nor the model ever sees what you type here.</p>`}`);
});

concept33.post("/consent/:id", (req, res) => {
  if (!Uuid.safeParse(req.params.id).success) return res.status(400).send("bad id");
  // A form post: parse the urlencoded body by hand (express.json() does not read it).
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const form = new URLSearchParams(raw);
    const state = form.get("decision") === "grant" ? "granted" : "denied";
    const account = (form.get("account") ?? "").slice(0, 100);
    consents.set(req.params.id, { state, account: state === "granted" ? account : undefined });
    runs.get(consentRun.get(req.params.id) ?? "")?.emit("consent", { state, account: state === "granted" ? account : undefined });
    res.redirect(303, req.originalUrl);
  });
});

// #region messages
/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, run: Run, emit: Emit) {
  const m = msg as any;
  if (m.type === "system" && m.subtype === "init")
    return emit("init", { model: m.model, mcp_servers: m.mcp_servers, tools: m.tools.filter((t: string) => t.startsWith("mcp__")) });
  // A URL-mode elicitation is finished (the server sent notifications/elicitation/complete).
  if (m.type === "system" && m.subtype === "elicitation_complete") return emit("elicitationComplete", { server: m.mcp_server_name, elicitation_id: m.elicitation_id });
  if (m.type === "assistant") {
    // When the API fails (no credit, bad key…), Claude Code writes a SYNTHETIC assistant message with `error` (Concept 28).
    if (m.error) {
      run.apiError = m.error;
      return emit("apiError", { error: m.error, text: m.message.content.map((b: any) => b.text ?? "").join("").slice(0, 300) });
    }
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: b.text.slice(0, 700) });
      if (b.type === "tool_use") {
        run.toolNames.set(b.id, b.name);
        run.toolCalls.push(b.name);
        emit("toolUse", { name: b.name, input: JSON.stringify(b.input).slice(0, 300) });
      }
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { name: run.toolNames.get(b.tool_use_id) ?? "?", is_error: !!b.is_error, text: short(text).slice(0, 600) });
    }
    return;
  }
  if (m.type === "result")
    emit("result", { subtype: m.subtype, is_error: m.is_error, apiError: run.apiError, num_turns: m.num_turns, cost: m.total_cost_usd, text: typeof m.result === "string" ? m.result.slice(0, 700) : undefined });
}

async function runOnce(prompt: string, options: Options, run: Run, emit: Emit) {
  try {
    for await (const msg of query({ prompt, options })) relay(msg, run, emit);
  } catch (err) {
    emit("error", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  }
}
// #endregion

// #region check
// Trust what your code saw: what the host answered, what the server says it received, and the bookings file.
function check(run: Run, emit: Emit) {
  const after = bookings(run);
  const key = (b: Booking) => JSON.stringify(b);
  emit("check", {
    apiError: run.apiError,
    toolCalls: run.toolCalls,
    forms: run.forms,
    // The server's view and the host's view, side by side: a command ElicitationResult hook can change one into the other.
    pairs: run.received.map((got, i) => ({ sent: run.sent[i], got })),
    hooks: run.hooks,
    added: after.filter((b) => !run.before.some((x) => key(x) === key(b))),
    removed: run.before.filter((b) => !after.some((x) => key(x) === key(b))),
  });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /run: one scenario
// ---------------------------------------------------------------------------------------------

const SEED: Booking[] = [{ id: "a1b2c3", room: "Roma", date: "2026-10-15", attendees: 4, projector: true }];
const PROMPTS: Record<string, string> = {
  book: "Book a meeting room for the sprint review with the book_room tool (it asks me for the details itself). Then tell me what was booked.",
  cancel: "Cancel booking a1b2c3 with the cancel_booking tool, then list the bookings.",
  calendar: "Connect my calendar with the connect_calendar tool, then tell me whether it worked.",
  policy: "Book a meeting room for the all-hands with the book_room tool (it asks me for the details itself). Then tell me what was booked.",
};

const Scenario = z.enum(["book", "cancel", "calendar", "policy", "custom"]);
const RunBody = z
  .object({ scenario: Scenario, prompt: z.string().trim().min(1).max(2000).optional() })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" });

concept33.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }), end();
  const b = parsed.data;
  const run = newRun(emit, b.scenario === "cancel" || b.scenario === "custom" ? SEED : []);
  try {
    const prompt = b.scenario === "custom" ? b.prompt! : PROMPTS[b.scenario];
    const extra: Partial<Options> = { abortController: abort };
    if (b.scenario === "policy") {
      // The command hook enforces the policy; the callback hooks only watch.
      extra.settings = { hooks: { ElicitationResult: [{ matcher: "rooms", hooks: [{ type: "command", command: hookCmd("policy", run) }] }] } } as Options["settings"];
      extra.hooks = { Elicitation: [{ matcher: "rooms", hooks: [observe(run)] }], ElicitationResult: [{ matcher: "rooms", hooks: [observe(run)] }] };
    }
    const options = baseOptions(run, extra);
    emit("opened", { prompt, options: optionsForBrowser(run, options), bookings: run.before });
    await runOnce(prompt, options, run, emit);
    check(run, emit);
  } finally {
    for (const p of pending.values()) if (p.run === run) p.done({ action: "cancel" }, "the run ended");
    runs.delete(run.id);
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /who: who answers the form? The same book_room call in five setups, in parallel.
// ---------------------------------------------------------------------------------------------

const AUTO: ElicitationResult = { action: "accept", content: { room: "Roma", date: "2026-11-01", attendees: 4 } };
const SETUPS: { key: string; label: string; shown: string }[] = [
  { key: "none", label: "no onElicitation", shown: "—" },
  { key: "handler", label: "onElicitation", shown: "onElicitation: async () => ({ action: 'accept', content: { room: 'Roma', … } })" },
  { key: "callback", label: "SDK callback hook", shown: "hooks: { Elicitation: [{ hooks: [async () => ({ hookSpecificOutput: { action: 'accept', … } })] }] }" },
  { key: "command", label: "command hook", shown: "settings.hooks.Elicitation: [{ matcher: 'rooms', hooks: [{ type: 'command', command: 'node hook.mjs autofill' }] }] + onElicitation (declines)" },
  { key: "inproc", label: "in-process sdk server", shown: "mcpServers: { rooms: createSdkMcpServer(…) } whose tool calls elicitInput() + onElicitation" },
];

/** The same book_room tool as a type "sdk" server, inside this Node process (Concept 5). */
function inProcessRooms(row: Record<string, unknown>) {
  const srv: any = createSdkMcpServer({
    name: "rooms",
    version: "1.0.0",
    tools: [
      tool("book_room", "Book a meeting room. The tool asks the user for the details itself.", {}, async () => {
        try {
          const r = await srv.instance.server.elicitInput({ mode: "form", message: "Book a room", requestedSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] } });
          row.serverGot = r.action;
          return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
        } catch (err) {
          row.serverGot = "error";
          row.serverError = String((err as Error)?.message ?? err);
          return { content: [{ type: "text" as const, text: `Could not ask the user: ${row.serverError}` }], isError: true };
        }
      }),
    ],
  });
  return srv as McpServerConfig;
}

concept33.post("/who", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const quiet: Emit = () => {};
  const mine: Run[] = [];
  try {
    await Promise.all(
      SETUPS.map(async (s) => {
        const run = newRun(quiet);
        mine.push(run);
        const row: Record<string, unknown> = { label: s.label, shown: s.shown, handlerCalled: false, callbackCalled: false };
        const spy = (answer: ElicitationResult): OnElicitation => async () => ((row.handlerCalled = true), answer);
        const extra: Partial<Options> = { abortController: abort, maxTurns: 3, onElicitation: undefined };
        if (s.key === "handler" || s.key === "inproc") extra.onElicitation = spy(AUTO);
        if (s.key === "command") {
          extra.onElicitation = spy({ action: "decline" }); // if it were called, the server would get "decline"
          extra.settings = { hooks: { Elicitation: [{ matcher: "rooms", hooks: [{ type: "command", command: hookCmd("autofill", run) }] }] } } as Options["settings"];
        }
        if (s.key === "callback")
          extra.hooks = {
            Elicitation: [{ matcher: "rooms", hooks: [async () => ((row.callbackCalled = true), { hookSpecificOutput: { hookEventName: "Elicitation" as const, action: "accept" as const, content: AUTO.content } })] }],
          };
        if (s.key === "inproc") extra.mcpServers = { rooms: inProcessRooms(row) };
        try {
          const options = baseOptions(run, extra);
          for await (const m of query({ prompt: "Call the book_room tool once with no arguments, then reply DONE.", options }) as AsyncIterable<any>) {
            if (m.type === "assistant" && m.error) row.error = m.error;
            if (m.type === "result") row.cost = m.total_cost_usd;
          }
        } catch (err) {
          row.error = String((err as Error)?.message ?? err).slice(0, 200);
        }
        if (s.key !== "inproc") {
          const got = run.received[0];
          row.serverGot = got?.action;
          row.serverError = got?.message;
        }
        row.commandHook = run.hooks.some((h) => h.kind === "command");
        row.booked = bookings(run)[0];
        send("whoRow", { ...row, at: Date.now() - startedAt });
      }),
    );
  } finally {
    for (const r of mine) runs.delete(r.id);
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// GET /code: this file's #regions, plus the rooms server's (form, confirm, url)
// ---------------------------------------------------------------------------------------------

const regions = (file: string, prefix = "") =>
  [...readFileSync(file, "utf8").replaceAll("\r\n", "\n").matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [prefix + name, c.trimEnd()]);

concept33.get("/code", (_req, res) => {
  res.json(Object.fromEntries([...regions(fileURLToPath(import.meta.url)), ...regions(ROOMS_SERVER, "rooms: ")]));
});
