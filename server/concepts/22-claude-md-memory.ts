/**
 * CONCEPT 22 — CLAUDE.md & memory: which instruction files Claude Code loads, and when
 *
 * Memory files are markdown that Claude Code adds to the context. `settingSources` decides which ones are read:
 *
 *   "project"  <cwd>/CLAUDE.md (and the CLAUDE.md of every parent folder), .claude/rules/*.md,
 *              <sub>/CLAUDE.md (nested, only when Claude reads a file in <sub>/)
 *   "local"    <cwd>/CLAUDE.local.md, personal notes that are not committed
 *   "user"     ~/.claude/CLAUDE.md (here a fake home: env.CLAUDE_CONFIG_DIR = memory-lab/home)
 *
 * When a file is read:
 *   session_start     at the start: CLAUDE.md, CLAUDE.local.md, the user file, rules WITHOUT `paths:`
 *   include           a line "@docs/style.md" inside a memory file pulls that file in too
 *   nested_traversal  api/CLAUDE.md, the first time Claude reads a file inside api/
 *   path_glob_match   a rule with `paths: ["api/**\/*.js"]`, the first time Claude reads a matching file
 *   compact           everything is read again after /compact
 *
 * How to see it: the InstructionsLoaded hook (one call per file, with load_reason / trigger_file_path /
 * parent_file_path), and q.getContextUsage().memoryFiles (every memory file in the context, with its tokens).
 *
 * Also shown: settings.claudeMdExcludes (skip files by glob), auto memory (settings.autoMemoryEnabled +
 * autoMemoryDirectory: the model saves notes in MEMORY.md and reads them in the next session; needs the claude_code
 * preset), and omitClaudeMd on a subagent.
 *
 * Routes: GET /files, POST /reset, POST /run (SSE).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept22 = Router();

const PROJECT = path.resolve("memory-project"); // committed: the memory files the tab explains
const LAB = path.resolve("memory-lab"); // recreated by the server (gitignored)
const HOME = path.join(LAB, "home"); // the fake ~/.claude for the "user" source
const AUTO = path.join(LAB, "auto-memory"); // where auto memory writes
const MAX_RUN_MS = 120_000;
const MAX_PROMPT = 2000;
const MAX_PROMPTS = 4;

const USER_CLAUDE_MD = `# My preferences (user memory)

- Marker: ⬜ USER (~/.claude/CLAUDE.md, needs settingSources "user"; here the fake home memory-lab/home/)
- Keep answers short.
`;

/** Recreates memory-lab/: the fake home with its CLAUDE.md, and an empty auto-memory folder. */
function resetLab() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(AUTO, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(path.join(HOME, "CLAUDE.md"), USER_CLAUDE_MD);
}
resetLab();

// The same base for every run. No system prompt (the SDK's minimal one): CLAUDE.md loads anyway.
// Auto memory is off, and its folder is ALWAYS the lab's, so a run never writes to ~/.claude/projects/.../memory/.
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: PROJECT,
  settingSources: ["project"],
  settings: { autoMemoryEnabled: false, autoMemoryDirectory: AUTO },
  tools: ["Read"],
  allowedTools: ["Read"],
  strictMcpConfig: true,
  persistSession: false,
  maxTurns: 6,
};

// ---------------------------------------------------------------------------------------------
// GET /files: the memory files on disk
// ---------------------------------------------------------------------------------------------

/**
 * Frontmatter reader: `key: value`, a list (`key:` then `  - item` lines) and one level of nesting (`key:` then
 * `  sub: value`, returned as "key.sub"). Enough for these files and for what auto memory writes.
 */
function parse(text: string) {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {} as Record<string, string>, body: text.trim() };
  const frontmatter: Record<string, string> = {};
  const unquote = (v: string) => v.trim().replace(/^["'](.*)["']$/, "$1");
  let parent = "";
  for (const line of match[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    const nested = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (item && parent) frontmatter[parent] = [frontmatter[parent], unquote(item[1])].filter(Boolean).join(", ");
    else if (nested && parent) frontmatter[`${parent}.${nested[1]}`] = unquote(nested[2]);
    else if (line.includes(":")) {
      parent = line.slice(0, line.indexOf(":")).trim();
      const value = unquote(line.slice(line.indexOf(":") + 1));
      if (value) frontmatter[parent] = value;
    }
  }
  return { frontmatter, body: match[2].trim() };
}

/** Every .md file under a folder (not code files), relative to `base`. */
function markdownFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return markdownFiles(full, base);
    return d.name.endsWith(".md") ? [path.relative(base, full).replaceAll("\\", "/")] : [];
  });
}

