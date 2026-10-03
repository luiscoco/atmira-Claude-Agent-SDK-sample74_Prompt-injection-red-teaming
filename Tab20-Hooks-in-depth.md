# Concept 20: Hooks in depth, the whole agent loop

This file explains how Concept 20 (**Hooks in depth**) was added to the Claude Agent SDK Lab.
Concept 7 ([Tab7-Hooks.md](Tab7-Hooks.md)) hooked tool calls with `PreToolUse` and `PostToolUse`. `options.hooks`
accepts every name in `HOOK_EVENTS`, so you can also run code when the prompt arrives, when a call would ask for
permission, when a call fails, around a subagent, and when the model wants to **stop**.

**Goal:** know which events really fire in an SDK run, what each one can answer, and how a hook fails.

| Concept | Topic | Routes |
|---|---|---|
| 20 | `HOOK_EVENTS`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse` `updatedToolOutput`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStart` / `SubagentStop`, `MessageDisplay`, `systemMessage`, `continue: false`, `timeout`, `{ async: true }` | `/api/c20/run` (SSE), `/files`, `/file`, `/reset` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/20-hooks-in-depth.ts` | **New**: the routes and the 11 example hooks |
| `server/index.ts` | Mounts the router on `/api/c20` |
| `src/concepts/Concept20HooksInDepth.tsx` | **New**: the tab (scenarios, events grid, timeline) |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The events grid and dimmed observer rows |
| `.gitignore` | Ignores `hooks-lab/` |
| `Tab1-query().md` | Adds Concept 20 to the table |
| `Tab20-Hooks-in-depth.md` | This explanation |

---

## Step 1: Which events fire in an SDK run

`HOOK_EVENTS` (SDK `0.3.281`) has 33 names. A probe registered a callback on **all** of them and ran several
prompts. These are the events that reached a callback, in the order they fire:

| Event | When | Main `input` fields |
|---|---|---|
| `UserPromptSubmit` | Before the prompt reaches the model | `prompt` |
| `PreToolUse` | Before a tool call | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | The call would "ask" (no allow rule, no `canUseTool`) | `tool_name`, `tool_input`, `permission_suggestions` |
| `PostToolUse` | After a call that worked | + `tool_response`, `duration_ms` |
| `PostToolUseFailure` | After a call that failed (`PostToolUse` does **not** fire) | + `error` |
| `PostToolBatch` | After all the calls of one turn | `tool_calls[]` |
| `SubagentStart` / `SubagentStop` | Around a subagent | `agent_id`, `agent_type`, `last_assistant_message` |
| `MessageDisplay` | Each assistant text block | `delta`, `final` |
| `Stop` | The model wants to finish | `stop_hook_active`, `last_assistant_message` |

Inside a subagent, `PreToolUse` / `PostToolUse` fire too, and their input carries `agent_id` and `agent_type`.

**What did not fire (tested):**

- `SessionStart` and `SessionEnd`, with a string prompt and in streaming input mode. Their `additionalContext`
  never reached the model.
- `PermissionDenied`, even in `permissionMode: "dontAsk"`. A `system/permission_denied` message is streamed instead.
- `includeHookEvents: true` added no `hook_started` / `hook_response` messages for callback hooks.

## Step 2: What a hook can answer

Valid on **every** event:

| Answer | Effect |
|---|---|
| `{}` | No opinion |
| `systemMessage` | Shown to the **user** as a `system/informational` message. The model never sees it. |
| `continue: false`, `stopReason` | Ends the run |
| `{ async: true, asyncTimeout }` | "Don't wait for me". The run goes on and the answer is ignored. |

Per event (`hookSpecificOutput` unless noted):

| Event | Answer | Effect |
|---|---|---|
| `UserPromptSubmit` | `additionalContext` | Text the model reads next to the prompt |
| `UserPromptSubmit` | `decision: "block"`, `reason` (top level) | The model is not called: 0 turns, $0. The result text starts with `UserPromptSubmit operation blocked by hook:` |
| `PreToolUse` | `permissionDecision`, `updatedInput`, `additionalContext` | Concept 7, plus context for the model |
| `PermissionRequest` | `decision: { behavior: "allow" }` or `{ behavior: "deny", message }` | `canUseTool` as a hook |
| `PostToolUse` | `updatedToolOutput` | Replaces what the **model** sees. The tool and the disk are not changed. |
| `PostToolUseFailure` | `additionalContext` | Explain the error to the model |
| `SubagentStart` | `additionalContext` | Goes to the **subagent**, not to the main agent |
| `Stop` | `decision: "block"`, `reason` (top level) | The model gets `reason` and goes on |

## Step 3: How a hook fails

| The hook… | Result | Meaning |
|---|---|---|
| throws | Ignored. The call **runs**. | **Fail open**: a guard with a bug lets everything through |
| is slower than its matcher's `timeout` | `signal` is aborted, and the call is **not run**. The model reads `PreToolUse hook did not respond before its timeout…` | **Fail closed** |

So a guard should catch its own errors and return `deny`, and give the matcher a `timeout` that fits the work.

## Step 4: Server route

**File:** [server/concepts/20-hooks-in-depth.ts](server/concepts/20-hooks-in-depth.ts)

Every run registers an **observer** on every event: one matcher, no regex, returning `{}`. The hooks the browser
ticks are added on top of it as more matchers:

```ts
for (const event of HOOK_EVENTS) add(event, "observer", observer);
for (const name of picked) {
  const h = available[name];
  add(h.event, name, h.fn, h.matcher, h.timeout);
}
```

Each callback is wrapped by `traced()`, which streams a `hook` SSE event with the input, the answer (or the
error) and how long it took. The 11 hooks:

| Hook | Event | Shows |
|---|---|---|
| `context` | `UserPromptSubmit` | `additionalContext` |
| `block-secrets` | `UserPromptSubmit` | `decision: "block"` |
| `maintenance` | `UserPromptSubmit` | `continue: false` |
| `redact` | `PostToolUse`, matcher `Read` | `updatedToolOutput` + `systemMessage` |
| `explain-failure` | `PostToolUseFailure` | `additionalContext` after an error |
| `approve-writes` | `PermissionRequest` | allow inside `hooks-lab/`, deny + `message` outside |
| `stop-gate` | `Stop` | `decision: "block"` until the answer has a `Source:` line |
| `subagent-brief` | `SubagentStart` | context for the subagent |
| `crash` | `PreToolUse`, matcher `Read` | a throwing guard |
| `slow` | `PreToolUse`, matcher `Read`, `timeout: 2` | a hook that times out |
| `async-log` | `PostToolUse` | `{ async: true }` |

The stop gate must check `stop_hook_active`, or it could block forever:

```ts
if (input.hook_event_name !== "Stop" || input.stop_hook_active) return {};
if (/^Source: \S+/m.test(input.last_assistant_message ?? "")) return {};
return { decision: "block", reason: 'Stop-gate hook: end your answer with a line "Source: <file you read>".' };
```

The run uses Haiku, no thinking, `persistSession: false`, `cwd: hooks-lab/`. `allowedTools` holds the ticked tools
except `Write`, so `Write` "asks" and `PermissionRequest` fires. The browser sends hook names (checked with
`Object.hasOwn`, so `"constructor"` is not a hook) and tool names from a fixed list, never code or paths. A zod
schema checks the body, and an unknown name is refused.
`/files`, `/file?name=` (only names listed in the folder) and `/reset` let you compare what the model saw with
what is on disk.

## Step 5: Browser flow

**File:** [src/concepts/Concept20HooksInDepth.tsx](src/concepts/Concept20HooksInDepth.tsx)

1. Pick a scenario, or tick hooks and tools yourself.
2. The **HOOK_EVENTS** grid lights up each event the observer saw, with a count and the first-fire order.
3. **Hook calls** is the timeline of the ticked hooks. Tick *show the observer's rows* to see every event.
4. **Shown to the user, not to the model** lists `system/informational` and `system/permission_denied` messages.
5. The result card shows turns, cost, `permission_denials`, and the result text when there was no answer.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/20-hooks-in-depth.ts](server/concepts/20-hooks-in-depth.ts) and
[src/concepts/Concept20HooksInDepth.tsx](src/concepts/Concept20HooksInDepth.tsx). Steps 4 and 5 above give the
overview; this section shows the code behind it.

### Step 1: Read the types, then probe

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `HOOK_EVENTS` (the list of 33 names),
`HookCallback`, `HookCallbackMatcher` (with its `matcher` and `timeout`) and the `hookSpecificOutput` types of each
event. The types list every event, but not which ones really fire in an SDK run. So a probe registered a callback on
all of them first (Step 1 above). The observer of the lab is that same probe, kept in the final code.

### Step 2: The lab folder and its seed files

```ts
const LAB = path.resolve("hooks-lab");

