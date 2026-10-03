/**
 * CONCEPT 16 — Settings & env: what the Claude Code process is configured with
 *
 * Part A: env
 *   env omitted              -> the subprocess inherits process.env (ANTHROPIC_API_KEY from .env included)
 *   env: { ...process.env, X } -> inherited variables plus yours
 *   env: { X }               -> REPLACES the environment: the API key is gone, so the run silently falls back to the login
 *   env: { KEY: undefined }  -> removes one inherited variable
 *   CLAUDE_AGENT_SDK_CLIENT_APP -> identifies your app in the User-Agent header
 *
 * Part B: the settings layers (low -> high precedence)
 *   settingSources   -> which settings files are read: "user" (~/.claude), "project" (.claude/settings.json),
 *                       "local" (.claude/settings.local.json); [] = none; omitted = all three
 *   settings         -> the "flag" layer (like --settings): an object or a path to a JSON file, above the files
 *   managedSettings  -> the policy tier, filtered to restrictive keys only (deny rules, locks); others are dropped
 *   resolveSettings() -> @alpha: the merged result and which source set each top-level key, without starting Claude
 *   settings.env wins over Options.env; Options.model wins over settings.model.
 *
 * Part C: file access
 *   additionalDirectories -> extra folders the agent may read and edit besides cwd
 *   permissions.deny      -> a rule from project settings that blocks a file, even for a model that tries other tools
 *
 * Routes: /files (GET), /env-run (SSE), /resolve (JSON), /layers-run (SSE), /access-run (SSE).
 * The browser only sends keys and JSON settings, never a path. Every body is checked with zod.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { query, resolveSettings, type Options, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept16 = Router();

// cwd of every run: a folder with its own .claude/settings.json and .claude/settings.local.json.
const LAB = path.resolve("settings-lab");
const PROJECT = path.join(LAB, "project");
const SHARED = path.join(LAB, "shared"); // outside cwd: only reachable with additionalDirectories
const FLAG_FILE = path.join(LAB, "flag-settings.json");

const HAIKU = "claude-haiku-4-5-20251001";

/**
 * Bash can only run printenv and echo, and nothing else is pre-approved: "dontAsk" denies the rest.
 * No settings files unless a part asks for them, so each difference you see comes from one option.
 */
const BASE: Options = {
  model: HAIKU,
  cwd: PROJECT,
  tools: ["Bash", "Read"],
  allowedTools: ["Bash(printenv:*)", "Bash(echo:*)"],
  permissionMode: "dontAsk",
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 4,
};

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

/** One `echo NAME=$(printenv NAME)` per variable, so a missing variable shows as an empty value, not an error. */
function printenvPrompt(vars: string[], extra: string[] = []) {
  const command = [...vars.map((v) => `echo "${v}=$(printenv ${v})"`), ...extra].join("; ");
  return `Run exactly this one Bash command and reply with its raw output only, nothing else: ${command}`;
}