/** What kind of memory file each path is, and what makes it load. Must match the layout of memory-project/. */
function kindOf(file: string, frontmatter: Record<string, string>) {
  if (file === "CLAUDE.md") return { kind: "project", loads: 'session start · settingSources "project"' };
  if (file === "CLAUDE.local.md") return { kind: "local", loads: 'session start · settingSources "local"' };
  if (file.startsWith(".claude/rules/"))
    return frontmatter.paths ? { kind: "path rule", loads: `when a file matching ${frontmatter.paths} is read` } : { kind: "rule", loads: "session start (no paths:)" };
  if (file.endsWith("/CLAUDE.md")) return { kind: "nested", loads: `when a file in ${file.slice(0, -"/CLAUDE.md".length)}/ is read` };
  return { kind: "import", loads: "when a memory file has a line @" + file };
}

concept22.get("/files", (_req, res) => {
  const read = (base: string, file: string) => parse(readFileSync(path.join(base, file), "utf8"));
  const project = markdownFiles(PROJECT, PROJECT).map((file) => {
    const { frontmatter, body } = read(PROJECT, file);
    return { file, ...kindOf(file, frontmatter), frontmatter, body };
  });
  const user = { file: "memory-lab/home/CLAUDE.md", kind: "user", loads: 'session start · settingSources "user"', frontmatter: {}, body: read(HOME, "CLAUDE.md").body };
  // Auto memory: whatever the model has written so far (MEMORY.md is the index, one file per memory).
  const auto = markdownFiles(AUTO, AUTO).map((file) => ({ file, ...read(AUTO, file) }));
  res.json({ files: [...project, user], auto });
});

