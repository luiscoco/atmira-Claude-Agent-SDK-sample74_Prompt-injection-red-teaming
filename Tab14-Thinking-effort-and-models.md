# Concept 14: Thinking, effort & models, step by step

This file explains how Concept 14 (**Thinking, effort & models**) was added to the Claude Agent SDK Lab.
Concept 2 introduced `model`. Concept 12 switched it with `setModel()`. This concept looks at **how hard the model
works before it answers**, which three options control:

- **`thinking`**: whether the model reasons before answering, with what budget, and whether you get to read it.
- **`effort`**: how deep that reasoning (and the answer) goes, on models that support it.
- **`model`** (+ `fallbackModel`): which model runs, what it supports, and what happens when it is not available.

There are three parts:

- **A. The same prompt, several configurations.** Up to four runs in parallel, side by side.
- **B. What each model supports.** `supportedModels()` and `fallbackModel`.
- **C. Changing them while the session is alive.** `applyFlagSettings({ effortLevel })`, `setMaxThinkingTokens()`,
  `setModel()`.

| Concept | Topic | Routes |
|---|---|---|
| 14 | `thinking` (`adaptive` / `enabled` / `disabled`, `display`), `effort`, `fallbackModel`, `supportedModels()`, `applyFlagSettings({ effortLevel })`, `setMaxThinkingTokens()` | `/api/c14/run`, `/models`, `/session`, `/send`, `/effort`, `/thinking`, `/model`, `/end` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/14-thinking-effort-models.ts` | **New**: `/run`, `/models` and the live-session routes |
| `server/index.ts` | Mounts the router on `/api/c14` |
| `src/concepts/Concept14ThinkingEffortModels.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | Comparison grid, thinking text, effort badge |
| `Tab1-query().md` | Adds Concept 14 to the table of concepts |
| `Tab14-Thinking-effort-and-models.md` | This explanation |

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
type Options = {
  thinking?: ThinkingConfig;       // "When set, takes precedence over the deprecated maxThinkingTokens"
  effort?: EffortLevel;            // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxThinkingTokens?: number;      // @deprecated: use `thinking`
  fallbackModel?: string;          // "if the primary model is overloaded or unavailable"
  // ...
};

type ThinkingConfig =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }                        // Claude decides when and how much
  | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }  // fixed budget (older models)
  | { type: 'disabled' };

type ModelInfo = {
  value: string; resolvedModel?: string; displayName: string; description: string;
  supportsEffort?: boolean; supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean; supportsFastMode?: boolean; supportsAutoMode?: boolean;
};

type ModelUsage = {
  inputTokens: number; outputTokens: number;
  thinkingTokens?: number;         // "already counted inside outputTokens"
  costUSD: number; contextWindow: number; maxOutputTokens: number; /* ... */
};

interface Query {
  supportedModels(): Promise<ModelInfo[]>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: ...): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null; /* any Settings key */ }): Promise<void>;
}
```

Two more things found in the types shaped the design:

1. **Hooks receive the effort.** `BaseHookInput.effort?: { level: string }` is the *"active effort level for the
   current turn, after any silent downgrade for the selected model"*, and it is absent on models without effort. So
   a `Stop` hook can report what was **really** sent, not what you asked for.
2. **There is no `setEffort()`.** Effort is a setting (`effortLevel`), so a live session changes it with
   `applyFlagSettings()`, the mid-session version of the `settings` option.

---

## Step 2: Try it before writing the lab

Three scratch scripts ran against the real SDK first, with the same small puzzle (*"How many times does the digit 7
appear when you write every integer from 1 to 1000?"*, answer **300**). What they showed decided the scenarios:

| Finding | Effect on the lab |
|---|---|
| Haiku 4.5 **thinks by default** (~800 to 1,950 thinking tokens), but the thinking text is **empty** | `display` is part of every comparison |
| With `display: "summarized"` the text arrives as `thinking_delta` stream events | The tab streams it live |
| Sonnet 5 at the default effort (`high`) often **skipped thinking** on this puzzle, and sometimes answered **301** | The effort ladder (Part A) |
| Sonnet 5 ignores `{ type: "enabled", budgetTokens: 4000 }`: no thinking, the hook says `high` | Its own scenario |
| The `Stop` hook reports `null` for Haiku, even with `effort: "max"` | *effort on a model without effort* |
| Every Sonnet run also lists a small **Haiku** entry in `modelUsage` (~$0.001) | Explained in Step 5 |
| In a live session, the same question asked again is answered from the conversation, without thinking | Part C asks a different question each turn |

---

# Part A: The same prompt, several configurations

## Step 3: One route, only the options you chose

`POST /run` builds `options` like Concept 2 did: a field left empty in the form is **omitted**, so "(omit)" really
means the model's default.

```ts
function thinkingConfig({ thinking, budgetTokens, display }: RunBody): ThinkingConfig | undefined {
  if (thinking === "disabled") return { type: "disabled" };
  if (thinking === "adaptive") return { type: "adaptive", ...(display && { display }) };
  if (thinking === "enabled") return { type: "enabled", ...(budgetTokens && { budgetTokens }), ...(display && { display }) };
  return undefined;
}

