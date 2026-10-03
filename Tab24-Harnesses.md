# Harnesses

This file explains how Concept 24 (**Harnesses**) was added to the Claude Agent SDK Lab.
Concepts 1 to 23 all used one harness: Claude Code, through `query()`. This concept steps back and asks what a
harness **is**, by running the **same tools and the same prompt** through three of them, side by side:

| # | Harness | Package | You write |
|---|---|---|---|
| 1 | **Manual loop** | `@anthropic-ai/sdk`: `client.messages.create()` | the loop, running tools, errors, limits, approval, the conversation |
| 2 | **Tool Runner** | `@anthropic-ai/sdk`: `client.beta.messages.toolRunner()` + `betaZodTool()` | the tool functions |
| 3 | **Agent SDK** | `@anthropic-ai/claude-agent-sdk`: `query()` + `createSdkMcpServer()` + `tool()` | a prompt and options |

**Goal:** know what a harness does for the model, where each job lives in each of the three, what the bigger harness
costs in tokens and time, and when to pick which.

| Concept | Topic | Routes |
|---|---|---|
| 24 | Harnesses: a manual agent loop on the Messages API (`stop_reason`, `tool_use` / `tool_result`, `is_error`, `pause_turn`), the Tool Runner (`betaZodTool`, `ToolError`, `max_iterations`, `runner.params`), and `query()` as a harness (`canUseTool`, `maxTurns` + `error_max_turns`, `result.usage` vs `modelUsage`, `num_turns`, the `claude_code` preset, `createSdkMcpServer({ alwaysLoad })`) | `/api/c24/tools`, `/code`, `/run` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/24-harnesses.ts` | **New**: the shared tools, the three harnesses and the three routes |
| `server/index.ts` | Mounts the router on `/api/c24` |
| `src/concepts/Concept24Harnesses.tsx` | **New**: the tab (Parts A to C) |
| `src/App.tsx` | Adds the tab |
| `package.json`, `package-lock.json` | `@anthropic-ai/sdk` `^0.128.0` as a direct dependency (it was already installed by the Agent SDK) |
| `.gitignore` | Ignores `harness-lab/` |
| `Tab1-query().md` | Adds Concept 24 to the table |
| `Tab24-Harnesses.md` | This explanation |

---

## Step 1: What a harness is

The model is stateless. One request goes in, one response comes out. The response may end with
`stop_reason: "tool_use"` and a `tool_use` block, which is a **request** to run a tool. The model runs nothing
itself. Something has to:

1. send the request, with the tools and the conversation so far;
2. read `stop_reason`, find the `tool_use` blocks, **run the tools**, and turn failures into `is_error` results;
3. send all results back in one `user` message, and repeat;
4. **stop**: when the model is done, when a limit is hit, or when the user cancels;
5. decide **whether** a tool may run (permissions, approval);
6. keep the conversation, count the cost, handle a full context window.

That something is the **harness**. Claude Code is a harness, and a very large one. The Agent SDK is Claude Code as a
library, so every `query()` in Concepts 1 to 23 was "use Claude Code's harness".

Two words that often get mixed up:

- **Tool Runner ≠ Agent SDK.** The Tool Runner is a helper in the plain API SDK (`@anthropic-ai/sdk`) that loops over
  tools *you* define. It has no built-in tools, permissions, sessions or hooks. The Agent SDK is the whole of Claude
  Code.
- **Harness ≠ deployment.** All three harnesses here run on your machine (or your server). Anthropic's Managed Agents
  are the option where Anthropic runs the harness *and* hosts the sandbox. They are not covered here.

## Step 2: The tools, written once

Simplified from `SHOP_TOOLS` in [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts):

```ts
const SHOP_TOOLS = {
  search_products: { description, schema: z.object({ query: z.string().min(1) }),            run: (shop, input) => ... },
  get_stock:       { description, schema: z.object({ sku: z.string() }),                     run: ... },  // throws for an unknown sku
  reserve_stock:   { description, schema: z.object({ sku, warehouse: z.enum([...]), qty }),  run: ... },  // changes the stock
};
```

Each run gets its **own copy** of the four-product catalog, so a reservation in one harness doesn't change what the
other two see. Each harness then wraps the same `schema` and `run` in its own shape (Part A of the tab shows
`reserve_stock` in all three):

| Harness | Shape | Name the model sees |
|---|---|---|
| manual | `{ name, description, input_schema: z.toJSONSchema(schema) }` (an `Anthropic.Tool`) | `reserve_stock` |
| runner | `betaZodTool({ name, description, inputSchema: schema, run })` (adds `parse` and `run`) | `reserve_stock` |
| sdk | `tool(name, description, schema.shape, handler)` in `createSdkMcpServer({ name: "shop" })` | `mcp__shop__reserve_stock` |

The same model (Haiku 4.5), the same short system prompt (*"You are the Atmira shop assistant… at most 5 lines"*),
and a limit of 10 model calls in all three, so the numbers compare.

## Step 3: Harness 1, the manual loop

Simplified from `runManual()` in [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts):

```ts
const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];   // YOU hold the conversation
while (true) {
  if (turns >= maxTurns) break;                                                  // YOU stop a confused model
  const response = await client.messages.create({ model, max_tokens, system, tools: manualTools, messages }, { signal });
  messages.push({ role: "assistant", content: response.content });              // keep every answer
  if (response.stop_reason === "pause_turn") continue;
  if (response.stop_reason !== "tool_use") break;                                // end_turn, max_tokens, refusal…
  const results = [];
  for (const call of toolUseBlocks(response)) results.push(executeManual(shop, call, gate));
  messages.push({ role: "user", content: results });                             // ALL results in ONE user message
}
```

`executeManual` does four jobs the API never does for you: find the tool, **validate** the input with
`schema.safeParse` (the API does not promise the input matches the schema), apply the approval policy, and turn a
thrown error into `{ is_error: true }` so the model can read it and react.

One bug was found in testing: the first version pushed the assistant message only before running tools, so the
**final answer was missing** from `messages` (5 entries against the runner's 6). A follow-up question would have lost
it. Now every response is pushed.

## Step 4: Harness 2, the Tool Runner

Simplified from `runRunner()` in [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts):

```ts
const tools = TOOL_NAMES.map((name) => betaZodTool({
  name, description, inputSchema: SHOP_TOOLS[name].schema,
  run: async (input) => {
    if (gate && policy(name, input)) throw new ToolError(reason);   // approval lives INSIDE the tool
    return JSON.stringify(SHOP_TOOLS[name].run(shop, input));        // a throw becomes "Error: <message>", is_error
  },
}));
const runner = client.beta.messages.toolRunner({ model, max_tokens, system, tools, messages, max_iterations: 10 }, { signal });
for await (const message of runner) { /* one API response per iteration; tools run after the yield */ }
```

The runner owns the loop, the zod validation (`parse`), the `is_error` results and the stop. What's left for you:

- **Approval.** No permission system: gate inside `run()` and throw a `ToolError` (its text is the result the model
  reads), or look at the pending `tool_use` blocks between iterations.
- **`max_iterations`.** When it is reached, the loop simply ends. The last message still has
  `stop_reason: "tool_use"`, so check it: the lab reports *"max_iterations (2)"* from exactly that.
- **The conversation** is in `runner.params.messages`.
- **Cost.** Like the manual loop, you add up `usage` and multiply by the prices.

It is a beta API (`client.beta.…`). It also does not resume `pause_turn` by itself (only relevant with server tools,
which this lab doesn't use).

## Step 5: Harness 3, the Agent SDK

Simplified from `runSdk()` in [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts):

```ts
const server = createSdkMcpServer({ name: "shop", version: "1.0.0", alwaysLoad: true, tools: [...] });
const canUseTool: CanUseTool = async (toolName, input) =>
  gate && policy(toolName, input) ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };

query({ prompt, options: {
  model, thinking: { type: "disabled" },
  systemPrompt: SYSTEM,                    // or { type: "preset", preset: "claude_code", append: SYSTEM }
  tools: [],                               // no built-in tools, like the other two (or the claude_code preset)
  mcpServers: { shop: server }, strictMcpConfig: true,
  allowedTools: ["mcp__shop__search_products", "mcp__shop__get_stock", "Read", "Glob", "Grep"],
  canUseTool,                              // asked for every tool NOT in allowedTools, e.g. reserve_stock
  maxTurns: 10, cwd: "harness-lab", settingSources: [], settings: { autoMemoryEnabled: false }, persistSession: false,
}});
```

Claude Code runs the loop in its own process. Your code **configures** it and **reads** the messages it streams. Its
handlers return `isError` instead of throwing. Three parts of it surprised the tests:

- **`maxTurns` throws.** The iterator first yields `result` with `subtype: "error_max_turns"`, then **throws**
  *"Claude Code returned an error result: Reached maximum number of turns (2)"*. The first version lost the summary
  because of that throw. The route now keeps the `result` it already has and shows the throw as its own step.
- **Built-in tools run inside Claude Code**, so no handler of yours reports them. The lab reads their results from
  the `tool_result` blocks of the `user` messages.
- **Its assistant messages carry `stop_reason: null`**, one message per content block (text, then each `tool_use`),
  all with the same `message.id`. The tab merges them into one row per model call, and shows the stop reason the
  blocks imply (`tool_use` if there is a tool call, else `end_turn`) marked *(inferred)*.

## Step 6: The same prompt in the three harnesses

All three run at the same time (the tab opens three SSE requests). Results on Haiku 4.5:

| # | Prompt | Manual | Runner | Agent SDK |
|---|---|---|---|---|
| 1 | *Which keyboards do we sell, and how many are in stock in Madrid?* | 3 calls, 2 tools, $0.0038, 3.9 s | 3 calls, 2 tools, $0.0039, 3.9 s | 3 calls, 2 tools, $0.0056, 7.2 s |
| 2 | *Give me the stock of every headset and every monitor we sell.* | 2 parallel `search_products`, then 2 parallel `get_stock`: 3 calls, $0.0047 | the same, $0.0047 | the same, $0.0067 |
| 3 | *How many units of ZZ-999 are in stock?* | `get_stock` threw → your `catch` → `is_error`, $0.0025 | the runner caught it, $0.0025 | `isError` from the handler, $0.0040 |
| 4 | *Reserve 10 wireless mice (MS-202) from Madrid…* | reserved, 30 left, $0.0026 | the same | `canUseTool` allowed it, $0.0042 |
| 5 | the same + **approval policy** | **denied** by your `if` | **denied** by `ToolError` | **denied** by `canUseTool` |
| 6 | four `get_stock` one at a time + **limit 2** | *your turn counter (2)* | *max_iterations (2)* | `error_max_turns`, then `query()` threw |
| 7 | *Our returns policy is a file in the docs folder…* + **Claude Code preset** | *"I don't have access to files"*, $0.0027 | the same, $0.0028 | `Glob` + `get_stock`, `Read`: the right rule, $0.0401 |
| 8 | *Say hello in five words.* | 1 call, 908 in, $0.0010, 1.3 s | 908 in, $0.0010, 1.0 s | 1,149 in, $0.0012, 3.9 s |

What the numbers show:

- **The two API harnesses are the same request.** Same tokens (1,964 and 1,964 in scenario 4), same answers. The
  runner saves you code, not tokens.
- **The Agent SDK adds a little, even when stripped down.** With `tools: []` and your own system prompt: about 240
  input tokens more per call (1,149 against 908 in 8) and 2 to 4 s more per run, because it starts a Claude Code
  process first.
- **The full Claude Code harness is big.** With the preset (7), 37 tool definitions and Claude Code's system prompt
  went through the cache: 26,044 tokens written, 51,441 read, **$0.040, about 10 times more**. Only this harness could
  read the file. That is the trade.
- **In 5 the model got the same reason in all three** and answered the same way. Only the place of the check changes.

## Step 7: Counting in the Agent SDK: `result.usage`, `modelUsage`, `num_turns`

The comparison table showed that the Agent SDK's numbers need care:

| Scenario | `result.usage` input | `modelUsage` input | `total_cost_usd` |
|---|---|---|---|
| 3 (a tool call) | 2,450 | 3,355 | $0.004045 = 3,355 × $1 + 138 × $5 per million |
| 2 (two rounds of tool calls) | 4,244 | 5,150 | $0.0067 |
| 8 (no tool) | 1,149 | 1,149 | $0.0012 |

- **`total_cost_usd` is priced from `modelUsage`**, not from `result.usage`. In the runs with tool calls,
  `modelUsage` had about 900 input tokens more. The lab uses `modelUsage` for the totals (Concept 15 has more on
  this).
- **`num_turns` is not the number of model calls.** Scenario 2 made 3 model calls and reported `num_turns: 5`; the
  preset run of 7 made 3 and reported 4. The lab counts model calls as distinct assistant `message.id`s, because the
  SDK streams one assistant message per content block with the same id.

## Step 8: With the claude_code preset, MCP tools are deferred

In the first try of scenario 7, the SDK harness got the preset's 37 built-in tools, and the shop tools were **not in
the prompt**. They were deferred behind `ToolSearch`, and the model had to load them first. Haiku then read the policy
file, loaded `get_stock` with `ToolSearch`, and tried to call it **from PowerShell** (`canUseTool` denied it). It
took 6 calls and 35 s, and never got the stock. Simplified from `runSdk()` in [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts):

```ts
createSdkMcpServer({ name: "shop", version: "1.0.0", alwaysLoad: true, tools })   // never deferred
```

With `alwaysLoad: true` the same prompt took 3 calls and 8 s: `Glob` and `get_stock` in parallel, then `Read`. In a
big harness, the tools *you* care about can be one of 40. Keep them in the prompt.

The preset also turns on **auto memory** (Concept 22). It created an empty
`~/.claude/projects/<…>-harness-lab/memory/` folder, even with `persistSession: false`. The folder was removed, and the
lab now sets `settings: { autoMemoryEnabled: false }`.

## Step 9: Server routes

**File:** [server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts)

- `GET /tools`: `reserve_stock` in the three shapes (functions shown as placeholders).
- `GET /code`: this file cut at its `// #region tools | manual | runner | sdk` markers, for Part A.
- `POST /run` `{ harness, prompt, switches }`: SSE, one harness per request. Events: `options` (sdk only), `step`
  (`init`, `response`, `tool`, `thrown`), `context` (who holds the conversation and, for the API harnesses, the
  messages), `summary` (`turns`, `toolCalls`, `totals`, `cost`, `stop`, `answer`, `duration_ms`, and for the sdk its
  `num_turns` and `result.usage`), `error`, `done`. Stops after 120 s.

