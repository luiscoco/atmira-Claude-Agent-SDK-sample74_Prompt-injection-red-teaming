# V2 session API

This file explains Concept 41 (**the V2 session API**) of the Claude Agent SDK Lab. From SDK 0.1.54 to 0.2.141 there
was a second way to talk to Claude Code, next to `query()`: `unstable_v2_createSession()` returned a **session object**
with `send()`, `stream()` and `close()`. It was marked `@deprecated` ("Use `query()` instead") in 0.2.133 and **removed**
in 0.3.142. This lab uses 0.3.281, which has none of it.

So this concept is a **migration lesson**. The lab installs the last release that had V2 (0.2.141) next to today's SDK,
runs the old API for real, resumes its sessions with today's `query()`, and rebuilds the same session object on
`query()` with streaming input (Concept 12).

**Goal:** know V2 when you meet it in older code or blog posts, see why it went away, and move it to `query()`.

| Concept | Topic | Routes |
|---|---|---|
| 41 | The V2 session API: `unstable_v2_prompt`, `unstable_v2_createSession`, `unstable_v2_resumeSession`, `SDKSession` (`send`, `stream`, `sessionId`, `close`), its history, the npm alias, V2 as a wrapper over streaming input, resuming V2 sessions with `query()`, a `createSession()` on `query()`, four ways compared (processes, sessions, time, cost), `SDKSessionOptions` vs `Options` | `/api/c41/facts`, `/state`, `/v2` (SSE), `/resume` (SSE), `/compare` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | **New dependency**: `"claude-agent-sdk-v2": "npm:@anthropic-ai/claude-agent-sdk@0.2.141"` (an npm alias, next to 0.3.281) |
| `server/concepts/41-v2-session-api.ts` | **New**: the facts, the V2 runs, the resume, `createSession()` on `query()`, the four-way comparison, the routes |
| `server/concepts/41-launcher.mjs` | **New**: stands in for `claude.exe`, logs one line per Claude Code process, then starts the real binary |
| `server/index.ts` | Mounts the router on `/api/c41` |
| `src/concepts/Concept41V2SessionApi.tsx` | **New**: the tab, Parts A to G |
| `src/App.tsx` | Adds the tab |
| `.gitignore` | Ignores `v2-lab/` |
| `Tab1-query().md` | Adds Concept 41 to the table and the project tree, the sample41 path |

---

## Step 1: The smallest example

What V2 code looked like (SDK ≤ 0.2.141), and the same with today's SDK:

```ts
// ── V2 (removed in 0.3.142) ─────────────────────────────────────────
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk"; // 0.2.x only

const session = unstable_v2_createSession({ model: "claude-haiku-4-5-20251001" });
for (const text of ["My name is Ana.", "What is my name?"]) {
  await session.send(text);
  for await (const m of session.stream()) {        // ends by itself after this turn's result
    if (m.type === "result") console.log(m.result);
  }
}
session.close();

// ── Today: streaming input (Concept 12) ─────────────────────────────
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const user = (text: string): SDKUserMessage => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } });
const script = ["My name is Ana.", "What is my name?"];

const input = inputQueue();                         // an async generator you can push into (Concept 12)
const q = query({ prompt: input.stream, options: { model: "claude-haiku-4-5-20251001", settingSources: [] } });
input.push(user(script[0]));
let turn = 0;
for await (const m of q) {                          // ONE stream for every turn
  if (m.type !== "result") continue;
  console.log(m.result);
  if (++turn < script.length) input.push(user(script[turn]));
  else input.close();                               // the normal end: Claude Code finishes and exits
}
```

If you want V2's shape back, `createSession()` in `41-v2-session-api.ts` (Step 5) gives you the same `send()` /
`stream()` / `close()` on top of `query()`, in about 60 lines.

## Step 2: The lab

