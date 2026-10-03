# Concept 8: Subagents with `options.agents` and the `Agent` tool, step by step

This file explains how Concept 8 (**Subagents**) was added to the Claude Agent SDK Lab.
It builds on Concept 3 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)) for the `sandbox/` folder, on Concept 4
([Tab4-Permissions.md](Tab4-Permissions.md)) for permission rules, and on Concept 7 ([Tab7-Hooks.md](Tab7-Hooks.md)) for
hooks.

**Goal:** let the main agent hand parts of a task to specialist agents. Each one has its own system prompt, tools and
model, and each one sends back a single report.

| Concept | Topic | Route |
|---|---|---|
| 8 | Subagents: `options.agents` + the `Agent` tool | `/api/c8/query` |

## Step 1: Defining subagents

Subagents are set in `Options.agents`: a map from a **name** to an `AgentDefinition`. Simplified from the
`definitions` object and the options in [server/concepts/08-subagents.ts](server/concepts/08-subagents.ts):

```ts
const options: Options = {
  tools: ["Agent", "Read", "Glob", "Grep", "Write"], // "Agent" is what lets the main agent delegate
  agents: {
    researcher: {
      description: "Reads files in the working folder and answers questions about them.", // read by the main agent
      prompt: "You are a researcher. ...",                                                 // the subagent's system prompt
      tools: ["Read", "Glob", "Grep"],                                                     // omit = inherit all tools
      model: "haiku",                                                                      // alias, full id or "inherit"
    },
  },
};
```

| Field | What it does |
|---|---|
| `description` | The main agent reads it to decide **when** to use this subagent. Write it like a job title plus limits. |
| `prompt` | The subagent's system prompt. |
| `tools` | Which tools it may use. Omitted = all of the parent's. `[]` = none. |
| `model` | `"haiku"`, `"sonnet"`, `"opus"`, a full model id, or `"inherit"` (same model as the main agent). |
| `disallowedTools`, `maxTurns`, `effort`, `permissionMode`, `background`, ... | Other limits for this one agent. |

The main agent then calls the built-in `Agent` tool:

```json
{ "subagent_type": "researcher", "description": "Find open tasks", "prompt": "Read data/tasks.json and ..." }
```

**The subagent starts with a fresh context.** It sees only its own system prompt and that `prompt`, not the
conversation. Whatever it needs has to be in the prompt the main agent writes.

## Step 2: Following a subagent in the stream

Everything a subagent does is tagged with the id of the `Agent` tool_use that started it:

| Message | `parent_tool_use_id` |
|---|---|
| Main agent's `assistant` / `user` messages | `null` |
| Subagent's `assistant` (tool_use) and `user` (tool_result) messages | the `Agent` tool_use id |

By default only the subagent's **tool** blocks are forwarded. `forwardSubagentText: true` also forwards its text, so
you can show a full nested transcript.

The SDK also emits `system` messages for each subagent:

| Message | Useful fields |
|---|---|
| `system/task_started` | `tool_use_id`, `subagent_type`, `is_backgrounded`, `prompt` |
| `system/task_notification` | `tool_use_id`, `status`, `summary`, `usage.{total_tokens, tool_uses, duration_ms}` |

And two hook events: `SubagentStart` (`agent_id`, `agent_type`) and `SubagentStop` (`last_assistant_message`, plus
`agent_transcript_path`).

## Step 3: Foreground vs background

In this SDK version, the `Agent` tool **runs subagents in the background by default**. Its input has a
`run_in_background` flag, and the model usually leaves it unset. In the background:

1. The `Agent` tool_result is only `"Async agent launched successfully..."`.
2. The main agent answers right away, and the first `result` arrives **before** the subagent is done.
3. The report comes later in `task_notification.summary`. It wakes the main agent up again, which gives a second turn
   and a **second `result`**.

That is right for long jobs, but confusing for a first look. So the route has a `foreground` switch: a Concept 7
`PreToolUse` hook that rewrites every `Agent` call:

```ts
const foreground: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as Record<string, unknown>;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, run_in_background: false },
    },
  };
};
```

