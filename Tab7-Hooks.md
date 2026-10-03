# Concept 7: Hooks with `PreToolUse` / `PostToolUse`, step by step

This file explains how Concept 7 (**Hooks**) was added to the Claude Agent SDK Lab.
It builds on Concept 3 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)) for the `sandbox/` folder and on Concept 4
([Tab4-Permissions.md](Tab4-Permissions.md)) for the idea of deciding a tool call in code.

**Goal:** run your own functions at fixed points of the agent loop: **before** a tool call (to allow, deny or rewrite
it) and **after** it (to add feedback for the model, or to stop the run).

| Concept | Topic | Route |
|---|---|---|
| 7 | Hooks: `PreToolUse` / `PostToolUse` | `/api/c7/query` |

## Step 1: Where hooks live

Hooks are set in `Options.hooks`: a map from an **event name** to a list of **matchers**. Each matcher has a regex
`matcher` (tested against the tool name) and a list of callbacks. A simplified example (the lab builds this object
with `add()`, see "How it was built" below):

```ts
const options: Options = {
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit|Bash", hooks: [guard] }], // before the tool runs
    PostToolUse: [{ hooks: [audit] }],                            // after it ran; no matcher = every tool
  },
};
```

A callback is an async function. A minimal example:

```ts
const myHook: HookCallback = async (input, toolUseID, { signal }) => {
  // input.hook_event_name tells you which event fired
  return {}; // HookJSONOutput
};
```

`input` depends on the event:

| Event | Main fields of `input` |
|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `session_id`, `cwd`, `permission_mode` |
| `PostToolUse` | the same plus `tool_response` and `duration_ms` |

The SDK knows many more events (`UserPromptSubmit`, `Stop`, `SessionStart`, `SubagentStop`, ...). This concept only
uses the two tool events.

## Step 2: What a hook can answer

| Return value | Effect |
|---|---|
| `{}` | No opinion. The call continues exactly as before. |
| `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" \| "deny" \| "ask", permissionDecisionReason } }` | Decides the call before the permission system does. The model reads the reason. |
| `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }` | The tool runs with `updatedInput` instead of the model's input. |
| `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }` | Extra text the model reads together with the tool result. |
| `{ continue: false, stopReason }` | Ends the whole run. `result.terminal_reason` is `"hook_stopped"`. |

When several hooks answer the same call, they all run, and **deny wins over ask, and ask wins over allow**.

## Step 3: Hooks vs `canUseTool`

Both can decide a tool call in code, so why have two?

| | `canUseTool` (Concept 4) | `PreToolUse` hook |
|---|---|---|
| When it runs | Only for calls that would "ask" | For **every** matching call, even read-only ones |
| Filtering | You check `toolName` yourself | `matcher` regex |
| After the call | Nothing | `PostToolUse` sees the result |
| How many | One function | Many, combined by precedence |

## Step 4: Server route

**File:** [server/concepts/07-hooks.ts](server/concepts/07-hooks.ts)

The browser sends the names of the hooks to turn on (the body is checked with zod first). The server builds
`options.hooks` from them. There are five hooks,
and each one shows a different kind of answer:

| Hook | Registered on | Returns |
|---|---|---|
| `audit` | `PreToolUse` + `PostToolUse`, every tool | `{}`: only observes |
| `guard` | `PreToolUse`, matcher `Write\|Edit\|Bash` | `allow`, or `deny` for paths outside `sandbox/` and `rm` commands |
| `stamp` | `PreToolUse`, matcher `Write` | `updatedInput`: adds a header comment to `.md` files |
| `lint` | `PostToolUse`, matcher `Write` | `additionalContext` when a `.md` file has no `Source:` line |
| `limit` | `PreToolUse`, every tool | `continue: false` + `deny` from the 4th tool call on |

The run uses `permissionMode: "default"` with no `canUseTool` and no `allowedTools`. So the **only** thing that can let
`Write` run is a hook that says `allow`, like `guard`.

The guard is Concept 4's policy, written as a hook:

```ts
const guard: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as Record<string, unknown>;
  // … decide(), then the sandbox/ and delete-command checks, which return decide("deny", …)
  return decide("allow", "Guard hook: inside sandbox/ and not destructive.");
};
```

`stamp` shows `updatedInput`. It only takes effect together with `permissionDecision: "allow"`:

```ts
return {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...toolInput, content: `${STAMP}\n${toolInput.content}` },
  },
};
```

`lint` shows that `PostToolUse` can't undo a call, but it can talk to the model:

```ts
return {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `Lint hook: ${path.basename(toolInput.file_path)} has no "Source: <file>" line. Every Markdown file must end with one naming the file it was based on. Rewrite the file with it.`,
  },
};
```

`limit` shows `continue: false`. **Careful:** in this SDK version, `continue: false` stops the loop *after* the
current tool call. The call itself still runs, and so does any other call the model made in the same turn. To also block
it, the hook denies it:

```ts
return {
  continue: false,
  stopReason: reason,
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
};
```

