/**
 * CONCEPT 39 — projectConfigRoot: run in a worktree, take the project config from the trusted checkout
 *
 *   options.cwd               = ".../repo-pr-42"   ← a git worktree of the PR branch: the files Claude reads and edits
 *   options.projectConfigRoot = ".../repo"         ← the trusted checkout: where the project CONFIG comes from
 *
 * It becomes the CLI flag --project-config-root=<dir>. From that directory, instead of cwd, Claude Code reads:
 *   .claude/settings.json and .claude/settings.local.json (hooks, permissions, env…), .mcp.json,
 *   .claude/commands, skills, agents, output-styles…, and CLAUDE_PROJECT_DIR (hooks also run there).
 * What stays with cwd: CLAUDE.md, the tools' working folder, the files.
 *
 * Why: a PR branch can carry its own .claude/settings.json. Without the option, its hooks run on your machine, and if
 * the main checkout is trusted (the worktree inherits that trust), its permissions.allow rules apply too.
 *
 * The path must be absolute, local, and an existing directory: otherwise Claude Code exits at startup.
 * `settingSources` still decides WHETHER project settings load; projectConfigRoot only changes WHERE from.
 *
 * Routes: POST /dry, POST /where, /takeover (SSE, one row per case), POST /try (SSE), GET /code.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept39 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("config-root-lab");
const REPO = path.join(LAB, "repo"); // the main checkout, branch main: the trusted one
const PR = path.join(LAB, "repo-pr-42"); // git worktree, branch pr-42: a pull request that changed every config file
const DOCS = path.join(LAB, "repo-docs"); // git worktree, branch docs: a branch without .claude and .mcp.json
const RUNS = path.join(LAB, "runs"); // one folder per session: its CLAUDE_CONFIG_DIR and its hook log

const ROOT = process.cwd();
const slashes = (s: string) => s.replaceAll("\\", "/");
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "") // colour codes: `npm run dev` (concurrently) sets FORCE_COLOR, and Claude Code and node inherit it
    .replaceAll(LAB, "config-root-lab")
    .replaceAll(slashes(LAB), "config-root-lab")
    .replaceAll(encodeURI(slashes(LAB)), "config-root-lab")
    .replace(/config-root-lab[^\s"'`]*/g, (p) => p.replaceAll("\\", "/")) // one style of path in the tab
    .replace(/config-root-lab\/runs\/\w+/g, "<the run folder>")
    .replaceAll(ROOT, ".")
    .replaceAll(slashes(ROOT), ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…"); // a key must never reach the browser

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 500);

// #region lab
// Two checkouts of one git repository. Each has the same config files, with its own content ("trusted" or "branch"),
// so every row can tell where a piece of config came from.
const write = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

function config(root: string, who: "trusted" | "branch", word: string) {
  write(root, "CLAUDE.md", `# Project notes\n\nThe project code word is ${word}.\n`);
  write(root, "README.md", `A small project. This copy is the ${who} checkout.\n`);
  // The hook records who it is, where it runs, and what it can see. It never prints the key, only whether it had it.
  write(
    root,
    ".claude/hook.mjs",
    String.raw`import { appendFileSync } from "node:fs";
let input = "";
for await (const c of process.stdin) input += c;
const e = process.env;
appendFileSync(e.HOOK_LOG, JSON.stringify({ script: "${who}", event: JSON.parse(input).hook_event_name, CLAUDE_PROJECT_DIR: e.CLAUDE_PROJECT_DIR, cwd: process.cwd(), LAB_SETTINGS: e.LAB_SETTINGS, LAB_LOCAL: e.LAB_LOCAL, sawApiKey: !!e.ANTHROPIC_API_KEY }) + "\n");
`,
  );
  const settings = {
    env: { LAB_SETTINGS: who },
    enableAllProjectMcpServers: true,
    // The branch grants itself Bash. The trusted checkout grants nothing.
    ...(who === "branch" && { permissions: { allow: ["Bash", "Read"] } }),
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hook.mjs"' }] }] },
  };
  write(root, ".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");
  write(root, ".claude/commands/release.md", `---\ndescription: the release steps (${who} checkout)\n---\nReply with exactly this line: release steps from the ${who} checkout\n`);
  write(root, `.claude/commands/${who}-only.md`, `---\ndescription: only in the ${who} checkout\n---\nReply with exactly: ${who}\n`);
  write(root, `.claude/skills/${who}-skill/SKILL.md`, `---\nname: ${who}-skill\ndescription: a skill of the ${who} checkout\n---\nSay: ${who}.\n`);
  write(root, `.claude/agents/${who}-agent.md`, `---\nname: ${who}-agent\ndescription: an agent of the ${who} checkout\n---\nYou are the ${who} agent.\n`);
  // A server that exits at once: only its name matters here (Concept 13 has real servers).
  write(root, ".mcp.json", JSON.stringify({ mcpServers: { [`${who}-notes`]: { command: "node", args: ["-e", "process.exit(0)"] } } }, null, 2) + "\n");
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=lab", "-c", "user.email=lab@example.com", ...args], { cwd, stdio: "pipe" }).toString();
}

