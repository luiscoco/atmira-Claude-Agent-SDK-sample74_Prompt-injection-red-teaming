# CLAUDE.md & memory

This file explains how Concept 22 (**CLAUDE.md & memory**) was added to the Claude Agent SDK Lab.
Memory files are markdown files that Claude Code adds to the context: `CLAUDE.md`, `CLAUDE.local.md`, the user's
`~/.claude/CLAUDE.md`, `.claude/rules/*.md`, nested `CLAUDE.md` files in subfolders, and the files they import with
`@path`. Concept 9 ([Tab9-System-prompts.md](Tab9-System-prompts.md)) loaded one `CLAUDE.md`. This concept shows
**which** files are read, **when**, and how to see and control it from the SDK.

**Goal:** know which memory files reach the model for a given `settingSources` and `cwd`, which ones load only later,
how to check it (`InstructionsLoaded`, `getContextUsage().memoryFiles`), and how auto memory saves notes between
sessions.

| Concept | Topic | Routes |
|---|---|---|
| 22 | `settingSources` (`project`, `local`, `user`), `CLAUDE.md`, `CLAUDE.local.md`, `@imports`, `.claude/rules/*.md` with and without `paths:`, nested `CLAUDE.md`, parent folders, `claudeMdExcludes`, the `InstructionsLoaded` hook (`load_reason`, `trigger_file_path`, `parent_file_path`), `getContextUsage().memoryFiles`, auto memory (`autoMemoryEnabled`, `autoMemoryDirectory`, `MEMORY.md`), `omitClaudeMd`, reload after `/compact` | `/api/c22/files`, `/reset`, `/run` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `memory-project/` | **New**: 6 memory files and 2 code files, each memory file with a `Marker:` line. The 7th memory file, the user's `CLAUDE.md`, is not committed: the server writes it into `memory-lab/home/` |
| `server/concepts/22-claude-md-memory.ts` | **New**: the three routes |
| `server/index.ts` | Mounts the router on `/api/c22` |
| `src/concepts/Concept22ClaudeMdMemory.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab |
| `.gitignore` | Ignores `memory-lab/` |
| `Tab1-query().md` | Adds Concept 22 to the table |
| `Tab22-CLAUDE-md-and-memory.md` | This explanation |

---

## Step 1: The memory files

```
memory-project/                          <- the agent's cwd
├── CLAUDE.md                            🟦 PROJECT     session start ("project")
├── CLAUDE.local.md                      🟪 LOCAL       session start ("local")
├── docs/style.md                        🟨 IMPORT      pulled in by "@docs/style.md" in CLAUDE.md
├── .claude/rules/testing.md             🟩 RULE        session start (no paths:)
├── .claude/rules/api-validation.md      🟧 PATH-RULE   when a file matching api/**/*.js is read
├── api/CLAUDE.md                        🟥 NESTED      when a file inside api/ is read
├── api/orders.js
└── web/app.js

memory-lab/                              <- recreated by the server (gitignored)
├── home/CLAUDE.md                       ⬜ USER        session start ("user"), a fake ~/.claude
└── auto-memory/                         where auto memory writes (Step 6)
```

Each memory file has one `Marker:` line and one rule (*call it Orbit*, *start with "Hi Ana,"*, *use node:test*…).
The default prompt asks the model to copy every `Marker:` line it can see.

`CLAUDE.md` imports a file with a line of its own:

```markdown
- Code style: @docs/style.md
```

A rule with `paths:` loads only for matching files:

```markdown
---
paths:
  - "api/**/*.js"
---

