/**
 * LESSON 61 — Exposing your agent as an MCP server.
 *
 * The refund desk (server/agent-mcp/desk.ts) is an agent behind one MCP tool. This router serves it over Streamable
 * HTTP on /api/c61/mcp (bearer token, Host check, stateless, SSE responses so progress can stream), and
 * server/agent-mcp/stdio.ts serves the same server over stdio. The other routes:
 *   GET  /facts /code /describe /contract     offline: what callers see, the tool contract with a scripted agent
 *   GET  /stdio-check  /http-check            offline: a real client over each transport (tools/list; stdio also calls the scripted agent)
 *   GET  /log                                 every tool call this process served, with the inner agent's cost
 *   POST /call      (SSE, billed)             an MCP client calls review_refund over HTTP; progress streams back
 *   POST /delegate  (SSE, billed)             another agent (query()) uses the desk as an http MCP server
 */
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openSse } from "../sse.js";
import { buildDeskServer, DeskState, deskLimits, orders, policyDecision, policyText, sampleMessages, toolDescription, type CallLog, type Runner } from "../agent-mcp/desk.js";
import { describeDesk, runContract } from "../agent-mcp/contract.js";
import { agentEnv, deskSystemPrompt, LAB, MODEL, realRunner } from "../agent-mcp/agent.js";

const STDIO_ENTRY = fileURLToPath(new URL("../agent-mcp/stdio.ts", import.meta.url));
const TSX_LOADER = import.meta.resolve("tsx"); // a file:// URL, so the stdio command works from any folder

export const leadSystemPrompt =
  "You are a support lead. For every refund request you are given, call review_refund once, then answer with one line per order: " +
  "the order id, the decision and the broken rules. Do not decide refunds yourself.";

