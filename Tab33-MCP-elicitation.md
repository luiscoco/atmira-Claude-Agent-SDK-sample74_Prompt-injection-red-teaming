# MCP elicitation

This file explains Concept 33 (**MCP elicitation**) of the Claude Agent SDK Lab. Until now, an MCP tool got everything
it needed from the model's arguments (Concept 13). With **elicitation**, an MCP tool can stop halfway and **ask the
user**: the server sends an `elicitation/create` request back to its client, Claude Code. In the terminal, Claude Code
shows a form. With the SDK, **nothing is shown**: the request reaches **your** `onElicitation`, and your code must show
the form, wait for the person, and send back the answer.

**Goal:** build that form in your own UI from the server's JSON schema. Know the three answers you can send, who answers
when you don't (hooks, or nobody), what the server checks, and what this version of Claude Code does not support yet
(URL mode, in-process servers, answers from callback hooks).

| Concept | Topic | Routes |
|---|---|---|
| 33 | MCP elicitation: an MCP server asks the user mid-tool-call (`server.elicitInput()`), `Options.onElicitation` (`serverName`, `message`, `mode`, `requestedSchema`), `accept` + `content` / `decline` / `cancel`, a form built from the schema, the host's and the server's schema checks (`-32602`), a confirmation the server asks for itself, the client capabilities (`elicitation.form`, no `url` in 2.1.281) and a fallback for URL mode, the sign-in page, `system/elicitation_complete`, timeouts (`-32001`, the aborted `signal`), `Elicitation` / `ElicitationResult` hooks (command hooks answer, callback hooks only watch), in-process servers cannot elicit | `/api/c33/who` (SSE), `/run` (SSE), `/respond`, `/consent/:id` (GET, POST), `/consent/:id/status`, `/log`, `/hooklog`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `mcp-servers/rooms-server.ts` | **New**: the lab's `rooms` MCP server (stdio). `book_room` and `cancel_booking` ask the user with a form, `connect_calendar` asks for a sign-in (URL mode, or a form fallback) |
| `elicit-hooks/hook.mjs` | **New**: a command hook. `autofill` answers the form itself, `policy` rewrites the user's answer |
| `server/concepts/33-mcp-elicitation.ts` | **New**: the options, `ask()` (the pending form), `/respond` and its schema check, the hooks, the sign-in page, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c33` |
| `src/concepts/Concept33McpElicitation.tsx` | **New**: the tab (Parts A to D), the form card built from `requestedSchema` |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The form card, server and hook rows |
| `.gitignore` | Ignores `elicit-lab/` |
| `Tab1-query().md` | Adds Concept 33 to the table |

---

## Step 1: A tool that asks the user

The `rooms` server is an ordinary stdio MCP server, like `notes-server.ts` in Concept 13. Claude Code starts it as a
child process. Nothing in the config "turns on" elicitation. Simplified from `roomsServer()` and `baseOptions()` in
[server/concepts/33-mcp-elicitation.ts](server/concepts/33-mcp-elicitation.ts):

```ts
mcpServers: {
  rooms: { type: "stdio", command: process.execPath, args: ["--import", "tsx", "mcp-servers/rooms-server.ts"], env: { … } },
},
allowedTools: ["mcp__rooms__*"],
```

The model calls `book_room` with **no details**. The tool itself asks for them (from `book_room` in
[mcp-servers/rooms-server.ts](mcp-servers/rooms-server.ts); `ROOMS` is `["Madrid", "Lisboa", "Roma"]`):

```ts
    const requestedSchema = {
      type: "object" as const,
      properties: {
        room: { type: "string" as const, title: "Room", enum: ROOMS, description: "Which room" },
        date: { type: "string" as const, title: "Date", format: "date" as const, description: "YYYY-MM-DD" },
        attendees: { type: "integer" as const, title: "Attendees", minimum: 1, maximum: 12 },
        projector: { type: "boolean" as const, title: "Projector", default: false },
      },
      required: ["room", "date", "attendees"],
    };
    // …
      const r = await server.server.elicitInput({ mode: "form", message: `Book a meeting room${purpose ? ` for “${purpose}”` : ""}. Pick the room, the date and how many people will attend.`, requestedSchema }, { timeout: ELICIT_TIMEOUT_MS });
      log(`elicitation result: ${r.action}`, r.content);
      // decline = the user said no; cancel = the user dismissed it. Tell the model, and do nothing.
      if (r.action !== "accept") return text(`The user ${r.action === "decline" ? "declined" : "cancelled"} the booking form. Nothing was booked. Do not retry unless the user asks.`);
      // … refuse a room that is already booked on that date, then save the new booking
      return text({ booked: booking });
