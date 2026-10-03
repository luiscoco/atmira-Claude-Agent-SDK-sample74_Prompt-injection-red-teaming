/**
 * CONCEPT 23 — Plugins in depth: one folder that adds commands, agents, skills, hooks and an MCP server
 *
 * A plugin is a folder. `plugins: [{ type: "local", path }]` loads it, and every part is found by its place:
 *
 *   .claude-plugin/plugin.json   the manifest: name (the namespace), version, userConfig. Optional
 *   commands/standup.md          /atmira-ops:standup            (a slash command, also callable through Skill)
 *   agents/reviewer.md           subagent_type "atmira-ops:reviewer"
 *   skills/ticket-format/        Skill "atmira-ops:ticket-format"
 *   hooks/hooks.json             SessionStart + PreToolUse hooks that run node "${CLAUDE_PLUGIN_ROOT}/hooks/audit.mjs"
 *   .mcp.json                    MCP server "plugin:atmira-ops:tickets", tools mcp__plugin_atmira-ops_tickets__*
 *
 * Also shown: two plugins with the same command name, a plugin with a broken manifest (only reloadPlugins()
 * counts it), SdkPluginConfig.skipMcpDiscovery, strictMcpConfig (drops plugin MCP servers too), pluginDelivery
 * "initialize" + initializationResult().plugins_applied, manifest userConfig + settings.pluginConfigs, the host's
 * permissions against a plugin hook that approves tools, and q.reloadPlugins() in a live session.
 *
 * Every run gets a fake CLAUDE_CONFIG_DIR (plugins-lab/home), because Claude Code creates each plugin's data
 * folder (CLAUDE_PLUGIN_DATA) under <config dir>/plugins/data/. It authenticates with ANTHROPIC_API_KEY from .env.
 *
 * Routes: GET /plugins, POST /reset, POST /inventory (JSON, no model call), POST /run (SSE), POST /reload (SSE).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type Options, type Query, type SDKUserMessage, type SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept23 = Router();

const PLUGINS = path.resolve("plugins"); // committed: atmira-ops, atmira-extra, broken
const LAB = path.resolve("plugins-lab"); // recreated by the server (gitignored)
const HOME = path.join(LAB, "home"); // the fake CLAUDE_CONFIG_DIR
const WORK = path.join(LAB, "work"); // the agent's cwd: an empty folder
const LIVE = path.join(LAB, "live-plugin"); // a copy of atmira-ops that /reload edits
const MAX_RUN_MS = 120_000;
const MAX_PROMPT = 2000;

function resetLab() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WORK, { recursive: true });
}
resetLab();

const plugin = (name: string, extra: Partial<SdkPluginConfig> = {}): SdkPluginConfig => ({ type: "local", path: path.join(PLUGINS, name), ...extra });

// The plugin's MCP tools need an allow rule like any other MCP tool: loading a plugin does not approve its tools.
const MCP_RULE = "mcp__plugin_atmira-ops_tickets__*";

const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: WORK,
  settingSources: [], // no project or user settings: only the plugins listed below
  settings: { disableBundledSkills: true },
  plugins: [plugin("atmira-ops")],
  tools: ["Skill", "Agent"], // Skill runs plugin commands and skills, Agent runs plugin agents
  allowedTools: [MCP_RULE, "Skill", "Agent"],
  persistSession: false,
  maxTurns: 8,
};

// ---------------------------------------------------------------------------------------------
// GET /plugins: the plugin folders on disk
// ---------------------------------------------------------------------------------------------

/** Every file under a folder, relative to it. */
function filesOf(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? filesOf(full, base) : [path.relative(base, full).replaceAll("\\", "/")];
  });
}

/** Which part of a plugin a file is, from its place in the folder. */
function partOf(file: string) {
  if (file === ".claude-plugin/plugin.json") return "manifest";
  if (/^commands\/[^/]+\.md$/.test(file)) return "command";
  if (/^agents\/[^/]+\.md$/.test(file)) return "agent";
  if (/^skills\/[^/]+\/SKILL\.md$/.test(file)) return "skill";
  if (file === "hooks/hooks.json") return "hooks";
  if (file === ".mcp.json") return "mcp";
  return "file";
}

