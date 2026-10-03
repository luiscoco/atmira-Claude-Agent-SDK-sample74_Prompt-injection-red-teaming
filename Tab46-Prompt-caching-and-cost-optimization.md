# Prompt caching and cost optimization

This file explains Concept 46 (**prompt caching and cost optimization**) of the Claude Agent SDK Lab. Every call an
agent makes re-sends the whole prompt: the tools, the system prompt and the conversation so far. On a support agent
with an 8,000-token handbook, that is 8,000 input tokens per call, every call. **Prompt caching** lets the API keep that
prefix for a few minutes and read it back at a tenth of the price. Claude Code already adds the `cache_control`
breakpoints to every request, so there is no "enable caching" option. What your code decides is whether the prefix is
**big enough** to be cached, **stable enough** to be read again, and **how long** it stays cached. Concept 15 showed where the
cache numbers are in the result. This concept shows what causes them, and how to make them smaller.

**Goal:** see where Claude Code puts the breakpoints, see a call write the cache and the next one read it, choose the
TTL, know what breaks the cache (and what does not), keep a per-user prompt cacheable, and stop an expensive model
switch before it happens.

| Concept | Topic | Routes |
|---|---|---|
| 46 | Prompt caching and cost: the `cache_control` breakpoints Claude Code sends, `cache_creation` (5m / 1h) and `cache_read_input_tokens` per call, the minimum cacheable prefix, write/read multipliers and break-even, `settings.promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`, `DISABLE_PROMPT_CACHING`, cross-session reuse, cache breakers, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and `scope: "global"`, `excludeDynamicSections`, `setModel()` + `PreModelSwitch` / `PostModelSwitch` (`estimated_cache_write_usd`), a cost checklist | `/api/c46/facts`, `/anatomy`, `/switches`, `/breakers`, `/model-switch` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/46-prompt-caching.ts` | **New**: the handbook, the wire tap (breakpoints + usage of every call), the lane options, the session runner, the four scenarios, the routes |
| `server/index.ts` | Mounts the router on `/api/c46` |
| `src/concepts/Concept46PromptCaching.tsx` | **New**: the tab, Parts A to G, with the calculator and the cache bars |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The wire-call rows, the cache bar, the calculator |
| `.gitignore` | Ignores `cache-lab/` |
| `Tab1-query().md` | Adds Concept 46 to the table and the project tree, the sample46 path |

No new package.

---

## Step 1: The smallest example

```ts
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Which section covers chargebacks?",
  options: {
    model: "haiku",
    // The big static part first, the part that changes per user after the boundary.
    systemPrompt: [handbook, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `Customer: ${customer}`],
    settings: { promptCacheTtl: "5m" },   // the default on an API key; "1h" for longer gaps
  },
});
for await (const m of q) {
  if (m.type === "result")
    for (const [model, u] of Object.entries(m.modelUsage))
      console.log(model, "written", u.cacheCreationInputTokens, "read", u.cacheReadInputTokens, "$", u.costUSD);
}
```

The rules come from the API, and they are the same for every Claude app:

| | Price (× the input price) |
|---|---|
| cache write, 5 minutes | **1.25×** |
| cache write, 1 hour | **2×** |
| cache read | **0.1×** (0.05× on Opus 5.5); a read also restarts the entry's TTL |
| uncached input | 1× |

- The cache is a **prefix match** in render order: `tools` → `system` → `messages`. One changed byte and everything after
  it is written again.
- A prefix shorter than the model's **minimum** is not cached. No error, just zeros: 512 tokens on Opus 5.5 / Opus 5 /
  Fable 5.x / Sonnet 5.5, 1,024 on Sonnet 5 / Sonnet 4.x / Opus 4.8, 2,048 on Opus 4.7, **4,096 on Haiku 4.5**.
- Entries belong to your **workspace**, not to a session: another `query()` with the same prefix reads them.
- Break-even: with 5 minutes, 2 requests (1.25 + 0.1 = 1.35 < 2); with 1 hour, 3 requests (2 + 0.1 + 0.1 = 2.2 < 3).

## Step 2: The wire tap (the lab's instrument)

The cache happens between Claude Code and the API, so the lab puts a small proxy there. `ANTHROPIC_BASE_URL` of every
lane is `http://127.0.0.1:<tap>/<lane>`. The tap forwards the call to `api.anthropic.com` unchanged and records, for
every `/v1/messages` request:

- every `cache_control` it carries: where (`system[2]`, `messages[2].content[0]`…), its `ttl` and `scope`;
- the system blocks (size and first words);
- the usage the API answered: `cache_creation.ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`,
  `cache_read_input_tokens`, `input_tokens`, `output_tokens`, and a cost at list price.

```ts
function breakpointsOf(body: any): Breakpoint[] {
  // tools → system → messages: the order the API renders (and caches) them
  (body.tools ?? []).forEach((t, i) => t.cache_control && add(`tools[${i}] ${t.name}`, t.cache_control, t.description));
  (body.system ?? []).forEach((b, i) => b.cache_control && add(`system[${i}]`, b.cache_control, b.text));
  (body.messages ?? []).forEach((m, i) => m.content.forEach((b, k) => b.cache_control && add(`messages[${i}].content[${k}]`, …)));
}
```

The tap can only report a call once its answer has been read, which is after Claude Code has already shown the tool
call it produced. So each call also records when it was **sent** (`sentAt`), and the tab sorts every lane by time: a call
appears before the `Read` or the result it caused, with "sent @ 1.1 s". In the tab each call is a **→ API** row with a bar: green = read from the cache, yellow = written (5 minutes), red =
written (1 hour), blue = uncached input. The small calls in grey are the **session title** side call (Concept 38); they
are too short to cache.

Each press of a scenario uses a new **edition** of the handbook (`Handbook edition <id>.` is its first line). Otherwise
the second press would read what the first press wrote, since the cache belongs to the workspace.

## Step 3: The anatomy of a cached run (Part B, about $0.02)

One question that needs two calls (`Read`, then the answer), two lanes side by side:

| Lane | Call 2 (Read) | Call 3 (answer) | Run |
|---|---|---|---|
| The SDK's default system prompt (about 1,500 tokens) | 1,444 uncached | 1,592 uncached | about $0.005, **nothing cached** |
| `systemPrompt: handbook` (about 9,400 tokens with the tools) | **writes 9,402** ($0.0123) | **reads 9,402**, writes 135 ($0.0013) | about $0.0145 |

Both runs include the session title side call (about $0.0010). `result.usage` of the handbook run says "cache write
9,537": that is the sum of both calls (9,402 + 135), not what the first call wrote.

What the breakpoints show:

- Claude Code marks the **system prompt** (`system[1]`, `system[2]`) and the **last message blocks** (the user text on
  the first call; the `tool_use` and the `tool_result` on the next). Never more than 4, the API's limit.
- On the first lane the breakpoints are there, but 1,500 tokens is below Haiku's 4,096 minimum: nothing is cached. A
  short prompt is cheap anyway; caching matters once the prefix is big.