Every hook is wrapped by `traced()`, which streams a `hook` SSE event with the `input` and the `output`, so the UI can
show each call. Functions can't be serialized, so the echoed `options` shows `[Function guard]` under each matcher.

A small `GET /api/c7/file?path=...` route returns the content of one sandbox file, so you can see what `stamp` and
`lint` changed.

## Step 5: Browser flow

**File:** [src/concepts/Concept07Hooks.tsx](src/concepts/Concept07Hooks.tsx)

1. Pick a scenario, or tick hooks and tools yourself.
2. **Run query() with hooks** posts `{ prompt, tools, hooks }` to `/api/c7/query`.
3. Each `hook` event is added to the **hook calls** card: event, hook name, tool, input, and the answer (`allow`,
   `deny`, `continue: false`, or `{}`).
4. When the run ends, the file list reloads. Click a file to see its content.
5. The `result` card shows `terminal_reason` and `permission_denials`.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/07-hooks.ts](server/concepts/07-hooks.ts) and
[src/concepts/Concept07Hooks.tsx](src/concepts/Concept07Hooks.tsx). Steps 1 to 4 above explain what each hook
answers. Here we look at how the lab wires them together.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `HookCallback`, `HookCallbackMatcher`,
`HookEvent`, `HookJSONOutput`, `SyncHookJSONOutput`, `PreToolUseHookInput` and `PostToolUseHookInput`. The first
three are imported by the server file. `HookCallbackMatcher` also has an optional `timeout` (in seconds), which
this tab does not use.

### Step 2: The constants, the body check, and the sandbox from Concept 3

```ts
import { SANDBOX } from "./03-tools.js";
// …
const HOOK_NAMES = ["audit", "guard", "stamp", "lint", "limit"] as const;
type HookName = (typeof HOOK_NAMES)[number];
// …
// Exactly what the tab sends: its five tools, the hook names, and a model and maxTurns.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    model: z.string().regex(/^claude-[a-z0-9.-]+$/, "a Claude model id").optional(),
    tools: z.array(z.enum(["Read", "Glob", "Write", "Edit", "Bash"])).max(5),
    hooks: z.array(z.enum(HOOK_NAMES)).max(5),
    maxTurns: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const STAMP = "<!-- written by the Agent SDK Lab, stamped by a PreToolUse hook -->";
const MAX_TOOL_CALLS = 3;
```

- The route starts with `Body.safeParse(req.body ?? {})`. A bad body (an unknown tool, an unknown hook name, an
  empty prompt, an extra key) gets one `error` event with a `Bad request: …` message, then `done`. The SDK is never
  called. This is the same pattern as Concept 34.
- `HOOK_NAMES` is written once: the `HookName` type and the zod enum both come from it.
- The tab does not have its own folder. It reuses `sandbox/` from Concept 3, and the browser uses Concept 3's
  `GET /api/c3/files` and `POST /api/c3/reset` routes to list and reset it.
- The browser only sends hook **names**. It can't send functions, so the server keeps the five hooks and picks
  them by name.

### Step 3: Create the hooks inside the route

All five hooks are created **inside** `concept07.post("/query", …)`, once per request. Each one is wrapped by
`traced()`:

```ts
const traced =
  (name: HookName, fn: HookCallback): HookCallback =>
  async (input, toolUseID, opts) => {
    const output = await fn(input, toolUseID, opts);
    send("hook", { name, input, output, at: Date.now() });
    return output;
  };
```

- `send` is the SSE function of **this** request, so each hook call reaches the right browser tab.
- The event is sent after the hook has answered, so it carries both the `input` and the `output`.
- Because the hooks are new for every request, `limit` can keep its counter in a simple `let toolCalls = 0`.
  Two runs at the same time do not share it.

### Step 4: The guard's path check

Step 4 above cut this part of `guard`. It is the same check as Concept 4:

```ts
if (typeof toolInput.file_path === "string") {
  const rel = path.relative(SANDBOX, path.resolve(SANDBOX, toolInput.file_path));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return decide("deny", `Guard hook: ${input.tool_name} is only allowed inside sandbox/.`);
  }
}
if (input.tool_name === "Bash" && /\b(rm|del|rmdir|Remove-Item)\b/.test(String(toolInput.command))) {
  return decide("deny", "Guard hook: commands that delete files are not allowed.");
}
return decide("allow", "Guard hook: inside sandbox/ and not destructive.");
```

- The path is resolved against `SANDBOX` first, so both `notes.txt` and an absolute path are checked the same way.
- `path.isAbsolute(rel)` catches a path on another drive on Windows, where `path.relative()` returns an absolute
  path.
- The `Bash` check is only a regex on the command. It is a teaching example, not a real security boundary.

### Step 5: Build `options.hooks` from the checkboxes

