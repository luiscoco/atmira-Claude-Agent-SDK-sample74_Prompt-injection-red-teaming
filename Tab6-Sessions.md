# Concept 6: Sessions with `resume`, step by step

This file explains how Concept 6 (**Sessions**) was added to the Claude Agent SDK Lab.
It builds on Concept 1 ([Tab1-query().md](<Tab1-query().md>)), especially the `system/init` message.

**Goal:** make two separate `query()` calls behave like one conversation. The first call creates a session and emits a
`session_id`. The browser sends that ID back as `options.resume` on the next call, allowing Claude to remember the
previous turn.

| Concept | Topic | Route |
|---|---|---|
| 6 | Sessions: multi-turn chat with `resume` | `/api/c6/query` |

## Step 1: Find the session ID

Every run emits a `system/init` message. Among other fields, it contains the ID of the conversation:

```ts
{
  type: "system",
  subtype: "init",
  session_id: "...",
  model: "..."
}
```

The ID is not invented by the UI. It comes from the SDK, so the client must wait for `system/init` before it can
continue the session.

## Step 2: Resume the session

The SDK accepts the previous session ID in `Options.resume`. A simplified example of what the lab does in two
requests (the real code is the `/query` route in [server/concepts/06-sessions.ts](server/concepts/06-sessions.ts)):

```ts
const firstRun = query({
  prompt: "Remember that my favorite color is green.",
  options: { settingSources: [] },
});

const secondRun = query({
  prompt: "What is my favorite color?",
  options: { resume: sessionId, settingSources: [] },
});
```

`resume` is different from putting the earlier answer into the new prompt. The SDK loads the existing conversation
session and adds the new prompt to it.

## Step 3: Server route

**File:** [server/concepts/06-sessions.ts](server/concepts/06-sessions.ts)

The route accepts an optional `resume` value (checked by zod, see "How it was built" below). When it is present,
it is forwarded to `query()`:

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  maxTurns: 3,
  settingSources: [],
  ...(body.resume ? { resume: body.resume } : {}),
};

pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
```

The server does not store conversation state in an application `Map`. The SDK owns the session; the browser only keeps
and returns its identifier.

## Step 4: Browser flow

**File:** [src/concepts/Concept06Sessions.tsx](src/concepts/Concept06Sessions.tsx)

The tab follows this sequence:

1. **Start session** sends a prompt without `resume`.
2. The `system/init` event is received and its `session_id` is saved in React state.
3. **Continue session** sends the next prompt together with that ID.
4. **New session** clears the ID and message log, so the next run starts from scratch.

The tab also keeps all raw SDK messages visible through `MessageLog`, making the two `system/init` events and their
results easy to compare.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/06-sessions.ts](server/concepts/06-sessions.ts) and
[src/concepts/Concept06Sessions.tsx](src/concepts/Concept06Sessions.tsx). Both files are short: the SDK does the
hard part.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `resume?: string` (in `Options`) and
`SDKSystemMessage` (the `system/init` message, with its `session_id`). Next to `resume` you will also find
`forkSession?: boolean`. This tab does not use it: it always continues the same session.

### Step 2: Write the route, with a zod check

The server file is a `badRequest()` helper, one schema and one route:

```ts
// The tab sends resume: null until the first system/init gives it a session id.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    resume: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a session id (uuid)").nullable().optional(),
  })
  .strict();

concept06.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 3,
    settingSources: [],
    ...(body.resume ? { resume: body.resume } : {}),
  };

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});
```

- `openSse()` comes from [server/sse.ts](server/sse.ts). `send()` writes one SSE event. `pipe()` sends every SDK
  message as a `message` event, then a `done` event.
- `send("options", options)` goes out **before** the run, so the browser can show what was sent (the
  `options sent to query()` card).
- The schema accepts exactly what the tab sends: a non-empty `prompt`, and `resume` as a session id, `null` (the
  first run, see Step 4) or nothing. `.strict()` refuses any other key.
- A bad body gets one `error` event (for example `Bad request: resume: a session id (uuid)`), then `done`. The
  SDK is never called. `badRequest()` is the same one-line helper as in Concept 34.
- The spread with `body.resume ?` turns `null` into "no resume".
- The `abortController` from `openSse()` fires when the browser disconnects, so closing the tab stops the run.

### Step 3: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept06 } from "./concepts/06-sessions.js";
// …
app.use("/api/c6", concept06);
```

### Step 4: The React tab

The tab keeps the prompt, the message list and the current `sessionId`. One `run()` handles both **Start session**
and **Continue session**:

```tsx
async function run() {
  setRunning(true);
  try {
    await streamPost("/api/c6/query", { prompt, resume: sessionId }, (event, data) => {
      if (event === "options") setOptions(data);
      if (event === "message") {
        setMessages((previous) => [...previous, data]);
        if (data.type === "system" && data.subtype === "init") setSessionId(data.session_id);
      }
      if (event === "error") setMessages((previous) => [...previous, { type: "error", message: data.message }]);
    });
  } finally {
    setRunning(false);
  }
}
```

- `streamPost()` comes from [src/lib/sse.ts](src/lib/sse.ts). It POSTs JSON and reads the SSE answer, because
  `EventSource` only supports GET.
- On the first run `sessionId` is `null`, so the body is `{ prompt, resume: null }`. The schema allows it, and the
  route sends no `resume`.
- The ID is saved from **every** `system/init`, not only the first one. So the state always holds the ID the SDK
  reported last.
- The button label comes from the same state: `sessionId ? "Continue session" : "Start session"`.
  `newSession()` sets it back to `null` and clears the messages.

The cards below the buttons are computed from `messages` on each render: the latest `system/init`, the text of all
`assistant` messages, and the number of `result` messages ("Runs in this session").

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 6, title: "Sessions", Component: Concept06Sessions },
```

### Step 5: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 6 and click **Start session**. The **Active session** card appears with the ID.
3. Type `What is my favorite color?` and click **Continue session**. The answer says green, and the
   `options sent to query()` card now contains `resume`.
4. A bad body is refused before the SDK runs. From PowerShell:
   `curl.exe -N -X POST http://localhost:3001/api/c6/query -H "Content-Type: application/json" -d '{\"prompt\":\"hi\",\"resume\":\"x\"}'`
   answers `event: error` with `Bad request: resume: a session id (uuid)`.

## Things to try in Concept 6

1. Run the default prompt, then replace it with `What is my favorite color?` and click **Continue session**.
2. Click **New session**, then ask the color question immediately. Compare the answer with the resumed session.
3. Open the `options sent to query()` card. The first run has no `resume`; the second run contains the session ID.
4. Continue the session several times and compare the run count with the number of `result` messages.
5. Inspect the raw stream and find the `system/init.session_id` that the UI uses for the next request.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/06-sessions.ts` | New route that checks the body with zod and forwards `resume` to `query()` |
| `server/index.ts` | Mounts the route on `/api/c6` |
| `src/concepts/Concept06Sessions.tsx` | Multi-turn session UI |
| `src/App.tsx` | Adds the Sessions tab |
| `Tab6-Sessions.md` | This explanation |
