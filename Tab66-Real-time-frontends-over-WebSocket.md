# Real-time frontends over WebSocket

With Node 24 or newer, run `npm ci` and `npm run dev`. Open `?lesson=66` or **Production & deployment → 66. Real-time frontends over WebSocket**. Sample66 uses backend port **3066**; Vite uses **5173** or the next free port. Its `/api` proxy forwards both HTTP requests and WebSocket upgrades, preserving Host.

## Learning objectives

Build a bidirectional browser-to-host transport for an agent. Validate commands, correlate runs, render incremental text, send cancellation during streaming, and distinguish a new connection from durable run resumption. The SDK executes on Node; the browser uses its native WebSocket API.

## Exercise

1. Wait for **Connection: connected**, enter a prompt and click **Stream guided response (no model API)**. This deterministic response still travels over a real WebSocket. Inspect the wire frames.
2. Start another response and click **Cancel run** during streaming. The browser sends cancellation on the same connection; partial output remains and the terminal status is cancelled.
3. Click **Drop connection**, either while idle or during streaming. The socket stays disconnected and the host aborts any active run. Click **Reconnect** to open a fresh socket. Unexpected connection loss still triggers automatic recovery with exponential backoff and jitter, up to five attempts. No prompt is automatically resubmitted. Start a fresh run after reconnecting.
4. Optionally click **Stream live agent (billed)** with Anthropic credentials configured. Haiku uses no tools, one turn, a $0.05 SDK budget and a 60-second host deadline. Stop and disconnect use the same AbortController as the SDK.
5. Load source code to inspect the protocol, host lifecycle, SDK adapter and React component.

## Wire protocol

The path is `/api/c66/socket`. Client commands are strict JSON objects:

```json
{"type":"start","runId":"a UUID","mode":"guided","prompt":"Explain WebSocket"}
{"type":"cancel","runId":"the same UUID"}
```

Host frames contain `{ type, runId, seq, data }`. `ready` has a null run ID. An accepted run produces `started`, zero or more `delta` frames, `result`, then `done` with completed status. Failure produces `error` then `done`; cancellation ends with cancelled status. Invalid commands produce an error without starting a run. A rejected start includes failed status but has no done frame because no run was accepted.

Sequence numbers increase per connection, not globally. The browser filters stale frames by sequence and run ID. Text deltas append to the displayed answer. The final authoritative text replaces that answer rather than appending a duplicate. SDK `includePartialMessages: true` provides `stream_event` / `content_block_delta` / `text_delta`; only text is exposed to the browser, plus final text and cost.

## Lifecycle and limits

Each connection owns one active run. Duplicate start IDs are rejected for the lifetime of that socket. After 100 accepted IDs, open a fresh connection. The host permits at most 20 connections and four concurrent runs, bounds prompts to 2,000 characters, frames to 8 KiB and command traffic to 20 frames per second. Binary frames are rejected. Compression is disabled.

The host sends ping every 15 seconds. Browsers automatically answer protocol pings with pong; a socket missing the next heartbeat is terminated and its run aborted. If the send buffer exceeds 256 KiB, the host terminates that slow consumer. The frontend retains the latest 200 frames and at most 100,000 answer characters. Unmount closes the socket and cancels its connection-owned run. Cancellation or reaching the deadline ends with cancelled status; it cannot undo already completed effects.

There is no frame retention, run replay or session resume. Reconnect resets sequence numbers and uses a fresh socket; retrying a prompt requires explicit user action and a new UUID. Production resumption requires authenticated session ownership, persisted events, a last-seen cursor and idempotent commands. Lesson 60 supplies the durable execution context.

## SSE and security

Earlier lessons stream an HTTP response through SSE and use separate HTTP POSTs for controls. WebSocket carries both directions on one upgraded connection. Application-level correlation, heartbeat, retry and validation remain your responsibility.

Upgrade requests must include a browser Origin whose host matches the request Host; unknown paths are refused. This is a local teaching app without user authentication. A public deployment needs authenticated upgrades, per-run authorization, account quotas, HTTPS/WSS and a reverse proxy supporting Upgrade while preserving Host. Same-origin checking alone does not authenticate a caller.

The live adapter disables built-in tools, user setting sources and external MCP servers, and uses an isolated configuration directory in ignored `realtime-lab/`. It does not persist SDK transcripts. Live credentials are still required; guided tests use no model API.

## Verification

```sh
npm run test:realtime
npm run test:offline
npm run typecheck
npm run build
npm run test:realtime:smoke
```

The realtime suite uses ephemeral HTTP servers and real WebSocket clients. It verifies text assembly, sequence ordering, duplicate rejection, cancellation, isolation between clients, disconnect cleanup, fresh reconnects, invalid commands and hostile Origin rejection. The live adapter is injected in tests; the suite never calls a model.

The smoke suite needs installed Chrome (or `PLAYWRIGHT_MCP_EXECUTABLE_PATH`). It checks the built React lesson and the actual Vite development proxy in a headless browser, including streaming, cancellation, disconnect/reconnect and source loading. It also makes no model calls.

Reference: [ws upgrade, native browser client and heartbeat examples](https://github.com/websockets/ws/blob/master/README.md).
