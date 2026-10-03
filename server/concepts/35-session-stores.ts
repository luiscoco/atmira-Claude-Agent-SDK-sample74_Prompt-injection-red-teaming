/**
 * CONCEPT 35 — Session stores: keep the transcripts in YOUR storage, and resume them on another machine
 *
 * Without a store, a session lives in one file: CLAUDE_CONFIG_DIR/projects/<project key>/<session id>.jsonl, on the
 * machine that ran it. A second server (another container, another laptop) cannot resume it. With a store:
 *
 *   options.sessionStore = { append, load, listSessions?, listSessionSummaries?, delete?, listSubkeys? }
 *
 *   append(key, entries)   Claude Code still writes the local file; the SDK sends a COPY of each batch of lines to your
 *                          store ("mirroring"). Batched (default: at the end of each turn) or eager (every line).
 *                          If append() rejects 3 times, the batch is dropped and a system/mirror_error message comes.
 *   load(key)              resume: the SDK calls it BEFORE starting Claude Code, writes the lines into a temporary
 *                          CLAUDE_CONFIG_DIR (claude-resume-…), and starts Claude Code there. Deleted at the end.
 *   listSessions(pk)       continue: true, and listSessions({ sessionStore })
 *   listSubkeys(key)       subagent transcripts (key.subpath = "subagents/agent-<id>") are loaded back too
 *
 * The key is { projectKey, sessionId, subpath? }. projectKey is the cwd with every non-alphanumeric character as "-"
 * (the same name as the local folder), or CLAUDE_CODE_PROJECT_DIR_NAME from options.env (a tenant id).
 * The session functions of Concept 19 take { sessionStore } too: listSessions, getSessionInfo, getSessionMessages,
 * renameSession, tagSession, forkSession, deleteSession, listSubagents; importSessionToStore copies a local session in.
 *
 * The lab: two fake machines (two CLAUDE_CONFIG_DIRs, the same cwd) and one store, a folder of JSONL files.
 * Routes: GET /db, GET /entries, POST /reset, POST /run (SSE), POST /manage, POST /failures (SSE), GET /code.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import {
  deleteSession,
  foldSessionSummary,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  importSessionToStore,
  listSessions,
  listSubagents,
  query,
  renameSession,
  tagSession,
  type Options,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept35 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("store-lab");
const DB = path.join(LAB, "db"); // the lab's "database": one JSONL file per key
const FAIL = path.join(LAB, "fail"); // one small store per failure row
const WORK = path.join(LAB, "work"); // the cwd, the same on both machines, so the project key is the same
const MACHINE = { a: path.join(LAB, "machine-a"), b: path.join(LAB, "machine-b") } as const; // two CLAUDE_CONFIG_DIRs
type Machine = keyof typeof MACHINE;

function resetLab() {
  // Best effort: on Windows a Claude Code process that just closed can still hold a file (EPERM).
  for (const d of [DB, FAIL, MACHINE.a, MACHINE.b]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  for (const d of [DB, FAIL, WORK, MACHINE.a, MACHINE.b]) mkdirSync(d, { recursive: true });
}
resetLab();

const TMP = os.tmpdir();
const escaped = (p: string) => JSON.stringify(p).slice(1, -1); // a path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) =>
  s
    .replaceAll(LAB, "store-lab")
    .replaceAll(escaped(LAB), "store-lab")
    .replaceAll(TMP, "%TEMP%")
    .replaceAll(escaped(TMP), "%TEMP%");
const rel = (f: string) => short(f).replaceAll("\\", "/");

type Emit = (event: string, data: object) => void;

// #region adapter
// A SessionStore on plain files: <root>/<projectKey>/<sessionId>.jsonl for the main transcript,
// <root>/<projectKey>/<sessionId>/<subpath>.jsonl for a subagent, and <sessionId>.summary.json next to it.
// Swap the file calls for Postgres, S3, Redis…: the contract is the same.
class FileSessionStore implements SessionStore {
  constructor(readonly root: string) {}

  private file(key: SessionKey) {
    // Keys come from the SDK, but a store must never let one leave its folder.
    const parts = [key.projectKey, key.sessionId, ...(key.subpath ? key.subpath.split("/") : [])];
    if (parts.some((p) => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) throw new Error(`unsafe key ${JSON.stringify(key)}`);
    const [pk, id, ...sub] = parts;
    return sub.length ? path.join(this.root, pk, id, ...sub) + ".jsonl" : path.join(this.root, pk, `${id}.jsonl`);
  }

  private read(file: string): SessionStoreEntry[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    const file = this.file(key);
    mkdirSync(path.dirname(file), { recursive: true });
    // uuid is the idempotency key: a retried batch or a second importSessionToStore() adds nothing twice.
    // Lines without a uuid (titles, tags, cost-state…) are appended as they come.
    const seen = new Set(this.read(file).map((e) => e.uuid).filter(Boolean));
    const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
    appendFileSync(file, fresh.map((e) => JSON.stringify(e) + "\n").join(""));
    if (!key.subpath) {
      // The summary sidecar makes listSessions() one read per session instead of a full load(). The SDK computes it
      // (foldSessionSummary is pure); the store only keeps it. mtime must use the same clock as listSessions().
      const side = file.replace(/\.jsonl$/, ".summary.json");
      const prev: SessionSummaryEntry | undefined = existsSync(side) ? JSON.parse(readFileSync(side, "utf8")) : undefined;
      writeFileSync(side, JSON.stringify(foldSessionSummary(prev, key, fresh, { mtime: Math.floor(statSync(file).mtimeMs) })));
    }
  }

  async load(key: SessionKey) {
    const file = this.file(key);
    return existsSync(file) ? this.read(file) : null; // null = never written
  }

  async listSessions(projectKey: string) {
    const dir = path.join(this.root, projectKey);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ sessionId: f.slice(0, -6), mtime: Math.floor(statSync(path.join(dir, f)).mtimeMs) }));
  }

  async listSessionSummaries(projectKey: string) {
    const dir = path.join(this.root, projectKey);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".summary.json"))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SessionSummaryEntry);
  }

  async delete(key: SessionKey) {
    const file = this.file(key);
    rmSync(file, { force: true });
    if (!key.subpath) {
      rmSync(file.replace(/\.jsonl$/, ".summary.json"), { force: true });
      rmSync(file.replace(/\.jsonl$/, ""), { recursive: true, force: true }); // its subagents
    }
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }) {
    const dir = path.join(this.root, key.projectKey, key.sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6).replaceAll("\\", "/")); // "subagents/agent-<id>"
  }
}
// #endregion

const db = new FileSessionStore(DB);

// #region spy
// Wraps a store and reports every call to the browser, so you see WHEN the SDK calls it and with what.
// It can also break the store: append rejects, load is slow, or listSessions is missing.
type Fault = { appendRejects?: boolean; loadDelayMs?: number; noListSessions?: boolean };
type StoreCall = { method: string; key?: { projectKey?: string; sessionId?: string; subpath?: string }; count?: number; types?: string[]; result?: unknown; error?: string; ms: number };

const typeCounts = (entries: SessionStoreEntry[]) => {
  const c: Record<string, number> = {};
  for (const e of entries) c[e.type] = (c[e.type] ?? 0) + 1;
  return Object.entries(c).map(([t, n]) => (n > 1 ? `${t}×${n}` : t));
};

function spy(inner: FileSessionStore, emit: (c: StoreCall) => void, fault: Fault = {}): SessionStore {
  async function call<T>(method: string, info: Omit<StoreCall, "method" | "ms">, fn: () => Promise<T>, summarize: (r: T) => unknown = () => undefined) {
    const t = Date.now();
    try {
      const r = await fn();
      emit({ method, ...info, result: summarize(r), ms: Date.now() - t });
      return r;
    } catch (err) {
      emit({ method, ...info, error: String((err as Error)?.message ?? err), ms: Date.now() - t });
      throw err;
    }
  }
  const s: SessionStore = {
    append: (key, entries) =>
      call("append", { key, count: entries.length, types: typeCounts(entries) }, async () => {
        if (fault.appendRejects) throw new Error("the database is down");
        return inner.append(key, entries);
      }),
    load: (key) =>
      call("load", { key }, async () => {
        if (fault.loadDelayMs) await new Promise((r) => setTimeout(r, fault.loadDelayMs));
        return inner.load(key);
      }, (r) => (r ? `${r.length} lines` : null)),
    listSessionSummaries: (pk) => call("listSessionSummaries", { key: { projectKey: pk } }, () => inner.listSessionSummaries(pk), (r) => `${r.length} summaries`),
    delete: (key) => call("delete", { key }, () => inner.delete(key)),
    listSubkeys: (key) => call("listSubkeys", { key }, () => inner.listSubkeys(key), (r) => r),
  };
  if (!fault.noListSessions) s.listSessions = (pk) => call("listSessions", { key: { projectKey: pk } }, () => inner.listSessions(pk), (r) => r.map((x) => x.sessionId.slice(0, 8)));
  return s;
}
// #endregion

// #region options
type Setup = { machine: Machine; store?: SessionStore; flush?: Options["sessionStoreFlush"]; resume?: string; continue?: boolean; subagent?: boolean; tenant?: string; extra?: Partial<Options> };

function baseOptions(s: Setup, abort: AbortController): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = MACHINE[s.machine]; // "which machine": where Claude Code writes its local transcript
  if (s.tenant) env.CLAUDE_CODE_PROJECT_DIR_NAME = s.tenant; // the projectKey, instead of the cwd's name
  return {
    model: MODEL,
    cwd: WORK,
    ...(s.store && { sessionStore: s.store }), // mirror every transcript line to the store
    ...(s.store && s.flush && { sessionStoreFlush: s.flush }), // "batched" (default) or "eager"
    ...(s.resume && { resume: s.resume }), // with a store: load() it first, from any machine
    ...(s.continue && { continue: true }), // with a store: the newest session of store.listSessions()
    tools: s.subagent ? ["Agent"] : [],
    ...(s.subagent && { allowedTools: ["Agent"] }),
    settingSources: [],
    thinking: { type: "disabled" }, // fewer lines in the transcript
    maxTurns: s.subagent ? 4 : 1,
    abortController: abort,
    env,
    ...s.extra,
  };
}
// #endregion

const optionsForBrowser = (o: Options) => ({
  ...o,
  sessionStore: o.sessionStore && "new FileSessionStore('store-lab/db') (wrapped by spy())",
  env: `{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: '${rel(String(o.env?.CLAUDE_CONFIG_DIR))}'${o.env?.CLAUDE_CODE_PROJECT_DIR_NAME ? `, CLAUDE_CODE_PROJECT_DIR_NAME: '${o.env.CLAUDE_CODE_PROJECT_DIR_NAME}'` : ""} }`,
  abortController: "[AbortController]",
  cwd: "store-lab/work",
});

/** Files under a folder, relative to it, "/" separated. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .map((f) => f.replaceAll("\\", "/"));
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionStoreEntry) : []);

// #region check
// The host's check: are all the transcript's messages in the store? It compares the uuids of the local file (or of
// the temporary one of a resume) with the store, at the moment the turn's result arrives (the SDK flushes the batch
// just before it passes the result on). A dropped batch (mirror_error) shows here as missing lines.
function mirrorCheck(localFile: string, store: FileSessionStore, key: SessionKey) {
  const uuids = (es: SessionStoreEntry[]) => new Set(es.map((e) => e.uuid).filter(Boolean) as string[]);
  const local = lines(localFile);
  const stored = existsSync(path.join(store.root, key.projectKey)) ? lines(path.join(store.root, key.projectKey, `${key.sessionId}.jsonl`)) : [];
  const have = uuids(stored);
  const missing = local.filter((e) => e.uuid && !have.has(e.uuid));
  return {
    localFile: rel(localFile),
    localLines: local.length,
    localWithUuid: uuids(local).size,
    storedLines: stored.length,
    missing: missing.length,
    missingTypes: typeCounts(missing),
    ok: local.length > 0 && missing.length === 0,
  };
}
// #endregion

// #region messages
type Outcome = { sessionId?: string; text: string; cost: number; result?: string; isError?: boolean; mirrorErrors: number; error?: string; check?: ReturnType<typeof mirrorCheck>; materialized?: { dir: string; files: string[] } };

/**
 * Runs one query() to the end. Sends a short line per message, and at the result (the batch is already in the
 * store) runs the host's check. On a store-backed resume, it also looks for the temporary CLAUDE_CONFIG_DIR.
 */
