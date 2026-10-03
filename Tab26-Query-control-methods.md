# Query control methods

This file explains how Concept 26 (**Query control methods**) was added to the Claude Agent SDK Lab.
`query()` returns a **`Query`**. You already know one side of it: an async iterator of messages (Concept 1). The other
side is a set of **methods** that send control requests to the running Claude Code process: ask what the session
has, change its model or permission mode, stop a turn, move a command to the background, kill a task, or end the
session. Earlier tabs used some of these as side notes. This concept puts them together as a **remote control** and
lets the browser drive a live session with them.

**Goal:** know which methods exist, what each one returns, **when** it takes effect, which messages it causes, and
how it behaves before a turn, during a tool call, and after the session has ended.

| Concept | Topic | Routes |
|---|---|---|
| 26 | Query control methods: `initializationResult()`, `supportedModels()` / `supportedCommands()` / `supportedAgents()`, `mcpServerStatus()`, `accountInfo()`, `getContextUsage()`, `readFile()`, `setModel()` (`<local-command-stdout>`, `system/init` per turn), `setPermissionMode()` (`system/status`, `acceptEdits`, `plan`, `dontAsk`), `interrupt()` (`still_queued`, `error_during_execution`), `backgroundTasks(toolUseId)`, `stopTask(taskId)`, `task_started` / `task_updated` / `task_notification`, `close()`, `CLAUDE_CODE_TMPDIR` | `/api/c26/catalog`, `/open` (SSE), `/call`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/26-query-control.ts` | **New**: the lab folder, `canUseTool`, the method whitelist, the live-session routes |
| `server/index.ts` | Mounts the router on `/api/c26` |
| `src/concepts/Concept26QueryControl.tsx` | **New**: the tab (Parts A to C) and the scenario runner |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Colours for control calls and task events |
| `.gitignore` | Ignores `control-lab/` |
| `Tab1-query().md` | Adds Concept 26 to the table |
| `Tab26-Query-control-methods.md` | This explanation |

---

## Step 1: A Query is two things

Simplified from `POST /open` in [server/concepts/26-query-control.ts](server/concepts/26-query-control.ts):

```ts
const q = query({ prompt: input(), options });   // input(): an async generator of user messages (Concept 12)