- Marker: 🟧 PATH-RULE (...)
- Every API handler must validate its input with assertOrder() before using it.
```

## Step 2: `settingSources` decides what is read

| `settingSources` | Loaded at the start | Tested with |
|---|---|---|
| `[]` | Nothing. The model finds no marker | scenario 2 |
| `["project"]` | `CLAUDE.md`, `docs/style.md` (import), `.claude/rules/testing.md` | 1 |
| `["project", "local"]` | The same, plus `CLAUDE.local.md` | 3 |
| `["user", "project"]` | `<CLAUDE_CONFIG_DIR>/CLAUDE.md`, plus the project files | 4 |

**No system prompt is needed.** The lab's base options have no `systemPrompt` at all, and `CLAUDE.md` still loads.
With the `claude_code` preset (scenario 10) the same three files load, but the run costs about **3×** more
($0.0075 against $0.0023) because the system prompt is much bigger. Concept 9 used the preset together with
`settingSources: ["project"]`; it is `settingSources` that loads `CLAUDE.md`.

**The user file, without touching yours.** The `"user"` source reads `CLAUDE.md` from the Claude Code config folder.
The lab sets `env: { ...process.env, CLAUDE_CONFIG_DIR: "memory-lab/home" }`, so your real `~/.claude/CLAUDE.md`
is never read. That folder also receives the CLI's own files (`.claude.json`, `projects/`…), and the run
authenticates with `ANTHROPIC_API_KEY` from `.env`.

## Step 3: Seeing what was loaded

Two sources, shown side by side in the tab:

**The `InstructionsLoaded` hook** fires once per file, when it is read:

```text
session_start     Project  memory-project/CLAUDE.md
include           Project  memory-project/docs/style.md               parent_file_path: memory-project/CLAUDE.md
session_start     Project  memory-project/.claude/rules/testing.md
nested_traversal  Project  memory-project/api/CLAUDE.md               trigger_file_path: memory-project/api/orders.js
path_glob_match   Project  memory-project/.claude/rules/api-validation.md  globs: ["api/**/*.js"], trigger_file_path: …/orders.js
```

`memory_type` is `User`, `Project`, `Local` or `Managed`. A lazy load also carries a `prompt_id`.

**`q.getContextUsage().memoryFiles`** lists `{ path, type, tokens }` for every memory file in the context
(here 50, 41 and 35 tokens).

They do not tell the same story:

| | `InstructionsLoaded` | `memoryFiles` |
|---|---|---|
| Session-start files | Yes, **but not always** (below) | Yes, every time |
| Nested and path rules (lazy) | Yes, with the trigger file | **No**, not even after the file was read |
| Auto memory's `MEMORY.md` | **No** | Yes, as type `AutoMem` |
| After `/compact` | Yes, again, with `load_reason: "compact"` | Same list |

**The hook can miss the session-start calls.** In about 60 runs, 4 got no `session_start` calls at all while
`memoryFiles` listed the files and the model quoted their markers. Three of them were the first run with a fresh
`CLAUDE_CONFIG_DIR`. The tab prints a ⚠ line when `memoryFiles` has a file the hook never reported. Use the hook to
audit or react, and `memoryFiles` when you need to know what is in the context.

## Step 4: Files that load later

| Scenario | What the model reads | Loaded then |
|---|---|---|
| 5 | `api/orders.js` | `api/CLAUDE.md` (`nested_traversal`) and `api-validation.md` (`path_glob_match`) |
| 6 | `web/app.js` | Nothing: no rule matches, and `web/` has no `CLAUDE.md` |
| 9 | `api/orders.js`, then writes a test | Same as 5. The answer follows every file: *Hi Ana,*, `node:test`, single quotes, a comment naming Orbit |

A lazy file arrives **after** the `Read` result, inside the same turn. In scenario 5 the model's second message quotes
five markers: the three from the start, plus 🟥 and 🟧.

**Starting in a subfolder** (scenario 7, `cwd: memory-project/api`):

- `api/CLAUDE.md` is now read at **session start**, and so is the parent folder's `CLAUDE.md`. Claude Code walks up
  from `cwd`. (No `CLAUDE.md` exists above `memory-project/` in this course folder, or it would load too.)
- `.claude/rules/testing.md` of the parent still loads.
- **`docs/style.md` did not load.** The parent's `@docs/style.md` import was not followed from the subfolder, in
  every run.

## Step 5: `claudeMdExcludes`

Simplified from the `exclude` switch in `SWITCHES` in [server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts):

```ts
settings: { claudeMdExcludes: ["**/.claude/rules/testing.md", "**/api/CLAUDE.md"] }
```

Globs are matched against the **absolute** path, hence the `**/`. In scenario 8 `testing.md` is gone from the
start, and reading `api/orders.js` loads only the path rule, not `api/CLAUDE.md`. It applies to user, project and
local files (managed ones can't be excluded).

## Step 6: Auto memory

With auto memory on, the model keeps notes of its own between sessions. Simplified from the `preset` and
`autoMemory` switches and `BASE` in [server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts):

```ts
settings: { autoMemoryEnabled: true, autoMemoryDirectory: "memory-lab/auto-memory" }
systemPrompt: { type: "preset", preset: "claude_code" }   // required, see below
tools: ["Read", "Write", "Edit"]
```

| # | Setup | Prompt | Result |
|---|---|---|---|
| 11 | preset + auto memory | *Remember … my favourite colour is teal. Save it … and add it to the MEMORY.md index.* | `Write user_preferences.md`, `Write MEMORY.md`. 4 turns, ≈ $0.009 |
| 12 | same, **new session** | *What is my favourite colour?* | `MEMORY.md` in `memoryFiles` (`AutoMem`, 19 tokens). *Teal*, 1 turn |
| 13 | preset, auto memory **off** | same | `MEMORY.md` not loaded. *UNKNOWN* |
| — | auto memory, **no preset** | *Remember…* | The model tried to edit `CLAUDE.md` instead. Denied (no `Write` rule), nothing saved |

What it writes:

```markdown
<!-- MEMORY.md: the index, loaded at session start -->
- [Favourite colour is teal](user_preferences.md) — User's colour preference