// The lab's files. config.env holds a fake key, to show updatedToolOutput redacting it.
const SEED: Record<string, string> = {
  "notes.txt": "Team offsite on Friday in Valencia.\nBudget approved: 1200 EUR.\nOwner: Marta.\n",
  "config.env": "DB_HOST=db.internal\nDB_USER=lab\nAPI_KEY=sk-live-4f9a2b7c1d8e\n",
};

function seed() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(LAB, { recursive: true });
  for (const [name, content] of Object.entries(SEED)) writeFileSync(path.join(LAB, name), content);
}
seed();
```

- `seed()` runs when the server starts, and again on `POST /reset`. Scenario 7 writes `summary.md`, so you need a way
  back to the two seed files.
- The key in `config.env` is fake. `SECRET = /sk-live-[a-z0-9]+/gi` is the pattern the `redact` hook looks for.
- `SLOW_MS = 5000` and `TIMEOUT_S = 2` are the two numbers of scenario 11: the hook is slower than its timeout.

### Step 3: The hooks, as a table of names

All 11 hooks live in one object. The browser only sends their names:

```ts
type Hook = { event: HookEvent; matcher?: string; timeout?: number; fn: HookCallback };

/** `later(name, data)` sends an SSE event after the hook returned (used by the async hook). */
function buildHooks(later: (event: string, data: Record<string, unknown>) => void): Record<string, Hook> {
  return {
    // …
    redact: {
      event: "PostToolUse",
      matcher: "Read",
      fn: async (input) => {
        if (input.hook_event_name !== "PostToolUse") return {};
        const raw = JSON.stringify(input.tool_response);
        const found = raw.match(SECRET)?.length ?? 0;
        if (!found) return {};
        return {
          systemMessage: `Redact hook: hid ${found} secret(s) from the model.`,
          hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: JSON.parse(raw.replace(SECRET, "[REDACTED]")) },
        };
      },
    },
```

- Each entry says which event it is for, and for tool events which `matcher` (`"Read"`). `slow` also has a
  `timeout`.
- Most callbacks that read their input first check `input.hook_event_name`. That tells TypeScript which input type
  it has, so `input.tool_response` or `input.prompt` can be read without a cast (`crash` and `async-log` use a cast
  instead).
- `redact` works on the JSON text of the tool response. It replaces the key and parses the text back, so the model
  gets a response of the same shape.

Two hooks show how a hook fails (Step 3 above). `slow` listens to the `signal` the SDK passes in:

```ts
slow: {
  event: "PreToolUse",
  matcher: "Read",
  timeout: TIMEOUT_S,
  fn: (_input, _id, { signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({}), SLOW_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error(`aborted by the SDK after the ${TIMEOUT_S} s matcher timeout`));
      });
    }),
},
```

- `async-log` returns `{ async: true, asyncTimeout: 5000 }` at once, and calls `later("async", …)` 1.5 s later. That
  is the `async` row in the timeline.
- `buildHooks()` is called once per run, with a `later` that sends only while the browser is still connected.

### Step 4: The `/run` route: check the body

```ts
const TOOLS = ["Read", "Glob", "Write", "Agent"] as const;
const KNOWN_HOOKS = buildHooks(() => {}); // only to check names; each run builds its own hooks
// …
// Hook names and tool names only, never code or paths.
const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    hooks: z.array(z.string().refine((h) => Object.hasOwn(KNOWN_HOOKS, h), { message: "not a hook of this lab" })).max(11),
    tools: z.array(z.enum(TOOLS)).max(TOOLS.length),
    agents: z.boolean().optional(),
  })
  .strict();

