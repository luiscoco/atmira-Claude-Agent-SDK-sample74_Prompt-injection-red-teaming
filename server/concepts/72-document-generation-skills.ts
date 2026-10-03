/**
 * CONCEPT 72 — Document generation with Skills
 *
 *   A skill is a folder: SKILL.md (instructions) + reference docs + assets + a script. For documents that split is ideal:
 *   - the MODEL writes the content (a JSON spec), guided by SKILL.md and, on demand, the reference files (level 3);
 *   - the SCRIPT owns the format: brand styles, numbering, tables, footer, OOXML and zip. Deterministic, dependency-free;
 *   - the HOST decides what may run (a PreToolUse policy: one exact build command, spec files only, no .docx writes,
 *     skill files read-only) and opens the finished .docx itself before accepting it (it does not trust the skill).
 *   settingSources: ["project"] finds <cwd>/.claude/skills/atmira-docx; skills: ["atmira-docx"] is all the model sees.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { query, type HookCallback, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { agentEnv } from "../agent-mcp/agent.js";
import {
  INCIDENT_SECTIONS, LAB_ROOT, SKILL, createWorkspace, decide, frontmatter, inspectFile, presets, removeWorkspace, reviewedDigest,
  runBuilder, skillDigest, skillFiles, systemPrompt, workspaceFiles,
} from "../docgen/docgen.js";

export const MODEL = "claude-haiku-4-5";
export const limits = { maxTurns: 20, maxBudgetUsd: 0.4, deadlineMs: 180_000 };
const TOOLS = ["Skill", "Read", "Write", "Edit", "Bash"];
const CONTRACTS = ["incident-report", "general"] as const;

type Session = { ws: string; expires: number; busy: boolean };
export const concept72 = Router();
const sessions = new Map<string, Session>();

concept72.get("/facts", (_req, res) => {
  const files = skillFiles();
  res.json({
    skill: SKILL, frontmatter: frontmatter(files.find((f) => f.path === "SKILL.md")!.content), files, digest: reviewedDigest,
    notes: readFileSync(new URL("../docgen/incident-notes.md", import.meta.url), "utf8"),
    presets, systemPrompt, model: MODEL, limits, tools: TOOLS, incidentSections: INCIDENT_SECTIONS,
  });
});
concept72.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["docgen.ts", new URL("../docgen/docgen.ts", import.meta.url)],
  ["72-document-generation-skills.ts", new URL("./72-document-generation-skills.ts", import.meta.url)],
].map(([name, url]) => [String(name), readFileSync(url as URL, "utf8")]))));

concept72.post("/sessions", (_req, res) => {
  for (const [id, session] of sessions) if (session.expires < Date.now() && !session.busy) { removeWorkspace(session.ws); sessions.delete(id); }
  if (sessions.size >= 20) return res.status(429).json({ message: "Lab capacity reached; try later." });
  const id = randomUUID(); const ws = createWorkspace(id);
  sessions.set(id, { ws, expires: Date.now() + 3_600_000, busy: false });
  res.json({ id, files: workspaceFiles(ws) });
});
concept72.use("/sessions/:id", (req, res, next) => {
  const session = sessions.get(req.params.id);
  if (!session || session.expires < Date.now()) return res.status(404).json({ message: "Lab expired or missing. Start a new lab." });
  res.locals.session = session; next();
});
concept72.get("/sessions/:id", (_req, res) => res.json({ files: workspaceFiles((res.locals.session as Session).ws) }));

// Offline: write a spec and run the skill's script exactly as the agent would, then inspect the result.
const Name = z.string().regex(/^[\w-]{1,40}$/);
concept72.post("/sessions/:id/build", async (req, res) => {
  const session = res.locals.session as Session;
  const body = z.object({ name: Name, spec: z.unknown(), contract: z.enum(CONTRACTS).default("incident-report") }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  if (session.busy) return res.status(409).json({ message: "Wait until the agent run ends." });
  const { name, spec, contract } = body.data;
  const text = JSON.stringify(spec, null, 2) ?? "null";
  if (text.length > 200_000) return res.status(413).json({ message: "Spec too large." });
  writeFileSync(path.join(session.ws, `${name}.spec.json`), text);
  const build = await runBuilder(session.ws, `${name}.spec.json`, `out/${name}.docx`);
  const inspection = build.exitCode === 0 ? inspectFile(session.ws, `out/${name}.docx`, contract) : null;
  res.json({ build, inspection, files: workspaceFiles(session.ws) });
});

// The same decide() the hook calls, so you can try the policy without a model.
concept72.post("/sessions/:id/policy", (req, res) => {
  const body = z.object({ tool: z.string().min(1).max(40), input: z.record(z.string(), z.unknown()) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: z.prettifyError(body.error) });
  res.json(decide(body.data.tool, body.data.input, (res.locals.session as Session).ws));
});

concept72.get("/sessions/:id/files/:name", (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.docx$/.test(name)) return res.status(400).json({ message: "Bad file name." });
  const file = path.join((res.locals.session as Session).ws, "out", name);
  res.download(file, name, (error) => { if (error && !res.headersSent) res.status(404).json({ message: "No such document." }); });
});

let active = false;
concept72.post("/sessions/:id/query", async (req, res) => {
  const input = z.object({ request: z.string().trim().min(1).max(2000), contract: z.enum(CONTRACTS).default("incident-report") }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: z.prettifyError(input.error) });
  const session = res.locals.session as Session;
  if (active || session.busy) return res.status(409).json({ message: "A lesson 72 agent is already running." });
  active = true; session.busy = true;
  const { abort, send } = openSse(req, res);
  const timer = setTimeout(() => abort.abort(), limits.deadlineMs);
  const before = new Set(readdirSync(path.join(session.ws, "out")));
  let run: ReturnType<typeof query> | undefined;

  // Every tool call goes through the policy. The decision (allow or deny) is streamed so the tab can show it.
  const policy: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    const verdict = decide(hookInput.tool_name, toolInput, session.ws);
    send("policy", { tool: hookInput.tool_name, input: toolInput, ...verdict });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } };
  };
  try {
    const options: Options = {
      model: MODEL, systemPrompt, thinking: { type: "disabled" }, cwd: session.ws,
      tools: TOOLS,
      // Skills come from <cwd>/.claude/skills because "project" settings are on; nothing else is loaded.
      settingSources: ["project"], settings: { disableBundledSkills: true }, skills: [SKILL],
      hooks: { PreToolUse: [{ hooks: [policy] }] },
      permissionMode: "dontAsk", // anything the hook does not allow is denied, never prompted
      strictMcpConfig: true, persistSession: false,
      env: agentEnv(path.join(LAB_ROOT, "config")), abortController: abort,
      maxTurns: limits.maxTurns, maxBudgetUsd: limits.maxBudgetUsd,
    };
    send("options", { ...options, hooks: "{ PreToolUse: [policy] }", env: "agentEnv(docgen-lab/config)", abortController: undefined });
    run = query({ prompt: input.data.request, options });
    let completed = false;
    for await (const message of run) {
      send("message", message);
      if (message.type !== "result") continue;
      completed = true;
      send("result", { subtype: message.subtype, costUsd: message.total_cost_usd, turns: message.num_turns });
    }
    if (!completed) throw new Error("Agent ended without a result.");
  } catch (error) { if (!res.destroyed) send("error", { message: abort.signal.aborted ? "Run stopped or deadline reached." : String(error) }); }
  finally {
    clearTimeout(timer); run?.close();
    if (!res.destroyed) {
      // Acceptance happens here, in the host: each new .docx is opened and checked, and the skill must be unchanged.
      const created = readdirSync(path.join(session.ws, "out")).filter((f) => f.endsWith(".docx") && !before.has(f));
      const intact = skillDigest(path.join(session.ws, ".claude", "skills", SKILL)) === reviewedDigest;
      send("documents", { intact, documents: created.map((f) => inspectFile(session.ws, `out/${f}`, input.data.contract)), files: workspaceFiles(session.ws) });
      send("done", {}); res.end();
    }
    session.busy = false; active = false;
  }
});