<!-- user_preferences.md: one memory, read when needed -->
---
name: user_favorite_color
description: "User's favourite colour is teal"
metadata:
  node_type: memory
  type: user
  originSessionId: afe30465-…
  modified: 2026-09-25T14:40:38.329Z
---
User's favourite colour is teal.
```

- **Only `MEMORY.md` is loaded**. The memory files are read on demand. In one run of the plain prompt
  (*"Remember … teal."*) Haiku wrote `user_preferences.md` but **no index**, and the next session answered
  *UNKNOWN*. That is why scenario 11 asks for the index.
- **The preset is required.** The instructions on how to use `MEMORY.md` are part of Claude Code's system prompt.
- **Writes into `autoMemoryDirectory` need no `allowedTools` rule.** `Write` is in `tools` only; the same `Write`
  into `CLAUDE.md` was denied.
- **Always set `autoMemoryDirectory`.** The default is `~/.claude/projects/<sanitized-cwd>/memory/`, in your real
  home. The lab sets it on every run, and keeps `autoMemoryEnabled: false` unless the switch is on.
  (`autoMemoryDirectory` is ignored in a committed `.claude/settings.json`; through `options.settings` it works.)

## Step 7: Subagents and `omitClaudeMd`

Simplified from `checker()` and the `omitClaudeMd` switch in [server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts):

```ts
agents: {
  checker: { description: "...", prompt: "...", tools: [], model: "haiku", background: false, omitClaudeMd: true },
}
```

| # | `omitClaudeMd` | The subagent's answer (the `Agent` tool result) |
|---|---|---|
| 14 | `false` | The three markers: a subagent gets the memory files too |
| 15 | `true` | *"There are no lines that start with 'Marker:'"* |

The main agent keeps its files: in 15 it reported the subagent's answer, then listed the markers from its own
context, even though the prompt said not to.

Two things the tests showed:

- In one probe without `background: false` the model started the subagent **in the background**. The `result`
  arrived first and the run ended while the subagent was still working. The lab sets `background: false` and asks
  for the foreground in the prompt.
- A foreground subagent's own messages are **not** streamed. Its answer is the `tool_result` of the `Agent` call,
  wrapped in a *"[Subagent hand-back] … The report follows:"* preamble and an `agentId: … <usage>` footer. The tab
  strips both.

## Step 8: After `/compact`

Scenario 16 sends *"Say OK."* and then `/compact` in one session. After the `compact_boundary` (1,839 → 988 tokens)
every memory file is read again:

```text
compact  Project  memory-project/CLAUDE.md
include  Project  memory-project/docs/style.md
compact  Project  memory-project/.claude/rules/testing.md
```

The summary replaced the conversation the files were part of, so they are put back. `/compact` costs a model call
(≈ $0.01 here).

**Tested but left out:** `verbatimPrompts: true` (Concept 21) changed nothing here. Session-start, nested and path
rule files all still loaded.

## Step 9: Server routes

**File:** [server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts)

```ts
// The same base for every run. No system prompt (the SDK's minimal one): CLAUDE.md loads anyway.
// Auto memory is off, and its folder is ALWAYS the lab's, so a run never writes to ~/.claude/projects/.../memory/.
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: PROJECT,
  settingSources: ["project"],
  settings: { autoMemoryEnabled: false, autoMemoryDirectory: AUTO },
  tools: ["Read"],
  allowedTools: ["Read"],
  strictMcpConfig: true,
  persistSession: false,
  maxTurns: 6,
};
```

- `GET /files` returns every `.md` in `memory-project/` with its kind (`project`, `local`, `import`, `rule`,
  `path rule`, `nested`), its frontmatter and body, plus the fake user file and whatever auto memory has written.
- `POST /reset` recreates `memory-lab/` (also done when the server starts).
- `POST /run` takes `{ prompts, switches }`, checked with zod: 1 to 4 prompts, sent one after the other in one
  session (streaming input, as in Concept 21's `/session`). The switches are **names** checked against fixed lists: `noProject`,
  `local`, `user` (they build `settingSources`), `subdir`, `exclude`, `preset`, `autoMemory`, `agent`,
  `omitClaudeMd`. It streams a `hook` event per `InstructionsLoaded` call and a `memory` event with
  `getContextUsage().memoryFiles` after `system/init` and after each `result`. Paths are sent relative to the
  sample folder, and `env` is never echoed (it holds the API key).

A body that does not match gets an `error` event with the reason, then `done`. The run stops after 120 s. It logs
a `started` line and one line per result.

## Step 10: Browser flow

**File:** [src/concepts/Concept22ClaudeMdMemory.tsx](src/concepts/Concept22ClaudeMdMemory.tsx)

1. **A · The memory files**: each file, its kind, its marker, and what makes it load. Click a name to see it. Below:
   the auto-memory folder, with a **reset** link.
2. **B · A run**: 16 scenarios, or your own prompts (one per line) and switches. The **What was loaded** table has one
   row per memory file: the `InstructionsLoaded` calls (reason, `memory_type`, ms, trigger or parent) and the
   `memoryFiles` tokens after `init` and at the end. Files that never loaded are dimmed. Then: the subagent's
   answer, the answer, one `result` per prompt, the options, and the message log.

## What to take away

1. **`settingSources` loads memory, not the system prompt.** `"project"` for `CLAUDE.md` and rules, `"local"` for
   `CLAUDE.local.md`, `"user"` for `~/.claude/CLAUDE.md`. `[]` loads none.
2. **Some files load later.** A nested `CLAUDE.md` and a rule with `paths:` arrive when Claude reads a matching file.
   Put folder-specific rules there, not in the root `CLAUDE.md`.
3. **`cwd` matters.** Claude Code walks up to parent folders, so anything above your `cwd` is read too.
4. **To see what loaded, use both sources.** `InstructionsLoaded` gives the reason and the trigger, but it can miss
   session-start calls and never reports `MEMORY.md`. `memoryFiles` gives tokens, but no lazy files.
5. **`claudeMdExcludes` removes files by absolute-path glob.**
6. **Auto memory needs the preset, a `Write` tool, and an index.** Point `autoMemoryDirectory` somewhere you control.
7. **Subagents get the memory files** unless `omitClaudeMd: true`.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts) and
[src/concepts/Concept22ClaudeMdMemory.tsx](src/concepts/Concept22ClaudeMdMemory.tsx). The memory files live in
[memory-project/](memory-project/).

### Step 1: Read the types, then write the memory files

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `InstructionsLoadedHookInput`,
`getContextUsage`, `memoryFiles`, `claudeMdExcludes`, `autoMemoryEnabled`, `autoMemoryDirectory` and
`omitClaudeMd`. The types give the field names (`load_reason`, `trigger_file_path`…), but not **when** each file
loads. So the files in `memory-project/` were written first, each one with a `Marker:` line, and every scenario was
run by hand before it became a button (see Step 1 above for the layout).

### Step 2: The folders, and a fake home

```ts
const PROJECT = path.resolve("memory-project"); // committed: the memory files the tab explains
const LAB = path.resolve("memory-lab"); // recreated by the server (gitignored)
const HOME = path.join(LAB, "home"); // the fake ~/.claude for the "user" source
const AUTO = path.join(LAB, "auto-memory"); // where auto memory writes
// …
/** Recreates memory-lab/: the fake home with its CLAUDE.md, and an empty auto-memory folder. */
function resetLab() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(AUTO, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(path.join(HOME, "CLAUDE.md"), USER_CLAUDE_MD);
}
resetLab();
```

- `PROJECT` is committed and never changes. `LAB` is thrown away and rebuilt, so it can be edited freely.
- The user's `CLAUDE.md` is a string in the code (`USER_CLAUDE_MD`). `resetLab()` writes it into the fake home.
- `resetLab()` runs once when the module loads, and again on `POST /reset`.
- `BASE` (quoted in Step 9 above) always sets `autoMemoryDirectory: AUTO`, so no run can write to your real home.

### Step 3: List the memory files (`GET /files`)

`markdownFiles()` walks a folder and returns every `.md` path. `kindOf()` then says what each file is and what makes
it load:

```ts
/** What kind of memory file each path is, and what makes it load. Must match the layout of memory-project/. */
function kindOf(file: string, frontmatter: Record<string, string>) {
  if (file === "CLAUDE.md") return { kind: "project", loads: 'session start · settingSources "project"' };
  if (file === "CLAUDE.local.md") return { kind: "local", loads: 'session start · settingSources "local"' };
  if (file.startsWith(".claude/rules/"))
    return frontmatter.paths ? { kind: "path rule", loads: `when a file matching ${frontmatter.paths} is read` } : { kind: "rule", loads: "session start (no paths:)" };
  if (file.endsWith("/CLAUDE.md")) return { kind: "nested", loads: `when a file in ${file.slice(0, -"/CLAUDE.md".length)}/ is read` };
  return { kind: "import", loads: "when a memory file has a line @" + file };
}
```

- This is the lab's own label, for Part A. Claude Code does not use it. If you add a file that fits none of these
  rules, it is shown as an `import`.
- `parse()` reads the frontmatter, including a list like `paths:` and one level of nesting (`metadata.type`). That
  is enough for the files auto memory writes.
- The route returns `{ files, auto }`: the project files plus the fake user file, and whatever is in `AUTO`.

### Step 4: Switches, and `settingSources` built from three of them

```ts
function buildOptions(switches: string[]): Options {
  let options: Options = {
    ...BASE,
    settingSources: [
      ...(switches.includes("user") ? (["user"] as const) : []),
      ...(switches.includes("noProject") ? [] : (["project"] as const)),
      ...(switches.includes("local") ? (["local"] as const) : []),
    ],
  };
  // The "user" source reads <CLAUDE_CONFIG_DIR>/CLAUDE.md. A fake home keeps your real ~/.claude out of the lab.
  // (It also moves the CLI's own config files there, so the run authenticates with ANTHROPIC_API_KEY from .env.)
  if (switches.includes("user")) options.env = { ...process.env, CLAUDE_CONFIG_DIR: HOME };
  for (const s of Object.keys(SWITCHES)) if (switches.includes(s)) options = SWITCHES[s](options);
  return options;
}
```

- `noProject`, `local` and `user` are not in `SWITCHES`. They are in `SOURCE_SWITCHES` and only build this array.
- The other switches (`preset`, `subdir`, `exclude`, `autoMemory`, `agent`, `omitClaudeMd`) are small functions in
  `SWITCHES`. They run in the order of that object, not in the order the browser sent.
- `describe()` replaces `env` before the options are sent to the tab, because `process.env` holds the API key.

The request body is checked with zod before any of this runs:

```ts
// The request body. The browser sends only switch names from the lists above, never code or paths.
const known = (x: string) => Object.hasOwn(SWITCHES, x) || SOURCE_SWITCHES.includes(x);
const RunBody = z
  .object({
    prompts: z.array(z.string().trim().min(1).max(MAX_PROMPT)).min(1).max(MAX_PROMPTS),
    switches: z.array(z.string().refine(known, { message: `must be one of ${[...SOURCE_SWITCHES, ...Object.keys(SWITCHES)].join(", ")}` })).max(20).default([]),
  })
  .strict();
