/**
 * CONCEPT 43 — Remote MCP servers (OAuth, transports, a live session) and MCP resources
 *
 *   mcpServers: { shop: { type: "http", url, headers: { Authorization: `Bearer ${token}` }, timeout: 1500 } }
 *
 * A REMOTE server is one Claude Code reaches over the network (type "http", or the older "sse"). The lab runs one on
 * its own port on 127.0.0.1 ("the remote"), protected like a real one: every MCP request needs an OAuth access token.
 *   - With no token, Claude Code finds the OAuth metadata (WWW-Authenticate → /.well-known/…) and stops: "needs-auth".
 *     A headless agent can't open a browser, so the server's tools are simply missing. And that answer is CACHED by
 *     server name (CLAUDE_CONFIG_DIR/mcp-needs-auth-cache.json): the next runs skip the server, even with a good token.
 *   - With headers.Authorization, the OAuth fallback is off: a wrong token is "failed", with a clear error.
 *   - The host does the OAuth itself (client_credentials here), and passes the token in `headers`.
 *   - In a live session: an expired token → the tool call fails and the server becomes "needs-auth" → the host gets a
 *     new token and calls setMcpServers(); a lost MCP session (404) → Claude Code initializes again on its own;
 *     `timeout` cancels a slow call (notifications/cancelled); a new resource is seen only after reconnectMcpServer().
 *
 * RESOURCES are the other half of MCP: data the server offers by URI (docs://runbook), not actions.
 *   - Claude Code gives the model three tools for them: ListMcpResourcesTool, ReadMcpResourceTool (and
 *     ReadMcpResourceDirTool), only when they are in `tools` (or with the default tool set). tools: [] removes them.
 *   - ui:// resources (MCP Apps) are left out of the list; templates (orders://{id}) are not listed either.
 *   - A binary resource is saved to a file (blobSavedTo); a tool's resource_link blocks arrive as
 *     tool_use_result.resourceLinks.
 *   - "@shop:docs://runbook" in the prompt is NOT expanded in an SDK run: the host reads the resource itself.
 *   - q.readMcpResource(server, uri) reads a ui:// resource for the host (any other scheme is refused).
 * Routes: GET /facts, POST /auth, /cache, /transports, /toolsets, /resources, /host-read, /live (SSE), GET /code.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";
import { z } from "zod";
import { query, type McpServerConfig, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openSse } from "../sse.js";

export const concept43 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("remote-lab");
const WORK = path.join(LAB, "work"); // the agents' cwd (no file tools: it stays empty)
const ROOT = process.cwd();
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replaceAll(LAB, "remote-lab")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…")
    .replace(/Bearer [\w.-]+/g, (m) => `Bearer ${tokenLabel(m.slice(7))}`); // never show a token, only its number

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The remote: an MCP server on its own port, protected by OAuth, with tools AND resources
// ---------------------------------------------------------------------------------------------

// #region remote
const CLIENT = { id: "lab-agent", secret: "lab-agent-secret" }; // the host's OAuth client (client_credentials)
const TOKEN_TTL_S = 600;
const tokens = new Map<string, { n: number; exp: number }>(); // access token → its number and expiry
let tokenCount = 0;
function tokenLabel(t: string) {
  const k = tokens.get(t);
  return k ? `token #${k.n}` : t ? "an unknown token" : "none";
}
const validToken = (h?: string) => {
  const t = h?.startsWith("Bearer ") ? h.slice(7) : "";
  const k = tokens.get(t);
  return !!k && k.exp > Date.now();
};

const RUNBOOK = "# On-call runbook\n1. Check https://status.example/health.\n2. If the shop is down, restart it with the restart word PELICAN-42.\n3. Tell #shop-ops.";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4//8/AwAI/AL+p5qgoAAAAABJRU5ErkJggg==";
const WIDGET = `<!doctype html><html><body><h1>Orders</h1><p>An MCP App (SEP-1865): a host renders this next to the tool result, sandboxed.</p></body></html>`;
const extra: { name: string; uri: string; text: string }[] = []; // resources added while the lab runs (Part F)

/** One MCP server object per MCP session. The same definitions every time: 3 tools, 4 resources, 1 template. */
function shopServer() {
  const s = new McpServer({ name: "lab-shop", version: "1.0.0" }, { instructions: "The Widget Co shop: orders, the on-call runbook, the logo." });
  const read = (uri: URL, mimeType: string, body: { text: string } | { blob: string }) => ({ contents: [{ uri: uri.href, mimeType, ...body }] });
  s.registerResource("runbook", "docs://runbook", { title: "On-call runbook", description: "What to do when the shop is down", mimeType: "text/markdown" }, async (u) => read(u, "text/markdown", { text: RUNBOOK }));
  s.registerResource("logo", "files://logo.png", { title: "Widget Co logo", mimeType: "image/png" }, async (u) => read(u, "image/png", { blob: PNG_1PX }));
  s.registerResource("orders-widget", "ui://orders/widget", { title: "Orders widget", mimeType: "text/html;profile=mcp-app" }, async (u) => read(u, "text/html;profile=mcp-app", { text: WIDGET }));
  // A template: one resource per order id. It is not in resources/list; the model learns the URIs from find_orders.
  s.registerResource("order", new ResourceTemplate("orders://{id}", { list: undefined }), { title: "An order", mimeType: "application/json" }, async (u, { id }) =>
    read(u, "application/json", { text: JSON.stringify({ id, customer: id === "1001" ? "ana" : "bob", status: id === "1001" ? "shipped" : "pending", total: 42 }) }),
  );
  for (const r of extra) s.registerResource(r.name, r.uri, { mimeType: "text/plain" }, async (u) => read(u, "text/plain", { text: r.text }));

  s.registerTool("find_orders", { description: "Find the orders of a customer. Returns links to the order resources (orders://<id>).", inputSchema: { customer: z.string() }, annotations: { readOnlyHint: true } }, async ({ customer }) => ({
    content: [
      { type: "text", text: `2 orders for ${customer}.` },
      { type: "resource_link", uri: "orders://1001", name: "order-1001", mimeType: "application/json", description: "Order 1001" },
      { type: "resource_link", uri: "orders://1002", name: "order-1002", mimeType: "application/json", description: "Order 1002" },
    ],
  }));
  s.registerTool("slow_report", { description: "Build the sales report. Takes `ms` milliseconds.", inputSchema: { ms: z.number().int().min(0).max(20000) } }, async ({ ms }) => {
    await sleep(ms);
    return { content: [{ type: "text", text: "The sales report is ready." }] };
  });
  // A tool that declares an MCP App: the host can render ui://orders/widget next to its result (Part E).
  s.registerTool("show_orders", { description: "Show the orders widget.", inputSchema: {}, _meta: { ui: { resourceUri: "ui://orders/widget" } } }, async () => ({ content: [{ type: "text", text: "Showing the orders widget." }] }));
  return s;
}

