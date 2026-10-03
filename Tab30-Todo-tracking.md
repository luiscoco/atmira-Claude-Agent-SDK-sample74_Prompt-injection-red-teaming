# Todo tracking

This file explains Concept 30 (**Todo tracking**) of the Claude Agent SDK Lab. On a job with several steps, the agent
can keep a **todo list**: it writes a plan, marks one task `in_progress`, and then marks it `completed`. Claude Code has
**two** todo tools, and which one the model gets depends on the model and on two env variables. This concept shows
both tools, what your code sees of them, and how the **host** can write the plan, watch it, check it, and refuse
changes to it.

**Goal:** know which todo tool your agent has, how to show its plan live in your UI, and how to make the plan
something your code controls, not only something the model says.

| Concept | Topic | Routes |
|---|---|---|
| 30 | Todo tracking: the Task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) vs `TodoWrite`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, the `tools` option, deferred tools and `ToolSearch`, `tool_use_result` (`oldTodos` / `newTodos`, `statusChange`), the task files in `CLAUDE_CONFIG_DIR/tasks/`, `CLAUDE_CODE_TASK_LIST_ID`, `blockedBy`, the `TaskCreated` / `TaskCompleted` hooks, resume, a live todo board | `/api/c30/tools` (SSE), `/run` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/30-todo-tracking.ts` | **New**: the options, the board (disk poller + `TodoWrite` reader), the hooks, the seeded plan, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c30` |
| `src/concepts/Concept30TodoTracking.tsx` | **New**: the tab (Parts A to D), the todo board, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Todo board, todo rows, board-change rows |
| `.gitignore` | Ignores `todo-lab/` |
| `Tab1-query().md` | Adds Concept 30 to the table |

---

## Step 1: Two todo tools

| | **Task tools** | **TodoWrite** |
|---|---|---|
| Tools | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | `TodoWrite` |
| One change is | One call: `TaskUpdate { taskId: "2", status: "completed" }` | The **whole list again**: `TodoWrite { todos: [ … ] }` |
| Stored in | `CLAUDE_CONFIG_DIR/tasks/<list>/<id>.json` | Only the transcript |
| Dependencies | `blockedBy` / `blocks` | No |
| Hooks | `TaskCreated`, `TaskCompleted` | None |

