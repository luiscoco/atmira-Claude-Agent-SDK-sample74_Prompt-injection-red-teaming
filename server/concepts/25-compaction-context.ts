/**
 * CONCEPT 25 — Compaction & context: what fills the context window, and what happens when it is full
 *
 * Every request sends the WHOLE conversation again. It grows with each tool result until it no longer fits.
 * Claude Code then COMPACTS: one extra model call writes a summary, and the summary replaces the old messages.
 *
 *   q.getContextUsage()                     -> the window, category by category: used / buffer / free
 *   settings.autoCompactWindow              -> the window compaction measures against (100k to 1M tokens)
 *   settings.autoCompactEnabled: false      -> no auto-compaction (only /compact)
 *   "/compact <instructions>"               -> manual compaction, sent as a user message (Concept 21)
 *   system/status "compacting"              -> compaction started; then compact_result "success" | "failed"
 *   system/compact_boundary                 -> trigger, pre_tokens, post_tokens, duration_ms, preserved_messages
 *   hooks.PreCompact                        -> sees trigger + custom_instructions; systemMessage ADDS instructions,
 *                                              decision "block" cancels the compaction
 *   hooks.PostCompact                       -> compact_summary: the text that replaces the conversation
 *   hooks.SessionStart (source "compact")   -> additionalContext is put back after the summary
 *
 * The lab: a session reads large ops reports (about 16k tokens each) from an MCP tool, one per turn, then asks a
 * question that needs facts from all of them. With a 100k window, auto-compaction fires at 67k tokens, in the
 * fifth report.
 *
 * Routes: GET /window (no model calls), GET /code, POST /run (SSE).
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type HookEvent,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept25 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const WINDOW = 100_000; // the smallest autoCompactWindow the CLI accepts: compaction at 100k - 20k output - 13k = 67k
const REPORT_CHARS = 45_000; // about 16k tokens. Over about 50,000 characters the CLI saves the result to a file instead
const HUGE_CHARS = 60_000; //   and the model only gets a preview: the "huge" switch shows it.
const MAX_REPORTS = 6;
const MAX_RUN_MS = 240_000;
const SYSTEM = "You are an ops assistant. Answer briefly.";
const INSTRUCTIONS = "Keep every incident code with its owner, exactly.";
const REINJECTED = "Re-injected after compaction: the on-call engineer this week is Marta Ruiz.";
const RECALL =
  "Without calling any tool: list every incident code and its owner, the rollback deadline mentioned in report 2, and who is on call this week. Say 'unknown' for what you don't know.";

// A too-large tool result is saved under <CLAUDE_CONFIG_DIR>/projects/<cwd>/<session>/tool-results/, even with
// persistSession: false. A fake config dir keeps those files in this sample instead of the real ~/.claude.
const LAB = path.resolve("compact-lab");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
mkdirSync(CONFIG_DIR, { recursive: true });

// ---------------------------------------------------------------------------------------------
// The reports: mostly filler, one incident code + owner at the top, and ONE detail buried in the middle of report 2.
// ---------------------------------------------------------------------------------------------

const OWNERS = ["Lisbon", "Madrid", "Porto", "Sevilla"];
const code = (n: number) => `ORCA-${n}${n}7`;
const owner = (n: number) => `team ${OWNERS[n % 4]}`;

function report(n: number, chars: number) {
  const lines = [`# Weekly ops report ${n}`, `Incident code: ${code(n)}. Owner: ${owner(n)}.`];
  for (let i = 0; lines.join("\n").length < chars; i++) {
    if (n === 2 && i === 150) lines.push("Note: the rollback window for ORCA-227 closes on Friday at 17:00.");
    lines.push(`Line ${i}: metric ${n}-${i} stayed within normal range; latency ${100 + ((n * i) % 37)} ms, error rate 0.${(n + i) % 9}%.`);
  }
  return lines.join("\n");
}

function opsServer(huge: boolean, onRead: (n: number, chars: number) => void) {
  return createSdkMcpServer({
    name: "ops",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool("read_report", `Read weekly ops report number n (1-${MAX_REPORTS}).`, { n: z.number().int().min(1).max(MAX_REPORTS) }, async ({ n }) => {
        const text = report(n, huge ? HUGE_CHARS : REPORT_CHARS);
        onRead(n, text.length);
        return { content: [{ type: "text", text }] };
      }),
    ],
  });
}

/** The options every query here shares. No settings files, no transcript, no built-in tools: only the ops tool. */
function baseOptions(extra: Partial<Options>, huge = false, onRead: (n: number, chars: number) => void = () => {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  return {
    model: MODEL,
    systemPrompt: SYSTEM,
    tools: [],
    mcpServers: { ops: opsServer(huge, onRead) },
    strictMcpConfig: true,
    allowedTools: ["mcp__ops__read_report"],
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    env,
    ...extra,
  };
}

/** Options without the parts JSON can't show. */
function describe(options: Options) {
  const { env: _env, mcpServers: _mcp, hooks, abortController: _a, ...rest } = options;
  return {
    ...rest,
    env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'compact-lab/config' }",
    mcpServers: { ops: { type: "sdk", name: "ops", instance: "[McpServer]" } },
    hooks: hooks && Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v!.map((m) => ({ ...m, hooks: m.hooks.map(() => "[Function]") }))])),
  };
}