concept23.get("/plugins", (_req, res) => {
  const plugins = readdirSync(PLUGINS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(PLUGINS, d.name);
      const manifestPath = path.join(dir, ".claude-plugin", "plugin.json");
      let manifest: unknown = null;
      let manifestError: string | undefined;
      if (existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch (err) {
          manifestError = String(err);
        }
      }
      const files = filesOf(dir).map((file) => {
        const full = path.join(dir, file);
        return { file, part: partOf(file), content: statSync(full).size < 20_000 ? readFileSync(full, "utf8") : "(too big to show)" };
      });
      return { folder: `plugins/${d.name}`, name: d.name, manifest, manifestError, files };
    });
  res.json({ plugins });
});

concept23.post("/reset", (_req, res) => {
  resetLab();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Switches the browser can turn on (names only, checked against this list). Applied in this order.
// ---------------------------------------------------------------------------------------------

const SWITCHES: Record<string, (o: Options) => Options> = {
  // No plugin at all: the baseline.
  noPlugins: (o) => ({ ...o, plugins: [] }),
  // A second plugin, without a manifest, whose command has the same file name (commands/standup.md).
  extra: (o) => ({ ...o, plugins: [...(o.plugins ?? []), plugin("atmira-extra")] }),
  // A plugin whose plugin.json is invalid JSON.
  broken: (o) => ({ ...o, plugins: [...(o.plugins ?? []), plugin("broken")] }),
  // Load the plugin's commands, agents, skills and hooks, but NOT its .mcp.json.
  skipMcp: (o) => ({ ...o, plugins: (o.plugins ?? []).map((p) => (p.path.endsWith("atmira-ops") ? { ...p, skipMcpDiscovery: true } : p)) }),
  // Only MCP servers from the mcpServers option: plugin servers are dropped too.
  strict: (o) => ({ ...o, strictMcpConfig: true }),
  // Send the plugin list over stdin (initialize request) instead of one --plugin-dir flag per plugin.
  initialize: (o) => ({ ...o, pluginDelivery: "initialize" }),
  // A value for the manifest's userConfig option "team". The key is the plugin id: <name>@inline for local plugins.
  team: (o) => ({ ...o, settings: { ...(o.settings as object), pluginConfigs: { "atmira-ops@inline": { options: { team: "Nebula" } } } } }),
  // No allow rule for the plugin's MCP tools.
  noAllow: (o) => ({ ...o, allowedTools: (o.allowedTools ?? []).filter((t) => t !== MCP_RULE) }),
  // The plugin's own PreToolUse hook approves every tool (see plugins/atmira-ops/hooks/audit.mjs).
  autoApprove: (o) => ({ ...o, env: { ...o.env, ATMIRA_AUTO_APPROVE: "1" } }),
  // The host removes one of the plugin's tools.
  denyList: (o) => ({ ...o, disallowedTools: ["mcp__plugin_atmira-ops_tickets__list_tickets"] }),
};

// The request bodies. The browser sends only switch names from the list above, never code or paths.
const Switches = z
  .array(z.string().refine((x) => Object.hasOwn(SWITCHES, x), { message: `must be one of ${Object.keys(SWITCHES).join(", ")}` }))
  .max(20)
  .default([]);
const InventoryBody = z.object({ switches: Switches }).strict();
const RunBody = z.object({ prompt: z.string().trim().min(1).max(MAX_PROMPT), switches: Switches }).strict();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

/** `auditLog` is where the plugin's hook script appends one JSON line per call (it reads ATMIRA_AUDIT_LOG). */
function buildOptions(switches: string[], auditLog: string): Options {
  let options: Options = { ...BASE, env: { ...process.env, CLAUDE_CONFIG_DIR: HOME, ATMIRA_AUDIT_LOG: auditLog } };
  for (const s of Object.keys(SWITCHES)) if (switches.includes(s)) options = SWITCHES[s](options);
  return options;
}

/** Paths relative to the sample folder, so the tab can show them short. */
const short = (p: string) => path.relative(process.cwd(), p).replaceAll("\\", "/");

/** What to show of the options: no env values (it holds the API key), only the ones the lab adds. */
const describe = (options: Options, extra: object = {}) => ({
  ...options,
  cwd: short(options.cwd!),
  plugins: options.plugins?.map((p) => ({ ...p, path: short(p.path) })),
  env: {
    "...process.env": "…",
    ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([k]) => ["CLAUDE_CONFIG_DIR", "ATMIRA_AUDIT_LOG", "ATMIRA_AUTO_APPROVE"].includes(k)).map(([k, v]) => [k, k === "ATMIRA_AUTO_APPROVE" ? v : short(v!)])),
  },
  ...extra,
});