export type WireRow = { at: number; lane: string; dir: "in" | "out"; method: string; path: string; rpc?: string; status?: number; auth: string; session?: string };
const wire = new EventEmitter(); // one "request" per HTTP request the remote answers (and one per notification it sends)
const laneOf = (p: string) => p.match(/\/l\/([\w-]+)/)?.[1] ?? "?";
const rpcName = (b: any): string | undefined => (Array.isArray(b) ? b.map(rpcName).join(", ") : b?.method ? `${b.method}${b.params?.name ? ` ${b.params.name}` : b.params?.uri ? ` ${b.params.uri}` : ""}` : undefined);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  // Log each request once, when its status is known (for a stream: when it opens).
  const writeHead = res.writeHead;
  let logged = false;
  res.writeHead = function (this: any, ...a: any[]) {
    if (!logged) {
      logged = true;
      const sid = req.headers["mcp-session-id"] ?? req.query.sessionId;
      wire.emit("request", {
        at: Date.now(),
        lane: laneOf(req.path),
        dir: "in",
        method: req.method,
        path: req.path.replace(/^\/l\/[\w-]+/, ""),
        rpc: req.method === "POST" ? (rpcName(req.body) ?? (req.body?.grant_type ? `grant_type=${req.body.grant_type}` : undefined)) : req.method === "GET" && /\/(mcp|sse)$/.test(req.path) ? "(open the event stream)" : undefined,
        status: a[0],
        auth: short(String(req.headers.authorization ?? "none")).replace(/^Bearer /, ""),
        session: sid ? String(sid).slice(0, 8) : undefined,
      } satisfies WireRow);
    }
    return writeHead.apply(this, a as any);
  } as any;
  next();
});

let remoteBase = ""; // http://127.0.0.1:<port>, set when the remote listens
// OAuth 2.0 Protected Resource Metadata (RFC 9728) and Authorization Server Metadata (RFC 8414), one "issuer" per lane.
app.get("/l/:lane/.well-known/oauth-protected-resource", (req, res) => void res.json({ resource: `${remoteBase}/l/${req.params.lane}/mcp`, authorization_servers: [`${remoteBase}/l/${req.params.lane}/auth`], scopes_supported: ["shop"] }));
app.get(/^\/\.well-known\/(oauth-authorization-server|openid-configuration)/, (req, res) => {
  const iss = `${remoteBase}/l/${laneOf(req.path)}/auth`;
  // registration_endpoint: dynamic client registration (RFC 7591). Without it Claude Code gives up at once ("failed:
  // Incompatible auth server"); with it, it gets as far as "needs-auth": the next step would be a browser sign-in.
  res.json({ issuer: iss, token_endpoint: `${iss}/token`, authorization_endpoint: `${iss}/authorize`, registration_endpoint: `${iss}/register`, grant_types_supported: ["client_credentials", "authorization_code"], response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
});
app.post("/l/:lane/auth/register", (req, res) => void res.status(201).json({ client_id: `dcr-${randomUUID().slice(0, 8)}`, redirect_uris: req.body?.redirect_uris ?? [], token_endpoint_auth_method: "none" }));
app.get("/l/:lane/auth/authorize", (_req, res) => void res.status(200).type("html").send("<h1>Sign in to Widget Co</h1><p>A person would sign in here. A headless agent never gets this far.</p>"));
app.post("/l/:lane/auth/token", (req, res) => {
  const b = req.body ?? {};
  if (b.grant_type !== "client_credentials" || b.client_id !== CLIENT.id || b.client_secret !== CLIENT.secret) return void res.status(401).json({ error: "invalid_client" });
  const t = randomBytes(24).toString("base64url");
  tokens.set(t, { n: ++tokenCount, exp: Date.now() + TOKEN_TTL_S * 1000 });
  res.json({ access_token: t, token_type: "Bearer", expires_in: TOKEN_TTL_S, scope: "shop" });
});

/** No valid token: 401, and where to find the OAuth metadata (that is what makes Claude Code try OAuth). */
function requireToken(req: express.Request, res: express.Response) {
  if (validToken(req.headers.authorization)) return true;
  res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${remoteBase}/l/${req.params.lane}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: "invalid_token", error_description: "A valid access token is required" });
  return false;
}