async function collect(prompt: string, options: Options, send: Emit, store: FileSessionStore | null, keyOf: () => SessionKey | undefined): Promise<Outcome> {
  const o: Outcome = { text: "", cost: 0, mirrorErrors: 0 };
  const startedAt = Date.now();
  let tempDir: string | undefined;
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "system" && m.subtype === "init") {
        o.sessionId = m.session_id;
        send("msg", { kind: "system/init", detail: `session_id ${m.session_id}` });
        if (options.sessionStore && (options.resume || options.continue)) {
          // The SDK loaded the session from the store and started Claude Code in a claude-resume-* folder.
          const found = readdirSync(TMP)
            .filter((d) => d.startsWith("claude-resume-") && statSync(path.join(TMP, d)).mtimeMs >= startedAt - 1000)
            .map((d) => path.join(TMP, d))
            .find((d) => files(d).some((f) => f.endsWith(`${m.session_id}.jsonl`)));
          if (found) {
            tempDir = found;
            o.materialized = { dir: rel(found), files: files(found) };
            send("materialized", o.materialized);
          }
        }
      } else if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "text") (o.text += (o.text ? "\n" : "") + b.text), send("msg", { kind: "assistant", detail: b.text.slice(0, 300) });
          if (b.type === "tool_use") send("msg", { kind: "assistant", detail: `tool_use ${b.name}` });
        }
      } else if (m.type === "system" && m.subtype === "mirror_error") {
        // append() failed 3 times: the batch is gone from the store, the session goes on.
        o.mirrorErrors++;
        send("msg", { kind: "system/mirror_error", detail: `${m.error} · ${m.key.subpath ?? "main transcript"}`, bad: true });
      } else if (m.type === "result") {
        o.cost += m.total_cost_usd;
        o.isError = m.is_error;
        o.result = m.subtype === "success" ? m.result.slice(0, 300) : m.subtype;
        send("msg", { kind: `result/${m.subtype}`, detail: `${o.result} · $${m.total_cost_usd.toFixed(4)}`, bad: m.is_error });
        const key = keyOf();
        if (store && key && o.sessionId) {
          const local = path.join(tempDir ?? String(options.env?.CLAUDE_CONFIG_DIR), "projects", key.projectKey, `${o.sessionId}.jsonl`);
          o.check = mirrorCheck(local, store, { ...key, sessionId: o.sessionId });
          send("check", o.check);
        }
      }
    }
  } catch (err) {
    o.error = short(String((err as Error)?.message ?? err)).slice(0, 400);
    send("msg", { kind: "error (query threw)", detail: o.error, bad: true });
  }
  return o;
}
// #endregion

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const SessionId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a session id (uuid)");
const Tenant = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "1–64 letters, digits, - or _ (the rule Claude Code applies)");
const cwdKey = WORK.replace(/[^a-zA-Z0-9]/g, "-"); // the default projectKey (the path is shorter than 200 characters)