/** A prompt input that never sends anything: the session starts, answers control requests, and costs nothing. */
async function* silent(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
}

/** Plugin MCP servers start in the background: wait until none is "pending" (up to 10 s). */
async function settledMcp(q: Query) {
  for (let i = 0; i < 20; i++) {
    const servers = await q.mcpServerStatus();
    if (!servers.some((s) => s.status === "pending")) return servers;
    await new Promise((r) => setTimeout(r, 500));
  }
  return q.mcpServerStatus();
}

const notBuiltin = <T extends { builtin?: boolean }>(list: T[]) => list.filter((c) => !c.builtin);

// ---------------------------------------------------------------------------------------------
// POST /inventory: what the session sees, from control requests only (no prompt is sent)
// ---------------------------------------------------------------------------------------------

concept23.post("/inventory", async (req, res) => {
  const parsed = InventoryBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: badRequest(parsed.error) });
  const { switches } = parsed.data;
  const auditLog = path.join(LAB, `audit-${Date.now()}.jsonl`);
  const options = buildOptions(switches, auditLog);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  const q = query({ prompt: silent(abort.signal), options: { ...options, abortController: abort } });
  try {
    const init = await q.initializationResult();
    const mcpServers = await settledMcp(q);
    // reloadPlugins() re-reads the same folders. It is the only call that reports plugins that failed to load.
    const reload = await q.reloadPlugins();
    res.json({
      options: describe(options),
      plugins_applied: init.plugins_applied,
      commands: notBuiltin(init.commands),
      agents: init.agents,
      mcpServers: mcpServers.map(({ name, status, scope, source, error, tools }) => ({ name, status, scope, source, error, tools: tools?.map((t) => t.name) })),
      plugins: reload.plugins.map((p) => ({ ...p, path: p.path === "builtin" ? p.path : short(p.path) })),
      error_count: reload.error_count,
      audit: readAudit(auditLog),
    });
    console.log(`[c23] inventory switches=${switches.join(",") || "-"} plugins=${reload.plugins.length} errors=${reload.error_count}`);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(timer);
    q.close();
    rmSync(auditLog, { force: true });
  }
});

/** The lines the plugin's hook script wrote, with the paths made short. */
function readAudit(file: string, from = 0) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(from)
    .map((l) => {
      const line = JSON.parse(l);
      line.pluginEnv = Object.fromEntries(Object.entries(line.pluginEnv ?? {}).map(([k, v]) => [k, typeof v === "string" && v.includes("/") ? short(v) : v]));
      return line;
    });
}

// ---------------------------------------------------------------------------------------------
// POST /run: one prompt
// ---------------------------------------------------------------------------------------------

// A host hook next to the plugin's hooks. Subagents run in the background by default in this SDK version
// (Concept 8), so this one keeps the plugin's reviewer agent in the foreground. Both hooks run on the same call.
const foreground: HookCallback = async (input) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...(input as { tool_input: Record<string, unknown> }).tool_input, run_in_background: false },
  },
});

concept23.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return res.end();
  }
  const { prompt, switches } = parsed.data;
  const auditLog = path.join(LAB, `audit-${Date.now()}.jsonl`);
  const options: Options = { ...buildOptions(switches, auditLog), hooks: { PreToolUse: [{ matcher: "Agent", hooks: [foreground] }] } };
  send("options", describe(options, { hooks: { PreToolUse: [{ matcher: "Agent", hooks: ["[Function foreground]"] }] } }));

  const label = `[c23] ${JSON.stringify(prompt.slice(0, 40))} switches=${switches.join(",") || "-"}`;
  console.log(`${label} started`);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  res.on("close", () => {
    clearTimeout(timer);
    rmSync(auditLog, { force: true });
  });

  const q = query({ prompt, options: { ...options, abortController: abort } });
  let seen = 0;
  const flushAudit = () => {
    const lines = readAudit(auditLog, seen);
    seen += lines.length;
    for (const line of lines) send("audit", line);
  };

  async function* run() {
    if (switches.includes("initialize")) send("control", { plugins_applied: (await q.initializationResult()).plugins_applied });
    for await (const msg of q) {
      flushAudit(); // the plugin's hooks have run before the message that follows them
      yield msg;
      if (msg.type === "result") {
        console.log(`${label} ${msg.subtype} turns=${msg.num_turns} $${msg.total_cost_usd.toFixed(4)}`);
        return;
      }
    }
  }
  pipe(run());
});