`updatedInput` only takes effect together with `permissionDecision: "allow"` (see Concept 7). The hook is
registered as `PreToolUse: [{ matcher: "Agent|Task", hooks: [traced(foreground)] }]`, and only when the
`foreground` switch is on.

In the foreground the main agent waits, and the report **is** the `Agent` tool_result.

## Step 4: Server route

**File:** [server/concepts/08-subagents.ts](server/concepts/08-subagents.ts)

The browser sends which subagents to define, the session `tools`, `forwardSubagentText` and `foreground` (plus a
`model` and `maxTurns`). A zod schema checks the body first. The server has three definitions, and each one shows a different setting:

| Subagent | `tools` | `model` | Shows |
|---|---|---|---|
| `researcher` | `Read`, `Glob`, `Grep` | `haiku` | A read-only specialist on a cheaper model |
| `writer` | `Read`, `Write` | `inherit` | The only one that can change files |
| `critic` | `[]` | (default) | No tools: it only reasons over the text in its prompt |

Other settings, and why:

| Setting | Why |
|---|---|
| `permissionMode: "acceptEdits"` | Subagents use the same permission rules as the main agent. This lets the writer's `Write` run inside `cwd`. |
| `settingSources: []` | Without it, agents from your own `~/.claude/agents/` would be offered too. |
| `disallowedTools: ["Agent(general-purpose)", "Agent(Explore)", "Agent(Plan)", "Agent(claude)", "Agent(claude-code-guide)", "Agent(statusline-setup)"]` | Claude Code always offers its **built-in** subagents, and the model often picks `general-purpose` over yours. The permission rule `Agent(<name>)` blocks one subagent type and keeps the `Agent` tool. |
| `SubagentStart` / `SubagentStop` hooks | They only observe. Each call is streamed as a `hook` SSE event. |

`GET /api/c8/agents` returns the three definitions, so the UI table shows exactly what the server uses.

## Step 5: Browser flow

**File:** [src/concepts/Concept08Subagents.tsx](src/concepts/Concept08Subagents.tsx)

1. Pick a scenario, or tick subagents, tools and switches yourself.
2. **Run query() with subagents** posts `{ prompt, tools, agents, forwardSubagentText, foreground }` to `/api/c8/query`.
3. `buildDelegations()` groups the flat stream by the `Agent` tool_use id. Each group gets the input, the subagent's
   steps (messages whose `parent_tool_use_id` matches), `task_started` / `task_notification`, and the report.
4. The **delegations** card shows one block per subagent run: its prompt (all it knows), its tool calls, and its
   report.
5. The main agent's answer only uses messages with `parent_tool_use_id: null`. Every `result` is shown, because a
   background run has two.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/08-subagents.ts](server/concepts/08-subagents.ts) and
[src/concepts/Concept08Subagents.tsx](src/concepts/Concept08Subagents.tsx). Steps 1 to 5 above explain the ideas.
Here we look at the functions, the routes and the UI wiring.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `AgentDefinition`, `agents?:`,
`forwardSubagentText`, `SDKTaskStartedMessage`, `SDKTaskNotificationMessage`, `SubagentStartHookInput` and
`SubagentStopHookInput`. The `run_in_background` flag is **not** in these types: it is part of the `Agent` tool's
input, which you see in the `tool_use` blocks of a real run. That is why the lab changes it with a hook (Step 3
above) and not with an option.

### Step 2: The three definitions, in one place

```ts
const AGENT_NAMES = ["researcher", "writer", "critic"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

// Three subagents, each showing a different setting of AgentDefinition.
const definitions: Record<AgentName, AgentDefinition> = {
  // Read-only tools and a cheaper model: a specialist that can't change anything.
  researcher: {
    description: "Reads files in the working folder and answers questions about their content. Cannot modify files.",
    // … prompt
    tools: ["Read", "Glob", "Grep"],
    model: "haiku",
  },
  // … writer (tools: ["Read", "Write"], model: "inherit") and critic (tools: [])
};

// Offered by Claude Code itself even with settingSources: []. They stay in the `agents` list of system/init,
// but the deny rules below make an Agent call to them fail.
const BUILT_IN_AGENTS = ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"];
```

