# Cost & usage tracking, step by step

This file explains how Concept 15 (**Cost & usage tracking**) was added to the Claude Agent SDK Lab.
Every tab so far has shown a price such as `$0.0042` next to its results. This concept looks at **where that
number comes from**, which of the several usage fields to trust, and how to stop a run that costs too much.

There are three parts:

- **A. Where the numbers are in one run.** `message.usage` per API call, `result.usage`, `result.modelUsage`,
  `total_cost_usd`, `rate_limit_event`.
- **B. Limits that stop a run.** `maxTurns`, `maxBudgetUsd` and `taskBudget`, side by side.
- **C. A live cost meter.** Running totals in a streaming-input session, `getContextUsage()` and
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.

| Concept | Topic | Routes |
|---|---|---|
| 15 | `total_cost_usd`, `usage` vs `modelUsage`, `message.usage`, `maxTurns`, `maxBudgetUsd`, `taskBudget`, `rate_limit_event`, `getContextUsage()`, `usage_EXPERIMENTAL…()` | `/api/c15/run`, `/session`, `/send`, `/context`, `/usage`, `/end` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/15-cost-usage.ts` | **New**: `/run` and the live-session routes |
| `server/index.ts` | Mounts the router on `/api/c15` |
| `src/concepts/Concept15CostUsage.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `Tab1-query().md` | Adds Concept 15 to the table of concepts |
| `Tab15-Cost-and-usage.md` | This explanation |

No CSS was added: the tables, cards and meters reuse the classes from Concepts 12 and 14.

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Cost and usage appear in four places:

```ts
type SDKResultSuccess /* and SDKResultError */ = {
  total_cost_usd: number;              // "Cumulative estimated cost ... An estimate, not a billing statement."
  usage: NonNullableUsage;             // "MAIN AGENT LOOP ONLY ... per-turn in streaming-input sessions."
  modelUsage: Record<string, ModelUsage>; // "The correct field for token/cost accounting"
  duration_ms: number; duration_api_ms: number; num_turns: number;
  terminal_reason?: TerminalReason;    // 'completed' | 'max_turns' | 'budget_exhausted' | 'api_error' | ...
  // SDKResultError: subtype 'error_max_turns' | 'error_max_budget_usd' | ..., errors: string[]
};

type ModelUsage = {
  inputTokens: number; outputTokens: number; thinkingTokens?: number; // thinking is inside outputTokens
  cacheReadInputTokens: number; cacheCreationInputTokens: number; webSearchRequests: number;
  costUSD: number; contextWindow: number; maxOutputTokens: number;
  costBasis?: 'list' | 'managed' | 'unknown'; // which price table was used
};

type SDKAssistantMessage = { message: { id, usage, stop_reason, ... } };
// "several consecutive assistant messages can share message.id ... message.usage is not final"

type SDKRateLimitEvent = { type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo }; // claude.ai login only

type Options = {
  maxTurns?: number;
  maxBudgetUsd?: number;               // "returning an `error_max_budget_usd` result"
  taskBudget?: { total: number };      // @alpha: "the model is made aware of its remaining token budget"
};

interface Query {
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>;
}
```

The comments in the types already say most of the rules. The experiments checked each one.

## Step 2: Try it before writing the lab

