/**
 * CONCEPT 34 — Output styles: change HOW the agent answers (voice, shape, teaching) without writing a system prompt
 *
 * An output style is a Markdown file with a little frontmatter:
 *
 *   ---
 *   name: Code reviewer                  the name you select (default: the file name). Case matters.
 *   description: …                       shown in lists
 *   keep-coding-instructions: true       keep the "# Doing tasks" rules of the claude_code preset (default: false)
 *   force-for-plugin: true               plugin styles only: applied whenever the plugin is loaded
 *   ---
 *   The instructions.
 *
 * Claude Code finds styles in <cwd>/.claude/output-styles/ (settingSources "project"), in
 * CLAUDE_CONFIG_DIR/output-styles/ ("user") and in plugins (as "<plugin>:<name>"), next to the built-in ones
 * (default, Proactive, Concise, Explanatory, Learning). The SDK has no outputStyle option: it is a SETTING.
 *
 *   options.settings = { outputStyle: "Code reviewer" }       or .claude/settings.json, settings.local.json…
 *   q.applyFlagSettings({ outputStyle })                      switch mid-session (next turn)
 *   q.updateSettings("localSettings", { outputStyle })        save it to <cwd>/.claude/settings.local.json
 *   q.reloadOutputStyles()                                    see a style file written mid-session
 *   system/init.output_style, initializationResult().available_output_styles
 *
 * What the model gets, seen by a wire tap (ANTHROPIC_BASE_URL): the style text is NOT in the system prompt. It comes
 * in the first user message, as "<system-reminder># Output Style: <name>\n<text>". With the claude_code preset, a
 * style also changes the system prompt: its first line, and without keep-coding-instructions, "# Doing tasks" goes.
 * An unknown name (or the wrong case) is silently ignored, while system/init still reports it: the host checks.
 *
 * Routes: GET /styles, POST /who (SSE), POST /compare (SSE), POST /live (SSE), GET /code.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept34 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

// The lab's style files are real files you can open:
//   styles-project/.claude/output-styles/*.md   project styles (Pirate, Tutor, Tutor (keeps coding), Code reviewer)
//   styles-project/discount.js                   the file the prompts ask about (it has a bug)
//   styles-user/output-styles/spanish.md         a user style, copied into the fake CLAUDE_CONFIG_DIR
//   styles-plugin/                               the "acme" plugin with a forced style (acme:House)
// Each run works on its own copy of styles-project in style-lab/runs/<run id>.
const PROJECT_SRC = path.resolve("styles-project");
const USER_SRC = path.resolve("styles-user");
const PLUGIN = path.resolve("styles-plugin");
const LAB = path.resolve("style-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
mkdirSync(RUNS, { recursive: true });
cpSync(USER_SRC, CONFIG_DIR, { recursive: true }); // CONFIG_DIR/output-styles/spanish.md
const escaped = JSON.stringify(LAB).slice(1, -1); // the path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) => s.replaceAll(LAB, "style-lab").replaceAll(escaped, "style-lab").replace(/style-lab[\\/]+runs[\\/]+\w+[\\/]*/g, "");

const BUILT_IN = ["default", "Proactive", "Concise", "Explanatory", "Learning"];

type Emit = (event: string, data: object) => void;
type Reminder = { msg: number; name: string; text: string };
type Call = { n: number; system: string; reminders: Reminder[]; fresh: Reminder[] };
type Run = { id: string; work: string; calls: Call[] };

const active = new Set<string>();
function newRun(): Run {
  // Delete the folders of finished runs, keep the ones still running. On Windows a Claude Code process that just
  // closed can still hold its folder (EPERM): leave that one for the next run instead of failing this one.
  for (const d of readdirSync(RUNS)) {
    if (active.has(d)) continue;
    try {
      rmSync(path.join(RUNS, d), { recursive: true, force: true });
    } catch {}
  }
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  cpSync(PROJECT_SRC, work, { recursive: true });
  active.add(id);
  return { id, work, calls: [] };
}

// #region files
// A style file = frontmatter + instructions. This is how the CLI reads it: name defaults to the file name,
// keep-coding-instructions and force-for-plugin are booleans (force-for-plugin is ignored outside a plugin).
type StyleFile = { where: "project" | "user" | "plugin"; file: string; name: string; description: string; keepCoding: boolean; forceForPlugin: boolean; body: string; raw: string };