```

- Only names found in `SWITCHES` or `SOURCE_SWITCHES` pass. The browser never sends a path.
- A bad body (5 prompts, an unknown switch, an extra key) gets an `error` event with the reason, then `done`.

### Step 5: The route: one hook, and the context snapshots

`POST /run` takes the 1 to 4 checked prompts and pushes them one at a time (the same `input()` generator as Concept
21's `/session`). Two parts are specific to this concept. The hook observer:

```ts
const observer: HookCallback = async (input) => {
  if (input.hook_event_name === "InstructionsLoaded") {
    const { file_path, memory_type, load_reason, globs, trigger_file_path, parent_file_path } = input;
    send("hook", {
      file: short(file_path),
      memory_type,
      load_reason,
      globs,
      trigger: short(trigger_file_path),
      parent: short(parent_file_path),
      at: Date.now() - startedAt,
    });
  }
  return {};
};
```

And the `memoryFiles` snapshot, taken after `system/init` and after each `result`:

```ts
async function memory(when: string) {
  try {
    const { memoryFiles } = await q.getContextUsage({ detail: "summary" });
    send("memory", { when, files: memoryFiles.map((f) => ({ ...f, path: short(f.path) })) });
  } catch (err) {
    send("memory", { when, error: String(err) });
  }
}
```

- The hook returns `{}`: it only watches. Each call becomes one `hook` SSE event.
- `short()` makes every path relative to the sample folder, so the hook paths and the `memoryFiles` paths can be
  compared in the tab.
- `getContextUsage()` is called on the live query `q`. A failure is sent as a `memory` event with `error`, not as a
  run error.
- A 120 s timer aborts a run that takes too long.

### Step 6: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept22 } from "./concepts/22-claude-md-memory.js";
// …
app.use("/api/c22", concept22);
```

