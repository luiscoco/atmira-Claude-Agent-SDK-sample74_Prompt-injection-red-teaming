# Concept 12: Streaming input mode, step by step

This file explains how Concept 12 (**Streaming input mode**) was added to the Claude Agent SDK Lab.
Concept 10 used an input queue only to make `interrupt()` work. Here the queue is the main topic: when the prompt
is an async iterable, one `query()` call is a **live session** you can talk to, and change, while it runs.
There are three parts:

- **A. One `query()`, many turns.** A chat on top of a single process: messages sent while the agent is busy,
  `priority`, and messages with images.
- **B. Changing the session while it is alive.** `setModel()`, `setPermissionMode()`, `supportedModels()` and
  `getContextUsage()`.
- **C. Two ways to write the prompt.** An `async function*` generator compared with a plain string.

| Concept | Topic | Routes |
|---|---|---|
| 12 | Streaming input: `AsyncIterable<SDKUserMessage>`, queue, `priority`, image blocks, control requests | `/api/c12/session`, `/send`, `/model`, `/permission-mode`, `/context`, `/end`, `/script` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/12-streaming-input.ts` | **New**: the live-session routes and the `/script` route |
| `server/index.ts` | Mounts the router on `/api/c12`, and raises the JSON body limit to 10 MB (images) |
| `src/concepts/Concept12StreamingInput.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | Adds `.thumb` (image preview) and `.meter` (context bar) |
| `Tab1-query().md` | Adds Concept 12 to the table of concepts |
| `Tab12-Streaming-input.md` | This explanation |

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;

type SDKUserMessage = {
  type: 'user';
  message: MessageParam;             // content: a string OR an array of blocks (text, image, document, ...)
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later';
  // ...
};

interface Query extends AsyncGenerator<SDKMessage, void> {
  // "Control Requests ... only supported when streaming input/output is used."
  interrupt(): Promise<...>;                              // Concept 10
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;   // "Used internally for multi-turn conversations."
  close(): void;
  // ... and many more (applyFlagSettings, setMcpServers, reloadSkills, ...)
}
```

Two things in these types shape the tab:

1. `prompt` has **two modes**. A string is *single message mode*: one message, then the input is closed.
   An async iterable is *streaming input mode*: the SDK keeps reading from it, so the session lives as long as
   the iterable is open.
2. The `Query` object is not only the output stream. It is also a **remote control** for the running
   Claude Code process. Those control requests need the process to still be alive, which is what streaming input
   gives you.

---

# Part A: One query(), many turns

## Step 2: The input queue (again)

The server reuses the push queue from Concept 10. It is an async generator that yields whatever was pushed, and
waits while the queue is empty:

```ts
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}
```

The only change: `push()` now takes a whole `SDKUserMessage`, so the caller can set `priority` and use content
blocks. A small helper builds it:

```ts
/** Builds the SDKUserMessage for a text (and an optional image). */
function userMessage(text: string, image?: Image, priority?: Priority): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = image
    ? [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
      ]
    : text;
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content }, ...(priority && { priority }) };
}
```

## Step 3: The session route

`POST /session` starts one `query()` with the queue as prompt, stores it in a `Map` by id (like Concept 10), and
streams everything as SSE. `MODEL` is Haiku, so the demo is cheap, and `permissionMode` is the one chosen in the UI
before starting (Part B):

```ts
const options: Options = {
  model: MODEL,
  tools: ["Read", "Write", "Glob"],
  allowedTools: ["Read", "Glob"], // Write is NOT pre-approved: the permission mode decides
  permissionMode,
  cwd: SANDBOX,
  settingSources: [],
  strictMcpConfig: true,
  includePartialMessages: true, // the answer grows as it streams, so you can send while it is busy
};

const id = randomUUID();
const input = inputQueue();
const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
sessions.set(id, { q, input, send, startedAt: Date.now() });

send("session", { id });
send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
pipe(q).finally(() => sessions.delete(id));

// A control request works as soon as the process is up, even before the first message.
q.supportedModels()
  .then((models) => send("models", models))
  .catch(() => {});
```

Before this, the route checks the body (`permissionMode` must be one of the four modes the tab offers) and deletes
`sandbox/hello.txt`, so the permission demo of Step 8 always starts from zero.

`POST /send` pushes a message (it also sends a `control` SSE event so the timeline shows when):

```ts
concept12.post(
  "/send",
  control(SendBody, ({ input, send, ms }, { text, image, imageName, priority, clientId }) => {
    send("control", { method: "push user message", text, image: imageName, priority, clientId, ms });
    input.push(userMessage(text, image, priority));
  }),
);
```

`control()` is a small wrapper used by every route in Parts A and B: it checks the body against a zod schema
(`SendBody` here, `400` when it is wrong), finds the open session, runs the action, and answers `409` with the error
if the session is gone.

## Step 4: What one live session looks like in the stream

Tested with three messages in a row. The same `session_id` for all of them, and **one `system/init` per turn**, not
one per session:

```
push "Create hello.txt ..."        system/init  model haiku  mode default      session d824e1b8
                                   ... result/success  total $0.0090