function buildLab() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
  config(REPO, "trusted", "MAPLE");
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "add", ".");
  git(REPO, "commit", "-qm", "main: the project and its config");
  // The PR branch: every config file changed, committed on the branch, checked out as a worktree.
  git(REPO, "worktree", "add", "-q", "-b", "pr-42", PR);
  for (const f of ["commands/trusted-only.md", "skills/trusted-skill", "agents/trusted-agent.md"]) rmSync(path.join(PR, ".claude", f), { recursive: true });
  config(PR, "branch", "BIRCH");
  git(PR, "add", "-A");
  git(PR, "commit", "-qm", "pr-42: new hooks, permissions, commands, MCP server");
  // A branch without any project config.
  git(REPO, "worktree", "add", "-q", "-b", "docs", DOCS);
  rmSync(path.join(DOCS, ".claude"), { recursive: true });
  rmSync(path.join(DOCS, ".mcp.json"));
  git(DOCS, "add", "-A");
  git(DOCS, "commit", "-qm", "docs: no config");
  // settings.local.json is never committed: each checkout has its own.
  write(REPO, ".claude/settings.local.json", JSON.stringify({ env: { LAB_LOCAL: "trusted-local" } }) + "\n");
  write(PR, ".claude/settings.local.json", JSON.stringify({ env: { LAB_LOCAL: "branch-local" } }) + "\n");
}

let lab: Promise<void> | undefined;
const ensureLab = () => (lab ??= Promise.resolve().then(buildLab).catch((err) => ((lab = undefined), Promise.reject(new Error(`Could not build config-root-lab (is git installed?): ${errText(err)}`)))));
// #endregion

// Each session gets its own config-root-lab/runs/<id>: a CLAUDE_CONFIG_DIR (with a trust entry, for some rows) and a
// hook log. Folders of finished sessions are deleted.
const active = new Set<string>();
function newRun(trust: string | null) {
  if (existsSync(RUNS)) for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const dir = path.join(RUNS, id);
  const configDir = path.join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  // What the trust dialog writes when you accept it in the terminal (Concept 16): trust for this folder.
  if (trust) writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ projects: { [slashes(trust)]: { hasTrustDialogAccepted: true } } }));
  active.add(id);
  return { id, configDir, hookLog: path.join(dir, "hooks.jsonl"), done: () => active.delete(id) };
}
type Run = ReturnType<typeof newRun>;