The body is checked with zod. `harness` must be `manual`, `runner` or `sdk` (a `z.enum`, so `__proto__` is refused).
The prompt must be a string of 1 to 2,000 characters. The switches must be names from `gate`, `limit`, `claudeCode`.
Anything else, or an extra key, gets an `error` event with the reason, then `done`. `harness-lab/` (the SDK harness's `cwd`, with `docs/returns-policy.md`) is recreated when the server
starts.

## Step 10: Browser flow

**File:** [src/concepts/Concept24Harnesses.tsx](src/concepts/Concept24Harnesses.tsx)

1. **A · One tool, three shapes**: `reserve_stock` as each harness needs it, and buttons that show the code of the
   shared tools and of each harness. The manual loop is agent logic. The Agent SDK code is mostly configuration.
2. **B · The same prompt in the three harnesses**: 8 scenarios and 3 switches, then **Run the three harnesses**.
   Three columns fill in at the same time: every model call (with its `tool_use` blocks), every tool run (ran, error,
   denied, or built-in), the answer, what stopped the loop, and who holds the conversation. A table below compares
   model calls, tool calls, tokens, cache, cost, time and the stop reason.
3. **C · Who does what**: the table below.

## What to take away

| Job | Manual loop | Tool Runner | Agent SDK |
|---|---|---|---|
| Send the request, read `stop_reason` | your `while` | the runner | Claude Code |
| Hold the conversation | your `messages` | `runner.params.messages` | the Claude Code process (sessions, resume) |
| Validate tool input | `safeParse` | zod `parse` | the MCP server (zod) |
| A tool fails | your `try/catch` → `is_error` | caught → `is_error` | `isError` from the handler |
| Approval | an `if` | `throw new ToolError()` | `allowedTools` + `canUseTool` (+ hooks, modes) |
| Stop after N calls | your counter | `max_iterations` | `maxTurns` → `error_max_turns` (and a throw) |
| Cost | `usage` × prices | `usage` × prices | `total_cost_usd`, `modelUsage` |
| Built-in tools, skills, subagents, hooks, MCP, plugins | — | — | yes (Concepts 3 to 23) |

1. **The model only answers. The harness makes it an agent.** Loop, tools, errors, limits, permissions, context.
2. **Write the loop once to understand it.** It is about 50 lines, and every harness does the same steps.
3. **Use the Tool Runner for an agent over your own tools**: the same requests and tokens as your loop, with less
   code. Gate approval inside the tools.
4. **Use the Agent SDK when you want Claude Code's parts**: files, shell, subagents, skills, hooks, sessions,
   permissions. It costs a process start and, with the preset, many more tokens per call.
5. **Every harness needs a stop.** Your counter, `max_iterations`, `maxTurns`. Check which one fired.
6. **Read the Agent SDK's numbers carefully.** Cost comes from `modelUsage`, and `num_turns` is not the number of
   model calls.
7. **In a big harness, keep your own tools in view** with `alwaysLoad: true`.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/24-harnesses.ts](server/concepts/24-harnesses.ts) and
[src/concepts/Concept24Harnesses.tsx](src/concepts/Concept24Harnesses.tsx). The three harness bodies are already
shown in Steps 3, 4 and 5 above, so this section covers the parts around them.