Both use the same three statuses: `pending`, `in_progress`, `completed`. A task also has an `activeForm` ("Writing
total.txt"), the text a UI shows while the task runs. `TaskUpdate` also accepts `status: "deleted"`.

The types are in `sdk-tools.d.ts`: `TaskCreateInput`, `TaskUpdateInput`, `TodoWriteInput`, and their outputs.

## Step 2: Which one the model gets

Measured with the **0 · Which todo tools** button, which sends "Reply ok" once for each setup and reads `system/init`:

| Setup | Todo tools in `system/init` |
|---|---|
| Haiku 4.5, default tool set | `TaskCreate, TaskGet, TaskList, TaskUpdate` |
| Haiku 4.5, `CLAUDE_CODE_ENABLE_TASKS=false` | `TodoWrite` |
| Sonnet 5, default tool set | **none** |
| Sonnet 5, `tools` lists them | `TaskCreate, TaskGet, TaskList, TaskUpdate` |
| Haiku 4.5, `tools: ["Read", "Write"]` | none |

Button **0** runs the five setups above. One more setup was tried only in an earlier probe script, and it is **not**
one of button 0's setups: Sonnet 5 with the default tool set and `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` got
`TaskCreate, TaskGet, TaskList, TaskUpdate`.

Rules:

- **`CLAUDE_CODE_ENABLE_TASKS=false`** swaps the Task tools for `TodoWrite`.
- In the **default tool set**, the todo tools are on for a list of known models (Haiku 4.5, Sonnet 4.5, …). A newer
  model such as `claude-sonnet-5` gets none, unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set.
- With an explicit **`tools`** list, the todo tools are there only if you list them, and then every model gets them.
  The lab always lists them. A short list is also cheaper: "Reply ok" cost $0.004 instead of $0.02.

`Task` in the default list is the **subagent** tool (Concept 8), and `TaskStop` stops a **background** task
(Concept 27). Neither is a todo tool.

## Step 3: Deferred tools, and when the model plans

In the default tool set, the todo tools are **deferred** (Concept 25): their schemas are not in the request. The model
must load them first with `ToolSearch`:

```
tool_use ToolSearch   {"query":"select:TaskCreate","max_results":1}
tool_use TaskCreate   {"subject":"Read prices.csv", …}
```

Two things follow from this:

1. **The model rarely plans unless the prompt asks it to.** Asked to "plan with your task list", Haiku wrote the list
   in plain text and never called `TaskCreate`. Only a prompt that named the tool made it load and use it. A prompt
   with no word about planning (**4 · Not asked to plan**) got no list at all, even with `ENABLE_TOOL_SEARCH=false`
   (every tool loaded) and even with the `claude_code` system prompt. **If you want a todo list, ask for one.**
2. **A deferred tool called before its schema is loaded can fail.** `TaskGet {"id":"1"}` returned an
   `InputValidationError`, and the model then loaded the schema and tried again.

With an explicit `tools` list, the lab's tools are few, so nothing is deferred and there is no `ToolSearch` call.
Scenario **3 · Default tool set** shows the deferred path.

## Step 4: What your code sees

Every todo call arrives as a normal `tool_use` and `tool_result`. The user message that carries the result also has
**`tool_use_result`**, the tool's full output object. These shapes were seen in real runs (shortened):

```ts
// TaskCreate
{ task: { id: "1", subject: "Read prices.csv" } }
// TaskUpdate
{ success: true, taskId: "1", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }
// TaskList
{ tasks: [{ id: "1", subject: "…", status: "pending", blockedBy: [] }, …] }
// TodoWrite: the list before and after
{ oldTodos: [ … ], newTodos: [ … ] }
```

Measured on the same 4-step job (scenarios 1 and 2):

| | Task tools | TodoWrite |
|---|---|---|
| Todo calls | 12 (4 × `TaskCreate`, 8 × `TaskUpdate`) | 5 |
| Turns | 17 | 10 |
| Output tokens | 1,699 | 1,826 |
| Cost | $0.025 | $0.025 |

`TodoWrite` needs fewer calls, because one call can complete a task and start the next. Each call writes more tokens,
though, because it repeats the whole list. After a `TodoWrite` call in which **every** item is `completed`, Claude
Code empties its stored list: the next call's `oldTodos` is `[]`.

## Step 5: A live todo board

The tab shows a **todo board** above the events. It is built in two ways. For the Task tools, the host reads the
files, the same source `TaskList` reads, polled every 250 ms (from `listDir()` and `readDisk()` in
[server/concepts/30-todo-tracking.ts](server/concepts/30-todo-tracking.ts)):

```ts
const listDir = (run: Run) => path.join(CONFIG_DIR, "tasks", (run.listId ?? run.sessionId ?? "none").replace(/[^a-zA-Z0-9_-]/g, "-"));
// …
for (const f of readdirSync(dir)) {
  if (!/^\d+\.json$/.test(f)) continue; // skip .lock and the high-water-mark file
  try {
    const t = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    items.push({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm, blockedBy: t.blockedBy, owner: t.owner });
  } catch {} // being written right now: the next poll reads it
}
```

For `TodoWrite`, nothing is on disk, so `relay()` reads `tool_use_result`:

```ts
if (name === "TodoWrite" && tur?.newTodos) showBoard(run, fromTodoWrite(tur.newTodos), "TodoWrite", emit);
```

A task file looks like this:

```json
{ "id": "2", "subject": "Write total.txt", "description": "Sum the prices …", "activeForm": "Writing total.txt",
  "status": "completed", "blocks": ["3"], "blockedBy": [] }
```

The folder also holds a `.lock` file and a high-water-mark file for the next ID, so the lab reads only `<number>.json`.
Each status change becomes a green **board** row in the event list: `#2 Write total.txt: in_progress → completed`.

Reading the files has one advantage over reading the tool results: it also shows changes the **host** makes (Step 7).

## Step 6: The list's name, and resume

By default, the list is named after the **session ID**: `tasks/<session id>/`. A resumed session keeps its ID, so it
keeps its list. In **7 · Resume keeps the list**, run 1 plans 4 tasks and does one. Run 2 is a new `query()` with
`resume`. The model goes on from task 2, without calling `TaskList` or planning again.

With `TodoWrite`, resume works too: the old `TodoWrite` calls are in the transcript.

## Step 7: The host writes the plan

`CLAUDE_CODE_TASK_LIST_ID` names the list instead of the session ID. The host can then **write the plan before the
run**:

```ts
if (hostList) run.listId = `plan-${run.id}`;
// …
if (run.listId) env.CLAUDE_CODE_TASK_LIST_ID = run.listId; // work on the host's list, not a new one per session
// …
function seedPlan(run: Run) {
  writeTask(run, "1", "Write total.txt", "Sum the prices in prices.csv and write the number to total.txt", [], ["3"]);
  writeTask(run, "2", "Write cheapest.txt", "Write the name of the cheapest item in prices.csv to cheapest.txt", [], ["3"]);
  writeTask(run, "3", "Write report.txt", "Write report.txt with the total and the cheapest item, read from total.txt and cheapest.txt", ["1", "2"]);
}
```

The last two arguments of `writeTask()` are `blockedBy` and `blocks`: task 3 is blocked by 1 and 2.

The prompt only says "Your task list already holds the plan. Use TaskList…". The model sees:

```
#1 [pending] Write total.txt
#2 [pending] Write cheapest.txt
#3 [pending] Write report.txt [blocked by #1, #2]
```

It followed the order and the dependencies in every run. The same variable also lets several sessions (or a
session and your UI) share one list.

## Step 8: Hooks that gate the plan

`TaskCreated` and `TaskCompleted` run **before** the change is saved. Their input has `task_id`, `task_subject` and
`task_description`. Returning `{ decision: "block", reason }` refuses the change:

| Hook | When it blocks |
|---|---|
| `TaskCreated` | The task is deleted and its ID is skipped. The model gets an `is_error` tool_result: "TaskCreated hook feedback: …" |
| `TaskCompleted` | The status stays as it was. The tool_result is **not** `is_error`, but `tool_use_result` is `{ success: false, error: "TaskCompleted hook feedback: …" }` |

Scenario **6 · Hooks gate the plan** uses three rules, in `gate()`. It returns the reason to refuse, or `undefined`
to allow:

```ts
if (name === "TaskCreated") return /delete|remove/i.test(`${subject} ${description}`) ? "Policy: tasks that delete files are not allowed in this lab." : undefined;
// TaskCompleted: check the work for real. A task named "Write x.txt" is done only when x.txt exists.
const file = subject.match(/[\w-]+\.txt/)?.[0];
if (file && !existsSync(path.join(run.work, file))) return `${file} does not exist yet. Write it, then mark task ${taskId} completed again.`;
if (file === "report.txt" && !/^END\s*$/m.test(readFileSync(path.join(run.work, file), "utf8")))
  return "report.txt must end with a line that says END. Fix the file, then mark task 3 completed again.";
```

The creation rule looks at the subject **and** the description. The `END` check allows spaces after `END`.

After task 2, the host also writes `4.json` ("Write dearest.txt") itself.

What happened: the model marked task 3 completed, was refused, read `report.txt`, added `END`, and marked it again.
The delete task was refused. At the end, `TaskList` showed the host's task #4, and the model did it too.

Lessons:

- **The `reason` goes to the model.** Write it as an instruction the model can act on. In a probe, a vague reason
  ("Before completing, check the file…") was **ignored**: the model moved on and task 1 stayed `in_progress` forever.
- **Neither todo tool asks for permission.** `canUseTool` is never called for them. The hooks are how you control
  them. For `TodoWrite`, which has no hooks, use `PreToolUse` with matcher `TodoWrite`.

## Step 9: The host checks the plan

A final "DONE" from the model proves nothing. After each run, the lab reads the board and writes a **host check**
row: `4/4 completed`, or the tasks left and their status, plus the files the agent wrote. This check caught the ignored
refusal in Step 8. It cannot catch **wrong** work: in one resume run, the model wrote a total of 9.75 instead of 8.75
and marked the task completed. Checks that matter belong in `TaskCompleted` (Step 8).

## Step 10: Part D, which one to use

| You want | Use |
|---|---|
| A plan the host can write, share and check | Task tools + `CLAUDE_CODE_TASK_LIST_ID` + the hooks |
| To show the model's progress in a UI | Either: the task files, or `tool_use_result.newTodos` |
| A list that dies with the transcript | `TodoWrite` (`CLAUDE_CODE_ENABLE_TASKS=false`) |
| A model outside the default list (for example Sonnet 5) | List the todo tools in `tools` (or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) |
| The model to plan at all | Ask it to, in the prompt |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/30-todo-tracking.ts](server/concepts/30-todo-tracking.ts) and
[src/concepts/Concept30TodoTracking.tsx](src/concepts/Concept30TodoTracking.tsx). The tab's **code** buttons show
the `options`, `board`, `hooks`, `seed`, `check` and `messages` regions.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, read `TaskCreateInput`, `TaskUpdateInput`,
`TodoWriteInput` and their outputs: they are the shapes of `tool_use_result` (Step 4 of the concept). In
`sdk.d.ts`, search for `TaskCreated` and `TaskCompleted`: their hook inputs carry `task_id`, `task_subject` and
`task_description`. The types say nothing about **which** tool a model gets, or about the task files on disk. The
button **0** and a look inside `CLAUDE_CONFIG_DIR/tasks/` after a first run showed both.