push "Try again ..."               system/init  model haiku  mode acceptEdits  session d824e1b8
                                   ... result/success  total $0.0166
push "Write 30 octopus facts..."   system/init  ...                            session d824e1b8
```

Two things to notice:

- **No `resume` is needed.** Concept 6 started a new process per message and passed `resume: sessionId`.
  Here the process never stops, so the context is simply still there. Part C proves it with a memory question.
- **`result.total_cost_usd` is a running total for the session**, not the cost of that turn. The timeline shows
  both: the total, and the difference with the previous result ("this turn").

## Step 5: Sending while the agent is busy, and `priority`

The input is a queue, so nothing stops you from pushing while a turn is running. Tested with a long answer, and a
second message 1.5 s later:

| Second message sent with | What happened |
|---|---|
| no `priority` | It waited. The first turn finished (`result/success`), then the second one ran as its own turn. |
| `priority: "later"` | Same as no priority, for a single queued message. |
| `priority: "now"` | The running turn stopped within ~10 ms with `result/error_during_execution` ($0 for that turn), and a new turn started straight away. |

With `"now"`, the new turn still sees the whole conversation, including the unfinished request. In the first test
the message was just "Now just say: BANANA" and the model went back to counting. When the message clearly redirects
("**Stop. Instead,** just say BANANA."), the answer is `BANANA`. So `"now"` behaves like *interrupt + send*, in one
message.

`"next"` vs `"later"` only matters when several messages are waiting: they decide the order inside the queue.

## Step 6: Messages with images

`message.content` is an Anthropic Messages API `MessageParam`, so it can be an array of blocks. The browser reads
the file with `FileReader.readAsDataURL()`, keeps the base64 part, and sends it in the JSON body:

```ts
reader.onload = () => {
  const url = String(reader.result); // data:image/png;base64,....
  setImage({ media_type: file.type, data: url.split(",")[1], name: file.name, url });
};
```

Tested with the architecture diagram from sample 1: *"This infographic illustrates the architecture of the
'Claude Agent SDK Lab', showing how a React browser UI sends queries ..."*.

### The JSON body limit

`express.json()` accepts 100 KB by default, and a screenshot in base64 is usually bigger (Express would answer
`413 Payload Too Large`). `server/index.ts` now uses `express.json({ limit: "10mb" })`, and the browser refuses files
over 5 MB. The server echoes only the file *name* in the `control` event; the browser keeps its own preview
(by `clientId`), so the image is not sent back through SSE.

---

# Part B: Changing the session while it is alive

## Step 7: The control routes

| Route | Calls | What you see in the stream |
|---|---|---|
| `POST /model` | `await q.setModel(model)` | A `user` message `<local-command-stdout>Set model to ...</local-command-stdout>`, then the next `system/init` shows the new model |
| `POST /permission-mode` | `await q.setPermissionMode(mode)` | A `system/status` message with `permissionMode`, then the next `system/init` shows it too |
| `POST /context` | `await q.getContextUsage({ detail: "summary" })` | Nothing in the stream: the answer is the return value |
| `POST /end` | `input.close()` | The loop ends normally |
| (on start) | `await q.supportedModels()` | Nothing in the stream: fills the model `<select>` |

```ts
concept12.post(
  "/model",
  control(z.object({ id: Id, model: ModelName }).strict(), async ({ q, send, ms }, { model }) => {
    await q.setModel(model);
    send("control", { method: `q.setModel("${model}")`, ms });
  }),
);
```

`getContextUsage()` returns a lot (a grid for the terminal UI, memory files, MCP tools, ...). The route keeps only
the numbers the tab draws:

```ts
const { categories, totalTokens, maxTokens, percentage } = await q.getContextUsage({ detail: "summary" });
```

`"summary"` answers from the last response's usage, without extra calls to the token-count API. After six turns it
said: *System tools 2,840 · Messages 3,917 · 6,757 tokens (1%)*. The window was 1,000,000 because the session was on
Sonnet by then; on Haiku it is 200,000.

## Step 8: What each control does, tested

**`setPermissionMode()`**: the same request, before and after:

1. Start in `default` and send *Create hello.txt*. `Write` is not in `allowedTools` and there is no `canUseTool`
   (Concept 4), so nobody can approve it: `system/permission_denied`, an error `tool_result`, and
   `result.permission_denials` has one entry. The model says it needs permission.
2. `setPermissionMode("acceptEdits")`, then *Try again*: `Write` succeeds and `sandbox/hello.txt` contains `hi`.
   Same session, same process, no restart.
3. `plan` mode: the model does **not** touch `hello.txt`. It writes a plan instead. Note that Claude Code saves
   that plan in `~/.claude/plans/` (your user folder, outside the sandbox).

**`setModel()`**: after `setModel("claude-sonnet-5")`, *Which model are you?* answers *"I'm Claude Sonnet 5."* and
`system/init.model` changes. One detail found while testing: a message that was **already queued** when
`setModel()` was called still ran on the old model. The change applies from the next turn the CLI starts.

## What to take away from Parts A and B

1. **An async iterable prompt turns `query()` into a session.** It lives until you close the iterable (or abort).
2. **Each message is a turn.** One `system/init` and one `result` per turn, the same `session_id`, no `resume`.
3. **Pushing while busy is normal.** Messages wait in order; `priority: "now"` cuts the running turn.
4. **Content can be blocks.** Text + image (or documents) in one user message.
5. **The `Query` object is a remote control.** Model, permission mode, context usage, and more, all without
   restarting. Each change shows up in the stream (`local-command-stdout`, `system/status`, the next `system/init`).
6. **`total_cost_usd` is cumulative** in a live session. Subtract to get the cost of a turn.

---

# Part C: Two ways to write the prompt

## Step 9: A generator instead of a queue

A queue is handy when messages come from outside (a browser, a chat app). When the conversation is known in
advance, an `async function*` is simpler. The generator yields a message, then waits until that turn's result
arrives before it yields the next one:

```ts
let turnDone = () => {};
async function* conversation(): AsyncGenerator<SDKUserMessage> {
  for (const text of SCRIPT) {
    const done = new Promise<void>((resolve) => (turnDone = resolve));
    send("control", { method: "yield user message", text, ms: ms() });
    yield userMessage(text);
    await done;
  }
  send("control", { method: "generator returned (input closed)", ms: ms() });
}

