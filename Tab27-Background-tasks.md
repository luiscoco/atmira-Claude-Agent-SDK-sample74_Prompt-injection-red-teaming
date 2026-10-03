# Background tasks

This file explains how Concept 27 (**Background tasks**) was added to the Claude Agent SDK Lab. A **task** is a Bash
command, a subagent or a Monitor that Claude Code runs **next to** the conversation. The turn ends, the task keeps
running, and when it settles Claude Code **starts a new turn by itself** to tell the model. Concept 26 moved a task
to the background from the host (`q.backgroundTasks()`, `q.stopTask()`). This concept follows a task through its
whole life.

**Goal:** know who can start a background task, which messages your code gets about it, how the model hears about
it, every way it can end, and the traps: the one-shot run that kills it, the turn nobody asked for, and the
`interrupt()` that spares some tasks and not others.

| Concept | Topic | Routes |
|---|---|---|
| 27 | Background tasks: Bash `run_in_background`, the Bash timeout that moves a command to the background (`timedOutAfterMs`), background subagents (`AgentDefinition.background`), the `Monitor` tool, the `TaskStop` tool, `system/background_tasks_changed` (level) vs `task_started` / `task_updated` / `task_progress` / `task_notification` (edges), `agentProgressSummaries`, the Stop hook's `background_tasks`, the automatic turn after a notification, reading the output file, one-shot vs streaming input, `interrupt()` + `perTaskStopAffordance`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_TMPDIR` | `/api/c27/oneshot` (SSE), `/open` (SSE), `/call`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/27-background-tasks.ts` | **New**: the lab folder, `canUseTool`, the options (the `waiter` agent, the Stop hook), the one-shot and live-session routes, the message relay |
| `server/index.ts` | Mounts the router on `/api/c27` |
| `src/concepts/Concept27BackgroundTasks.tsx` | **New**: the tab (Parts A to D), the Tasks panel and the scenario runner |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Task status colours, the tasks panel, the "automatic turn" row |
| `.gitignore` | Ignores `bg-lab/` |
| `Tab1-query().md` | Adds Concept 27 to the table |
| `Tab27-Background-tasks.md` | This explanation |

---

## Step 1: What a task is

Claude Code keeps a list of **tasks**: work that has a life of its own. Each one has a `task_id` and a `task_type`:

| `task_type` | What it is | Started by |
|---|---|---|
| `local_bash` | A shell command (also a `Monitor`) | The Bash tool, the Monitor tool |
| `local_agent` | A subagent | The Agent tool |
| `local_workflow`, `mcp_task`… | Workflows, long MCP calls | not in the lab |

A task is **in the foreground** while the tool call that started it is waiting for it, and **in the background** once
that tool call has returned. A background task does not block the turn, so the model can answer, the turn can end,
and the task goes on running.

## Step 2: One-shot runs kill background tasks (Part A)

Simplified from `POST /oneshot` in [server/concepts/27-background-tasks.ts](server/concepts/27-background-tasks.ts):

```ts
for await (const m of query({ prompt: "Run node slow.mjs 15 with run_in_background… then reply: started", options })) …
```

What `POST /oneshot` shows:

```
 3.3 s  tool_use Bash {"command":"node slow.mjs 15","run_in_background":true}
 5.4 s  system/background_tasks_changed [b88age0o2 (local_bash)]
 5.4 s  system/task_started   is_backgrounded: true
 5.4 s  tool_result  "Command running in background with ID: b88age0o2. Output is being written to: bg-lab\tmp\claude\…\tasks\b88age0o2.output"
 6.1 s  Stop hook    background_tasks: b88age0o2 shell running
 6.1 s  result       success  "Started"
11.3 s  task_updated { status: "killed" }  →  task_notification status: stopped
13.4 s  the iterator ends
```

A **string** prompt closes the input. With nothing left to read, Claude Code **kills** the background tasks shortly
after the result (about 5 s here) and exits. The command never finished. Nothing could hear about it anyway: the
automatic turn of Step 5 needs a live process.

**Rule:** for background work, use **streaming input** (Concept 12): a prompt iterable that stays open. Part B does
that with a push queue, like Concept 26.