concept20.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
```

- The body is exactly the tab's `Form`: a prompt, hook names, tool names and `agents`. An unknown hook or tool
  name is refused with a clear message, for example `Bad request: hooks.0: not a hook of this lab`.
- `Object.hasOwn` keeps names like `"constructor"` out: they exist on every object, but they are not hooks.
- A bad body gets an `error` event and `done`, and no Claude Code process starts.
- Right after the check, `open` is set to `false` on `res.on("close")`. Both `later` (the late `async` event) and
  `traced()` below check it, so nothing is written to a closed response.

### Step 5: Wrap every callback, then register it

```ts
const traced =
  (name: string, fn: HookCallback): HookCallback =>
  async (input, toolUseID, opts) => {
    const t0 = Date.now();
    const { session_id, transcript_path, cwd, ...rest } = input as unknown as Record<string, unknown>;
    // A hook can still run after the browser left (async work, a slow abort): write only while it is connected.
    try {
      const output = await fn(input, toolUseID, opts);
      if (open) send("hook", { name, event: input.hook_event_name, input: rest, output, ms: Date.now() - t0, at: t0 - startedAt });
      return output;
    } catch (err) {
      if (open) send("hook", { name, event: input.hook_event_name, input: rest, error: String(err), ms: Date.now() - t0, at: t0 - startedAt });
      throw err;
    }
  };
