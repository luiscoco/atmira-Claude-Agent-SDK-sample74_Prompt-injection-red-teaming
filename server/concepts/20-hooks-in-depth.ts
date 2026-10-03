/**
 * CONCEPT 20 — Hooks in depth: the whole agent loop, not only tool calls
 *
 * Concept 7 used PreToolUse / PostToolUse. options.hooks accepts every name in HOOK_EVENTS (33 in 0.3.281).
 * The ones that reach an SDK callback in a normal query() run, in the order they fire:
 *
 *   UserPromptSubmit     before the prompt reaches the model   -> additionalContext, decision: "block", continue: false
 *   PreToolUse           before a tool call                    -> permissionDecision, updatedInput, additionalContext
 *   PermissionRequest    the call would "ask" (no allow rule)  -> decision: { behavior: "allow" | "deny", message }
 *   PostToolUse          after a successful call               -> additionalContext, updatedToolOutput (what the model sees)
 *   PostToolUseFailure   after a call that failed              -> additionalContext
 *   PostToolBatch        after all the calls of one turn       -> additionalContext
 *   SubagentStart / SubagentStop   around a subagent           -> additionalContext for the subagent
 *   MessageDisplay       each assistant text block             -> observe only
 *   Stop                 the model wants to finish             -> decision: "block" + reason = keep going
 *
 * Not delivered to callbacks here (tested): SessionStart, SessionEnd, PermissionDenied (a system/permission_denied
 * message is streamed instead). includeHookEvents adds no hook_* messages for callback hooks.
 *
 * Answers valid on every event:
 *   systemMessage   -> shown to the USER (a system/informational message), the model never sees it
 *   continue: false -> ends the run (stopReason)
 *   { async: true } -> "don't wait for me": the run continues and the result is ignored
 *
 * Failure modes: a hook that THROWS is ignored (fail open: the call runs). A hook slower than its matcher's
 * `timeout` is aborted through `signal` and the call is NOT executed (fail closed).
 *
 * Every run registers an `observer` on every event, so the timeline shows everything that fired, and the hooks
 * the browser picked on top of it. The browser sends hook names, never code or paths.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { HOOK_EVENTS, query, type HookCallback, type HookCallbackMatcher, type HookEvent, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept20 = Router();

const LAB = path.resolve("hooks-lab");

// The lab's files. config.env holds a fake key, to show updatedToolOutput redacting it.
const SEED: Record<string, string> = {
  "notes.txt": "Team offsite on Friday in Valencia.\nBudget approved: 1200 EUR.\nOwner: Marta.\n",
  "config.env": "DB_HOST=db.internal\nDB_USER=lab\nAPI_KEY=sk-live-4f9a2b7c1d8e\n",
};

function seed() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(LAB, { recursive: true });
  for (const [name, content] of Object.entries(SEED)) writeFileSync(path.join(LAB, name), content);
}
seed();

const SECRET = /sk-live-[a-z0-9]+/gi;
const SLOW_MS = 5000;
const TIMEOUT_S = 2;
const MAX_RUN_MS = 120_000;

/** The hooks the browser can turn on: which event, which matcher (tool events only), and the callback. */
type Hook = { event: HookEvent; matcher?: string; timeout?: number; fn: HookCallback };

