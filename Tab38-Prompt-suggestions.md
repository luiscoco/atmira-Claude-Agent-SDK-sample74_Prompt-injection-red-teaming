# Prompt suggestions

This file explains Concept 38 (**prompt suggestions**) of the Claude Agent SDK Lab. In the Claude Code terminal, after
a turn, grey text sometimes appears in the input box: *"run the tests"*. Press Tab and it is yours. That is a **prompt
suggestion**: Claude Code predicting what you will type next. With `promptSuggestions: true`, your app gets the same
prediction as an SDK message, and can show it as a chip the user accepts with one click.

**Goal:** see where the suggestion comes from (one more API call per turn), when it comes and when it does not, who
can switch it off, what it costs and why the prompt cache matters, and how to use it in a chat.

| Concept | Topic | Routes |
|---|---|---|
| 38 | Prompt suggestions: `promptSuggestions`, the `prompt_suggestion` message (after the `result`), the suggestion API call (`[SUGGESTION MODE]`), when it is skipped (fewer than 2 replies, a queued message, plan mode, a cold cache), the switches (option, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`, `promptSuggestionEnabled`), the filters, the cost in the next `total_cost_usd` | `/api/c38/dry`, `/chat` (SSE), `/send`, `/end`, `/when` (SSE), `/switches` (SSE), `/cache` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/38-prompt-suggestions.ts` | **New**: the wire tap, the options, the dry run, the live chat, the three tables of cases, the routes |
| `server/index.ts` | Mounts the router on `/api/c38` |
| `src/concepts/Concept38PromptSuggestions.tsx` | **New**: the tab, Parts A to H |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The suggestion rows and the chip |
| `.gitignore` | Ignores `suggest-lab/` |
| `Tab1-query().md` | Adds Concept 38 to the table and the project tree |

---

## Step 1: The smallest example

```ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

for await (const m of query({ prompt: messages /* AsyncIterable<SDKUserMessage> */, options: { promptSuggestions: true } })) {
  if (m.type === "result") showTurnDone(m);        // the turn is over, but DON'T stop reading
  if (m.type === "prompt_suggestion") showChip(m.suggestion);   // ≈ 1 s later: "run it with node hello.js"
}
```

- The message is `{ type: "prompt_suggestion", suggestion, uuid, session_id }`. At most **one per turn**.
- It arrives **after** the `result`. A loop that stops at `result` never sees it.
- It is a **prediction**. Show it, and let the user send it or edit it. Never send it on your own: after *"run it"*
  the lab got *"commit this"*.

## Step 2: Where the option goes

Scenario **1** passes three setups to `query()` with a spawner that records the args and what the SDK writes to the
process's stdin (Concept 36). No Claude Code starts:

| Setup | A CLI flag? | `control_request/initialize` |
|---|---|---|
| no option | none | `{"subtype":"initialize","systemPrompt":[""]}` |
| `promptSuggestions: true` | none | `{…,"promptSuggestions":true}` |
| `promptSuggestions: false` | none | `{…,"promptSuggestions":false}` |

The option is not a flag. It goes to Claude Code in the first control request, like `agents` or `hooks`.

## Step 3: A chat with suggestions

Scenario **2** opens a streaming session (Concept 12) with Read, Write, Edit and Bash (only `node`, `ls`, `cat`). A
**wire tap** (`ANTHROPIC_BASE_URL`, as in Concept 34) shows every API call with its usage. The first message is
*"Create hello.js that prints hello, with the Write tool."*. Then click **Send it** on the chip:

```text
user            Create hello.js that prints hello, with the Write tool.
wire #1 title   (the side call that names the session)
wire #2 main    tool_use Write hello.js
wire #3 main    "Done! I've created hello.js…"
result/success  total_cost_usd $0.003918 = #1 + #2 + #3
wire #4 suggestion   5 messages · 4 tools · in 343 · cache read 5566 · out 5 → "run it"
prompt_suggestion    run it                            ← 0.8 s after the result   [Send it] [Edit it]
user            run it          (the suggestion, accepted)
wire #5, #6 main     Bash: node hello.js → hello
result/success  this result adds $0.002727 = #4 suggestion + #5 + #6   ← the previous suggestion is billed HERE
wire #7 suggestion   → "commit this"
prompt_suggestion    commit this
```

- **The suggestion is an API call.** It sends the whole conversation plus one more user message:

  ```text
  [SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]
  FIRST: Look at the user's recent messages and original request.
  Your job is to predict what THEY would type - not what you think they should do.
  THE TEST: Would they think "I was just about to type that"?
  …  Format: 2-12 words, match the user's style. Or nothing.
  ```

  It uses the **same model, system prompt and tools** as the turn. With Sonnet as the model, the suggestion call used
  Sonnet too.
- The instruction is written **for coding**: *"run the tests"*, *"commit this"*. In a Portuguese lesson it still
  worked (*"And how do I say 'good night'?"*), but a resumed quiz got *"run the tests"*.
- When the suggestion call answers something Claude Code drops (*"(silence)"*), **no message comes at all**. The lab
  waits 2 s after the call and shows *no prompt_suggestion*. Your app has no such signal, so never block on a chip.
- The chat stays open until you click **End the chat** (under the input box) or 15 minutes pass.
- *"commit this"* is exactly why a suggestion must stay a suggestion. The lab's session was denied `git add`
  because `git` is not in `allowedTools`.

## Step 4: When a suggestion comes

Scenario **3** runs seven scripted conversations (**code: when**). The wire shows whether the call was even made:

| Case | Suggestion | Why |
|---|---|---|
| one prompt, one reply | none, **no call** | The conversation has 1 assistant reply. Claude Code wants **at least 2** (`early_conversation`). This is the "first turn" rule |
| one prompt, with a tool call | *"run it with node hello.js"* | The tool call makes 2 replies, so even the first turn gets one. Single message mode emits it before the process exits |
| streaming input, two turns | turn 1 none, turn 2 yes | Turn 2 is the second reply |
| one prompt, resuming a session | the call is made | The resumed history counts |
| the next message is already waiting | only the last turn | A queued message makes the prediction useless: the call is skipped, or **aborted** mid-flight |
| a conversation that is over (*"Bye!"*) | none, **but the call was paid** | The model answered *"(no suggestion - conversation is complete…)"*, and Claude Code's filter dropped it |
| `permissionMode: 'plan'` | none, no call | `plan_mode` |

## Step 5: Who switches it off

Scenario **4** (**code: switches**) uses the same two turns each time:

| Setup | Suggestion |
|---|---|
| `promptSuggestions: true` | yes |
| no option | no: **off by default** |
| `promptSuggestions: false` | no |
| `true` + env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` | no |
| `true` + `settings: { promptSuggestionEnabled: false }` (the flag layer) | no |
| `true` + `CLAUDE_CONFIG_DIR/settings.json` `{ "promptSuggestionEnabled": false }` + `settingSources: ['user']` | no: a **user** can switch it off for every app |
| the setting `false` + the env var `true` | **yes**: the env var wins |

## Step 6: Cost and the prompt cache

The SDK says suggestions *"piggyback on the parent's prompt cache, making them nearly free"*. Scenario **5**
(**code: cache**):

| Case | The suggestion call | Why |
|---|---|---|
| a small conversation | in 673, no cache, $0.00074 | Under Haiku 4.5's minimum cacheable prompt (4,096 tokens): nothing is cached |
| a 5,000-token system prompt | **cache read 5,270** of 5,634, $0.00097 instead of about $0.0057 | The same prefix as the turn, so it reads the turn's cache |
| the same, `DISABLE_PROMPT_CACHING=1`, a 7,000-token turn 2 | **no call** | The last reply had 12,044 uncached tokens, over **10,000** (`cache_cold: uncached`) |
| turn 2 pastes 12,000 tokens | **no call** | The last reply wrote 12,019 tokens to the cache, over 10,000 (`cache_cold: cache_write`) |

So Claude Code only makes the call when it is cheap. And the bill:

- The suggestion comes **after** its `result`, so its cost is in the **next** result's `total_cost_usd` (Step 3: the
  lab adds up the wire calls between two results, and they match to the micro-dollar).
- The **last** suggestion of a session is in **no** result. The tables show it as *"never reported"*. The same
  happens to a side call that finishes after the result (the title).

## Step 7: Why no suggestion came, and what is dropped

The host is never told why a suggestion did not come. Part F lists what the CLI's code (`claude.exe` of `0.3.281`)
checks. It is **not** a documented API and can change.

**Skipped (no API call):** `disabled`, `early_conversation` (fewer than 2 assistant replies), `aborted` (a queued
message), `plan_mode`, `last_response_error`, `pending_permission`, `elicitation_active`, `cache_cold` (over 10,000
uncached tokens, or with the cache writes), `rate_limit` (near or at the plan's usage limit).

**Dropped (the call was paid):** empty or *"done"*, *"nothing to suggest"* / *"silence"* / text in `(…)`, an API error
text, *"Suggestion: …"*, one word (except *yes, ok, push, commit…* or a `/command`), more than 12 words or 100
characters, two sentences or markdown, *thanks / looks good / perfect…*, Claude's voice (*"Let me…"*, *"I'll…"*,
*"Here's…"*).

## Step 8: What changes, and what does not

| What | How | What happens |
|---|---|---|
| Turn it on | `promptSuggestions: true` | Sent in `control_request/initialize`. Off by default |
| You get | `{ type: 'prompt_suggestion', suggestion }` | At most one per turn, after the `result` |
| It is made by | one more API call | The conversation + `[SUGGESTION MODE]`, the same model, system prompt and tools |
| Not on turn 1 | fewer than 2 assistant replies | A tool call or a resumed history counts |
| Not when | a message is queued, plan mode, an API error, a cold cache | No call at all |
| Filtered | weak answers are dropped | The call was still paid |
| Switches | option, env var, setting | `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` beats `promptSuggestionEnabled` |
| Cost | the next `total_cost_usd` | The last suggestion is in none |
| Use it | a chip | Send or edit it. Never run it on your own |

## Things to try in Concept 38

1. Run 1: which setup sends nothing at all?
2. Run 2, click *Send it* twice, and follow the cost of the suggestion from its wire row to the next result.
3. Run 2 with the checkbox off: are the results cheaper?
4. Run 2 with a first message that needs no tool (*"What is 2+2?"*): when does the first suggestion come?
5. In 2, type a message **while** a turn runs (it is queued): does that turn get a suggestion?
6. Run 3 and read the *"Bye!"* row: what did the model answer, and why did no suggestion reach the host?
7. Run 5 and compare the cache read of the suggestion call with the turn's.

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **38. Prompt suggestions** tab. `ANTHROPIC_API_KEY` must be in `.env`. Start the app from a normal terminal,
not from inside Claude Code (see Tab16). With Haiku 4.5: scenario 1 costs nothing, 2 about $0.01 per turn, 3 about
$0.02, 4 about $0.013, 5 about $0.045.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -X POST http://localhost:3001/api/c38/dry
curl.exe -N -X POST http://localhost:3001/api/c38/when
```
