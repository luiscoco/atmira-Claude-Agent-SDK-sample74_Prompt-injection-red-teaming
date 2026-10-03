# Concept 13: External MCP servers, step by step

This file explains how Concept 13 (**External MCP servers**) was added to the Claude Agent SDK Lab.
Concept 5 ([Tab5-Custom-tools.md](Tab5-Custom-tools.md)) served tools from an **in-process** MCP server
(`createSdkMcpServer`, `type: "sdk"`). Here the MCP server is a **separate program**: Claude Code either starts it
(`stdio`) or connects to it over the network (`http`). There are two parts:

- **A. One `query()` with external servers.** The config of each transport, what `system/init` reports, and how
  failures look.
- **B. Managing servers while a session runs.** `mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()` and
  `setMcpServers()` on a streaming-input session (Concept 12).

| Concept | Topic | Routes |
|---|---|---|
| 13 | External MCP servers: `stdio`, `http` (`sse`), status, runtime management | `/api/c13/query`, `/session`, `/send`, `/status`, `/toggle`, `/reconnect`, `/set-servers`, `/end`, and the MCP server itself on `/api/c13/mcp` |

**Files touched:**

| File | Change |
|---|---|
| `mcp-servers/notes-server.ts` | **New**: a standalone MCP server over **stdio** (a separate Node program) |
| `server/concepts/13-mcp-servers.ts` | **New**: the **http** MCP server (`/api/c13/mcp`), the server configs, Part A and Part B routes |
| `server/index.ts` | Mounts the router on `/api/c13` |
| `src/concepts/Concept13McpServers.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | Transport tags (`stdio`/`http`/`sdk`) and status badges |
| `package.json` | `@modelcontextprotocol/sdk` as a direct dependency (it was already installed by the Agent SDK) |
| `tsconfig.json` | Type-checks `mcp-servers/` too |
| `Tab1-query().md` | Adds Concept 13 to the table of concepts |

---

## Step 1: Read the type definitions

From `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`0.3.281`):

```ts
type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;

type McpStdioServerConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number; alwaysLoad?: boolean };
type McpHttpServerConfig  = { type: 'http'; url: string; headers?: Record<string, string>; timeout?: number; alwaysLoad?: boolean; ... };
type McpSSEServerConfig   = { type: 'sse';  url: string; headers?: Record<string, string>; ... };   // same shape, older transport
type McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer };           // Concept 5

type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: McpServerStatusConfig;
  source?: string;                 // "sdk" for in-process servers, a config scope ("dynamic", "project", ...) otherwise
  tools?: { name: string; description?: string; annotations?: {...} }[];
};

interface Query {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  reconnectMcpServer(serverName: string): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;  // { added, removed, errors }
}
```

The key difference from Concept 5: **stdio, http and sse configs are plain JSON.** They describe *where* the server is.
Claude Code (the CLI process that `query()` starts) does the connecting. An `sdk` config holds a live object, and
only your process can serve it.

## Step 2: Write a stdio server

**New file:** [mcp-servers/notes-server.ts](mcp-servers/notes-server.ts). It uses the official MCP TypeScript SDK
(`@modelcontextprotocol/sdk`, already in `node_modules` because the Agent SDK depends on it):

```ts
const server = new McpServer(
  { name: "lab-notes", version: "1.0.0" },
  { instructions: "Read-only access to the plain-text notes of the lab's sandbox folder." },
);
// …
server.registerTool(
  "search_notes",
  {
    description: "Find every line in the notes that contains a text (case-insensitive). Returns file, line number and line.",
    inputSchema: { text: z.string().min(2).describe("Text to look for, at least 2 characters") },
    annotations: { readOnlyHint: true },
  },
  async ({ text: needle }) => {
    // … read every note file, keep the lines that contain `needle`
    log("tools/call search_notes", { text: needle, hits: hits.length });
    return text(hits);
  },
);

await server.connect(new StdioServerTransport());
```

`text()` is a small helper in the same file: it wraps any value as `{ content: [{ type: "text", text: JSON }] }`.