```

`purpose` is the tool's only (optional) argument. `log()` sends each step to the lab (see "How it was built" below).

The schema is **flat**: one object whose properties are strings (with `enum`, `format`: `date`, `email`, `uri`,
`date-time`, `minLength`, `maxLength`), numbers or integers (`minimum`, `maximum`) and booleans. No nested objects or
arrays. That is enough to draw a form without knowing the server.

The model **never sees the form or the values**. It only sees what the tool puts in its result
(`{"booked": {...}}`). So a server can ask for details that the model must not invent, or must not know.

## Step 2: The host answers in `onElicitation`

Simplified from `ask()` in [server/concepts/33-mcp-elicitation.ts](server/concepts/33-mcp-elicitation.ts): the lab's handler waits for the browser instead of answering at once.

```ts
onElicitation: async (request, { signal }) => {
  // request: { serverName: "rooms", message, mode: "form", requestedSchema }
  return { action: "accept", content: { room: "Roma", date: "2026-10-20", attendees: 4, projector: true } };
}
```

| Return | Means | What the tool gets |
|---|---|---|
| `{ action: "accept", content }` | The user filled in the form | The content. The tool books the room |
| `{ action: "decline" }` | The user said **no** | No content. The tool books nothing and tells the model |
| `{ action: "cancel" }` | The user **dismissed** the form | The same, but a server may treat it as "ask again later" |

As in Concepts 31 and 32, the lab's `ask()` shows the request in the browser (a `form` event), keeps a promise in a map,
and returns it. `POST /respond` finds the promise and resolves it. The tab draws the form from `requestedSchema`: an
`enum` becomes a select, `format: "date"` a date picker, an integer a number field, a boolean a checkbox, and
`default` fills the first value.

**With no `onElicitation`, every elicitation is declined at once.** The tool gets `{ action: "decline" }` and the
user is never asked (button 0, row "no onElicitation").

## Step 3: Two checks of the answer

The host checks `content` against `requestedSchema` before it answers: a required field left empty, a value outside
the `enum`, a date that is not `YYYY-MM-DD`, a number above `maximum`. `POST /respond` answers **422** with the list,
and the form stays open so the user can fix it.

The server checks again. The MCP SDK's `elicitInput()` validates an `accept` against the schema it sent, and throws:

```
MCP error -32602: Elicitation response content does not match requested schema:
data/room must be equal to one of the allowed values, data/attendees must be <= 12
```

That error happens **inside the tool**. The lab's tool catches it and returns it as `is_error`, and the model then asks
the user in plain text for the details. To see it, press **Edit as JSON**, type `"attendees": 50`, and tick **skip the
host's check**.

Check in the host for a good form, and in the server for safety: the server never trusts its client.

## Step 4: The server asks for a confirmation

Scenario 2 starts with one booking (`a1b2c3`). The model calls `cancel_booking`, and the tool asks. Simplified from
`cancel_booking` in [mcp-servers/rooms-server.ts](mcp-servers/rooms-server.ts), with the booking's room and date filled in:

```ts
requestedSchema: {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Cancel Roma on 2026-10-15?" },
    reason:  { type: "string", title: "Reason", minLength: 3, maxLength: 100 },
  },
  required: ["confirm", "reason"],
}
```

`allowedTools: ["mcp__rooms__*"]` lets the tool run with no permission prompt (Concept 4), yet the user is still
asked. This confirmation belongs to the **server**: it works with any host and any permission settings. The server
decides from the answer, not from the model: a `decline`, or an `accept` with the box unticked, keeps the booking.

## Step 5: What Claude Code supports (URL mode)

When the client connects, it says in `initialize` what it can do. The `client_capabilities` tool of the rooms server
shows it:

```json
{ "client": { "name": "claude-code", "version": "2.1.281" }, "elicitation": { "form": {} } }
```

MCP also has a **URL mode**: `elicitInput({ mode: "url", url, elicitationId })` asks the client to open a web page (a
sign-in, a payment), so the secret is typed on the **server's** page, never in the client. When the flow is over, the
server sends `notifications/elicitation/complete`, and Claude Code emits a `system/elicitation_complete` message. The
SDK types have all of it (`ElicitationRequest.url`, `elicitationId`, `SDKElicitationCompleteMessage`).

But Claude Code 2.1.281 declares **only `form`**. URL mode is behind a CLI feature flag that is off. So a URL
elicitation fails in the server before it is sent: `Client does not support url elicitation.`

`connect_calendar` shows the right way to handle this: **check the capabilities first**, and fall back. Simplified
from `connect_calendar` in [mcp-servers/rooms-server.ts](mcp-servers/rooms-server.ts):

```ts
if (server.server.getClientCapabilities()?.elicitation?.url) {
  await server.server.elicitInput({ mode: "url", message, url, elicitationId });   // then wait, then send "complete"
} else {
  // A form-only client: a form that carries the link (a link is not a secret) and a "done" box.
  await server.server.elicitInput({ mode: "form", message: `Open ${url}, sign in, then tick the box.`, requestedSchema: { … done: boolean … } });
}
const s = await fetch(`${url}/status`).then((r) => r.json());   // never trust the tick: ask YOUR page
```

The sign-in page is served by the lab (`/api/c33/consent/<id>`), and stands for the MCP server's own web page. The
password is typed there. Claude Code, the host and the model never see it. The tab shows the link in the form, and a
`sign-in page` row when you press Allow or Deny.

## Step 6: Who answers: hooks

Two hook events run around `onElicitation`. Button 0 runs the same `book_room` call in five setups, in parallel:

| Setup | `onElicitation` called | The server got |
|---|---|---|
| no `onElicitation` | no | `decline` |
| `onElicitation` | yes | `accept` (booked) |
| SDK **callback** hook on `Elicitation` that returns `accept` | no (none set) | `decline`: the hook ran, its answer was **ignored** |
| **command** hook on `Elicitation` (`settings.hooks`) + an `onElicitation` that declines | **no** | `accept` (booked by the hook) |
| an in-process `createSdkMcpServer` whose tool calls `elicitInput()` | no | error: `Client does not support form elicitation.` |

What the probes showed about Claude Code 2.1.281:

- **Order:** a command `Elicitation` hook → `onElicitation` → nothing (decline). Then a command `ElicitationResult` hook
  can **rewrite** the answer before the server gets it.
- **Only command hooks can answer.** A command hook is a program that Claude Code runs. It reads the hook input on stdin
  and prints its answer as JSON on stdout:

  ```json
  { "hookSpecificOutput": { "hookEventName": "Elicitation", "action": "accept", "content": { "room": "Lisboa", … } } }
  ```

  It goes in `settings.hooks` (the `settings` option, Concept 16), with `matcher` set to the MCP server's name.
  An SDK **callback** hook (`Options.hooks`, Concept 7) for the same events is called with the full input (server,
  message, schema, the user's answer), but what it returns is ignored. Use callbacks to **watch** and log, and command
  hooks to **decide**.
- **In-process servers cannot elicit.** For a `type: "sdk"` server, the client in the SDK declares no elicitation, so
  only external servers (stdio, http) can ask the user.

Scenario 4 uses both kinds. `hook.mjs policy` is a command hook on `ElicitationResult` with a company rule: more than 6
people must use Madrid. Answer **Roma, 8 attendees**. The host sent Roma, the hook changed it, the server got
**Madrid**, and the model reports Madrid. The callback hooks show two rows: they saw the form and your answer.

## Step 7: Time limits

`onElicitation` can wait for ever. The **server** does not: `elicitInput()` has a request timeout (60 s by default in
the MCP SDK; the rooms server sets 150 s with `ELICIT_TIMEOUT_MS`). When it fires, the tool gets
`MCP error -32001: Request timed out`, and Claude Code **aborts `onElicitation`'s `signal`**. The answer your host sends
after that is thrown away.

So the lab:

- gives up **before** the server, after 2 minutes, with `{ action: "cancel" }` (a countdown in the card)
- listens to `signal`, and closes the form with "the server gave up" if it fires
- answers `cancel` for every open form when the run ends or the browser disconnects

Never guess values for a user who did not answer.

## Step 8: The host check

After each run the lab compares three views, and trusts none of them alone:

- what the **host** answered (`onElicitation`'s results)
- what the **server** says it received (its log lines, posted to `/api/c33/log` from the other process)
- the bookings file, before and after

A difference between "host sent" and "server got" is shown in red: an `ElicitationResult` hook changed the answer on
the way (scenario 4), or the server refused it (`-32602`). As in Concepts 30 to 32: trust what your code saw, not what
the model says it did.

## Step 9: Part D, the summary

| You want | Do |
|---|---|
| A tool that asks the user | `server.server.elicitInput({ mode: "form", message, requestedSchema })` in an external MCP server |
| Show the form | `onElicitation`: draw fields from `request.requestedSchema`, show `request.message` and `request.serverName` |
| The user filled it in | `{ action: "accept", content }`, checked against the schema first |
| The user said no / closed it | `{ action: "decline" }` / `{ action: "cancel" }` |
| A confirmation the model cannot skip | Let the server ask for it (a boolean in the schema), whatever the host's permissions |
| A secret (password, OAuth) | URL mode, if the client declares `elicitation.url`; otherwise a form with the link, and the server checks its own page |
| Know what the client supports | `server.server.getClientCapabilities()?.elicitation` in the server |
| Answer without a person | A command `Elicitation` hook in `settings.hooks` |
| Change or veto the user's answer | A command `ElicitationResult` hook |
| Log every form and answer | SDK callback hooks on `Elicitation` / `ElicitationResult` (they watch; they cannot answer) |
| A time limit | Your own timer below the server's timeout, and watch `signal` |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/33-mcp-elicitation.ts](server/concepts/33-mcp-elicitation.ts) and
[src/concepts/Concept33McpElicitation.tsx](src/concepts/Concept33McpElicitation.tsx), with two helpers that run in
other processes: [mcp-servers/rooms-server.ts](mcp-servers/rooms-server.ts) and
[elicit-hooks/hook.mjs](elicit-hooks/hook.mjs). The tab's **code** buttons show the regions of both TypeScript files.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `OnElicitation` (its `signal`),
`ElicitationRequest` (`serverName`, `message`, `mode`, `url`, `elicitationId`, `requestedSchema`),
`ElicitationResult`, `onElicitation` in `Options`, `ElicitationHookInput`, `ElicitationResultHookInput` and
`SDKElicitationCompleteMessage`. The server side is in the MCP SDK: `server.server.elicitInput()` and
`getClientCapabilities()`. The types do not say who answers first, or which hooks count. The five setups of button 0
(`POST /who`) were built to find that out (Step 6 above).

### Step 2: The constants: two processes talk back to the lab

```ts
// The rooms server (a child process of Claude Code) posts its log and reads the sign-in page here.
// server/index.ts always listens on 3001 and ignores LAB_PORT: set LAB_PORT only when you mount this router on another port.
const LAB_URL = `http://localhost:${process.env.LAB_PORT ?? 3001}`;
const ROOMS_SERVER = path.resolve("mcp-servers", "rooms-server.ts");
const HOOK = path.resolve("elicit-hooks", "hook.mjs");
// …
const SERVER_TIMEOUT_MS = 150_000;
const HOST_TIMEOUT_MS = 120_000;
```

- The rooms server and the command hook are **not** in the lab's process: Claude Code starts them. They reach the
  lab over HTTP, at `LAB_URL`.
- `LAB_URL` must point at the port the router really listens on. The lab's server always uses 3001. `LAB_PORT` is
  only for a small test server that mounts this router alone on another port.
- `HOST_TIMEOUT_MS` is shorter than `SERVER_TIMEOUT_MS`, so the host cancels before the server gives up (Step 7
  above).
- `newRun()` creates `elicit-lab/runs/<run id>/rooms.json` with the seed bookings, and keeps the run in a `runs` map.
  The map is how `POST /log` and `POST /hooklog` find the run of a line that comes from another process.

### Step 3: The rooms server and its log

```ts
function roomsServer(run: Run): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", ROOMS_SERVER],
    env: { LAB_URL, LAB_RUN: run.id, ROOMS_FILE: run.roomsFile, ELICIT_TIMEOUT_MS: String(SERVER_TIMEOUT_MS) },
  };
}
```

In `rooms-server.ts`, every step of a tool is posted back to the lab:

```ts
function log(method: string, detail?: unknown) {
  if (!LAB_URL) return;
  fetch(`${LAB_URL}/api/c33/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run: RUN, pid: process.pid, method, detail }),
  }).catch(() => {});
}
```

- Everything the server needs comes through `env`: which run, which bookings file, how long `elicitInput()` waits.
- `log()` is fire-and-forget. The lab reads lines like `elicitation result: accept`, and the host check uses them as
  "what the server got".

### Step 4: The options

```ts
function baseOptions(run: Run, extra: Partial<Options> = {}): Options {
  // …
  return {
    model: MODEL,
    cwd: run.work,
    tools: [], // no built-in tools: only the rooms server's tools
    mcpServers: { rooms: roomsServer(run) },
    strictMcpConfig: true,
    allowedTools: ["mcp__rooms__*"], // the tools run without a permission prompt; the SERVER still asks the user
    onElicitation: ask(run), // without it, every elicitation is declined
    // … settingSources: [], persistSession: false, thinking disabled, maxTurns: 8, env
    ...extra,
  };
}
```

- `tools: []` and `strictMcpConfig: true` leave the model with the rooms tools only.
- `onElicitation` is set by default. `POST /who` sets it back to `undefined` (or to a spy) through `extra`.

### Step 5: Hold the form: `ask()`

The same pending-promise pattern as Concepts 31 and 32, but for `onElicitation` instead of `canUseTool`:

```ts
type Pending = { run: Run; request: ElicitationRequest; done: (r: ElicitationResult, how: string) => void };
const pending = new Map<string, Pending>(); // "<run id>:<form id>" → the form waiting for an answer

function ask(run: Run): OnElicitation {
  return (request, { signal }) => {
    const id = String(++run.forms);
    run.emit("form", { run: run.id, id, serverName: request.serverName, message: request.message, mode: request.mode ?? "form", requestedSchema: request.requestedSchema, url: request.url, timeoutMs: HOST_TIMEOUT_MS });
    return new Promise((resolve) => {
      const key = `${run.id}:${id}`;
      const done = (result: ElicitationResult, how: string) => {
        if (!pending.delete(key)) return; // already answered
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        run.sent.push({ id, how, action: result.action, content: result.content as Record<string, unknown> | undefined });
        run.emit("answer", { id, how, result });
        resolve(result);
      };
      // The server timed out (or the run was aborted): Claude Code no longer waits for this answer.
      const onAbort = () => done({ action: "cancel" }, "the server gave up (signal aborted)");
      // Nobody answered in time: cancel, never guess values for the user.
      const timer = setTimeout(() => done({ action: "cancel" }, "host timeout"), HOST_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(key, { run, request, done });
    });
  };
}
```

- The `form` event sends the whole `requestedSchema` to the browser. The browser draws the form from it.
- Here the `signal` has a second meaning: Claude Code aborts it when the **server's** `elicitInput()` times out.
- Every way out gives `cancel`, never an `accept` with guessed values. `run.sent` keeps what the host answered.

### Step 6: Release it: `POST /respond`, with a schema check

```ts
const RespondBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string().max(50), z.union([z.string().max(500), z.number(), z.boolean()])).optional(), // accept only
    skipCheck: z.boolean().optional(), // accept only: send the content even if it breaks the schema (to see the server refuse it)
  })
  .strict()
  // … two refine() rules: content and skipCheck are only for 'accept'
```

```ts
  const form = (p.request.mode ?? "form") === "form";
  if (b.action === "accept" && form !== (b.content !== undefined)) return res.status(400).json({ error: form ? "accept needs content for a form" : "a url elicitation takes no content" });
  if (b.action === "accept" && form && !b.skipCheck) {
    const errors = validate(p.request.requestedSchema, b.content!);
    if (errors.length) return res.status(422).json({ error: "The answer does not match requestedSchema.", errors });
  }
```

- `content` values can only be strings, numbers or booleans: the flat schema of Step 1 above.
- `validate()` is a small hand-written check of the flat schema: `required`, `enum`, `minLength`, `maxLength`,
  `format` `date` and `email`, `minimum`, `maximum`, and the type of each field. It returns a list of messages.
- A 422 does **not** call `done()`. The form stays open, and the card shows the list.
- `skipCheck` exists only to show the server's own check (`-32602`, Step 3 above).

### Step 7: Hooks, and the logs from other processes

```ts
const hookCmd = (mode: "autofill" | "policy", run: Run) => `"${process.execPath}" "${HOOK}" ${mode} ${run.id} ${LAB_URL}`;

// An SDK CALLBACK hook for the same events: it is called with the full input, but what it returns is ignored.
function observe(run: Run): HookCallback {
  return async (input) => {
    const i = input as any;
    run.hooks.push({ kind: "callback", event: i.hook_event_name });
    run.emit("callbackHook", { event: i.hook_event_name, server: i.mcp_server_name, mode: i.mode, action: i.action, content: i.content, fields: Object.keys(i.requested_schema?.properties ?? {}) });
    return {};
  };
}
```

The command hook, `hook.mjs`, reads the input on stdin and prints its answer on stdout. In `policy` mode:

```js
  if (mode === "policy" && input.hook_event_name === "ElicitationResult" && input.action === "accept" && input.content?.attendees !== undefined) {
    // Company policy: more than 6 people must use Madrid, the only large room.
    if (input.content.attendees > 6 && input.content.room !== "Madrid")
      output = { hookSpecificOutput: { hookEventName: "ElicitationResult", action: "accept", content: { ...input.content, room: "Madrid" } } };
  }
```

- The run id and `LAB_URL` go to the hook as command-line arguments. The hook posts what it saw to
  `POST /api/c33/hooklog`, and the lab adds a `commandHook` row.
- `POST /log` does the same for the rooms server. It fills `run.received`: the server's view of each answer.
- `observe()` only watches. It returns `{}`, because its answer would be ignored anyway (Step 6 above).

Both routes check their body with zod, like the other routes. The schemas accept exactly what the two senders post
(`log()` in the rooms server, the `fetch` at the end of `hook.mjs`), and a bad body gets a 400:

```ts
const LogBody = z
  .object({
    run: z.string().regex(/^([0-9a-f]{8})?$/), // empty when the server runs without LAB_RUN
    pid: z.number().int().positive(),
    method: z.string().min(1).max(200),
    detail: z.record(z.string(), z.unknown()).optional(), // every detail the server sends is an object
  })
  .strict();
```

`HookLogBody` is the same idea for the hook: `run`, `mode`, `event`, and the optional `server`, `action`, `content`,
plus `answer`, which is the hook's `hookSpecificOutput` or `null`.

### Step 8: The routes, the sign-in page, the host check

`POST /run` checks `{ scenario, prompt? }` with zod and streams the run. Only scenario 4 adds hooks:

```ts
    if (b.scenario === "policy") {
      // The command hook enforces the policy; the callback hooks only watch.
      extra.settings = { hooks: { ElicitationResult: [{ matcher: "rooms", hooks: [{ type: "command", command: hookCmd("policy", run) }] }] } } as Options["settings"];
      extra.hooks = { Elicitation: [{ matcher: "rooms", hooks: [observe(run)] }], ElicitationResult: [{ matcher: "rooms", hooks: [observe(run)] }] };
    }
```

`check()` puts the two views side by side:

```ts
    // The server's view and the host's view, side by side: a command ElicitationResult hook can change one into the other.
    pairs: run.received.map((got, i) => ({ sent: run.sent[i], got })),
```

- Scenarios 2 and custom start with the `SEED` booking `a1b2c3`. `check()` also sends the bookings `added` and
  `removed`, compared by their JSON.
- The `finally` block of `/run` answers `cancel` to every form of this run that is still open, and removes the run
  from `runs`.
- `GET /consent/:id` is the sign-in page of Step 5 above, and `POST /consent/:id` records the decision. The id must be
  a uuid. `GET /consent/:id/status` is what the rooms server asks after the form.
- `POST /who` runs the five setups in parallel. The in-process row builds the same `book_room` tool with
  `createSdkMcpServer()` (`inProcessRooms()`). `GET /code` returns the regions of this file and of the rooms server.

### Step 9: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept33 } from "./concepts/33-mcp-elicitation.js";
// …
app.use("/api/c33", concept33); // POST /respond answers a form that onElicitation is waiting on; /consent is the sign-in page
```

### Step 10: The React tab

`run()` streams the events of `POST /run`. A `form` event opens the card, and the matching `answer` event closes it:

```tsx
await streamPost("/api/c33/run", body, (event, data) => {
  if (event === "done") return;
  if (event === "opened") return setOptions(data);
  if (event === "form") setOpen({ ...data, receivedAt: Date.now() });
  if (event === "answer") setOpen((o) => (o && o.id === data.id ? null : o));
  got.push({ event, data });
  setEvents([...got]);
});
```

`FormCard` draws one `Field` per property of `requestedSchema`. `Field` picks the input from the schema:

```tsx
  // … a boolean becomes a checkbox, an enum a select with "(choose)" and one option per value
  else if (p.type === "integer" || p.type === "number")
    input = <input id={`f-${name}`} type="number" min={p.minimum} max={p.maximum} step={p.type === "integer" ? 1 : "any"} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  else input = <input id={`f-${name}`} type={p.format === "date" ? "date" : p.format === "email" ? "email" : "text"} maxLength={p.maxLength} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)} />;