- **Two SDKs in one project.** npm installs a package under another name with an alias:
  ```powershell
  npm install "claude-agent-sdk-v2@npm:@anthropic-ai/claude-agent-sdk@0.2.141"
  ```
  `import("claude-agent-sdk-v2")` loads 0.2.141 with **its own** Claude Code binary (2.1.141, in its nested
  `node_modules`). `@anthropic-ai/claude-agent-sdk` stays 0.3.281 (Claude Code 2.1.281). The server loads the old one
  only when a Concept 41 route needs it.
- **One config folder for both CLIs.** Every run uses `CLAUDE_CONFIG_DIR=v2-lab/config`, so the old and the new
  Claude Code read and write the same session files (Part C).
- **Auto memory off.** In the first probe, turn 1 saved "Ana teaches TypeScript" to auto memory (Tab22) with the
  `Write` tool, and a later session "remembered" it without the transcript. The lab sets
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: here, only the session remembers.
- **A process counter.** `41-launcher.mjs` is set as `pathToClaudeCodeExecutable` in every run. Both SDKs start a
  `.mjs` path with node; the launcher logs `{ pid, resume }` and starts the real binary with the same stdin/stdout.
- **The script** (the same three turns as Concept 12): *"My name is Ana and I teach a TypeScript course"*,
  *"Suggest a catchy title for my course"*, *"What is my name, and what do I teach?"*. The third answer only comes
  right if the session kept the first.

## Step 3: What V2 was, and where it went (Part A)

From `npm view @anthropic-ai/claude-agent-sdk time` and a bisect of every release's `sdk.d.ts`:

| SDK | Published | What happened |
|---|---|---|
| `0.1.54` | 2025-11-26 | `unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt` appear ("V2 API - UNSTABLE", `@alpha`) |
| `0.2.133` | 2026-05-07 | All five V2 declarations get `@deprecated Use query() instead. The V2 session API will be removed in a future release.` |
| `0.2.141` | 2026-05-13 | The last release with V2 |
| `0.3.142` | 2026-05-14 | V2 is gone |

The tab checks it live: `Object.keys(await import(…))` finds the three `unstable_v2_*` functions in 0.2.141 and none in
0.3.281. It also reads the five doc comments from the old `sdk.d.ts`.

**Why it went away** is visible in its own source. `SDKSession`'s constructor (in `sdk.mjs` of 0.2.141) builds an
input queue, the same internal `Query` that `query()` returns, and calls `query.streamInput(queue)`. `stream()` reads
that `Query` until the next `result`, and `unstable_v2_prompt` is `createSession` + `send` + the first `result` +
dispose. V2 was a thinner, more limited copy of streaming input, so it was dropped in favour of `query()`.

## Step 4: The V2 API, live (Part B)

Scenario **2** (one tab run, times from the start):

```text
call  const session = unstable_v2_createSession(options)
call  session.sessionId                         → throws: Session ID not available until after receiving messages
call  await session.send("My name is Ana and I teach a TypeScript course. …")
call  for await (const m of session.stream())
      system/init  Claude Code 2.1.141 · 27 tools · session f6810bdb     1.0 s
      result/success  Hi Ana! I'm ready to help …      total_cost_usd $0.0027
call  // stream() returned by itself after the result
      …turns 2 and 3 in the same process…
      result/success  Your name is Ana and you teach a TypeScript course.   $0.0079
call  session.sessionId                         → f6810bdb-5582-43f0-b935-e2cfcc5b3dad
call  session.close()
call  await session.send("One more?")           → throws: Cannot send to closed session
```

What to notice:

- `stream()` is **per turn**: it returns after each `result`. A `Query` is one stream for every turn.
- `system/init` comes again at the start of every turn. `total_cost_usd` is the session's **running total**.
- `sessionId` throws until the first message, and a closed session refuses `send()`.
- V2 always offers **every built-in tool** (27 in 2.1.141): `SDKSessionOptions` has no `tools` field.

Scenario **1**, `unstable_v2_prompt()`, returns the `SDKResultMessage` directly (about $0.03 on a cold cache).

## Step 5: The replacement (Parts C and D)