// ---------------------------------------------------------------------------------------------
// POST /reload: q.reloadPlugins() in a live session, on a copy of atmira-ops
// ---------------------------------------------------------------------------------------------

const LIVE_COMMAND = `---
description: A command written while the session was running.
---

Answer with exactly this line and nothing else:
⚡ live command (written after the session started, loaded by reloadPlugins())
`;

const LIVE_AGENT = `---
name: summarizer
description: Summarizes a text in one line. Written while the session was running.
model: haiku
tools: []
---

Summarize the text you get in one line that starts with "📝".
`;

concept23.post("/reload", (req, res) => {
  const { abort, send, pipe } = openSse(req, res);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  res.on("close", () => clearTimeout(timer));

  // A fresh copy each time, so the committed plugin is never edited. Its name is still atmira-ops (from plugin.json).
  rmSync(LIVE, { recursive: true, force: true });
  cpSync(path.join(PLUGINS, "atmira-ops"), LIVE, { recursive: true });
  const auditLog = path.join(LAB, `audit-${Date.now()}.jsonl`);
  const options: Options = { ...buildOptions([], auditLog), plugins: [{ type: "local", path: LIVE }] };
  send("options", describe(options, { prompt: "[AsyncIterable<SDKUserMessage>]" }));

  let push: ((m: SDKUserMessage) => void) | undefined;
  // One prompt, then the input stays open: the session must still answer control requests after the result.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield await new Promise<SDKUserMessage>((resolve) => (push = resolve));
    yield* silent(abort.signal);
  }
  const q = query({ prompt: input(), options: { ...options, abortController: abort } });
  const commandNames = (list: { name: string; builtin?: boolean }[]) => notBuiltin(list).map((c) => c.name);
  const pluginAgents = (list: { name: string }[]) => list.map((a) => a.name).filter((n) => n.includes(":"));

  async function* run() {
    send("step", { step: "1. Session open (no prompt yet)", commands: commandNames(await q.supportedCommands()), agents: pluginAgents(await q.supportedAgents()) });

    writeFileSync(path.join(LIVE, "commands", "live.md"), LIVE_COMMAND);
    writeFileSync(path.join(LIVE, "agents", "summarizer.md"), LIVE_AGENT);
    send("step", {
      step: "2. Wrote commands/live.md and agents/summarizer.md, asked again",
      commands: commandNames(await q.supportedCommands()),
      agents: pluginAgents(await q.supportedAgents()),
    });

    const reloaded = await q.reloadPlugins({ holdOnCacheImpact: true });
    send("step", {
      step: "3. await q.reloadPlugins({ holdOnCacheImpact: true })",
      commands: commandNames(reloaded.commands),
      agents: pluginAgents(reloaded.agents),
      held: reloaded.held,
      error_count: reloaded.error_count,
    });

    push?.({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "/atmira-ops:live" } });
    send("step", { step: '4. Sent the prompt "/atmira-ops:live"' });
    // next() by hand: a `break` out of for-await would call q.return() and end the session before step 5.
    const messages = q[Symbol.asyncIterator]();
    for (;;) {
      const { value: msg, done } = await messages.next();
      if (done) return;
      yield msg;
      if (msg.type === "result") break;
    }

    // An edited .mcp.json: a second server with the same program. reloadPlugins() does not pick it up.
    const mcpFile = path.join(LIVE, ".mcp.json");
    const mcp = JSON.parse(readFileSync(mcpFile, "utf8"));
    mcp.mcpServers.tickets2 = mcp.mcpServers.tickets;
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));
    const again = await q.reloadPlugins();
    send("step", { step: '5. Added a server "tickets2" to .mcp.json, then await q.reloadPlugins()', mcpServers: again.mcpServers.map((s) => `${s.name} (${s.status})`) });
    q.close();
    rmSync(auditLog, { force: true });
  }
  pipe(run());
});