Tools: `list_notes`, `search_notes`, and `server_process` (returns its own pid, parent pid, cwd and which env
variables it received, so you can *see* that it is another process).

Three rules for a stdio server:

1. **stdout belongs to the protocol.** A `console.log()` would corrupt the JSON-RPC stream. Log to stderr.
2. **Its configuration comes from `env`**: here `NOTES_DIR` (which folder to read) and `LAB_LOG_URL`.
3. **It could be any language.** Claude Code just sees a process that speaks MCP on stdin/stdout.

To show the tab *when* the process runs, it POSTs a small log line to `LAB_LOG_URL` (the lab server's
`/api/c13/log` route) when it starts and on every tool call.

The config that starts it, from `serverConfig()` in `13-mcp-servers.ts` (`NOTES_SERVER` is the absolute path to
`mcp-servers/notes-server.ts`):

```ts
case "notes":
  return {
    type: "stdio",
    command: process.execPath, // the same node.exe that runs this server: no PATH lookup
    args: ["--import", "tsx", NOTES_SERVER],
    env: { NOTES_DIR: SANDBOX, LAB_LOG_URL: `${LAB_URL}/api/c13/log` },
  };
```

## Step 3: Write an http server

The **inventory** server is Streamable HTTP, mounted on the lab's own Express app at `/api/c13/mcp`. It is
**stateless**: every request gets a new `McpServer` + transport:

```ts
concept13.post("/mcp", async (req, res) => {
  // … `methods` and `log()`: what the tab shows as "What the MCP servers saw"

  // The `headers` of the http config arrive here. A real server would validate an OAuth token instead.
  if (req.headers.authorization !== `Bearer ${INVENTORY_TOKEN}`) {
    log(401);
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or wrong bearer token" }, id: null });
    return;
  }
  const server = inventoryServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  log(res.statusCode);
});
```

The body of this route is not checked with zod: it is JSON-RPC, and the MCP transport checks it.

Tools: `list_products` (read-only) and `reserve` (changes the stock, returns `isError` if there is not enough).
The stock is a `Map` in this module, so it outlives every query and is shared by all of them. **Reset stock** puts
it back.

The config that connects to it, with a header chosen in the UI (right token, wrong token, or none).
`INVENTORY_TOKEN` is `"lab-secret-token"`, and with **no headers** the `headers` field is left out:

```ts
case "inventory":
  return {
    type: "http",
    url: `${LAB_URL}/api/c13/mcp`,
    ...(token !== "none" && { headers: { Authorization: `Bearer ${token === "right" ? INVENTORY_TOKEN : "not-the-token"}` } }),
  };
```

`sse` would have the same shape (`type: "sse"`, `url`, `headers`). It is the older MCP transport. New servers use
Streamable HTTP, so this lab doesn't include an sse server.

## Step 4: The route for Part A

```ts
const baseOptions = (): Options => ({
  model: MODEL,
  tools: [], // no built-in tools: every tool in this concept comes from an MCP server
  cwd: SANDBOX,
  settingSources: [],
  strictMcpConfig: true, // only the servers in mcpServers; the machine's own MCP servers stay out
});
// …
const mcpServers = buildServers(body.servers, body.token);
const options: Options = { ...baseOptions(), mcpServers, allowedTools: body.allowedTools };
```

`MODEL` is Haiku. `body.allowedTools` holds rules like `mcp__notes` or `mcp__inventory__list_products`. The body is
checked with zod first, so `body.servers` can only hold the four names below.