// Pass every message through, and tell the generator when a turn ends.
async function* signalTurns(stream: AsyncIterable<SDKMessage>) {
  for await (const msg of stream) {
    yield msg;
    if (msg.type === "result") turnDone();
  }
}

pipe(signalTurns(query({ prompt: conversation(), options })));
```

The `done` promise is created **before** the `yield`, so a result that arrives quickly is never missed.
When the generator returns, the input is closed and the session ends by itself.

Without the `await done`, the generator would yield all three messages at once: they would simply queue up
(Step 5) and run one after the other. Waiting makes each message depend on the previous answer, which is what a
real script usually needs.

## Step 10: The same first message, as a string

```ts
const q = query({ prompt: SCRIPT[0], options });

// Stream every message, then (once the loop has ended and the process is gone) try a control request.
async function* thenTryControl() {
  yield* q;
  try {
    await q.setModel("claude-sonnet-5");
    send("control", { method: 'q.setModel("claude-sonnet-5") after the loop', ms: ms() });
  } catch (err) {
    send("control", { method: 'q.setModel("claude-sonnet-5") after the loop', ms: ms(), error: String(err) });
  }
}
```

## Step 11: Generator vs. string, tested

| | `async function*` | `"a string"` |
|---|---|---|
| Turns | 3 (`system/init` ×3, one `session_id`) | 1 |
| Third answer | *"You're Ana, and you teach TypeScript."* (context kept, no `resume`) | – |
| After the loop | The generator returned, so the input closed | `setModel()` throws `Error: Query closed before response received` |
| Session total | $0.0050 for 3 turns (Haiku) | $0.0020 |

One more detail found while testing: calling `setModel()` on a string query **before** the loop does not throw. It
resolves, but the single turn still ran on the original model (`result.modelUsage` only listed Haiku). The
message was already sent, so there was no *next* turn to apply it to. The `sdk.d.ts` comment "only available in
streaming input mode" is not enforced with an error. In practice, it just has no useful effect.

## What to take away

1. **String = one message, one turn.** Simple, and the right choice for one-shot tasks.
2. **Async iterable = a live session.** Use a push queue when the messages come from outside, and a generator when
   the script is known.
3. **Control requests need a live process.** They work from the moment `query()` starts until the input closes.
   After that they throw `Query closed before response received`.
4. **Close the input to end cleanly.** `input.close()` (or the generator returning) ends the loop without an error.
   `abortController.abort()` (Concept 10) kills the process instead.
5. **`streamInput()`** exists on `Query`, but the SDK describes it as "used internally for multi-turn
   conversations". Passing the iterable as `prompt` is the public way to do the same.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/12-streaming-input.ts](server/concepts/12-streaming-input.ts) and
[src/concepts/Concept12StreamingInput.tsx](src/concepts/Concept12StreamingInput.tsx). The queue, `userMessage()` and
the generator are already shown in Steps 2, 3, 9 and 10 of the concept, so here we look at how they are wired together.

### Step 1: Read the types, and reuse what exists

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `SDKUserMessage`, `priority`, `interface Query`,
`setModel`, `setPermissionMode`, `supportedModels` and `getContextUsage` (see Step 1 of the concept). Two things are
reused from earlier concepts: the push queue of Concept 10 (now `push()` takes a whole `SDKUserMessage`), and the
sandbox folder of Concept 3 (`import { SANDBOX } from "./03-tools.js"`). `MODEL` is Haiku, which keeps a long live
session cheap.

Then come the zod schemas that every route uses to check its body. The image schema is the biggest one:

```ts
// Every POST body is checked first: SSE routes answer a bad one with `error` + `done`, JSON routes with 400.
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const Id = z.string().uuid();
const MODES = ["default", "acceptEdits", "plan", "dontAsk"] as const; // the modes the tab offers
// …
// The browser refuses files over 5 MB; in base64 that is under 7 million characters.
const ImageInput = z
  .object({
    media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+=*$/, "base64 data"),
  })
  .strict();