### Step 1: Read the types of two packages

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `createSdkMcpServer`, `alwaysLoad`, `tool(`,
`CanUseTool`, `maxTurns`, `error_max_turns` and `modelUsage`. The other two harnesses use the plain API client,
`@anthropic-ai/sdk`. It was already in `node_modules` (the Agent SDK depends on it), and it was added to
`package.json` so the import is explicit. The server imports three things from it:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { createSdkMcpServer, query, tool, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
```

- `betaZodTool` and `ToolError` come from deep import paths. They are the Tool Runner's helpers.
- `new Anthropic()` reads `ANTHROPIC_API_KEY` from the environment, like Claude Code does.

### Step 2: The constants, the prices, and the lab folder

```ts
const MODEL = "claude-haiku-4-5-20251001"; // the same model in the three harnesses, so the numbers compare
const MAX_TOKENS = 16000;
const MAX_TURNS = 10; // every harness needs a stop, even when nobody asked for one
// …
const SYSTEM = "You are the Atmira shop assistant. Use the tools to answer. Be brief: at most 5 lines.";

// Haiku 4.5 prices per million tokens. The Agent SDK computes total_cost_usd itself; for the two API harnesses
// the lab computes it from `usage`, the way you would in your own harness.
const PRICE = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
```

- One `MODEL`, one `SYSTEM` and one `MAX_TURNS` for all three. Without that, the comparison table would mean
  nothing.
- `PRICE` is only used by the two API harnesses. The Agent SDK gives `total_cost_usd` itself.
- `resetLab()` recreates `harness-lab/docs/returns-policy.md` when the server starts. Only the SDK harness with the
  preset can read it (scenario 7).

### Step 3: The shared tools, and one report shape

`SHOP_TOOLS` (Step 2 above) is written once. Then each harness must report to the browser in the **same** shape,
so the three columns can be compared:

```ts
type Send = (event: string, data: unknown) => void;
type Setup = { prompt: string; gate: boolean; limit: boolean; claudeCode: boolean; signal: AbortSignal; send: Send };
type Totals = { input: number; output: number; cacheWrite: number; cacheRead: number };
const addUsage = (t: Totals, u: Anthropic.Usage | Anthropic.Beta.BetaUsage) => {
  t.input += u.input_tokens;
  t.output += u.output_tokens;
  t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  t.cacheRead += u.cache_read_input_tokens ?? 0;
};
const costOf = (t: Totals) => (t.input * PRICE.input + t.output * PRICE.output + t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6;
```

- Every harness is a function `(setup: Setup) => Promise<summary>`. It sends `step` events while it runs, and
  returns `{ turns, toolCalls, totals, cost, stop, answer }`.
- `policy()` is the approval rule for the `gate` switch. It is shared too: only **where** it is called changes.
- The code between `// #region tools` and `// #endregion` is what Part A shows as "shared tools".

### Step 4: Write the three harnesses

Write `runManual()`, `runRunner()` and `runSdk()` as shown in Steps 3, 4 and 5 above. The one part that is not
shown there is how `runSdk()` survives the throw after `error_max_turns`:

```ts
let result: any;
try {
  for await (const msg of query({ prompt, options })) {
    // …
    if (msg.type === "result") result = msg;
  }
} catch (err) {
  // After an error result (error_max_turns...), the iterator also THROWS. The result message came first: keep it.
  if (!result) throw err;
  send("step", { kind: "thrown", message: String(err) });
}
if (!result) throw new Error("query() ended without a result message."); // e.g. the run was stopped
```

- The `result` is saved **before** the throw arrives. So the summary can still be built, and the throw is shown as
  its own `thrown` row.
- If there is no `result`, the error is real, and it goes up to the route.
- The loop can also end with no `result` and no throw, for example when the run is stopped. The last line turns that
  into a clear error, instead of a `TypeError` on `result.modelUsage` a few lines later.
- The totals are then added from `result.modelUsage`, not `result.usage` (see Step 7 above).

`query()` takes an `AbortController`, but the API clients take an `AbortSignal`. `abortFrom()` bridges the two, so
**Stop** cancels all three harnesses in the same way.

### Step 5: The routes

`GET /code` cuts the server's own file at the `#region` markers:

```ts
const SOURCE = fileURLToPath(import.meta.url);

concept24.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, code]) => [name, code.trimEnd()])));
});
```

`POST /run` runs **one** harness. The browser picks it by name, and zod checks the body:

```ts
const HARNESSES = { manual: runManual, runner: runRunner, sdk: runSdk };

// The request body: a harness name, a prompt, and switch names only.
const RunBody = z
  .object({
    harness: z.enum(["manual", "runner", "sdk"]),
    prompt: z.string().trim().min(1).max(MAX_PROMPT),
    switches: z.array(z.enum(["gate", "limit", "claudeCode"])).max(3).default([]),
  })
  .strict();
// …
if (!parsed.success) {
  send("error", { message: badRequest(parsed.error) });
  return finish();
}
const { harness, prompt, switches } = parsed.data;
const setup: Setup = { prompt, gate: switches.includes("gate"), limit: switches.includes("limit"), claudeCode: switches.includes("claudeCode"), signal: abort.signal, send };
// …
try {
  const summary = await HARNESSES[harness](setup);
  send("summary", { ...summary, duration_ms: Date.now() - started });
  // …
} catch (err) {
  if (!abort.signal.aborted) send("error", { message: String(err) });
} finally {
  clearTimeout(timer);
  finish();
}
```

- This route does not use `pipe()` from [server/sse.ts](server/sse.ts), because two of the harnesses are not a
  stream of SDK messages. It uses `send()`, and `finish()` sends `done` and ends the response.
- A bad body (an unknown harness, an empty prompt, an unknown switch) gets an `error` event with the reason, then
  `done`. The switches then become three booleans.
- `duration_ms` is measured here, around the whole harness call, so the process start of the Agent SDK is counted.
- `GET /tools` builds `reserve_stock` in the three shapes, and replaces the functions with placeholder strings.

### Step 6: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept24 } from "./concepts/24-harnesses.js";
// …
app.use("/api/c24", concept24);
```

### Step 7: The React tab: three requests at once

The tab keeps one `Lane` per harness. **Run the three harnesses** opens three SSE requests with the same body,
except `harness`:

```tsx
async function runAll() {
  setError(null);
  const ctrl = new AbortController();
  setController(ctrl);
  setLanes({ manual: { ...emptyLane(), busy: true }, runner: { ...emptyLane(), busy: true }, sdk: { ...emptyLane(), busy: true } });
  // Three requests at the same time: the three harnesses race on the same prompt.
  await Promise.all(harnesses.map((h) => runOne(h.id, ctrl.signal)));
  setController(null);
}
```

And `runOne()` sorts each lane's events:

```tsx
await streamPost(
  "/api/c24/run",
  { harness: id, prompt: form.prompt, switches: form.switches },
  (event, data) => {
    if (event === "step") update(id, (l) => ({ ...l, steps: addStep(l.steps, data) }));
    if (event === "summary") update(id, (l) => ({ ...l, summary: data }));
    if (event === "context") update(id, (l) => ({ ...l, context: data }));
    if (event === "options") update(id, (l) => ({ ...l, options: data }));
    if (event === "error") update(id, (l) => ({ ...l, error: data.message }));
  },
  signal,
);
```

- One `AbortController` is shared by the three requests, so one **Stop** button closes all three.
- `addStep()` merges the Agent SDK's messages that share a model call number into one row, and marks the inferred
  `stop_reason` (see Step 5 above).
- The comparison table is built from the three `summary` events. The **Who does what** table (Part C) is a fixed
  array, `duties`.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 24, title: "Harnesses", Component: Concept24Harnesses },
```

### Step 8: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 24. Part A shows `reserve_stock` in three shapes, and four code buttons.
3. Run **1 · Two tools in a row**: three columns fill in at the same time, then the comparison table appears.
4. Run **6 · Turn limit**: the SDK column shows a `query() threw` row after the result.
5. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 24

1. Run **1** twice and compare the three columns. Then open **manual harness** in Part A and find each line that the
   runner does for you.
2. Run **5**, then change `policy()` in the server to allow up to 20 units and run it again.
3. Run **6**, then remove `if (turns >= maxTurns)` from the manual loop (on a copy!) and think about what a confused
   model would cost.
4. Run **8** with and without the Claude Code preset, and compare the cache columns.
5. Remove `alwaysLoad: true` and run **7** again: look for `ToolSearch` in the SDK column.
6. Add a fourth tool to `SHOP_TOOLS` (for example `cancel_reservation`) and see it appear in all three harnesses with
   no other change.

Costs on Haiku: $0.001 to $0.007 per harness per scenario, except the Claude Code preset (about $0.04).

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **24. Harnesses**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. `ANTHROPIC_API_KEY` must be in `.env`:
the two API harnesses use it through `new Anthropic()`, and the Agent SDK passes it to Claude Code.

To call the endpoints without the UI:

```powershell
curl.exe http://localhost:3001/api/c24/tools
curl.exe http://localhost:3001/api/c24/code

'{"harness":"manual","prompt":"Which keyboards do we sell?","switches":[]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c24/run -H "Content-Type: application/json" -d "@body.json"

'{"harness":"sdk","prompt":"Reserve 10 wireless mice (MS-202) from Madrid.","switches":["gate"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c24/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
