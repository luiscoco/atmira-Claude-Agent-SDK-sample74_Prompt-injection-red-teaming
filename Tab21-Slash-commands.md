# Slash commands

This file explains how Concept 21 (**Slash commands**) was added to the Claude Agent SDK Lab.
When a prompt starts with `/`, it is **not** sent to the model as written. Claude Code looks up the name first and
handles it **before** any model call. Concept 11 ([Tab11-Skills.md](Tab11-Skills.md)) showed that a skill can be
typed as `/name`. This concept covers the command files themselves, the built-in commands, and how to control
dispatch from the SDK.

**Goal:** know what each kind of `/name` does in a `query()` run, what a command file can contain, and how to stop
text the user did not type from running a command.

| Concept | Topic | Routes |
|---|---|---|
| 21 | `.claude/commands/*.md`, `$ARGUMENTS`, `$0` / `$ARGUMENTS[0]`, `arguments`, `@file`, `` !`cmd` ``, `allowed-tools`, `disableSkillShellExecution`, `model`, `disable-model-invocation`, subfolders, built-ins, `result.local_command`, `supportedCommands()`, `system/init.slash_commands`, `UserPromptExpansion`, `verbatimPrompts`, `/compact`, `/clear` | `/api/c21/commands`, `/run` (SSE), `/session` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `commands-project/.claude/commands/*.md` | **New**: 8 commands (`standup`, `greet`, `ticket`, `review`, `env-check`, `whoami`, `release`, `frontend/component`) |
| `commands-project/data/sprint.json`, `src/cart.js` | **New**: what the commands read |
| `server/concepts/21-slash-commands.ts` | **New**: the three routes |
| `server/index.ts` | Mounts the router on `/api/c21` |
| `src/concepts/Concept21SlashCommands.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab |
| `Tab1-query().md` | Adds Concept 21 to the table |
| `Tab21-Slash-commands.md` | This explanation |

---

## Step 1: Three kinds of `/name`

| The prompt is… | What happens | Model called? | `result` |
|---|---|---|---|
| A **custom command** (`/greet Ana`) | The file's body replaces the prompt, then the normal loop runs | Yes | `local_command` unset |
| A **built-in** (`/context`, `/cost`, `/usage`, `/model`, `/compact`, `/clear`) | Runs inside Claude Code | No (except `/compact`, see Step 8) | `num_turns: 0`, `local_command: "context"` |
| **Unknown** (`/nope hello`) | Sent to the model as plain text | Yes | The model says it has no such command |

Only a `/` at the **start** of the prompt dispatches. *"Please run /greet Ana"* is plain text. The model may then
run the command itself if it has the `Skill` tool (Step 5).

The expanded body is **not** in the message stream. The transcript only stores
`<command-name>/greet</command-name><command-args>Ana</command-args>`. What you can observe is the
`UserPromptExpansion` hook (Step 6) and the answer. So every command in this lab ends with a marker you can
recognise (☕ 🎫 🔍 🧪 🚢 …).

## Step 2: A command file

A command is a markdown file in `<cwd>/.claude/commands/`. It is found when `settingSources` includes
`"project"`. The file name is the command name:

```
commands-project/                        <- the agent's cwd
├── data/sprint.json
├── src/cart.js
└── .claude/commands/
    ├── standup.md                       /standup
    ├── greet.md                         /greet <name>              $ARGUMENTS
    ├── ticket.md                        /ticket <id> <priority> "<title>"   $0 $1 $2, named arguments
    ├── review.md                        /review                    @src/cart.js
    ├── env-check.md                     /env-check                 !`node -e …`, !`ls data`, allowed-tools
    ├── whoami.md                        /whoami                    model: claude-sonnet-5
    ├── release.md                       /release <version>         disable-model-invocation: true
    └── frontend/component.md            /frontend:component <Name> a subfolder
```

```markdown
---
description: Formats a ticket line from an id, a priority and a title.
argument-hint: <id> <priority> "<title>"
arguments: [id, priority, title]
---