Three scratch scripts ran against the real SDK, with a task in the Concept 3 sandbox (*"List the files here, read each
one, then tell me in two lines how many tasks are open and what the TODO in the notes says."*). With `Read` and `Glob`
the model needs three API calls: list, read both files, answer.

| Finding | Effect on the lab |
|---|---|
| One API call produced 2 or 3 `assistant` messages (thinking, text, tool_use), all with the **same `message.id` and the same `usage`**. `output_tokens` there was `1` or `3` | Part A groups by `message.id` and greys out `output_tokens` |
| `modelUsage.inputTokens` was always about **900 higher** than `result.usage.input_tokens` | Part A shows both side by side, with the difference |
| `maxBudgetUsd: 0.001` still spent **$0.004 to $0.005**: the first call finishes before the check | Part B draws the budget bar and the overshoot |
| On a budget stop after the first call, **`result.usage` was all zeros**, but `modelUsage` had the numbers | A hint in Part A, and the reason to prefer `modelUsage` |
| `maxTurns: 2` ended with `num_turns: 3` after 2 API calls. `num_turns` is not "API calls" | The tab counts calls by `message.id` |
| With the `Agent` tool the system prompt grew past the cache minimum: **cache writes, then cache reads**. The run still cost more | The *Agent tool* checkbox in Part A |
| In a session, `total_cost_usd` and `modelUsage` are **running totals**; `result.usage` is per turn | Part C computes the turn cost as a difference |
| `maxBudgetUsd` is sent to the model: `getContextUsage()` lists a **`budget_usd` attachment** | Mentioned in Step 7 |
| In a session with `maxBudgetUsd: 0.005`, the turn that crossed the limit **ran, was paid for, and returned no text**. The next turn returned the same error at **no cost** | Part C explains both cases |
| `taskBudget` on Haiku 4.5: **`API Error: 400 This model does not support user-configurable task budgets`**. Sonnet 5 accepted it | Part B compares both models |

---

# Part A: Where the numbers are in one run

## Step 3: One route with read-only tools

```ts
const READ_ONLY = ["Read", "Glob", "Grep"];
const BASE: Options = { cwd: SANDBOX, tools: READ_ONLY, allowedTools: READ_ONLY, settingSources: [], strictMcpConfig: true };
// …
concept15.post("/run", (req, res) => {
  // … check the body with zod (see "How it was built" below)
  // Only the fields you chose are set, like in Concept 2.
  const options: Options = { ...BASE };
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;
  if (body.maxBudgetUsd) options.maxBudgetUsd = body.maxBudgetUsd;
  if (body.taskBudget) options.taskBudget = { total: body.taskBudget };
  if (body.agentTool) {
    options.tools = [...READ_ONLY, "Agent"];
    options.allowedTools = [...READ_ONLY, "Agent"];
  }

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});
```

The tools matter: each tool round-trip is another API call, so a single prompt produces several calls to count.
The tools are read-only and the agent works in `sandbox/`, so nothing can be changed. `settingSources: []` and
`strictMcpConfig: true` keep your own settings and MCP servers out of the token count.

## Step 4: `message.usage`, one row per API call

From [src/concepts/Concept15CostUsage.tsx](src/concepts/Concept15CostUsage.tsx):

```ts
function apiCalls(messages: any[]) {
  type Call = { id: string; model: string; blocks: string[]; usage: any; subagent: boolean };
  const calls = new Map<string, Call>();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    const call: Call = calls.get(m.message.id) ?? { id: m.message.id, model: m.message.model, blocks: [], usage: m.message.usage, subagent: m.parent_tool_use_id !== null };
    call.blocks.push(...m.message.content.map((b: any) => (b.type === "tool_use" ? `tool_use(${b.name})` : b.type)));
    calls.set(m.message.id, call);
  }
  return [...calls.values()];
}
```

The first message of a call gives its `usage`, its model, and whether it came from a subagent. Tool blocks are
named, so the table shows `tool_use(Glob)`.

A real run (Haiku, the sandbox task) printed 8 assistant messages for 3 calls:

| # | blocks | input | output (not final) |
|---|---|---|---|
| 1 | `thinking, text, tool_use(Glob)` | 2,195 | 3 |
| 2 | `thinking, tool_use(Read), tool_use(Read)` | 2,433 | 1 |
| 3 | `thinking, text` | 2,935 | 1 |

The **input** side is right: it grows with each call, because each call re-sends the conversation and the new tool
results. The **output** side is a placeholder. Adding up `message.usage` from every assistant message would count
the first call three times and still get the output wrong. Use it to see *how the context grows*, not for totals.

## Step 5: `result.usage` vs `result.modelUsage`

The same run's result:

| | `result.usage` (main loop) | `result.modelUsage` (all calls) | not in usage |
|---|---|---|---|
| input tokens | 7,563 | 8,484 | 921 |
| output tokens | 581 | 593 | 12 |
| of which thinking | 266 | 266 | |

The 921 input tokens and 12 output tokens are a small helper call the CLI makes outside the main loop. The types
say the same: `usage` is *"MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls"*, and
`modelUsage` is *"the correct field for token/cost accounting"*. A subagent's tokens also only appear in
`modelUsage`. `total_cost_usd` is the sum of `modelUsage[*].costUSD`.

Two more fields worth reading:

- `costBasis`: `list` means Claude Code's list prices. `managed` means your organization's rates. `unknown` means the
  model had no price and the cost is a guess.
- `duration_ms` vs `duration_api_ms`: the difference is time spent outside the API (tools, the CLI itself).

## Step 6: Caching and plan limits

The *also give it the Agent tool* checkbox adds one tool. Its description makes the system prompt big enough to be
cached (about 5,000 tokens on Haiku), and the numbers change shape:

| Run | input | cache write | cache read | cost |
|---|---|---|---|---|
| Read the sandbox | 11,654 | 0 | 0 | $0.0147 |
| Read the sandbox + Agent | 947 | 6,829 | 12,450 | $0.0185 |

Cache reads are cheap, but cache writes cost more than normal input, and the prompt is bigger. On a short run, caching
does not pay for itself. On a long session it does, because every call after the first reads the cache. The **Runs
so far** table keeps one line per run, so you can compare prompts and models this way.

If you are logged in with a claude.ai plan, every run also emits a `rate_limit_event`: the status and how much of the
5-hour and 7-day windows you have used. With an API key it is not sent, because plan limits do not apply.
Its `utilization` is a **fraction** from 0 to 1 (`0.95` means 95% used), and `resetsAt` is in Unix **seconds**. The
per-window numbers are in `rate_limit_info.unifiedWindows`, a field that the SDK types do not list yet:

```json
{ "status": "allowed_warning", "rateLimitType": "five_hour", "utilization": 0.95, "resetsAt": 1790620200,
  "unifiedWindows": { "five_hour": { "utilization": 0.95, "resetsAt": 1790620200 },
                      "seven_day": { "utilization": 0.84, "resetsAt": 1790647200 } } }
```

---

# Part B: Limits that stop a run

## Step 7: `maxTurns`, `maxBudgetUsd`, `taskBudget`

Concept 2 introduced the first two. Here they run in parallel on the same task, one column each:

| Column | Result | Cost |
|---|---|---|
| no limit | `success`, `terminal_reason: completed`, 3 calls | $0.0147 |
| `maxTurns: 2` | `error_max_turns`, `terminal_reason: max_turns`, 2 calls, `errors: ["Reached maximum number of turns (2)"]` | $0.0097 |
| `maxBudgetUsd: 0.001` | `error_max_budget_usd`, `terminal_reason: budget_exhausted`, 1 call | **$0.0050** (503%) |
| `maxBudgetUsd: 0.005` | `error_max_budget_usd`, 2 calls | **$0.0094** (188%) |

Three things to take from it:

1. **The budget is checked after each call, not before.** A call that starts under the limit always finishes, so
   `maxBudgetUsd` is a stop signal, not a hard cap. Set it below what you are ready to spend.
2. **A limit is an error result, and then `for await` throws** (`Claude Code returned an error result: ...`). Read the
   result first; Concept 10 showed the same with interrupts.
3. **The model knows about the budget.** `getContextUsage()` lists a `budget_usd` attachment in the prompt, so the
   model is told how much it may spend.

`taskBudget` (`@alpha`) is different: a token budget sent to the API, so the model can pace its tool use. It enforces
nothing on the SDK side. On this small task Sonnet 5 answered the same with and without it ($0.0239 vs $0.0241), and
Haiku 4.5 rejected the request (`result/success` with `is_error: true`, `terminal_reason: api_error`). Check
`is_error`, not only `subtype`.

---

# Part C: A live cost meter

## Step 8: Running totals in a session

The session uses the input queue from Concepts 12 and 14, with an optional `maxBudgetUsd` for the whole session:

```ts
const options: Options = { ...BASE, model };
if (maxBudgetUsd) options.maxBudgetUsd = maxBudgetUsd; // for the whole session, not per turn
const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
```

The browser keeps the meter. The rule comes from the types: *"each result carries the running total so far, so read
the latest result rather than summing across results"*.

```ts
const total = results.at(-1)?.total_cost_usd ?? 0; // cumulative: read the latest, never add them up
// …
const turn = d.total_cost_usd - previous;
```

`total` is the session so far (in `LiveMeter`). `turn` is the cost of one turn (in `MeterTimeline`, where `d` is a
`result` message and `previous` is the total of the result before it).

A tested session (Haiku, `maxBudgetUsd: 0.01`):

| Turn | Result | Session total | This turn |
|---|---|---|---|
| *Say hi* | `success` | $0.0047 | $0.0047 |
| *Poem* | `success` | $0.0092 | $0.0045 |
| *Read notes.txt* | `error_max_budget_usd`, no text | $0.0138 | $0.0047 |

The third turn started under the limit, so it ran and was paid for, but its answer was dropped. In a second test, the
turn after that returned the same error at **no cost**: once the budget is used, no more calls are made. The session
then ends and `for await` throws.

## Step 9: `getContextUsage()` and `usage_EXPERIMENTAL…()`

Two control requests, one route each:

```ts
// "summary" answers from the last response's usage, without extra token-count calls (so it costs nothing).
// …
const { categories, totalTokens, maxTokens, percentage, autoCompactThreshold, apiUsage } = await q.getContextUsage({ detail: "summary" });

// The data behind the /usage command. The name says it: the shape may change in any release.
// skipBehaviors skips a scan of the last seven days of local transcripts that we do not need.
// …
const { session, subscription_type, rate_limits_available, rate_limits } = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
```

- **`getContextUsage()`** (seen in Concept 12) answers *"how full is the context window?"*: 4,149 of 200,000 tokens
  after the first turn, with auto-compaction at 167,000. It is about the next call's size, not about money.
- **`usage_EXPERIMENTAL…()`** answers *"what has this session cost, and how much of my plan is left?"*: the session
  totals (the same as the latest `total_cost_usd` and `modelUsage`), plus `subscription_type` and the 5-hour and 7-day
  windows. With an API key, `rate_limits_available` is `false`. Its name is a warning: the shape may change in any
  release. The response also lists many other windows, most of them `null`; the server keeps only `five_hour` and
  `seven_day`. Here `utilization` is a **percent** from 0 to 100 (`95`), and `resets_at` is an ISO date. That is a
  different unit from `rate_limit_event` (Step 6): the same moment gave `0.95` there and `95` here.

---

## What to take away

1. **Use `modelUsage` for accounting.** It counts every call of the `query()`: main loop, subagents and helper calls.
   `total_cost_usd` is its cost. `result.usage` is only the main loop, and it can be zeros on a limit stop.
2. **`message.usage` is per API call, repeated, and not final.** Group by `message.id` and read only the input side.
3. **In a session, cost and `modelUsage` are running totals.** Take the latest; a turn's cost is the difference.
4. **`maxBudgetUsd` is checked after each call.** Expect an overshoot of up to one call. A limit ends with an error
   result, and then `for await` throws.
5. **`num_turns` is not the number of API calls.** Count distinct `message.id`s if you need that.
6. **Caching changes the split between input, cache write and cache read.** It pays off over many calls, not one.
7. **Costs are estimates** (*"not a billing statement"*). `costBasis` says which price table was used.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/15-cost-usage.ts](server/concepts/15-cost-usage.ts) and
[src/concepts/Concept15CostUsage.tsx](src/concepts/Concept15CostUsage.tsx). The server is small: most of the work of
this concept is in the browser, which reads the numbers out of the raw messages.

