# Compaction & context

This file explains how Concept 25 (**Compaction & context**) was added to the Claude Agent SDK Lab.
Every request to the model sends the **whole conversation** again, so the context grows with each turn and each
tool result. When it gets close to the window, Claude Code **compacts**: one extra model call writes a summary, and
the summary replaces the old messages. This concept measures the window, fills it on purpose, and watches both kinds
of compaction, the hooks around them, and what the model still knows afterwards.

**Goal:** read `getContextUsage()`, know when auto-compaction fires and how to move that point, use `/compact`, use
the three compaction hooks, and know what a summary keeps and what it loses.

| Concept | Topic | Routes |
|---|---|---|
| 25 | Compaction & context: `getContextUsage()` (categories and `kind`, `autoCompactThreshold`, `isAutoCompactEnabled`), `settings.autoCompactWindow`, `settings.autoCompactEnabled`, `/compact <instructions>`, auto-compaction in the middle of a turn, `system/status` (`compacting`, `compact_result`), `system/compact_boundary` (`trigger`, `pre_tokens`, `post_tokens`, `duration_ms`, `preserved_messages`), the `PreCompact` hook (`systemMessage` adds instructions, `decision: "block"` cancels), `PostCompact` (`compact_summary`), `SessionStart` with `source: "compact"` (`additionalContext`), too-large tool results saved as `<persisted-output>` | `/api/c25/window`, `/code`, `/run` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/25-compaction-context.ts` | **New**: the reports tool, the hooks, the routes |
| `server/index.ts` | Mounts the router on `/api/c25` |
| `src/concepts/Concept25CompactionContext.tsx` | **New**: the tab (Parts A to C) |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The context bar and the per-turn chart |
| `vite.config.ts` | `server.watch.ignored` for the lab folders: Claude Code locks files in `compact-lab/config` during a run, and watching them crashed Vite with `EBUSY` |
| `.gitignore` | Ignores `compact-lab/` |
| `Tab1-query().md` | Adds Concept 25 to the table |
| `Tab25-Compaction-and-context.md` | This explanation |

---

## Step 1: What is in the context

The model has no memory between requests. Claude Code sends, every time:

1. the **system prompt**,
2. the **tool definitions** (built-in tools, MCP tools, skills),
3. the **messages**: every user prompt, every answer, every tool call and every tool result so far.

`q.getContextUsage()` (a control method on a live `query()`, like in Concepts 12, 15 and 22) returns this, category
by category. Each row has a `kind`:

| `kind` | Meaning |
|---|---|
| `used` | In the window now: `System prompt`, `System tools`, `MCP tools`, `Skills`, `Messages`… |
| `buffer` | Kept free on purpose: `Autocompact buffer`, or `Compact buffer` when auto-compaction is off |
| `free` | What is left |
| `deferred` | Tool schemas that are **not** in the window (behind `ToolSearch`), listed for information only |

Classify rows by `kind`, never by the English `name`. `detail: "summary"` answers from the last response's usage and
is fast between turns; `detail: "full"` (the default) counts each category with the token-count API.

## Step 2: The empty window, in four setups (Part A)

Part A starts four sessions whose prompt is a generator that never sends anything (`silent()`), so **no model call
is made**. It waits for the `ops` MCP server to connect (`q.mcpServerStatus()`), then calls `getContextUsage()`:

| Setup | Used | Window | `autoCompactThreshold` | Rows worth a look |
|---|---|---|---|---|
| default (`systemPrompt` string, `tools: []`, 1 MCP tool) | 124 | 200,000 | 167,000 | System prompt 16, MCP tools 100 |
| `claude_code` preset | 18,933 | 200,000 | 167,000 | System prompt 3,296, System tools 14,156, **System tools (deferred) 14,177**, Skills 1,373 |
| `settings: { autoCompactWindow: 100_000 }` | 124 | 100,000 | 67,000 | **Autocompact buffer 33,000** |
| `settings: { autoCompactEnabled: false }` | 124 | 200,000 | — | **Compact buffer 3,000**, `isAutoCompactEnabled: false` |

Where the threshold comes from, for Haiku 4.5 (read in the CLI and matched by every measurement):

```
effective window = window − min(max output tokens, 20,000)      200,000 − 20,000 = 180,000
threshold        = effective window − 13,000                    180,000 − 13,000 = 167,000
with autoCompactWindow: 100,000                                 100,000 − 20,000 − 13,000 = 67,000
```

`autoCompactWindow` accepts **100,000 to 1,000,000** tokens (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). The lab uses the
smallest one, so compaction happens in a few turns instead of after 167,000 tokens.

## Step 3: The lab session (Part B)

One session with streaming input (Concept 12): the next prompt is sent only after the previous `result`.

- An MCP tool `read_report(n)` returns a weekly ops report of **45,000 characters (about 16k tokens)**. The top of each
  report has an incident code and an owner (`ORCA-117 · team Madrid`…). Report 2 has **one extra line in the
  middle**: *"the rollback window for ORCA-227 closes on Friday at 17:00"*.
- One turn per report: *"Read report n and tell me its incident code in one line."*
- In `manual` mode, then: `/compact Focus on the ops reports.`
- The last turn asks, without tools, for every incident code and owner, the rollback deadline, and **who is on call**.
  The on-call engineer is in no report: only the `SessionStart` hook can provide it.
- After every `result` the server calls `getContextUsage({ detail: "summary" })`, and the tab draws one column per call.
- At the end the server checks the answer for each fact (the "What the model still knew" table). A fact counts only
  on a line that names it without a hedge word such as *unknown* or *maybe* (see "How it was built", Step 7).

Simplified from `baseOptions()` and `POST /run` in [server/concepts/25-compaction-context.ts](server/concepts/25-compaction-context.ts):

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  systemPrompt: "You are an ops assistant. Answer briefly.",
  tools: [],                                      // only the MCP tool
  mcpServers: { ops: opsServer(...) },
  allowedTools: ["mcp__ops__read_report"],
  settingSources: [],
  persistSession: false,
  env: { ...processEnvWithoutClaude, CLAUDE_CONFIG_DIR: "compact-lab/config" }, // Step 7
  settings: { autoCompactWindow: 100_000 },      // + autoCompactEnabled: false in mode "off"
  hooks: { PreCompact: [...], PostCompact: [...], SessionStart: [{ matcher: "compact", hooks: [...] }] },
};
```

