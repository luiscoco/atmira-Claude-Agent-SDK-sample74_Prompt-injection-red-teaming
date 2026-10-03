/**
 * CONCEPT 50 — Full-stack capstone: "Acme Support Desk"
 *
 * Forty-nine tabs taught one feature each. A product uses them all at once, and the hard part is the seams between
 * them. This tab is one small but complete app: a customer-support agent for a shop.
 *
 *   React (the tab)  ──REST + SSE──▶  Express (this file)  ──query()──▶  Claude Code  ──▶  the Anthropic API
 *        ▲   approve/deny a refund          │  canUseTool waits here       │  desk MCP tools (in-process) ─▶ Store (JSON db)
 *        └──── state, audit, deltas ◀───────┘  hooks write the audit        └─ policy-expert subagent ─▶ policies/*.md
 *
 * The agent itself lives in server/capstone/ (store.ts, tools.ts, agent.ts, evals.ts). This file is only the HTTP
 * layer: it turns SDK messages into a small, stable event stream for the browser (a view model, not raw SDK
 * messages), keeps the pending approvals, and stores the conversation index next to Claude Code's session files.
 *
 * Routes: GET /facts, GET /state, POST /reset, GET /conversation/:id, POST /chat (SSE), POST /approve,
 *         POST /close (SSE), POST /evals (SSE), GET /code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { getSessionMessages, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { AGENTS, deskOptions, ensureWorkspace, MAX_TURNS, MODEL, POLICIES, REFUND_LIMIT_CENTS, TURN_BUDGET_USD, type Approver } from "../capstone/agent.js";
import { CASES, runCase } from "../capstone/evals.js";
import { Store, type Summary } from "../capstone/store.js";
import { deskServer, SERVER } from "../capstone/tools.js";

export const concept50 = Router();

const LAB = path.resolve("capstone-lab");
const WORKSPACE = path.join(LAB, "workspace"); // the agent's cwd: policies/*.md, and the key of its session files
const ROOT = process.cwd();
const store = new Store(path.join(LAB, "db.json"));
ensureWorkspace(WORKSPACE);

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const short = (s: string) =>
  s
    .replaceAll(WORKSPACE.replaceAll("\\", "\\\\"), ".")
    .replaceAll(WORKSPACE, ".")
    .replaceAll(WORKSPACE.replaceAll("\\", "/"), ".")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…");
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const shortInput = (input: unknown) => JSON.parse(short(JSON.stringify(input ?? {})));

// Started from inside Claude Code (e.g. the VS Code extension), the server inherits CLAUDECODE / CLAUDE_CODE_* —
// variables that make the child think it is a nested session (Concept 49). Drop those, keep the rest.
const agentEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDECODE|^CLAUDE_CODE_/.test(k))) as Record<string, string>;

/** An SSE route: parse the body, stream every event with the time since the start, and always end cleanly. */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await body(parsed.data, abort, emit);
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: errText(err) });
    } finally {
      send("done", {});
      res.end();
    }
  };
}

const Customer = z.enum(["C-1", "C-2"]);
const SessionId = z.string().regex(/^[0-9a-f-]{36}$/);

/** What the console's right-hand panel shows: the back office, as the support lead would see it. */
function snapshot(customerId: string) {
  const d = store.data;
  return {
    orders: store.ordersOf(customerId),
    refunds: d.refunds.filter((r) => r.customerId === customerId),
    tickets: d.tickets.filter((t) => t.customerId === customerId),
    audit: d.audit.slice(-40).map((a) => ({ ...a, input: shortInput(a.input) })),
    conversations: d.conversations.filter((c) => c.customerId === customerId),
  };
}

// ---------------------------------------------------------------------------------------------
// GET /facts — the personas, the policies, the limits, and which earlier tab each layer comes from
// ---------------------------------------------------------------------------------------------