The four servers the tab can pick: `notes` (stdio), `inventory` (http), `clock` (an sdk server, for comparison with
Concept 5) and `broken` (a stdio command that doesn't exist).

External servers run outside `query()`, so their log lines can't come through the message stream. An
`EventEmitter` collects them (the notes process POSTs to `/api/c13/log`, the http route emits directly) and the
route forwards them as `mcp_log` SSE events. The tab shows them as **What the MCP servers saw**.

---

# Part A: One query() with external servers

## Step 5: What happens, tested

Every scenario ran against the real SDK with Haiku.

**All four servers** (`notes`, `inventory`, `clock`, `broken`), asking about TODO notes, monitor stock and the pid:

```
  993ms  inventory  server/discover            HTTP 400    <- Claude Code probes first; the server doesn't know it
 1010ms  inventory  initialize                 HTTP 200
 1035ms  inventory  notifications/initialized  HTTP 202
 1137ms  inventory  tools/list                 HTTP 200
 1680ms  notes      process started            pid 31344, cwd ...\sample13\sandbox
 1719ms  system/init mcp_servers: notes connected (dynamic) · inventory connected (dynamic) · broken failed (dynamic) · clock connected (sdk)
         tools: mcp__clock__now, mcp__inventory__list_products, mcp__inventory__reserve, mcp__notes__list_notes, ...
 3737ms  tool_use mcp__notes__search_notes {"text":"TODO"}      -> notes: tools/call search_notes, 1 hit
 3757ms  tool_use mcp__inventory__list_products {}             -> inventory: tools/call list_products
 3795ms  tool_use mcp__notes__server_process {}                -> pid 31344, parentPid 18916
 5854ms  result/success  4 turns  $0.0076
```

What this run shows:

- **Everything connects before the first turn.** The http handshake and the stdio process start both happen
  before `system/init`.
- **The stdio process is a child of Claude Code, not of the lab server.** Its `parentPid` is the Claude Code CLI
  process. Its `cwd` is `options.cwd` (the sandbox).
- **`env` is added to the environment, it does not replace it.** `server_process` reported `ANTHROPIC_API_KEY: true`
  although only `NOTES_DIR` and `LAB_LOG_URL` were in `env`. A stdio server inherits the environment, including your
  secrets. Only run stdio servers you trust.
- **`source`** is `dynamic` for servers given in `options.mcpServers` and `sdk` for in-process ones.
- **For the model, all four are the same**: `mcp__<server>__<tool>`, exactly like Concept 5.

| Scenario | Result |
|---|---|
| 1 · stdio | The notes process started, `search_notes` found `notes.txt` line 5, `server_process` returned its pid |
| 2 · http | The full handshake in *What the MCP servers saw*, then `tools/call list_products`: "4 units" |
| 3 · Wrong token (and *no headers*) | `server/discover` 401, `initialize` 401 → `inventory: failed`, `tools: []`. **`result/success`**: *"I don't have access to an inventory management tool..."* |
| 4 · A server that can't start | `broken: failed`, `notes: connected`, the answer listed `notes.txt` |
| 5 · Allow one tool | `reserve` → `system/permission_denied`, `permission_denials: ["mcp__inventory__reserve"]`, stock unchanged |
| 6 · All transports | The run above |

Two lessons from scenario 3:

1. **A failed server does not fail the run.** There is no error and no exception. The server's tools are simply
   missing, and the model answers without them. If a server is required, **check `system/init.mcp_servers`** (or
   `mcpServerStatus()`) yourself, and stop the run when it isn't `connected`.
2. **401 means `failed`, not `needs-auth`.** `needs-auth` is for servers that support the MCP OAuth flow (a 401 with
   OAuth metadata). This server only checks a static header.

---

# Part B: Managing servers while a session runs

## Step 6: The live session

The session route reuses the input queue from Concepts 10 and 12. `allowedTools` allows all four servers, so Part B
is about servers, not about permissions. Each control is one small route, wrapped in a `control()` helper like
Concept 12's (check the body → find the session → run → `409` on error). This one also takes a function that names
the call, and it writes the result or the error to the session's stream itself.

| Route | Calls |
|---|---|
| `POST /status` | `await q.mcpServerStatus()` |
| `POST /toggle` | `await q.toggleMcpServer(name, enabled)` |
| `POST /reconnect` | `await q.reconnectMcpServer(name)` |
| `POST /set-servers` | `await q.setMcpServers(buildServers(names))` → `{ added, removed, errors }` |
| `POST /send`, `/end` | push a user message, close the input |

The tab asks for a fresh `mcpServerStatus()` after every control, so the status table always matches the session.

## Step 7: Status, toggle and reconnect, tested

Started with `notes`, `inventory` and `broken`:

| Step | Result |
|---|---|
| `mcpServerStatus()` right after start | All three **`pending`**: MCP startup doesn't block `query()`. They connect before the first turn runs |
| after turn 1 | `notes` and `inventory` **`connected`**, with `serverInfo` (`lab-notes@1.0.0`) and their `tools`. `broken` **`failed`** with `error: "Connection closed"` |
| `toggleMcpServer("inventory", false)` | Status `disabled`. The next turn's `system/init` has no inventory tools, and the model said *"I don't have access to an inventory tool"* |
| `toggleMcpServer("inventory", true)` | The http server saw a **new handshake** (`initialize` → `tools/list`); the tools came back |
| `reconnectMcpServer("notes")` | A **new process**: pid 5240 → 16312, `uptimeMs` back to ~1,100 |
| `reconnectMcpServer("broken")` | **Throws** `Error: Connection closed` (the route answers 409) |

`mcpServerStatus()` also returns each server's full `config`, **including http `headers`**, so be careful before you
show it to users or write it to logs.

## Step 8: `setMcpServers()`, tested

The SDK comment says it "replaces the current set of dynamically-added MCP servers". A test started a session with
`notes` + `inventory` from `options.mcpServers`, then called `setMcpServers` five times:

| Call | `added` | `removed` | Servers after |
|---|---|---|---|
| (start) | | | notes, inventory |
| `setMcpServers({ clock })` | clock | – | notes, inventory, **clock** |
| `setMcpServers({ notes })` | notes | clock | notes, inventory |
| `setMcpServers({})` | – | notes | inventory |
| `setMcpServers({ notes, inventory })` | notes, inventory | – | notes, inventory (a **new** notes process) |
| `setMcpServers({})` | – | notes, inventory | (none) |

So `setMcpServers()` **replaces the set it manages**, and:

- Servers from `options.mcpServers` are **not** in that set at first. `setMcpServers({ clock })` kept them.
- **Naming** a server takes it over. `setMcpServers({ notes })` "added" notes, but kept the running process (same
  config, no restart). From then on, a call that leaves it out removes it, and its process stops.
- `sdk` servers work too: `clock` was added mid-session and `mcp__clock__now` ran in the next turn.

## What to take away

1. **Three transports, one tool name.** `stdio` (Claude Code starts a process), `http`/`sse` (Claude Code connects to
   a URL), `sdk` (your process). The model always sees `mcp__<server>__<tool>`, and `allowedTools` works the same.
2. **External configs are plain JSON.** The same objects work in `.mcp.json` or `claude mcp add`. Only `sdk` servers
   need your process.
3. **A stdio server is a child of Claude Code.** It gets `options.cwd` and inherits the whole environment, and `env`
   only adds to it.
4. **A failed server fails silently.** Check `mcp_servers[].status` in `system/init` (or `mcpServerStatus()`) when
   a server is required.
5. **Servers are live state you can manage.** In a streaming session you can disable, re-enable, restart, add and
   remove servers. Each change shows up in the next turn's `system/init`.
6. **`strictMcpConfig: true`** keeps every earlier concept's safety: only the servers you pass, never the machine's
   own MCP configuration.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/13-mcp-servers.ts](server/concepts/13-mcp-servers.ts),