- `system[0]` (`x-anthropic-billing-header: …`) is a line Claude Code adds itself; it is never marked.
- The last breakpoint moves forward with the conversation: each call writes only the new part (135 tokens) and reads
  the rest. Call 3 cost $0.0013; without the cache the same call would cost about $0.0097 (8× more: the reads are 10×
  cheaper, but the answer's output tokens cost the same either way).

## Step 4: The switches: 5 minutes, 1 hour, off (Part C, about $0.07)

The same 4-turn session (streaming input, Concept 12) three ways at once:

| Lane | Turn 1 | Turns 2-4 | Session title | Session | On the wire |
|---|---|---|---|---|---|
| default (API key): 5 minutes | $0.0103 (writes 8,208) | $0.0009 each (reads) | $0.0010 | **$0.0140** | `ttl 5m` |
| `settings: { promptCacheTtl: "1h" }` | $0.0165 (writes at 2×) | $0.0009 each | $0.0010 | $0.0202 | `ttl 1h` on every breakpoint |
| `env: { DISABLE_PROMPT_CACHING: "1" }` | $0.0083 | $0.0083 each | $0.0010 | $0.0341 | no breakpoints at all |

The turn costs come from the wire tap. Why not from the SDK? A turn's cost is the difference of two running
`total_cost_usd` values (Concept 15), and the **session title** side call runs next to turn 1: `total_cost_usd` adds
it to turn 1 or to turn 2, depending on which finishes first. The tab counts it in its own column instead. Each wire
call knows its turn from the request itself: the number of user messages that are not tool results.

- `promptCacheTtl` (a `settings` field, sdk.d.ts): *"Unset = automatic: 1 hour on a Claude subscription within its
  usage limits, 5 minutes on an API key, Bedrock, Vertex or Foundry."* `CLAUDE_CODE_PROMPT_CACHE_TTL` wins over it.
- `subagentPromptCacheTtl` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` do the same for subagents, background and helper
  requests (5 minutes unless `ENABLE_PROMPT_CACHING_1H=1`).
- `DISABLE_PROMPT_CACHING=1` removes every breakpoint; `DISABLE_PROMPT_CACHING_HAIKU` / `_SONNET` / `_OPUS` /
  `_FABLE` do it for one family. Use them to measure, not in production.
- **1 hour is not "better"**: it doubles the write, so it only wins when requests sharing the prefix come **5 to 60
  minutes apart** (a user who reads for 10 minutes before the next question). Requests less than 5 minutes apart keep a
  5-minute entry warm forever, because each read restarts the timer. The Part A calculator shows this with your numbers.

## Step 5: What breaks the cache (Part D, about $0.10)

Nine `query()` calls **one after the other**, with one edition of the handbook. Each is a new session, so a hit means
the cache was shared across sessions.

| Run | What changed | write · read | Turn call | |
|---|---|---|---|---|
| a | nothing cached yet | 8,205 · 0 | $0.0103 | miss |
| b | a new `query()`, same system prompt, another question | 228 · **7,978** | $0.0011 | **hit** |
| c | `Current time: …` on the first line | 8,225 · 0 | $0.0104 | miss |
| d | one more tool (`Read`) | 9,389 · 0 | $0.0119 | miss |
| e | `model: "sonnet"` | 10,181 · 0 | $0.0259 | miss |
| f | `…\nCustomer: Initech (gold tier).` appended | 8,214 · 0 | $0.0104 | miss |
| g | `[handbook, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "Customer: ACME"]`, first-party URL | 8,216 · 0 | $0.0103 | miss (first write) |
| h | the same, `"Customer: Globex"` | 238 · **7,978** | $0.0012 | **hit** |
| i | the same, `"Customer: Umbrella"`, behind a proxy URL | 8,216 · 0 | $0.0103 | miss |

The tab also shows each run's `total_cost_usd`: $0.0010 more when the session title call finished before the answer.

What this shows:

- **The cache outlives the session.** Run b is a brand-new `query()` and still reads 7,978 tokens: its turn call costs
  $0.0011 instead of $0.0103. A fleet of short agents with one shared system prompt pays for it once every 5 minutes,
  not once per agent.
- **A timestamp, a request id or a user name in the system prompt** (c, f) changes the prefix: every run pays the whole
  prompt again. It is the most common silent cache killer. Appending it at the end (f) does not help: it is still inside
  the same cached system block, so that block changes. It needs its own block after the boundary (g, h) or a place in
  the user message.
- **Tools come first** (d): adding, removing or reordering one tool invalidates everything after it. Keep one tool list
  per agent.
- **Caches are per model** (e). Sonnet 5 also counts the same text as more tokens (10,181 vs 8,205).
- **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** (g, h) splits a `string[]` system prompt: the blocks before the marker are sent
  as their own block with `cache_control: { type: "ephemeral", scope: "global" }`, the ones after it as a separate
  block. Customer B then reads what customer A wrote; only the customer line is new.
- **But only on a first-party URL.** The CLI enables the split only when it talks to the Anthropic API itself (first
  party or Claude Platform on AWS, and no foreign `ANTHROPIC_BASE_URL`). Behind a gateway, a proxy or this lab's tap (i)
  it sends the static part and the customer line as **one** block, and every customer misses. The lab's lanes g and h
  set `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, an internal switch of the CLI, so the tap can show the first-party
  request. **Your app does not need it**: without `ANTHROPIC_BASE_URL` the split happens by itself. Behind a gateway,
  put the per-user part in the user message instead.
- `systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true }` is the same idea for
  Claude Code's own prompt: the working directory, memory path and git status move to the first user message, so
  the system prompt is identical for every user of your fleet.

## Step 6: Switching models in the middle of a session (Part E, about $0.05)

A new model starts with a cold cache: `q.setModel()` after a long conversation writes all of it again at the new
model's write price. Claude Code tells you before it happens, in the `PreModelSwitch` hook:

```ts
hooks: {
  PreModelSwitch: [{ hooks: [async (input) => {
    // input: from_model, to_model, source: "sdk", context_tokens, prompt_cache_warm, cache_ttl, estimated_cache_write_usd, pricing
    if (input.prompt_cache_warm && input.estimated_cache_write_usd > 0.01)
      return { hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: "Stay on the current model" } };
    return {};
  }] }],
  PostModelSwitch: [{ hooks: [async (input) => (log(input), {})] }],  // after the switch: the same fields
}
```

| Lane | The hook saw | `setModel("sonnet")` | Turn 2 | Session |
|---|---|---|---|---|
| report only | `context_tokens: 8219`, `prompt_cache_warm: true`, `estimated_cache_write_usd: 0.0205` | resolves | Sonnet 5 writes 10,438 tokens: **$0.0262** | about $0.040 |
| deny above $0.01 | the same | **rejects**: "Model switch blocked by a PreModelSwitch hook: …" | Haiku reads 8,206: $0.0009 | about $0.013 |

- The estimate excludes the answer and counts the context in the old model's tokens, so the real turn cost a bit more.
- A denied switch makes `setModel()` throw; catch it. The session stays on its model and keeps its cache.
- After an allowed switch, Claude Code adds a short `system` message to the conversation ("You are powered by the
  model named Sonnet 5…"). You can see it as a breakpoint in the tap.
- The types list the same idea for `SessionStart` on `resume` / `fork` (`seconds_since_last_response`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd`): resuming after the TTL re-writes the whole transcript.
  (Not shown in the tab: in the probe, a `SessionStart` callback passed in `options.hooks` did not fire.)
- `reloadPlugins({ holdOnCacheImpact: true })` is the same guard for a plugin reload that would change the tool list.

## Step 7: A cost checklist for agents (Part F)

| Lever | How, in the SDK | Seen in |
|---|---|---|
| Keep the prefix stable | No timestamps, ids or user names in `systemPrompt`; one tool list; one model per session; keep `systemPrompt` snapshotting on (the default) | Steps 5, 6 |
| Static first, dynamic last | `[static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, perUser]`, or preset + `excludeDynamicSections: true`, or the per-user part in the user message | Step 5 |
| Make the static part worth caching | Long instructions and reference text in the system prompt, once, above the model's minimum | Step 3 |
| Choose the TTL by the gaps | 5 minutes for steady traffic; `promptCacheTtl: "1h"` for gaps of 5 to 60 minutes | Step 4 |
| Reuse sessions | Streaming input or `resume` inside the TTL: every turn reads the conversation so far | Step 4 |
| The right model for each job | `model: "haiku"` for simple agents and subagents (`AgentDefinition.model`); decide at the start, a switch forfeits the cache | Step 6 |
| Fewer tokens in | Only the tools you need, `settingSources: []`, `strictMcpConfig`, small tool results | Tab3, Tab25 |
| Fewer tokens out | `effort`, `thinking`, `maxTurns`; `maxBudgetUsd` as the safety net | Tab14, Tab15 |
| Measure | `modelUsage[model].cacheReadInputTokens` / `cacheCreationInputTokens`; a turn's cost is the difference of the running `total_cost_usd` | all |

---

## Things to try in Concept 46

1. In the Part A calculator, set 10 requests, 8,000 tokens and a gap of 4, 6 and 30 minutes. When does 1 hour win?
2. In `/anatomy`, add a second copy of the handbook to the small lane's prompt only up to 3,000 tokens. Does Haiku cache
   it? Switch that lane to `model: "sonnet"`: does it now?
3. In `/breakers`, move the timestamp of run c to the **end** of the system prompt. Hit or miss? Then put it in the
   question instead.
4. Change run d so the extra tool is added in **every** run (a to i). Which runs hit now?
5. In `/model-switch`, raise the deny threshold to $0.05. What does `setModel()` do, and what does the session cost?
6. Set `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` in the env of the `sw-1h` lane. Which one wins: the env or the setting?

## Running the app

```powershell
npm install        # once (no new packages in this sample)
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **46. Prompt caching & cost** tab. `ANTHROPIC_API_KEY` must be in `.env`: the wire tap forwards every call to
the Anthropic API with it (the tap only listens on 127.0.0.1). With Haiku 4.5: Part A is $0, 1 about $0.02, 2 about
$0.07, 3 about $0.10, 4 about $0.05. A full pass costs about $0.25.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c46/facts
curl.exe -N -X POST http://localhost:3001/api/c46/anatomy -H "Content-Type: application/json" -d "{}"
curl.exe -N -X POST http://localhost:3001/api/c46/breakers -H "Content-Type: application/json" -d "{}"
```

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 46 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "sample 46: Prompt caching and cost optimization" (#14 + #26 in the list of features the course
had not covered). `sample46-prompts and presentation/sample46.docx` was empty, so the list was the spec. `sample46/` was
a copy of sample45 without `node_modules` and without its readme; `npm install` restored the packages.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab45-Cloud-providers.md`, `45-cloud-providers.ts`, `Concept45CloudProviders.tsx` | The latest style: lanes, `sseRoute()`, `#region` + `/code`, the retrying `/facts`, "Steps followed" |
| `Tab15-Cost-and-usage.md` | What is already covered (`modelUsage`, `maxBudgetUsd`, the Agent-tool cache example), so this concept does not repeat it |
| `38-prompt-suggestions.ts` | The wire tap pattern (`ANTHROPIC_BASE_URL` → a local proxy, usage read from the SSE) |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types and the CLI

| Found | Used for |
|---|---|
| sdk.d.ts: `promptCacheTtl`, `subagentPromptCacheTtl`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `excludeDynamicSections`, `snapshot`, `PreModelSwitch` / `PostModelSwitch` inputs, `SessionStart.prompt_cache_likely_expired`, `reloadPlugins({ holdOnCacheImpact })` | Steps 4 to 6 |
| The CLI binary (2.1.281): `DISABLE_PROMPT_CACHING[_HAIKU/_SONNET/_OPUS/_FABLE]`, `ENABLE_PROMPT_CACHING_1H`, `CLAUDE_CODE_PROMPT_CACHE_TTL`; the boundary split with `cacheScope: "global"` and its gate (first party or Claude Platform on AWS, and a first-party base URL) | Steps 4 and 5 |
| The prompt-caching reference of the Claude API: multipliers, minimums per model, workspace scope | Step 1, Part A |

### Build step 4: Probe before designing

Four scratchpad scripts (not part of the project) ran `query()` with Haiku 4.5 through a capturing proxy:

| Probe | Result | Decision |
|---|---|---|
| Default prompt vs an 8,000-token handbook, a `Read` agent | Markers on both; only the handbook caches (Haiku's 4,096 minimum) | Scenario 1 with both lanes |
| `promptCacheTtl: "1h"`, `DISABLE_PROMPT_CACHING=1`, preset + `append`, `excludeDynamicSections` | `ttl: "1h"` on every marker; no markers at all; all as documented | Scenario 2 |
| `string[]` + boundary through the proxy | No `scope`, one merged block | Read the CLI: the split needs a first-party URL. Probed again with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`: `scope: "global"`, two blocks, customer B hits |
| Three `query()` calls in a row; a timestamp; one more tool; a suffix | Cross-session hit; the others miss | Scenario 3 |
| A session with `setModel()`, a `PreModelSwitch` that denies, a resume | `estimated_cache_write_usd` ≈ the real cost; a deny rejects `setModel()` | Scenario 4 |
| A second probe run | Its first call already **read** the previous run's cache | A new handbook edition on every press |

### Build step 5: Design the concept

- **The wire tap** inside the lab server, one URL prefix per lane, that emits every call as a `wire` event.
- **One handbook generator** with an edition line, **one options helper** (`laneOptions()`), **one session runner**
  (`runSession()`) that reports each turn's cost as the difference of the running totals.
- **Four scenarios**, each a route; parallel lanes where they must not share a cache (each its own edition),
  sequential lanes where sharing is the point (Scenario 3).
- **A $0 calculator** in the browser for the TTL decision, and a checklist that points back to earlier tabs.

### Build step 6: Implement it

| File | What |
|---|---|
| `server/concepts/46-prompt-caching.ts` | `handbook()`, the tap (`breakpointsOf()`, `usageOf()`, `callCost()`), `laneOptions()`, `runSession()`, `switchHooks()`, the four routes |
| `src/concepts/Concept46PromptCaching.tsx` | `WireCallView` (the cache bar and the breakpoints), `Trail`, `Calculator`, Parts A to G |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md` | Mount, tab, styles, `cache-lab/`, table row and tree |

`npx tsc --noEmit -p .` passed.

### Build step 7: Test the routes and the tab

The router was first mounted alone on a spare port and each route called with `curl -N`; then `npm run dev` ran the
whole lab and a headless Chrome (driven over the DevTools protocol) opened tab 46, pressed the four buttons and took a
screenshot. All nine breaker runs matched their expectation and no error appeared. What the tests changed:

- `/facts` showed "not found" for the TTL docs: sdk.d.ts has Windows line endings, so the regular expression now
  accepts `\r\n`.
- The breaker table showed Claude Code's billing header line as a system block and coloured a miss green; the header is
  now hidden (it is never cached) and hit / miss are coloured by result, with "as expected" next to them.
- The model-switch run showed a `system` message after the switch ("You are powered by the model named Sonnet 5…"):
  added to Step 6.

### Build step 8: Review of the tab's output

The output of a full pass was checked line by line against the wire data. The calculator, the prices, the minimums
and all nine hit/miss verdicts were right. Five things were not:

| Problem in the output | Fix |
|---|---|
| Part B said the first call "wrote 9,536 tokens": that was the sum of both calls' writes (9,401 + 135) | The sentence now reads each call from the wire: 9,402 written by the first, 9,402 read and 135 written by the second |
| Part B said the second call would cost "about ten times more" without the cache | It is computed now: about 8× (the output tokens are not cheaper when cached) |
| Part C showed turn 2 at $0.0019 while its API call cost $0.0009: the session title call ($0.0010) had landed in turn 2's `total_cost_usd` difference | Each wire call now carries its `turn` (counted from the request); the table sums the calls per turn and shows the title call in its own column. The result rows show both numbers and name the extra |
| Part D's advice "put what changes at the end" contradicted run f, which appended the customer line at the end and missed | The advice now says: after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (its own block) or in the user message; appending is not enough |
| The call rows read "claude-haiku-4-5-202510011 messages" and "1 tools" when copied as text | A separator between the model and the counts, and singular/plural |

A second pass over the corrected output confirmed the fixes and found three smaller problems:

| Problem in the output | Fix |
|---|---|
| A `Read` row came before the API call that asked for it, and the session title call appeared after `PostModelSwitch`: rows were added when the answer ended | Each wire call keeps `sentAt`; the route's `at` uses it, and the tab sorts every lane by time |
| Part A said the handbook has 29,651 characters, the lanes sent 29,663 | `/facts` measured `handbook("x")`; it now measures a real edition |
| Part C said the title call is counted in turn 1 or turn 2, but runs b and h of Part D showed `total_cost_usd` without it | The note says it can be missing from a one-turn run, because the run ends first. The small lane of Part B now says that not naming a handbook section is expected (it has no handbook) |