/** Hides values such as API keys that may appear in the user's own settings files. */
function mask(value: unknown, key = ""): unknown {
  if (typeof value === "string" && /key|token|secret|password|auth/i.test(key)) return value ? `${value.slice(0, 4)}…(hidden)` : value;
  if (Array.isArray(value)) return value.map((v) => mask(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  return value;
}

/**
 * The options as the UI shows them. `env` would print the whole server environment (API key included), so the
 * inherited part is summarized and only the variables that differ from process.env are listed.
 */
function echo(options: Options) {
  if (!options.env) return options;
  const env = options.env;
  const inherited = Object.keys(env).filter((k) => env[k] !== undefined && env[k] === process.env[k]);
  const changed = Object.fromEntries(Object.entries(env).filter(([k]) => !inherited.includes(k)).map(([k, v]) => [k, v === undefined ? "undefined (removed)" : mask(v, k)]));
  const summary = inherited.length ? { "...process.env": `${inherited.length} inherited variables` } : {};
  return { ...options, env: { ...summary, ...changed } };
}

concept16.get("/files", async (_req, res) => {
  const read = (file: string) => readFile(file, "utf8").catch(() => "(missing)");
  res.json({
    project: await read(path.join(PROJECT, ".claude", "settings.json")),
    local: await read(path.join(PROJECT, ".claude", "settings.local.json")),
    flagFile: await read(FLAG_FILE),
  });
});

// ---------------------------------------------------------------------------------------------
// Part A: env
// ---------------------------------------------------------------------------------------------

const EnvBody = z
  .object({
    variant: z.enum(["omitted", "spread", "only", "removeKey"]),
    team: z.string().trim().min(1).max(100), // the value of LAB_TEAM
  })
  .strict();

concept16.post("/env-run", (req, res) => {
  const parsed = EnvBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { variant, team } = parsed.data;

  const options: Options = { ...BASE };
  const app = "atmira-lab/16";
  if (variant === "spread") options.env = { ...process.env, LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
  if (variant === "only") options.env = { LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
  if (variant === "removeKey") options.env = { ...process.env, ANTHROPIC_API_KEY: undefined, LAB_TEAM: team };

  send("options", { ...echo(options), parentHasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
  // The key itself is never printed, only whether the subprocess has it.
  const keyCheck = 'echo "ANTHROPIC_API_KEY is $(printenv ANTHROPIC_API_KEY > /dev/null && echo set || echo unset)"';
  const prompt = printenvPrompt(["LAB_TEAM", "CLAUDE_AGENT_SDK_CLIENT_APP"], [keyCheck]);
  pipe(query({ prompt, options: { ...options, abortController: abort } }));
});

// ---------------------------------------------------------------------------------------------
// Part B: settings layers
// ---------------------------------------------------------------------------------------------

const LayersBody = z
  .object({
    omit: z.boolean().optional(), // the tab's checkbox; the server only reads sources
    sources: z.array(z.enum(["user", "project", "local"])).max(3).nullable(), // null = omit settingSources (all three)
    flag: z.enum(["none", "inline", "file"]),
    flagJson: z.string().max(10_000),
    managedJson: z.string().max(10_000),
    optionsEnvLayer: z.string().max(200), // "" = no Options.env
  })
  .strict();
type LayersBody = z.infer<typeof LayersBody>;

function parse(json: string, name: string): Settings | undefined {
  if (!json.trim()) return undefined;
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
  }
}

function layersOptions(body: LayersBody): Options {
  const options: Options = { ...BASE };
  if (body.sources) options.settingSources = body.sources;
  else delete options.settingSources;
  if (body.flag === "inline") options.settings = parse(body.flagJson, "settings");
  if (body.flag === "file") options.settings = FLAG_FILE;
  const managed = parse(body.managedJson, "managedSettings");
  if (managed) options.managedSettings = managed;
  if (body.optionsEnvLayer) options.env = { ...process.env, LAB_LAYER: body.optionsEnvLayer };
  return options;
}

// Same merge engine as the CLI, but nothing is started and nothing is billed.
concept16.post("/resolve", async (req, res) => {
  const parsed = LayersBody.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
  try {
    const options = layersOptions(parsed.data);
    const startedAt = Date.now();
    const resolved = await resolveSettings({ cwd: options.cwd, settingSources: options.settingSources, managedSettings: options.managedSettings });
    res.json({
      took: Date.now() - startedAt,
      call: { cwd: options.cwd, settingSources: options.settingSources ?? "(omitted: all)", managedSettings: options.managedSettings },
      // resolveSettings() has no `settings` input: the flag layer is applied on top only when query() runs.
      flag: options.settings ?? null,
      effective: mask(resolved.effective),
      provenance: resolved.provenance,
      sources: resolved.sources.map((s) => ({ ...s, settings: mask(s.settings) })),
    });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

concept16.post("/layers-run", (req, res) => {
  const parsed = LayersBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  let options: Options;
  try {
    options = layersOptions(parsed.data);
  } catch (err) {
    send("error", { message: String(err) });
    send("done", {});
    return res.end();
  }
  send("options", echo(options));
  const prompt = printenvPrompt(["LAB_LAYER", "LAB_PROJECT_NOTE", "LAB_LOCAL_NOTE"]);
  pipe(query({ prompt, options: { ...options, abortController: abort } }));
});

// ---------------------------------------------------------------------------------------------
// Part C: additionalDirectories and permissions.deny
// ---------------------------------------------------------------------------------------------

const FILES = {
  readme: path.join(PROJECT, "readme.txt"), // inside cwd
  secret: path.join(PROJECT, "secret.txt"), // inside cwd, denied by project settings
  glossary: path.join(SHARED, "glossary.txt"), // outside cwd
};

const AccessBody = z
  .object({
    file: z.enum(["readme", "secret", "glossary"]), // a key of FILES, never a path
    projectSettings: z.boolean(),
    additionalDir: z.boolean(),
  })
  .strict();

concept16.post("/access-run", (req, res) => {
  const parsed = AccessBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { file, projectSettings, additionalDir } = parsed.data;

  const options: Options = { ...BASE };
  if (projectSettings) options.settingSources = ["project"];
  if (additionalDir) options.additionalDirectories = [SHARED];

  send("options", echo(options));
  const prompt = `Read the file ${FILES[file]} with the Read tool and quote its content. If you cannot, say why in one sentence.`;
  pipe(query({ prompt, options: { ...options, abortController: abort } }));
});