Answer with exactly these two lines, copied literally, and nothing else:
🎫 [ATM-$id] priority=$priority title=$title
positional: $0 | $1 | $2 · all: $ARGUMENTS
```

| Key or syntax | What it does | Tested with |
|---|---|---|
| `description`, `argument-hint` | Shown in `supportedCommands()` (with ` (project)` added to the description) | every command |
| `$ARGUMENTS` | Everything typed after the name | `/greet Ana` → *Hello, Ana!* |
| `$0`, `$1`, … and `$ARGUMENTS[0]` | One argument, **0-based**. `"Fix the CSV export"` in quotes is **one** argument | `/ticket 42 high "Fix the CSV export"` → `42 \| high \| Fix the CSV export` |
| `arguments: [id, priority, title]` | Names the arguments: `$id`, `$priority`, `$title` | same |
| `@src/cart.js` | The file's content is put in the prompt, so no `Read` call is needed | `/review` → 2 bugs found, 1 turn |
| `` !`cmd` `` | Runs a shell command while the command expands. Its output replaces the line | `/env-check` |
| `allowed-tools: Bash(node -e:*)` | Lets a `` !`…` `` line that isn't read-only run without asking | `/env-check` |
| `model: claude-sonnet-5` | This command's turn runs on another model | `/whoami`: `init.model` and `modelUsage` say Sonnet |
| `disable-model-invocation: true` | The model is not told about the command; only a user can type it | `/release` |
| A subfolder | `frontend/component.md` is `/frontend:component`. `/component` does **not** exist | `/frontend:component Button` |

**The `$1` trap:** the first probe used `$1` for the first argument and got `[ATM-high]`. `$0` is the first one.

## Step 3: Shell lines, step by step

`env-check.md` has two lines that run a shell command when the command expands:

```markdown
allowed-tools: Bash(node -e:*)
...
- Node.js: !`node -e "console.log(process.version)"`
- Data files: !`ls data`
```

| Setup | Result |
|---|---|
| `Bash` **not** in `tools` | Expansion fails. `result/success`, 0 turns, $0, `local_command: "custom"`. The error arrives as a replayed user message: `<local-command-stderr>Shell command permission check failed … Permission to use Bash has been denied.` |
| `Bash` in `tools` (not in `allowedTools`) | Both lines run. 1 turn: *node: v24.21.0, data: sprint.json* |
| The same, **without** the `allowed-tools` line | `ls data` is read-only and still runs. `node -e` fails: *This command requires approval* |
| `settings: { disableSkillShellExecution: true }` | Each line becomes `[shell command execution disabled by policy]`. Nothing runs |

**Careful:** `Bash` in `tools` is also available to the **model**. In a test with the shell disabled but `Bash` in
`tools`, the model simply ran `node --version` and `ls` itself. Read-only commands like `ls`, `find` and
`node --version` needed no `allowedTools` rule. That is why scenario 9 turns the shell off with `Bash` left out.

## Step 4: Built-in commands

| Prompt | `local_command` | Output (as a synthetic assistant message and `result.result`) |
|---|---|---|
| `/context` | `context` | A markdown table: tokens by category, including one row per command |
| `/cost`, `/usage` | `cost`, `usage` | *Total cost: $0.0034 … Usage: …* for **this session** |
| `/model` | `model` | *Current model: Haiku 4.5. Usage: /model <name> …* |
| `/compact [instructions]` | `compact` | Summarises the conversation (Step 7). On a fresh session: *Error: No messages to compact* |
| `/clear` | `clear` | A `conversation_reset` message and a **new `session_id`** |
| `/help` | (unset) | *"/help isn't available in this environment."* |

All of them give `num_turns: 0` and `terminal_reason` unset (*"Unset when the loop was bypassed (local slash
command)"* in `sdk.d.ts`).

**Two lists of commands:**

- `system/init.slash_commands` holds **names only**: the custom commands first, then Claude Code's own (42 names
  with the first 7 commands, before `whoami` was added).
- `q.supportedCommands()` returns `{ name, description, argumentHint, builtin? }`: 8 custom and 35 with
  `builtin: true`. The route sends both halves to the tab.

## Step 5: Who runs the command, the user or the model

| Setup | Prompt | Result |
|---|---|---|
| `tools: ["Read"]` | `/greet Ana` | Expanded by the CLI. 1 turn. **The user's `/name` does not need the `Skill` tool.** |
| `tools: ["Read", "Skill"]` | `/greet Ana` | Same answer, but Haiku often calls `Skill` again anyway (*"already loaded above"*): 3 turns |
| `tools: ["Read", "Skill"]` | *"Use the greet command to greet Ana."* | The model runs it: `Skill { skill: "greet", args: "Ana" }`, 3 turns |
| `tools: ["Read", "Skill"]` | *"Use the release command…"* | *"I don't see a release command"*: `disable-model-invocation` hides it |
| any | `/release 2.0` | Works: the user can always type it |

So the lab's base options leave `Skill` out. It is added only for the "the model runs one" scenarios.

## Step 6: The `UserPromptExpansion` hook

Concept 20 found that `UserPromptExpansion` never fired. That is because it fires **only for a slash command**,
before `UserPromptSubmit`:

```text
UserPromptExpansion  { expansion_type: "slash_command", command_name: "greet", command_args: "Ana",
                       command_source: "projectSettings", prompt: "/greet Ana" }