## Step 4: Manual compaction with `/compact`

`/compact` is a built-in slash command (Concept 21), sent as a normal user message. Anything after it becomes the
**custom instructions** for the summary. Scenario 1 (two reports, then `/compact`):

```
turn 3  /compact Focus on the ops reports.
status  "compacting"
hook    PreCompact   trigger: manual · custom_instructions: "Focus on the ops reports."
hook    SessionStart source: compact
hook    PostCompact  compact_summary: 4,915 characters
status  null · compact_result: "success"
system/compact_boundary  trigger: manual · pre_tokens 33,512 → post_tokens 1,117 · 13,189 ms
result  success · num_turns 0
```

The context went from 33,493 to 1,419 tokens. `num_turns: 0`, but it is **not free**: the summary is a model call
that reads the whole conversation (+$0.025 here).

## Step 5: Auto-compaction

No `/compact` this time: five reports in the 100k window (scenario 2).

| After turn | Context | |
|---|---|---|
| 1 | 17,174 | |
| 2 | 33,491 | |
| 3 | 49,817 | |
| 4 | 66,143 | just under 67,000 |
| 5 | 17,925 | compacted **during** turn 5 |

Turn 5 called `read_report(5)`. Adding its result would push the next request past the threshold, so **before that
model call** Claude Code compacted (`trigger: "auto"`, `custom_instructions: null`), 77,548 → 12,223 tokens in about
10 s, and then finished the turn: *"ORCA-557"*. Auto-compaction can happen **in the middle of a turn**, between two
tool calls, not only between prompts.

`post_tokens` (12,223) is much more than the summary. `preserved_messages` lists 3 message uuids: the **latest
messages are kept word for word** (here the report 5 tool call and its result), and only the older ones are
summarised.

## Step 6: The three hooks

All three are ordinary SDK hook callbacks (Concepts 7 and 20). Their matcher is the `trigger` (`manual` / `auto`) for
`PreCompact` / `PostCompact`, and the `source` for `SessionStart`.

### `PreCompact`: before the summary call

Simplified from `preCompact` in [server/concepts/25-compaction-context.ts](server/concepts/25-compaction-context.ts):