### Step 2: One folder per run

Each scenario gets a fresh work folder with `prices.csv`, so the files of the last run are never there:

```ts
function newRun(mode: Mode, extra: Partial<Run> = {}): Run {
  // Delete the folders of finished runs, keep the ones still running.
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "prices.csv"), PRICES);
  active.add(id);
  return { id, work, mode, board: [], boardJson: "[]", toolNames: new Map(), ...extra };
}
```

- A `Run` holds everything one scenario needs: its folder, its mode (`tasks` or `todo`), the list id, the session id,
  and what the board last showed.
- `toolNames` maps each `tool_use` id to the tool's name, so a `tool_result` can be labelled (`TaskUpdate`,
  `TodoWrite`…).
- All runs share one `CLAUDE_CONFIG_DIR`, `todo-lab/config`. That is where the task lists go.

### Step 3: The options

```ts
env.CLAUDE_CONFIG_DIR = CONFIG_DIR; // the task files go to CLAUDE_CONFIG_DIR/tasks/
if (run.mode === "todo") env.CLAUDE_CODE_ENABLE_TASKS = "false"; // TodoWrite instead of the Task tools
if (run.listId) env.CLAUDE_CODE_TASK_LIST_ID = run.listId; // work on the host's list, not a new one per session
return {
  model: MODEL,
  cwd: run.work,
  // An explicit list: the todo tool must be in it, or the model does not get it. A short list is also cheaper.
  tools: [...FILE_TOOLS, ...(run.mode === "todo" ? ["TodoWrite"] : TASK_TOOLS)],
```