for await (const msg of q) { … }                 // 1. the messages the session sends you
await q.setModel("sonnet");                      // 2. requests YOU send the session, at any time
```

Both travel on the same pipe (stdin/stdout of the Claude Code process). A control method is a **round trip**: the
SDK sends a `control_request`, the CLI answers with a `control_response`, and the promise resolves. So the process
must still be alive. With streaming input it stays alive between turns, waiting for your next message.

The lab groups the methods by what they do:

| Group | Methods |
|---|---|
| **ask** | `initializationResult()`, `supportedModels()`, `supportedCommands()`, `supportedAgents()`, `mcpServerStatus()`, `accountInfo()`, `getContextUsage()`, `readFile(path)` |
| **steer** | `setModel(model?)`, `setPermissionMode(mode)` (also `applyFlagSettings()`, `setMaxThinkingTokens()`: Concept 14) |
| **stop** | `interrupt()`, `backgroundTasks(toolUseId?)`, `stopTask(taskId)`, `close()` |

**Sending a prompt is not a control method.** It writes a user message to the input stream. The lab's `/call`
route accepts `method: "prompt"` only to keep one button bar, and the tab labels it as such.

## Step 2: Ask a session that has not said anything (Part A)

`GET /catalog` starts a session whose prompt never yields (`silent()`, as in Concept 25) and calls every "ask"
method. **No model call is made**, so it costs nothing:

| Call | Time | Answer (API key login) |
|---|---|---|
| `initializationResult()` | **1,225 ms** | 50 commands, 5 agents, 5 models, `output_style: "default"`, the account |
| `supportedModels()` | 0 ms | `default` (Opus 5.5), `opus[1m]`, `claude-fable-5-1`, `sonnet`, `haiku` |
| `supportedCommands()` | 0 ms | `/deep-research`, `/design`, … (the built-in and bundled skills) |
| `supportedAgents()` | 0 ms | `claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup` |
| `mcpServerStatus()` | 3 ms | `[]` (no MCP servers in this lab) |
| `accountInfo()` | 0 ms | `{ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }` |
| `getContextUsage()` | 36 ms | 8,288 tokens of 200,000 (the three tools) |
| `readFile("notes.txt")` | 28 ms | `{ contents: "Release checklist: …", absPath: "control-lab\work\notes.txt" }` |
| `readFile("../../package.json")` | 3 ms | **`null`** |

- The first call **waits for the session to start** (about 1.2 s). The lists after it take 0 ms: the SDK keeps the
  answer to its own `initialize` request, and `supportedModels()` & co. read from that cache.
- `readFile()` is a real round trip. It resolves the path against the cwd and applies the same rules as the `Read`
  tool. For a path outside the cwd, a missing file or a denied path it returns **`null`**, never an error.

## Step 3: The live session (Part B)

The server keeps sessions in a `Map`, so the browser can act on one across many HTTP requests:

```
POST /open  (SSE)   starts query({ prompt: input() }), sends "opened" { id }, then one event per message, until it ends
POST /call          { id, method, args } → runs ONE whitelisted method on that session → { ok, value | error, ms }
```

- `input()` is a **push queue**: `/call { method: "prompt" }` adds a message and wakes the generator. A prompt sent
  while a turn runs **waits in the queue** and starts when that turn ends.
- Every control call is also sent on the session's stream as a `call` event, so the tab shows each call **between
  the messages it caused** (orange rows).
- The whitelist is a table of `{ kind, args: zod schema, run }`. Unknown methods (`__proto__`, `toString`), extra
  keys and wrong types are refused before anything runs. At most 2 live sessions; a session idle for 10 minutes is
  closed; an ended session stays callable for one minute (Step 9 needs that).

Simplified from `baseOptions()` and `POST /open` in [server/concepts/26-query-control.ts](server/concepts/26-query-control.ts):

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  cwd: "control-lab/work",                    // notes.txt + slow.mjs
  tools: ["Read", "Write", "Bash"],
  settingSources: [],
  persistSession: false,
  thinking: { type: "disabled" },
  canUseTool: policy(...),                    // allows only `node slow.mjs N`
  env: { ...processEnvWithoutClaude, CLAUDE_CONFIG_DIR: "control-lab/config", CLAUDE_CODE_TMPDIR: "control-lab/tmp" },
};
```

`slow.mjs` prints `tick i/N` once per second. It is the slow command to interrupt, background and stop. A plain
`sleep 30` does not work: the Bash tool refuses it (*"Blocked: standalone sleep 30. … use run_in_background"*).

The scenarios are lists of steps that the **browser** runs against the same console: `{ prompt }`, `{ call, args }`,
or `{ wait: "result" | "toolUse" | "taskStarted" | "taskEnded" | "ended" | ms }`. A wait also matches an event that
arrived before it started waiting (after the last action), so fast replies are never missed.

## Step 4: `setModel()` between turns (scenario 1)

```
prompt  Reply with one word: alpha
init    model: claude-haiku-4-5-20251001
result  "alpha"
q.setModel({"model":"sonnet"})  → undefined
user    <local-command-stdout>Set model to `sonnet (claude-sonnet-5)`</local-command-stdout>
init    model: claude-sonnet-5
result  "beta"
q.setModel(haiku) …
result  "gamma … I replied with "alpha" and "beta" before."
```

- The change applies from the **next request**. The session, its history and its cost counter stay the same.
- It shows up in the stream as a **user message** with `<local-command-stdout>`, just like `/model` in the terminal.
- Each turn starts with a new `system/init`, and its `model` is the one in use. Read the model there, or in each
  `assistant` message's `message.model`.
- `setModel()` with **no argument** does not mean "the model I started with". It means **Claude Code's default
  model** (Opus 5.5 here). In the probe that turn cost 8× the Haiku turn. The tab labels that choice "pricier".
- Scenario 1 cost $0.026, mostly the Sonnet turn.

## Step 5: `setPermissionMode()` (scenario 2 and `dontAsk`)

The same request, *"Use the Write tool to create a.txt"*, in different modes:

| Mode | What happened | `canUseTool` called? |
|---|---|---|
| `default` | Denied by the lab's policy; the model apologised | **yes** |
| `acceptEdits` | `a.txt` written; `readFile("a.txt")` → `"hello"` | **no**: edits are pre-approved |
| `plan` | The model wrote a **plan** to `control-lab/config/plans/….md` and no `b.txt` (`readFile` → `null`) | no |
| `dontAsk` | Write denied, then Bash denied, even `node slow.mjs 2` | **no**: anything not pre-approved is denied without asking |

- Each change emits **`system/status`** with `permissionMode`, and the next `system/init` repeats it.
- `dontAsk` is the opposite of what the name suggests to some people: it does not *allow* without asking, it
  *denies* without asking. Only rules in `allowedTools` / settings get through. `canUseTool` is skipped.
- `bypassPermissions` also needs `allowDangerouslySkipPermissions: true` in the options, so the lab leaves it out.

## Step 6: `interrupt()` (scenarios 3 and 6)

Scenario 3: `node slow.mjs 30` runs; 3 s later, `interrupt()`:

```
q.interrupt()  → { still_queued: [] }   8 ms
tool_result    is_error: "The user doesn't want to proceed with this tool use. The tool use was rejected …"
result         error_during_execution · stop_reason tool_use
prompt         In one line: did the command finish?
result         "No, the command was blocked and didn't run."
```

- It ends the **current turn**, not the session. The next prompt is answered by the same session with the same
  history. (Concept 10 showed it from a hook; here it is a plain method call.)
- The model is told the *user* rejected the tool. It does not know the command ran for 3 seconds.
- The answer is an **interrupt receipt**: `still_queued` lists async user messages that will still run.

Scenario 6 sends a second prompt while the first turn is still running, then interrupts. `still_queued` is `[]`,
and the queued prompt **runs right after** the interrupted turn (*"queued"*). `interrupt()` does not clear what you
already wrote to the input stream. To drop a message, don't send it yet: hold it in your own queue.

## Step 7: Tasks: `backgroundTasks()` and `stopTask()` (scenarios 4 and 5)

A Bash command or a subagent that runs a while is a **task**. The session reports tasks with system messages:

| Message | When |
|---|---|
| `task_started` | the task is registered: `task_id`, `tool_use_id`, `is_backgrounded`, `task_type: "local_bash"` |
| `task_updated` | a patch: `{ is_backgrounded: true }`, `{ status: "killed" }`, `{ status: "completed" }` |
| `task_notification` | it settled: `status: "completed" | "failed" | "stopped"` |

**`backgroundTasks(toolUseId?)`** is Ctrl+B in the terminal: a foreground command stops blocking the turn.

The first try seemed to do nothing, and a probe found why: a foreground command becomes a task only about **3 s after
it starts**. Before that there is nothing to background:

| Called | Returns | Effect |
|---|---|---|
| after 1 s, with `toolUseId` | `false` | none: no task matched yet |
| after 3 s, no argument | `true` | none: it is only `false` when a `toolUseId` matches nothing |
| after `task_started` | `true` | `task_updated { is_backgrounded: true }`, the tool returns at once |

So scenario 4 waits for `task_started`, then calls `backgroundTasks(lastToolUse)`:

```
task_started   node slow.mjs 15 · is_backgrounded: false
task_updated   { is_backgrounded: true }
q.backgroundTasks({"toolUseId":"toolu_…"})  → true
tool_result    Command was manually backgrounded by user with ID: brfeyf7z5. Output is being written to: control-lab\tmp\…
result         success  (the turn ended while the command kept running)
task_updated   { status: "completed" }                       ~12 s later
task_notification  status: completed
init  →  assistant "The script completed …"  →  result      ← a NEW turn, with no prompt
```

The last three lines matter: when a background task ends, Claude Code **starts a turn by itself** to tell the model.
Your loop gets an extra `init` … `result` that no prompt caused, and it is billed like any other turn. Keep reading
the iterator between prompts, or you will miss it.

**`stopTask(taskId)`** kills a task. Scenario 5 starts `node slow.mjs 60` with `run_in_background: true` (the turn
ends in 4 s), then:

```
task_updated       { status: "killed" }
task_notification  status: stopped
q.stopTask({"taskId":"byg61vklb"})  → undefined
```

No model call is needed. `stopTask("nope")` also resolves to `undefined`: an unknown id is not an error.

**Where the output goes.** A background command writes to `<tmp>/claude/<cwd>/<session>/tasks/<id>.output`. The
first test run put it in the user's `%TEMP%\claude\…`. The lab now sets `CLAUDE_CODE_TMPDIR=control-lab/tmp`, and a
new run left nothing in the system temp folder.

## Step 8: `close()` (scenario 7)

`close()` during `node slow.mjs 20`:

```
q.close()  → undefined   0 ms
session ended  the message iterator finished        (2 s later, no error, no result message)
q.accountInfo()        → { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", … }   still answers
q.setModel("sonnet")   ✗ Error: Query closed before response received
```

- `close()` kills the process. The `for await` loop **just ends**: no exception and no `result`. If your code needs
  to know why, remember that you closed it.
- Methods that read the SDK's cache (`accountInfo()`, `supportedModels()`…) keep answering. Methods that need the
  process reject.
- Compare: `interrupt()` ends a turn, `close()` ends the session, and aborting `abortController` (the tab's
  **Disconnect**) ends it too, through the SDK's abort path.

## Step 9: What the tests changed

| Found | Change |
|---|---|
| `sleep 30` refused by the Bash tool | `slow.mjs`, allowed by `canUseTool` as `node slow.mjs N` (N ≤ 60) |
| `backgroundTasks()` did nothing after 3 s | Scenario 4 waits for `task_started` and passes the `toolUseId` |
| The background task's end started a new turn | Scenario 4 waits for that extra `result`; the doc says why |
| Background output in the real `%TEMP%` | `CLAUDE_CODE_TMPDIR=control-lab/tmp`; the test folder was deleted |
| Calls after `close()` were written to a finished SSE response and never shown | `/call` streams only while the session lives, returns `streamed: false` after, and the tab adds the row itself |
| `setModel()` on a **string** prompt did not throw, but the model did not change either | Documented only: use streaming input for control methods |

## Step 10: The costs

| Scenario | Cost (measured) |
|---|---|
| 1 · Swap the model (one Sonnet turn) | $0.026 |
| 2 · Flip the permission mode | $0.012 |
| 3 · Interrupt | $0.004 |
| 4 · Background (includes the automatic turn) | $0.006 |
| 5 · Stop a task | $0.004 |
| 6 · Interrupt with a queued prompt | $0.003 |
| 7 · `close()` | under $0.002 |
| Part A | $0 |

## Step 11: Every method of Query (Part C)

| Method | Use it to | Where |
|---|---|---|
| `interrupt()` | Stop the current turn (a Stop button) | B · 3, 6 · Concept 10 |
| `close()` | End the session and free the process | B · 7 |
| `setModel(model?)` | Cheap model for easy turns, a bigger one when needed | B · 1 · Concepts 12, 14 |
| `setPermissionMode(mode)` | "Approve edits from now on", plan first, lock down | B · 2 · Concept 12 |
| `backgroundTasks(toolUseId?)` | Let a long command run while the conversation goes on | B · 4 |
| `stopTask(taskId)` | Kill a background command or subagent | B · 5 |
| `initializationResult()` and `supported*()` | Build menus: models, slash commands, agents | A · Concepts 11, 14, 23 |
| `accountInfo()` | Show who is billed | A |
| `mcpServerStatus()` | Show MCP health | A · Concepts 13, 23, 25 |
| `getContextUsage()` | A context meter | A · Concepts 15, 22, 25 |
| `readFile()` | Show a file as the session sees it (with its permissions) | A · B · 2 |
| `applyFlagSettings()` / `setMaxThinkingTokens()` | Effort and thinking mid-session | Concept 14 |
| `setMcpServers()` / `toggleMcpServer()` / `reconnectMcpServer()` | Change MCP servers mid-session | Concept 13 |
| `rewindFiles()` | Undo file edits back to a user message | Concept 17 |
| `reloadPlugins()` / `reloadSkills()` / `reloadOutputStyles()` | Pick up files changed on disk | Concept 23 |
| `streamInput()` | Feed user messages (the prompt iterable does it for you) | Concept 12 |
| `updateSettings()`, `setMcpPermissionModeOverride()`, `seedReadState()`, `reinitialize()`, `readMcpResource()`, `usage_EXPERIMENTAL…()` | Niche or unstable | not in the lab |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/26-query-control.ts](server/concepts/26-query-control.ts) and
[src/concepts/Concept26QueryControl.tsx](src/concepts/Concept26QueryControl.tsx). The tab's **code** buttons show
the `methods`, `canUseTool`, `options` and `messages` regions.