[mcp-servers/notes-server.ts](mcp-servers/notes-server.ts) and
[src/concepts/Concept13McpServers.tsx](src/concepts/Concept13McpServers.tsx). The two MCP servers themselves are
described in Steps 2 and 3 of the concept; here we look at how the lab around them was built.

### Step 1: Read the types, then fix the addresses

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `McpServerConfig`, `McpStdioServerConfig`,
`McpHttpServerConfig`, `McpServerStatus` and the four `Query` methods of Part B (see Step 1 of the concept). Then the server
file starts with the places Claude Code must reach:

```ts
const MODEL = "claude-haiku-4-5-20251001";
// Claude Code connects to the inventory server and the notes process posts its log here, so both need the lab's own URL.
const LAB_URL = `http://localhost:${process.env.LAB_PORT ?? 3001}`;
const NOTES_SERVER = path.resolve("mcp-servers", "notes-server.ts");
export const INVENTORY_TOKEN = "lab-secret-token";
```

- These are strings in a config, not objects: Claude Code runs in another process, so it needs a URL and an absolute
  file path.
- `LAB_PORT` is only for the case where the lab runs on another port (see "Running the app" below).

### Step 2: A log channel for what the servers see

External servers run outside `query()`, so their activity is not in the message stream. The lab gives them their
own channel: an `EventEmitter` and a small route.

```ts
const McpLogBody = z
  .object({
    server: z.string().max(40),
    transport: z.string().max(10),
    method: z.string().max(300),
    pid: z.number().int().optional(),
    status: z.number().int().optional(),
    detail: z.unknown().optional(),
  })
  .strict();