const options: Options = {
  ...BASE,
  maxTurns: 1,
  includePartialMessages: true, // thinking arrives as thinking_delta stream events, before the answer
};
if (body.model) options.model = body.model;
const thinking = thinkingConfig(body);
if (thinking) options.thinking = thinking;
if (body.effort) options.effort = body.effort;
if (body.fallbackModel) options.fallbackModel = body.fallbackModel;
```

`BASE` is `{ tools: [], settingSources: [], strictMcpConfig: true }`, and `body` is the request body after the zod
check (see "How it was built" below).

`includePartialMessages: true` matters here: thinking arrives as `stream_event` → `content_block_delta` →
`delta.type: "thinking_delta"`, **before** the first `text_delta` of the answer.

The browser opens **one stream per column, all at the same time**, so the durations can be compared.

## Step 4: Which effort was really used? A Stop hook

```ts
function effortReporter(send: (event: string, data: unknown) => void): Options["hooks"] {
  const report: HookCallback = async (input) => {
    send("effort", { level: input.effort?.level ?? null });
    return {};
  };
  return { Stop: [{ hooks: [report] }] };
}
```

`null` means that no effort parameter was sent.

This is the same `hooks` option as Concept 7, used only to observe. `system/init` also has an `effort` field, but in
this SDK version it is only filled on Remote Control sessions, so it stays `undefined` here.

## Step 5: Where the numbers come from

Each result card shows `result.modelUsage`, one row per model:

| Field | Meaning |
|---|---|
| `outputTokens` | Everything the model generated, **including thinking** |
| `thinkingTokens` | The thinking part, *"already counted inside outputTokens"* |
| `costUSD` | The cost for that model. `total_cost_usd` is the sum |

Two things to know:

- **`result.usage` is not enough.** The SDK says it covers the *main agent loop only*, and to *"prefer modelUsage for
  token/cost accounting"*. In these tests every Sonnet run listed an extra **Haiku** row (~900 input tokens, ~20 output,
  ~$0.001). That is a small auxiliary call Claude Code makes on its own, outside the agent loop. Runs on Haiku don't
  have it.
- **`system/thinking_tokens`** messages (subtype `thinking_tokens`, `estimated_tokens`) arrive while the model thinks.
  They are an estimate for spinners, not what you pay. The tab shows the last one next to "thinking".

## Step 6: The comparisons, tested

Tested through the lab's route (the real `/api/c14/run`, driven by a script like the browser does):

**Thinking on / off (Haiku 4.5, the 7s puzzle):**

| `thinking` | Answer | Thinking tokens | Output tokens | Cost | Time |
|---|---|---|---|---|---|
| (omit) | 300 | 781 | 809 | $0.0056 | 7.2 s |
| `disabled` | the whole reasoning, then 300 | 0 | 240 | $0.0027 | 2.6 s |
| `enabled`, `budgetTokens: 1024`, `summarized` | 300 | 425 | 453 | $0.0038 | 3.2 s |
| `enabled`, `budgetTokens: 2000`, `omitted` | 300 | 566 | 593 | $0.0045 | 5.4 s |

With thinking **disabled**, Haiku still reasoned, but it wrote the reasoning **into the answer**. Turning thinking off
does not make the model skip reasoning: it moves it to where you can see it (and it cost fewer tokens here).

**`display`:** `omitted` produced a `thinking` block with an empty `thinking` string and `thinking_delta` events with
no text, but `thinkingTokens` was still 566. You pay for the thinking either way; `summarized` lets you read it.

**Effort ladder (Sonnet 5, adaptive, the clock puzzle, answer 7.5):**

| `effort` | Applied (hook) | Thinking tokens | Sonnet output | Cost |
|---|---|---|---|---|
| `low` | `low` | 0 | 5 | $0.0027 |
| `medium` | `medium` | 0 | 5 | $0.0027 |
| `high` | `high` | 0 | 5 | $0.0027 |
| `max` | `max` | 144 | 150 | $0.0042 |

With **adaptive** thinking the model decides whether to think, and effort pushes that decision. On an easy question
only `max` thought at all. `xhigh` and `max` exist only on some models (see Part B).

**Effort on a model without effort:** `{ model: haiku, effort: "max" }` is accepted without an error, but the hook
reports `null`: no effort was sent. Nothing warns you, so check `supportedModels()` first.

---

# Part B: What each model supports

## Step 7: `supportedModels()` without a conversation

`supportedModels()` is a control request (Concept 12), so it needs a running process. `GET /models` starts a
`query()` whose prompt is a generator that never yields, asks, and closes it:

```ts
async function loadModels() {
  let close = () => {};
  async function* noMessages(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => (close = resolve));
  }
  const q = query({ prompt: noMessages(), options: BASE });
  try {
    return await q.supportedModels();
  } finally {
    close(); // the generator returns, the input closes, and the process exits
    for await (const _ of q); // drain the stream so the process is gone before we answer
  }
}
```

No model is called, so it costs nothing (~0.5 s to start the process). The server keeps the answer, so the second
click answers in 0 ms (`cached`).

What it returned for this login:

| `value` | `resolvedModel` | effort | adaptive thinking |
|---|---|---|---|
| `default` | `claude-opus-5-5[1m]` | low … max | ✔ |
| `opus[1m]` | `claude-opus-5-5[1m]` | low … max | ✔ |
| `claude-fable-5-1[1m]` | `claude-fable-5-1` | low … max | ✔ |
| `sonnet` | `claude-sonnet-5` | low … max | ✔ |
| `haiku` | `claude-haiku-4-5-20251001` | – | – |

That explains Part A: Haiku 4.5 has **no `supportsEffort`** and **no `supportsAdaptiveThinking`** (it uses a
thinking budget). An alias works as `model`: `model: "haiku"` gives `system/init.model: "claude-haiku-4-5-20251001"`.

## Step 8: `fallbackModel`

Both runs use a model name that doesn't exist, `claude-nope-9`:

| Options | What happened |
|---|---|
| `model: "claude-nope-9"` | An `assistant` message with `error: "model_not_found"`, then **`result/success` with `is_error: true`**, and the `for await` loop threw. No cost. |
| `+ fallbackModel: "claude-haiku-4-5-20251001"` | `system/model_fallback`, then a normal answer from Haiku, `result/success`, `is_error: false`, $0.0032 |

```json
{ "type": "system", "subtype": "model_fallback", "trigger": "model_not_found",
  "original_model": "claude-nope-9", "fallback_model": "claude-haiku-4-5-20251001",
  "content": "Switched to Haiku 4.5 because claude-nope-9 is not available" }