- The definitions live at module level. The browser only sends names (`agents: AgentName[]`), and the server picks
  the definitions with `Object.fromEntries(body.agents.map((name) => [name, definitions[name]]))`.
- `BUILT_IN_AGENTS` becomes the `disallowedTools` list: `` BUILT_IN_AGENTS.map((name) => `Agent(${name})`) ``.
- As in Concept 7, `SANDBOX` is imported from `./03-tools.js`, so the subagents work in Concept 3's `sandbox/`.

The body is checked with zod before anything else. The schema accepts exactly what the tab sends:

```ts
// Exactly what the tab sends: its five tools, the agent names, two switches, and a model and maxTurns.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    model: z.string().regex(/^claude-[a-z0-9.-]+$/, "a Claude model id").optional(),
    tools: z.array(z.enum(["Agent", "Read", "Glob", "Grep", "Write"])).max(5),
    agents: z.array(z.enum(AGENT_NAMES)).max(3),
    forwardSubagentText: z.boolean(),
    foreground: z.boolean(),
    maxTurns: z.number().int().min(1).max(50).optional(),
  })
  .strict();
```

- The route starts with `Body.safeParse(req.body ?? {})`. On a bad body it sends one `error` event
  (`Bad request: agents.0: Invalid option: …`), then `done`, and never calls the SDK. Same pattern as Concept 34.
- Because `agents` can only hold the three names, `definitions[name]` always finds a definition.

### Step 3: The hooks, created per request

Inside `concept08.post("/query", …)` there is a `traced()` wrapper, like in Concept 7, and one hook that only
observes:

```ts
const traced =
  (fn: HookCallback): HookCallback =>
  async (input, toolUseID, opts) => {
    const output = await fn(input, toolUseID, opts);
    send("hook", { input, output, at: Date.now() });
    return output;
  };
const observe: HookCallback = async () => ({});
```

- There is no hook name here. The UI tells the hooks apart by `input.hook_event_name`.
- `observe` is registered on `SubagentStart` and `SubagentStop`. It returns `{}`, but thanks to `traced()` the
  browser gets `agent_id`, `agent_type` and `last_assistant_message` without reading any transcript file.
- The `foreground` hook (Step 3 above) is also created here, and wrapped with `traced()` too.

### Step 4: Build the options

```ts
hooks: {
  PreToolUse: body.foreground ? [{ matcher: "Agent|Task", hooks: [traced(foreground)] }] : [],
  SubagentStart: [{ hooks: [traced(observe)] }],
  SubagentStop: [{ hooks: [traced(observe)] }],
},
```

- The matcher is `Agent|Task`: the same regex also covers the tool's older name `Task`. The UI checks both names
  too.
- The other options are listed in Step 4 above: `tools`, `agents`, `forwardSubagentText`, `cwd: SANDBOX`,
  `permissionMode: "acceptEdits"`, `settingSources: []`, `strictMcpConfig: true` and `disallowedTools`.
- Functions can't be serialized, so the `options` SSE event is sent with the same `hooks` object written by hand
  as strings (`"[Function foreground]"`, `"[Function observe]"`). Then `pipe(query(…))` streams the run.

### Step 5: The `/agents` route

```ts
// The browser shows the definitions, so they live in one place.
concept08.get("/agents", (_req, res) => {
  res.json(definitions);
});
```

The UI table (tools, model, description) is filled from this answer, so it can't drift from the server.