concept22.post("/reset", (_req, res) => {
  resetLab();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Switches the browser can turn on (names only, checked against this list)
// ---------------------------------------------------------------------------------------------

const withSettings = (o: Options, extra: object): Options => ({ ...o, settings: { ...(o.settings as object), ...extra } });
const addTools = (o: Options, ...tools: string[]): Options => ({ ...o, tools: [...(o.tools as string[]), ...tools], allowedTools: [...(o.allowedTools ?? []), ...tools] });

// A subagent that is asked about its own context. `background: false` keeps it in the foreground, so the main
// agent waits for its answer.
const checker = (omitClaudeMd: boolean) => ({
  description: "Answers questions about its own instructions and context.",
  prompt: "You answer questions about your own instructions and context. Never use tools.",
  tools: [],
  model: "haiku",
  background: false,
  omitClaudeMd,
});

// Applied in this order. settingSources is built from "noProject", "local" and "user" together (see buildOptions).
const SWITCHES: Record<string, (o: Options) => Options> = {
  // Claude Code's full system prompt. Needed for auto memory: it holds the instructions on how to use MEMORY.md.
  preset: (o) => ({ ...o, systemPrompt: { type: "preset", preset: "claude_code" } }),
  // The run starts in memory-project/api/: CLAUDE.md files of the PARENT folders load too.
  subdir: (o) => ({ ...o, cwd: path.join(PROJECT, "api") }),
  // Skip memory files by glob (matched against the absolute path).
  exclude: (o) => withSettings(o, { claudeMdExcludes: ["**/.claude/rules/testing.md", "**/api/CLAUDE.md"] }),
  // The model may save memories. Write/Edit are needed; writes into autoMemoryDirectory need no allowedTools rule.
  autoMemory: (o) => withSettings({ ...o, tools: [...(o.tools as string[]), "Write", "Edit"] }, { autoMemoryEnabled: true }),
  // A subagent "checker", with or without the memory files.
  agent: (o) => ({ ...addTools(o, "Agent"), agents: { checker: checker(false) } }),
  omitClaudeMd: (o) => ({ ...addTools(o, "Agent"), agents: { checker: checker(true) } }),
};
const SOURCE_SWITCHES = ["noProject", "local", "user"];

// The request body. The browser sends only switch names from the lists above, never code or paths.
const known = (x: string) => Object.hasOwn(SWITCHES, x) || SOURCE_SWITCHES.includes(x);
const RunBody = z
  .object({
    prompts: z.array(z.string().trim().min(1).max(MAX_PROMPT)).min(1).max(MAX_PROMPTS),
    switches: z.array(z.string().refine(known, { message: `must be one of ${[...SOURCE_SWITCHES, ...Object.keys(SWITCHES)].join(", ")}` })).max(20).default([]),
  })
  .strict();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

function buildOptions(switches: string[]): Options {
  let options: Options = {
    ...BASE,
    settingSources: [
      ...(switches.includes("user") ? (["user"] as const) : []),
      ...(switches.includes("noProject") ? [] : (["project"] as const)),
      ...(switches.includes("local") ? (["local"] as const) : []),
    ],
  };
  // The "user" source reads <CLAUDE_CONFIG_DIR>/CLAUDE.md. A fake home keeps your real ~/.claude out of the lab.
  // (It also moves the CLI's own config files there, so the run authenticates with ANTHROPIC_API_KEY from .env.)
  if (switches.includes("user")) options.env = { ...process.env, CLAUDE_CONFIG_DIR: HOME };
  for (const s of Object.keys(SWITCHES)) if (switches.includes(s)) options = SWITCHES[s](options);
  return options;
}

/** What to show of the options (no env: it would print the API key). */
const describe = (options: Options) => ({
  ...options,
  env: options.env ? { "...process.env": "…", CLAUDE_CONFIG_DIR: HOME } : undefined,
  hooks: { InstructionsLoaded: ["[Function observer]"] },
  prompt: "[AsyncIterable<SDKUserMessage>]",
});

/** Paths relative to the sample folder, so the tab can show them short. */
const short = (p: unknown) => (typeof p === "string" ? path.relative(process.cwd(), p).replaceAll("\\", "/") : p);

// ---------------------------------------------------------------------------------------------
// POST /run: 1 to 4 prompts in ONE session (streaming input, Concept 12), so /compact can follow a prompt
// ---------------------------------------------------------------------------------------------

concept22.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  const startedAt = Date.now();
  if (!parsed.success) {
    send("error", { message: `${badRequest(parsed.error)} (send 1 to ${MAX_PROMPTS} prompts of up to ${MAX_PROMPT} characters)` });
    send("done", {});
    return res.end();
  }
  const { prompts, switches } = parsed.data;

  // An observer on InstructionsLoaded: one `hook` event per memory file, when it is read.
  const observer: HookCallback = async (input) => {
    if (input.hook_event_name === "InstructionsLoaded") {
      const { file_path, memory_type, load_reason, globs, trigger_file_path, parent_file_path } = input;
      send("hook", {
        file: short(file_path),
        memory_type,
        load_reason,
        globs,
        trigger: short(trigger_file_path),
        parent: short(parent_file_path),
        at: Date.now() - startedAt,
      });
    }
    return {};
  };
  const options: Options = { ...buildOptions(switches), hooks: { InstructionsLoaded: [{ hooks: [observer] }] } };
  send("options", describe(options));

  const label = `[c22] ${prompts.length} prompt(s) ${JSON.stringify(prompts[0].slice(0, 40))} switches=${switches.join(",") || "-"}`;
  console.log(`${label} started`);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  res.on("close", () => clearTimeout(timer));

  // The next prompt is pushed only after the previous one's result, like a user typing turn after turn.
  let next: (() => void) | undefined;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (const [index, text] of prompts.entries()) {
      send("turn", { index, prompt: text });
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
      await new Promise<void>((resolve) => (next = resolve));
    }
  }

  const q = query({ prompt: input(), options: { ...options, abortController: abort } });

  /** q.getContextUsage().memoryFiles: every memory file in the context right now, with its tokens. */
  async function memory(when: string) {
    try {
      const { memoryFiles } = await q.getContextUsage({ detail: "summary" });
      send("memory", { when, files: memoryFiles.map((f) => ({ ...f, path: short(f.path) })) });
    } catch (err) {
      send("memory", { when, error: String(err) });
    }
  }

  async function* run() {
    let results = 0;
    for await (const msg of q) {
      yield msg;
      if (msg.type === "system" && msg.subtype === "init" && results === 0) await memory("after system/init");
      if (msg.type !== "result") continue;
      await memory(`after result #${results + 1}`);
      console.log(`${label} result #${results + 1} ${msg.subtype} turns=${msg.num_turns} $${msg.total_cost_usd.toFixed(4)}`);
      if (++results === prompts.length) return; // ends the query: the input generator is left waiting
      next?.();
    }
  }
  pipe(run());
});