// ---------------------------------------------------------------------------------------------
// GET /db, GET /entries: what the store and the two machines hold
// ---------------------------------------------------------------------------------------------

function snapshot() {
  const sessions: object[] = [];
  for (const pk of existsSync(DB) ? readdirSync(DB) : []) {
    for (const f of readdirSync(path.join(DB, pk)).filter((f) => f.endsWith(".jsonl"))) {
      const sessionId = f.slice(0, -6);
      const es = lines(path.join(DB, pk, f));
      const title = [...es].reverse().find((e) => e.type === "custom-title" || e.type === "ai-title") as any;
      const sub = path.join(DB, pk, sessionId);
      sessions.push({
        projectKey: pk,
        defaultKey: pk === cwdKey,
        sessionId,
        title: title?.customTitle ?? title?.aiTitle ?? null,
        lines: es.length,
        types: typeCounts(es),
        subkeys: files(sub).filter((s) => s.endsWith(".jsonl")).map((s) => ({ subpath: s.slice(0, -6), lines: lines(path.join(sub, s)).length })),
        mtime: Math.floor(statSync(path.join(DB, pk, f)).mtimeMs),
      });
    }
  }
  sessions.sort((a: any, b: any) => b.mtime - a.mtime);
  return { cwdKey, sessions, machines: { a: files(MACHINE.a).filter((f) => f.startsWith("projects/")), b: files(MACHINE.b).filter((f) => f.startsWith("projects/")) } };
}