**Stored sessions survive the upgrade.** A session is a JSONL file, not a V2 object. Scenario **3** resumes the V2
session with `unstable_v2_resumeSession(id)`. Scenario **4** resumes the **same id** with today's
`query({ prompt, options: { resume: id } })`: Claude Code 2.1.281 reads what 2.1.141 wrote and answers *"Your name is
Ana and you teach TypeScript"*. It costs more the first time ($0.0225 against $0.0023): the new CLI sends another
system prompt and 30 tools, so the old prompt cache does not apply.

**`createSession()` on `query()`** (the `wrapper` region):

```ts
export function createSession(options: Options) {
  const input = inputQueue();
  const live: Query = query({ prompt: input.stream, options });
  const messages = live[Symbol.asyncIterator]();
  let sessionId = options.resume ?? null;
  let closed = false;
  return {
    get sessionId() { if (!sessionId) throw new Error("Session ID not available until after receiving messages"); return sessionId; },
    query: live,                                   // V2 hid it: interrupt(), setModel()… still work (Concept 26)
    async send(message: string | SDKUserMessage) { /* push into the queue, or throw when closed */ },
    async *stream() {                              // one turn: returns after the result, like V2
      while (true) {
        const { value, done } = await messages.next();
        if (done) return;
        if (value.type === "system" && value.subtype === "init") sessionId = value.session_id;
        yield value;
        if (value.type === "result") return;
      }
    },
    close() { if (!closed) { closed = true; input.close(); } },
  };
}
export const resumeSession = (id: string, options: Options) => createSession({ ...options, resume: id });
```

Unlike V2, it takes **every** `Options` field and returns the `Query`.

**Four ways, at the same time** (scenario **5**, one run, warm cache):

| Way | SDK · Claude Code · tools | Processes | Sessions | Turns (ms) | Cost |
|---|---|---|---|---|---|
| `unstable_v2_createSession()` | 0.2.141 · 2.1.141 · 27 | **1** | 1 | 3395 · 2136 · 1026 | $0.0078 |
| `createSession()` on `query()` | 0.3.281 · 2.1.281 · 31 | **1** | 1 | 2545 · 2885 · 1153 | $0.0086 |
| `createSession()` + `tools: []`, thinking off | 0.3.281 · 2.1.281 · 0 | **1** | 1 | 1918 · 799 · 722 | **$0.0023** |
| `query()` + `resume`, one per turn (Concept 6) | 0.3.281 · 2.1.281 · 31 | **3** (2 with `--resume`) | 1 | 2527 · 3640 · 1919 | $0.0120 |

- V2 and the wrapper behave the same: **one** Claude Code process for the whole conversation.
- One `query()` per turn starts a process per turn and reloads the session each time: slower, and it costs more.
- The *lean* row is what V2 could never do (`tools`, `thinking`): about a quarter of the cost.
- Every way answered turn 3 correctly. Claude Code 2.1.281 also carries `total_cost_usd` across a resume, so for
  each way the last result is the session's total.

## Step 6: Options, and what V2 decided for you (Part E)

Read live from both `sdk.d.ts` files: `SDKSessionOptions` has **14** keys (`model`, `pathToClaudeCodeExecutable`,
`executable`, `executableArgs`, `env`, `cwd`, `settingSources`, `allowDangerouslySkipPermissions`, `allowedTools`,
`disallowedTools`, `canUseTool`, `hooks`, `permissionMode`, `planModeInstructions`). All 14 still exist in `Options`,
which has **69**. The 55 others include `tools`, `mcpServers`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `thinking`,
`outputFormat`, `abortController`, `forkSession`, `includePartialMessages`, `agents` and `sandbox`.

What `SDKSession` fixed in its constructor:

| Setting | V2 passed | So |
|---|---|---|
| `tools` | not passed | Every built-in tool; `allowedTools` / `disallowedTools` only filter them |
| `mcpServers`, `strictMcpConfig` | `{}`, `false` | No MCP servers, no in-process tools |
| `maxTurns`, `maxBudgetUsd`, `thinkingConfig`, `fallbackModel` | `undefined` | No limits, the default thinking, no fallback |
| `includePartialMessages` | `false` | No `stream_event`: no token-by-token UI |
| `forkSession`, `resumeSessionAt` | `false`, `undefined` | A resumed session is always continued, never forked or cut |
| `settingSources` | `?? []` | No CLAUDE.md or settings files. **`query()` has the opposite default** |
| `abortController` | its own | `close()` ends the input, then aborts after 5 s |
| the `Query` | private | No `interrupt()`, `setModel()`, `getContextUsage()` |

## Step 7: Migrating, line by line (Part F)

| V2 | Today | Note |
|---|---|---|
| `unstable_v2_prompt(text, options)` | `query({ prompt: text, options })` | Keep the `result` message |
| `unstable_v2_createSession(options)` | `query({ prompt: inputQueue.stream, options })` | Streaming input: one process for the conversation |
| `await session.send(text)` | push an `SDKUserMessage` into the queue | A message pushed during a turn waits in the queue |
| `for await (m of session.stream())` | read the `Query` until the next `result` | One stream for every turn |
| `session.sessionId` | `system/init.session_id` | Or the id you resumed |
| `session.close()` / `await using` | close the queue, or `abortController.abort()` | Closing is the normal end; `abort()` kills at once |
| `unstable_v2_resumeSession(id, options)` | `options.resume = id` | The ids V2 wrote still resume |
| `model` (required) | `model` (optional) | |
| `settingSources` default `[]` | set `settingSources: []` | Otherwise `query()` loads user, project and local settings |

## Things to try in Concept 41

1. Run 2, then 3 and 4. Compare the two `system/init` rows: which fields are the same, and which are not?
2. Run 5 twice. Which costs change between the runs, and why? (The prompt cache.)
3. In the *resume* way, why is turn 2 the slowest of its three?
4. In `41-v2-session-api.ts`, add `maxTurns: 1` or a `systemPrompt` to the *lean* way. Could you have done that with V2?
5. Change `createSession()` so `stream()` also stops on an `error` result, and try `session.query.interrupt()`.

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **41. V2 session API** tab. `ANTHROPIC_API_KEY` must be in `.env`. With Haiku 4.5: Part A costs nothing,
1 about $0.03, 2 about $0.01, 3 about $0.003, 4 about $0.02, and 5 about $0.03 to $0.07 (the first run of each Claude
Code version writes the prompt cache). A full pass costs about $0.10.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c41/facts
curl.exe -N -X POST http://localhost:3001/api/c41/v2 -H "Content-Type: application/json" -d "{\"step\":\"session\"}"
curl.exe -N -X POST http://localhost:3001/api/c41/compare
```

`node_modules` was copied from sample40, then `npm install` added the alias: **run `npm install` once** if you copy
this sample without its `node_modules`. It downloads 0.2.141 and its own Claude Code binary (about 230 MB).

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 41 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "#1: the V2 session API" from a list of features the course had not covered. The first check
changed the plan: the installed SDK (0.3.281) and the latest (0.3.284) export no `unstable_v2_*` function. `npm pack`
of the last 0.2.x (0.2.141) and the first 0.3.x (0.3.142) showed where it went. The user chose a **migration lesson**
(run the real V2 from 0.2.141, then rebuild it on `query()`) over a wrapper-only sample or another feature.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab40-Resume-drops-turn.md`, `40-resume-drops-turn.ts`, `Concept40ResumeDropsTurn.tsx` | The latest style: strict zod bodies, SSE rows, `#region` + `/code`, the "Steps followed" section |
| `12-streaming-input.ts`, `06-sessions.ts` | The input queue and `resume`: the two things V2 wrapped |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types and the SDK

