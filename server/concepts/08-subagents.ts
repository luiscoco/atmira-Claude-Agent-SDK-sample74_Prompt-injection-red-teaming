/**
 * CONCEPT 8 — Subagents: options.agents + the Agent tool
 *
 * A subagent is a second agent loop that the main agent starts with the built-in `Agent` tool. You define them in
 * `options.agents`, keyed by name:
 *
 *   agents: {
 *     researcher: {
 *       description: "Reads files and answers questions about them.",  // the main agent reads this to pick one
 *       prompt: "You are a researcher...",                              // the subagent's system prompt
 *       tools: ["Read", "Glob", "Grep"],                                // omit = inherit every tool of the parent
 *       model: "haiku",                                                 // alias, full id, or "inherit"
 *     },
 *   }
 *
 * The main agent calls   Agent({ subagent_type: "researcher", description, prompt })
 * The subagent starts with a FRESH context: it only sees its own system prompt and that `prompt`. It works with
 * its own tools and returns one final report, which comes back to the main agent as the Agent tool_result.
 *
 * In the message stream, everything the subagent does has `parent_tool_use_id` = the id of that Agent tool_use.
 * Main-thread messages have `parent_tool_use_id: null`. By default only the subagent's tool_use / tool_result
 * blocks are forwarded; `forwardSubagentText: true` also forwards its text, so you can render a nested transcript.
 * The run also emits `system/task_started` and `system/task_notification` messages for every subagent.
 *
 * Foreground vs background: in this SDK version the Agent tool runs subagents IN THE BACKGROUND by default
 * (its input has `run_in_background`, which the model usually leaves unset). Then the Agent tool_result is only
 * "Async agent launched", the first `result` arrives before the subagent is done, and the report comes later in
 * `task_notification.summary`, followed by a second main-agent turn and a second `result`.
 * The `foreground` hook below (a Concept 7 PreToolUse hook with updatedInput) forces `run_in_background: false`,
 * so the main agent waits and the report is the Agent tool_result itself.
 */
import { Router } from "express";
import { z } from "zod";
import { query, type AgentDefinition, type HookCallback, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept08 = Router();

const AGENT_NAMES = ["researcher", "writer", "critic"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

// Three subagents, each showing a different setting of AgentDefinition.
const definitions: Record<AgentName, AgentDefinition> = {
  // Read-only tools and a cheaper model: a specialist that can't change anything.
  researcher: {
    description: "Reads files in the working folder and answers questions about their content. Cannot modify files.",
    prompt:
      "You are a researcher. Use Read, Glob and Grep to find the answer in the files of the working folder. " +
      "Reply with a short, factual report and name the files you used. Never guess.",
    tools: ["Read", "Glob", "Grep"],
    model: "haiku",
  },
  // The only one allowed to write. `model: "inherit"` uses the same model as the main agent.
  // Note: Claude Code refuses a subagent's Write of a report-like file (e.g. summary.md) with "Subagents should
  // return findings as text", so the scenarios ask for plain .txt files.
  writer: {
    description: "Creates or rewrites plain text files (.txt) in the working folder from material it is given.",
    prompt:
      "You are a technical writer. Write clear, concise plain text. Only create the files you were asked for, " +
      "inside the working folder. Reply with the path of each file you wrote.",
    tools: ["Read", "Write"],
    model: "inherit",
  },
  // No tools at all: a pure "second opinion" that only reasons over the text it is sent.
  critic: {
    description: "Reviews a piece of text sent in the prompt and returns concrete improvement suggestions. Has no tools.",
    prompt:
      "You are a strict reviewer. You only see the text in your prompt; you have no tools. " +
      "Return at most 3 concrete suggestions, most important first, or say it is fine as is.",
    tools: [],
  },
};

// Offered by Claude Code itself even with settingSources: []. They stay in the `agents` list of system/init,
// but the deny rules below make an Agent call to them fail.
const BUILT_IN_AGENTS = ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"];

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// Exactly what the tab sends: its five tools, the agent names, two switches, and a model and maxTurns.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    model: z.string().regex(/^claude-[a-z0-9.-]+$/, "a Claude model id").optional(),
    tools: z.array(z.enum(["Agent", "Read", "Glob", "Grep", "Write"])).max(5),
    agents: z.array(z.enum(AGENT_NAMES)).max(3),
    forwardSubagentText: z.boolean(),
    foreground: z.boolean(),
    maxTurns: z.number().int().min(1).max(50).optional(),
  })
  .strict();

concept08.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;

  // Concept 7's hooks, now on the two subagent events. They only observe, but they give us the agent_id
  // and (on stop) the subagent's last message without reading its transcript file.
  const traced =
    (fn: HookCallback): HookCallback =>
    async (input, toolUseID, opts) => {
      const output = await fn(input, toolUseID, opts);
      send("hook", { input, output, at: Date.now() });
      return output;
    };
  const observe: HookCallback = async () => ({});

  // foreground: rewrite every Agent call so the main agent blocks until the subagent's report is back.
  // updatedInput only takes effect together with permissionDecision "allow" (see Concept 7).
  const foreground: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as Record<string, unknown>;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, run_in_background: false },
      },
    };
  };

  const agents = Object.fromEntries(body.agents.map((name) => [name, definitions[name]]));

  const options: Options = {
    // `tools` is the pool for the whole session. The main agent needs "Agent" to delegate at all. A subagent gets
    // the overlap of its own `tools` and this pool, so a tool missing here is missing for every subagent too.
    tools: body.tools,
    agents,
    forwardSubagentText: body.forwardSubagentText,
    cwd: SANDBOX,
    // acceptEdits: file edits inside cwd are allowed, so the writer subagent can use Write without canUseTool.
    // Subagents run under the same permission rules as the main agent.
    permissionMode: "acceptEdits",
    hooks: {
      PreToolUse: body.foreground ? [{ matcher: "Agent|Task", hooks: [traced(foreground)] }] : [],
      SubagentStart: [{ hooks: [traced(observe)] }],
      SubagentStop: [{ hooks: [traced(observe)] }],
    },
    // Isolation matters even more here: without it, agents from your own ~/.claude/agents/ folder would also be
    // offered to the model next to the ones defined above. The built-in ones (general-purpose, Explore, Plan, ...)
    // are always offered; see the `agents` list of the system/init message.
    settingSources: [],
    strictMcpConfig: true,
    // The built-in subagents compete with ours (the model often picks general-purpose). A permission rule
    // "Agent(<name>)" blocks one subagent type without removing the Agent tool itself.
    disallowedTools: BUILT_IN_AGENTS.map((name) => `Agent(${name})`),
  };
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;

  // Functions can't be serialized, so show which hook sits under which event instead.
  send("options", {
    ...options,
    hooks: {
      PreToolUse: body.foreground ? [{ matcher: "Agent|Task", hooks: ["[Function foreground]"] }] : [],
      SubagentStart: [{ hooks: ["[Function observe]"] }],
      SubagentStop: [{ hooks: ["[Function observe]"] }],
    },
  });

  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});

// The browser shows the definitions, so they live in one place.
concept08.get("/agents", (_req, res) => {
  res.json(definitions);
});