type Priority = z.infer<typeof PriorityName>;
type Image = z.infer<typeof ImageInput>;
```

- `Image` only allows the four media types the Messages API accepts for images.
- The TypeScript types come from the schemas (`z.infer`), so the checked body and the code cannot drift apart.
- `MODES` has only the four modes the tab offers, so a request cannot start a session in `bypassPermissions`.

### Step 2: One open session per id

A live session must survive between HTTP requests, so the server keeps it in a `Map`:

```ts
type Session = { q: Query; input: ReturnType<typeof inputQueue>; send: (event: string, data: unknown) => void; startedAt: number };
const sessions = new Map<string, Session>();

concept12.post("/session", async (req, res) => {
  const parsed = SessionBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return void res.end();
  }
  const permissionMode: PermissionMode = parsed.data.permissionMode ?? "default";

  // The permission demo creates this file, so every session starts without it.
  await rm(path.join(SANDBOX, "hello.txt"), { force: true });
  // … options (see Step 3 of the concept)
  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  sessions.set(id, { q, input, send, startedAt: Date.now() });

  send("session", { id });
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  pipe(q).finally(() => sessions.delete(id));
```

- The session keeps `send`, the SSE writer of **this** response. Later requests (`/send`, `/model`…) use it to add
  `control` events to the same stream the browser is already reading.
- The first SSE event is `session`, with the id. The browser needs it for every other route.
- `pipe(q).finally(...)` removes the session when the loop ends: the input was closed, or the browser left (abort).
- The route deletes `hello.txt`, so the `setPermissionMode()` demo of Step 8 of the concept always starts from zero.
- A bad body is answered on the stream (`error`, then `done`), as in Concept 34. `/script` does the same.

### Step 3: `getSession()` and `control()`: one wrapper for five routes

```ts
function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error("No open session with that id (it already ended).");
  return { ...session, ms: Date.now() - session.startedAt };
}

/** Wraps a control route: checks the body (400), finds the session, runs the action, reports errors as 409. */
function control<T extends z.ZodType<{ id: string }>>(schema: T, action: (s: ReturnType<typeof getSession>, body: z.infer<T>) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: badRequest(parsed.error) });
      return;
    }
    try {
      const result = await action(getSession(parsed.data.id), parsed.data);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  };
}
```

- These routes answer with plain JSON, not SSE. What they cause shows up in the session's own stream.
- Each route passes its own schema. Every schema has an `id`, so `control()` can always find the session, and the
  action gets a typed body.
- `400` means a bad body. `409` covers both "no such session" and a control request that throws.
- `ms` is the time since the session started. The timeline prints it, so you can see when each push or control
  happened.

### Step 4: The routes on top of `control()`

With the wrapper, each route is one or two lines: `/send` (Step 3 of the concept), `/model`, `/permission-mode` and
`/context` (Step 7 of the concept), and `/end`:

```ts
// Closing the input iterable is the normal way to end the session.
concept12.post(
  "/end",
  control(IdBody, ({ input, send, ms }) => {
    send("control", { method: "close input", ms });
    input.close();
  }),
);
```

- `input.close()` ends the prompt stream, so the `for await` loop ends with no error and the session is deleted.
- `/context` returns the trimmed usage **and** sends it as a `control` event, so the bar appears in the timeline.
- `IdBody` is `z.object({ id: Id }).strict()`. `/send` uses `SendBody`: `text`, `clientId`, and the optional
  `priority`, `image` and `imageName`, exactly what the tab sends.

### Step 5: `POST /script`: Part C in one route

`/script` takes `{ variant: "generator" | "string" }` (checked with `z.enum`) and is a normal one-shot SSE route. It uses `tools: []`, so
the three turns are only text. The string branch ends with `return`, so the generator code below it runs only for
`"generator"`. The code of both branches is in Steps 9 and 10 of the concept.

### Step 6: Mount the router, and raise the body limit

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept12 } from "./concepts/12-streaming-input.js";
// …
app.use("/api/c12", concept12);
```

