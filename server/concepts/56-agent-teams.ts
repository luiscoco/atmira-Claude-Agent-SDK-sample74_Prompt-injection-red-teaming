import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openSse } from "../sse.js";
import { commandSchema, members, replay, walkthrough } from "../teams/workshop.js";

export const concept56 = Router();
concept56.get("/facts", (_req, res) => res.json({ members, walkthrough, initial: replay([]), nativeTeams: "Interactive Claude Code only; this SDK demo uses a named subagent.", modelApiCalls: 0 }));
concept56.get("/code", (_req, res) => res.json({
  "workshop.ts": readFileSync(new URL("../teams/workshop.ts", import.meta.url), "utf8"),
  "56-agent-teams.ts": readFileSync(new URL("./56-agent-teams.ts", import.meta.url), "utf8"),
}));
concept56.post("/replay", (req, res) => {
  const parsed = z.object({ commands: z.array(commandSchema).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json(replay(parsed.data.commands));
});

// Two turns of one open SDK session: create an addressable worker, then message it.
// No experimental teams flag, undocumented TeamCreate API or hand-edited native inboxes.
concept56.post("/live", async (req, res) => {
  if (!z.object({}).strict().safeParse(req.body).success) return res.status(400).json({ message: "Expected an empty JSON object." });
  const { abort, send } = openSse(req, res);
  let wake = () => {};
  const queue: (string | null)[] = ["Use Agent to start one foreground calculator subagent named researcher. Ask it to compute 12 + 18. Return its answer. Do not calculate it yourself."];
  const push = (text: string | null) => { queue.push(text); wake(); };
  const stop = () => push(null);
  abort.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { send("error", { message: "Live run exceeded 90 seconds; cancelled." }); abort.abort(); }, 90_000);
  let session: ReturnType<typeof query> | undefined;
  let turns = 0;
  let sawSendMessage = false;
  let cost = 0;
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/sk-ant-[\w-]+/g, "[redacted]"));
  try {
    const root = path.resolve("teams-lab"); mkdirSync(root, { recursive: true });
    const run = mkdtempSync(path.join(root, "run-"));
    const cwd = path.join(run, "work"); const config = path.join(run, "config");
    mkdirSync(cwd); mkdirSync(config);
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!abort.signal.aborted) {
        while (!queue.length && !abort.signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
        const text = queue.shift(); if (text == null) return;
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
      }
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && key !== "ANTHROPIC_BASE_URL"));
    session = query({ prompt: input(), options: {
      cwd, env: { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      model: "haiku", maxTurns: 8, maxBudgetUsd: 0.15, abortController: abort,
      settingSources: [], strictMcpConfig: true, persistSession: false,
      tools: ["Agent", "SendMessage"], allowedTools: ["Agent", "SendMessage"],
      systemPrompt: "You coordinate a calculator. Use only the calculator subagent and plain text SendMessage. Follow the user's requested tool sequence. Do not claim to have sent a message unless the tool succeeded.",
      agents: { calculator: { description: "Computes arithmetic and applies follow-up corrections.", prompt: "Compute the requested sum. On a follow-up, use your previous total. Reply with the equation and total only.", tools: [], model: "haiku", maxTurns: 3 } },
      hooks: { PreToolUse: [{ hooks: [async (input) => {
        if (input.hook_event_name === "PreToolUse") {
          if (input.tool_name === "SendMessage") sawSendMessage = true;
          send("tool", scrub({ name: input.tool_name, input: input.tool_input, agent: input.agent_id ?? "lead" }));
        }
        return {};
      }] }] },
    } });
    for await (const message of session) {
      send("message", scrub(message));
      if (message.type === "system" && message.subtype === "init" && !message.tools.includes("SendMessage")) {
        send("error", { message: "This runtime does not expose SendMessage. Use the offline exercise or a compatible Claude runtime." }); break;
      }
      if (message.type !== "result") continue;
      cost = message.total_cost_usd; turns++;
      if (message.subtype !== "success" || message.is_error) {
        send("error", { message: "The SDK turn failed. Inspect the result for auth, credit, budget or turn-limit errors." }); break;
      }
      if (turns === 1) {
        push("Use SendMessage to researcher (or its returned agent ID) to continue the same calculator: add 7 to its previous total of 30. Wait for the worker's reply, then return its equation and total. Do not start a new Agent or calculate it yourself.");
      } else {
        send("summary", { mode: "named SDK subagent", turns, cost, sendMessageAttempted: sawSendMessage, answerContains37: /\b37\b/.test(message.result), note: "Check the tool result and worker reply: a tool attempt alone does not prove delivery. This run is not a native agent team." });
        break;
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) send("error", { message: String(scrub(String(error))) });
  } finally {
    clearTimeout(timer); abort.signal.removeEventListener("abort", stop); stop(); session?.close();
    if (!res.destroyed) { send("done", { turns, cost }); res.end(); }
  }
});