concept35.get("/db", (_req, res) => res.json(snapshot()));

const EntriesQuery = z.object({ projectKey: Tenant.or(z.literal(cwdKey)), sessionId: SessionId, subpath: z.string().regex(/^subagents\/agent-[\w-]+$/).optional() }).strict();
concept35.get("/entries", (req, res) => {
  const q = EntriesQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: badRequest(q.error) });
  db.load(q.data)
    .then((es) => res.json({ entries: (es ?? []).map((e) => short(JSON.stringify(e)).slice(0, 600)) }))
    .catch((err) => res.status(400).json({ error: String(err) }));
});

concept35.post("/reset", (_req, res) => (resetLab(), res.json(snapshot())));

// ---------------------------------------------------------------------------------------------
// POST /run: one query() on machine A or B, with or without the store
// ---------------------------------------------------------------------------------------------

const RunBody = z
  .object({
    machine: z.enum(["a", "b"]),
    prompt: z.string().trim().min(1).max(2000),
    store: z.boolean(),
    flush: z.enum(["batched", "eager"]).optional(),
    resume: SessionId.optional(),
    continue: z.boolean().optional(),
    subagent: z.boolean().optional(),
    tenant: Tenant.optional(),
  })
  .strict()
  .refine((b) => !(b.resume && b.continue), { message: "resume or continue, not both" })
  .refine((b) => b.store || !b.flush, { message: "flush needs the store" });