concept50.get("/facts", (_req, res) => {
  const pkg = JSON.parse(readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
  res.json({
    sdkVersion: pkg.version,
    claudeCodeVersion: pkg.claudeCodeVersion,
    model: MODEL,
    limits: { refundLimitCents: REFUND_LIMIT_CENTS, turnBudgetUsd: TURN_BUDGET_USD, maxTurns: MAX_TURNS },
    customers: store.data.customers,
    policies: POLICIES,
    subagents: Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { description: a.description, tools: a.tools, model: a.model }])),
    cases: CASES.map((c) => ({ id: c.id, title: c.title, customerId: c.customerId, prompt: c.prompt })),
    layers: [
      { layer: "Agent loop", how: "query() with typed Options, one call per user message", tabs: [1, 2], file: "server/capstone/agent.ts" },
      { layer: "System prompt", how: "a custom prompt with the signed-in customer and today's date", tabs: [9], file: "agent.ts · systemPrompt()" },
      { layer: "Custom tools", how: "createSdkMcpServer + tool() + zod; customer id in a closure, not a parameter", tabs: [5, 13], file: "server/capstone/tools.ts" },
      { layer: "Subagent", how: "policy-expert (Read/Grep/Glob) reads policies/*.md; forced to the foreground", tabs: [8, 47], file: "agent.ts · AGENTS" },
      { layer: "Hooks", how: "PreToolUse refund guard + caller-based read guard; PostToolUse audit log", tabs: [7, 20], file: "agent.ts · hooks()" },
      { layer: "Permissions", how: "canUseTool: safe tools allowed, refunds → a person (or the eval bot), rest denied", tabs: [4, 31, 37], file: "agent.ts · canUseTool" },
      { layer: "Streaming", how: "includePartialMessages → text deltas over SSE to React", tabs: [2, 10, 12], file: "50-capstone.ts · /chat" },
      { layer: "Sessions", how: "persistSession + resume; getSessionMessages() rebuilds the chat after a reload", tabs: [6, 19, 40], file: "50-capstone.ts · /conversation" },
      { layer: "Structured output", how: "outputFormat json_schema on a forkSession of the chat → the CRM summary", tabs: [10], file: "50-capstone.ts · /close" },
      { layer: "Limits & cost", how: "maxTurns, maxBudgetUsd per turn, AbortController (Stop), cost per conversation", tabs: [15, 26, 28], file: "agent.ts · deskOptions()" },
      { layer: "Isolation", how: "settingSources: [], strictMcpConfig, a cleaned env, a dedicated cwd", tabs: [16, 39, 48, 49], file: "agent.ts · deskOptions()" },
      { layer: "Evals", how: "scripted chats, in-memory stores, a bot approver; assert effects, then tools, then text", tabs: [49], file: "server/capstone/evals.ts" },
    ],
  });
});

concept50.get("/state", (req, res) => {
  const c = Customer.safeParse(req.query.customer);
  if (!c.success) return res.status(400).json({ error: "customer must be C-1 or C-2" });
  res.json(snapshot(c.data));
});