// Streamable HTTP, stateful: `initialize` opens an MCP session (Mcp-Session-Id), every later request carries it.
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; lane: string; since: number }>(); // Claude Code rarely closes one: they stay until the lab restarts
app.all("/l/:lane/mcp", async (req, res) => {
  if (!requireToken(req, res)) return;
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const known = sid ? sessions.get(sid) : undefined;
  if (known) return void (await known.transport.handleRequest(req, res, req.body));
  if (sid) return void res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }); // the client must initialize again
  if (req.method !== "POST" || req.body?.method !== "initialize") return void res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No session: send initialize first" }, id: null }); // e.g. Claude Code's server/discover probe
  const server = shopServer();
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => void sessions.set(id, { transport, server, lane: req.params.lane, since: Date.now() }),
  });
  transport.onclose = () => void (transport.sessionId && sessions.delete(transport.sessionId));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// The older HTTP+SSE transport: GET /sse keeps a stream open, the client POSTs to /messages?sessionId=…
const sseSessions = new Map<string, SSEServerTransport>();
app.get("/l/:lane/sse", async (req, res) => {
  if (!requireToken(req, res)) return;
  const transport = new SSEServerTransport(`/l/${req.params.lane}/messages`, res);
  sseSessions.set(transport.sessionId, transport);
  res.on("close", () => sseSessions.delete(transport.sessionId));
  await shopServer().connect(transport);
});
app.post("/l/:lane/messages", async (req, res) => {
  if (!requireToken(req, res)) return;
  const t = sseSessions.get(String(req.query.sessionId));
  if (!t) return void res.status(404).json({ error: "unknown sessionId" });
  await t.handlePostMessage(req, res, req.body);
});

let remoteServer: Server | undefined;
const remoteReady = new Promise<string>((resolve) => {
  remoteServer = app.listen(0, "127.0.0.1", () => resolve((remoteBase = `http://127.0.0.1:${(remoteServer!.address() as { port: number }).port}`)));
});
const mcpUrl = async (lane: string, transport: "http" | "sse" = "http") => `${await remoteReady}/l/${lane}/${transport === "http" ? "mcp" : "sse"}`;
// #endregion

// ---------------------------------------------------------------------------------------------
// The host's OAuth: discover the authorization server from the 401, then get a token (client_credentials)
// ---------------------------------------------------------------------------------------------

// #region oauth
async function getToken(mcp: string, emit: Emit) {
  // 1. Ask without a token: the 401 says where the metadata is.
  const r1 = await fetch(mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  const metaUrl = r1.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  emit("oauth", { step: "1 · POST the MCP URL without a token", detail: `${r1.status} · WWW-Authenticate → resource_metadata=${metaUrl?.replace(remoteBase, "")}` });
  if (r1.status !== 401 || !metaUrl) throw new Error(`expected a 401 with resource_metadata, got ${r1.status}`);
  // 2. The protected resource names its authorization server.
  const prm = (await (await fetch(metaUrl)).json()) as { authorization_servers: string[] };
  const issuer = prm.authorization_servers[0];
  emit("oauth", { step: "2 · GET the protected resource metadata", detail: `authorization_servers: ["${issuer.replace(remoteBase, "")}"]` });
  // 3. The authorization server's metadata gives the token endpoint (RFC 8414: /.well-known/… + the issuer's path).
  const as = (await (await fetch(`${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`)).json()) as { token_endpoint: string };
  emit("oauth", { step: "3 · GET the authorization server metadata", detail: `token_endpoint: ${as.token_endpoint.replace(remoteBase, "")}` });
  // 4. A machine client: client_credentials, no browser. (A user-facing app would run the authorization_code flow.)
  const r4 = await fetch(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT.id, client_secret: CLIENT.secret, scope: "shop" }) });
  const tok = (await r4.json()) as { access_token: string; expires_in: number };
  emit("oauth", { step: "4 · POST client_credentials to the token endpoint", detail: `${r4.status} · ${tokenLabel(tok.access_token)}, expires_in ${tok.expires_in} s` });
  return tok.access_token;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// Options, and one run
// ---------------------------------------------------------------------------------------------