```ts
const preCompact: HookCallback = async (input) => {
  // input.trigger: "manual" | "auto" · input.custom_instructions: the /compact words, or null
  if (block) return { decision: "block", reason: "..." };          // cancel this compaction
  return { systemMessage: "Keep every incident code with its owner, exactly." }; // ADD instructions
};
```

- `systemMessage` is **appended** to the custom instructions, after the user's `/compact` words. This is the only way
  to steer an **auto** compaction, which has no user text.
- `decision: "block"` cancels it (scenario 4). `status` goes `compacting` then straight back to `null`, with no
  boundary. Claude Code **asks again before the next request**: in the test, `PreCompact` fired in turn 5 and again
  in turn 6, and the context stayed at 82,503 tokens, over the threshold. Blocking is only safe while the model's real
  limit (200k for Haiku) is still far away.

### `PostCompact`: the summary

`input.compact_summary` is the text that now stands for everything before the boundary. The tab shows it in full. It
starts with an `<analysis>` block, then a `<summary>` with sections (*Primary request*, *Key technical concepts*, *All
user messages*, *Pending tasks*, *Current work*, *Optional next step*). Log it, check it, or store it somewhere.

### `SessionStart` with `source: "compact"`: put things back

`SessionStart` runs again after each compaction. Whatever it returns as `additionalContext` is added **after** the
summary, whatever the summary kept. Simplified from `sessionStart` and `hooks` in [server/concepts/25-compaction-context.ts](server/concepts/25-compaction-context.ts):

```ts
SessionStart: [{ matcher: "compact", hooks: [async () => ({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "…the on-call engineer this week is Marta Ruiz." },
})] }]
```

Scenario 3: the recall question was answered with *"On-call this week: Marta Ruiz"*, a fact that was never in the
conversation. Without the hook the answer is "unknown". Use it for rules and state that must survive every
compaction. CLAUDE.md files are reloaded the same way (`InstructionsLoaded` with `load_reason: "compact"`,
Concept 22).

## Step 7: What a summary keeps

| Fact | Where | Survived |
|---|---|---|
| Incident codes + owners | first lines of each report | **Always**, in every run |
| Rollback deadline | one line in the middle of report 2 | **Sometimes**: kept in 2 of the 3 runs that compacted, lost in 1 |
| On-call engineer | only in the `SessionStart` hook | Only with the hook |

A summary is written by a model: it is **lossy and not deterministic**. What was asked about survives. A detail
nobody mentioned may or may not. If something must survive, re-inject it (`SessionStart`), ask for it
(`PreCompact` → `systemMessage`, or `/compact <instructions>`), or store it outside the conversation (a file, memory,
Concept 22).

One side effect was seen in the tests: after an auto-compaction, the next answer once copied the summary's format
(*"Analysis Block … Summary Block"*).

## Step 8: Too-large tool results never enter the context

The first version of the lab used 60,000-character reports, and the context barely grew: about 1,000 tokens per
report instead of 19,000. When a tool result is **over about 50,000 characters**, Claude Code saves it to a file and
sends the model a preview instead:

```
<persisted-output>
Output too large (59.4KB). Full output saved to: compact-lab\config\projects\…\tool-results\toolu_….json
Preview (first 2KB):
…
```

The model can read the file only if it has a `Read` tool, and this lab gives it none. So with the **huge reports**
switch (scenario 6) the model still saw the incident codes (they are in the first 2 KB), but never the rollback
deadline. The reports were cut to 45,000 characters so they stay in the context and can fill it.

The file is written under `<CLAUDE_CONFIG_DIR>/projects/<cwd>/<session>/tool-results/` **even with
`persistSession: false`**. In the first test it landed in the real `~/.claude/projects/` and had to be deleted by
hand. The lab now sets `CLAUDE_CONFIG_DIR=compact-lab/config` (like Concept 23), so these files stay in the sample.

Keeping tool results small is the cheapest context management: page or filter in the tool, return only what the
model needs.

## Step 9: Auto-compaction off

`settings: { autoCompactEnabled: false }` (or `DISABLE_AUTO_COMPACT=1`). Scenario 5 read six reports: 98,815 tokens
in the "100,000" window, and nothing stopped them. `autoCompactWindow` is a **compaction policy**, not a hard limit
(`getContextUsage().over_limit.kind` has the same two words: `compaction_window` vs `hard_limit`). The real limit
is the model's (200k for Haiku), and past it the API refuses the request. Without compaction every request resends
everything, so the last turns are the most expensive.