/** A prompt that never sends a message: the session starts, answers control requests, and costs nothing. */
async function* silent(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
}

// ---------------------------------------------------------------------------------------------
// GET /window: the empty window in four setups. getContextUsage() needs no model call.
// ---------------------------------------------------------------------------------------------

const SETUPS: Record<string, { label: string; extra: Partial<Options> }> = {
  default: { label: "default window", extra: {} },
  preset: { label: "claude_code preset", extra: { systemPrompt: { type: "preset", preset: "claude_code" }, tools: { type: "preset", preset: "claude_code" }, settings: { autoMemoryEnabled: false } } },
  window: { label: `autoCompactWindow: ${WINDOW.toLocaleString("en")}`, extra: { settings: { autoCompactWindow: WINDOW } } },
  off: { label: "autoCompactEnabled: false", extra: { settings: { autoCompactEnabled: false } } },
};

concept25.get("/window", async (_req, res) => {
  const out = await Promise.all(
    Object.entries(SETUPS).map(async ([id, { label, extra }]) => {
      const stop = new AbortController();
      const options = baseOptions({ ...extra, abortController: stop });
      const q = query({ prompt: silent(stop.signal), options });
      try {
        // Before the first message the in-process MCP server may still be connecting, and its tools would be missing.
        for (let i = 0; i < 50; i++) {
          if ((await q.mcpServerStatus()).some((s) => s.name === "ops" && s.status === "connected")) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const u = await q.getContextUsage(); // detail "full": each category counted with the token-count API (free)
        return {
          id,
          label,
          settings: extra.settings ?? {},
          model: u.model,
          totalTokens: u.totalTokens,
          maxTokens: u.maxTokens,
          percentage: u.percentage,
          autoCompactThreshold: u.autoCompactThreshold ?? null,
          isAutoCompactEnabled: u.isAutoCompactEnabled,
          categories: u.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
          mcpTools: u.mcpTools.map(({ name, tokens }) => ({ name, tokens })),
        };
      } catch (err) {
        return { id, label, error: String(err) };
      } finally {
        stop.abort();
        q.close();
      }
    }),
  );
  res.json(out);
});

// ---------------------------------------------------------------------------------------------
// POST /run: one session, one report per turn, then the recall question
// ---------------------------------------------------------------------------------------------

const MODES = ["auto", "manual", "off"] as const;
const SWITCHES = ["instructions", "reinject", "block", "huge"] as const;

// The request body: a mode, a number of reports, and switch names only.
const RunBody = z
  .object({
    mode: z.enum(MODES),
    reports: z.number().int().min(1).max(MAX_REPORTS),
    switches: z.array(z.enum(SWITCHES)).max(SWITCHES.length).default([]),
  })
  .strict();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// A fact counts only on a line that states it without hedging, so "unknown, maybe Friday" is not a pass.
const HEDGE = /\b(unknown|maybe|perhaps|probably|not sure|unsure|not mentioned|don't know|do not know)\b/;
function statedIn(answer: string) {
  const lines = answer.toLowerCase().split(/\n|;/);
  return (...parts: string[]) => lines.some((l) => parts.every((p) => l.includes(p)) && !HEDGE.test(l));
}

concept25.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const finish = () => {
    send("done", {});
    res.end();
  };
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    return finish();
  }
  const { mode, reports, switches } = parsed.data;
  const on = (s: (typeof SWITCHES)[number]) => switches.includes(s);
  const startedAt = Date.now();
  const at = () => Date.now() - startedAt;

  // #region hooks
  // PreCompact: runs before the summary call, for /compact (trigger "manual") and auto-compaction ("auto").
  const preCompact: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreCompact") return {};
    const returned = on("block")
      ? { decision: "block" as const, reason: "Blocked by the lab's PreCompact hook." } // the compaction is skipped
      : on("instructions")
        ? { systemMessage: INSTRUCTIONS } // appended to custom_instructions for the summary call
        : {};
    send("hook", { event: "PreCompact", trigger: input.trigger, custom_instructions: input.custom_instructions, returned, at: at() });
    return returned;
  };
  // PostCompact: the summary that now stands for everything before the boundary.
  const postCompact: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact") send("hook", { event: "PostCompact", trigger: input.trigger, compact_summary: input.compact_summary, at: at() });
    return {};
  };
  // SessionStart runs again after a compaction, with source "compact" (the matcher). What it adds survives the summary.
  const sessionStart: HookCallback = async (input) => {
    if (input.hook_event_name !== "SessionStart") return {};
    const returned = on("reinject") ? { hookSpecificOutput: { hookEventName: "SessionStart" as const, additionalContext: REINJECTED } } : {};
    send("hook", { event: "SessionStart", source: input.source, returned, at: at() });
    return returned;
  };
  const hooks: Partial<Record<HookEvent, { matcher?: string; hooks: HookCallback[] }[]>> = {
    PreCompact: [{ hooks: [preCompact] }],
    PostCompact: [{ hooks: [postCompact] }],
    SessionStart: [{ matcher: "compact", hooks: [sessionStart] }],
  };
  // #endregion

  // #region options
  const options = baseOptions(
    {
      settings: mode === "off" ? { autoCompactWindow: WINDOW, autoCompactEnabled: false } : { autoCompactWindow: WINDOW },
      hooks,
      abortController: abort,
    },
    on("huge"),
    (n, chars) => send("tool", { n, chars, at: at() }),
  );
  // #endregion
  send("options", describe(options));

  const prompts = [
    ...Array.from({ length: reports }, (_, i) => `Read report ${i + 1} and tell me its incident code in one line.`),
    ...(mode === "manual" ? ["/compact Focus on the ops reports."] : []),
    RECALL,
  ];

  const label = `[c25] ${mode} reports=${reports} switches=${switches.join(",") || "-"}`;
  console.log(`${label} started`);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);

  // The next prompt is pushed only after the previous result, like a user typing turn after turn.
  let next: (() => void) | undefined;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (const [index, text] of prompts.entries()) {
      send("turn", { index, prompt: text, at: at() });
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
      await new Promise<void>((resolve) => (next = resolve));
    }
  }

  const q = query({ prompt: input(), options });

  // #region usage
  /** getContextUsage "summary": from the last response's usage, no token-count calls, so it is fast between turns. */
  async function usage(when: string) {
    try {
      const u = await q.getContextUsage({ detail: "summary" });
      send("usage", {
        when,
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        threshold: u.autoCompactThreshold ?? null,
        enabled: u.isAutoCompactEnabled,
        categories: u.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
        at: at(),
      });
    } catch (err) {
      send("usage", { when, error: String(err) });
    }
  }
  // #endregion

  (async () => {
    let results = 0;
    let lastText = "";
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init" && results === 0) await usage("start");
        // #region messages
        if (msg.type === "system" && msg.subtype === "status") {
          send("status", { status: msg.status, compact_result: msg.compact_result, compact_error: msg.compact_error, at: at() });
        }
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          send("boundary", { ...msg.compact_metadata, at: at() });
        }
        // #endregion
        if (msg.type === "assistant" && !msg.parent_tool_use_id) {
          const text = msg.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
          if (text) send("assistant", { text, at: at() });
        }
        // What the model got back from the tool: the full report, or the CLI's preview of a saved file.
        if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const b of msg.message.content as any[]) {
            if (b.type !== "tool_result") continue;
            const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
            send("toolResult", { chars: content.length, head: content.slice(0, 600).replaceAll(LAB, "compact-lab"), at: at() });
          }
        }
        if (msg.type !== "result") continue;
        lastText = msg.subtype === "success" ? msg.result : "";
        send("result", { index: results, subtype: msg.subtype, num_turns: msg.num_turns, cost: msg.total_cost_usd, text: lastText, errors: "errors" in msg ? msg.errors : undefined, at: at() });
        await usage(`after turn ${results + 1}`);
        console.log(`${label} result #${results + 1} ${msg.subtype} $${msg.total_cost_usd.toFixed(4)}`);
        if (++results === prompts.length) break; // ends the query: the input generator is left waiting
        next?.();
      }
      // The recall question, graded: which facts are still in the context?
      const stated = statedIn(lastText);
      send("recall", {
        codes: Array.from({ length: reports }, (_, i) => ({ code: code(i + 1), owner: owner(i + 1), found: stated(code(i + 1).toLowerCase()) })),
        rollback: stated("friday") || stated("17:00"),
        onCall: stated("marta"),
      });
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: String(err) });
    } finally {
      clearTimeout(timer);
      finish();
    }
  })();
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers (Concept 24 does the same)
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept25.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