// #region options
/** A CLAUDE_CONFIG_DIR per lane, emptied before the run unless `keep`: Claude Code keeps MCP auth state there. */
function configDir(lane: string, keep = false) {
  const dir = path.join(LAB, `config-${lane}`);
  if (!keep) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function base(abort: AbortController, config: string, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = config;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  mkdirSync(WORK, { recursive: true });
  return {
    model: MODEL,
    cwd: WORK,
    env,
    tools: [], // no built-in tools; each scenario adds the resource tools when it needs them
    settingSources: [],
    strictMcpConfig: true, // only the servers in mcpServers (Concept 13)
    thinking: { type: "disabled" },
    maxTurns: 8,
    abortController: abort,
    ...extra,
  };
}

/** The remote server's config. With a token, `headers` carries it, and Claude Code never tries OAuth itself. */
const shopConfig = (url: string, token?: string, extra: object = {}): McpServerConfig => ({
  type: url.endsWith("/sse") ? "sse" : "http",
  url,
  ...(token !== undefined && { headers: { Authorization: `Bearer ${token}` } }),
  ...extra,
});
// #endregion

// #region run
const RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool"];

/** The typed result of a tool (sdk-tools.d.ts: ListMcpResourcesOutput, ReadMcpResourceOutput; an MCP tool's content). */
function toolOutput(r: any, isError: boolean) {
  if (isError) return { error: cut(short(String(r).replace(/^Error: /, "")), 400) };
  if (Array.isArray(r)) return { resources: r.map((x: any) => ({ uri: x.uri, name: x.name, mimeType: x.mimeType, server: x.server })) }; // ListMcpResourcesTool
  if (r?.contents)
    return { contents: r.contents.map((c: any) => ({ uri: c.uri, mimeType: c.mimeType, text: c.text && !c.blobSavedTo ? cut(short(c.text), 600) : undefined, blobSavedTo: c.blobSavedTo && short(c.blobSavedTo).replace(/projects([\\/])[^\\/]+[\\/][^\\/]+[\\/]/, "projects$1…$1") })) }; // ReadMcpResourceTool
  if (r?.content) return { text: cut(short(r.content.map((c: any) => c.text ?? `[${c.type}]`).join("\n")), 600), resourceLinks: r.resourceLinks }; // an MCP tool
  return { text: cut(short(typeof r === "string" ? r : JSON.stringify(r)), 600) };
}

export type RunResult = { subtype: string; text: string; cost: number; turns: number; tools: string[]; servers: any[]; calls: { name: string; input: any; output: any }[] };

/** Streams one query() (a prompt, or a live session's input) as rows. `onInit` runs as soon as system/init arrives. */
async function runAgent(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, emit: Emit, hooks: { onInit?: (q: Query) => Promise<void>; onResult?: (q: Query) => Promise<void> } = {}) {
  const out: RunResult = { subtype: "none", text: "", cost: 0, turns: 0, tools: [], servers: [], calls: [] };
  const calls = new Map<string, { name: string; input: any; output?: any }>();
  const q = query({ prompt, options });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        out.tools = m.tools;
        out.servers = m.mcp_servers;
        emit("init", { mcpServers: m.mcp_servers, tools: m.tools });
        await hooks.onInit?.(q);
      }
      if (m.type === "assistant")
        for (const b of m.message.content) {
          if (b.type === "text" && b.text.trim()) emit("text", { text: cut(short(b.text), 1200) });
          if (b.type === "tool_use") {
            calls.set(b.id, { name: b.name, input: b.input });
            emit("tool", { id: b.id, name: b.name, input: b.input });
          }
        }
      if (m.type === "user" && Array.isArray(m.message.content))
        for (const b of m.message.content) {
          if (b.type !== "tool_result" || !calls.has(b.tool_use_id)) continue;
          const call = calls.get(b.tool_use_id)!;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          // tool_use_result: the typed output (one per message). An error is only text.
          const typed = b.is_error ? text : m.message.content.length === 1 && m.tool_use_result !== undefined ? m.tool_use_result : text;
          call.output = toolOutput(typed, !!b.is_error);
          out.calls.push(call as any);
          emit("toolResult", { id: b.tool_use_id, name: call.name, isError: !!b.is_error, output: call.output });
        }
      if (m.type === "result") {
        out.subtype = m.subtype;
        out.cost = m.total_cost_usd; // in a session, total_cost_usd is the total so far (not this turn)
        out.turns += m.num_turns;
        out.text = m.subtype === "success" ? short(m.result) : short((m.errors ?? []).join("; "));
        emit("result", { subtype: m.subtype, text: cut(out.text, 1500), cost: m.total_cost_usd, turns: m.num_turns });
        await hooks.onResult?.(q);
      }
    }
  } catch (err) {
    if (!options.abortController?.signal.aborted) throw err;
  }
  return out;
}

/** What mcpServerStatus() says, without the config: it holds the headers, so the token too. */
const statusRows = async (q: Query) =>
  (await q.mcpServerStatus()).map((s) => ({ name: s.name, status: s.status, error: s.error && short(s.error), serverInfo: s.serverInfo, tools: s.tools?.map((t) => ({ name: t.name, _meta: t._meta })) }));
/** A streaming-input session (Concept 12): say() sends a turn and waits for its result. */
function liveSession(options: Options, emit: Emit, onInit?: (q: Query) => Promise<void>) {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let turnDone: (() => void) | undefined;
  async function* input() {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  let q!: Query;
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const done = runAgent(input(), options, emit, { onInit: async (qq) => ((q = qq), ready(), await onInit?.(qq)), onResult: async () => turnDone?.() });
  const say = async (text: string) => {
    emit("say", { text });
    const t = new Promise<void>((r) => (turnDone = r));
    queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
    wake?.();
    await Promise.race([t, done]);
  };
  const end = async () => ((closed = true), wake?.(), await done);
  return { say, end, started, done, query: () => q };
}
// #endregion

/** An SSE route: parse the body, stream the rows (with their time) and the remote's requests, end with "done". */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
    const lanes = new Set<string>(); // the remote's rows go to the run whose lanes they belong to
    (emit as any).lanes = lanes;
    const onWire = (r: WireRow) => lanes.has(r.lane) && emit("wire", { ...r, at: r.at - startedAt });
    wire.on("request", onWire);
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await remoteReady;
      await body(parsed.data, abort, emit);
    } catch (err) {
      if (!abort.signal.aborted) emit("error", { message: errText(err) });
    } finally {
      wire.off("request", onWire);
      send("done", {});
      res.end();
    }
  };
}
/** A lane: its own URL path on the remote (so its requests can be told apart), its own rows. */
function laneEmit(emit: Emit, lane: string): Emit {
  ((emit as any).lanes as Set<string>).add(lane);
  return (e, d) => emit(e, { ...d, lane });
}