```

```ts
const add = (event: HookEvent, name: string, fn: HookCallback, matcher?: string, timeout?: number) => {
  (hooks[event] ??= []).push({ ...(matcher && { matcher }), ...(timeout && { timeout }), hooks: [traced(name, fn)] });
  (described[event] ??= []).push({ ...(matcher && { matcher }), ...(timeout && { timeout }), hooks: [`[Function ${name}]`] });
};
for (const event of HOOK_EVENTS) add(event, "observer", observer);
for (const name of picked) {
  const h = available[name];
  add(h.event, name, h.fn, h.matcher, h.timeout);
}
```

- `traced()` removes `session_id`, `transcript_path` and `cwd` from the input, because they are the same on every
  row.
- `if (open)` skips the `hook` event when the browser has already left. A hook can still finish later, for
  example the `slow` hook when its abort comes after a **Stop**.
- The error is **re-thrown**. So the SDK sees the throw of `crash` exactly as it would without the wrapper, and
  scenario 10 still shows "fail open".
- Every hook gets its **own** matcher, so the `timeout` of `slow` applies only to `slow`.
- `described` is a copy of `hooks` with names instead of functions. Functions cannot be sent as JSON, so the
  `options` event uses it.

### Step 6: The options, and a time limit

The options are listed in Step 4 above (`allowedTools` without `Write`, `persistSession: false`, and the `counter`
agent when `agents` is ticked). Then the route makes sure a run cannot hang the tab:

```ts
const timer = setTimeout(() => {
  send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
  abort.abort();
}, MAX_RUN_MS);
res.on("close", () => clearTimeout(timer));
```

- `MAX_RUN_MS` is 120 s. The route also prints one log line when the run starts, gets its result, and closes.
- Before the query, the route sends `events` with the whole `HOOK_EVENTS` list. The tab draws the grid from it.

The file routes let you compare what the model saw with the disk. `/file` only serves a name that is in the folder:

```ts
concept20.get("/file", (req, res) => {
  const name = String(req.query.name);
  if (!readdirSync(LAB).includes(name)) return void res.status(404).send("Not a file of hooks-lab/.");
  res.type("text/plain").send(readFileSync(path.join(LAB, name), "utf8"));
});
```

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept20 } from "./concepts/20-hooks-in-depth.js";
// …
app.use("/api/c20", concept20);
```