UserPromptSubmit     { prompt: "/greet Ana" }
```

It does not fire for built-ins, unknown commands, or with `verbatimPrompts`. The `freeze-release` hook blocks
one command:

```ts
if (input.hook_event_name !== "UserPromptExpansion" || input.command_name !== "release") return {};
return { decision: "block", reason: "Freeze-release hook: no releases this week." };
```

The result: 0 turns, $0, `local_command: "custom"`, a `system/informational` warning with
`prevent_continuation: true`, and `result.result` = *"UserPromptExpansion operation blocked by hook: … Original
prompt: /release 2.0"*.

## Step 7: `verbatimPrompts`, for text the user did not type

If your app builds the prompt from a ticket, an email or a web page, a line starting with `/` would run a
command. `verbatimPrompts: true` delivers every prompt **as written**: no slash-command dispatch and no `@path`
expansion.

| Prompt | `verbatimPrompts` | Result |
|---|---|---|
| `/release 9.9` | off | *🚢 Release 9.9 is out* |
| `/release 9.9` | **on** | No `UserPromptExpansion`. The model gets the text and can't run `release` (user-only) |
| `/greet Ana` | **on**, `Skill` in `tools` | Not dispatched, but the **model** read `/greet Ana` and called `Skill(greet)` |

So `verbatimPrompts` stops the **CLI** from dispatching. It does not stop the **model** from choosing a command
it can see. Pair it with `disable-model-invocation` on anything dangerous, or leave `Skill` out of `tools`.
(The type doc also says a verbatim turn skips the CLI's turn-start context, such as nested `CLAUDE.md`.)

## Step 8: Commands in one session

`/session` sends several prompts **in one `query()`**, each one after the previous `result` (streaming input,
Concept 12). With the *Compact & clear* preset:

| # | Prompt | `local_command` | Turns | Total cost | Session |
|---|---|---|---|---|---|
| 1 | Remember this: the code word is PINEAPPLE… | — | 1 | $0.0015 | `18ba…` |
| 2 | `/greet Ana` | — | 1 | $0.0041 | `18ba…` |
| 3 | `/context` | `context` | 0 | $0.0041 | `18ba…` |
| 4 | `/compact Keep only the code word.` | `compact` | 0 | **$0.0089** | `18ba…` · `compact_boundary` 1,643 → 677 tokens |
| 5 | What is the code word? | — | 1 | $0.0112 | `18ba…` → *PINEAPPLE* |
| 6 | `/clear` | `clear` | 0 | **$0.0000** | **`3449…`** · `conversation_reset` |
| 7 | What is the code word…? | — | 1 | $0.0017 | `3449…` → *UNKNOWN* |

- `/compact` has **0 turns but is not free**: the summary is a model call (≈ $0.005 here). It streams
  `system/status: compacting`, then `compact_boundary` with `pre_tokens` / `post_tokens`, and a replayed
  `<local-command-stdout>Compacted</local-command-stdout>`.
- `/clear` starts a new conversation inside the same `query()`: a new `session_id`, and `total_cost_usd` starts
  again from $0. `total_cost_usd` is cumulative **per session**, not per prompt.

## Step 9: Server routes

**File:** [server/concepts/21-slash-commands.ts](server/concepts/21-slash-commands.ts)

```ts
// The same base for every run. No "Skill" tool: a user's /name works without it (see the "switches" below).
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: PROJECT,
  settingSources: ["project"], // discovers <cwd>/.claude/commands/
  settings: { disableBundledSkills: true }, // keeps the command list short (Concept 11)
  tools: ["Read"],
  allowedTools: ["Read"],
  strictMcpConfig: true,
  persistSession: false,
  maxTurns: 6,
};
```

- `GET /commands` reads every `.md` under `.claude/commands/` (a subfolder file is named `folder:file`) and returns
  its frontmatter and body.
- `POST /run` takes `{ prompt, switches, hooks }`, checked with zod. The switches (`skillTool`, `bash`, `noShell`,
  `verbatim`, `noProject`) and hooks (`freeze-release`) are **names**, checked with `Object.hasOwn` against fixed
  lists. Every run also gets an observer on `UserPromptExpansion` and `UserPromptSubmit`, streamed as `hook` events.
  After `system/init` it sends `q.supportedCommands()` split into custom and built-in.
- `POST /session` takes 1 to 8 prompts and pushes each one after the previous `result`. It sends a `turn` event
  before each prompt, so the tab can group the messages.

A body that does not match gets an `error` event (for example *"Bad request: switches.0: must be one of skillTool,
bash, …"*) and `done`. Both SSE routes stop a run after 120 s. `/run` logs a `started` line and a line for its
`result`. `/session` logs a line when it starts and a `session closed` line at the end.

## Step 10: Browser flow

**File:** [src/concepts/Concept21SlashCommands.tsx](src/concepts/Concept21SlashCommands.tsx)

1. **A · The command files**: every command, its file, its frontmatter. Click a name to see the body.
2. **B · One prompt**: pick one of 16 scenarios, or type a prompt and tick switches. The **How the prompt was
   handled** card says, in one sentence, whether the prompt was expanded, run as a built-in, blocked, run by the
   model with `Skill`, or sent as plain text. Below it: the prompt hooks, local command output, the answer, the
   result (`local_command`, `terminal_reason`, `init.model` vs `modelUsage`), and the `supportedCommands()` list.
3. **C · Several prompts in one session**: one prompt per line. Each row shows `local_command`, turns, the running
   total cost, the session id, and any `compact_boundary` or `conversation_reset`.

## What to take away

1. **A leading `/` is handled before the model.** Custom commands are prompt templates, built-ins are local
   actions, and unknown names cost a turn.
2. **Arguments are 0-based.** Use `$0` for the first one, or give them names with `arguments:`.
3. **`@file` and `` !`cmd` `` run while the command expands**, before the model sees anything. Shell lines need
   `Bash` in `tools`, and `allowed-tools` for anything that isn't read-only. `disableSkillShellExecution` turns
   them off.
4. **The user's `/name` doesn't need the `Skill` tool. The model's use of a command does.**
   `disable-model-invocation` keeps a command for users only.
5. **Guard commands with `UserPromptExpansion`.** It sees `command_name` and `command_args` and can block.
6. **Use `verbatimPrompts` for text your users didn't type**, and remember it doesn't hide commands from the
   model.
7. **Built-ins report through `result`**: `num_turns: 0`, `local_command`, no `terminal_reason`. `/compact` still
   costs a model call, and `/clear` gives a new `session_id`.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/21-slash-commands.ts](server/concepts/21-slash-commands.ts) and
[src/concepts/Concept21SlashCommands.tsx](src/concepts/Concept21SlashCommands.tsx). The command files live in
[commands-project/.claude/commands/](commands-project/.claude/commands/).

### Step 1: Read the types, then write the command files

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `SlashCommand`, `supportedCommands()`,
`local_command`, `verbatimPrompts`, `UserPromptExpansionHookInput` and `disableSkillShellExecution`. The types
list the fields, but not the frontmatter keys of a command file. So the 8 files in `commands-project/` were written
one by one and each one was run with a short script. Every body ends with a marker (☕ 🎫 🔍 …), because the
expanded body never appears in the message stream (see Step 1 above).

### Step 2: The constants and the base options

```ts
const PROJECT = path.resolve("commands-project");
const COMMANDS = path.join(PROJECT, ".claude", "commands");
const MAX_RUN_MS = 120_000;
const MAX_PROMPT = 2000;
```

- `PROJECT` is the agent's `cwd`. Claude Code finds `.claude/commands/` inside it because `BASE` has
  `settingSources: ["project"]` (the full `BASE` object is quoted in Step 9 above).
- `COMMANDS` is only used by the server itself, to list the files for Part A.
- `MAX_RUN_MS` and `MAX_PROMPT` are the limits that every route checks.

### Step 3: List the command files (`GET /commands`)

```ts
/** Every .md under .claude/commands/. A file in a subfolder is named "<folder>:<file>". */
function readCommands(dir = COMMANDS, prefix = ""): { name: string; file: string; frontmatter: Record<string, string>; body: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return readCommands(path.join(dir, d.name), `${prefix}${d.name}:`);
    if (!d.name.endsWith(".md")) return [];
    const file = path.join(dir, d.name);
    return [{ name: prefix + d.name.slice(0, -3), file: path.relative(PROJECT, file).replaceAll("\\", "/"), ...parse(readFileSync(file, "utf8")) }];
  });
}
```

- The function calls itself for a subfolder and adds `folder:` to the name. That is the same naming rule as
  Claude Code's (`/frontend:component`).
- `parse()` is a tiny frontmatter reader: `key: value` lines between the two `---`. It is enough for these files,
  but it is not a full YAML parser.
- This is only for display. The SDK does not use this list: it scans the folder itself.

### Step 4: Switches and hooks, by name only

The browser can change the options, but only by sending **names** from two fixed lists:

```ts
const SWITCHES: Record<string, (o: Options) => Options> = {
  // The Skill tool is how the MODEL runs a command. The user's "/name" does not need it.
  skillTool: (o) => ({ ...o, tools: [...(o.tools as string[]), "Skill"] }),
  // !`cmd` lines run through Bash. It is in `tools` but NOT in allowedTools: the command's allowed-tools grants it.
  bash: (o) => ({ ...o, tools: [...(o.tools as string[]), "Bash"] }),
  // …
  verbatim: (o) => ({ ...o, verbatimPrompts: true }),
  // No filesystem settings: .claude/commands/ is not scanned.
  noProject: (o) => ({ ...o, settingSources: [] }),
};
// …
// The request bodies. The browser sends only names from the two lists above, never code or paths.
const Names = (known: Record<string, unknown>) =>
  z.array(z.string().refine((x) => Object.hasOwn(known, x), { message: `must be one of ${Object.keys(known).join(", ")}` })).max(10).default([]);