concept35.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send: raw } = openSse(req, res);
  const startedAt = Date.now();
  const send: Emit = (e, d) => raw(e, { ...d, at: Date.now() - startedAt });
  const end = () => (raw("done", { db: snapshot() }), res.end());
  if (!parsed.success) return raw("error", { message: badRequest(parsed.error) }), end();
  const b = parsed.data;
  let lastKey: SessionKey | undefined;
  const store = b.store
    ? spy(db, (c) => {
        if (c.key?.sessionId && c.key.projectKey) lastKey = { projectKey: c.key.projectKey, sessionId: c.key.sessionId };
        send("store", c);
      })
    : undefined;
  const options = baseOptions({ machine: b.machine, store, flush: b.flush, resume: b.resume, continue: b.continue, subagent: b.subagent, tenant: b.tenant }, abort);
  send("opened", { prompt: b.prompt, options: optionsForBrowser(options) });
  const o = await collect(b.prompt, options, send, b.store ? db : null, () => lastKey ?? { projectKey: b.tenant ?? cwdKey, sessionId: "" });
  // After the session: what machine's own CLAUDE_CONFIG_DIR holds (a store-backed resume writes nothing there).
  send("outcome", { ...o, machine: b.machine, machineFiles: files(MACHINE[b.machine]).filter((f) => f.startsWith("projects/")) });
  // With a tenant key, the SDK functions that only take { dir } look under the cwd's key: they miss the session.
  if (b.tenant && store && o.sessionId && !b.resume) {
    const viaDir = await listSessions({ dir: WORK, sessionStore: store });
    const viaKey = await db.listSessions(b.tenant);
    send("tenant", { viaDir: viaDir.map((s) => s.sessionId), viaKey: viaKey.map((s) => s.sessionId), tenant: b.tenant });
  }
  end();
});

// ---------------------------------------------------------------------------------------------
// POST /manage: the session functions, reading and writing the store instead of the local files
// ---------------------------------------------------------------------------------------------

// #region import
// importSessionToStore() reads the local file from the CLAUDE_CONFIG_DIR of THIS process (there is no env option).
// The lab's local sessions are in store-lab/machine-a, so the host points process.env at it for the call, one call
// at a time.
let envLock: Promise<unknown> = Promise.resolve();
function withConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = envLock.then(async () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
  envLock = run.catch(() => {});
  return run;
}
// #endregion

const ManageBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("listSessions") }).strict(),
  z.object({ action: z.literal("getSessionInfo"), sessionId: SessionId }).strict(),
  z.object({ action: z.literal("getSessionMessages"), sessionId: SessionId }).strict(),
  z.object({ action: z.literal("listSubagents"), sessionId: SessionId }).strict(),
  z.object({ action: z.literal("renameSession"), sessionId: SessionId, title: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("tagSession"), sessionId: SessionId, tag: z.string().trim().min(1).max(40).nullable() }).strict(),
  z.object({ action: z.literal("forkSession"), sessionId: SessionId }).strict(),
  z.object({ action: z.literal("deleteSession"), sessionId: SessionId }).strict(),
  z.object({ action: z.literal("importSessionToStore"), sessionId: SessionId }).strict(),
]);