### Step 8: The React tab

A scenario is only a `Form`: a prompt, hook names, tool names and `agents`. **Run** posts the form:

```tsx
const ctrl = new AbortController();
setController(ctrl);
try {
  await streamPost(
    "/api/c20/run",
    form,
    (event, data) => {
      if (event === "options") setSentOptions(data);
      if (event === "events") setAllEvents(data.all);
      if (event === "message") setMessages((prev) => [...prev, data]);
      if (event === "hook") setCalls((prev) => [...prev, data]);
      if (event === "async") setAsyncDone((prev) => [...prev, data]);
      if (event === "error") setError(data.message);
    },
    ctrl.signal,
  );
```

- **Stop** calls `controller?.abort()`. That closes the request, and `openSse()` on the server then aborts the query.
- The grid is computed from the observer's rows only:
  `for (const c of calls) if (c.name === "observer") fired.set(c.event, (fired.get(c.event) ?? 0) + 1);`
- `HookRow` shows one `hook` event, and marks it red when the answer blocks or denies, or when the hook threw.
- `hookInfo` at the top of the file describes the 11 hooks for the table. It is written by hand, so it must match
  `buildHooks()` on the server.
- `src/styles.css` got `.events-grid` for the grid and `.tool-call.observer` to dim the observer's rows.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 20, title: "Hooks in depth", Component: Concept20HooksInDepth },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 20, click **1 · Which events fire?**, then **Run query() with hooks**. The HOOK_EVENTS grid
   lights up, and `SessionStart` stays grey.
3. Click **5 · Redact tool output** and run it. Then click `config.env` in the file list: the key is still on disk.
4. Click **11 · A hook that times out**: the `slow` row shows the error after about 2 s.
5. Send a bad body, for example `{"prompt":"x","hooks":["constructor"],"tools":[]}` to `/api/c20/run`: the stream
   has only an `error` event and `done`.

## Things to try in Concept 20

1. **1 · Which events fire?** Count the grey events. `SessionStart` stays grey.
2. **2 · Context on every prompt**: the answer gives USD, which the prompt never asked for.
3. **3 · Block a prompt**: 0 turns, $0. `context` ran too: both `UserPromptSubmit` hooks see the prompt.
4. **5 · Redact tool output**: the answer says `[REDACTED]`. Open `config.env`: the key is still there.
5. **6 · Explain a failure**: `PostToolUseFailure` fires instead of `PostToolUse`, and the model goes to `notes.txt`.
6. **7 · Approve writes**: `summary.md` is created, and `../outside.md` is in `permission_denials`.
7. **8 · Don't stop yet**: two `Stop` rows. The second has `stop_hook_active: true`.
8. **9 · Subagents**: show the observer's rows and find the `Glob` call that has `(in counter)`.
9. **10** then **11**: the same guard idea, opposite results. The throwing hook lets the key through. The slow one
   blocks the Read.
10. **12 · Don't wait for me**: the `async` row arrives after the run has moved on.

Costs: $0.0046 to $0.022 per scenario on Haiku. Scenarios 3 and 4 cost $0.

**Note:** even with `persistSession: false`, a subagent leaves a small `.meta.json` under
`~/.claude/projects/<hooks-lab>/<session>/subagents/`.