- The two env variables are the whole difference between the modes and between "the session's list" and "the host's
  list" (Steps 2 and 7 of the concept).
- `canUseTool` allows only the file tools inside the run folder, checked with a small `inside(run.work, …)` helper
  built on `path.relative()` (a sibling folder with the same name prefix is refused). It is never called for the
  todo tools: that is how
  the lab found out that they never ask for permission.
- `hooks` sets `taskHook(run, emit)` on `TaskCreated` and `TaskCompleted` (Step 5). `persistSession: true` is there for
  the resume scenario.

### Step 4: The host writes the plan (`seed`)

```ts
const listDir = (run: Run) => path.join(CONFIG_DIR, "tasks", (run.listId ?? run.sessionId ?? "none").replace(/[^a-zA-Z0-9_-]/g, "-"));

function writeTask(run: Run, id: string, subject: string, description: string, blockedBy: string[] = [], blocks: string[] = []) {
  mkdirSync(listDir(run), { recursive: true });
  const task = { id, subject, description, activeForm: subject.replace(/^Write/, "Writing"), status: "pending", blocks, blockedBy };
  writeFileSync(path.join(listDir(run), `${id}.json`), JSON.stringify(task, null, 2));
}
```

- `listDir()` is the one place that knows where a list lives: the host's list id, or else the session id.
- A task file written by the host has the same fields as one written by `TaskCreate`, so `TaskList` shows it the
  same way.