/** The router, with the runner injectable: the tests mount it with a scripted agent. */
export function createConcept61({ runner = realRunner, state = new DeskState(), token = process.env.REFUND_DESK_TOKEN || randomBytes(16).toString("hex") }: { runner?: Runner; state?: DeskState; token?: string } = {}) {
  const router = Router();
  let delegating = false;

  // -------------------------------------------------------------------------------------------
  // The MCP endpoint. Stateless: every POST gets a fresh McpServer + transport; the limits live in `state`.
  // -------------------------------------------------------------------------------------------
  router.post("/mcp", async (req, res) => {
    // 1. Authenticate before the protocol sees anything: this endpoint spends model tokens on the caller's behalf.
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or wrong bearer token" }, id: null });
      return;
    }
    const port = req.socket.localPort;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no Mcp-Session-Id, any replica can serve any request
      enableJsonResponse: false,     // answer with an SSE stream, so notifications/progress reach the caller during the call
      enableDnsRebindingProtection: true, allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`], // a web page cannot reach it by rebinding a name
    });
    const server = buildDeskServer(runner, state, "http");
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // Stateless: no GET stream for server-initiated messages and no session to DELETE.
  router.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

  const mcpUrl = (req: Request) => `http://localhost:${req.socket.localPort}${req.baseUrl}/mcp`;
  const httpClient = async (req: Request, caller: string, withToken = true) => {
    const client = new Client({ name: `lesson61-${caller}`, version: "1.0.0" });
    const headers: Record<string, string> = { "x-caller": caller, ...(withToken ? { Authorization: `Bearer ${token}` } : {}) };
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(req)), { requestInit: { headers } }));
    return client;
  };

  // -------------------------------------------------------------------------------------------
  // Offline routes
  // -------------------------------------------------------------------------------------------
  router.get("/facts", (req, res) => {
    const url = `http://localhost:${req.socket.localPort ?? 3061}${req.baseUrl}/mcp`;
    const stdioArgs = ["--import", TSX_LOADER, STDIO_ENTRY];
    res.json({
      model: MODEL, limits: state.limits, policyText, toolDescription, deskSystemPrompt, leadSystemPrompt, sampleMessages,
      orders: orders.map((order) => ({ ...order, expected: policyDecision(order) })),
      tokenFromEnv: Boolean(process.env.REFUND_DESK_TOKEN), liveAvailable: Boolean(process.env.ANTHROPIC_API_KEY), url,
      config: {
        claudeHttp: `claude mcp add --transport http refund-desk ${url} --header "Authorization: Bearer $REFUND_DESK_TOKEN"`,
        claudeStdio: `claude mcp add refund-desk -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -- node ${stdioArgs.map((arg) => `"${arg}"`).join(" ")}`,
        mcpJson: JSON.stringify({ mcpServers: { "refund-desk": { type: "http", url, headers: { Authorization: "Bearer ${REFUND_DESK_TOKEN}" } } } }, null, 2),
        agentSdk: `mcpServers: {\n  "refund-desk": { type: "http", url: "${url}",\n    headers: { Authorization: \`Bearer \${process.env.REFUND_DESK_TOKEN}\` }, timeout: 120_000 },\n},\nallowedTools: ["mcp__refund-desk__review_refund"],`,
        stdio: { command: "node", args: stdioArgs },
      },
    });
  });
  router.get("/code", (_req, res) => res.json(Object.fromEntries([
    ["desk.ts", "../agent-mcp/desk.ts"], ["agent.ts", "../agent-mcp/agent.ts"], ["stdio.ts", "../agent-mcp/stdio.ts"],
    ["61-agent-as-mcp-server.ts", "./61-agent-as-mcp-server.ts"], ["contract.ts", "../agent-mcp/contract.ts"],
  ].map(([name, file]) => [name, readFileSync(new URL(file, import.meta.url), "utf8")]))));
  router.get("/describe", async (_req, res) => res.json(await describeDesk()));
  router.get("/contract", async (_req, res) => res.json(await runContract()));
  router.get("/log", (_req, res) => res.json({ spentUsd: state.spentUsd, inFlight: state.inFlight, limits: state.limits, calls: state.calls }));

  /** Starts stdio.ts exactly as a client would (from another folder), with the scripted agent: no model calls. */
  router.get("/stdio-check", async (_req, res) => {
    const started = Date.now(); let stderr = "";
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", TSX_LOADER, STDIO_ENTRY], cwd: os.tmpdir(), env: { ...process.env, REFUND_DESK_FAKE: "1" } as Record<string, string>, stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: "lesson61-stdio-check", version: "1.0.0" });
    try {
      await client.connect(transport);
      const connectedMs = Date.now() - started;
      const { tools } = await client.listTools();
      const progress: string[] = [];
      const result = await client.callTool({ name: "review_refund", arguments: { orderId: "O-205", customerMessage: sampleMessages["O-205"] } }, undefined, { onprogress: (p) => progress.push(p.message ?? "") });
      res.json({ ok: true, command: `node --import tsx ${path.relative(process.cwd(), STDIO_ENTRY)}`, cwd: os.tmpdir(), connectedMs, totalMs: Date.now() - started, server: client.getServerVersion(), tools: tools.map((t) => t.name), result: result.structuredContent, progress, stderr: stderr.trim() });
    } catch (error) {
      res.status(500).json({ ok: false, message: String(error), stderr: stderr.trim() });
    } finally { await client.close().catch(() => {}); }
  });

  /** Over real HTTP to this very endpoint: no token is refused with 401; with the token, initialize + tools/list. */
  router.get("/http-check", async (req, res) => {
    const noToken = await fetch(mcpUrl(req), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    // A forged Host header (what DNS rebinding produces) is refused by the transport even with a valid token.
    const badHost = await new Promise<number>((resolve, reject) => {
      const probe = http.request({ host: "localhost", port: req.socket.localPort, path: `${req.baseUrl}/mcp`, method: "POST",
        headers: { Host: "evil.example", Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } },
        (answer) => { answer.resume(); resolve(answer.statusCode ?? 0); });
      probe.on("error", reject); probe.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    const get = await fetch(mcpUrl(req), { headers: { Authorization: `Bearer ${token}` } });
    const client = await httpClient(req, "http check");
    try {
      const { tools } = await client.listTools();
      res.json({ url: mcpUrl(req), noToken: noToken.status, badHost, get: get.status, server: client.getServerVersion(), tools: tools.map((t) => t.name), annotations: tools[0]?.annotations });
    } finally { await client.close(); }
  });

  // -------------------------------------------------------------------------------------------
  // Live routes (billed): the real agent behind the real HTTP endpoint
  // -------------------------------------------------------------------------------------------
  const live = (res: Response) => {
    if (process.env.ANTHROPIC_API_KEY || runner !== realRunner) return true;
    res.status(400).json({ message: "Live runs require ANTHROPIC_API_KEY in .env (the agents use an isolated config directory, not your CLI login)." });
    return false;
  };
  const orderIdSchema = z.enum(orders.map((order) => order.id) as [string, ...string[]]);

  router.post("/call", async (req, res) => {
    const parsed = z.object({ orderId: orderIdSchema, customerMessage: z.string().min(1).max(500) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    if (!live(res)) return;
    const { abort, send } = openSse(req, res);
    const client = await httpClient(req, "lesson page");
    try {
      send("start", { url: mcpUrl(req), ...parsed.data });
      const started = Date.now();
      const result = await client.callTool({ name: "review_refund", arguments: parsed.data }, undefined, {
        signal: abort.signal, timeout: 120_000, onprogress: (p) => send("progress", { ...p, ms: Date.now() - started }),
      });
      send("result", { ...result, ms: Date.now() - started, expected: policyDecision(orders.find((o) => o.id === parsed.data.orderId)!) });
    } catch (error) { if (!abort.signal.aborted) send("error", { message: String(error) }); }
    finally { await client.close().catch(() => {}); if (!res.destroyed) { send("done", {}); res.end(); } }
  });

  /** Another agent delegates to the desk. Its only tool is mcp__refund-desk__review_refund, reached over HTTP. */
  router.post("/delegate", async (req, res) => {
    const parsed = z.object({ orderIds: z.array(orderIdSchema).min(1).max(4) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    if (delegating) return res.status(409).json({ message: "A delegation run is already running." });
    if (!live(res)) return;
    delegating = true;
    const { abort, send } = openSse(req, res);
    const inner: CallLog[] = [];
    const onCall = (entry: CallLog) => { if (entry.caller === "outer agent") { inner.push(entry); send("inner", entry); } };
    state.listeners.add(onCall);
    const controller = new AbortController(); abort.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const deadline = setTimeout(() => { send("error", { message: "180-second deadline reached." }); controller.abort(); }, 180_000);
    const requests = parsed.data.orderIds.map((id) => `- ${id}: "${sampleMessages[id]}"`).join("\n");
    const options: Options = {
      model: MODEL, systemPrompt: leadSystemPrompt, thinking: { type: "disabled" },
      tools: [], settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk",
      mcpServers: { "refund-desk": { type: "http", url: mcpUrl(req), headers: { Authorization: `Bearer ${token}`, "x-caller": "outer agent" }, timeout: 120_000 } },
      allowedTools: ["mcp__refund-desk__review_refund"],
      maxTurns: 8, maxBudgetUsd: 0.1, persistSession: false,
      cwd: path.join(LAB, "work"), env: agentEnv(path.join(LAB, "lead-config")), abortController: controller,
    };
    const q = query({ prompt: `Refund requests:\n${requests}`, options });
    try {
      send("start", { prompt: `Refund requests:\n${requests}`, url: mcpUrl(req) });
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") send("init", { mcp_servers: message.mcp_servers, tools: message.tools });
        if (message.type === "assistant") for (const block of message.message.content) {
          if (block.type === "tool_use") send("tool", { id: block.id, name: block.name, input: block.input });
          if (block.type === "text" && block.text.trim()) send("text", { text: block.text });
        }
        if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content)
          if (typeof block === "object" && block.type === "tool_result") send("tool_result", { id: block.tool_use_id, isError: Boolean(block.is_error), content: block.content });
        if (message.type === "result") {
          const innerUsd = inner.reduce((sum, entry) => sum + (entry.usage?.costUsd ?? 0), 0);
          send("result", { subtype: message.subtype, text: message.subtype === "success" ? message.result : message.errors.join("; "), turns: message.num_turns, outerUsd: message.total_cost_usd, innerUsd, innerCalls: inner.length });
        }
      }
    } catch (error) { if (!controller.signal.aborted) send("error", { message: String(error) }); }
    finally {
      clearTimeout(deadline); q.close(); state.listeners.delete(onCall); delegating = false;
      if (!res.destroyed) { send("done", {}); res.end(); }
    }
  });

  return router;
}

export const concept61 = createConcept61();
