/**
 * CONCEPT 7 — Hooks: PreToolUse / PostToolUse
 *
 * A hook is a function the SDK calls at a fixed point of the agent loop. You register them in `options.hooks`:
 *
 *   hooks: {
 *     PreToolUse:  [{ matcher: "Write|Edit", hooks: [myHook] }],   // before a tool runs
 *     PostToolUse: [{ hooks: [auditHook] }],                       // after it ran (no matcher = every tool)
 *   }
 *
 *   myHook(input, toolUseID, { signal }) -> Promise<HookJSONOutput>
 *
 * `matcher` is a regex tested against the tool name. `input` depends on the event:
 *   PreToolUse  -> { hook_event_name, tool_name, tool_input, tool_use_id, session_id, cwd, ... }
 *   PostToolUse -> the same plus { tool_response, duration_ms }
 *
 * What a hook can return:
 *   {}                                                        -> nothing to say, carry on
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *       permissionDecision: "allow" | "deny" | "ask",           -> decide the call before the permission system does
 *       permissionDecisionReason, updatedInput } }              -> the model reads the reason; updatedInput replaces the input
 *   { hookSpecificOutput: { hookEventName: "PostToolUse",
 *       additionalContext } }                                   -> extra text the model reads next to the tool result
 *   { continue: false, stopReason }                           -> stop the whole run after this tool call
 *
 * Hooks vs canUseTool (Concept 4): canUseTool is only asked for calls that would "ask". A PreToolUse hook sees
 * EVERY matching call (even read-only ones), runs first, and there is also PostToolUse, which canUseTool has no
 * equivalent for.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { query, type HookCallback, type HookCallbackMatcher, type HookEvent, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept07 = Router();

const HOOK_NAMES = ["audit", "guard", "stamp", "lint", "limit"] as const;
type HookName = (typeof HOOK_NAMES)[number];

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// Exactly what the tab sends: its five tools, the hook names, and a model and maxTurns.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    model: z.string().regex(/^claude-[a-z0-9.-]+$/, "a Claude model id").optional(),
    tools: z.array(z.enum(["Read", "Glob", "Write", "Edit", "Bash"])).max(5),
    hooks: z.array(z.enum(HOOK_NAMES)).max(5),
    maxTurns: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const STAMP = "<!-- written by the Agent SDK Lab, stamped by a PreToolUse hook -->";
const MAX_TOOL_CALLS = 3;

concept07.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const enabled = new Set(body.hooks);

  /** Wraps a hook so every call and its answer are streamed to the browser as a `hook` SSE event. */
  const traced =
    (name: HookName, fn: HookCallback): HookCallback =>
    async (input, toolUseID, opts) => {
      const output = await fn(input, toolUseID, opts);
      send("hook", { name, input, output, at: Date.now() });
      return output;
    };

  // audit: only observes. Returning {} means "no opinion", so the call continues exactly as before.
  const audit: HookCallback = async () => ({});

  // guard: the policy from Concept 4, written as a hook. It also says "allow", which grants the permission
  // that Write/Edit/Bash would otherwise need (with no canUseTool that call would be denied).
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as Record<string, unknown>;
    const decide = (permissionDecision: "allow" | "deny", permissionDecisionReason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision, permissionDecisionReason },
    });

    if (typeof toolInput.file_path === "string") {
      const rel = path.relative(SANDBOX, path.resolve(SANDBOX, toolInput.file_path));
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        return decide("deny", `Guard hook: ${input.tool_name} is only allowed inside sandbox/.`);
      }
    }
    if (input.tool_name === "Bash" && /\b(rm|del|rmdir|Remove-Item)\b/.test(String(toolInput.command))) {
      return decide("deny", "Guard hook: commands that delete files are not allowed.");
    }
    return decide("allow", "Guard hook: inside sandbox/ and not destructive.");
  };

  // stamp: updatedInput changes the call before it runs. The model asked for one content; the file gets another.
  // updatedInput is only applied together with permissionDecision "allow".
  const stamp: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as { file_path: string; content: string };
    if (!toolInput.file_path.endsWith(".md") || toolInput.content.startsWith(STAMP)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, content: `${STAMP}\n${toolInput.content}` },
      },
    };
  };

  // lint: PostToolUse can't undo the call, but it can talk to the model. additionalContext is read with the
  // tool result, so the model usually fixes the problem with another Write.
  const lint: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const toolInput = input.tool_input as { file_path: string; content: string };
    if (!toolInput.file_path.endsWith(".md") || /^Source: /m.test(toolInput.content)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Lint hook: ${path.basename(toolInput.file_path)} has no "Source: <file>" line. Every Markdown file must end with one naming the file it was based on. Rewrite the file with it.`,
      },
    };
  };

  // limit: `continue: false` ends the whole run (result.terminal_reason = "hook_stopped"). It does NOT block the
  // current call: that call, and any other call from the same turn, would still run. So the hook also denies it.
  // The counter lives in a closure, which is fine because a new set of hooks is created for every request.
  let toolCalls = 0;
  const limit: HookCallback = async () => {
    toolCalls++;
    if (toolCalls <= MAX_TOOL_CALLS) return {};
    const reason = `Limit hook: more than ${MAX_TOOL_CALLS} tool calls in one run.`;
    return {
      continue: false,
      stopReason: reason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };

  // Build options.hooks from the checkboxes. Several matchers can listen to the same event; they all run,
  // and when their decisions disagree, deny wins over ask, and ask wins over allow.
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { PreToolUse: [], PostToolUse: [] };
  const described: Record<string, { matcher?: string; hooks: string[] }[]> = { PreToolUse: [], PostToolUse: [] };
  const add = (event: "PreToolUse" | "PostToolUse", matcher: string | undefined, name: HookName, fn: HookCallback) => {
    hooks[event]!.push({ ...(matcher ? { matcher } : {}), hooks: [traced(name, fn)] });
    described[event].push({ ...(matcher ? { matcher } : {}), hooks: [`[Function ${name}]`] });
  };
  if (enabled.has("audit")) add("PreToolUse", undefined, "audit", audit);
  if (enabled.has("audit")) add("PostToolUse", undefined, "audit", audit);
  if (enabled.has("guard")) add("PreToolUse", "Write|Edit|Bash", "guard", guard);
  if (enabled.has("stamp")) add("PreToolUse", "Write", "stamp", stamp);
  if (enabled.has("lint")) add("PostToolUse", "Write", "lint", lint);
  if (enabled.has("limit")) add("PreToolUse", undefined, "limit", limit);

  const options: Options = {
    tools: body.tools,
    cwd: SANDBOX,
    permissionMode: "default", // no canUseTool and no allowedTools: only hooks can let Write/Edit/Bash run
    hooks,
    settingSources: [], // isolation, as in Concept 3 (also: no hooks from your own settings files)
    strictMcpConfig: true,
  };
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;

  // Functions can't be serialized, so show which hook sits under which matcher instead.
  send("options", { ...options, hooks: described });

  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});

// Show the content of one sandbox file, so you can see what a hook changed (e.g. the stamp).
concept07.get("/file", async (req, res) => {
  const full = path.resolve(SANDBOX, String(req.query.path));
  const rel = path.relative(SANDBOX, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return void res.status(400).send("Outside sandbox/.");
  res.type("text/plain").send(await readFile(full, "utf8").catch(() => "(file not found)"));
});