- `seedPlan(run)` calls `writeTask()` three times, with task 3 `blockedBy` 1 and 2.

### Step 5: The hooks (`hooks`)

```ts
function taskHook(run: Run, emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "TaskCreated" && input.hook_event_name !== "TaskCompleted") return {};
    const { hook_event_name: name, task_id, task_subject } = input;
    const verdict = run.gate ? gate(run, emit, name, task_subject, input.task_description ?? "", task_id) : undefined;
    emit("hook", { name, task_id, subject: task_subject, decision: verdict ? "block" : "allow", reason: verdict });
    return verdict ? { decision: "block", reason: verdict } : {};
  };
}
```

- The hook runs in every Task tools scenario, so you always see an `allow` row. It only **blocks** in scenario 6,
  where `run.gate` is `true`.
- `gate()` returns a reason, or `undefined`. The reason is written as an instruction, because it goes to the model
  (Step 8 of the concept).

The completion check looks at the real files:

```ts
const file = subject.match(/[\w-]+\.txt/)?.[0];
if (file && !existsSync(path.join(run.work, file))) return `${file} does not exist yet. Write it, then mark task ${taskId} completed again.`;
if (file === "report.txt" && !/^END\s*$/m.test(readFileSync(path.join(run.work, file), "utf8")))
  return "report.txt must end with a line that says END. Fix the file, then mark task 3 completed again.";
```

After task 2 is allowed to complete, `gate()` also calls `writeTask(run, "4", "Write dearest.txt", …)` once
(`run.hostAdded`), and sends a `call` event so the tab shows what the host did.

### Step 6: The todo board (`board`)

For the Task tools, the board is read from the files, polled every 250 ms:

```ts
function watchDisk(run: Run, emit: Emit) {
  const poll = () => {
    const items = run.mode === "tasks" && (run.listId || run.sessionId) ? readDisk(run) : undefined;
    if (items) showBoard(run, items, "disk", emit);
  };
  const timer = setInterval(poll, 250);
  return () => (clearInterval(timer), poll()); // one last read when the run ends
}
```

- The poll can only start once the list's name is known: the host's `listId`, or the `session_id` that `relay()`
  saves at `system/init`.
- `readDisk()` reads only the `<number>.json` files, skips a file that is being written, and sorts by id.

For `TodoWrite` there is nothing on disk, so `relay()` builds the board from the tool result:

```ts
if (name === "TodoWrite" && tur?.newTodos) showBoard(run, fromTodoWrite(tur.newTodos), "TodoWrite", emit);
```

Both paths end in `showBoard()`, which sends a `board` event only when the list changed, and a `change` event with
one line per status change:

```ts
const before = new Map(run.board.map((i) => [i.id, i.status]));
const changes = items.filter((i) => before.get(i.id) !== i.status).map((i) => ({ id: i.id, subject: i.subject, from: before.get(i.id) ?? null, to: i.status }));
```

That is where the green `#2 Write total.txt: in_progress → completed` rows come from.

### Step 7: One run, then the host check

```ts
async function runOnce(prompt: string, options: Options, run: Run, emit: Emit) {
  const stop = watchDisk(run, emit);
  try {
    for await (const msg of query({ prompt, options })) relay(msg, run, emit);
  } catch (err) {
    emit("error", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  } finally {
    stop();
  }
}
```