### Step 1: Read the types, then pick a task that makes several calls

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `total_cost_usd`, `NonNullableUsage`,
`ModelUsage`, `terminal_reason`, `SDKRateLimitEvent`, `maxBudgetUsd`, `taskBudget`, `getContextUsage` and
`usage_EXPERIMENTAL` (see Step 1 of the concept). To have something to count, every run gets read-only tools in the Concept 3
sandbox (`BASE`, in Step 3 of the concept).

### Step 2: `POST /run`: only the limits you chose

The body schema is the list of things the tab can change:

```ts
const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: ModelName.optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxBudgetUsd: Budget.optional(),
    taskBudget: z.number().int().min(1).max(1_000_000).optional(), // tokens, sent as { total }
    agentTool: z.boolean().optional(), // adds the Agent tool: a bigger system prompt, which makes prompt caching kick in
  })
  .strict();
```

- `Budget` is `z.number().positive().max(10)`, in dollars. `/session` uses it too.
- A bad body (a negative budget, `maxTurns: 1.5`, an unknown key) gets an `error` event, then `done`, as in
  Concept 34. The control routes answer a bad body with `400` and `{ error }`.

- The route (Step 3 of the concept) copies each field into `options` only when it is set, so an empty field means "no
  limit".
- `taskBudget` is a plain number in the body. The route wraps it as `{ total: body.taskBudget }`, the shape the SDK
  wants.
