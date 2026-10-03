/**
 * CONCEPT 11 — Skills: from SKILL.md to loading skills into the agent
 *
 * Part A: fundamentals
 *   A skill is a FOLDER with a SKILL.md (YAML frontmatter + markdown instructions) and optional extra files.
 *   Progressive disclosure keeps it cheap:
 *     level 1  name + description      -> always in the model's context (the skill listing)
 *     level 2  SKILL.md body           -> injected only when the model calls the `Skill` tool (or the user types /name)
 *     level 3  other files in the folder -> read with Read/Bash only if the instructions say so
 *   `disable-model-invocation: true` hides a skill from the model; only the user can run it with /name.
 *
 * Part B: loading skills into the agent (what decides which skills exist and which ones the model sees)
 *   settingSources: ["project"] + cwd          -> discovers <cwd>/.claude/skills/<name>/SKILL.md
 *   plugins: [{ type: "local", path }]         -> discovers <plugin>/skills/<name>/SKILL.md, named "plugin:name"
 *   skills: "all" | string[]                   -> filters what the MODEL sees (context filter, not a sandbox)
 *   settings: { disableBundledSkills: true }   -> drops the skills that ship with Claude Code
 *   system/init.skills + q.supportedCommands() -> what was discovered
 *
 * Part C: advanced
 *   agents: { x: { skills: [...] } }           -> a subagent starts with the skill already in its context
 *   q.reloadSkills()                           -> re-scans the skill folders in a live session
 *
 * Routes: GET /skills, POST /invoke (SSE), POST /load (SSE), POST /subagent (SSE), POST /reload (SSE).
 */
import path from "node:path";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { Router, type Response } from "express";
import { z } from "zod";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept11 = Router();

const MODEL = "claude-haiku-4-5-20251001";
// A project whose .claude/skills/ holds three skills, and a plugin that ships a fourth one.
const PROJECT_DIR = path.resolve("skills-project");
const PLUGIN_DIR = path.resolve("skills-plugin");
const PLUGIN = { type: "local", path: PLUGIN_DIR } as const;

// The same base for every run, so only the skill-loading options change.
const BASE: Options = {
  model: MODEL,
  cwd: PROJECT_DIR,
  tools: ["Skill", "Read"], // Skill is the built-in tool that loads a skill's SKILL.md
  allowedTools: ["Read"], // skills read their data and extra files; no permission prompt for that
  maxTurns: 8,
  strictMcpConfig: true,
};

// Project skills + plugin skill, all visible, no bundled skills: the "everything on" setup.
const FULL: Options = {
  ...BASE,
  settingSources: ["project"],
  settings: { disableBundledSkills: true },
  plugins: [PLUGIN],
  skills: "all",
};

// Every POST body is checked first. A bad body gets an `error` event, then `done`, as in Concept 34.
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Prompt = z.string().trim().min(1).max(4000);
const PromptBody = z.object({ prompt: Prompt }).strict();

function refuse(send: (event: string, data: unknown) => void, res: Response, e: z.ZodError) {
  send("error", { message: badRequest(e) });
  send("done", {});
  res.end();
}

// ---------------------------------------------------------------------------------------------
// Part A: fundamentals
// ---------------------------------------------------------------------------------------------

/** A tiny frontmatter reader: `key: value` lines between the two `---`. Enough for these files. */
function parseSkillMd(text: string) {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter = Object.fromEntries(
    match[1].split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
  return { frontmatter, body: match[2].trim() };
}

async function readSkills(root: string, source: string) {
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  return Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const dir = path.join(root, d.name);
      const files = (await readdir(dir)).filter((f) => f !== "SKILL.md");
      const { frontmatter, body } = parseSkillMd(await readFile(path.join(dir, "SKILL.md"), "utf8"));
      return { folder: d.name, source, path: path.relative(process.cwd(), dir).replaceAll("\\", "/"), frontmatter, body, files };
    }),
  );
}

// Lets the tab show every skill on disk: frontmatter (level 1), body (level 2) and extra files (level 3).
concept11.get("/skills", async (_req, res) => {
  res.json([
    ...(await readSkills(path.join(PROJECT_DIR, ".claude", "skills"), "project")),
    ...(await readSkills(path.join(PLUGIN_DIR, "skills"), "plugin atmira-tools")),
  ]);
});

// Runs a prompt with every skill loaded, so the tab can show how each one gets invoked.
concept11.post("/invoke", (req, res) => {
  const parsed = PromptBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return refuse(send, res, parsed.error);
  const { prompt } = parsed.data;
  send("options", FULL);
  pipe(query({ prompt, options: { ...FULL, abortController: abort } }));
});

// ---------------------------------------------------------------------------------------------
// Part B: loading skills into the agent
// ---------------------------------------------------------------------------------------------

const VARIANTS = ["isolated", "project", "noBundled", "filtered", "plugin"] as const;
type Variant = (typeof VARIANTS)[number];
const LoadBody = z.object({ prompt: Prompt, variant: z.enum(VARIANTS) }).strict();

