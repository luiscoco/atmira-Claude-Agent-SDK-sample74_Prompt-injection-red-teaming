# Remote MCP plus resources

This file explains Concept 43 (**remote MCP servers and MCP resources**) of the Claude Agent SDK Lab. Concept 13 connected
to an `http` MCP server with a fixed bearer token. A real remote server is protected by **OAuth**, and a headless agent
can't open a browser to sign in. This lab runs an OAuth-protected server on its own port ("the remote") and shows what
Claude Code does with no token, a wrong one, and one the host got itself. It then covers a cache that keeps a server out
even after you fix the token, the two transports on the wire, and a live session while the remote changes under it.
The second half is **resources**, the part of MCP the course had not covered: data by URI that the model lists and
reads, links a tool returns, binary content, and what the host can read itself.

**Goal:** connect an agent to a protected remote server reliably, recover when its token or its session goes away,
and use MCP resources from the model's side and from the host's side.

| Concept | Topic | Routes |
|---|---|---|
| 43 | Remote MCP: OAuth discovery (401 + `WWW-Authenticate`, RFC 9728 / RFC 8414 metadata, dynamic client registration), `needs-auth` vs `failed`, `headers.Authorization` (no OAuth fallback), host-side OAuth (client_credentials), `mcp-needs-auth-cache.json` and its fixes, `http` vs `sse`, `timeout`, `setMcpServers()` after a 401, a lost MCP session, `list_changed`. Resources: `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, templates, `ui://`, `blobSavedTo`, `resource_link` → `resourceLinks`, `@server:uri`, `q.readMcpResource()` | `/api/c43/facts`, `/auth`, `/cache`, `/transports`, `/toolsets`, `/resources`, `/host-read`, `/live` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/43-remote-mcp-resources.ts` | **New**: the remote (OAuth + MCP over http and sse), the host's OAuth client, the run helper, the seven scenarios, the routes |
| `server/index.ts` | Mounts the router on `/api/c43` |
| `src/concepts/Concept43RemoteMcp.tsx` | **New**: the tab, Parts A to G |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | A few classes: outgoing wire rows, OAuth and host rows, step headers, the sandboxed MCP App |
| `.gitignore` | Ignores `remote-lab/` |
| `Tab1-query().md` | Adds Concept 43 to the table and the project tree, the sample43 path |

No new npm package: the remote and the host's own MCP client use `@modelcontextprotocol/sdk` (Concept 13).

---

## Step 1: The smallest example

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const token = await getToken(mcpUrl); // the HOST does the OAuth (see Step 3)

