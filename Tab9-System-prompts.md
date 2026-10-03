# Concept 9: System prompts, step by step

This file explains how Concept 9 (**System prompts**) was added to the Claude Agent SDK Lab.
It builds on Concept 2 ([Tab2-Options.md](Tab2-Options.md)), which introduced `systemPrompt` as one option among many.
Here it is the only thing that changes: one user prompt is run through six system-prompt setups **in parallel**,
and the answers and prompt token counts are compared side by side.

| Concept | Topic | Route |
|---|---|---|
| 9 | System prompts: string, blocks, preset, append, CLAUDE.md | `/api/c9/query`, `/api/c9/claude-md` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/09-system-prompts.ts` | **New**: checks the body with zod, builds the options for each variant and runs `query()` |
| `claude-md-project/CLAUDE.md` | **New**: the project memory loaded by the CLAUDE.md variant |
| `server/index.ts` | Mounts the router on `/api/c9` |
| `src/concepts/Concept09SystemPrompts.tsx` | **New**: the comparison tab |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | `table.compare` for the results table |
| `Tab9-System-prompts.md` | This explanation |

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`). In
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (simplified: comments removed and lines joined):

```ts
systemPrompt?: string | string[]
  | { type: 'custom'; prompt: string | string[]; snapshot?: boolean }
  | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean; snapshot?: boolean };

settingSources?: SettingSource[];   // 'user' | 'project' | 'local'
                                    // "Must include 'project' to load CLAUDE.md files."

export declare const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
```

Tab 2 used three of these shapes. The types show three more ideas worth a tab of their own:

- **`string[]` with a boundary**: splits a custom prompt into a static part, which can be cached, and a
  per-request part.
- **CLAUDE.md**: project instructions that come from a file, not from code. They only load when
  `settingSources` includes `"project"`.
- **`snapshot` / `excludeDynamicSections`**: caching controls (see "What to take away").

## Step 2: The six variants

| Variant | What is sent to `query()` | What Claude reads before your prompt |
|---|---|---|
| omitted | nothing | The SDK's minimal default prompt |
| string | `systemPrompt: "You are Pip..."` | Only your text; it **replaces** the default |
| string[] + boundary | `["static", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic"]` | Your blocks; the ones before the marker can be cached across sessions |
| preset | `{ type: "preset", preset: "claude_code" }` | Claude Code's full system prompt (tools, safety, tone...) |
| preset + append | `{ ...preset, append: "Always end with ARRR." }` | Claude Code's prompt **plus** your rules at the end |
| preset + CLAUDE.md | preset + `settingSources: ["project"]` + `cwd` | Claude Code's prompt plus the `CLAUDE.md` found in `cwd` |

## Step 3: Server route

**File:** [server/concepts/09-system-prompts.ts](server/concepts/09-system-prompts.ts)

Every variant starts from the **same base**, so the system prompt is the only difference:

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: [],
  maxTurns: 1,
  settingSources: [],
};
```

`settingSources: []` is isolation mode: no settings files, and no CLAUDE.md.

The route checks the body with zod first (see "How it was built" below). Then a `switch` in `buildOptions()`
fills in the variant. The two new ones:

```ts
case "blocks":
  // …
  options.systemPrompt = [
    "You are the support bot of Atmira Lab. Answer in at most two sentences.",
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    `The current user is ${body.userName}. Today is ${new Date().toDateString()}.`,
  ];
  break;
case "claudeMd":
  options.systemPrompt = { type: "preset", preset: "claude_code" };
  options.settingSources = ["project"];
  options.cwd = PROJECT_DIR;
  break;