## Step 10: The costs

| Scenario | Cost (measured) |
|---|---|
| 1 · `/compact` by hand (2 reports) | $0.076 |
| 2 / 3 · auto-compaction (5 reports) | $0.13 |
| 4 · `PreCompact` blocks (5 reports) | $0.13 |
| 5 · auto-compaction off (6 reports) | $0.17 |
| 6 · huge tool results (2 reports) | $0.013 |
| Part A | $0 |

The reports are cached (Concept 15), so each turn mostly pays to **write** its new report to the cache. The
compaction itself cost $0.025 to $0.04.

## Step 11: Which knob, when (Part C)

| Knob | Use it to |
|---|---|
| `q.getContextUsage()` | Measure before you decide: show a meter, warn the user, compact yourself |
| `settings.autoCompactWindow` | Compact earlier than the model's window (cost, speed, or a smaller "working set") |
| `settings.autoCompactEnabled: false` | Short sessions, or a host that decides when to compact |
| `"/compact <instructions>"` | Compact at a good moment (a task is done), with a focus |
| `PreCompact` → `systemMessage` | Tell every compaction, auto included, what must be kept |
| `PreCompact` → `decision: "block"` | Postpone compaction at a bad moment (use with care) |
| `PostCompact` | Log or check the summary |
| `SessionStart`, matcher `compact` | Put rules and state back after every compaction |
| Small tool results | Don't fill the window in the first place |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/25-compaction-context.ts](server/concepts/25-compaction-context.ts) and
[src/concepts/Concept25CompactionContext.tsx](src/concepts/Concept25CompactionContext.tsx). The tab's **code**
buttons show the `options`, `hooks`, `usage` and `messages` regions of the server file.

### Step 1: Read the types, then find the numbers

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `getContextUsage`, `autoCompactThreshold`,
`autoCompactWindow`, `autoCompactEnabled`, `PreCompactHookInput`, `PostCompactHookInput`, `compact_summary`,
`compact_boundary` and `compact_result`. The types do not say **when** compaction fires. So the first probes
measured an empty window (Step 2 above), and then filled one with reports until it compacted. Those probes also found
the 50,000-character limit of Step 8, which is why the reports have their size.

### Step 2: The constants, and a fake config folder

```ts
const MODEL = "claude-haiku-4-5-20251001";
const WINDOW = 100_000; // the smallest autoCompactWindow the CLI accepts: compaction at 100k - 20k output - 13k = 67k
const REPORT_CHARS = 45_000; // about 16k tokens. Over about 50,000 characters the CLI saves the result to a file instead
const HUGE_CHARS = 60_000; //   and the model only gets a preview: the "huge" switch shows it.
const MAX_REPORTS = 6;
const MAX_RUN_MS = 240_000;
// …
const LAB = path.resolve("compact-lab");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
mkdirSync(CONFIG_DIR, { recursive: true });
```

- Every number in the tab comes from these constants: 4 reports of 16k tokens stay under 67k, and the fifth does
  not.
- `MAX_RUN_MS` is 240 s here, not 120 s: a run of six reports plus a compaction takes a while.
- `CONFIG_DIR` is the fake `CLAUDE_CONFIG_DIR` of Step 8 above. The folder is emptied when the server starts.
- `INSTRUCTIONS`, `REINJECTED` and `RECALL` are the fixed texts for the two hooks and the last question.

### Step 3: The reports and the MCP tool