/** `later(name, data)` sends an SSE event after the hook returned (used by the async hook). */
function buildHooks(later: (event: string, data: Record<string, unknown>) => void): Record<string, Hook> {
  return {
    // Every prompt gets extra context the model reads, without the user typing it.
    context: {
      event: "UserPromptSubmit",
      fn: async () => ({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "The user works in Finance. Give every amount in EUR and in USD (1 EUR = 1.10 USD).",
        },
      }),
    },

    // decision: "block" stops the prompt before the model sees it: 0 turns, $0. The reason is the result text.
    "block-secrets": {
      event: "UserPromptSubmit",
      fn: async (input) => {
        if (input.hook_event_name !== "UserPromptSubmit") return {};
        if (!/password|passwd|sk-live-/i.test(input.prompt)) return {};
        return { decision: "block", reason: "Block-secrets hook: prompts with passwords or keys are not sent to the model." };
      },
    },

    // continue: false works on any event. Here nothing runs at all.
    maintenance: {
      event: "UserPromptSubmit",
      fn: async () => ({ continue: false, stopReason: "Maintenance hook: the agent is closed until 18:00." }),
    },

    // updatedToolOutput replaces what the MODEL sees. The file on disk and the tool itself are not changed.
    // systemMessage tells the USER what happened; the model never reads it.
    redact: {
      event: "PostToolUse",
      matcher: "Read",
      fn: async (input) => {
        if (input.hook_event_name !== "PostToolUse") return {};
        const raw = JSON.stringify(input.tool_response);
        const found = raw.match(SECRET)?.length ?? 0;
        if (!found) return {};
        return {
          systemMessage: `Redact hook: hid ${found} secret(s) from the model.`,
          hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: JSON.parse(raw.replace(SECRET, "[REDACTED]")) },
        };
      },
    },

    // PostToolUse does not fire for a call that failed; PostToolUseFailure does, with the error text.
    "explain-failure": {
      event: "PostToolUseFailure",
      fn: async (input) => {
        if (input.hook_event_name !== "PostToolUseFailure") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext: "Explain-failure hook: old budget files were archived. The current budget is in notes.txt.",
          },
        };
      },
    },

    // PermissionRequest fires only for calls that would "ask" (Write/Edit/Bash with no allow rule and no canUseTool).
    // It is canUseTool as a hook: allow inside hooks-lab/, deny outside with a message the model reads.
    "approve-writes": {
      event: "PermissionRequest",
      fn: async (input) => {
        if (input.hook_event_name !== "PermissionRequest") return {};
        const file = (input.tool_input as { file_path?: unknown }).file_path;
        const rel = typeof file === "string" ? path.relative(LAB, path.resolve(LAB, file)) : "..";
        const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        return {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: inside
              ? { behavior: "allow" }
              : { behavior: "deny", message: "Approve-writes hook: only files inside hooks-lab/ can be written." },
          },
        };
      },
    },

    // Stop with decision: "block" sends `reason` to the model and the loop goes on. stop_hook_active is true when
    // this stop comes from an earlier block: letting it go then is what prevents an endless loop.
    "stop-gate": {
      event: "Stop",
      fn: async (input) => {
        if (input.hook_event_name !== "Stop" || input.stop_hook_active) return {};
        if (/^Source: \S+/m.test(input.last_assistant_message ?? "")) return {};
        return { decision: "block", reason: 'Stop-gate hook: end your answer with a line "Source: <file you read>".' };
      },
    },

    // SubagentStart's additionalContext goes to the SUBAGENT, not to the main agent.
    "subagent-brief": {
      event: "SubagentStart",
      fn: async () => ({
        hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "Answer in the form '<N> files: <names>'." },
      }),
    },

    // A guard with a bug: it means to deny reading config.env, but throws first. A throwing hook is ignored.
    crash: {
      event: "PreToolUse",
      matcher: "Read",
      fn: async (input) => {
        const file = (input as { tool_input: { file_path: string } }).tool_input.file_path;
        const rule = undefined as unknown as { denied: string[] };
        if (rule.denied.includes(path.basename(file))) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };
        return {};
      },
    },

    // A hook slower than its matcher's timeout: the SDK aborts `signal` and does not run the call.
    slow: {
      event: "PreToolUse",
      matcher: "Read",
      timeout: TIMEOUT_S,
      fn: (_input, _id, { signal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({}), SLOW_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error(`aborted by the SDK after the ${TIMEOUT_S} s matcher timeout`));
          });
        }),
    },

    // { async: true } returns at once; the run does not wait. The work goes on in the background.
    "async-log": {
      event: "PostToolUse",
      fn: async (input) => {
        const tool = (input as { tool_name: string }).tool_name;
        const startedAt = Date.now();
        setTimeout(() => later("async", { tool, startedAt, finishedAt: Date.now() }), 1500);
        return { async: true, asyncTimeout: 5000 };
      },
    },
  };
}

const TOOLS = ["Read", "Glob", "Write", "Agent"] as const;
const KNOWN_HOOKS = buildHooks(() => {}); // only to check names; each run builds its own hooks

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// Hook names and tool names only, never code or paths.
const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    hooks: z.array(z.string().refine((h) => Object.hasOwn(KNOWN_HOOKS, h), { message: "not a hook of this lab" })).max(11),
    tools: z.array(z.enum(TOOLS)).max(TOOLS.length),
    agents: z.boolean().optional(),
  })
  .strict();