- The route sends the final `options` as the first SSE event, then `pipe()`s the query.

### Step 3: Part C: the session and two control routes

`POST /session` is the Concept 12 session (push queue, `Map` by id, `getSession()` + `control(schema, action)`), with the model
and an optional `maxBudgetUsd` (Step 8 of the concept). The two new routes measure how long each control request takes, and
the `/usage` route keeps only a small part of the answer:

```ts
concept15.post(
  "/usage",
  control(IdBody, async ({ q, send, ms }) => {
    const startedAt = Date.now();
    const { session, subscription_type, rate_limits_available, rate_limits } = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    // rate_limits has many more windows (most of them null); keep the two every plan has.
    const usage = {
      session,
      subscription_type,
      rate_limits_available,
      rate_limits: rate_limits && { five_hour: rate_limits.five_hour ?? null, seven_day: rate_limits.seven_day ?? null },
    };
    send("control", { method: "q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })", ms, took: Date.now() - startedAt, usage });
    return usage;
  }),
);
```

- `ms` is when the call happened (since the session started). `took` is how long it took.
- The answer goes to the timeline as a `control` event with a `usage` field. `/context` does the same with a
  `context` field. The tab uses these field names to pick the right card.
- `rate_limits && …` keeps `null` as `null` when the login has no plan limits (an API key).