// #region manage
// Every function takes { dir, sessionStore }: dir gives the projectKey (the cwd's name), the store replaces the files.
async function manage(b: z.infer<typeof ManageBody>, store: SessionStore): Promise<unknown> {
  const o = { dir: WORK, sessionStore: store };
  switch (b.action) {
    case "listSessions":
      return (await listSessions(o)).map((s) => ({ sessionId: s.sessionId, summary: s.summary, tag: s.tag, lastModified: s.lastModified, firstPrompt: s.firstPrompt }));
    case "getSessionInfo":
      return (await getSessionInfo(b.sessionId, o)) ?? "undefined (not in the store)";
    case "getSessionMessages":
      return (await getSessionMessages(b.sessionId, o)).map((m) => {
        const c = (m.message as any)?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? `[${x.type}]`).join(" ") : "";
        return `${m.type}: ${text.slice(0, 160)}`;
      });
    case "listSubagents":
      return await listSubagents(b.sessionId, o);
    case "renameSession":
      return await renameSession(b.sessionId, b.title, o); // appends a "custom-title" line
    case "tagSession":
      return await tagSession(b.sessionId, b.tag, o); // appends a "tag" line
    case "forkSession":
      return await forkSession(b.sessionId, o); // load() the source, append() a copy with new uuids
    case "deleteSession":
      return await deleteSession(b.sessionId, o); // store.delete(); a no-op if the store has no delete()
    case "importSessionToStore":
      // A session that only exists on machine A's disk → the store. Safe to repeat: the store dedups by uuid.
      return await withConfigDir(MACHINE.a, () => importSessionToStore(b.sessionId, store, { dir: WORK }));
  }
}
// #endregion