```

Three details:

- **Check `is_error`, not only `subtype`.** The failed run's subtype was still `success`.
- `system/init.model` still says `claude-nope-9`. `modelUsage` and `assistant.message.model` tell you which model
  really answered. The model itself was told it was `claude-nope-9` (it said so in its answer).
- `system/model_fallback` is not in the `SDKMessage` types of this version, so the tab reads it as raw JSON.
  The primary model is tried again at the start of every user turn, so a short outage doesn't change the whole
  session.

---

# Part C: Changing them while the session is alive

## Step 9: Three control routes

The session is the Concept 12 pattern (input queue, `Map` of sessions, `control()` wrapper), started with
`thinking: { type: "adaptive", display: "summarized" }` and the same Stop hook.

Simplified from the `/effort`, `/thinking` and `/model` routes in `14-thinking-effort-models.ts`:

```ts
// There is no setEffort(). Effort is a setting, so it goes through the session's flag-settings layer.
await q.applyFlagSettings({ effortLevel: level });    // null = back to the model's default

// 0 turns thinking off, a number sets a budget, null goes back to the session's default.
await q.setMaxThinkingTokens(tokens);

await q.setModel(model);                               // Concept 12
```

## Step 10: One session, tested

One session, one control between turns, and a **different question each turn**:

| Before the turn | Model | Applied effort | Thinking tokens | Answer |
|---|---|---|---|---|
| (start) | Sonnet 5 | `high` | 0 | 300 |
| `applyFlagSettings({ effortLevel: "max" })` | Sonnet 5 | `max` | 165 | 328 |
| `setMaxThinkingTokens(0)` | Sonnet 5 | `max` | **0** | 5 |
| `setMaxThinkingTokens(null)`, `applyFlagSettings({ effortLevel: null })`, `setModel(haiku)` | Haiku 4.5 | `null` | 323 | 7.5 |
| `setMaxThinkingTokens(0)` | Haiku 4.5 | `null` | **0** | 3 |
| `setMaxThinkingTokens(8000)` | Haiku 4.5 | `null` | 58 | 391 |

- **Each change applies from the next turn.** The hook shows it each time.
- **`setMaxThinkingTokens(0)` wins over effort.** Effort was still `max`, but the model did not think.
- **`effortLevel: null` resets** to the model's default (`high` on Sonnet 5).
- After `input.close()`, any control route answers `409` (*No open session with that id*).

The first test asked the **same** question in every turn. After the first answer, the model repeated it from the
conversation, and even at `max` it did not think again. That is why the presets are different questions.

## What to take away

1. **Thinking has two parts: doing it and showing it.** `thinking.type` decides whether the model thinks;
   `display` decides whether you get the text. `omitted` still bills the thinking tokens.
2. **Adaptive thinking + effort.** On models with adaptive thinking (Sonnet 5, Opus, Fable), the model decides when to
   think, and `effort` is the dial. A fixed `budgetTokens` does not force it.
3. **Budget thinking on Haiku 4.5.** Haiku thinks by default, has no effort, and ignores `effort` silently.
4. **Ask the model what it supports.** `supportedModels()` tells you `supportsEffort`, `supportedEffortLevels` and
   `supportsAdaptiveThinking`. A `Stop` (or `PreToolUse`) hook tells you the effort that was really applied.
5. **Read `modelUsage`.** `thinkingTokens` is inside `outputTokens`, and auxiliary calls on other models only appear
   there.
6. **`fallbackModel` turns a hard failure into `system/model_fallback`.** Without it, check `is_error`.
7. **In a live session, change them between turns** with `applyFlagSettings({ effortLevel })`,
   `setMaxThinkingTokens()` and `setModel()`.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/14-thinking-effort-models.ts](server/concepts/14-thinking-effort-models.ts) and
[src/concepts/Concept14ThinkingEffortModels.tsx](src/concepts/Concept14ThinkingEffortModels.tsx). `thinkingConfig()`,
`effortReporter()`, `loadModels()` and the three control calls are already shown in Steps 3, 4, 7 and 9 of the concept.

### Step 1: Read the types, then one shared base

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `ThinkingConfig`, `EffortLevel`,
`fallbackModel`, `ModelInfo`, `ModelUsage`, `BaseHookInput` (its `effort` field), `setMaxThinkingTokens` and
`applyFlagSettings` (see Step 1 of the concept). Every route of this file starts from the same small base:

```ts
/** Every run: no tools, no inherited settings or MCP servers. This concept is only about the model call. */
const BASE: Options = { tools: [], settingSources: [], strictMcpConfig: true };
```

- With no tools, every run is one model call, so the numbers you compare come only from `thinking`, `effort` and
  `model`.
- There is no `model` in `BASE`: when the form leaves it out, the SDK default is used.

### Step 2: `POST /run`: one column, one stream

The body schema lists what the form can send. Every field except `prompt` is optional, because "(omit)" must really
omit the option:

```ts
const RunBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: ModelName.optional(),
    thinking: z.enum(["adaptive", "enabled", "disabled"]).optional(), // undefined = omit the option (the model's default)
    budgetTokens: z.number().int().min(1).max(200_000).optional(),
    display: z.enum(["summarized", "omitted"]).optional(),
    effort: Effort.optional(),
    fallbackModel: ModelName.optional(),
  })
  .strict();