## Step 3: The lab

Simplified from `baseOptions()` in [server/concepts/27-background-tasks.ts](server/concepts/27-background-tasks.ts):

```ts
{
  model: "claude-haiku-4-5-20251001",
  cwd: "bg-lab/work",                                     // slow.mjs: prints "tick i/N" once per second
  tools: ["Read", "Bash", "Agent", "Monitor", "TaskStop"],
  agents: { waiter: { description, prompt, tools: ["Bash"], model: "haiku", background: true } },
  agentProgressSummaries: true,                           // Step 7
  perTaskStopAffordance: false,                           // Step 10 (a profile option in the tab)
  hooks: { Stop: [{ hooks: [stopHook] }] },               // Step 4
  canUseTool: policy(...),
  env: { ...processEnvWithoutClaude, CLAUDE_CONFIG_DIR: "bg-lab/config", CLAUDE_CODE_TMPDIR: "bg-lab/tmp" },
}
```

- `canUseTool` allows Bash and Monitor only for `node slow.mjs N` (N ≤ 60), Read inside `bg-lab`, the `waiter`
  agent, and TaskStop. The subagent's Bash calls come through it too.
- `CLAUDE_CODE_TMPDIR` keeps the output files in `bg-lab/tmp/claude/<cwd>/<session>/tasks/<task id>.output`, not in
  the system temp folder.
- `POST /open` takes a **profile** (zod, strict): `{ perTaskStopAffordance?, disableBackground? }`. Nothing else
  about the session can be set from the browser. `POST /call` accepts `prompt`, `backgroundTasks`, `stopTask`,
  `interrupt` and `close`.

## Step 4: Two ways to track tasks: the level and the edges

The session reports tasks in two ways, and the Tasks panel shows both side by side:

| Message | Kind | Carries |
|---|---|---|
| `system/background_tasks_changed` | **level** | `tasks: [{ task_id, task_type, description }]`: **every** live background task after a change |
| `system/task_started` | edge | `task_id`, `tool_use_id`, `task_type`, `subagent_type`, `is_backgrounded`, `owned_by_subagent` |
| `system/task_updated` | edge | `patch`: `{ status: "completed" \| "killed" … }`, `{ is_backgrounded: true }` |
| `system/task_progress` | edge | `usage` (tokens, tool uses, ms), `last_tool_name`, `summary` (Step 7) |
| `system/task_notification` | edge | `status: "completed" \| "failed" \| "stopped"`, `summary`, `output_file`, `usage` |

- The **level** has REPLACE semantics: swap your set for each payload. The SDK recommends it for a "background work
  is running" indicator, because a missed edge cannot leave a stale spinner. It lists **background tasks only**, and
  nothing is sent at startup: start from an empty set.
- The **edges** tell the story of every task, foreground ones too. The panel's "Every task" column merges them into
  a map (`taskMap()` in the tab).
- The **Stop hook** gets `background_tasks` (`[{ id, type: "shell" | "subagent", status, description, command |
  agent_type }]`). A hook can tell "the session is done" from "the session is waiting for background work".

## Step 5: The model starts it: `run_in_background` (scenario 1)

```
tool_use Bash {"command":"node slow.mjs 12","run_in_background":true}
tool_result   "Command running in background with ID: bstfd5u5j. Output is being written to: …\bstfd5u5j.output"
              tool_use_result.backgroundTaskId: "bstfd5u5j"
result        "started"                                                        ← turn 1 ends, the command runs on
prompt        Read the background task's output file … last tick line
tool_use Read {"file_path":"…\tasks\bstfd5u5j.output"}   →  "tick 1/12 … tick 5/12"
result        "tick 5/12"                                                      ← turn 2
bgSet []  ·  task_updated completed  ·  task_notification completed
system/init   turn 3   ← started by a task notification, not a prompt
tool_use Read …  →  "… finished [exited with code 0]"
result        "tick 12/12"
```

- The tool result gives the model the **task id** and the **output file**. To look at a running task, the model reads
  that file with the **Read** tool. (The old `TaskOutput` tool was removed; `taskOutputMaxChars` no longer does
  anything.) The file ends with `[exited with code N]` when the command is done.