for await (const m of query({
  prompt: "Read the runbook, then find the orders of customer ana.",
  options: {
    tools: ["ListMcpResourcesTool", "ReadMcpResourceTool"], // the resource tools (tools: [] removes them)
    mcpServers: { shop: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` }, timeout: 1500 } },
    allowedTools: ["mcp__shop", "ListMcpResourcesTool", "ReadMcpResourceTool"],
    strictMcpConfig: true,
    settingSources: [],
  },
})) {
  if (m.type === "system" && m.subtype === "init") console.log(m.mcp_servers); // [{ name: "shop", status: "connected" }]
  if (m.type === "user" && m.tool_use_result) console.log(m.tool_use_result);  // typed: the resource list, the contents, resourceLinks
}
```

## Step 2: The remote (Part A)

`the remote` is an Express app on `127.0.0.1`, on a random port, inside the lab server. It stands in for a server on the
internet, and it behaves like one:

| Endpoint | What it does |
|---|---|
| `POST/GET /l/<lane>/mcp` | Streamable HTTP, **stateful**: `initialize` opens an MCP session (`Mcp-Session-Id`), later requests carry it. Without a valid token: `401` + `WWW-Authenticate: Bearer resource_metadata="…"` |
| `GET /l/<lane>/sse`, `POST /l/<lane>/messages` | The older HTTP+SSE transport, the same server behind it |
| `GET /l/<lane>/.well-known/oauth-protected-resource` | RFC 9728: "my authorization server is `/l/<lane>/auth`" |
| `GET /.well-known/oauth-authorization-server/l/<lane>/auth` | RFC 8414: the token, authorization and **registration** endpoints |
| `POST /l/<lane>/auth/token` | `client_credentials` for the client `lab-agent`: a token valid for 600 s |

`<lane>` is a path segment per agent, so the tab can show each agent's requests (the **→ remote** rows) apart, even when
three agents run at the same time. The tab never shows a token, only its number (`token #3`).

What it serves (`shopServer()`, one `McpServer` per MCP session):

| Kind | Name | Notes |
|---|---|---|
| tool | `find_orders(customer)` | Returns a text block and two **`resource_link`** blocks (`orders://1001`, `orders://1002`) |
| tool | `slow_report(ms)` | Waits `ms`: for the `timeout` test |
| tool | `show_orders()` | Declares `_meta.ui.resourceUri: "ui://orders/widget"` (an MCP App) |
| resource | `docs://runbook` | `text/markdown`, holds the restart word `PELICAN-42` |
| resource | `files://logo.png` | `image/png`, a **blob** |
| resource | `ui://orders/widget` | `text/html;profile=mcp-app` |
| template | `orders://{id}` | Not listed: the model learns the URIs from `find_orders` |

## Step 3: Three ways to connect (scenario 1)

Three agents at the same time, each with a fresh `CLAUDE_CONFIG_DIR`:

```text
a · no headers
→ POST /mcp server/discover                               401   no token
→ GET  /.well-known/oauth-protected-resource              200
→ GET  /.well-known/oauth-authorization-server/l/…/auth   200
system/init  shop needs-auth · tools: (none)
CLAUDE_CONFIG_DIR: mcp-needs-auth-cache.json {"shop":{"timestamp":…}} · .credentials.json mcpOAuth: { accessToken: (empty), discoveryState… }

b · headers.Authorization: "Bearer not-a-real-token"
→ POST /mcp server/discover   401     → POST /mcp initialize   401
system/init  shop failed
mcpServerStatus().error: "Server rejected the configured Authorization header (HTTP 401). Check that the token is
valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set."

c · the host gets a token, then passes it
host OAuth 1 · POST the MCP URL without a token   → 401, WWW-Authenticate → resource_metadata=…
host OAuth 2 · GET the protected resource metadata → authorization_servers: ["/l/auth-host/auth"]
host OAuth 3 · GET the authorization server metadata → token_endpoint
host OAuth 4 · POST client_credentials              → 200, token #1, expires_in 600
→ POST /mcp initialize 200 · notifications/initialized 202 · GET /mcp (the event stream) 200 · tools/list · resources/list
system/init  shop connected · mcp__shop__find_orders, mcp__shop__show_orders, mcp__shop__slow_report
```

What this shows:

- **With no headers, Claude Code does the OAuth discovery itself**, then stops. The next step would be a browser
  sign-in, which a headless agent can't do. The status is `needs-auth`, and Claude Code saves what it discovered in
  `.credentials.json` (`mcpOAuth`, with an empty `accessToken`).
- **Without dynamic client registration** (`registration_endpoint` missing from the metadata), the same run ends in
  `failed: "Incompatible auth server: does not support dynamic client registration"`. The first version of the lab
  had no DCR and got exactly that.
- **`headers.Authorization` turns the OAuth fallback off.** A wrong token is simply `failed`, with a clear error.
- **The host's job is to get the token.** Here that's `client_credentials` (a machine client, no user). For a user's
  account, run the authorization_code flow in your app and pass the user's token the same way.
- As in Concept 13, **a failed server does not fail the run**: all three runs ended in `result/success`, and two
  models just said they had no shop tools. Check `system/init.mcp_servers` when a server is required.

```ts
// #region oauth (shortened)
const r1 = await fetch(mcp, { method: "POST", body: ping });                                     // 1. 401
const metaUrl = r1.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
const issuer = (await (await fetch(metaUrl)).json()).authorization_servers[0];                    // 2.
const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server${issuerPath}`)).json(); // 3.
const tok = await (await fetch(as.token_endpoint, { method: "POST",                                // 4.
  body: new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret, scope: "shop" }) })).json();
```

## Step 4: The needs-auth cache (scenario 2)

Three runs with **one** config dir, as on one machine or in one container:

| Run | Config | What the remote saw | `shop` |
|---|---|---|---|
| 1 | no headers | discovery (3 requests) | `needs-auth`, and `mcp-needs-auth-cache.json` = `{"shop":{"timestamp":…}}` |
| 2 | a **valid** token | **nothing** | still `needs-auth`: the server was skipped |
| 3a | the same + `q.reconnectMcpServer("shop")` after `system/init` | a full handshake | `connected` for **turn 2**; turn 1 had already started without the tools. The cache entry is removed |
| 3b | the host deletes `mcp-needs-auth-cache.json` first | a full handshake at startup | `connected` |
| 3c | the same server as `shop2` | a full handshake at startup | `connected` (the tools are `mcp__shop2__*`); the old `shop` entry stays |

The cache is **keyed by the server name**, not the URL or the config. It also caught the probes: a later run with a new
port and no auth at all was still skipped. `q.setMcpServers()` also connects (Step 7). In a service, give each
deployment its own `CLAUDE_CONFIG_DIR` (Concept 16), and delete that file when you change a server's auth.

## Step 5: Two transports (scenario 3)

```text
type: "http" (Streamable HTTP)                          type: "sse" (HTTP+SSE, older)
→ POST /mcp server/discover            400              → GET  /sse (open the event stream)   200
→ POST /mcp initialize                 200  (answer)    → POST /messages initialize           202  (answer on the stream)
→ POST /mcp notifications/initialized  202  sid …       → POST /messages notifications/…      202
→ GET  /mcp (open the event stream)    200  sid …       → POST /messages tools/list           202
→ POST /mcp tools/list, resources/list 200  sid …       → POST /messages resources/list       202
→ POST /mcp tools/call find_orders     200  sid …       → POST /messages tools/call           202
```

- **Streamable HTTP** uses one URL. The answer comes in the POST response, and the session is the `Mcp-Session-Id`
  header. The GET stream is only for messages the server starts (notifications).
- **HTTP+SSE** keeps a GET stream open and POSTs to a second URL (`?sessionId=…`). Every POST gets `202`, and the
  answers arrive on the stream. It is deprecated in the MCP spec. Use it only for old servers.
- `server/discover` is Claude Code's probe before `initialize`. A server that doesn't know it answers `400` and nothing
  breaks. A stateful server should not open a session for it (the remote only opens one on `initialize`).
- **`resources/list` is called at connect time** when the server declares resources. `resources/templates/list` is not.

## Step 6: Resources, from the model's side (scenarios 4 and 5)

The model doesn't call resources directly. Claude Code gives it built-in tools for them (types from `sdk-tools.d.ts`):

```ts
interface ListMcpResourcesInput { server?: string }
type ListMcpResourcesOutput = { uri: string; name: string; mimeType?: string; description?: string; server: string }[];
interface ReadMcpResourceInput  { server: string; uri: string }
interface ReadMcpResourceOutput { contents: { uri: string; mimeType?: string; text?: string; blobSavedTo?: string }[]; error?: string }
```

Scenario 4 starts three agents with different `tools` and stops each at `system/init` with `q.close()`: **no model
call, $0**.

| `options.tools` | tools in `system/init` | MCP-related |
|---|---|---|
| `[]` | 3 | only `mcp__shop__*`: **no resource tools** |
| `["ListMcpResourcesTool", "ReadMcpResourceTool"]` | 5 | the two resource tools + `mcp__shop__*` |
| not set (the default set) | 37 | + `ReadMcpResourceDirTool` (lists a "directory" resource's children) |

With the default set, the model had to call `ToolSearch` first to load the resource tools (they are deferred, like MCP
tools: `alwaysLoad: true` on a server avoids that for its own tools). Listing the two tools in `tools` is shorter and
cheaper.

Scenario 5 (Haiku, about $0.01):

```text
ListMcpResourcesTool {}                       → docs://runbook (text/markdown), files://logo.png (image/png)
ReadMcpResourceTool {shop, docs://runbook}    → resources/read → "# On-call runbook … PELICAN-42 …"
ReadMcpResourceTool {shop, files://logo.png}  → blobSavedTo: remote-lab\config-res\projects\…\tool-results\mcp-resource-….png
mcp__shop__find_orders {customer: "ana"}      → "2 orders for ana.\n[Resource link: order-1001] orders://1001 (Order 1001)\n…"
                                                 tool_use_result.resourceLinks: [{ uri: "orders://1001", … }, { uri: "orders://1002", … }]
ReadMcpResourceTool {shop, orders://1001}     → {"id":"1001","customer":"ana","status":"shipped","total":42}
```

- **`ui://` resources are left out of the list** (MCP Apps are for the host to render, not for the model), and so are
  **templates**. `orders://1001` was never listed, but reading it works: the model got the URI from a resource link.
- **A blob is not sent to the model.** Claude Code saves it next to the session's transcript and gives the model the
  path (`blobSavedTo`). With no file tools, that path is all it gets.
- **`resource_link` blocks become text for the model** (`[Resource link: …] uri (description)`), and the host gets them
  typed in `tool_use_result.resourceLinks` (at most 50).
- **The server name is a separate input.** In two probes, Haiku used the URI's scheme as the server name (`{server: "docs",
  uri: "docs://runbook"}`, then `"files"` and `"orders"`) and got `Server "docs" not found. Available servers: remote`; it
  retried with the right name. Clear server names and descriptions help.

## Step 7: Resources, from the host's side (scenario 6)

In the Claude Code terminal, `@shop:docs://runbook` in a prompt attaches the resource. In an SDK run it doesn't: the
probes tried a string prompt, streaming input, a second turn after the server was connected, the resource tools on and
off, and `alwaysLoad: true`. The model never saw the runbook, and the remote saw no `resources/read`.

| Lane | What the host does | The answer has `PELICAN-42` |
|---|---|---|
| a | `@shop:docs://runbook` in the prompt | **no** |
| b | reads the resource with its **own MCP client** (same URL and token) and puts it in the prompt as a `<resource>` block | **yes**, with no tool call |
| c | `q.readMcpResource("shop", "ui://orders/widget")` while the session runs | the widget's HTML (rendered in a sandboxed `<iframe>`) |

```ts
// #region hostread (shortened)
const client = new Client({ name: "lab-host", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const r = await client.readResource({ uri: "docs://runbook" });

// through Claude Code's own connection: only ui:// (MCP Apps)
const status = await q.mcpServerStatus();              // tools[].name "show_orders", _meta: { ui: { resourceUri: "ui://orders/widget" } }
await q.readMcpResource("shop", "ui://orders/widget"); // { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text }] }
await q.readMcpResource("shop", "docs://runbook");     // throws "mcp_read_resource: uri must use the ui:// scheme"
```

`readMcpResource()` needs `mcp_read_resource_v1` in `system/init.capabilities` (it is there in 2.1.281), and it refuses a
server that is not connected ("MCP server shop is not connected (status: needs-auth)"). The HTML is third-party
content: render it sandboxed, as the tab does (`<iframe sandbox="">`).

## Step 8: A live session while the remote changes (scenario 7)

One streaming session (Concept 12) with `timeout: 1500` in the server's config. Between the turns, the remote changes:

| Step | The remote | What Claude Code does | What the host does |
|---|---|---|---|
| 0 | normal | handshake, `tools/call find_orders` 200 | |
| 1 | forgets every token | `tools/call` → **401**. Tool error: *"MCP server "shop" rejected the Authorization header in its config (update it, then run /mcp to reconnect)"*. Status → `needs-auth` | gets a new token, then `q.setMcpServers({ shop: { …, headers: { Authorization: "Bearer <new>" } } })` → `{"added":["shop"]}`: a new connection, and the next call works |
| 2 | forgets its MCP sessions | `tools/call` → **404 Session not found** → `initialize` again, then the same call again. **No error reaches the model** | nothing |
| 3 | adds `docs://incident-42` and sends `notifications/resources/list_changed` | on a normal connection, nothing: `ListMcpResourcesTool` still lists 2 resources (3 runs out of 3). On a connection it recovered from a 404 (after step 2), it reconnects about 0.3 s later and lists 3 (2 out of 2). A **check** row says which one happened | `q.reconnectMcpServer("shop")` → a new `resources/list`: the model finds and reads the incident |
| 4 | `slow_report` takes 4 s | after 1.5 s: *"MCP server "shop" tool "slow_report" timed out after 1s"*, and `notifications/cancelled` to the server | nothing (the server kept working: cancelling is up to it) |

```ts
// #region live (shortened)
tokens.clear();                                                      // the remote: every token expires
await s.say("Call find_orders for customer bob…");                   // → the tool error
token = await getToken(url, e);                                      // the host: a new token…
await s.query().setMcpServers({ shop: shopConfig(url, token, { timeout: 1500 }) }); // …a new config, a new connection
```

More details from the tests:

- In step 2, Claude Code sent **two** `initialize` requests at the same moment and got two sessions (it used one of
  them). A stateful server should expire idle sessions.
- What decides step 3 is step 2. A test ran step 3 after each other step: after `sessions` (a 404 recovery), Claude
  Code reconnected right after the notification; after `expire` (a `setMcpServers()` connection) and alone, it did
  not. **Don't rely on either**: reconnect when you know the list changed.
- The timeout message rounds down (1.5 s → "1s").
- In a streaming session, **`total_cost_usd` in each `result` is the session's total so far**, not the turn's cost.
- `mcpServerStatus()` returns each server's `config` **with its headers**, so with the token. The lab drops `config`
  before it shows the status.
- Two things that did not work in the probes: a `tools: [{ name, permission_policy: "always_deny" }]` policy in
  `options.mcpServers` (the tool still ran), and `headersHelper` (in 0.3.281 it exists only for plugin marketplaces).

## Things to try in Concept 43

1. In scenario 1, remove `registration_endpoint` from the authorization server metadata. Lane a becomes `failed`. Is
   `mcp-needs-auth-cache.json` written then?
2. Set `TOKEN_TTL_S` to 20, run scenario 7 with only step 0, wait 30 s, and send another turn. The same error as step 1?
3. Give `find_orders` an `outputSchema` and return `structuredContent`. What does `tool_use_result` look like?
4. Add a `list` callback to the `orders://{id}` template. Do the orders appear in `ListMcpResourcesTool` now?
5. In step 3, call `setMcpServers()` with the same config instead of `reconnectMcpServer()`. Does it re-list?

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **43. Remote MCP + resources** tab. `ANTHROPIC_API_KEY` must be in `.env`. Everything runs on your machine
(no DNS, no internet besides the API). With Haiku 4.5: 1 about $0.007, 2 about $0.01, 3 about $0.008, 4 $0, 5 about
$0.01, 6 about $0.005, 7 about $0.04. A full pass costs about $0.08.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c43/facts
curl.exe -N -X POST http://localhost:3001/api/c43/auth -H "Content-Type: application/json" -d "{}"
curl.exe -N -X POST http://localhost:3001/api/c43/cache -H "Content-Type: application/json" -d "{\"fix\":\"reconnect\"}"
curl.exe -N -X POST http://localhost:3001/api/c43/live -H "Content-Type: application/json" -d "{\"steps\":[\"expire\",\"timeout\"]}"
```

`node_modules` was copied from sample42 (no new package). Run `npm install` once if you copy this sample without it.

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 43 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "sample 43: Remote MCP plus resources" (#5 + #6 in the list of features the course had not
covered). A search of the lab showed that Concept 13 had one `http` server with a static bearer token, and nothing
used MCP resources, OAuth, `sse` or `readMcpResource()`.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab13-MCP-servers.md`, `13-mcp-servers.ts` | The transports, `mcpServerStatus()`, `setMcpServers()`, "401 means `failed`, not `needs-auth`" |
| `Tab42-Web-tools.md`, `42-web-tools.ts`, `Concept42WebTools.tsx` | The latest style: `sseRoute()`, lanes, `#region` + `/code`, the retrying `/facts`, "Steps followed" |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types

| Found in SDK 0.3.281 | Used for |
|---|---|
| `McpHttpServerConfig`, `McpSSEServerConfig` (`headers`, `timeout`, `alwaysLoad`, `tools`) | Steps 3, 5, 8 |
| `McpServerStatus.status` (`needs-auth`), `tools[]._meta` | Steps 3, 7 |
| `ListMcpResourcesInput/Output`, `ReadMcpResourceInput/Output` (`blobSavedTo`), `ReadMcpResourceDirInput/Output` in `sdk-tools.d.ts` | Step 6, Part D (read live by `/facts`) |
| `SDKMcpResourceLink`, "tool_use_result.resourceLinks (at most 50 links)" | Step 6 |
| `Query.readMcpResource()` (`@alpha`, `ui://` only, `mcp_read_resource_v1`) | Step 7 |
| "`@server:resource` MCP mentions are not expanded" (for turns the user did not type) | Why Step 7 tests the mentions |

### Build step 4: Probe before designing

Scratchpad scripts (`_probe/`, removed at the end) ran a small remote and `query()` with Haiku 4.5 and a fresh
`CLAUDE_CONFIG_DIR`:

| Probe | Result | Decision |
|---|---|---|
| Resources with the default tools, `tools: []`, the two tools listed | Default: `ToolSearch` first; `[]`: no resource tools; listed: direct | Scenario 4, and `tools: RESOURCE_TOOLS` |
| List + read + blob + template + `resource_link` | `ui://` and templates not listed; `blobSavedTo`; `resourceLinks`; wrong server name tried | Scenario 5 |
| `@remote:docs://runbook`, 5 variants | Never expanded, no `resources/read` | Scenario 6 compares it with a host read |
| `readMcpResource()` on `ui://` and `docs://` | `ui://` read, `docs://` refused | Scenario 6, lane c |
| `sse` transport | Works, `202` + the stream | Scenario 3 |
| 401 + OAuth metadata, no headers | `needs-auth`, `mcp-needs-auth-cache.json`, `mcpOAuth` in `.credentials.json` | Scenario 1 |
| The next runs, the same config dir, a good token, no auth at all | Skipped: no request | Scenario 2 |
| Wrong `headers.Authorization` | `failed`, "OAuth fallback is disabled" | Scenario 1, lane b |
| `reconnectMcpServer()`, `setMcpServers()`, rename, delete the file | All four connect | Scenario 2's fixes |
| Token rotated mid-session | Tool error, `needs-auth`; `setMcpServers()` with the new header fixes it | Scenario 7, step 1 |
| Sessions forgotten | 404 → initialize again, invisible to the model | Step 2 |
| `list_changed`; `timeout: 1500` on a 4 s tool; `permission_policy: "always_deny"` | Ignored until reconnect; "timed out after 1s" + `notifications/cancelled`; the policy had no effect | Steps 3 and 4; the policy is left out |

One probe bug is worth a note: a dangling `else` in the probe's message loop swallowed the `result` messages, so the
session waited for ever. Braces fixed it.

### Build step 5: Design the concept

- **The remote** inside the lab server (`app.listen(0, "127.0.0.1")`), with a path segment per lane and a `wire`
  emitter: every request is a row, logged when its status is known (a patched `res.writeHead`).
- **The host's OAuth** as a function (`getToken()`) that emits its four steps.
- **One run helper** (`runAgent()`) with `onInit` / `onResult` callbacks, and **`liveSession()`** on top of it for
  streaming input.
- **Seven scenarios**, each a route; lanes run in parallel, each with its own config dir.

### Build step 6: Implement it

| File | What was done |
|---|---|
| `server/concepts/43-remote-mcp-resources.ts` | New: `shopServer()`, the remote's routes, `getToken()`, `configDir()`, `base()`, `shopConfig()`, `toolOutput()`, `runAgent()`, `statusRows()`, `liveSession()`, `sseRoute()`, `laneEmit()`, `authFiles()`, `hostReadResource()`, the routes |
| `src/concepts/Concept43RemoteMcp.tsx` | New: `WireRow`, `Status`, `Output`, `Trail`, `Lanes`, Parts A to G |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md` | Mount, tab, styles, `remote-lab/`, table row and tree |

`npx tsc --noEmit -p .` passed (after two fixes: `base` was both the remote's URL and the options helper, and a resource
reader needs `text` **or** `blob`, not both optional).

### Build step 7: Test the routes

A scratchpad server mounted **only** the Concept 43 router on port **3143**; a driver script printed each SSE event.

What the tests changed:

- Lane a first ended in `failed: Incompatible auth server: does not support dynamic client registration`, not
  `needs-auth`: the probe's metadata had a `registration_endpoint`, the first lab version did not. The remote now has
  one (and a stub `/register` and `/authorize`), and Step 3 describes both outcomes.
- The reconnect fix called `reconnectMcpServer()` after `system/init`, and the model still had no tools: the turn had
  already started. That run is now a streaming session with two turns, so the tab shows the gap and the fix.
- Scenario 4 aborted the runs at `system/init` with the `AbortController`, and they still made a model call ($0.02 for
  the default set). `q.close()` stops the process at once: $0.
- `list_changed` failed with "Resource docs://incident-42 is already registered": Claude Code rarely closes its MCP
  sessions, and sessions from earlier runs were still in the map. Only this run's sessions get the notification now.
- Session costs were added up (`+=`), but `total_cost_usd` is already the session's total: now it is assigned.
- A `sed` edit lost the backslashes of a Windows path regex (`blobSavedTo` was not shortened): fixed with an exact edit.

### Build step 8: Run it in the real app

`npm run dev` (all 43 routers on 3001, Vite on 5173). Headless Edge was driven through the DevTools protocol: tab 43,
then scenarios 1 to 7, then screenshots.

| Check | Page |
|---|---|
| Open tab 43 | Part A's text with the remote's address, the outcomes table, the resource types |
| 1 to 7 | Three auth lanes with their config files, the three-run cache trail, two transports, the tool-set table, the resource trail, the host-read lanes with the widget in a sandboxed iframe, the live session's steps |
| Console | No error |

One problem came from the test itself: the first Edge profile folder was inside the project, and Vite's file watcher
crashed on a locked cache file (`EBUSY`). The profile moved to the scratchpad.

A review of a full run in the tab found six more things, now fixed:

- Scenario 1 said "about $0.005"; the three lanes cost $0.0017 + $0.0017 + $0.0037 = **$0.007**.
- Part A counted `orders://{id}` as a fourth resource. It is a **template**: `/facts` now lists 3 resources and 1 template.
- The `sse` rows showed `Mcp-Session-Id`. HTTP+SSE has no such header: its session is the `?sessionId=` of `/messages`.
- The code at the top used an undefined `config` in `setMcpServers()`: it now builds `shop` once and reuses it.
- In step 3 the incident was listed **before** the host reconnected, which the tab did not explain. A test (step 3 after
  each other step) showed the cause: step 2's 404 recovery (Step 8). The tab now adds a **check** row after the first listing.
- Part F now says that each `result`'s `total_cost_usd` in a session is the running total.

A second review found four more, now fixed:

- The code at the top declared `const shop = { type: "http", … }` without a type. TypeScript widens `type` to `string`, and
  `mcpServers: { shop }` fails (`TS2322`: not assignable to `McpServerConfig`). It is now `const shop: McpHttpServerConfig`,
  checked with `tsc` against the SDK types.
- The shortened `blobSavedTo` path mixed separators (`projects/…/` inside a Windows path). It now keeps the path's own.
- Part A's resource list had a stray space before ")". The resources are now separated by commas.
- Part E did not say why lane b shows no OAuth steps (one token for lanes a and b), or why lane c's `resources/read ui://…`
  request shows in lane b (`readMcpResource()` uses that session's connection). It says so now.