concept35.post("/manage", async (req, res) => {
  const parsed = ManageBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: badRequest(parsed.error) });
  const calls: StoreCall[] = [];
  const store = spy(db, (c) => calls.push(c));
  try {
    const result = await manage(parsed.data, store);
    res.json({ result: result === undefined ? "(returns nothing)" : result, calls, db: snapshot() });
  } catch (err) {
    res.json({ error: short(String((err as Error)?.message ?? err)), calls, db: snapshot() });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /failures: what happens when the store fails, or the options do not fit it. 6 rows in parallel.
// ---------------------------------------------------------------------------------------------

type Row = { key: string; label: string; shown: string; run: (store: (f?: Fault) => SessionStore, fs: FileSessionStore, abort: AbortController) => Promise<object> };

const FAILS: Row[] = [
  {
    key: "append",
    label: "append() rejects",
    shown: "append: () => Promise.reject(new Error('the database is down'))",
    run: async (store, fs, abort) => {
      let key: SessionKey | undefined;
      const s = store({ appendRejects: true });
      const o = await collect("Reply only OK.", baseOptions({ machine: "a", store: s }, abort), () => {}, fs, () => key ?? { projectKey: cwdKey, sessionId: "" });
      // The repair: the local file is complete, so copy it in again once the store is back.
      const before = o.check;
      if (o.sessionId) await withConfigDir(MACHINE.a, () => importSessionToStore(o.sessionId!, fs, { dir: WORK }));
      const after = o.sessionId ? mirrorCheck(path.join(MACHINE.a, "projects", cwdKey, `${o.sessionId}.jsonl`), fs, { projectKey: cwdKey, sessionId: o.sessionId }) : undefined;
      return { outcome: `result: ${o.isError ? "error" : "success"} · ${o.mirrorErrors} × system/mirror_error`, check: before, repaired: after, cost: o.cost };
    },
  },
  {
    key: "slow",
    label: "load() is slow",
    shown: "resume + loadTimeoutMs: 1000, load() takes 3 s",
    run: async (store, fs, abort) => {
      const first = await collect("Remember the number 42. Reply only OK.", baseOptions({ machine: "a", store: store() }, abort), () => {}, null, () => undefined);
      if (!first.sessionId) return { outcome: first.error ?? "no session", cost: first.cost };
      const t = Date.now();
      const o = await collect("Which number?", baseOptions({ machine: "b", store: store({ loadDelayMs: 3000 }), resume: first.sessionId, extra: { loadTimeoutMs: 1000 } }, abort), () => {}, null, () => undefined);
      const gaveUp = Date.now() - t;
      // The SDK stops waiting, but it cannot cancel your load(): it is still running. Wait for it, to show it.
      await new Promise((r) => setTimeout(r, Math.max(0, 3200 - gaveUp)));
      return { outcome: o.error ? `query() threw after ${(gaveUp / 1000).toFixed(1)} s: ${o.error}` : `answered: ${o.text}`, note: "load() itself finished later: the SDK cannot cancel it", cost: first.cost + o.cost };
    },
  },
  {
    key: "unknown",
    label: "a session the store does not have",
    shown: "resume: '<a random uuid>'",
    run: async (store, _fs, abort) => {
      const o = await collect("Hello", baseOptions({ machine: "b", store: store(), resume: "00000000-0000-4000-8000-000000000000" }, abort), () => {}, null, () => undefined);
      return { outcome: o.error ? `query() threw: ${o.error}` : `result: ${o.result}`, cost: o.cost };
    },
  },
  {
    key: "nopersist",
    label: "persistSession: false",
    shown: "sessionStore + persistSession: false",
    run: async (store, _fs, abort) => {
      const o = await collect("Reply only OK.", baseOptions({ machine: "a", store: store(), extra: { persistSession: false } }, abort), () => {}, null, () => undefined);
      return { outcome: o.error ? `query() threw: ${o.error}` : `result: ${o.result}`, cost: o.cost };
    },
  },
  {
    key: "checkpoint",
    label: "enableFileCheckpointing",
    shown: "sessionStore + enableFileCheckpointing: true",
    run: async (store, _fs, abort) => {
      const o = await collect("Reply only OK.", baseOptions({ machine: "a", store: store(), extra: { enableFileCheckpointing: true } }, abort), () => {}, null, () => undefined);
      return { outcome: o.error ? `query() threw: ${o.error}` : `result: ${o.result}`, cost: o.cost };
    },
  },
  {
    key: "continue",
    label: "continue without listSessions()",
    shown: "continue: true, a store with no listSessions",
    run: async (store, _fs, abort) => {
      const o = await collect("Hello", baseOptions({ machine: "b", store: store({ noListSessions: true }), continue: true }, abort), () => {}, null, () => undefined);
      return { outcome: o.error ? `query() threw: ${o.error}` : `result: ${o.result}`, cost: o.cost };
    },
  },
];

concept35.post("/failures", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  try {
    await Promise.all(
      FAILS.map(async (row) => {
        const fs = new FileSessionStore(path.join(FAIL, row.key)); // each row has its own store
        rmSync(fs.root, { recursive: true, force: true });
        const calls: StoreCall[] = [];
        const store = (f?: Fault) => spy(fs, (c) => calls.push(c), f);
        try {
          const r = await row.run(store, fs, abort);
          send("failRow", { key: row.key, label: row.label, shown: row.shown, ...r, calls: callSummary(calls), at: Date.now() - startedAt });
        } catch (err) {
          send("failRow", { key: row.key, label: row.label, shown: row.shown, outcome: `the host threw: ${short(String(err))}`, calls: callSummary(calls), at: Date.now() - startedAt });
        }
      }),
    );
  } finally {
    send("done", {});
    res.end();
  }
});

/** "append ×3 (rejected) · load ×1" */
function callSummary(calls: StoreCall[]) {
  const c = new Map<string, { n: number; failed: number; ms: number }>();
  for (const x of calls) {
    const v = c.get(x.method) ?? { n: 0, failed: 0, ms: 0 };
    v.n++;
    if (x.error) v.failed++;
    v.ms = Math.max(v.ms, x.ms);
    c.set(x.method, v);
  }
  return [...c].map(([m, v]) => `${m} ×${v.n}${v.failed ? ` (${v.failed} rejected)` : ""}${v.ms >= 1000 ? ` (took ${(v.ms / 1000).toFixed(1)} s)` : ""}`).join(" · ") || "none";
}

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept35.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