```

`CLAUDE.md` lives in its own folder, `claude-md-project/`, not in `sandbox/`, because the Concept 3 reset button
recreates `sandbox/`. A small `GET /claude-md` route returns the file so the tab can show it.

As in Concept 2, `send("options", options)` echoes the exact options before the run starts.

## Step 4: Browser flow

**File:** [src/concepts/Concept09SystemPrompts.tsx](src/concepts/Concept09SystemPrompts.tsx)

1. Choose the variants to run with the checkboxes, and edit the custom prompt, the append text or the user name.
2. **Run N variant(s) in parallel** calls `streamPost("/api/c9/query", ...)` once per variant, **without** `await`
   between them. Each run keeps its own state in a `Record<variantId, Run>`.
3. A row of the comparison table appears as soon as its run starts. Its answer fills in as the messages arrive, and
   the **prompt tokens** and the cost appear with its `result`.
4. Every variant has a collapsible card with its `options` JSON and raw `MessageLog`.

"Prompt tokens" adds the three input counters from `result.usage`, because with prompt caching the prompt is
split between them:

```ts
const promptTokens = u && u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
```

## Step 5: Test the endpoint

With the server running, all six variants were called in parallel with the default prompt,
*"Who are you, who am I, and which rules do you follow? Two sentences max."*

| Variant | Prompt tokens (fresh + cache write + cache read) | Cost | Answer (short) |
|---|---|---|---|
| omitted | 598 + 0 + 0 | $0.0025 | "I'm Claude, an AI assistant built on Anthropic's Claude Agent SDK..." |
| string | 628 + 0 + 0 | $0.0028 | "Squawk! I be Pip, yer pirate parrot..." |
| string[] | 632 + 0 + 0 | $0.0034 | "I'm Claude, Atmira Lab's support bot... and you're Luis." |
| preset | 10 + 6,653 + 0 | $0.0153 | "I'm Claude... I help you with software engineering tasks..." |
| preset + append | 10 + 6,665 + 0 | $0.0166 | "I'm Claude Code, Anthropic's CLI assistant... ARRR" |
| preset + CLAUDE.md | 10 + 6,819 + 0 | $0.0170 | "Soy Claude, un asistente... del proyecto Atmira Lab... — Atmira Lab bot" |

Then the preset variants were run **a second time**:

| Variant | Prompt tokens | Cost |
|---|---|---|
| preset | 10 + 570 + **6,078** | **$0.0036** (was $0.0153) |
| preset + CLAUDE.md | 10 + 739 + **6,084** | cheaper for the same reason |
| string[] | 633 + 0 + 0 | unchanged |

## What to take away

1. **The preset is roughly ten times bigger.** Claude Code's prompt is about 6,600 tokens against about 600 for a
   short custom prompt. That is the price of getting Claude Code's behaviour (tools, safety rules, tone).
2. **Caching makes the big prompt cheap after the first run.** On the second preset run, about 6,000 tokens came
   from `cache_read_input_tokens` and the cost fell by around 75%. The short custom prompts are never cached,
   because they are below the model's minimum cacheable length. The boundary in `string[]` only pays off once the
   static part is large.
3. **`string` replaces, `append` adds.** With a string, Claude doesn't know it is Claude Code. With `append`, it
   keeps the full Claude Code prompt and also follows your rule (the answer ends with ARRR).
4. **CLAUDE.md is configuration, not code.** The only code change is `settingSources: ["project"]` plus a `cwd`.
   The rules (Spanish, the signature) come from the file. With `settingSources: []`, which every other tab uses,
   CLAUDE.md is ignored, even in the same folder.
5. **Some context is added whatever `systemPrompt` you choose.** Even the *omitted* and *string* variants knew
   the logged-in user's email. Claude Code injects that context separately from the system prompt, so
   `systemPrompt` is not the only input that shapes the answer.
6. **Two options this tab doesn't exercise:**
   - `excludeDynamicSections: true` (preset only) moves the working directory and git status out of the system
     prompt into the first user message, so the prompt is identical for every user and the cache hits across users.
   - `snapshot` (default `true`) records the system prompt the first time and reuses it on every later request and
     `resume`, so a changed `append` on a resumed session (Concept 6) is ignored until a new session starts.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/09-system-prompts.ts](server/concepts/09-system-prompts.ts) and
[src/concepts/Concept09SystemPrompts.tsx](src/concepts/Concept09SystemPrompts.tsx). The types are in Step 1 above,
and the six variants in Step 2 above.

### Step 1: One import that is a value, not a type

```ts
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type Options } from "@anthropic-ai/claude-agent-sdk";
```

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is a real constant exported by the SDK (`declare const` in `sdk.d.ts`). Import it
instead of typing the string `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` yourself, so a future SDK version can change
it.

### Step 2: The folder and the body

```ts
// A folder of its own (not sandbox/, which Concept 3 resets) with a CLAUDE.md in it.
const PROJECT_DIR = path.resolve("claude-md-project");

// The tab always sends every field; customPrompt and appendText may be empty.
const Body = z
  .object({
    prompt: z.string().max(4000).refine((s) => s.trim() !== "", { message: "must not be empty" }),
    variant: z.enum(["omitted", "custom", "blocks", "preset", "append", "claudeMd"]),
    customPrompt: z.string().max(4000),
    appendText: z.string().max(4000),
    userName: z.string().max(100),
  })
  .strict();