type RunBody = z.infer<typeof RunBody>;
```

- `ModelName` accepts any model id or alias (letters, digits and `. : [ ] - _`), even one that does not exist:
  the `fallbackModel` demo needs `claude-nope-9`.
- There is no rule between fields. The tab can send `display` with `thinking: "disabled"` (it keeps the value when
  you change the select), and `thinkingConfig()` simply ignores it.
- A bad body gets an `error` event, then `done`, as in Concept 34. The column shows the message.

The route builds the options as in Step 3 of the concept, and then:

```ts
send("options", { ...options, hooks: { Stop: ["[Function reportEffort]"] } });
pipe(query({ prompt: body.prompt, options: { ...options, hooks: effortReporter(send), abortController: abort } }));
```

- A function cannot be sent as JSON, so the tab gets a placeholder where the hook is.
- `effortReporter(send)` gets this request's `send`, so the hook writes an `effort` event into the right stream.

### Step 3: `GET /models`, asked once

`loadModels()` (Step 7 of the concept) starts a process. The route keeps the **promise**, so it runs only once:

```ts
let models: Promise<ModelInfo[]> | undefined;
// …
concept14.get("/models", async (_req, res) => {
  try {
    const startedAt = Date.now();
    const cached = !!models;
    models ??= loadModels();
    res.json({ models: await models, ms: Date.now() - startedAt, cached });
  } catch (err) {
    models = undefined;
    res.status(500).json({ error: String(err) });
  }
});
```

- Keeping the promise, not the result, means two clicks at the same time still start only one process.
- On an error the cache is cleared, so the next click tries again.
- `ms` and `cached` are there for the tab: the first answer takes about half a second, the second one 0 ms.

### Step 4: Part C: the session and its control routes

`POST /session` is the Concept 12 session (push queue, `Map` by id, `pipe(q).finally(...)`), with adaptive thinking
so the thinking text can be read, and the same Stop hook:

```ts
const { model = "claude-sonnet-5" } = parsed.data;
// …
const options: Options = {
  ...BASE,
  model,
  thinking: { type: "adaptive", display: "summarized" }, // so you can read what the model thought
  includePartialMessages: true,
};
```

The routes use the same `getSession()` + `control(schema, action)` wrapper as Concept 12: a bad body is a `400`, a
closed session a `409`. Each route passes its own schema, and `null` is a normal value:

```ts
concept14.post(
  "/effort",
  control(z.object({ id: Id, level: Effort.nullable() }).strict(), async ({ q, send, ms }, { level }) => {
    await q.applyFlagSettings({ effortLevel: level });
    send("control", { method: `q.applyFlagSettings({ effortLevel: ${JSON.stringify(level)} })`, ms });
  }),
);
```

- `JSON.stringify(level)` prints `null` and `"max"` correctly in the timeline.
- `/thinking` is the same shape, with `tokens: z.number().int().min(0).max(200_000).nullable()` and
  `setMaxThinkingTokens()`. `/model`, `/send` and
  `/end` are the Concept 12 routes.

### Step 5: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept14 } from "./concepts/14-thinking-effort-models.js";
// …
app.use("/api/c14", concept14);
```

