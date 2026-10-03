/**
 * CONCEPT 18 — Sandbox: run Bash inside an OS sandbox
 *
 *   sandbox: { enabled: true }        -> Bash commands run in an OS-level sandbox (Seatbelt on macOS, bubblewrap on
 *                                       Linux/WSL, a separate user on native Windows): writes only inside cwd,
 *                                       reads everywhere except filesystem.denyRead, network only to allowedDomains
 *   failIfUnavailable                 -> what happens when the sandbox cannot start. Defaults to TRUE when you pass
 *                                       Options.sandbox (error result, no model call, then query() throws), to FALSE
 *                                       when the same object comes from settings/managedSettings (a stderr warning,
 *                                       then every command runs unsandboxed)
 *   autoAllowBashIfSandboxed          -> sandboxed commands skip canUseTool (default true)
 *   allowUnsandboxedCommands          -> whether the model's escape hatch, Bash input dangerouslyDisableSandbox: true,
 *                                       is honored (default true; it then goes through canUseTool)
 *   excludedCommands                  -> commands that always run outside the sandbox
 *   filesystem / network              -> extra rules (denyRead, allowWrite, allowedDomains…), merged with Read/Edit/
 *                                       WebFetch permission rules
 *
 * The only signal that the sandbox is NOT active is a line on stderr ("Sandbox disabled: …"): nothing in the init
 * message says so. Every run here captures stderr and forwards the sandbox lines.
 *
 * Part A: availability (three ways to ask for the sandbox, same machine).
 * Part B: one fixed Bash command per run, four sandbox configurations side by side. canUseTool records every ask and
 *   allows only that exact command; after the run the server checks the disk itself.
 *
 * Routes: /platform (GET), /availability (SSE), /run (SSE).
 * The browser sends ids and booleans, never a path or a command. Every body is checked with zod.
 */
import os from "node:os";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept18 = Router();

// Not "sandbox/": that folder belongs to Concept 3.
const LAB = path.resolve("sandbox-lab");

const HAIKU = "claude-haiku-4-5-20251001";

/** No settings files, no MCP: each difference you see comes from the sandbox options. */
const BASE: Options = {
  model: HAIKU,
  tools: ["Bash"],
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 3,
};

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

/** Forwards the stderr lines that mention the sandbox: they are the only place its status is reported. */
function sandboxStderr(send: (event: string, data: unknown) => void) {
  return (data: string) => {
    for (const line of data.split("\n")) if (/sandbox/i.test(line)) send("stderr", line.replace(/^[^\w]*(?=\w)/, "").trim());
  };
}

concept18.get("/platform", (_req, res) => {
  res.json({ platform: process.platform, release: os.release(), arch: process.arch });
});

// ---------------------------------------------------------------------------------------------
// Part A: is the sandbox available, and what happens when it is not
// ---------------------------------------------------------------------------------------------

const AvailabilityBody = z.object({ variant: z.enum(["option", "optionOpen", "settings"]) }).strict();
type Variant = z.infer<typeof AvailabilityBody>["variant"];

function availabilityOptions(variant: Variant): Options {
  const options: Options = { ...BASE, cwd: LAB, permissionMode: "dontAsk" };
  if (variant === "option") options.sandbox = { enabled: true };
  if (variant === "optionOpen") options.sandbox = { enabled: true, failIfUnavailable: false };
  if (variant === "settings") options.settings = { sandbox: { enabled: true } };
  return options;
}

concept18.post("/availability", async (req, res) => {
  const parsed = AvailabilityBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { variant } = parsed.data;
  await mkdir(LAB, { recursive: true });

  const options = availabilityOptions(variant);
  send("options", options);
  // No tool is needed: the sandbox is set up when the process starts, before the first turn.
  pipe(query({ prompt: "Reply with the single word: ok", options: { ...options, abortController: abort, stderr: sandboxStderr(send) } }));
});

// ---------------------------------------------------------------------------------------------
// Part B: one Bash command under four sandbox configurations
// ---------------------------------------------------------------------------------------------

const WRITE_OUTSIDE = "echo escaped > ../outside/escape.txt && echo written";