type McpLog = z.infer<typeof McpLogBody>;
const mcpLog = new EventEmitter();

concept13.post("/log", (req, res) => {
  const parsed = McpLogBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  mcpLog.emit("log", parsed.data);
  res.sendStatus(204);
});
```

- This is the first zod schema of the file. Like every other route of the lab (not `/mcp`, which the MCP transport
  checks), `/log` refuses a body that does not match, with `400` and a `Bad request: …` message from `badRequest()`.
- The `McpLog` type comes from the schema, so the tab's log lines and the check always agree.

The notes process calls it with `fetch()`, and never waits for it:

```ts
/** Fire-and-forget: the lab's browser tab shows these lines as "notes (stdio) process" events. */
function log(method: string, detail?: unknown) {
  if (!LOG_URL) return;
  fetch(LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "notes", transport: "stdio", pid: process.pid, method, detail }),
  }).catch(() => {});
}
```

- `LOG_URL` comes from `env.LAB_LOG_URL` in the stdio config. Without it the server still works, it just stays quiet.
- The http server does not need `/log`: it runs inside the lab, so its `/mcp` route calls `mcpLog.emit()` directly.
- `.catch(() => {})` matters: a failed log must never break a tool call.

### Step 3: The inventory server's state and routes

The inventory server is `inventoryServer()`, with the stock in a module-level `Map`, so every request and every
session share it. The `/mcp` route (Step 3 of the concept) first writes down which JSON-RPC methods it received:

```ts
const methods = [req.body].flat().map((m: any) => (m?.method === "tools/call" ? `tools/call ${m.params?.name}` : m?.method));
const log = (status: number) => mcpLog.emit("log", { server: "inventory", transport: "http", method: methods.join(", "), status, detail: [req.body].flat()[0]?.params?.arguments });
```

```ts
// Stateless servers have no GET stream (server-to-client notifications) and no sessions to DELETE.
concept13.all("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});
```

- `[req.body].flat()` handles one message and a batch the same way.
- `log(res.statusCode)` runs after `handleRequest()`, so the tab sees the real status (200, 202, 400 or 401).
- `GET /stock` and `POST /stock/reset` are for the tab only. They are not MCP.

### Step 4: One function per server config

The server names are a zod enum. The TypeScript types come from it, and every route that takes names uses
`ServerList`:

```ts
// The browser only picks server NAMES from this list: never a command or a URL.
const ServerNameSchema = z.enum(["notes", "inventory", "clock", "broken"]);
const TokenSchema = z.enum(["right", "wrong", "none"]);
export type ServerName = z.infer<typeof ServerNameSchema>;
export type Token = z.infer<typeof TokenSchema>;
const ServerList = z.array(ServerNameSchema).max(4).refine((a) => new Set(a).size === a.length, { message: "each server once" });
```

Then one config per name:

```ts
function serverConfig(name: ServerName, token: Token = "right"): McpServerConfig {
  switch (name) {
    // … case "notes": the stdio config of Step 2 of the concept
    case "inventory":
      return {
        type: "http",
        url: `${LAB_URL}/api/c13/mcp`,
        ...(token !== "none" && { headers: { Authorization: `Bearer ${token === "right" ? INVENTORY_TOKEN : "not-the-token"}` } }),
      };
    case "broken":
      return { type: "stdio", command: "lab-mcp-server-that-does-not-exist", args: ["--stdio"] };
    case "clock":
      return createSdkMcpServer({
        // … one "now" tool, as in Concept 5
      });
    default: {
      const unknown: never = name; // every ServerName has a case above
      throw new Error(`Unknown MCP server: ${String(unknown)}`);
    }
  }
}

function buildServers(names: ServerName[], token?: Token) {
  return Object.fromEntries(names.map((n) => [n, serverConfig(n, token)]));
}
```

- The browser only sends server **names** and a token choice (`right`, `wrong`, `none`). It never sends a command or
  a URL, so the tab cannot start any program on the server.
- The `default` branch is a safety net. `const unknown: never = name` makes TypeScript fail if a new name is added
  to the enum without a case, and at run time an unknown name throws instead of returning `undefined`.
- `clock` is built fresh each time, because an sdk config holds a live `McpServer` object.
- `printable()` replaces that object with `"[McpServer]"` before the options are sent to the browser as JSON.

### Step 5: `POST /query`: forward the logs while the query runs

```ts
concept13.post("/query", (req, res) => {
  const parsed = QueryBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const body = parsed.data;

  const mcpServers = buildServers(body.servers, body.token);
  const options: Options = { ...baseOptions(), mcpServers, allowedTools: body.allowedTools };
  send("options", { ...options, mcpServers: printable(mcpServers) });

  const onLog = (l: McpLog) => send("mcp_log", l);
  mcpLog.on("log", onLog);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } })).finally(() => mcpLog.off("log", onLog));
});
```

- `baseOptions()` holds what never changes: Haiku, `tools: []`, the sandbox as `cwd`, `settingSources: []` and
  `strictMcpConfig: true`.
- The listener is removed in `finally`. Without `mcpLog.off()`, every old run would keep writing to a closed stream.
- `QueryBody` checks `prompt`, `servers` (a `ServerList`), `allowedTools` (up to 20 rules like `mcp__notes`) and the
  optional `token`. A bad body gets an `error` event, then `done`, as in Concept 34: `servers: ["evil"]` never
  reaches `serverConfig()`.

### Step 6: Part B: the session and a `control()` that also logs

`POST /session` is the Concept 12 session (a `Map` by id, the push queue, `pipe(q).finally(...)`), plus the same
`mcp_log` listener as Part A. The `control()` wrapper is a little different from Concept 12's: it takes a function
that names the call, and sends the result or the error to the session's stream itself:

```ts
function control<T extends z.ZodType<{ id: string }>>(
  schema: T,
  name: (body: z.infer<T>) => string,
  action: (q: Query, body: z.infer<T>, s: Session) => Promise<unknown> | unknown,
) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: badRequest(parsed.error) });
      return;
    }
    const body = parsed.data;
    const s = sessions.get(body.id);
    if (!s) {
      res.status(409).json({ error: "No open session with that id (it already ended)." });
      return;
    }
    const method = name(body);
    const ms = Date.now() - s.startedAt;
    try {
      const result = await action(s.q, body, s);
      s.send("control", { method, ms, result });
      res.json({ ok: true, result });
    } catch (err) {
      s.send("control", { method, ms, error: String(err) });
      res.status(409).json({ error: String(err) });
    }
  };
}