### Step 6: The React tab: one run per column

Parts A and B both use `startRun()`. It streams one `/run` and passes every change to an `update` function:

```tsx
async function startRun(prompt: string, config: Config, update: (fn: (r: Run) => Run) => void) {
  const startedAt = Date.now();
  update(() => ({ messages: [], running: true }));
  try {
    await streamPost("/api/c14/run", { prompt, ...config }, (event, data) => {
      if (event === "message") {
        const isText = data.type === "stream_event" && data.event.type === "content_block_delta" && data.event.delta.type === "text_delta";
        update((r) => ({ ...r, messages: [...r.messages, data], firstTextMs: r.firstTextMs ?? (isText ? Date.now() - startedAt : undefined) }));
      }
      if (event === "effort") update((r) => ({ ...r, effort: data.level }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}
```

`runAll()` calls it once per column, without `await`, so all columns run at the same time. Each one writes only its
own slot:

```tsx
columns.forEach((config, i) =>
  startRun(prompt, config, (fn) =>
    setRuns((prev) => {
      const next = [...prev];
      next[i] = fn(next[i] ?? { messages: [], running: true });
      return next;
    }),
  ),
);
```

- `firstTextMs` is the time to the first answer token. Thinking happens before it, so it shows the thinking cost in
  time.
- The comparisons of Step 6 of the concept are only data: `compareSets` is a list of column `Config`s. `ConfigEditor` lets
  you change a column, and **+ column** stops at 4.