```ts
function report(n: number, chars: number) {
  const lines = [`# Weekly ops report ${n}`, `Incident code: ${code(n)}. Owner: ${owner(n)}.`];
  for (let i = 0; lines.join("\n").length < chars; i++) {
    if (n === 2 && i === 150) lines.push("Note: the rollback window for ORCA-227 closes on Friday at 17:00.");
    lines.push(`Line ${i}: metric ${n}-${i} stayed within normal range; latency ${100 + ((n * i) % 37)} ms, error rate 0.${(n + i) % 9}%.`);
  }
  return lines.join("\n");
}
```

- The report is built in code, so it has an exact size and the facts sit at known places: the code at the top, the
  deadline in the middle of report 2.
- `code(n)` and `owner(n)` are small functions, so the server can later grade the answer with the same values.
- `opsServer()` wraps this in one `read_report` tool with `alwaysLoad: true`. Its `onRead` callback sends a `tool`
  event with the size.

### Step 4: The shared options

```ts
function baseOptions(extra: Partial<Options>, huge = false, onRead: (n: number, chars: number) => void = () => {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  return {
    model: MODEL,
    systemPrompt: SYSTEM,
    tools: [],
    mcpServers: { ops: opsServer(huge, onRead) },
    strictMcpConfig: true,
    allowedTools: ["mcp__ops__read_report"],
    // …
    env,
    ...extra,
  };
}
```

- Both routes use this function, so Part A measures the same setup that Part B fills.
- `extra` comes last, so a setup can replace `systemPrompt`, `tools` or `settings`.
- `describe()` replaces `env`, the MCP server instance and the hook functions with short strings before they are
  sent to the tab.

### Step 5: Measure four empty windows (`GET /window`)

Four sessions start in parallel, one per entry of `SETUPS`. Each one uses the `silent()` prompt, which never sends a
message:

```ts
const q = query({ prompt: silent(stop.signal), options });
try {
  // Before the first message the in-process MCP server may still be connecting, and its tools would be missing.
  for (let i = 0; i < 50; i++) {
    if ((await q.mcpServerStatus()).some((s) => s.name === "ops" && s.status === "connected")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const u = await q.getContextUsage(); // detail "full": each category counted with the token-count API (free)
  // …
} finally {
  stop.abort();
  q.close();
}
```

- Without the wait, the `ops` server may still be connecting, and its tool would be missing from the count. The
  loop waits up to 5 s.
- Only `name`, `tokens` and `kind` of each category are sent. The tab draws the bar from `kind` (Step 1 above).
- `stop.abort()` ends the `silent()` generator, and `q.close()` ends the session. Each call costs $0.

### Step 6: The run (`POST /run`): body, hooks and prompts

The route checks the body first, with zod. `mode` must be one of `MODES`, `reports` an integer from 1 to 6, and
every switch must be one of `SWITCHES`:

```ts
// The request body: a mode, a number of reports, and switch names only.
const RunBody = z
  .object({
    mode: z.enum(MODES),
    reports: z.number().int().min(1).max(MAX_REPORTS),
    switches: z.array(z.enum(SWITCHES)).max(SWITCHES.length).default([]),
  })
  .strict();
// …
const parsed = RunBody.safeParse(req.body ?? {});
// …
if (!parsed.success) {
  send("error", { message: badRequest(parsed.error) });
  return finish();
}
const { mode, reports, switches } = parsed.data;
```

- A bad body (7 reports, an unknown mode, an unknown switch, an extra key) gets an `error` event with the reason,
  then `done`. No session starts.

Then it builds the three hooks of Step 6 above (the `hooks` region). Each one sends a `hook` event with what it saw
and what it returned. The prompts are built from the mode:

```ts
const prompts = [
  ...Array.from({ length: reports }, (_, i) => `Read report ${i + 1} and tell me its incident code in one line.`),
  ...(mode === "manual" ? ["/compact Focus on the ops reports."] : []),
  RECALL,
];
```

- The prompts are sent one after the other by the same `input()` generator as Concept 21's `/session`: the next one
  waits for the previous `result`.
- The browser never sends a prompt. It sends only a mode, a number and switch names.

### Step 7: Stream the events, and grade the answer

The loop turns each SDK message into a small event. The `messages` region handles the two compaction messages:

```ts
if (msg.type === "system" && msg.subtype === "status") {
  send("status", { status: msg.status, compact_result: msg.compact_result, compact_error: msg.compact_error, at: at() });
}
if (msg.type === "system" && msg.subtype === "compact_boundary") {
  send("boundary", { ...msg.compact_metadata, at: at() });
}
```

After every `result`, `usage()` calls `getContextUsage({ detail: "summary" })` and sends a `usage` event: that is one
column of the chart. After the last `result`, the server checks the answer, line by line:

```ts
// A fact counts only on a line that states it without hedging, so "unknown, maybe Friday" is not a pass.
const HEDGE = /\b(unknown|maybe|perhaps|probably|not sure|unsure|not mentioned|don't know|do not know)\b/;
function statedIn(answer: string) {
  const lines = answer.toLowerCase().split(/\n|;/);
  return (...parts: string[]) => lines.some((l) => parts.every((p) => l.includes(p)) && !HEDGE.test(l));
}
// …
const stated = statedIn(lastText);
send("recall", {
  codes: Array.from({ length: reports }, (_, i) => ({ code: code(i + 1), owner: owner(i + 1), found: stated(code(i + 1).toLowerCase()) })),
  rollback: stated("friday") || stated("17:00"),
  onCall: stated("marta"),
});
```

- Every event carries `at`, the ms since the run started. That is how the tab shows that compaction happened
  **inside** turn 5.
- `toolResult` events send the first 600 characters of each tool result, with the lab path shortened. That is where
  the `<persisted-output>` preview shows up.
- The grading is still a simple text search, but stricter. The answer is cut into lines (and at `;`). A fact counts
  only if one line names it and has no hedge word. So *"Rollback: unknown, maybe Friday"* fails, and *"Rollback
  deadline: Friday at 17:00"* passes. The recall prompt already asks for `unknown` when the model does not know, so
  a real answer and a guess end up on different lines.
- This route does not use `pipe()`: it sends its own events and calls `finish()` in `finally`.

### Step 8: Mount the router, and keep Vite quiet

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept25 } from "./concepts/25-compaction-context.js";
// …
app.use("/api/c25", concept25);
```

In [vite.config.ts](vite.config.ts), the lab folders are not watched:

```ts
watch: { ignored: ["**/*-lab/**", "**/sandbox/**"] },
```

- Claude Code writes and locks files in `compact-lab/config` while a run is going on. Vite watched them and crashed
  with `EBUSY`.

### Step 9: The React tab

On load, the tab fetches `/api/c25/window` (Part A) and `/api/c25/code`. **Run the session** sends the form and
sorts the events:

```tsx
await streamPost(
  "/api/c25/run",
  form,
  (event, data) => {
    if (event === "options") return setOptions(data);
    if (event === "usage") return setUsage((u) => [...u, data]);
    if (event === "recall") return setRecall(data);
    if (event === "error") return setError(data.message);
    if (event === "done") return;
    if (event === "hook" && data.event === "PostCompact") setSummaries((s) => [...s, data.compact_summary]);
    if (event === "result") setCost(data.cost); // total_cost_usd is cumulative in one session
    setEvents((e) => [...e, { event, data }]);
  },
  ctrl.signal,
);
```

- `usage` events feed `History`, the column chart, with the threshold as a dashed line.
- `WindowBar` draws one bar from the categories: `used`, then `free`, then `buffer`. `deferred` rows are left out,
  because they are not in the window. The styles are the `ctx-` classes in [src/styles.css](src/styles.css).
- Every other event goes to the `Timeline`, one row each. A `PostCompact` summary is also kept apart, to show it in
  full.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 25, title: "Compaction & context", Component: Concept25CompactionContext },
```

### Step 10: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 25. Part A shows four bars. The `autoCompactWindow` one has its red line at 67,000.
3. Run **B · 1 · /compact by hand**: a `compact_boundary` row appears, and the chart drops.
4. Run **B · 2 · Auto-compaction**: four columns climb to the dashed line, and the fifth falls.
5. The same routes from a terminal: see "Running the app" below. A body with `"reports": 7` gets a `Bad request`
   error event at once, with no model call.

## Things to try

1. **A**: compare the preset with the default: 18,933 tokens before saying anything, and 14,177 more deferred.
2. **B · 1**: open `compact_summary`, find the *All user messages* section, compare `pre_tokens` / `post_tokens`.
3. **B · 2**: watch the chart: four columns climb to the dashed line, the fifth falls. Look at the event times:
   the compaction is inside turn 5.
4. **B · 3**: the recall table goes green for *Marta Ruiz*. Run it again without **SessionStart re-injects**.
5. **B · 4**: count the `PreCompact` rows. The column stays over the line.
6. **B · 5**: the last column is almost at the top, and it cost the most.
7. **B · 6**: read the `<persisted-output>` row, then the red rollback line in the recall table.
8. Use **reports** and the switches to try your own combinations, e.g. `manual` + 5 reports + **PreCompact blocks**
   (a blocked `/compact`).

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **25. Compaction & context**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. Part A loads by itself when the tab
opens and costs $0. A Part B run takes 1 to 3 minutes and costs up to about $0.17 (Step 10).

To call the endpoints without the UI:

```powershell
curl.exe http://localhost:3001/api/c25/window
curl.exe http://localhost:3001/api/c25/code

'{"mode":"manual","reports":2,"switches":["instructions"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c25/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