The same file also sets the JSON limit, because images travel as base64 in the body:

```ts
// 10mb instead of the default 100kb: Concepts 12 and 29 send images and PDFs as base64 inside the JSON body.
app.use(express.json({ limit: "10mb" }));
```

### Step 7: The React tab: one stream, many small requests

`LiveSession` opens the SSE stream once and keeps it open. Every button then calls a plain JSON route:

```tsx
async function start() {
  // … reset the log, the error and the models
  try {
    await streamPost("/api/c12/session", { permissionMode: startMode }, (event, data) => {
      if (event === "session") setSessionId(data.id);
      if (event === "models") setModels(data);
      if (event === "control") setLog((prev) => [...prev, { kind: "control", data }]);
      if (event === "message") setLog((prev) => [...prev, { kind: "message", data }]);
      if (event === "error") setError(data.message);
    });
  } finally {
    setOpen(false);
    setSessionId(null);
  }
}

async function run(route: string, body: object = {}) {
  try {
    setError(null);
    await post(route, { id: sessionId, ...body });
  } catch (err) {
    setError(String(err));
  }
}
```

- `streamPost()` only returns when the session ends, so the `finally` is where the tab knows the session is gone.
- `run("end")`, `run("model", { model })`, `run("permission-mode", { mode })` and `run("context")` all add the
  session id for you. `post()` throws the server's `409` error text, and the tab shows it.
- The status line (messages sent, results, `waiting in the queue`, current model and mode) is not stored: it is
  counted from the log on every render.

### Step 8: Sending a message, with an image

```tsx
async function send() {
  const clientId = crypto.randomUUID();
  if (image) setPreviews((prev) => ({ ...prev, [clientId]: image.url }));
  await run("send", {
    text,
    priority: priority || undefined,
    clientId,
    ...(image && { image: { media_type: image.media_type, data: image.data }, imageName: image.name }),
  });
  setImage(null);
}
```

- The image preview stays in the browser, under `clientId`. The server echoes only `clientId` and `imageName`, and
  `Timeline` finds the preview again (see Step 6 of the concept).
- `priority: priority || undefined` drops the field when the select says "(not set)".
- `Timeline` builds the answer from `text_delta` stream events, and prints the cost of each turn as the difference
  between two `total_cost_usd` values (`previousTotal`).

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 12, title: "Streaming input", Component: Concept12StreamingInput },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 12, press **Start session**, then **Send** twice. The status line shows 2 `system/init`
   and the same session id.
3. Pick **Long answer**, press **Send**, and send **Redirect** with `priority` `now` while it runs.
4. Press **await q.getContextUsage()**, then **Close input (end session)**.
5. Part C from a terminal: see "Running the app" below.

## Things to try in Concept 12

1. Start in `dontAsk` mode and ask for *Create a file*. Compare the denial with the one in `default` mode.
2. Send *Long answer*, then quickly send three short messages with different `priority` values. In what order do
   they run?
3. Switch the model to one from `supportedModels()` (e.g. `haiku` or `sonnet`) and watch the "this turn" cost
   change.
4. Press **`await q.getContextUsage()`** after each turn and watch *Messages* grow. Then send an image and press it
   again.
5. In the server, remove `await done` from `conversation()` and run the generator again. Are the answers
   different?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**12. Streaming input**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

The live session needs several requests (start, then send / control), so it is easiest from the UI. Part C can be
called without the UI:

```powershell
curl.exe -N -X POST http://localhost:3001/api/c12/script -H "Content-Type: application/json" -d '{\"variant\":\"generator\"}'
curl.exe -N -X POST http://localhost:3001/api/c12/script -H "Content-Type: application/json" -d '{\"variant\":\"string\"}'
```