After the last `runOnce()`, `check(run, emit)` (the `check` region) counts the board's items that are not
`completed` and lists the files the agent wrote (Step 9 of the concept).

### Step 8: The routes

`POST /run` checks its body with zod. A custom job must have a prompt, and only a custom job may have one:

```ts
const Scenario = z.enum(["tasks", "todo", "defaultTools", "unprompted", "seeded", "gate", "resume", "custom"]);
const RunBody = z
  .object({
    scenario: Scenario,
    prompt: z.string().trim().min(1).max(2000).optional(), // custom only
    mode: z.enum(["tasks", "todo"]).optional(), // custom only
  })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" });
```

Then each scenario is only a different prompt and a few settings:

```ts
const mode: Mode = b.scenario === "todo" ? "todo" : (b.mode ?? "tasks");
const hostList = ["seeded", "gate"].includes(b.scenario);
const run = newRun(mode, { gate: b.scenario === "gate" });
if (hostList) run.listId = `plan-${run.id}`;
```

- `seeded` and `gate` get a host list (`plan-<run id>`), and `seedPlan(run)` writes it **before** `query()`.
- `resume` calls `runOnce()` twice: the second time with `resume: run.sessionId`, so the same session and the same
  task folder.
- `defaultTools` passes `tools: undefined` (Claude Code's full set, where the todo tools are deferred) and a
  `disallowedTools` list, so the model cannot wander off to `Bash` or the web.

`POST /tools` is button **0**. It runs the `SETUPS` list in parallel, one "Reply with the single word: ok" each, with
`maxTurns: 1`, and keeps only the todo tools of `system/init`:

```ts
if (m.type === "system" && m.subtype === "init") row.todoTools = m.tools.filter((t: string) => /^(Task(Create|Get|List|Update)|TodoWrite)$/.test(t));
```

### Step 9: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept30 } from "./concepts/30-todo-tracking.js";
// …
app.use("/api/c30", concept30);
```

### Step 10: The React tab

Every scenario button, and the custom form, calls one `run()` function. `board` events do not go to the event
list: they replace the board.

```tsx
await streamPost("/api/c30/run", body, (event, data) => {
  if (event === "done") return;
  if (event === "opened") return setOptions(data);
  if (event === "board") return setBoard(data);
  got.push({ event, data });
  setEvents([...got]);
});
```

- A scenario button sends `{ scenario: s.id }`. The form sends `{ scenario: "custom", prompt, mode }`.
- `TodoBoard` draws the items. A task that is `in_progress` shows its `activeForm` ("Writing total.txt…"), and a
  blocker is shown only while it is not completed, like `TaskList` does.
- In the `Timeline`, a `tool_result` with `tool_use_result.success === false` is drawn red, because a refused
  `TaskUpdate` is **not** an `is_error` result.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 30, title: "Todo tracking", Component: Concept30TodoTracking },
```

### Step 11: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 30, press **1 · Task tools**: the board fills in from
   `todo-lab/config/tasks/<session id>/*.json`, and the run ends with a host check `4/4 completed`.
3. Press **5 · The host writes the plan**: a `host` row, and a board with 3 tasks before the first `tool_use`.
4. Press **6 · Hooks gate the plan**: red `block` rows, a `success: false` result, and task #4 on the board.

## How to try it

1. `npm run dev`, then open the **30. Todo tracking** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Which todo tools does each setup get?** and look at the Sonnet 5 rows.
3. Press **1 · Task tools** and watch the board fill in from the task files. Then press **2 · TodoWrite**, and compare
   the `tool_use_result` rows (`statusChange` vs `oldTodos` / `newTodos`).
4. Press **3 · Default tool set** and find the `ToolSearch` call. Press **4 · Not asked to plan**: the board stays empty.
5. Press **5 · The host writes the plan**: the board is full before the model starts.
6. Press **6 · Hooks gate the plan**: find the red `block` rows, the `success: false` result, and task #4 added by
   the host.
7. Write your own job in the form, and switch between Task tools and TodoWrite.

Each scenario costs $0.05 or less.
