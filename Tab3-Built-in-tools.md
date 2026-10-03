# Concept 3: Built-in tools, step by step

This file explains how Concept 3 (**Built-in tools**) was added to the Claude Agent SDK Lab, in the order the work was done.
It builds on Concept 1 ([Tab1-query().md](<Tab1-query().md>)) and Concept 2 ([Tab2-Options.md](Tab2-Options.md)).

**Goal:** until now every run used `tools: []`, so the agent could only talk. Concept 3 lets it **act**, using
Claude Code's built-in tools, and shows the four options that decide what it may do:

| Option | Question it answers |
|---|---|
| `tools` | Which tools **exist** for the model? |
| `allowedTools` | Which of them run **without asking** for permission? |
| `permissionMode` | What happens to a call that is **not** pre-allowed? |
| `cwd` | **Where** does the agent work? |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/03-tools.ts` | **New**: the Concept 3 route, plus the `sandbox/` folder with reset and file listing |
| `server/index.ts` | Mount the new router on `/api/c3` |
| `src/concepts/Concept03Tools.tsx` | **New**: the Concept 3 tab |
| `src/App.tsx` | Add the tab to the navigation |
| `src/styles.css` | Scenario buttons, tools table, tool-call timeline |
| `.gitignore` | Ignore `sandbox/` (the server recreates it) |
| `Tab1-query().md` | Status table, project structure, Step 7 section |

---

## Step 1: Read the existing code

The patterns from Concepts 1 and 2 are reused unchanged: one Express `Router` per concept, `openSse()` with
`send("options", …)` to echo the options, and a React tab that derives its cards from the message list.

## Step 2: Read the options in the SDK's type definitions

The dependencies were installed (`npm install`, `npm rebuild esbuild`), then `sdk.d.ts` (version `0.3.281`) was searched:

```ts
tools?: string[] | { type: 'preset'; preset: 'claude_code' };  // [] = no built-in tools
allowedTools?: string[];     // "auto-allowed without prompting... To restrict which tools are available, use `tools`"
disallowedTools?: string[];  // removed from the model's context
permissionMode?: PermissionMode;
allowDangerouslySkipPermissions?: boolean;  // "Must be set to true when using 'bypassPermissions'"
cwd?: string;                // "Defaults to process.cwd()"

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