// ---------------------------------------------------------------------------------------------
// GET /facts: the remote's address, what it serves, and the resource tools' types from the installed SDK
// ---------------------------------------------------------------------------------------------

const SDK_DIR = path.resolve("node_modules/@anthropic-ai/claude-agent-sdk");
function pickTypes(names: string[]) {
  const dts = readFileSync(path.join(SDK_DIR, "sdk-tools.d.ts"), "utf8").replaceAll("\r\n", "\n");
  const main = readFileSync(path.join(SDK_DIR, "sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
  const pick = (name: string) => {
    const src = (dts + main).match(new RegExp(`export (?:interface|type|declare type) ${name}(?: =)? \\{[\\s\\S]*?\\n\\}[\\[\\]]*;?`))?.[0] ?? `// ${name}: not found`;
    return src
      .replace(/\n(\s*)\/\*\*([\s\S]*?)\*\/\n\s*([^\n]+)/g, (_, ind, doc, line) => `\n${ind}${line}  // ${doc.replace(/\s*\*\s*/g, " ").trim().slice(0, 90)}`)
      .replace(/\n\s*\/\*\*[\s\S]*?\*\//g, "");
  };
  return Object.fromEntries(names.map((n) => [n, pick(n)]));
}

concept43.get("/facts", async (_req, res) => {
  try {
    const url = await remoteReady;
    res.json({
      remote: url,
      client: { id: CLIENT.id, grant: "client_credentials", tokenTtlSeconds: TOKEN_TTL_S },
      serves: {
        tools: ["find_orders (returns resource_link blocks)", "slow_report (waits ms)", "show_orders (declares _meta.ui.resourceUri)"],
        resources: ["docs://runbook (text/markdown)", "files://logo.png (image/png, a blob)", "ui://orders/widget (an MCP App)"],
        templates: ["orders://{id}"],
      },
      types: pickTypes(["ListMcpResourcesInput", "ListMcpResourcesOutput", "ReadMcpResourceInput", "ReadMcpResourceOutput", "SDKMcpResourceLink"]),
    });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /auth: three agents connect to the protected remote: no token, a wrong token, a token the host got
// ---------------------------------------------------------------------------------------------

// #region auth
const AUTH_LANES = {
  none: "a · no headers: let Claude Code handle auth",
  wrong: "b · headers.Authorization with a wrong token",
  host: "c · the host gets a token (OAuth client_credentials) and passes it",
} as const;

/** What Claude Code wrote in its config dir about MCP auth (values of the credentials file hidden). */
function authFiles(dir: string) {
  const cache = path.join(dir, "mcp-needs-auth-cache.json");
  const cred = path.join(dir, ".credentials.json");
  const creds = existsSync(cred) ? JSON.parse(readFileSync(cred, "utf8")) : undefined;
  const mcpOAuth = creds?.mcpOAuth
    ? Object.fromEntries(
        Object.entries(creds.mcpOAuth).map(([k, v]: [string, any]) => [
          k,
          { serverUrl: short(String(v.serverUrl)), accessToken: v.accessToken ? "(set)" : "(empty)", discoveryState: v.discoveryState && { ...v.discoveryState, authorizationServerUrl: short(String(v.discoveryState.authorizationServerUrl ?? "")).replace(remoteBase, ""), resourceMetadataUrl: short(String(v.discoveryState.resourceMetadataUrl ?? "")).replace(remoteBase, "") } },
        ]),
      )
    : undefined;
  return { needsAuthCache: existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : null, mcpOAuth: mcpOAuth ?? null };
}

async function authLane(lane: keyof typeof AUTH_LANES, abort: AbortController, emit: Emit) {
  const e = laneEmit(emit, `auth-${lane}`);
  const url = await mcpUrl(`auth-${lane}`);
  const token = lane === "none" ? undefined : lane === "wrong" ? "not-a-real-token" : await getToken(url, e);
  const config = shopConfig(url, token);
  e("options", { mcpServers: { shop: { ...config, ...("headers" in config && { headers: { Authorization: short(`Bearer ${token}`) } }) } } });
  const dir = configDir(`auth-${lane}`);
  const run = await runAgent("Find the orders of customer ana with the shop tools. One line. If you have no shop tool, say so.", base(abort, dir, { mcpServers: { shop: config }, allowedTools: ["mcp__shop"], maxTurns: 4 }), e, {
    onInit: async (q) => e("status", { servers: await statusRows(q) }),
  });
  e("files", authFiles(dir));
  e("verdict", { status: run.servers.find((s) => s.name === "shop")?.status, shopTools: run.tools.filter((t) => t.startsWith("mcp__shop")), cost: run.cost });
}

concept43.post(
  "/auth",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await Promise.all((Object.keys(AUTH_LANES) as (keyof typeof AUTH_LANES)[]).map((l) => authLane(l, abort, emit).catch((err) => emit("error", { lane: `auth-${l}`, message: errText(err) }))));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /cache: the needs-auth answer is remembered by server name, and blocks the next runs
// ---------------------------------------------------------------------------------------------

// #region cache
const CacheBody = z.object({ fix: z.enum(["reconnect", "delete-cache", "rename"]) }).strict();

concept43.post(
  "/cache",
  sseRoute(CacheBody, async ({ fix }, abort, emit) => {
    const e = laneEmit(emit, "cache");
    const url = await mcpUrl("cache");
    const dir = configDir("cache"); // one config dir for the three runs, like one machine or one container
    const prompt = "Find the orders of customer ana with the shop tools. One line. If you have no shop tool, say so.";
    const check = (label: string) => async (q: Query) => e("status", { label, servers: await statusRows(q) });

    e("step", { title: "Run 1 · no token", note: "Claude Code tries OAuth, can't finish it without a browser, and writes mcp-needs-auth-cache.json" });
    await runAgent(prompt, base(abort, dir, { mcpServers: { shop: shopConfig(url) }, allowedTools: ["mcp__shop"], maxTurns: 3 }), e, { onInit: check("run 1") });
    e("files", authFiles(dir));

    const token = await getToken(url, e);
    e("step", { title: "Run 2 · the same config dir, now WITH a valid token", note: "Watch the remote's log: no request at all" });
    await runAgent(prompt, base(abort, dir, { mcpServers: { shop: shopConfig(url, token) }, allowedTools: ["mcp__shop"], maxTurns: 3 }), e, { onInit: check("run 2") });

    const name = fix === "rename" ? "shop2" : "shop";
    e("step", { title: `Run 3 · the fix: ${fix}`, note: FIX_NOTES[fix] });
    if (fix === "delete-cache") rmSync(path.join(dir, "mcp-needs-auth-cache.json"), { force: true });
    const options = base(abort, dir, { mcpServers: { [name]: shopConfig(url, token) }, allowedTools: [`mcp__${name}`], maxTurns: 4 });
    if (fix !== "reconnect") await runAgent(prompt, options, e, { onInit: check("run 3, at init") });
    else {
      // A streaming session (Concept 12): turn 1 starts before the reconnect is done, turn 2 comes after it.
      let reconnected = false;
      const s = liveSession(options, e, async (q) => {
        if (reconnected) return;
        reconnected = true;
        await check("run 3, at init")(q);
        await q.reconnectMcpServer("shop"); // a real connection attempt: the cache is not consulted
        e("host", { action: 'await q.reconnectMcpServer("shop")', detail: "done, while turn 1 runs" });
        await check("run 3, after reconnect")(q);
      });
      await s.say(prompt);
      await s.say(`Turn 2: ${prompt}`);
      await s.end();
    }
    e("files", authFiles(dir));
  }),
);
const FIX_NOTES = {
  reconnect: "q.reconnectMcpServer(\"shop\") right after system/init, in a streaming session. Turn 1 has already started without the tools; turn 2 has them.",
  "delete-cache": "The host deletes mcp-needs-auth-cache.json before the run: the server is contacted again at startup.",
  rename: "The same server under another name (shop2): the cache is keyed by name. The tools become mcp__shop2__*.",
} as const;
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /transports: the same question over Streamable HTTP and over the older HTTP+SSE, side by side
// ---------------------------------------------------------------------------------------------

// #region transports
concept43.post(
  "/transports",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const lane = async (transport: "http" | "sse") => {
      const e = laneEmit(emit, `tr-${transport}`);
      const url = await mcpUrl(`tr-${transport}`, transport);
      const token = await getToken(url.replace(/\/sse$/, "/mcp"), e);
      e("options", { mcpServers: { shop: { type: transport, url: url.replace(remoteBase, "http://127.0.0.1:…"), headers: { Authorization: short(`Bearer ${token}`) } } } });
      const run = await runAgent("Call find_orders for customer ana. Answer in one line.", base(abort, configDir(`tr-${transport}`), { mcpServers: { shop: shopConfig(url, token) }, allowedTools: ["mcp__shop"], maxTurns: 3 }), e);
      e("verdict", { status: run.servers[0]?.status, cost: run.cost });
    };
    await Promise.all([lane("http"), lane("sse")].map((p) => p.catch((err) => emit("error", { message: errText(err) }))));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /toolsets: which resource tools the model gets, for three values of `tools`. Stops at system/init: $0.
// ---------------------------------------------------------------------------------------------

// #region toolsets
const TOOLSETS = {
  empty: { label: "tools: []", tools: [] as string[] | undefined },
  listed: { label: `tools: ${JSON.stringify(RESOURCE_TOOLS)}`, tools: RESOURCE_TOOLS },
  default: { label: "tools not set (Claude Code's default set)", tools: undefined },
};

concept43.post(
  "/toolsets",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const url = await mcpUrl("toolsets");
    const token = await getToken(url, laneEmit(emit, "toolsets"));
    await Promise.all(
      (Object.keys(TOOLSETS) as (keyof typeof TOOLSETS)[]).map(async (k) => {
        const e = laneEmit(emit, `ts-${k}`);
        const stop = new AbortController(); // stop this run at system/init: nothing is sent to the model
        abort.signal.addEventListener("abort", () => stop.abort());
        const { tools, ...rest } = base(stop, configDir(`ts-${k}`), { mcpServers: { shop: shopConfig(url, token) } });
        const options = TOOLSETS[k].tools === undefined ? rest : { ...rest, tools: TOOLSETS[k].tools };
        const run = await runAgent("Say OK.", options, e, { onInit: async (q) => (stop.abort(), q.close()) }); // close(): end the Claude Code process now
        e("verdict", { label: TOOLSETS[k].label, total: run.tools.length, mcpish: run.tools.filter((t) => /mcp/i.test(t)) });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /resources: the model lists and reads resources, follows a tool's resource links, reads a blob
// ---------------------------------------------------------------------------------------------

// #region resources
concept43.post(
  "/resources",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const e = laneEmit(emit, "res");
    const url = await mcpUrl("res");
    const token = await getToken(url, e);
    const options = base(abort, configDir("res"), {
      tools: RESOURCE_TOOLS, // ← the resource tools, and nothing else built in
      allowedTools: ["mcp__shop", ...RESOURCE_TOOLS],
      mcpServers: { shop: shopConfig(url, token) },
    });
    e("options", { tools: options.tools, allowedTools: options.allowedTools });
    const prompt =
      "1) List the MCP resources. 2) Read the runbook and tell me the restart word. 3) Read the logo. " +
      "4) Find the orders of customer ana, then read the first order it links to and tell me its status. Answer in 4 short lines.";
    e("prompt", { prompt });
    const run = await runAgent(prompt, options, e);
    const reads = run.calls.filter((c) => c.name === "ReadMcpResourceTool");
    e("check", {
      listed: run.calls.find((c) => c.name === "ListMcpResourcesTool")?.output?.resources?.map((r: any) => r.uri) ?? [],
      read: reads.map((c) => ({ server: c.input.server, uri: c.input.uri, ok: !c.output?.error, error: c.output?.error })),
      links: run.calls.find((c) => c.name === "mcp__shop__find_orders")?.output?.resourceLinks ?? [],
      restartWord: /PELICAN-42/.test(run.text),
      cost: run.cost,
    });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /host-read: "@shop:docs://runbook" vs the host reading the resource itself; q.readMcpResource() for ui://
// ---------------------------------------------------------------------------------------------

// #region hostread
/** The host's own MCP client: the same URL and token, no model involved. */
async function hostReadResource(url: string, token: string, uri: string) {
  const client = new Client({ name: "lab-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    return await client.readResource({ uri });
  } finally {
    await client.close();
  }
}

concept43.post(
  "/host-read",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const url = await mcpUrl("hr-mention");
    const token = await getToken(url, laneEmit(emit, "hr-mention"));
    const opts = (lane: string) => base(abort, configDir(lane), { mcpServers: { shop: shopConfig(url.replace("hr-mention", lane), token) }, allowedTools: ["mcp__shop"], maxTurns: 2 });
    const question = "What is the restart word in the on-call runbook? Do not use any tool. If you don't have the runbook, say so.";

    // a · an @-mention, as you would type it in the Claude Code terminal
    const mention = (async () => {
      const e = laneEmit(emit, "hr-mention");
      const prompt = `${question}\n\n@shop:docs://runbook`;
      e("prompt", { prompt });
      const run = await runAgent(prompt, opts("hr-mention"), e);
      e("verdict", { knowsWord: /PELICAN-42/.test(run.text), cost: run.cost });
    })();

    // b · the host reads the resource with its own MCP client and puts it in the prompt
    const attach = (async () => {
      const e = laneEmit(emit, "hr-attach");
      const r = await hostReadResource(url.replace("hr-mention", "hr-attach"), token, "docs://runbook");
      const c = r.contents[0] as { uri: string; mimeType?: string; text?: string };
      e("host", { action: 'client.readResource({ uri: "docs://runbook" })', detail: `${c.mimeType}, ${c.text?.length} chars` });
      const prompt = `${question}\n\n<resource server="shop" uri="${c.uri}" mimeType="${c.mimeType}">\n${c.text}\n</resource>`;
      e("prompt", { prompt });
      const run = await runAgent(prompt, opts("hr-attach"), e, {
        // c · while this session runs: the host asks Claude Code for the widget that show_orders declares
        onInit: async (q) => {
          const ce = laneEmit(emit, "hr-ui");
          const status = await statusRows(q);
          const meta = status[0]?.tools?.find((t) => t.name === "show_orders")?._meta;
          ce("host", { action: "mcpServerStatus() → tools[show_orders]._meta", detail: JSON.stringify(meta) });
          for (const uri of ["ui://orders/widget", "docs://runbook"])
            try {
              const w = await q.readMcpResource("shop", uri);
              ce("host", { action: `q.readMcpResource("shop", "${uri}")`, detail: `${w.contents[0]?.mimeType} · ${w.contents[0]?.text?.length} chars`, html: w.contents[0]?.text });
            } catch (err) {
              ce("host", { action: `q.readMcpResource("shop", "${uri}")`, error: errText(err) });
            }
        },
      });
      e("verdict", { knowsWord: /PELICAN-42/.test(run.text), cost: run.cost });
    })();
    laneEmit(emit, "hr-ui");
    await Promise.all([mention, attach].map((p) => p.catch((err) => emit("error", { message: errText(err) }))));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /live: one streaming session while the remote changes under it
// ---------------------------------------------------------------------------------------------

// #region live
const STEPS = ["expire", "sessions", "listchanged", "timeout"] as const;
const LiveBody = z.object({ steps: z.array(z.enum(STEPS)).min(1).max(4) }).strict();

concept43.post(
  "/live",
  sseRoute(LiveBody, async ({ steps }, abort, emit) => {
    const toLane = laneEmit(emit, "live");
    let listed: string[] = []; // what the last ListMcpResourcesTool call returned (step 3)
    const e: Emit = (ev, d: any) => {
      if (ev === "toolResult" && d.name === "ListMcpResourcesTool") listed = d.output?.resources?.map((r: any) => r.uri) ?? [];
      toLane(ev, d);
    };
    const runStart = Date.now(); // only this run's MCP sessions get the list_changed notification
    extra.length = 0; // the resource of the list_changed step is added during the run
    const url = await mcpUrl("live");
    let token = await getToken(url, e);
    const serverExtra = { timeout: 1500 }; // a remote call should not hang a turn: 1.5 s per tool call
    const options = base(abort, configDir("live"), { tools: RESOURCE_TOOLS, allowedTools: ["mcp__shop", ...RESOURCE_TOOLS], mcpServers: { shop: shopConfig(url, token, serverExtra) } });
    e("options", { mcpServers: { shop: { type: "http", url: url.replace(remoteBase, "http://127.0.0.1:…"), headers: { Authorization: short(`Bearer ${token}`) }, ...serverExtra } } });
    const s = liveSession(options, e);
    const status = async (label: string) => e("status", { label, servers: await statusRows(s.query()) });
    try {
      e("step", { title: "0 · A normal call", note: "The session opens, the handshake happens, one tool call" });
      const first = s.say("Call find_orders for customer ana. One line.");
      await Promise.race([s.started, s.done]);
      await first;

      if (steps.includes("expire")) {
        e("step", { title: "1 · The token expires", note: "The remote forgets every token (like an expiry). The next call gets a 401" });
        tokens.clear();
        await s.say("Call find_orders for customer bob. One line. If it fails, quote the error.");
        await status("after the failed call");
        token = await getToken(url, e); // the host's side: a new token…
        const r = await s.query().setMcpServers({ shop: shopConfig(url, token, serverExtra) }); // …in a new config: a new connection
        e("host", { action: "await q.setMcpServers({ shop: { …, headers: { Authorization: `Bearer ${newToken}` } } })", detail: JSON.stringify(r) });
        await s.say("Call find_orders for customer bob again. One line.");
      }
      if (steps.includes("sessions")) {
        e("step", { title: "2 · The remote loses its MCP sessions", note: "Like a restart or another instance behind a load balancer. The next request gets 404 Session not found" });
        sessions.clear();
        await s.say("Call find_orders for customer carl. One line. If it fails, quote the error.");
      }
      if (steps.includes("listchanged")) {
        e("step", { title: "3 · A new resource appears", note: "The remote adds docs://incident-42 and sends notifications/resources/list_changed" });
        extra.push({ name: "incident-42", uri: "docs://incident-42", text: "Incident 42: the payment gateway has been down since 10:05. Use the backup gateway." });
        for (const x of sessions.values())
          if (x.lane === "live" && x.since >= runStart && x.server.isConnected()) {
            // registerResource() on a connected server sends notifications/resources/list_changed on the session's stream
            x.server.registerResource("incident-42", "docs://incident-42", { mimeType: "text/plain" }, async (u) => ({ contents: [{ uri: u.href, mimeType: "text/plain", text: extra[0].text }] })); // sends list_changed
            wire.emit("request", { at: Date.now(), lane: "live", dir: "out", method: "SSE", path: "/mcp", rpc: "notifications/resources/list_changed", auth: "", session: x.transport.sessionId?.slice(0, 8) } satisfies WireRow);
          }
        await sleep(500);
        await s.say("List the MCP resources (names only). Is there an incident? One line.");
        // Tested: a connection opened normally ignores list_changed (3 runs out of 3). After a 404 recovery (step 2),
        // Claude Code reconnects about 0.3 s after the notification, so the list is already new (2 out of 2).
        const seen = listed.includes("docs://incident-42");
        e("note", {
          ok: seen,
          text: seen
            ? "docs://incident-42 is already listed: Claude Code reconnected by itself after the notification (see the initialize above). It does that on a connection it recovered from a 404 (step 2); a connection opened normally ignores list_changed."
            : "docs://incident-42 is not listed: Claude Code ignored list_changed and kept the list it read at connect time. The host reconnects.",
        });
        await s.query().reconnectMcpServer("shop");
        e("host", { action: 'await q.reconnectMcpServer("shop")', detail: "a new connection: tools/list and resources/list again" });
        await s.say("List the MCP resources again (names only). If there is an incident resource, read it and tell me what it says. Two lines.");
      }
      if (steps.includes("timeout")) {
        e("step", { title: "4 · A slow tool", note: "slow_report takes 4 s, the server's timeout is 1.5 s" });
        await s.say("Call slow_report with ms 4000. One line. If it fails, quote the error.");
      }
    } finally {
      await s.end();
      extra.length = 0;
    }
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept43.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