concept50.post("/reset", (_req, res) => {
  if (busy.size) return res.status(409).json({ error: "A conversation turn is running; stop it first." });
  store.reset();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// GET /conversation/:id — rebuild a chat from Claude Code's own transcript, after a reload or a server restart
// ---------------------------------------------------------------------------------------------

// #region transcript
type Item = { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; input: unknown; agent: string; result?: string; isError?: boolean };
type Turn = { user: string; items: Item[] };

const blocks = (m: any): any[] => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : []);
const resultText = (c: unknown) => cut(short(typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : JSON.stringify(c)), 400);

concept50.get("/conversation/:id", async (req, res) => {
  const id = SessionId.safeParse(req.params.id);
  // Only a conversation of the app's own index can be read: the id is not a path, it is a key we issued.
  const conv = id.success ? store.conversation(id.data) : undefined;
  if (!conv) return res.status(404).json({ error: "No such conversation." });
  try {
    const messages = await getSessionMessages(conv.id, { dir: WORKSPACE });
    const turns: Turn[] = [];
    const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
    for (const m of messages) {
      if (m.parent_tool_use_id) continue; // subagent messages live in their own transcript
      for (const b of blocks(m.message)) {
        if (m.type === "user" && b.type === "text") turns.push({ user: b.text, items: [] });
        else if (m.type === "user" && b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          if (t) Object.assign(t, { result: resultText(b.content), isError: !!b.is_error });
        } else if (m.type === "assistant" && turns.length) {
          const items = turns.at(-1)!.items;
          if (b.type === "text" && b.text.trim()) items.push({ kind: "text", text: b.text });
          if (b.type === "tool_use") {
            const t = { kind: "tool" as const, id: b.id, name: b.name, input: shortInput(b.input), agent: "desk" };
            tools.set(b.id, t);
            items.push(t);
          }
        }
      }
    }
    res.json({ conversation: conv, turns });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /chat — one user message = one query() turn, resumed from the conversation's session
// ---------------------------------------------------------------------------------------------

// #region approvals
// canUseTool("issue_refund") waits here until the person clicks Approve/Deny, the timeout fires, or the turn stops.
const APPROVAL_TIMEOUT_MS = 180_000;
const pending = new Map<string, (d: { allow: boolean; by: string; message?: string }) => void>();

function personApprover(emit: Emit, turn: AbortSignal): Approver {
  return ({ toolUseId, input, signal }) =>
    new Promise((resolve) => {
      const done = (d: { allow: boolean; by: string; message?: string }) => {
        if (!pending.delete(toolUseId)) return; // already decided
        clearTimeout(timer);
        emit("approval-done", { toolUseId, ...d });
        resolve(d);
      };
      const timer = setTimeout(() => done({ allow: false, by: "timeout", message: "Nobody approved the refund within 3 minutes. Tell the customer a colleague will follow up." }), APPROVAL_TIMEOUT_MS);
      for (const s of [signal, turn]) s.addEventListener("abort", () => done({ allow: false, by: "stopped" }), { once: true });
      pending.set(toolUseId, done);
      emit("approval", { toolUseId, input, timeoutMs: APPROVAL_TIMEOUT_MS });
    });
}

concept50.post("/approve", (req, res) => {
  const b = z.object({ toolUseId: z.string().min(1).max(100), decision: z.enum(["approve", "deny"]), note: z.string().trim().max(300).optional() }).strict().safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: badRequest(b.error) });
  const done = pending.get(b.data.toolUseId);
  if (!done) return res.status(404).json({ error: "No refund is waiting for that approval (decided, timed out, or the turn stopped)." });
  done({ allow: b.data.decision === "approve", by: "support lead (you)", message: b.data.note && `The approver said: ${b.data.note}` });
  res.json({ ok: true });
});
// #endregion

// #region chat
const busy = new Set<string>(); // one running turn per conversation (and "new:<customer>" for a first message)

concept50.post(
  "/chat",
  sseRoute(
    z.object({ customerId: Customer, conversationId: SessionId.optional(), message: z.string().trim().min(1).max(2000) }).strict(),
    async (b, abort, emit) => {
      const conv = b.conversationId ? store.conversation(b.conversationId) : undefined;
      if (b.conversationId && (!conv || conv.customerId !== b.customerId)) throw new Error("No such conversation for this customer.");
      if (conv?.status === "closed") throw new Error("This conversation is closed. Start a new one.");
      const lock = conv?.id ?? `new:${b.customerId}`;
      if (busy.has(lock)) throw new Error("This conversation is already answering a message.");
      busy.add(lock);

      const onChange = () => emit("state", snapshot(b.customerId));
      store.on("change", onChange);
      try {
        const { options, setSession } = deskOptions({
          store, customerId: b.customerId, workspace: WORKSPACE, abort, env: agentEnv(),
          approver: personApprover(emit, abort.signal),
          emit: (e, d) => emit(e, d),
          resume: conv?.id,
        });
        let sessionId = conv?.id;
        for await (const m of query({ prompt: b.message, options }) as AsyncIterable<SDKMessage>) {
          if (m.type === "system" && m.subtype === "init" && !sessionId) {
            sessionId = m.session_id;
            setSession(sessionId);
            store.upsertConversation({ id: sessionId, customerId: b.customerId, title: cut(b.message, 60) });
            emit("session", { conversationId: sessionId, resumed: false });
          } else if (m.type === "system" && m.subtype === "init") emit("session", { conversationId: sessionId, resumed: true });
          else if (m.type === "stream_event" && !m.parent_tool_use_id) {
            // Only the main agent's text streams to the customer; the subagent's work shows up as a tool call.
            const ev = m.event as any;
            if (ev.type === "content_block_start" && ev.content_block?.type === "text") emit("text-start", {});
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") emit("delta", { text: ev.delta.text });
          } else if (m.type === "assistant") {
            for (const blk of m.message.content)
              if (blk.type === "tool_use") emit("tool", { id: blk.id, name: blk.name, input: shortInput(blk.input), agent: m.parent_tool_use_id ? "policy-expert" : "desk" });
          } else if (m.type === "user") {
            for (const blk of blocks(m.message))
              if (blk.type === "tool_result") emit("tool-result", { id: blk.tool_use_id, isError: !!blk.is_error, text: resultText(blk.content) });
          } else if (m.type === "result") {
            const c = sessionId ? store.conversation(sessionId) : undefined;
            if (c) store.upsertConversation({ id: c.id, customerId: c.customerId, turns: c.turns + 1, costUsd: c.costUsd + (m.total_cost_usd ?? 0) });
            emit("result", {
              subtype: m.subtype, costUsd: m.total_cost_usd, turns: m.num_turns, ms: m.duration_ms,
              denials: (m.permission_denials ?? []).map((d) => d.tool_name),
              errors: "errors" in m ? m.errors : undefined,
            });
          }
        }
      } finally {
        store.off("change", onChange);
        busy.delete(lock);
      }
    },
  ),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /close — wrap up a conversation: a typed summary for the CRM, from a FORK of the session
// ---------------------------------------------------------------------------------------------

// #region close
const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["order-status", "damaged-item", "return", "refund", "cancellation", "account", "other"] },
    resolution: { type: "string", enum: ["resolved", "escalated", "unresolved"] },
    refundCents: { type: "integer", description: "total refunded in this conversation, in cents (0 if none)" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    summary: { type: "string", description: "two sentences for the next support agent" },
    followUp: { type: "string", description: "what still has to happen, or 'none'" },
  },
  required: ["category", "resolution", "refundCents", "sentiment", "summary", "followUp"],
  additionalProperties: false,
};

concept50.post(
  "/close",
  sseRoute(z.object({ conversationId: SessionId }).strict(), async (b, abort, emit) => {
    const conv = store.conversation(b.conversationId);
    if (!conv) throw new Error("No such conversation.");
    if (busy.has(conv.id)) throw new Error("This conversation is answering a message; wait for it to finish.");
    busy.add(conv.id);
    try {
      // forkSession: the summary request is NOT appended to the customer's conversation. persistSession: false: the
      // fork is not even saved. The desk server is attached (the transcript has its tool calls) but every tool is
      // denied: the summary is written from the conversation alone.
      const options = {
        model: MODEL, cwd: WORKSPACE, env: agentEnv(), abortController: abort,
        resume: conv.id, forkSession: true, persistSession: false,
        outputFormat: { type: "json_schema" as const, schema: SUMMARY_SCHEMA },
        tools: [], mcpServers: { [SERVER]: deskServer(store, conv.customerId, { session: () => conv.id, approver: () => "nobody" }) },
        permissionMode: "dontAsk" as const, settingSources: [], strictMcpConfig: true, thinking: { type: "disabled" as const }, maxTurns: 3,
      };
      emit("options", { ...options, env: "agentEnv()", abortController: "AbortController", cwd: "capstone-lab/workspace", mcpServers: { [SERVER]: "deskServer(…)" } });
      let r: any;
      for await (const m of query({ prompt: "Wrap up this support conversation for the CRM. Use only what happened in the conversation above.", options })) if (m.type === "result") r = m;
      if (r?.subtype !== "success" || !r.structured_output) throw new Error(`No summary: ${r?.subtype ?? "no result"}`);
      const summary = r.structured_output as Summary;
      store.upsertConversation({ id: conv.id, customerId: conv.customerId, status: "closed", summary, costUsd: conv.costUsd + (r.total_cost_usd ?? 0) });
      emit("summary", { summary, costUsd: r.total_cost_usd, ms: r.duration_ms });
    } finally {
      busy.delete(conv.id);
    }
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /evals — the test suite: every case in parallel, each with its own in-memory store
// ---------------------------------------------------------------------------------------------

concept50.post(
  "/evals",
  sseRoute(z.object({ ids: z.array(z.string().max(40)).max(20).optional() }).strict(), async (b, abort, emit) => {
    const cases = CASES.filter((c) => !b.ids?.length || b.ids.includes(c.id));
    await Promise.all(
      cases.map(async (c) => {
        emit("case-start", { id: c.id });
        const r = await runCase(c, WORKSPACE, agentEnv(), abort.signal, (e, d) => emit(e, { ...d, input: shortInput((d as any).input) }));
        emit("case-end", { ...r, checks: r.checks.map((k) => ({ ...k, detail: k.detail && short(k.detail) })) });
      }),
    );
  }),
);

// ---------------------------------------------------------------------------------------------
// GET /code — the capstone's modules and this route, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const CAP = path.resolve("server/capstone");
const SOURCES = [path.join(CAP, "tools.ts"), path.join(CAP, "agent.ts"), path.join(CAP, "evals.ts"), fileURLToPath(import.meta.url)];
concept50.get("/code", (_req, res) => {
  const out: Record<string, string> = {};
  for (const file of SOURCES) {
    const tag = path.basename(file).replace(/\.\w+$/, "").replace(/^50-capstone$/, "server");
    const src = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    for (const [, name, c] of src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)) out[`${tag}:${name}`] = c.trimEnd();
  }
  res.json(out);
});