### Step 6: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept08 } from "./concepts/08-subagents.js";
// …
app.use("/api/c8", concept08);
```

### Step 7: The React tab

On first load the tab reads the sandbox files and the definitions:

```tsx
useEffect(() => {
  loadFiles();
  fetch("/api/c8/agents").then((r) => r.json()).then(setDefinitions);
}, []);
```

Each scenario button fills the `Form` (`prompt`, `tools`, `agents`, `forwardSubagentText`, `foreground`). `run()`
posts it:

```tsx
await streamPost("/api/c8/query", { ...form, model: "claude-haiku-4-5-20251001", maxTurns: 15 }, (event, data) => {
  if (event === "options") setSentOptions(data);
  if (event === "message") setMessages((prev) => [...prev, data]);
  if (event === "hook") setHooks((prev) => [...prev, data]);
  if (event === "error") setError(data.message);
});
```

- `maxTurns: 15` is higher than Concept 7's `10`. It leaves room for the three delegations of **3 · Chain**.
- The main answer only joins `assistant` messages with no `parent_tool_use_id`. With `forwardSubagentText`, the
  subagents' text would otherwise be mixed into it.

### Step 8: Group the stream by delegation

`buildDelegations(messages)` runs on every render. It first finds the main agent's `Agent` calls, then attaches
everything else to them:

```tsx
for (const m of messages) {
  if (m.type === "assistant" && !m.parent_tool_use_id) {
    for (const b of m.message.content) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) byId.set(b.id, { id: b.id, input: b.input, steps: [] });
    }
  }
}
// … second loop: task_* messages by tool_use_id, steps by parent_tool_use_id, report from the tool_result
// A background subagent's tool_result is only "Async agent launched"; its real report is the notification summary.
for (const d of byId.values()) {
  if (d.started?.is_backgrounded && d.notification) d.report = d.notification.summary;
}
```

- The key of the map is the `Agent` tool_use id. It is the same value as `parent_tool_use_id` on the subagent's
  messages and `tool_use_id` on its `system/task_*` messages.
- The first loop only collects the `Agent` calls. The second loop attaches the other messages to them.
- `DelegationRow` shows each group. It says where the report came from: "the Agent tool_result" or
  "from task_notification.summary".

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 8, title: "Subagents", Component: Concept08Subagents },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 8. The agents table shows the three definitions (they come from `/api/c8/agents`).
3. Run **1 · Delegate**: the **delegations** card has one `researcher` block, marked `foreground`, with its
   `Read` or `Glob` calls and a report.
4. Run **8 · Background**: the block is marked `background`, and there are two `result` cards.

## Things to try in Concept 8

1. **1 · Delegate**: find the researcher's `Read` in the raw stream and check its `parent_tool_use_id`.
2. **2 · Pick by description**: the prompt names no agent, and the main agent picks `writer`. Remove "Delegate to the
   best-suited subagent:" from the prompt: the main agent usually does the job itself, since it has the same tools.
3. **3 · Chain**: read the critic's prompt. The main agent copied the list into it, because the critic can't see
   anything else.
4. **4 · Parallel**: both `task_started` messages arrive before either `task_notification`.
5. **5 · Tool isolation**: the researcher has no `Write`, even though the session does, so it can only explain why it
   can't do the job.
6. **6 · Forward text**: compare with scenario 1. The subagent's own text is now in the delegation.
7. **7 · No Agent tool**: the agents are defined, but without `"Agent"` in `tools` nothing is delegated.
8. **8 · Background**: the default mode. Look for the placeholder tool_result, `task_notification.summary`, and the
   two `result` cards.
9. Untick `Write` in `tools` and run scenario 2: the writer only has `Read` left. A subagent gets the tools in both
   its own list and the session pool.
10. Ask the writer for `summary.md`: Claude Code refuses a subagent's `Write` of a report-like file ("Subagents should
    return findings as text..."), and the main agent writes it itself.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/08-subagents.ts` | New route (body checked with zod) with three `AgentDefinition`s, the `foreground` hook and subagent hooks |
| `server/index.ts` | Mounts the route on `/api/c8` |
| `src/concepts/Concept08Subagents.tsx` | Subagents UI with scenarios and a card per delegation |
| `src/App.tsx` | Adds the Subagents tab |
| `src/styles.css` | Styles for delegation blocks |
| `Tab8-Subagents.md` | This explanation |
| `Tab1-query().md` | Adds Concept 8 to the table of concepts (this file was called `README.md` then) |