const variants: Record<Variant, Options> = {
  // No filesystem settings at all. Only the skills bundled with Claude Code remain.
  isolated: { ...BASE, settingSources: [] },
  // Project settings on: <cwd>/.claude/skills/ is scanned.
  project: { ...BASE, settingSources: ["project"] },
  // Same, without the bundled skills, so only ours are left.
  noBundled: { ...BASE, settingSources: ["project"], settings: { disableBundledSkills: true } },
  // Everything is still discovered, but the model is only told about task-report.
  filtered: { ...BASE, settingSources: ["project"], settings: { disableBundledSkills: true }, skills: ["task-report"] },
  // A plugin adds its own skills, prefixed with the plugin name.
  plugin: FULL,
};

concept11.post("/load", (req, res) => {
  const parsed = LoadBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return refuse(send, res, parsed.error);
  const { prompt, variant } = parsed.data;
  const options = variants[variant];
  send("options", options);

  const q = query({ prompt, options: { ...options, abortController: abort } });

  // Pass every message through; once the session is up, also ask for the discovered skills.
  async function* withCommands() {
    for await (const msg of q) {
      yield msg;
      if (msg.type === "system" && msg.subtype === "init") {
        const commands = await q.supportedCommands();
        // Built-in commands (/help, /clear...) are not skills; keep only the ones the user, project or a plugin defined.
        send("commands", commands.filter((c) => !c.builtin));
      }
    }
  }
  pipe(withCommands());
});

// ---------------------------------------------------------------------------------------------
// Part C: advanced loading
// ---------------------------------------------------------------------------------------------

// A subagent with a PRELOADED skill: its SKILL.md is in the subagent's context from the start,
// so it never calls the Skill tool. The main agent has no skills at all (skills: []).
concept11.post("/subagent", (req, res) => {
  const parsed = PromptBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return refuse(send, res, parsed.error);
  const { prompt } = parsed.data;
  const options: Options = {
    ...BASE,
    tools: ["Agent", "Read"],
    settingSources: ["project"],
    settings: { disableBundledSkills: true },
    skills: [],
    agents: {
      reporter: {
        description: "Reports on the team's tasks. Use for any question about task status.",
        prompt: "You report on team tasks. Follow your preloaded skill exactly.",
        tools: ["Read"],
        skills: ["task-report"],
        model: "haiku",
      },
    },
    // Concept 8's foreground hook: the main agent waits for the report instead of running the subagent in the background.
    hooks: {
      PreToolUse: [
        {
          matcher: "Agent",
          hooks: [
            async (input) => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { ...(input as { tool_input: Record<string, unknown> }).tool_input, run_in_background: false },
              },
            }),
          ],
        },
      ],
    },
  };
  send("options", options);
  pipe(query({ prompt, options: { ...options, abortController: abort } }));
});

/** Same push queue as Concept 10: an AsyncIterable prompt keeps the session open for control requests. */
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push(text: string) {
      queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

const LIVE_SKILL = "atmira-greeting";
const LIVE_SKILL_MD = `---
name: ${LIVE_SKILL}
description: Greets the user the Atmira Lab way. Use when the user asks for a greeting or says hello.
---

Answer with exactly this line and nothing else:
👋 Kaixo! Welcome to Atmira Lab (skill written while the session was running)
`;

// Writes a new skill to disk while the session is open, and shows that it only exists after reloadSkills().
concept11.post("/reload", async (req, res) => {
  const parsed = PromptBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return refuse(send, res, parsed.error);
  const { prompt } = parsed.data;
  const dir = path.join(PROJECT_DIR, ".claude", "skills", LIVE_SKILL);
  const names = (list: { name: string; builtin?: boolean }[]) => list.filter((c) => !c.builtin).map((c) => c.name);

  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...FULL, abortController: abort } });
  send("options", { ...FULL, prompt: "[AsyncIterable<SDKUserMessage>]" });

  try {
    await rm(dir, { recursive: true, force: true }); // start clean if an earlier run was cut short
    send("control", { step: "1. session open, q.supportedCommands()", skills: names(await q.supportedCommands()) });

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), LIVE_SKILL_MD);
    send("control", { step: `2. wrote .claude/skills/${LIVE_SKILL}/SKILL.md, q.supportedCommands() again`, skills: names(await q.supportedCommands()) });

    const reloaded = await q.reloadSkills();
    send("control", { step: "3. await q.reloadSkills()", skills: reloaded.skills.map((s) => s.name) });

    send("control", { step: "4. push the user message", text: prompt });
    input.push(prompt);
  } catch (err) {
    send("error", { message: String(err) });
  }

  // One turn is enough: close the input after the first result, then delete the skill again.
  async function* untilResult() {
    for await (const msg of q) {
      yield msg;
      if (msg.type === "result") input.close();
    }
  }
  pipe(untilResult()).finally(() => rm(dir, { recursive: true, force: true }));
});