function readStyle(where: StyleFile["where"], file: string, prefix = ""): StyleFile {
  const raw = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  const name = prefix + (fm.name || path.basename(file, ".md"));
  return { where, file: short(path.relative(process.cwd(), file)).replaceAll("\\", "/"), name, description: fm.description ?? "", keepCoding: fm["keep-coding-instructions"] === "true", forceForPlugin: fm["force-for-plugin"] === "true", body: (m?.[2] ?? raw).trim(), raw };
}

function labStyles(): StyleFile[] {
  const dir = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => path.join(d, f)) : []);
  const plugin = JSON.parse(readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).name as string;
  return [
    ...dir(path.join(PROJECT_SRC, ".claude", "output-styles")).map((f) => readStyle("project", f)),
    ...dir(path.join(USER_SRC, "output-styles")).map((f) => readStyle("user", f)),
    ...dir(path.join(PLUGIN, "output-styles")).map((f) => readStyle("plugin", f, `${plugin}:`)), // plugin styles are "<plugin>:<name>"
  ];
}

concept34.get("/styles", (_req, res) => res.json({ builtIn: BUILT_IN, files: labStyles(), code: readFileSync(path.join(PROJECT_SRC, "discount.js"), "utf8") }));
// #endregion

// #region wire
// The wire tap: ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<run id>. It forwards every request to the real API and
// keeps, for each main-loop request, the system prompt and the style reminders in the messages. That is the only place
// to see what a style really did: system/init only repeats the name you asked for.
const REMINDER = /^<system-reminder>\n# Output Style: ([^\n]*)\n([\s\S]*?)\n?<\/system-reminder>/;
const tapRuns = new Map<string, { run: Run; emit: Emit; seen: number }>();

function styleReminders(messages: any[]): Reminder[] {
  const out: Reminder[] = [];
  messages.forEach((m, msg) => {
    if (m.role !== "user") return;
    for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) {
      const r = b.type === "text" ? String(b.text).match(REMINDER) : null;
      if (r) out.push({ msg, name: r[1], text: r[2].trim() });
    }
  });
  return out;
}