### Step 1: Read the `Query` interface

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `interface Query`. It lists every method of
Part C with its return type. Then search for `SDKTaskStartedMessage`, `task_updated`, `task_notification` and
`SDKStatusMessage`: these are the messages the methods cause. The types do not say **when** a method works, so each
one was first called from a small script on a live session (that is how the 3-second delay of
`backgroundTasks()` in Step 7 of the concept was found).

### Step 2: The lab folder and the slow command

```ts
const LAB = path.resolve("control-lab");
const WORK = path.join(LAB, "work");
const CONFIG_DIR = path.join(LAB, "config");
const TMP_DIR = path.join(LAB, "tmp");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [WORK, CONFIG_DIR, TMP_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(WORK, "notes.txt"), "Release checklist: tag, build, smoke test, announce.\n");
```

- The folder is deleted and rebuilt each time the server starts, so every run begins the same way.
- The same code then writes `slow.mjs` into `work/`: the command that prints `tick i/N` once per second.
- `CONFIG_DIR` and `TMP_DIR` are passed to Claude Code in the options (next step), so plan files and background
  output stay inside the lab.

### Step 3: The policy and the options

```ts
function policy(onDecision: (d: { tool: string; input: unknown; allowed: boolean }) => void): CanUseTool {
  return async (tool, input) => {
    const allowed = tool === "Bash" && /^node slow\.mjs ([1-9]|[1-5]\d|60)$/.test(String(input.command ?? "").trim());
    onDecision({ tool, input, allowed });
    return allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Denied by the lab's canUseTool: only `node slow.mjs N` (N up to 60) is allowed." };
  };
}
```

- Only `node slow.mjs N` with N from 1 to 60 is allowed. So the Write of scenario 2 is denied in `default` mode.
- `onDecision` is a callback: the live session uses it to send a `canUseTool` event to the browser. That is how
  you can count the `canUseTool` rows (or see that there are none in `acceptEdits`).

`baseOptions(extra)` builds the options shown in Step 3 of the concept. It removes every `CLAUDE*` variable from the
environment, sets `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TMPDIR`, and adds `extra` (the `abortController` and the
policy) at the end.

### Step 4: The method whitelist

The browser sends a method **name**. The server never calls `q[name]` directly. It looks the name up in a table:

```ts
type Control = { kind: "ask" | "steer" | "stop"; args?: z.ZodType; run: (q: Query, args: any) => Promise<unknown> | unknown };

const MODELS = [MODEL, "sonnet", "default"] as const; // "default" -> setModel(undefined): Claude Code's default model
const MODES = ["default", "acceptEdits", "plan", "dontAsk"] as const; // bypassPermissions needs allowDangerouslySkipPermissions

const CONTROLS: Record<string, Control> = {
  // …
  setModel: {
    kind: "steer",
    args: z.object({ model: z.enum(MODELS) }).strict(),
    run: (q, { model }) => q.setModel(model === "default" ? undefined : model),
  },
  // …
  stopTask: { kind: "stop", args: z.object({ taskId: z.string().min(1).max(100) }).strict(), run: (q, { taskId }) => q.stopTask(taskId) },
  close: { kind: "stop", run: (q) => q.close() },
};
```

- Each entry has a zod schema for its arguments. `.strict()` refuses extra keys.
- `"default"` in the model list becomes `setModel(undefined)`: that is the "pricier" choice of Step 4 of the concept.
- Some `run` functions cut big answers down (for example, `supportedCommands()` returns only the names). The call
  itself is the real one.

`callControl()` runs one entry. It never throws, because the error is part of what the tab shows:

```ts
async function callControl(q: Query, method: string, rawArgs: unknown) {
  const control = Object.hasOwn(CONTROLS, method) ? CONTROLS[method] : undefined;
  if (!control) return { ok: false, error: `Unknown method. Allowed: ${Object.keys(CONTROLS).join(", ")}.`, ms: 0 };
  const parsed = (control.args ?? z.object({}).strict()).safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Bad arguments for ${method}: ${parsed.error.issues.map((i) => i.message).join("; ")}`, ms: 0 };
  const t = Date.now();
  try {
    const value = await control.run(q, parsed.data);
    return { ok: true, value: value === undefined ? "undefined" : value, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: String(err), ms: Date.now() - t };
  }
}
```

- `Object.hasOwn` is what refuses `__proto__` and `toString`: they exist on every object, but not as own keys.
- A method with no `args` accepts only `{}`.
- `ms` is the time of the round trip. Part A shows it for each call.

### Step 5: `GET /catalog` (Part A)

```ts
concept26.get("/catalog", async (_req, res) => {
  const stop = new AbortController();
  const q = query({ prompt: silent(stop.signal), options: baseOptions({ abortController: stop, canUseTool: policy(() => {}) }) });
  // … the list of [method, args] pairs
  const out = [];
  try {
    for (const [method, args] of calls) out.push({ method, args, ...(await callControl(q, method, args)) });
  } finally {
    stop.abort();
    q.close();
  }
  res.json(out);
});
```

- `silent()` is a prompt generator that waits for the abort and never yields. So the session starts, answers the
  control requests, and makes no model call.
- The calls run **one after the other**, so the first one pays the start-up time and the others show 0 ms.
- `finally` always ends the session, even when a call fails.

### Step 6: `POST /open`, the live session

The session lives in a `Map`, so later HTTP requests can find it by id. The prompt is a push queue:

```ts
const queue: SDKUserMessage[] = [];
let wake: (() => void) | undefined;
async function* input(): AsyncGenerator<SDKUserMessage> {
  while (!abort.signal.aborted) {
    while (queue.length) yield queue.shift()!;
    await new Promise<void>((resolve) => (wake = resolve));
  }
}
```

- `live.push(text)` adds a user message to `queue` and calls `wake()`. The generator yields it, and the SDK writes
  it to Claude Code.
- `abort` comes from `openSse()`. When the browser disconnects, it aborts, the generator stops, and the session ends.

Then the route reads the messages in the background and turns each one into a small event:

```ts
(async () => {
  try {
    for await (const msg of q) relay(msg, emit);
    emit("ended", { how: "the message iterator finished" });
  } catch (err) {
    emit("ended", { how: abort.signal.aborted ? "the browser disconnected" : `the iterator threw: ${String(err)}` });
  } finally {
    live.ended = true;
    clearTimeout(idle);
    console.log(`[c26] session ${id} ended`);
    setTimeout(() => sessions.delete(id), KEEP_ENDED_MS);
    send("done", {});
    res.end();
  }
})();
```

- The `ended` event says **how** it ended. After `close()` it is "the message iterator finished", with no error
  (Step 8 of the concept).
- `setTimeout(… KEEP_ENDED_MS)` keeps the session in the map for one more minute, so you can still call its methods
  after `close()`.
- `relay()` (the `messages` region) sends `init`, `status`, `task`, `assistant`, `toolUse`, `local`, `toolResult`
  and `result`. A user message with **string** content is the `<local-command-stdout>` of `setModel()`.

Before all this, the route refuses a third session (`MAX_SESSIONS = 2`), and `touch()` resets a 10-minute idle timer
that closes the session.

### Step 7: `POST /call`

The body is checked first, with a strict zod schema:

```ts
const CallBody = z
  .object({
    id: z.string().max(40).nullable(), // null: the tab has no session yet (a 404 below)
    method: z.string().min(1).max(40),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
```

Then the route handles a prompt, or runs one method:

```ts
if (method === "prompt") {
  const text = (args as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 2000) return res.status(400).json({ ok: false, error: "Send args.text (1 to 2000 characters)." });
  if (live.ended) return res.json({ ok: false, error: "The session has ended: nothing reads the input stream any more.", ms: 0 });
  live.push(text);
  live.send("call", { method, args: { text }, ok: true, value: "queued in the input stream", ms: 0 });
  return res.json({ ok: true, value: "queued in the input stream", ms: 0 });
}
const out = await callControl(live.q, method, args);
// After the session ended its event stream is closed, so the browser adds this call to its list itself.
const streamed = !live.ended;
if (streamed) live.send("call", { method, args: args ?? {}, ...out });
res.json({ ...out, streamed });
```

- A body that does not match `CallBody` (a missing method, an extra key, `args` that is not an object) is a 400.
  An unknown session id is a 404. The method's own arguments are checked later, by `callControl()`.
- `"prompt"` is handled first, because it is not a control method: it only writes to the queue.
- Every call is also sent on the session's SSE stream as a `call` event. That is why the orange rows appear
  **between** the messages they caused.
- `streamed: false` is the fix from Step 9 of the concept: after the session ended, the browser draws the row itself.

### Step 8: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept26 } from "./concepts/26-query-control.js";
// …
app.use("/api/c26", concept26);
```

### Step 9: The React tab

`open()` starts the SSE stream and resolves with the session id. `call()` posts one method:

```tsx
async function call(method: string, args?: Record<string, unknown>): Promise<CallOut> {
  const r = await fetch("/api/c26/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: idRef.current, method, args }) });
  const out = (await r.json()) as CallOut & { streamed?: boolean };
  if (!r.ok) setError(out.error ?? `HTTP ${r.status}`);
  else if (out.streamed === false) onEvent("call", { method, args: args ?? {}, ...out }); // the session's stream has ended
  return out;
}
```

The buttons of Part B call `call()` directly. A scenario is a list of steps that the browser runs with the same
functions:

```tsx
for (const step of s.steps) {
  if ("wait" in step) {
    if (typeof step.wait === "number") await new Promise((r) => setTimeout(r, step.wait as number));
    else await waitFor(step.wait, matches[step.wait]);
    continue;
  }
  cursor.current = evRef.current.length;
  if ("prompt" in step) await call("prompt", { text: step.prompt });
  else await call(step.call, typeof step.args === "function" ? step.args(ctx()) : step.args);
}
```

- `cursor` marks where the last action happened. `waitFor()` looks for a matching event **after the cursor**,
  including one that already arrived, so a fast reply is never missed.
- `args` can be a function of `ctx()`: scenario 4 passes the last `tool_use` id to `backgroundTasks()`, and
  scenario 5 passes the last `task_started` id to `stopTask()`.
- `MODELS` and `MODES` are copied at the top of the file. They must match the server's lists, or the zod check refuses
  the call.
- Leaving the tab aborts the stream, and the server's `abortController` ends the session.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 26, title: "Query control methods", Component: Concept26QueryControl },
```

### Step 10: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 26. Part A fills in by itself: the first row takes about a second, the lists 0 ms, and
   `readFile("../../package.json")` returns `null`.
3. Run **1 · Swap the model**: look for the `user (local command)` row and the new `system/init` under it.
4. Run **7 · close() mid-turn** and check that `accountInfo()` answers after the end and `setModel()` fails.

## Things to try

1. **A**: compare the times: 1,225 ms for the first call, 0 ms for the lists, a real round trip for `readFile`.
2. **B · 1**: find the `<local-command-stdout>` row, then the `system/init` with the new model under it.
3. **B · 2**: count the `canUseTool` rows: one in `default`, none in `acceptEdits`. Open the plan file path in the
   `plan` turn's tool result.
4. **B · 3**: look at the model's answer after the interrupt. It thinks the command never ran.
5. **B · 4**: watch the last `init` → `result`: nobody sent that prompt.
6. **By hand**: open a session, send `Run the Bash command node slow.mjs 20`, and press **backgroundTasks()** at once,
   then again after the teal `task_started` row.
7. **By hand**: `setPermissionMode(dontAsk)`, then ask for `node slow.mjs 2`. `canUseTool` would allow it, but it
   is never asked.
8. **By hand**: `close()`, then press every "ask" button. Which ones still answer?