```

Its `send()` POSTs the answer, and shows the server's list of errors on a 422:

```tsx
      } else body.content = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      if (skipCheck) body.skipCheck = true;
    }
    setSending(true);
    try {
      const r = await fetch("/api/c33/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return setErrors(j.errors ?? [j.error ?? `HTTP ${r.status}`]);
```

- An empty field becomes `undefined`, and is left out of `content`. So "required" is checked by the lab's `validate()`.
- `initialValues()` fills the fields from each property's `default`.
- **Edit as JSON** sends the textarea as `content` instead, to try values the form would not allow.
- `Linked` turns the URL in the server's message into a link, for the sign-in form of scenario 3.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 33, title: "MCP elicitation", Component: Concept33McpElicitation },
```

### Step 11: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 33, press **0**: five rows, and only two of them book a room.
3. Press **1**, press **Accept** on the empty form (the host's errors, a 422), then fill it in and accept. The host
   check shows the same answer in "host sent" and "server got".
4. Press **4**, answer Roma with 8 attendees: the host check shows Roma sent and Madrid received.

## How to try it

1. `npm run dev`, then open the **33. MCP elicitation** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Who answers the form?** and compare the five rows.
3. Press **1 · A form from the server**. Press **Accept** on the empty form (the host's errors), fill it in, and
   accept. Run it again and try **Decline**, **Cancel**, and **Edit as JSON** with `"attendees": 50` plus **skip the
   host's check**.
4. Press **2 · The server asks to confirm**. Accept with the box unticked: the booking stays.
5. Press **3 · Sign in on a web page**. Open the link in the form, press **Allow access** (or Deny) on that page, then
   tick the box and accept.
6. Press **4 · A hook rewrites your answer**. Answer Roma with 8 attendees, and read the host check.
7. Write your own job in the form (one booking, `a1b2c3`, exists).

Each scenario costs about $0.01 (Haiku 4.5), and button 0 about $0.03. A form waits for your answer for up to
2 minutes.