- Reading the output file did **not** go through `canUseTool`, even though it is outside the cwd. Claude Code allows
  reads of its own task output files.
- When the task settles, Claude Code **starts a turn by itself**. Your loop gets an extra `init` … `result` that no
  prompt caused, and it is billed like any other turn. The tab marks that `init` in red.

## Step 6: A timeout moves it (scenario 2)

A **foreground** Bash call with `timeout: 3000` on a 10-second command does **not** fail:

```
tool_result  "Command did not complete within its 3s timeout and was moved to the background (ID: b9e1b7jc9)…"
             tool_use_result: { backgroundTaskId: "b9e1b7jc9", timedOutAfterMs: 3000 }
```

The command keeps running, and its end starts a turn, like scenario 1. So a Bash timeout is not a kill switch. To
limit how long a command may live, stop it (Step 9) or build the limit into the command itself.

## Step 7: A background subagent (scenario 3)

The `waiter` agent is defined with `background: true`, so every call to it is a background task. (The Agent tool
also has its own `run_in_background` input, which is `true` by default in this version.)

```
tool_use Agent {"subagent_type":"waiter","prompt":"Run this command: node slow.mjs 40"}
task_started  local_agent (waiter) · is_backgrounded: true
tool_result   "Async agent launched successfully. … agentId: …"          tool_use_result.isAsync: true
result        "Delegated."                                                  ← the turn ends at once
  [subagent] tool_use Bash node slow.mjs 40
task_started  local_bash · is_backgrounded: false · owned_by_subagent      ← the subagent's own command
task_progress summary: "Running slow.mjs script"                            ← ~30 s in (agentProgressSummaries)
task_notification (the Bash) completed
task_notification (the agent) completed · summary: "The last output line is: finished" · usage { tool_uses, duration_ms }
system/init   turn 2   ← the main agent reports the result
```

- Two tasks: the **agent** (background) and its **Bash** (foreground *for the subagent*: `owned_by_subagent: true`).
  The subagent's command is not in the background set.
- `agentProgressSummaries: true` forks the subagent's conversation about every 30 s to write a one-line
  `task_progress.summary`. Without it, `task_progress` still carries `usage` and `last_tool_name`.
- The subagent's own messages come in the same stream with `parent_tool_use_id` set. The tab fades them.

## Step 8: Monitor: one turn per line (scenario 4)

The **Monitor** tool runs a command in the background and turns **each stdout line** into an event for the model:

```
tool_use Monitor {"command":"node slow.mjs 3","timeout_ms":60000}
tool_result  "Monitor started (task be1jq53se, expires in 1m unless the source ends first; …)"
result "Watching."    · turn 2 "tick 1/3" · turn 3 "tick 2/3" · task_notification · turn 4 "tick 3/3 finished"
```

Four turns for three lines. Lines less than 200 ms apart are batched into one event. Use Monitor when you want the
model to react to **every** occurrence (each error in a log). Use `run_in_background` when one "it finished"
notification is enough. A chatty command under Monitor costs a turn per line.

## Step 9: Stopping a task

| Who | How | Messages |
|---|---|---|
| the model | the **TaskStop** tool, `{ task_id }` (scenario 5) | `task_updated killed` → `task_notification stopped`; tool result `"Successfully stopped task: …"` |
| the host | `q.stopTask(taskId)` (scenario 7, Concept 26) | the same; resolves to `undefined` |
| the host | `q.interrupt()` (Step 10) | depends on the task type |
| the host | `q.close()` / abort | the process ends, and every task with it |

TaskStop on a task that has already ended returns
`<tool_use_error>Task … is not running (status: killed)</tool_use_error>`. A stop is a notification too, so it
**can** start a short automatic turn (it did in scenario 7, not in scenario 5).

## Step 10: `interrupt()`: who survives? (scenarios 6 and 7)

Three tasks run at once: a background **subagent**, a background **Bash** and a foreground **Bash**. Then
`interrupt()`:

| Task | `perTaskStopAffordance: false` (default) | `perTaskStopAffordance: true` |
|---|---|---|
| foreground Bash | stopped (it belongs to the turn) | stopped |
| background Bash | **keeps running** | keeps running |
| background subagent | **killed** (`task_updated killed`) | **keeps running** |

`perTaskStopAffordance` means "my UI has a stop button for each task". Without it, Claude Code assumes a runaway
background agent would be impossible to stop, so an interrupt kills background agents. With it, the Stop button only
stops the turn, and each task is stopped through your own `stopTask` buttons (scenario 7 does that for the agent).

**The trap found in the tests:** after the interrupt, the background Bash finished, and its notification turn made
the model **run the interrupted foreground command again** (`node slow.mjs 20`, 20 more seconds). The model reads the
notification as a cue to finish its plan. If a Stop must mean stop, also stop the background tasks, or tell the
model in the next prompt.

## Step 11: Turning it off (scenario 8)

`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in `options.env`:

- The Bash tool **loses its `run_in_background` parameter**. The same request ran in the foreground and blocked the
  turn for the whole command. The model said: *"The `run_in_background` parameter isn't available for the Bash tool"*.
- `q.backgroundTasks()` throws `Error: Background tasks are disabled in this session.`

Use it for hosts that cannot keep a session alive between turns, where a background task could only be killed.

## Step 12: What the tests changed

| Found | Change |
|---|---|
| The subagent ran `cd "<cwd>" && node slow.mjs 40`; the strict regex denied it, and the subagent then **reported success anyway** | `isSlow()` accepts a `cd` into exactly `bg-lab/work`, compared without case (Windows gave `c:` and `C:`). The waiter's prompt says "no cd" and "if it is denied, say so". Lesson: check the task's `tool_result`, not the subagent's summary |
| After `interrupt()`, a notification turn restarted the interrupted command | Documented (Step 10) and in the hints of scenarios 6 and 7 |
| Stopping the server's background shell left the node process on port 3001 alive, so the fix was not loaded | Stopped by port, restarted, re-tested |
| The probes' first Edge profile inside the project crashed Vite's watcher (`EBUSY`) | The profile was moved to a temp folder. `bg-lab/` is already ignored by the `*-lab` rule in `vite.config.ts` |
| Under `npm run dev`, **Run the one-shot** failed with a 502: `node --watch` restarted the server on the first POST (a freshly copied `node_modules` file read for the first time), and `slow.mjs` run by the agent was reported to the watcher, so each restart caused the next one | `server/index.ts` loads iconv-lite at startup and deletes `WATCH_REPORT_DEPENDENCIES`; `streamPost()` shows HTTP errors. Details in `Build-steps.md` Step 10 |

## Step 13: The costs

| Run | Cost (measured) |
|---|---|
| A · one-shot | $0.015 |
| 1 · `run_in_background` (3 turns) | $0.013 to $0.024 |
| 2 · timeout | $0.007 |
| 3 · background subagent (~50 s) | $0.014 |
| 4 · Monitor (4 turns) | $0.009 |
| 5 · TaskStop | $0.008 |
| 6 · interrupt (with the re-run) | $0.019 |
| 7 · `perTaskStopAffordance` | $0.019 |
| 8 · disabled | $0.014 |

The first turn of each session costs about $0.005 more than in Concept 26, because the five tools and the agent
definition are in the prompt.

## Step 14: How a task starts and ends (Part D)

| What | Effect | Scenario |
|---|---|---|
| Bash `run_in_background: true` | The model asks for it. Returns at once with the task id and the output file | 1, 5, 6 |
| Bash `timeout` | A foreground command past its timeout moves to the background (`timedOutAfterMs`) | 2 |
| Agent (`background: true`, or `run_in_background`) | A subagent next to the conversation (`local_agent`) | 3, 6, 7 |
| Monitor | A background command whose every stdout line is an event, and a turn | 4 |
| `q.backgroundTasks(toolUseId?)` | The host moves a running foreground command or subagent (Ctrl+B) | Concept 26 |
| completed / failed | `task_notification` → Claude Code starts a turn by itself | 1–4 |
| TaskStop tool | The model stops a task by id | 5 |
| `q.stopTask(taskId)` | The host stops a task by id | 7 · Concept 26 |
| `q.interrupt()` | Stops the turn and its foreground task. Background Bash survives; background agents die unless `perTaskStopAffordance` | 6, 7 |
| end of a one-shot run | The input is closed: background tasks are killed after the result | A |
| `q.close()` / abort | The process ends, and every task with it | Concept 26 |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/27-background-tasks.ts](server/concepts/27-background-tasks.ts) and
[src/concepts/Concept27BackgroundTasks.tsx](src/concepts/Concept27BackgroundTasks.tsx). The live session is built like
the one of Concept 26 (a push queue, a `Map` of sessions, `POST /call`), so this section spends its time on what is new.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `background_tasks_changed`, `task_started`,
`task_updated`, `task_progress`, `task_notification`, `AgentDefinition` (its `background` field),
`agentProgressSummaries`, `perTaskStopAffordance` and the Stop hook's `background_tasks`. The types give the fields,
but not the behaviour: that one-shot runs kill their tasks (Step 2 of the concept), or who survives an `interrupt()`
(Step 10 of the concept), was found by running each case first.

### Step 2: The lab folder

The server deletes and rebuilds `bg-lab/` at start-up, with `work/slow.mjs` (the same script as Concept 26),
`config/` and `tmp/`. One helper is new. Output file paths contain the session's cwd and are long, so they are
shortened before they go to the browser:

```ts
const short = (s: string) =>
  s
    .replaceAll(LAB, "bg-lab")
    .replace(/(bg-lab[\\/]+tmp[\\/]+claude[\\/]+)[^\\/"]+/g, "$1…");
```

- The first `replace` hides the absolute path of the project. The second one replaces the folder name made from the
  cwd with `…`, which gives `bg-lab\tmp\claude\…\<session>\tasks\<id>.output`.

### Step 3: The policy, with `isSlow()`

```ts
const SLOW = /^node slow\.mjs ([1-9]|[1-5]\d|60)$/;
/** `node slow.mjs N`, optionally after `cd "<the work folder>" &&` (subagents like to add that). */
function isSlow(command: string) {
  const m = command.trim().match(/^cd\s+"?([^"&]+?)"?\s*&&\s*(.+)$/);
  if (m && path.resolve(m[1]).toLowerCase() !== WORK.toLowerCase()) return false; // Windows paths: c:\ and C:\ are the same
  return SLOW.test((m ? m[2] : command).trim());
}
function policy(onDecision: (d: { tool: string; input: unknown; allowed: boolean }) => void): CanUseTool {
  return async (tool, input) => {
    let allowed = false;
    if (tool === "Bash" || tool === "Monitor") allowed = isSlow(String(input.command ?? ""));
    if (tool === "Read") allowed = inside(LAB, path.resolve(WORK, String(input.file_path ?? ""))); // the output files are in bg-lab/tmp
    if (tool === "Agent") allowed = input.subagent_type === "waiter";
    if (tool === "TaskStop") allowed = true;
    // … onDecision, then allow or deny
```

- `isSlow()` is the fix from Step 12 of the concept: the subagent added `cd "<cwd>" &&`, and the first, strict regex
  denied it. A `cd` is accepted only into the work folder itself.
- Monitor runs a command too, so it goes through the same check as Bash.
- `inside(dir, p)` is a small helper at the top of the region. It uses `path.relative()`, so it is true for `bg-lab`
  and the paths under it, but not for a sibling folder whose name only starts with `bg-lab`. A plain
  `startsWith(LAB)` would let that through.
- The subagent's Bash calls also come through this function. There is one policy for the whole session.

### Step 4: The profile and the options

The browser may choose only two things about a session. A strict zod object says which:

```ts
const Profile = z
  .object({
    disableBackground: z.boolean().optional(), // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
    perTaskStopAffordance: z.boolean().optional(), // "my UI has a stop button per task": interrupt() spares background agents
  })
  .strict();
```

`baseOptions(profile, extra)` turns the profile into options:

```ts
if (profile.disableBackground) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
return {
  model: MODEL,
  cwd: WORK,
  tools: ["Read", "Bash", "Agent", "Monitor", "TaskStop"],
  agents: {
    // background: true -> every call of this agent is a background task, whatever the model asks for
    waiter: {
      description: "Runs one slow command and reports its last output line.",
      prompt: "Run exactly the Bash command you are given, as it is (no cd), in the foreground, then report its last output line. If it is denied or fails, say so.",
      tools: ["Bash"],
      model: "haiku",
      background: true,
    },
  },
  agentProgressSummaries: true, // task_progress.summary for subagents, about every 30 s
  perTaskStopAffordance: profile.perTaskStopAffordance ?? false,
  // … settingSources: [], persistSession: false, thinking disabled, env, ...extra
};
```

- `Monitor` and `TaskStop` must be in `tools`, or the model cannot use them (scenarios 4 and 5).
- The waiter's prompt says "no cd" and "if it is denied, say so": both come from the tests (Step 12 of the concept).
- `CLAUDE_CODE_TMPDIR` is set in `env` above this, as in Concept 26.

The Stop hook only reports what it receives:

```ts
function stopHook(emit: (event: string, data: object) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name === "Stop") emit("stopHook", { background_tasks: input.background_tasks ?? [] });
    return {};
  };
}
```

### Step 5: The relay: the level and the edges

`relay()` (the `messages` region) turns each SDK message into a small event. The system messages are the new part:

```ts
case "init":
  return emit("init", { model: msg.model, tools: msg.tools }); // once per turn, including the turns a task_notification starts
// The LEVEL: every live background task after a change. Replace your set with it.
case "background_tasks_changed":
  return emit("bgSet", { tasks: msg.tasks });
// The EDGES of one task's life.
case "task_started":
```

- The level becomes a `bgSet` event, and the four edges all become one `task` event with a `subtype`. The browser
  handles them in two different ways (Step 8).
- For tool results, the relay also copies a few fields of `tool_use_result` (`BG_KEYS`: `backgroundTaskId`,
  `timedOutAfterMs`, `isAsync`…) into `meta`. That is where the tab shows `timedOutAfterMs: 3000` in scenario 2.
- Messages with a `parent_tool_use_id` get `sub: true`, so the tab can fade the subagent's own messages.

### Step 6: The routes

`POST /oneshot` is Part A. It runs a **string** prompt with the same options, and streams until the iterator ends:

```ts
const prompt = "Run the Bash command `node slow.mjs 15` with run_in_background set to true. Then reply: started";
const profile: Profile = {};
const options = baseOptions(profile, {
  abortController: abort,
  canUseTool: policy((d) => emit("canUseTool", d)),
  hooks: { Stop: [{ hooks: [stopHook(emit)] }] },
});
emit("opened", { id: "one-shot", prompt, options: optionsForBrowser(profile, options) });
try {
  for await (const msg of query({ prompt, options })) relay(msg, emit);
```

- The prompt is fixed in the server. The browser sends nothing.
- `optionsForBrowser()` replaces `env`, the functions and the `abortController` with short strings before the
  options are shown in the tab.

`POST /open` is Part B. Its first line validates the profile, and it refuses a bad one on the SSE stream:

```ts
const parsed = Profile.safeParse(req.body ?? {});
// …
if (!parsed.success) return refuse(`Bad profile: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
if ([...sessions.values()].filter((s) => !s.ended).length >= MAX_SESSIONS) return refuse(`Already ${MAX_SESSIONS} live sessions. Close one first.`);
```

The rest (the push queue, the idle timer, the background `for await`) is the code of Concept 26. `POST /call`
accepts `prompt` and the task methods only:

```ts
const CONTROLS: Record<string, { args?: z.ZodType; run: (q: Query, args: any) => Promise<unknown> }> = {
  backgroundTasks: { args: z.object({ toolUseId: z.string().max(100).optional() }).strict(), run: (q, { toolUseId }) => q.backgroundTasks(toolUseId) },
  stopTask: { args: z.object({ taskId: z.string().min(1).max(100) }).strict(), run: (q, { taskId }) => q.stopTask(taskId) },
  interrupt: { run: (q) => q.interrupt() },
  close: { run: async (q) => q.close() },
};
```

- As in Concept 26, a strict zod schema (`CallBody`) checks the body first: `id`, `method` and an optional `args`
  object. Then `Object.hasOwn` looks the name up, and the method's own zod schema checks `args` before anything runs.
- A method that throws (like `backgroundTasks()` in scenario 8) is not a server error: it is returned as
  `{ ok: false, error }` and shown as a red row.

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept27 } from "./concepts/27-background-tasks.js";
// …
app.use("/api/c27", concept27);
```

### Step 8: The React tab

The tab reuses the scenario runner of Concept 26 (`open()`, `call()`, `waitFor()` with a cursor). A scenario can
also carry a `profile`, which `open(p)` posts to `/api/c27/open`. The waits are new:

```tsx
const matches: Record<Wait, (e: Ev) => boolean> = {
  result: (e) => e.event === "result",
  taskStarted: (e) => e.event === "task" && e.data.subtype === "task_started",
  // the main thread's own foreground Bash command (not the subagent's)
  fgBash: (e) => e.event === "task" && e.data.subtype === "task_started" && e.data.task_type === "local_bash" && e.data.is_backgrounded === false && !e.data.owned_by_subagent,
  bgEmpty: (e) => e.event === "bgSet" && e.data.tasks.length === 0,
  ended: (e) => e.event === "ended",
};
```

- `bgEmpty` waits for the **level** to become empty: every background task has settled. Most scenarios then wait for
  one more `result`: the automatic turn.
- `fgBash` finds the main agent's own foreground command, so scenarios 6 and 7 interrupt at the right time.

The Tasks panel draws the level as it is (the last `bgSet`), and merges the edges into a map:

```tsx
function taskMap(events: Ev[]): TaskRow[] {
  const map = new Map<string, TaskRow>();
  for (const { event, data } of events) {
    if (event !== "task") continue;
    const row: TaskRow = map.get(data.task_id) ?? { task_id: data.task_id, status: "running" };
    if (data.subtype === "task_started") Object.assign(row, { task_type: data.task_type, description: data.description, is_backgrounded: data.is_backgrounded, owned_by_subagent: data.owned_by_subagent });
    if (data.subtype === "task_updated") {
      if (data.patch.status) row.status = data.patch.status;
      if (data.patch.is_backgrounded !== undefined) row.is_backgrounded = data.patch.is_backgrounded;
    }
    // … task_progress and task_notification
    map.set(data.task_id, row);
  }
  return [...map.values()];
}
```

- The same map gives the `stopTask(…)` buttons: one for each task whose status is still `running`.

The red "started by a task notification" row is found in the `Timeline`:

```tsx
// A turn with no prompt sent since the previous turn started was started by a task, not by you.
const before = events.slice(0, i);
const prevInit = before.map((e) => e.event).lastIndexOf("init");
const auto = turns > 0 && !before.slice(prevInit + 1).some((e) => e.event === "call" && e.data.method === "prompt");
```

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 27, title: "Background tasks", Component: Concept27BackgroundTasks },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 27, press **Run the one-shot**: the Stop hook row shows the task `running`, and a few
   seconds later `task_updated { status: "killed" }` arrives.
3. Run **1 · run_in_background**: the Tasks panel fills, then empties, and a red `system/init` row appears.
4. Run **8 · Background disabled**: the last orange row is `q.backgroundTasks()` with the "disabled" error.

## Things to try

1. **A**: compare the Stop hook row (task `running`) with the `task_updated killed` row 5 s later.
2. **B · 1**: find the red `system/init`. What caused that turn?
3. **B · 3**: in the Tasks panel, which task is in "Every task" but never in the live background set? Why?
4. **B · 4**: count the `result` rows, then multiply by a chatty log.
5. **B · 6 and 7**: compare the panel right after `interrupt()`: which status is `killed` in 6 and `running` in 7?
6. **By hand**: open a session, send `Run the Bash command node slow.mjs 30`, and press `backgroundTasks(last
   tool_use)` after the `task_started` row. Then press the `stopTask(…)` button that appears.
7. **By hand**: tick `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, open a session and ask for a background command.