const COMMANDS = {
  writeInside: { command: "echo sandboxed > note.txt && cat note.txt", extra: "" },
  readOutside: { command: "cat ../outside/secret.txt", extra: "" },
  writeOutside: { command: WRITE_OUTSIDE, extra: "" },
  network: { command: 'curl -s -o /dev/null -w "%{http_code}" https://example.com', extra: "" },
  escapeHatch: { command: WRITE_OUTSIDE, extra: " Set dangerouslyDisableSandbox to true on the Bash call." },
};

const Config = z
  .object({
    enabled: z.boolean(),
    autoAllow: z.boolean(), // autoAllowBashIfSandboxed
    allowUnsandboxed: z.boolean(), // allowUnsandboxedCommands
    denySecret: z.boolean(), // filesystem.denyRead: [outside/secret.txt]
    allowExample: z.boolean(), // network.allowedDomains: ["example.com"]
    excludeCurl: z.boolean(), // excludedCommands: ["curl"]
  })
  .strict();
type Config = z.infer<typeof Config>;

const RunBody = z
  .object({
    column: z.number().int().min(0).max(3), // it becomes a folder name: sandbox-lab/column-N
    commandId: z.enum(["writeInside", "readOutside", "writeOutside", "network", "escapeHatch"]), // a key of COMMANDS
    config: Config,
  })
  .strict();

/** Each column has its own folder, so four parallel runs do not see each other's files. */
function dirs(column: number) {
  const root = path.join(LAB, `column-${column}`);
  return { root, project: path.join(root, "project"), outside: path.join(root, "outside") };
}

async function reset(column: number) {
  const { root, project, outside } = dirs(column);
  await rm(root, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, "readme.txt"), "This folder is cwd.\n");
  await writeFile(path.join(outside, "secret.txt"), "TOP-SECRET-42\n");
}

const exists = (file: string) => access(file).then(() => true, () => false);

/** What is on disk after the run: the proof of what the command really did, whatever the model says. */
async function disk(column: number) {
  const { project, outside } = dirs(column);
  return {
    "project/": (await readdir(project)).sort(),
    "outside/": (await readdir(outside)).sort(),
    noteInside: await exists(path.join(project, "note.txt")),
    escapeOutside: await exists(path.join(outside, "escape.txt")),
  };
}

/** Builds the sandbox object from the column's switches. failIfUnavailable: false, so every column also runs where there is no sandbox. */
function sandboxFor(config: Config, column: number): SandboxSettings | undefined {
  if (!config.enabled) return undefined;
  const { outside } = dirs(column);
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: config.autoAllow,
    allowUnsandboxedCommands: config.allowUnsandboxed,
    ...(config.denySecret && { filesystem: { denyRead: [path.join(outside, "secret.txt")] } }),
    ...(config.allowExample && { network: { allowedDomains: ["example.com"] } }),
    ...(config.excludeCurl && { excludedCommands: ["curl"] }),
  };
}

concept18.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { column, commandId, config } = parsed.data;
  const lab = COMMANDS[commandId];

  await reset(column);
  const sandbox = sandboxFor(config, column);
  const options: Options = { ...BASE, cwd: dirs(column).project, permissionMode: "default", ...(sandbox && { sandbox }) };
  send("options", options);

  /**
   * Every permission ask is shown to the browser. Only the lab command is allowed; anything else the model tries
   * is denied, so the columns stay comparable. If the sandbox auto-allows a command, this is never called.
   */
  const canUseTool: Options["canUseTool"] = async (toolName, input, { decisionReason, blockedPath }) => {
    const allowed = toolName === "Bash" && typeof input.command === "string" && input.command.trim() === lab.command;
    // blockedPath is absolute; relative to the column folder it fits on the card (e.g. outside\escape.txt).
    send("ask", { toolName, input, decisionReason, blockedPath: blockedPath && path.relative(dirs(column).root, blockedPath), allowed });
    return allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the lab command may run in this lab." };
  };

  const prompt = `Run exactly this one Bash command, once, and reply with its raw output only: ${lab.command}${lab.extra}`;
  async function* run() {
    yield* query({ prompt, options: { ...options, abortController: abort, canUseTool, stderr: sandboxStderr(send) } });
    send("disk", await disk(column));
  }
  pipe(run());
});