### Step 4: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept15 } from "./concepts/15-cost-usage.js";
// …
app.use("/api/c15", concept15);
```

### Step 5: The React tab, Part A: one run and a history

`startRun()` streams one `/run` into a `Run`, like in Concept 14. Part A needs the finished run **right after** the
`await`, to add a line to **Runs so far**, so it keeps its own copy:

```tsx
async function go() {
  // A local copy, so the finished run can be read right after the await (React state may not be updated yet).
  let final: Run = { messages: [], running: true };
  await startRun({ prompt, model, agentTool }, (fn) => {
    final = fn(final);
    setRun(final);
  });
  // Keep one line per run, so you can compare runs with different models or prompts.
  const result = final.messages.find((m) => m.type === "result");
  if (!result) return;
  const s = sumModelUsage(result.modelUsage);
  // … push { label, model, agentTool, calls: apiCalls(final.messages).length, … } into history
}
```

- `apiCalls()` (Step 4 of the concept) groups the assistant messages by `message.id`. Its length is the number of API calls,
  which is not `num_turns`.
- The history line uses `modelUsage` and `total_cost_usd`, the numbers to trust (Step 5 of the concept).

### Step 6: Comparing `usage` with `modelUsage`

`modelUsage` has one entry per model, so the tab adds them up first:

```tsx
function sumModelUsage(modelUsage: Record<string, any> = {}) {
  const all = Object.values<any>(modelUsage);
  const sum = (k: string) => all.reduce((s, u) => s + (u[k] ?? 0), 0);
  return {
    input: sum("inputTokens"),
    cacheWrite: sum("cacheCreationInputTokens"),
    cacheRead: sum("cacheReadInputTokens"),
    output: sum("outputTokens"),
    thinking: sum("thinkingTokens"),
    cost: sum("costUSD"),
  };
}
```

`UsageCompare` puts `result.usage` next to this sum, row by row, with the difference in a third column. It also
detects a case found while testing (the findings table in Step 2 of the concept): a budget stop where
`result.usage` is all zeros:

```tsx
const zeroed = rows.every(([, main]) => !main) && all.input > 0;
```

- The thinking row of `result.usage` comes from `u.output_tokens_details?.thinking_tokens`, the one of `modelUsage`
  from `thinkingTokens`.
- `RateLimit` reads the latest `rate_limit_event`, and says so when there is none (an API key).
- The two plan-limit cards use one helper, because the two APIs use different units (Step 6 and Step 9 of the
  concept):

```tsx
// Plan utilization comes in two units: rate_limit_event says 0.95 (a fraction), usage_EXPERIMENTAL…() says 95 (a percent).
// Both are shown as a whole percent.
const pct = (percent?: number | null) => (percent == null ? "?" : `${Math.round(percent)}%`);
```

  `RateLimit` calls `pct(w.utilization == null ? null : w.utilization * 100)`, and `UsageCard` calls
  `pct(w.utilization)`.

### Step 7: Part B: the limits in parallel

`limitSets` holds the three comparisons as data. `runAll()` starts one `startRun()` per column, all at once, with
the Part A task (`tasks[0]`), exactly like Concept 14. `LimitCard` then draws the budget bar:

```tsx
<div className="meter" title={`${usd(cost)} of ${usd(budget)}`}>
  <div style={{ width: `${Math.min(100, (cost / budget) * 100)}%`, background: cost > budget ? "#d9a13b" : undefined }} />