// #region options
function base(run: Run, cwd: string, abort: AbortController, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = run.configDir;
  env.HOOK_LOG = run.hookLog; // the lab's hooks write here
  return {
    model: MODEL,
    cwd, // ← where the session works: the files, the tools, CLAUDE.md
    env,
    tools: [],
    settingSources: ["project", "local"], // project settings must load at all; projectConfigRoot says from where
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 4,
    abortController: abort,
    ...extra, // projectConfigRoot: REPO ← the option of this concept
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

async function argsFor(projectConfigRoot: string | undefined) {
  let args: string[] = [];
  const options: Options = { model: MODEL, cwd: PR, settingSources: [], ...(projectConfigRoot !== undefined && { projectConfigRoot }) };
  const q = query({ prompt: "hi", options: { ...options, spawnClaudeCodeProcess: (o) => ((args = o.args), recordingProcess()) } });
  try {
    for await (const _ of q) break;
  } catch {}
  return args.filter((a) => a.startsWith("--project-config-root")).map(short);
}

/** The real Claude Code, with a root it refuses: it exits before any API call. */
async function startup(projectConfigRoot: string) {
  const run = newRun(null);
  let stderr = "";
  try {
    for await (const _ of query({ prompt: "hi", options: base(run, PR, new AbortController(), { projectConfigRoot, stderr: (s) => (stderr += s) }) })) break;
    return { ok: true, message: "it started" };
  } catch (err) {
    return { ok: false, message: short(stderr.trim() || errText(err)) };
  } finally {
    run.done();
  }
}
// #endregion

concept39.post("/dry", async (_req, res) => {
  try {
    await ensureLab();
    const file = path.join(REPO, "README.md");
    const [flags, checks] = await Promise.all([
      Promise.all(
        [
          { key: "omitted", shown: "(no projectConfigRoot)", value: undefined },
          { key: "absolute", shown: "projectConfigRoot: '<lab>/repo'", value: REPO },
          { key: "relative", shown: "projectConfigRoot: '../repo'", value: "../repo" },
        ].map(async (r) => ({ key: r.key, shown: r.shown, args: await argsFor(r.value) })),
      ),
      Promise.all(
        [
          { key: "relative", shown: "'../repo' (relative)", value: "../repo" },
          { key: "missing", shown: "'<lab>/no-such-folder'", value: path.join(LAB, "no-such-folder") },
          { key: "file", shown: "'<lab>/repo/README.md' (a file)", value: file },
        ].map(async (r) => ({ key: r.key, shown: r.shown, ...(await startup(r.value)) })),
      ),
    ]);
    res.json({ flags, checks });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /where, /takeover: sessions in parallel, one table row each. POST /try: one session, streamed.
// ---------------------------------------------------------------------------------------------

// #region run
type Hook = { script: string; event: string; CLAUDE_PROJECT_DIR: string; cwd: string; LAB_SETTINGS?: string; LAB_LOCAL?: string; sawApiKey: boolean };
type Spec = {
  key: string;
  label: string;
  cwd: string;
  root?: string; // projectConfigRoot
  trust?: string | null; // the folder the fake CLAUDE_CONFIG_DIR trusts
  options?: Partial<Options>;
  prompt: string;
  note?: (r: Out) => string;
};
type Out = {
  key: string;
  label: string;
  cwd: string;
  root: string | null;
  trust: string | null;
  sources: string;
  init?: { cwd: string; commands: string[]; skills: string[]; agents: string[]; mcp: string[] };
  hooks: Hook[];
  bash: { command: string; ran: boolean; output: string }[];
  answer: string;
  denials: string[];
  warnings: string[];
  cost: number;
  error?: string;
  note?: string;
};

const MINE = /release|trusted|branch/; // the lab's own commands, skills and agents, not the built-in ones

async function runSession(spec: Spec, abort: AbortController, emit?: Emit): Promise<Out> {
  const run = newRun(spec.trust ?? null);
  const options = base(run, spec.cwd, abort, { ...(spec.root !== undefined && { projectConfigRoot: spec.root }), ...spec.options });
  const r: Out = {
    key: spec.key,
    label: spec.label,
    cwd: short(spec.cwd),
    root: spec.root === undefined ? null : short(spec.root),
    trust: spec.trust ? short(spec.trust) : null,
    sources: JSON.stringify(options.settingSources),
    hooks: [],
    bash: [],
    answer: "",
    denials: [],
    warnings: [],
    cost: 0,
  };
  let stderr = "";
  const pending = new Map<string, string>();
  try {
    for await (const m of query({ prompt: spec.prompt, options: { ...options, stderr: (s) => (stderr += s) } })) {
      if (m.type === "system" && m.subtype === "init") {
        r.init = {
          cwd: short(m.cwd),
          commands: m.slash_commands.filter((s) => MINE.test(s) && !m.skills.includes(s)), // skills are listed there too
          skills: m.skills.filter((s) => MINE.test(s)),
          agents: (m.agents ?? []).filter((s) => MINE.test(s)),
          mcp: m.mcp_servers.map((s) => s.name),
        };
        emit?.("init", r.init);
      }
      if (m.type === "assistant")
        for (const b of m.message.content) {
          if (b.type === "tool_use" && b.name === "Bash") pending.set(b.id, String((b.input as any).command ?? ""));
          if (b.type === "text" && b.text.trim()) emit?.("assistant", { text: short(b.text).slice(0, 800) });
        }
      if (m.type === "user" && Array.isArray(m.message.content))
        for (const b of m.message.content as any[]) {
          if (b.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
          const bash = { command: short(pending.get(b.tool_use_id)!), ran: !b.is_error, output: short(text).slice(0, 200) };
          r.bash.push(bash);
          emit?.("bash", bash);
        }
      if (m.type === "result") {
        r.answer = m.subtype === "success" ? short(m.result).slice(0, 400) : m.subtype;
        r.denials = m.permission_denials.map((d) => d.tool_name);
        r.cost = m.total_cost_usd;
      }
    }
  } catch (err) {
    r.error = short(stderr.trim().split("\n").at(-1) || errText(err));
  }
  // Claude Code's own warnings about the config (e.g. rules it ignored), from its stderr.
  r.warnings = stderr
    .split("\n")
    .filter((l) => /ignor|trust|project-config-root/i.test(l))
    .map((l) => short(l).slice(0, 300));
  if (existsSync(run.hookLog))
    r.hooks = readFileSync(run.hookLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((h: Hook) => ({ ...h, CLAUDE_PROJECT_DIR: short(h.CLAUDE_PROJECT_DIR ?? ""), cwd: short(h.cwd) }));
  r.note = spec.note?.(r);
  run.done();
  return r;
}

function rowsRoute(specs: Spec[]) {
  return async (req: Request, res: Response) => {
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    try {
      await ensureLab();
      // order: the row's place in the list. The rows finish in any order; the tab sorts them back.
      await Promise.all(specs.map(async (s, order) => send("row", { ...(await runSession(s, abort)), order, at: Date.now() - startedAt })));
    } catch (err) {
      send("error", { message: errText(err) });
    } finally {
      send("done", {});
      res.end();
    }
  };
}
// #endregion

// #region where
// Where does each piece of config come from? The same question in every row; only cwd and projectConfigRoot change.
const WORD = "What is the project code word in your instructions (from CLAUDE.md)? Reply with the word only. Do not use tools.";
const sawScript = (r: Out) => [...new Set(r.hooks.map((h) => h.script))].join(" + ") || "no hook";

const WHERE: Spec[] = [
  { key: "repo", label: "the trusted checkout itself", cwd: REPO, prompt: WORD, note: () => "The baseline: everything is the trusted checkout's." },
  {
    key: "pr",
    label: "the PR worktree, no option",
    cwd: PR,
    prompt: WORD,
    note: (r) => `Everything comes from the branch: its commands, its .mcp.json, its settings, and its hook ran (${sawScript(r)}).`,
  },
  {
    key: "prRoot",
    label: "the PR worktree + projectConfigRoot",
    cwd: PR,
    root: REPO,
    prompt: WORD,
    note: (r) => `Commands, skills, agents, .mcp.json, both settings files and the hook come from the root. The hook runs IN the root. But the code word is ${r.answer || "?"}: CLAUDE.md still comes from cwd.`,
  },
  {
    key: "docs",
    label: "a worktree without .claude, no option",
    cwd: DOCS,
    prompt: WORD,
    note: () => "A git worktree without its own .claude/: Claude Code falls back to the main checkout's commands, skills and agents. Not to its settings, hooks or .mcp.json.",
  },
  { key: "docsRoot", label: "a worktree without .claude + projectConfigRoot", cwd: DOCS, root: REPO, prompt: WORD, note: () => "With the option, all of the root's config loads, settings and hooks too." },
  {
    key: "noSources",
    label: "the PR worktree + projectConfigRoot + settingSources: []",
    cwd: PR,
    root: REPO,
    prompt: WORD,
    options: { settingSources: [] },
    note: () => "settingSources: [] loads no settings files and no project config, wherever they are. The option changes WHERE from, not WHETHER. CLAUDE.md is skipped too.",
  },
];
// #endregion

// #region takeover
// A PR branch tries to grant itself Bash (permissions.allow) and runs a hook. Trust is what the terminal's trust
// dialog stores in .claude.json; a git worktree shares the main checkout's trust.
const RUN_BASH = 'Run exactly this with the Bash tool: node -e "console.log(42)". Then reply with its output, or with the error, in one line.';

const TAKEOVER: Spec[] = [
  {
    key: "untrusted",
    label: "no option, the main checkout not trusted",
    cwd: PR,
    trust: null,
    prompt: RUN_BASH,
    options: { tools: ["Bash"] },
    note: (r) => `The branch's allow rules are ignored (not trusted), so Bash is denied. But its hook ran anyway${r.hooks.some((h) => h.sawApiKey) ? ", with ANTHROPIC_API_KEY in its env" : ""}: hooks do not wait for trust.`,
  },
  {
    key: "trusted",
    label: "no option, the main checkout trusted",
    cwd: PR,
    trust: REPO,
    prompt: RUN_BASH,
    options: { tools: ["Bash"] },
    note: (r) => `The worktree inherits the main checkout's trust, so the branch's "allow: ['Bash']" applies: ${r.bash.some((b) => b.ran) ? "Bash ran without asking" : "Bash did not run"}. The PR granted itself a tool.`,
  },
  {
    key: "trustedRoot",
    label: "projectConfigRoot, the main checkout trusted",
    cwd: PR,
    root: REPO,
    trust: REPO,
    prompt: RUN_BASH,
    options: { tools: ["Bash"] },
    note: (r) => `The rules and hooks come from the trusted checkout, which allows nothing: ${r.denials.length ? "Bash is denied" : "Bash was not denied"}. Only the trusted hook ran. The branch's code is still what Claude reads and edits.`,
  },
  {
    key: "trustWorktree",
    label: "no option, only the worktree folder trusted",
    cwd: PR,
    trust: PR,
    prompt: RUN_BASH,
    options: { tools: ["Bash"] },
    note: () => "Trusting the worktree's own path is not enough: Claude Code looks up trust under the main checkout.",
  },
];
// #endregion

concept39.post("/where", rowsRoute(WHERE));
concept39.post("/takeover", rowsRoute(TAKEOVER));

// #region try
// One session with the combination the tab picked. The prompt can be a custom command: "/release" runs the
// release.md of whichever checkout the config comes from.
const PLACES = { repo: REPO, pr: PR, docs: DOCS } as const;
const ROOTS = { none: undefined, repo: REPO, pr: PR, relative: "../repo", missing: path.join(LAB, "no-such-folder") } as const;

const TryBody = z
  .object({
    cwd: z.enum(["repo", "pr", "docs"]),
    root: z.enum(["none", "repo", "pr", "relative", "missing"]),
    trust: z.boolean(),
    bash: z.boolean(),
    prompt: z.string().trim().min(1).max(2000),
  })
  .strict();

concept39.post("/try", async (req, res) => {
  const parsed = TryBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  try {
    if (!parsed.success) throw new Error(badRequest(parsed.error));
    await ensureLab();
    const b = parsed.data;
    const spec: Spec = { key: "try", label: "your combination", cwd: PLACES[b.cwd], root: ROOTS[b.root], trust: b.trust ? REPO : null, prompt: b.prompt, options: b.bash ? { tools: ["Bash"] } : {} };
    emit("options", { cwd: short(spec.cwd), projectConfigRoot: spec.root === undefined ? "(not set)" : short(spec.root), tools: spec.options?.tools ?? [], trust: spec.trust ? short(spec.trust) : "(nothing trusted)", prompt: b.prompt });
    const r = await runSession(spec, abort, emit);
    emit("summary", r);
  } catch (err) {
    emit("error", { message: errText(err) });
  } finally {
    send("done", {});
    res.end();
  }
});
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept39.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