// In every result message:
permission_denials: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
```

There is also a `{ type: "system", subtype: "permission_denied" }` message, emitted when a call is refused.

**The key point from the types:** `tools` and `allowedTools` are different things. `tools` controls what the model
*can see*. `allowedTools` only controls what runs *without a permission check*. Putting a tool in `allowedTools`
does not make it available, and leaving it out does not hide it.

## Step 3: Give the agent a safe place to work

Tools like `Write` and `Bash` change files, so the agent must not run in the app's own folder by accident.
The server keeps a `sandbox/` folder, seeds it with two files (`notes.txt`, `data/tasks.json`) and exposes:

| Route | Purpose |
|---|---|
| `GET /api/c3/files` | List what is in `sandbox/` (to see what the agent changed) |
| `POST /api/c3/reset` | Delete `sandbox/` and write the seed files again |

The browser never sends a path. It sends a key (`"sandbox"` or `"project"`), and the server maps it to a folder.

## Step 4: Write the server route

**File:** [server/concepts/03-tools.ts](server/concepts/03-tools.ts)

```ts
const options: Options = {
  tools: body.toolsMode === "preset" ? { type: "preset", preset: "claude_code" } : body.tools,
  allowedTools: body.allowedTools,
  cwd: cwds[body.cwd] ?? SANDBOX,
  // …
  settingSources: [],
  strictMcpConfig: true,
};
if (body.permissionMode) options.permissionMode = body.permissionMode;
// bypassPermissions is refused unless you also opt in explicitly.
if (body.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
if (body.model) options.model = body.model;
if (body.maxTurns) options.maxTurns = body.maxTurns;

send("options", options);

const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
pipe(run);
```

`settingSources: []` and `strictMcpConfig: true` isolate the run: Step 7 explains why.

## Step 5: Write the React tab

**File:** [src/concepts/Concept03Tools.tsx](src/concepts/Concept03Tools.tsx)

**The form.** A table with one row per built-in tool and two checkboxes, "in `tools`" and "in `allowedTools`",
so you can see that they are separate lists. There is also a text field for **rules**, which are `allowedTools`
entries with a pattern, such as `Bash(ls:*)`, and selects for `permissionMode`, `cwd` and `maxTurns`.
Every run uses Haiku, because tool runs take several turns.

**Scenarios.** Seven buttons fill in the form. Each one changes one thing from the previous one, so you can compare runs.

**The tool-call timeline.** A tool call is spread over two messages. The `tool_use` block is in an `assistant`
message, and the matching `tool_result` block (with the same id) is in the next `user` message. The tab pairs them:

```ts
const toolResults = new Map<string, any>(
  messages
    .filter((m) => m.type === "user" && Array.isArray(m.message.content))
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_result")
    .map((b: any) => [b.tool_use_id, b]),
);
const toolCalls = messages
  .filter((m) => m.type === "assistant")
  .flatMap((m) => m.message.content)
  .filter((b: any) => b.type === "tool_use")
  .map((b: any) => ({ ...b, result: toolResults.get(b.id) }));
```

A refused call comes back as a `tool_result` with `is_error: true`. The tab shows it in yellow.

**Cards:** `sandbox/` on disk (refreshed after every run), the options sent, `system/init` (the tools that
actually exist, `permissionMode`, `cwd`), the tool calls, the answer, and the result with `permission_denials`.

## Step 6: Type-check and test

`npx tsc -p .` and `npx vite build` both succeeded. A small script then ran every scenario against the server
and printed the tool calls, the result and the sandbox files.

## Step 7: Fix what the test found: runs were not isolated

The first test run showed two surprises:

1. **Scenario 2 (Write, denied).** `Write` to `sandbox/summary.md` was denied, as expected. The agent then **wrote the
   file somewhere else**: a Claude Code scratchpad folder under `%TEMP%`, which the user settings on this machine allow.
   The answer said "Done!", but `sandbox/` was unchanged.
2. **Scenario 5 (plan).** The agent tried to call an MCP tool (`mcp__claude_ai_Claude_Docs__guide`) that was never
   in `tools`. It came from the MCP servers configured on this machine.

The cause is the same in both cases. When `settingSources` is omitted, the SDK loads **all** filesystem settings
(user `~/.claude/settings.json`, project, local), just like the CLI, including their permission rules, plugins and MCP servers.
The fix is two options:

```ts
settingSources: [],     // "Pass [] to disable filesystem settings (SDK isolation mode)"
strictMcpConfig: true,  // only the MCP servers passed in `mcpServers` (none here)
```

After the fix, scenario 2 stops and says it needs permission, and scenario 5 no longer sees the MCP tool.
Each run also became about **half as expensive** (≈ $0.01 instead of ≈ $0.02), because fewer tool definitions
and settings are sent to the model.

## Test results (after the fix)

| Scenario | Options | What happened |
|---|---|---|
| 1 · Read-only | `tools: [Read, Glob, Grep]` | `Glob` + `Read` ran without asking. `success`, no denials |
| 2 · Write, denied | `tools: [Read, Write]`, `permissionMode: default` | `Read` ok, `Write` → `permission_denied`. `permission_denials: [Write]`, no file created |
| 3 · Write + allowedTools | same + `allowedTools: [Write]` | `summary.md` created |
| 4 · acceptEdits | `allowedTools: []`, `permissionMode: acceptEdits` | `summary.md` created |
| 5 · plan | `allowedTools: [Write]`, `permissionMode: plan` | `sandbox/` unchanged. The only write was the plan file in `~/.claude/plans/` |
| 6 · Bash rule + dontAsk | `tools: [Bash]`, `allowedTools: ["Bash(ls:*)"]`, `dontAsk` | `ls -la` ran, `touch hello.txt` was denied "because Claude Code is running in don't ask mode" |
| 7 · maxTurns: 2 | `tools: [Read, Glob]`, `maxTurns: 2` | `result/error_max_turns`, then the `error` event (as in Concept 2) |

---

## What to take away

1. **`tools` is what exists. `allowedTools` is what skips the permission check.** Compare `system/init.tools` with what you ticked.
2. **With no `canUseTool`, "ask" means "deny".** A headless `query()` has nobody to ask, so in `default` mode
   anything that needs permission is refused. You approve calls interactively in Concept 4.
3. **A denial is not an exception.** The run still ends in `result/success`. The model receives the refusal as a
   `tool_result` with `is_error: true` and carries on, sometimes by trying another way. Check `result.permission_denials`.
4. **`permissionMode` is a policy for everything that isn't pre-allowed:** `acceptEdits` approves file edits,
   `plan` changes nothing, and `dontAsk` denies without asking. `bypassPermissions` approves everything and needs
   `allowDangerouslySkipPermissions: true`.
5. **Rules narrow a tool.** `Bash(ls:*)` pre-approves `ls` commands only, not all of Bash.
6. **Isolate your runs.** Without `settingSources: []` and `strictMcpConfig: true`, the agent inherits the settings
   and MCP servers of whoever runs the server. A production app should always decide these explicitly.
7. **`cwd` is a starting point, not a jail.** Bash and absolute paths can reach other folders. That is why the
   sandbox is a convenience and `bypassPermissions` shows a warning.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/03-tools.ts](server/concepts/03-tools.ts) and
[src/concepts/Concept03Tools.tsx](src/concepts/Concept03Tools.tsx). The `sandbox/` folder built here is reused by many
later concepts.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `tools?:`, `allowedTools?:`,
`PermissionMode =`, `allowDangerouslySkipPermissions`, `cwd?:`, `permission_denials`, `settingSources` and
`strictMcpConfig`. Step 2 above shows what they say.

### Step 2: The sandbox folder

```ts
// The agent works in its own folder, so Write/Edit/Bash can't touch the app's source code.
// The browser only picks a key; it never sends a path.
export const SANDBOX = path.resolve("sandbox");
const cwds = { sandbox: SANDBOX, project: process.cwd() };
```

```ts
async function resetSandbox() {
  await rm(SANDBOX, { recursive: true, force: true });
  for (const [file, content] of Object.entries(SEED)) {
    const full = path.join(SANDBOX, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content + "\n");
  }
}
// …
// Create the sandbox the first time the server starts.
await stat(SANDBOX).catch(() => resetSandbox());
```

- `SEED` maps a relative path to its text: `notes.txt` (with one `TODO:` line) and `data/tasks.json` (three tasks).
- `SANDBOX` is **exported**. Concepts 4, 5, 7, 8 and others import it, so they all work in the same folder.
- The top-level `await` runs once, when `server/index.ts` imports this file. An existing `sandbox/` is kept.
- `listSandbox()` walks the folder and returns `{ path, bytes }` for each file, with `/` as separator on Windows too.

### Step 3: The route

```ts
// The form the tab sends. permissionMode is one of the tab's choices; bypassPermissions is allowed on purpose.
const Body = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(100).optional(),
    toolsMode: z.enum(["list", "preset"]),
    tools: z.array(z.string().regex(/^\w+$/, "a tool name")).max(50),
    allowedTools: z.array(z.string().trim().min(1).max(200)).max(50), // names or rules like Bash(ls:*)
    permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]).optional(),
    cwd: z.enum(["sandbox", "project"]), // a key of cwds, never a path
    maxTurns: z.number().int().positive().optional(),
  })
  .strict();