</div>
```

- The bar stops at 100%. The overshoot is shown as text (`503% of the budget`) and in another colour.
- `ResultLine` prints `subtype`, `is_error`, `terminal_reason`, `num_turns` and `errors`, so each column shows why it
  stopped.

### Step 8: Part C: the live meter

`LiveMeter` opens the session with `streamPost("/api/c15/session", …)` and calls `/send`, `/context`, `/usage` and
`/end` with a small `post()` helper, as in Concept 12. The session total is never added up:

```tsx
const total = results.at(-1)?.total_cost_usd ?? 0; // cumulative: read the latest, never add them up
```

`MeterTimeline` walks the log once. At each `result`, it prints the turn's cost as the difference with the previous
total, and explains a turn that cost nothing:

```tsx
} else if (d.type === "result") {
  const turn = d.total_cost_usd - previous;
  // … the card: answer, subtype, this turn, session, result.usage (this turn)
  previous = d.total_cost_usd;
}
```

- A `control` event with `context` becomes a `ContextCard`, one with `usage` becomes a `UsageCard`.
- The last `context` answer also fills the context-window bar under the session cost.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 15, title: "Cost & usage", Component: Concept15CostUsage },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 15, keep **Read the sandbox (several calls)** and press **Run**. The first table shows more
   assistant messages than API calls.
3. In Part B, press **Run 3 in parallel**: the `maxBudgetUsd: 0.001` column ends over its budget.
4. In Part C, press **Start session**, send two messages, then **await q.getContextUsage()**.
5. The same `/run` route from a terminal: see "Running the app" below.

## Things to try in Concept 15

1. Run *Read the sandbox* on Haiku, Sonnet and Opus. Compare the three lines in **Runs so far**.
2. Run the same task twice with the *Agent* checkbox. Does the second run read more from the cache?
3. In Part B, set `maxBudgetUsd` to `0.01`, `0.012` and `0.015`. Which ones finish the task?
4. In Part C, start with `maxBudgetUsd: 0.02` and send *Poem* until the budget runs out. Then send one more turn:
   what did it cost?
5. Call `getContextUsage()` after each turn. How many tokens does *Read notes.txt* add?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**15. Cost & usage**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. The
sandbox task costs about $0.015 on Haiku and $0.024 on Sonnet 5; the *maxTurns vs maxBudgetUsd* comparison about $0.03.

The route can also be called without the UI:

```powershell
'{"prompt":"List the files here and read notes.txt.","model":"claude-haiku-4-5-20251001","maxBudgetUsd":0.001}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c15/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