concept13.post("/status", control(IdBody, () => "q.mcpServerStatus()", (q) => q.mcpServerStatus()));
```

- Every Part B route is one `control(schema, name, action)` call. A bad body is a `400`, before the session is even
  looked up. `/toggle` and `/reconnect` check `name` with `ServerNameSchema`, and `/set-servers` checks `servers`
  with `ServerList` before it calls `buildServers()`.
- An error is shown twice on purpose: as a red row in the timeline and as the route's `409`. That is how
  `reconnectMcpServer("broken")` shows up (Step 7 of the concept).

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept13 } from "./concepts/13-mcp-servers.js";
// …
app.use("/api/c13", concept13); // also serves the "inventory" MCP server on /api/c13/mcp
```

The comment is important: the same mount serves the tab's routes **and** a real MCP server that Claude Code connects
to.

### Step 8: The React tab, Part A

`OneQuery` keeps a `form` (prompt, servers, `allowedTools`, token). Each scenario button only fills the form. `run()`
turns the `allowedTools` text into an array, and reloads the stock at the end:

```tsx
const body = { ...form, allowedTools: form.allowedTools.split(",").map((r) => r.trim()).filter(Boolean) };
try {
  await streamPost("/api/c13/query", body, (event, data) => {
    if (event === "options") setSentOptions(data);
    if (event === "message") setMessages((prev) => [...prev, data]);
    if (event === "mcp_log") setLogs((prev) => [...prev, data]);
    if (event === "error") setError(data.message);
  });
} finally {
  setRunning(false);
  loadStock();
}
```