concept03.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
```

- The browser sends `cwd` as a key (`"sandbox"` or `"project"`), and the schema refuses anything else. The route then
  looks it up with `cwds[body.cwd] ?? SANDBOX`.
- `permissionMode` must be one of the five modes the tab offers. `bypassPermissions` is one of them on purpose:
  the tab shows a warning, and the route adds `allowDangerouslySkipPermissions: true` for it.
- A bad body gets one `error` event and `done`, as in Concept 1. The `options` object and the echo are in Step 4 above.

### Step 4: Two small routes for the disk

```ts
concept03.get("/files", async (_req, res) => {
  res.json(await listSandbox());
});
concept03.post("/reset", async (_req, res) => {
  await resetSandbox();
  res.json(await listSandbox());
});
```

- `POST /reset` returns the new listing, so the tab can refresh its card with one call.
- Concepts 4 and 5 call these same routes (`/api/c3/files`, `/api/c3/reset`) from their own tabs.

### Step 5: Mount the router

In [server/index.ts](server/index.ts), one import and one line:

```ts
import { concept03 } from "./concepts/03-tools.js";
// …
app.use("/api/c3", concept03);
```

### Step 6: The React tab

Each scenario is a label, a hint and a partial form:

```tsx
const scenarios: { label: string; hint: string; form: Partial<Form> }[] = [
  {
    label: "1 · Read-only",
    hint: "Read, Glob and Grep are read-only, so they run without asking.",
```

`run()` merges the ticked tools and the typed rules into one `allowedTools` list, and reloads the file list at the end:

```tsx
    const rules = form.rules.split(",").map((r) => r.trim()).filter(Boolean);
    const body = {
      prompt: form.prompt,
      model: "claude-haiku-4-5-20251001", // fast and cheap: tool runs take several turns
      toolsMode: form.toolsMode,
      tools: form.tools,
      allowedTools: [...form.allowedTools, ...rules],
      permissionMode: form.permissionMode || undefined,
      cwd: form.cwd,
      maxTurns: Number(form.maxTurns) || undefined,
    };
    try {
      await streamPost("/api/c3/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
      loadFiles();
    }
```

- A scenario button only fills the form (`set(s.form)`). You still press **Run query() with tools**, so you can
  change one field first.
- `loadFiles()` is a plain `fetch` to `/api/c3/files` (or `/api/c3/reset` for the Reset button). It runs on mount and
  after every run, so the `sandbox/ on disk` card shows what the agent changed.
- The pairing of `tool_use` and `tool_result` is in Step 5 above. `resultText()` cuts a long result to 300 characters.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
  { id: 3, title: "Built-in tools", Component: Concept03Tools },
```

### Step 7: Check that it works

1. `npx tsc -p .` must print nothing.
2. `npm run dev`, open tab **3. Built-in tools**, press **2 · Write, denied**, then **Run query() with tools**. The
   result card lists `permission_denials: Write`, and `sandbox/` has no `summary.md`.
3. Press **3 · Write + allowedTools** and run again: `summary.md` appears in the `sandbox/ on disk` card. Press
   **Reset sandbox/** to remove it.
4. The same routes from a terminal: see "Running the app" below.

## Running the app

Everything in [Tab2-Options.md → Running the app](Tab2-Options.md#running-the-app) applies, using the `sample35` folder.
Then open **http://localhost:5173** and select **3. Built-in tools**.

To call the endpoint without the UI (PowerShell):

```powershell
'{"prompt":"Read notes.txt and create summary.md with a 3-bullet summary of it.","model":"claude-haiku-4-5-20251001","toolsMode":"list","tools":["Read","Write"],"allowedTools":[],"permissionMode":"default","cwd":"sandbox"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c3/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
curl.exe http://localhost:3001/api/c3/files          # what is in sandbox/ now
curl.exe -X POST http://localhost:3001/api/c3/reset  # back to the seed files
```