| Found | Used for |
|---|---|
| A bisect of every release's `sdk.d.ts`: V2 from 0.1.54, `@deprecated` from 0.2.133, gone in 0.3.142 | Part A's history |
| `SDKSession`, `SDKSessionOptions` (14 fields), the three functions in `sdk.d.ts` of 0.2.141 | Parts B and E |
| The `SDKSession` class in `sdk.mjs` of 0.2.141: an input queue + the internal `Query` + `streamInput()`, the fixed options, `close()` → abort after 5 s; `unstable_v2_prompt` = create + send + first result + dispose | Part E's table, and the design of `createSession()` |
| Both SDKs run a `pathToClaudeCodeExecutable` ending in `.mjs` with node; each resolves its own platform package | The launcher |

### Build step 4: Probe before designing

| Probe | Result | Decision |
|---|---|---|
| V2 from a scratchpad script, default config | Every call: `API Error: 503 credential validation failed`, retried 10 times. The same key worked with curl, and with a fresh `CLAUDE_CONFIG_DIR` | The lab gets its own `CLAUDE_CONFIG_DIR` (`v2-lab/config`) |
| V2 with that config | `stream()` ends at each `result`; `sessionId` throws early; `send()` after `close()` throws; a resumed session knows its id at once | Part B's call rows |
| `system/init` of V2 | 27 tools, no MCP, Claude Code 2.1.141 | Part E |
| Turn 1 in V2 | Sometimes 2 `Write` calls: auto memory saved "Ana" | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |

### Build step 5: Design the concept

- **Two SDKs** through an npm alias; the old one loaded with `import()` only in Concept 41 routes.
- **Call rows**: each V2 line of code the server runs is sent to the tab with what it returned or threw.
- **`createSession()` / `resumeSession()` / `prompt()`** on `query()`: V2's shape, but any `Options`, and the `Query`.
- **Four ways in parallel**, each counted by the launcher.
- **Routes**: `GET /facts`, `GET /state`, `POST /v2` (SSE), `POST /resume` (SSE), `POST /compare` (SSE), `GET /code`.

### Build step 6: Implement it

| File | What was done |
|---|---|
| `server/concepts/41-v2-session-api.ts` | New: `realCli()`, `labEnv()`, `keysOf()` + `deprecations()` for `/facts`, `v2Session()`, `v2Prompt()`, `resumeLast()`, `createSession()`, `runWay()` for `/compare` |
| `server/concepts/41-launcher.mjs` | New: the process counter |
| `src/concepts/Concept41V2SessionApi.tsx` | New: `Timeline`, `CompareTable`, Parts A to G |
| `package.json`, `server/index.ts`, `src/App.tsx`, `.gitignore`, `Tab1-query().md` | The alias, mount, tab, `v2-lab/`, table row and tree |

`npx tsc --noEmit -p .` passed.

### Build step 7: Test the routes

A scratchpad server mounted **only** the Concept 41 router on port **3141**; a driver script printed each SSE event.

| Test | Result |
|---|---|
| `/state`, `/facts`, `/code` | `null`; both packages, 5 deprecations, 14 vs 69 options; 7 regions |
| `/v2` prompt and session | Step 4's rows |
| `/resume` v2, query, a bad body | Both resumed the same id; a zod error |
| `/compare` | Four rows, every turn 3 correct |

What the tests changed:

- The published `.d.ts` files use **CRLF**: the deprecation parser found nothing until the text was normalised.
- The *resume* way first showed $0.080: the sum of three results. Claude Code 2.1.281 carries the running total
  across a resume, so the lab takes the last result for every way.
- The launcher's `resume` flag was always false: the SDK passes `--resume=<id>` forms, so it now checks the prefix.
- The doc comment of `unstable_v2_prompt` includes an `@example`: the parser keeps only the description and the tags.

### Build step 8: Run it in the real app

`npm run dev` (all 41 routers on 3001, Vite on 5173). Headless Edge was driven through the DevTools protocol:
tab 41, then scenarios 2, 4 and 5.

| Check | Page |
|---|---|
| Open tab 41 | Part A's three tables, 7 code buttons, the last V2 session restored by `/state` |
| 2 | The call rows and 12 raw messages |
| 4 | Claude Code 2.1.281 resumed the V2 session |
| 5 | The four rows of Step 5 |
| Console | No error |