- `mcp_log` events fill **What the MCP servers saw**. `InitCard` reads `system/init.mcp_servers` and `tools`.
- `toolCalls()` pairs each `tool_use` with its `tool_result` by id, as in Concepts 3 and 5.

### Step 9: The React tab, Part B

`LiveServers` opens the session with `streamPost("/api/c13/session", …)`, and asks for the status as soon as the
`session` event arrives. Every other button goes through one `control()` function:

```tsx
async function control(route: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`/api/c13/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: idRef.current, ...body }),
  });
  const json = await res.json();
  if (!res.ok) setError(json.error);
  else setError(null);
  if (route === "status" && json.result) setStatuses(json.result);
  // Every change is followed by a fresh status, so the table always matches the session.
  else if (route !== "send" && route !== "end") void control("status");
  return json;
}
```

- The id is kept in a `useRef` as well as in state. The status call runs inside the SSE callback, before React has
  re-rendered with the new `id`.
- Each status row has its own **toggle** and **reconnect** buttons. The `setMcpServers` checkboxes are a separate
  list (`nextSet`).

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 13, title: "MCP servers", Component: Concept13McpServers },
```

### Step 10: Check that it works

1. `npx tsc --noEmit -p .` must print nothing (the `tsconfig.json` also checks `mcp-servers/`).
2. `npm run dev`, open tab 13, pick **1 · stdio: a child process** and press **Run query() with mcpServers**. The
   log shows `process started` with a pid.
3. Pick **3 · Wrong token** and run it: `inventory: failed`, HTTP 401, and still `result/success`.
4. In Part B, press **Start session**, send a message, then **toggle(false)** on `inventory` and send again.
5. The same Part A route from a terminal: see "Running the app" below.

## Things to try in Concept 13

1. Scenario 5 with `allowedTools: mcp__inventory`: reserve 3 monitors, then 3 more. The second call returns
   `isError` (*Only 1 unit(s) of MN-27 left.*). Press **Reset stock** afterwards.
2. In `notes-server.ts`, add a `console.log("hi")` at the top and run scenario 1 again. What status does `notes` get?
   (Remove it afterwards.)
3. In Part B, disable `notes`, then call `reconnectMcpServer("notes")`. Does reconnecting enable it again?
4. Change the notes config in `13-mcp-servers.ts` to `command: "node"` (a `PATH` lookup) instead of
   `process.execPath`, and check that it still starts on your machine.
5. Add `alwaysLoad: true` to the inventory config. The SDK says it blocks startup until the server is connected, and
   never defers its tools behind tool search. Compare the time to `system/init`.

## Running the app

Same as the other tabs: `npm run dev`, then open http://localhost:5173 and select **13. MCP servers**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

> The http server's URL and the notes log URL both use `http://localhost:3001` (the lab server). If you run the
> router on another port, set `LAB_PORT`. As with every sample, stop the other samples first: they all use port 3001.

Part A without the UI (PowerShell):

```powershell
'{"prompt":"How many 27-inch monitors are in stock?","servers":["inventory"],"allowedTools":["mcp__inventory"],"token":"right"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c13/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

Look for `event: mcp_log` lines: that is the MCP server itself, logging what it received.