concept20.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const startedAt = Date.now();
  let open = true;
  res.on("close", () => (open = false));

  const available = buildHooks((event, data) => open && send(event, { ...data, at: Date.now() - startedAt }));
  const picked = body.hooks;
  const tools: string[] = [...body.tools];

  /** Streams every call as a `hook` SSE event: input, output (or the error), and how long it took. */
  const traced =
    (name: string, fn: HookCallback): HookCallback =>
    async (input, toolUseID, opts) => {
      const t0 = Date.now();
      const { session_id, transcript_path, cwd, ...rest } = input as unknown as Record<string, unknown>;
      // A hook can still run after the browser left (async work, a slow abort): write only while it is connected.
      try {
        const output = await fn(input, toolUseID, opts);
        if (open) send("hook", { name, event: input.hook_event_name, input: rest, output, ms: Date.now() - t0, at: t0 - startedAt });
        return output;
      } catch (err) {
        if (open) send("hook", { name, event: input.hook_event_name, input: rest, error: String(err), ms: Date.now() - t0, at: t0 - startedAt });
        throw err;
      }
    };

  // The observer: one matcher with no matcher regex on every event, returning {}. It changes nothing.
  const observer: HookCallback = async () => ({});
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const described: Record<string, { matcher?: string; timeout?: number; hooks: string[] }[]> = {};
  const add = (event: HookEvent, name: string, fn: HookCallback, matcher?: string, timeout?: number) => {
    (hooks[event] ??= []).push({ ...(matcher && { matcher }), ...(timeout && { timeout }), hooks: [traced(name, fn)] });
    (described[event] ??= []).push({ ...(matcher && { matcher }), ...(timeout && { timeout }), hooks: [`[Function ${name}]`] });
  };
  for (const event of HOOK_EVENTS) add(event, "observer", observer);
  for (const name of picked) {
    const h = available[name];
    add(h.event, name, h.fn, h.matcher, h.timeout);
  }

  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    thinking: { type: "disabled" },
    tools,
    // Read-only tools run without asking; Write "asks", which is what makes PermissionRequest fire.
    allowedTools: tools.filter((t) => t !== "Write"),
    permissionMode: "default",
    cwd: LAB,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 8,
    hooks,
    ...(body.agents && {
      agents: {
        counter: {
          description: "Counts the files in the working folder.",
          prompt: "List the files with Glob and report how many there are.",
          tools: ["Glob"],
          model: "haiku",
        },
      },
    }),
  };

  // The observer is on all events, so only show where the picked hooks sit.
  send("options", {
    ...options,
    hooks: {
      "(every one of the HOOK_EVENTS)": [{ hooks: ["[Function observer]"] }],
      ...Object.fromEntries(Object.entries(described).map(([e, list]) => [e, list.filter((m) => m.hooks[0] !== "[Function observer]")]).filter(([, l]) => l.length)),
    },
  });
  send("events", { all: HOOK_EVENTS });

  // A run must never hang the tab: after MAX_RUN_MS the query is aborted. One log line per run helps diagnose.
  const label = `[c20] hooks=${picked.join(",") || "-"} tools=${tools.join(",") || "-"}`;
  console.log(`${label} started`);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  res.on("close", () => clearTimeout(timer));

  const q = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
  async function* run() {
    for await (const msg of q) {
      if (msg.type === "result") console.log(`${label} result/${msg.subtype} after ${Date.now() - startedAt} ms`);
      yield msg;
    }
  }
  pipe(run()).finally(() => console.log(`${label} closed after ${Date.now() - startedAt} ms${abort.signal.aborted ? " (aborted)" : ""}`));
});

// The lab's files and their content, to compare what the model saw with what is on disk.
concept20.get("/files", (_req, res) => {
  res.json(readdirSync(LAB).map((name) => ({ name, bytes: statSync(path.join(LAB, name)).size })));
});

concept20.get("/file", (req, res) => {
  const name = String(req.query.name);
  if (!readdirSync(LAB).includes(name)) return void res.status(404).send("Not a file of hooks-lab/.");
  res.type("text/plain").send(readFileSync(path.join(LAB, name), "utf8"));
});

concept20.post("/reset", (_req, res) => {
  seed();
  res.json({ ok: true });
});