- `tryFallback()` in Part B uses the same pattern with the two `fallbackCases`.

### Step 7: Reading a run: `summarize()`

`RunCard` and the session timeline both read the raw messages through one function:

```tsx
// Thinking text grows through thinking_delta events. With display "omitted" the block exists but stays empty.
thinking: deltas.filter((d) => d.type === "thinking_delta").map((d) => d.thinking).join("") || thinkingBlocks.map((b: any) => b.thinking ?? "").join(""),
thinkingBlock: thinkingBlocks.length > 0,
estimate: estimates.at(-1)?.estimated_tokens as number | undefined,
```

- `thinkingBlock` without `thinking` is how the card knows to say **text omitted**.
- `estimate` is the last `system/thinking_tokens` message (Step 5 of the concept).
- `fallback` is found by `subtype === "model_fallback"`, read as plain JSON (Step 8 of the concept).

In Part C, `SessionTimeline` groups the messages by turn. `total_cost_usd` and the `modelUsage` thinking tokens are
running totals, so it keeps the previous values and prints the difference for each turn:

```tsx
let previous = { cost: 0, thinking: 0 }; // cost and modelUsage are running totals for the session
```

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 14, title: "Thinking, effort & models", Component: Concept14ThinkingEffortModels },
```

### Step 8: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 14. Keep **Thinking on / off (Haiku)** and press **Run 3 configuration(s) in parallel**.
   The `disabled` column shows no thinking and a lower cost.
3. Press **await q.supportedModels()** twice. The second time says "(cached by the server)".
4. Press **Run both** under `fallbackModel`: the second card shows `system/model_fallback`.
5. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 14

1. Run *Effort ladder* with **Count the 7s** several times. Does Sonnet ever answer 301 at `low`?
2. Add a fourth column to *Thinking on / off* with `budgetTokens: 4000`. Does a bigger budget mean more thinking?
3. Run *Models* with **Easy (Lisbon)** and compare the cost of each model for a one-word answer.
4. In Part C, start on Sonnet 5, set effort to `low`, and ask *Primes*. Then `max`, and ask *Clock angle*.
5. Run one column with `effort: xhigh` on Opus 5.5 and one on Haiku 4.5. What does the hook say for each?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**14. Thinking, effort & models**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell
steps. Part A with Sonnet or Opus costs a few tenths of a cent per column.

The routes can also be called without the UI:

```powershell
curl.exe http://localhost:3001/api/c14/models
'{"prompt":"What is 17 times 23?","model":"claude-haiku-4-5-20251001","thinking":"enabled","budgetTokens":1024,"display":"summarized"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c14/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