type Body = z.infer<typeof Body>;
```

- `path.resolve()` works from the folder where the server was started, so `npm run dev` must run from the project
  root.
- The body always carries **all** the texts. Each variant uses only the field it needs: `customPrompt` for
  `custom`, `appendText` for `append`, `userName` for `blocks`.
- One request runs **one** variant. Running six at once is the browser's job (Step 5).
- `variant` is a zod enum, so an unknown variant is refused. `type Body` comes from the schema with `z.infer`, so
  `buildOptions()` gets the same type as before.

### Step 3: `buildOptions()`, one function for all variants

```ts
function buildOptions(body: Body): Options {
  // Same base for every variant, so the system prompt is the only difference.
  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    tools: [],
    maxTurns: 1,
    settingSources: [],
  };

  switch (body.variant) {
    case "omitted":
      break;
    case "custom":
      options.systemPrompt = body.customPrompt;
      break;
    // … blocks and preset
    case "append":
      options.systemPrompt = { type: "preset", preset: "claude_code", append: body.appendText };
      break;
    // … claudeMd
  }
  return options;
}
```

- The options are built in a separate function, not inline in the route. That keeps the route short,
  and the six cases are easy to read side by side.
- `omitted` really sends nothing: the `case` is empty, so `systemPrompt` stays `undefined`.
- `tools: []` and `maxTurns: 1` keep each run to one short answer, so the token counts only measure the system
  prompt and the user prompt.

### Step 4: The two routes

```ts
concept09.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;
  const options = buildOptions(body);

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});

// Lets the tab show the CLAUDE.md that the "claudeMd" variant loads.
concept09.get("/claude-md", async (_req, res) => {
  res.type("text/plain").send(await readFile(path.join(PROJECT_DIR, "CLAUDE.md"), "utf8").catch(() => "(missing)"));
});
```

- A bad body (for example `"variant": "evil"`, a missing field or an extra key) gets one `error` event with a
  `Bad request: …` message, then `done`. The SDK is never called. `badRequest()` is the same helper as in
  Concept 34.
- `/claude-md` reads the file on every call. It answers `(missing)` instead of an error when the file is gone.

Then mount the router in [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept09 } from "./concepts/09-system-prompts.js";
// …
app.use("/api/c9", concept09);
```

### Step 5: The React tab: one stream per variant

The tab keeps one `Run` per variant in a single state object:

```tsx
type Run = { options?: any; messages: any[]; error?: string; running: boolean };
// …
function update(id: VariantId, change: (run: Run) => Run) {
  setRuns((prev) => ({ ...prev, [id]: change(prev[id] ?? { messages: [], running: false }) }));
}

async function runOne(variant: VariantId) {
  update(variant, () => ({ messages: [], running: true }));
  try {
    await streamPost("/api/c9/query", { prompt, variant, customPrompt, appendText, userName }, (event, data) => {
      if (event === "options") update(variant, (r) => ({ ...r, options: data }));
      if (event === "message") update(variant, (r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "error") update(variant, (r) => ({ ...r, error: data.message }));
    });
  } finally {
    update(variant, (r) => ({ ...r, running: false }));
  }
}

function runAll() {
  setRuns({});
  // Same user prompt, one query() per variant, all at once.
  selected.forEach(runOne);
}
```

- `update()` always uses the **function** form of `setRuns`. Six streams write at the same time, so each change
  must start from the latest state, or one stream would erase another.
- `selected.forEach(runOne)` starts every stream without `await`, so they run in parallel.
- `running` for the whole tab is `Object.values(runs).some((r) => r?.running)`: the inputs stay disabled until the
  last stream ends.

The comparison table and the collapsible cards are computed from `runs` on every render. A row appears as soon as
its run starts (with `…`), and its answer and token count fill in when the messages arrive. On first load, a
`useEffect` fetches `/api/c9/claude-md` for the CLAUDE.md card.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 9, title: "System prompts", Component: Concept09SystemPrompts },
```

### Step 6: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 9 and click **Run 6 variant(s) in parallel**. Six rows appear and fill in one by one.
   The preset rows show about ten times more prompt tokens.
3. Click it again: the preset rows now show a "from cache" line.
4. One variant from a terminal: see "Running the app" below. With `"variant":"evil"` in that body, the answer is
   one `error` event: `Bad request: variant: Invalid option: …`.

## Things to try in Concept 9

1. Run all six, then run them again. Watch the **from cache** line appear under the preset rows.
2. Edit [claude-md-project/CLAUDE.md](claude-md-project/CLAUDE.md), for example "Always answer in French", and
   run only *preset + CLAUDE.md*. No restart is needed; the file is read on every run.
3. Change the user name and compare the *string[]* answer. Only the part after the boundary changed.
4. Put the same pirate text into both the *string* and the *append* fields and compare. Which one still knows it is
   Claude Code?
5. Ask a coding question such as "How do I read a file in Node?". The preset variants answer like a coding agent;
   *omitted* and *string* answer like a plain chat model.

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**9. System prompts**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

To call the endpoint without the UI:

```powershell
'{"prompt":"Who are you?","variant":"claudeMd","customPrompt":"","appendText":"","userName":"Luis"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c9/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

`variant` is one of `omitted`, `custom`, `blocks`, `preset`, `append`, `claudeMd`.
