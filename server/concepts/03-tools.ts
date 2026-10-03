/**
 * CONCEPT 3 — Built-in tools: letting the agent act
 *
 * Until now every run used `tools: []`. Here the agent gets Claude Code's built-in tools:
 *   - tools          -> which tools EXIST for the model: string[] or { type: "preset", preset: "claude_code" }
 *   - allowedTools   -> which of them run WITHOUT asking for permission (it does not add or remove tools)
 *   - permissionMode -> what happens to a call that is not pre-allowed:
 *                       "default" (ask; with no canUseTool that means deny), "acceptEdits" (file edits are allowed),
 *                       "plan" (read-only, no changes), "dontAsk" (deny anything not pre-allowed),
 *                       "bypassPermissions" (allow everything; needs allowDangerouslySkipPermissions)
 *   - cwd            -> the folder the agent works in (default: process.cwd())
 *
 * A tool call shows up in the stream as a `tool_use` block in an `assistant` message, and its output as a
 * `tool_result` block in the following `user` message. Refused calls are listed in `result.permission_denials`.
 */
import { Router } from "express";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept03 = Router();

// The agent works in its own folder, so Write/Edit/Bash can't touch the app's source code.
// The browser only picks a key; it never sends a path.
export const SANDBOX = path.resolve("sandbox");
const cwds = { sandbox: SANDBOX, project: process.cwd() };

const SEED: Record<string, string> = {
  "notes.txt": [
    "Meeting notes — Agent SDK workshop",
    "- query() returns an async iterable of SDKMessage objects.",
    "- Options control the model, the system prompt and the limits.",
    "- Next session: built-in tools and permissions.",
    "TODO: prepare the Concept 4 demo (canUseTool).",
  ].join("\n"),
  "data/tasks.json": JSON.stringify(
    [
      { id: 1, title: "Install the SDK", done: true },
      { id: 2, title: "Try query()", done: true },
      { id: 3, title: "Give the agent tools", done: false },
    ],
    null,
    2,
  ),
};

async function resetSandbox() {
  await rm(SANDBOX, { recursive: true, force: true });
  for (const [file, content] of Object.entries(SEED)) {
    const full = path.join(SANDBOX, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content + "\n");
  }
}

async function listSandbox(dir = SANDBOX): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSandbox(full)));
    else out.push({ path: path.relative(SANDBOX, full).replaceAll("\\", "/"), bytes: (await stat(full)).size });
  }
  return out;
}

// Create the sandbox the first time the server starts.
await stat(SANDBOX).catch(() => resetSandbox());

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The form the tab sends. permissionMode is one of the tab's choices; bypassPermissions is allowed on purpose.
const Body = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(100).optional(),
    toolsMode: z.enum(["list", "preset"]),
    tools: z.array(z.string().regex(/^\w+$/, "a tool name")).max(50),
    allowedTools: z.array(z.string().trim().min(1).max(200)).max(50), // names or rules like Bash(ls:*)
    permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]).optional(),
    cwd: z.enum(["sandbox", "project"]), // a key of cwds, never a path
    maxTurns: z.number().int().positive().optional(),
  })
  .strict();

concept03.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;

  const options: Options = {
    tools: body.toolsMode === "preset" ? { type: "preset", preset: "claude_code" } : body.tools,
    allowedTools: body.allowedTools,
    cwd: cwds[body.cwd] ?? SANDBOX,
    // Isolation: without these, the run also inherits your own ~/.claude settings (extra allow rules,
    // plugins) and MCP servers, so tools you never listed can appear and calls you expect denied can pass.
    settingSources: [],
    strictMcpConfig: true,
  };
  if (body.permissionMode) options.permissionMode = body.permissionMode;
  // bypassPermissions is refused unless you also opt in explicitly.
  if (body.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;

  send("options", options);

  const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
  pipe(run);
});

// Show what the agent changed on disk, and put the sandbox back to its starting state.
concept03.get("/files", async (_req, res) => {
  res.json(await listSandbox());
});
concept03.post("/reset", async (_req, res) => {
  await resetSandbox();
  res.json(await listSandbox());
});