const RunBody = z.object({ prompt: z.string().trim().min(1).max(MAX_PROMPT), switches: Names(SWITCHES), hooks: Names(HOOKS) }).strict();
const SessionBody = z.object({ prompts: z.array(z.string().trim().min(1).max(MAX_PROMPT)).min(1).max(MAX_PROMPTS) }).strict();
```

- Each switch is a small function that returns **new** options. They can be combined in any order.
- The zod schemas check the request bodies. `Names()` accepts only known names. `Object.hasOwn` also refuses names
  like `constructor` or `__proto__`.
- `.strict()` refuses any extra key, and `.default([])` lets a client leave out `switches` or `hooks`.
- `HOOKS` has one entry, `freeze-release`, the hook quoted in Step 6 above.

### Step 5: Trace the prompt hooks (`buildHooks`)

```ts
function buildHooks(picked: string[], send: (event: string, data: unknown) => void, startedAt: number) {
  const traced =
    (name: string, fn: HookCallback): HookCallback =>
    async (input, id, opts) => {
      const output = await fn(input, id, opts);
      const { session_id, transcript_path, cwd, ...rest } = input as unknown as Record<string, unknown>;
      send("hook", { name, event: input.hook_event_name, input: rest, output, at: Date.now() - startedAt });
      return output;
    };
  const observer: HookCallback = async () => ({});
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of ["UserPromptExpansion", "UserPromptSubmit"] as const) hooks[event] = [{ hooks: [traced("observer", observer)] }];
  for (const name of picked) (hooks[HOOKS[name].event] ??= []).push({ hooks: [traced(name, HOOKS[name].fn)] });
  return hooks;
}
```

- Every run gets an `observer` that does nothing (`{}`). It is there only so the tab can see **whether** a command
  was expanded, and when.
- `traced()` wraps any hook: it runs it, then sends a `hook` SSE event with the input and the answer.
- The hooks are functions, so JSON cannot show them. `describe()` replaces them with `"[Function observer]"` in the
  `options` event.

### Step 6: The routes

`POST /run` checks the body, applies the switches, and streams the run. After `system/init` it also asks for the
command list:

```ts
concept21.post("/run", (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  const startedAt = Date.now();
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    send("done", {});
    return res.end();
  }
  const { prompt, switches, hooks: picked } = parsed.data;

  let options = BASE;
  for (const s of switches) options = SWITCHES[s](options);
  options = { ...options, hooks: buildHooks(picked, send, startedAt) };
  // …
  const q = query({ prompt, options: { ...options, abortController: abort } });
  async function* run() {
    let listed = false;
    for await (const msg of q) {
      yield msg;
      // Once the session is up: the full command list, split into the ones defined on disk and Claude Code's own.
      if (msg.type === "system" && msg.subtype === "init" && !listed) {
        listed = true;
        const all = await q.supportedCommands();
        send("commands", { custom: all.filter((c) => !c.builtin), builtin: all.filter((c) => c.builtin).map((c) => c.name) });
      }
      // …
    }
  }
  pipe(run());
});
```

- The zod check comes first. A bad body gets an `error` event with the reason (`badRequest()`), then `done`, and no
  query starts.
- `openSse()` (in [server/sse.ts](server/sse.ts)) gives `send` for custom events and `pipe` for the messages. Its
  `abort` fires when the browser closes the stream, so **Stop** also stops the query.
- `supportedCommands()` is called on the live query `q`, once, after `init`. The `builtin` flag splits the list.
- `guard()` starts a 120 s timer that aborts a run that takes too long.

`POST /session` sends several prompts in one `query()`. The next prompt waits for the previous `result`:

```ts
let next: (() => void) | undefined;
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (const [index, text] of prompts.entries()) {
    send("turn", { index, prompt: text });
    yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
    await new Promise<void>((resolve) => (next = resolve));
  }
}
```

- The generator stops at the `await` until `untilLast()` sees a `result` and calls `next?.()`.
- After the last `result`, `untilLast()` returns. That ends the query, and the input generator is simply left
  waiting.
- The body is checked first with `SessionBody`: 1 to 8 prompts, each one not empty and at most 2000 characters. A
  bad body gets an `error` event and `done`, and no session starts.

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept21 } from "./concepts/21-slash-commands.js";
// …
app.use("/api/c21", concept21);
```