const tap = http.createServer(async (req, res) => {
  const m = req.url?.match(/^\/w\/([\w-]+)(\/.*)$/);
  const t = m ? tapRuns.get(m[1]) : undefined;
  if (!m || !t) return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  if (req.method === "POST" && m[2].startsWith("/v1/messages") && !m[2].includes("count_tokens")) {
    try {
      const j = JSON.parse(body.toString());
      const first = j.messages?.[0]?.content;
      // Skip the side call that names the session (its prompt starts with "<session>").
      if (!String(typeof first === "string" ? first : first?.[0]?.text ?? "").startsWith("<session>")) {
        const blocks: string[] = typeof j.system === "string" ? [j.system] : (j.system ?? []).map((b: any) => String(b.text ?? ""));
        // Block 0 is a billing header, block 1 the SDK's one-line identity; with a preset, the preset comes next.
        // The run id is in a path inside the preset (the memory folder): hide it, so runs compare line by line.
        const main = blocks.filter((s) => !s.startsWith("x-anthropic-billing-header"));
        const system = (main.length > 1 ? main.slice(1) : main).join("\n\n").replaceAll(t.run.id, "<run>");
        const reminders = styleReminders(j.messages);
        const call: Call = { n: t.run.calls.length + 1, system, reminders, fresh: reminders.filter((r) => r.msg >= t.seen) };
        t.seen = j.messages.length;
        t.run.calls.push(call);
        t.emit("wire", { n: call.n, systemChars: system.length, reminders: call.reminders.map((r) => ({ msg: r.msg, name: r.name })), fresh: call.fresh.map((r) => ({ ...r, text: short(r.text).slice(0, 400) })) });
      }
    } catch {}
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  try {
    const up = await fetch(UPSTREAM + m[2], { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : body });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    for await (const c of up.body ?? []) res.write(c);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
const tapPort = new Promise<number>((resolve) => tap.listen(0, "127.0.0.1", () => resolve((tap.address() as { port: number }).port)));

async function openTap(run: Run, emit: Emit) {
  tapRuns.set(run.id, { run, emit, seen: 0 });
  return `http://127.0.0.1:${await tapPort}/w/${run.id}`;
}
// #endregion

// #region options
type Setup = { style?: string; preset?: boolean; sources?: Options["settingSources"]; plugin?: boolean; tools?: string[]; maxTurns?: number };

async function baseOptions(run: Run, emit: Emit, s: Setup, abort: AbortController): Promise<Options> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR; // user styles: CLAUDE_CONFIG_DIR/output-styles/
  env.ANTHROPIC_BASE_URL = await openTap(run, emit); // every API call goes through the wire tap
  return {
    model: MODEL,
    cwd: run.work, // project styles: <cwd>/.claude/output-styles/
    // There is no outputStyle option: the style is a setting. options.settings is the "flag" layer, the highest one.
    ...(s.style !== undefined && { settings: { outputStyle: s.style } }),
    // Project and user styles are only found when their setting source is loaded.
    settingSources: s.sources ?? ["user", "project"],
    // Without a systemPrompt the SDK uses its short default prompt. With the claude_code preset you can also see
    // what a style removes from the system prompt (keep-coding-instructions).
    ...(s.preset && { systemPrompt: { type: "preset", preset: "claude_code" } }),
    ...(s.plugin && { plugins: [{ type: "local", path: PLUGIN }] }), // its styles are "acme:<name>"
    tools: s.tools ?? ["Read"],
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: s.maxTurns ?? 4,
    abortController: abort,
    env,
  };
}
// #endregion

const optionsForBrowser = (o: Options) => ({
  ...o,
  env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'style-lab/config', ANTHROPIC_BASE_URL: 'http://127.0.0.1:<tap>/w/<run>' }",
  abortController: "[AbortController]",
  cwd: "style-lab/runs/<run> (a copy of styles-project)",
  plugins: o.plugins && [{ type: "local", path: "styles-plugin" }],
});

// #region system
// What a style did to the SYSTEM prompt, compared line by line with the same run without a style.
function systemSummary(system: string, base?: string) {
  const lines = system.split("\n");
  const out = { chars: system.length, firstLine: lines.find((l) => l.trim()) ?? "", headings: lines.filter((l) => /^# /.test(l)) };
  if (base === undefined || base === system) return { ...out, same: base !== undefined };
  const now = new Set(lines);
  const before = base.split("\n");
  const was = new Set(before);
  const removed = before.filter((l) => l.trim() && !now.has(l));
  const added = lines.filter((l) => l.trim() && !was.has(l));
  return {
    ...out,
    same: false,
    removedChars: base.length - system.length,
    removedHeadings: removed.filter((l) => /^# /.test(l)),
    removed: removed.slice(0, 14).map((l) => short(l).slice(0, 140)),
    removedCount: removed.length,
    added: added.slice(0, 4).map((l) => short(l).slice(0, 220)),
    addedCount: added.length,
  };
}
// #endregion

// #region check
// The host's check: the name it asked for, the name system/init reports, and the style the API really got.
function verdict(asked: string | undefined, init: string | undefined, available: string[], calls: Call[]) {
  const got = calls.at(-1)?.reminders.at(-1)?.name; // the latest style reminder in the conversation
  const target = init ?? asked ?? "default";
  if (!got) {
    if (target === "default") return { got: null, verdict: "default", why: "no style: the model got no style reminder" };
    const near = available.find((a) => a.toLowerCase() === target.toLowerCase());
    return {
      got: null,
      verdict: "ignored",
      why: `system/init says "${target}", but it is not in available_output_styles${near ? ` (names are case-sensitive: did you mean "${near}"?)` : ""}. Nothing reached the model, and nothing reported an error.`,
    };
  }
  if (got === target) return { got, verdict: "applied", why: `the API got "# Output Style: ${got}"` };
  return { got, verdict: "replaced", why: `system/init says "${target}", but the API got "# Output Style: ${got}"${got.includes(":") ? " (a plugin style with force-for-plugin wins over the setting)" : ""}` };
}
// #endregion

// #region messages
type Outcome = { init?: string; available: string[]; text: string; tools: string[]; cost: number; error?: string; apiError?: string };

/** Runs one query() to the end and keeps what the host needs: the init's style, the style list, the answer. */
async function collect(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, onInit?: (q: Query) => Promise<void>): Promise<Outcome> {
  const o: Outcome = { available: [], text: "", tools: [], cost: 0 };
  const q = query({ prompt, options });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        o.init = m.output_style;
        o.available = (await q.initializationResult()).available_output_styles;
        await onInit?.(q);
      }
      if (m.type === "assistant") {
        // A failed API call arrives as a SYNTHETIC assistant message with `error` set (see Concept 28).
        if (m.error) o.apiError = m.error;
        for (const b of m.message.content) {
          if (b.type === "text") o.text += (o.text ? "\n\n" : "") + b.text;
          if (b.type === "tool_use") o.tools.push(b.name);
        }
      }
      if (m.type === "result") o.cost += m.total_cost_usd;
    }
  } catch (err) {
    o.error = short(String((err as Error)?.message ?? err)).slice(0, 300);
  }
  o.text = short(o.text).slice(0, 3000);
  return o;
}
// #endregion

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// ---------------------------------------------------------------------------------------------
// POST /compare: the same prompt with 1 to 5 styles, in parallel. "default" means no outputStyle setting.
// ---------------------------------------------------------------------------------------------

const PROMPT = "Read discount.js. Is there a bug? Show the fixed function in your answer. Do not edit any file.";
const StyleName = z.string().trim().min(1).max(60).regex(/^[\w .():-]+$/, "letters, digits, spaces and . ( ) : - _ only");
const Custom = z
  .object({
    name: z.string().trim().min(1).max(40).regex(/^[\w .()-]+$/, "letters, digits, spaces and . ( ) - _ only"),
    description: z.string().trim().max(200).optional(),
    keepCoding: z.boolean(),
    where: z.enum(["project", "user"]),
    body: z.string().trim().min(1).max(3000),
  })
  .strict()
  .refine((c) => !BUILT_IN.some((b) => b.toLowerCase() === c.name.toLowerCase()), { message: "pick a name that is not a built-in style" });

const CompareBody = z
  .object({
    styles: z.array(StyleName).min(1).max(5).refine((a) => new Set(a).size === a.length, { message: "each style once" }),
    prompt: z.string().trim().min(1).max(2000).optional(),
    preset: z.boolean().optional(), // systemPrompt: { type: "preset", preset: "claude_code" }
    custom: Custom.optional(), // your own style file, written into the run before it starts
  })
  .strict()
  .refine((b) => !b.custom || b.styles.includes(b.custom.name), { message: "styles must include the custom style's name" });

// #region custom
// Your style is written as a real file before the session starts: <run>/.claude/output-styles/ or
// CLAUDE_CONFIG_DIR/output-styles/ (shared by all runs, so the file name carries the run id and is deleted after).
function writeCustom(run: Run, c: z.infer<typeof Custom>) {
  const dir = c.where === "project" ? path.join(run.work, ".claude", "output-styles") : path.join(CONFIG_DIR, "output-styles");
  const file = path.join(dir, `custom-${run.id}.md`);
  const fm = [`name: ${JSON.stringify(c.name)}`, `description: ${JSON.stringify(c.description || "Written in the lab")}`, ...(c.keepCoding ? ["keep-coding-instructions: true"] : [])];
  writeFileSync(file, `---\n${fm.join("\n")}\n---\n${c.body}\n`);
  return file;
}
// #endregion

concept34.post("/compare", async (req, res) => {
  const parsed = CompareBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), end();
  const b = parsed.data;
  const prompt = b.prompt ?? PROMPT;
  const runs: Run[] = [];
  const cleanup: string[] = [];
  try {
    const cols = await Promise.all(
      b.styles.map(async (style, i) => {
        const run = newRun();
        runs.push(run);
        const custom = b.custom?.name === style ? b.custom : undefined;
        if (custom) {
          const file = writeCustom(run, custom);
          if (custom.where === "user") cleanup.push(file);
          send("customFile", { col: i, file: short(path.relative(process.cwd(), file)).replaceAll("\\", "/"), text: readFileSync(file, "utf8") });
        }
        const quiet: Emit = () => {};
        const options = await baseOptions(run, quiet, { style: style === "default" ? undefined : style, preset: b.preset }, abort);
        if (i === 0) send("opened", { prompt, options: optionsForBrowser({ ...options, settings: "{ outputStyle: <the column's style> } (omitted for 'default')" as any }) });
        const o = await collect(prompt, options);
        const col = { col: i, style, ...o, ...verdict(style === "default" ? undefined : style, o.init, o.available, run.calls), reminder: run.calls.at(-1)?.reminders.at(-1), calls: run.calls.length, at: Date.now() - startedAt };
        send("column", { ...col, reminder: col.reminder && { ...col.reminder, text: short(col.reminder.text).slice(0, 1500) } });
        return { style, system: run.calls[0]?.system };
      }),
    );
    // The system prompts, compared with the column without a style (when there is one).
    const base = cols.find((c) => c.style === "default")?.system;
    cols.forEach((c, i) => c.system !== undefined && send("system", { col: i, ...systemSummary(c.system, c.style === "default" ? undefined : base) }));
  } finally {
    for (const r of runs) active.delete(r.id), tapRuns.delete(r.id);
    for (const f of cleanup) rmSync(f, { force: true });
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /who: which style really applied? The same short prompt in 7 setups, in parallel.
// ---------------------------------------------------------------------------------------------

const WHO: { key: string; label: string; shown: string; setup: Setup; projectSettings?: boolean }[] = [
  { key: "none", label: "no outputStyle", shown: "—", setup: {} },
  { key: "builtin", label: "a built-in style", shown: "settings: { outputStyle: 'Explanatory' }", setup: { style: "Explanatory" } },
  { key: "case", label: "the wrong case", shown: "settings: { outputStyle: 'explanatory' }", setup: { style: "explanatory" } },
  { key: "nosource", label: "a project style, no setting sources", shown: "settings: { outputStyle: 'Pirate' }, settingSources: []", setup: { style: "Pirate", sources: [] } },
  { key: "project", label: "a project style", shown: "settings: { outputStyle: 'Pirate' }, settingSources: ['user', 'project']", setup: { style: "Pirate" } },
  { key: "file", label: "from .claude/settings.json", shown: "settingSources: ['project'] + .claude/settings.json { outputStyle: 'Code reviewer' }", setup: { sources: ["project"] }, projectSettings: true },
  { key: "plugin", label: "a plugin forces its style", shown: "plugins: [acme], settings: { outputStyle: 'Explanatory' }", setup: { style: "Explanatory", plugin: true } },
];

concept34.post("/who", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const runs: Run[] = [];
  try {
    await Promise.all(
      WHO.map(async (w) => {
        const run = newRun();
        runs.push(run);
        if (w.projectSettings) writeFileSync(path.join(run.work, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Code reviewer" }, null, 2));
        const options = await baseOptions(run, () => {}, { ...w.setup, tools: [], maxTurns: 1 }, abort);
        const o = await collect("Say hello in one short sentence.", options);
        const asked = w.setup.style ?? (w.projectSettings ? "Code reviewer" : undefined);
        const v = verdict(asked, o.init, o.available, run.calls);
        send("whoRow", { key: w.key, label: w.label, shown: w.shown, init: o.init, listed: o.init ? o.available.includes(o.init) : undefined, ...v, text: o.text.slice(0, 200), error: o.error ?? o.apiError, cost: o.cost, at: Date.now() - startedAt });
      }),
    );
  } finally {
    for (const r of runs) active.delete(r.id), tapRuns.delete(r.id);
    send("done", {});
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /live: switching styles in ONE session (streaming input, Concept 12), step by step
// ---------------------------------------------------------------------------------------------

/** A prompt the host can push user messages into while the session runs. */
function inbox() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
      if (closed) return;
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: queue.shift()! } };
    }
  }
  return { messages: messages(), push: (t: string) => (queue.push(t), wake?.()), close: () => ((closed = true), wake?.()) };
}

const HAIKU = "---\nname: Haiku\ndescription: Written while the session runs\n---\nAnswer only with a haiku: three lines of 5, 7 and 5 syllables. No other text.\n";
const LIVE_PROMPTS = [
  "Introduce yourself in one short sentence.",
  "Name one thing to check in a code review, in one short sentence.",
  "Name one more thing to check, in one short sentence.",
  "Describe a good commit message.",
  "Say goodbye in one short sentence.",
];

// #region live
// One session, five turns. Between turns the host changes the style with the Query's control methods. The next turn
// starts with a new system/init (output_style) and, if the style exists, a NEW style reminder. The old reminders stay
// in the history, so the model may mix styles: a fresh session is the clean switch.
async function live(send: Emit, abort: AbortController) {
  const run = newRun();
  const control = (method: string, result: unknown, note: string) => send("control", { method, result, note });
  let turn = 0;
  let asked = "Pirate";
  let spent = 0; // total_cost_usd adds up over the session: each turn shows its own part
  try {
    const box = inbox();
    // "local" too: updateSettings("localSettings") is refused when that source is not loaded.
    const options = await baseOptions(run, () => {}, { style: "Pirate", tools: [], sources: ["user", "project", "local"] }, abort);
    delete options.maxTurns; // one session, several prompts
    send("opened", { prompt: "(streaming input: one user message per turn)", options: optionsForBrowser(options) });
    const q = query({ prompt: box.messages, options });
    const it = q[Symbol.asyncIterator]();
    const step = async () => {
      const prompt = LIVE_PROMPTS[turn++];
      box.push(prompt);
      let init: string | undefined;
      let text = "";
      let cost = 0;
      const before = run.calls.length;
      while (true) {
        const { value: m, done } = await it.next();
        if (done) break;
        if (m.type === "system" && m.subtype === "init") init = m.output_style; // every turn starts with a new init
        if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text;
        if (m.type === "result") { cost = m.total_cost_usd - spent; spent = m.total_cost_usd; break; }
      }
      const call = run.calls.at(-1);
      const fresh = run.calls.length > before ? call?.fresh ?? [] : [];
      send("turn", { turn, prompt, asked, init, fresh: fresh.map((r) => ({ name: r.name, text: r.text.slice(0, 300) })), history: call?.reminders.map((r) => r.name) ?? [], text: short(text).slice(0, 600), cost });
    };

    await step(); // 1: Pirate, from options.settings

    await q.applyFlagSettings({ outputStyle: "Concise" });
    asked = "Concise";
    control("q.applyFlagSettings({ outputStyle: 'Concise' })", "ok", "switches from the next turn on");
    control("(await q.initializationResult()).output_style", (await q.initializationResult()).output_style, "still the value from the start: the initialize answer is cached. Read system/init instead");
    await step(); // 2

    const file = path.join(run.work, ".claude", "output-styles", "haiku.md");
    writeFileSync(file, HAIKU);
    control("writeFileSync('.claude/output-styles/haiku.md')", "written", "a new style file, while the session runs");
    await q.applyFlagSettings({ outputStyle: "Haiku" });
    asked = "Haiku";
    control("q.applyFlagSettings({ outputStyle: 'Haiku' })", "ok", "accepted, but the session has not seen haiku.md yet");
    await step(); // 3: ignored

    const r = await q.reloadOutputStyles();
    control("q.reloadOutputStyles()", r.available_output_styles, "re-reads the style folders: Haiku is there now");
    await q.applyFlagSettings({ outputStyle: "Haiku" });
    control("q.applyFlagSettings({ outputStyle: 'Haiku' })", "ok", "the same call, now the style exists");
    await step(); // 4

    try {
      await q.updateSettings("localSettings", { outputStyle: "Explanatory" });
      const local = path.join(run.work, ".claude", "settings.local.json");
      control("q.updateSettings('localSettings', { outputStyle: 'Explanatory' })", existsSync(local) ? JSON.parse(readFileSync(local, "utf8")) : "(no file)", "saved to .claude/settings.local.json, the way /config saves it");
    } catch (err) {
      control("q.updateSettings('localSettings', { outputStyle: 'Explanatory' })", `rejected: ${String(err).slice(0, 200)}`, "");
    }
    await q.applyFlagSettings({ outputStyle: null });
    asked = "(flag cleared)";
    control("q.applyFlagSettings({ outputStyle: null })", "ok", "removes the value set by applyFlagSettings: which layer wins now?");
    await step(); // 5
    box.close();
    q.close();
  } catch (err) {
    send("error", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  } finally {
    active.delete(run.id);
    tapRuns.delete(run.id);
  }
}
// #endregion

concept34.post("/live", async (req, res) => {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  await live((event, data) => send(event, { ...data, at: Date.now() - startedAt }), abort);
  send("done", {});
  res.end();
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept34.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