### Step 7: The React tab

The tab loads Part A with `loadFiles()` (a `fetch` of `/api/c22/files`). A run streams the events into three lists,
and reloads Part A at the end:

```tsx
await streamPost(
  "/api/c22/run",
  { prompts, switches: form.switches },
  (event, data) => {
    if (event === "options") setSentOptions(data);
    if (event === "hook") setCalls((prev) => [...prev, data]);
    if (event === "memory") setSnapshots((prev) => [...prev, data]);
    if (event === "message") setMessages((prev) => [...prev, data]);
    if (event === "error") setError(data.message);
  },
  ctrl.signal,
);
```

- The `finally` block calls `loadFiles()` again, because auto memory may have written new files.
- The **What was loaded** table has one row per file from Part A. It joins the `hook` calls and the first and last
  `memory` snapshots by path. `toProject()` removes the `memory-project/` prefix so the paths match.
- `unreported` lists the files that `memoryFiles` has but the hook never reported. That is the ⚠ line of Step 3
  above.
- `subagentAnswer()` finds the `tool_result` of the `Agent` call and strips the hand-back preamble and footer.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 22, title: "CLAUDE.md & memory", Component: Concept22ClaudeMdMemory },
```

### Step 8: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 22. Part A lists the memory files with their kind and marker.
3. Run **1 · Session start**: the table shows `session_start` and `include` rows, with tokens.
4. Run **5 · Read a file in api/**: `nested_traversal` and `path_glob_match` appear, with the trigger file.
5. Run **11**, then **12**: Part A shows the files in `memory-lab/auto-memory/`, and the answer is *Teal*.
6. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 22

1. **1**, then **2**, **3**, **4**: the same prompt with each `settingSources`.
2. **5** and **6**: which file triggered what. Then add `web/CLAUDE.md` and run **6** again (no restart needed).
3. Change `paths:` in `.claude/rules/api-validation.md` to `"web/**/*.js"` and run **5** and **6**.
4. **7 · Start in api/**: compare the table with **1**.
5. **11**, **12**, **13** in that order. Then remove the index sentence from the prompt, **reset**, and try again.
6. **9 · Does it obey?**: edit `CLAUDE.local.md` to another name and run it again.
7. **14** and **15**: the same subagent with and without `omitClaudeMd`.

Costs on Haiku: $0.002 to $0.008 per scenario without the preset, $0.003 to $0.008 with it, $0.004 to $0.017 for
**11**, and about $0.012 for **16**.

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **22. CLAUDE.md & memory**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

To call the endpoints without the UI:

```powershell
curl.exe http://localhost:3001/api/c22/files

'{"prompts":["Read api/orders.js. Then list every Marker line you can see."],"switches":["local"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c22/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json

curl.exe -X POST http://localhost:3001/api/c22/reset
```