```ts
const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { PreToolUse: [], PostToolUse: [] };
const described: Record<string, { matcher?: string; hooks: string[] }[]> = { PreToolUse: [], PostToolUse: [] };
const add = (event: "PreToolUse" | "PostToolUse", matcher: string | undefined, name: HookName, fn: HookCallback) => {
  hooks[event]!.push({ ...(matcher ? { matcher } : {}), hooks: [traced(name, fn)] });
  described[event].push({ ...(matcher ? { matcher } : {}), hooks: [`[Function ${name}]`] });
};
if (enabled.has("audit")) add("PreToolUse", undefined, "audit", audit);
if (enabled.has("audit")) add("PostToolUse", undefined, "audit", audit);
if (enabled.has("guard")) add("PreToolUse", "Write|Edit|Bash", "guard", guard);
// … stamp, lint and limit the same way
```

- `add()` fills two maps at once: `hooks` (the real functions, for `query()`) and `described` (strings, for the
  `options` SSE event). That is where the `[Function guard]` text of the options card comes from.
- `audit` is added twice, once per event. So with `audit` on you see two hook calls for each tool call.
- The options then use `permissionMode: "default"`, `cwd: SANDBOX`, `settingSources: []` and
  `strictMcpConfig: true`. `model` and `maxTurns` are only set when the body has them.
- The route ends like the others: `send("options", { ...options, hooks: described })`, then `pipe(query(…))`.

### Step 6: A route to read one sandbox file

```ts
concept07.get("/file", async (req, res) => {
  const full = path.resolve(SANDBOX, String(req.query.path));
  const rel = path.relative(SANDBOX, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return void res.status(400).send("Outside sandbox/.");
  res.type("text/plain").send(await readFile(full, "utf8").catch(() => "(file not found)"));
});
```

- It uses the same path check as `guard`, so the browser can't read files outside `sandbox/`.
- This is how you see the `STAMP` line that `stamp` added to `summary.md`.

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept07 } from "./concepts/07-hooks.js";
// …
app.use("/api/c7", concept07);
```

### Step 8: The React tab

The tab has a `scenarios` list: each one is a `Form` with a prompt, the tools and the hook names. A scenario
button only fills the form. `run()` sends it:

```tsx
async function run() {
  // … clear messages, calls, options, opened file and error
  setRunning(true);
  try {
    await streamPost("/api/c7/query", { ...form, model: "claude-haiku-4-5-20251001", maxTurns: 10 }, (event, data) => {
      if (event === "options") setSentOptions(data);
      if (event === "message") setMessages((prev) => [...prev, data]);
      if (event === "hook") setCalls((prev) => [...prev, data]);
      if (event === "error") setError(data.message);
    });
  } finally {
    setRunning(false);
    loadFiles();
  }
}
```

- Each `hook` event becomes one row of the **hook calls** card. `loadFiles()` in `finally` refreshes the sandbox
  list, even when the run fails.
- The `hookInfo` table at the top of the file must match the hooks of the server. A comment says so; nothing
  checks it.

`HookRow` reads the hook's answer to choose the tags:

```tsx
const decision = output.hookSpecificOutput?.permissionDecision;
const stopped = output.continue === false;
const silent = Object.keys(output).length === 0;
```

A `deny` or a `continue: false` makes the row red. An empty `{}` is shown as "no opinion, the call continues".

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 7, title: "Hooks", Component: Concept07Hooks },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 7, click **Reset sandbox/**, then run **1 · No hooks**: the `Write` call is denied,
   and the `result` card shows it under `permission_denials`.
3. Run **3 · Guard allows**: the hook calls card shows `guard` → `allow`, and `summary.md` appears in the file list.
4. Run **7 · Stop the run**: `terminal_reason` is `hook_stopped`.

## Things to try in Concept 7

1. **1 · No hooks**: Write is denied, as in Concept 3. Then run **3 · Guard allows**: same prompt, and now it works.
2. **2 · Observe everything**: `audit` fires for `Read` and `Glob`, which `canUseTool` never sees. Compare `duration_ms`.
3. **4 · Guard denies**: find the `permissionDecisionReason` text inside the `tool_result` in the raw stream.
4. **5 · Rewrite the input**: open `summary.md`. The first line is not in the model's `tool_use` input.
5. **6 · Feedback after a call**: count the `Write` calls. The second one comes from the `lint` feedback.
6. **7 · Stop the run**: only `a.txt` to `c.txt` exist, and `terminal_reason` is `hook_stopped`. Untick `guard` to see
   that `limit` alone does not grant permission.
7. Tick `guard` and `stamp` together and ask for `../outside.md`: `guard` says `deny`, `stamp` says `allow`, and
   `deny` wins.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/07-hooks.ts` | New route that checks the body with zod and builds `options.hooks` from five example hooks. It imports `SANDBOX` from `server/concepts/03-tools.ts` |
| `server/concepts/03-tools.ts` | Not changed: the tab reuses Concept 3's `GET /api/c3/files` and `POST /api/c3/reset` to list and reset `sandbox/` |
| `server/index.ts` | Mounts the route on `/api/c7` |
| `src/concepts/Concept07Hooks.tsx` | Hooks UI with scenarios and a timeline of hook calls |
| `src/App.tsx` | Adds the Hooks tab |
| `src/styles.css` | Tags for `PreToolUse` / `PostToolUse` and clickable file names |
| `Tab7-Hooks.md` | This explanation |