### Step 8: The React tab

The tab loads Part A with a plain `fetch("/api/c21/commands")`. Part B sends the form (prompt, switches, hooks) to
`/run` and sorts the SSE events into state:

```tsx
function run() {
  setMessages([]);
  setCalls([]);
  setListed(null);
  setSentOptions(null);
  setError(null);
  stream(
    "run",
    "/api/c21/run",
    form,
    (event, data) => {
      if (event === "options") setSentOptions(data);
      if (event === "commands") setListed(data);
      if (event === "hook") setCalls((prev) => [...prev, data]);
      if (event === "message") setMessages((prev) => [...prev, data]);
      if (event === "error") setError(data.message);
    },
    setError,
  );
}
```

- `stream()` wraps `streamPost()` with an `AbortController`, a running state and a live seconds counter.
- The **How the prompt was handled** card comes from `verdict()`. It reads the hook calls and the `result`: a
  blocked hook, `local_command`, a `UserPromptExpansion` call, a `Skill` tool call, or none of them.
- The `SWITCHES` and `HOOKS` names are repeated in `switchInfo` and `hookInfo` at the top of the file. They must
  match the server's lists.
- In Part C, `runSession()` adds a new row at each `turn` event and puts every `message` in the last row.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 21, title: "Slash commands", Component: Concept21SlashCommands },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 21. Part A lists 8 commands.
3. Run **2 · $ARGUMENTS**: the prompt hooks card shows `UserPromptExpansion` before `UserPromptSubmit`.
4. Run **13 · Built-in: /context**: 0 turns, `local_command: context`.
5. Run the **Compact & clear** session in Part C and check the new session id after `/clear`.
6. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 21

1. **3 · Positional & named**: change `$0` to `$1` in `ticket.md` and run it again (no restart needed).
2. **7**, **8**, **9**: the same command with no Bash, with Bash, and with the shell disabled.
3. Remove the `allowed-tools` line from `env-check.md` and run **8**: only `ls data` still works.
4. **12 · User-only command**, then type `/release 2.0`. Then remove `disable-model-invocation` and run **12** again.
5. **14 · Untrusted text**: untick `verbatimPrompts`, then tick it together with `tools + "Skill"` and try `/greet Ana`.
6. **C · Compact & clear**: compare `pre_tokens` and `post_tokens`, and the session id before and after `/clear`.
7. Add `.claude/commands/<you>.md` and run `/<you>` — it appears in Part A after a refresh.

Costs: $0 to $0.013 per scenario on Haiku. Built-ins and blocked commands cost $0. `/whoami` runs on Sonnet
(≈ $0.004). The *Compact & clear* session costs about $0.011 in total.

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **21. Slash commands**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

To call the endpoints without the UI:

```powershell
'{"prompt":"/greet Ana","switches":[],"hooks":[]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c21/run -H "Content-Type: application/json" -d "@body.json"

'{"prompts":["/greet Ana","/cost"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c21/session -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
