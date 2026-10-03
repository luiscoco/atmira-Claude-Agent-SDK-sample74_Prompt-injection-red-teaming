# Concept 2: Options, step by step

This file explains how Concept 2 (**Options**) was added to the Claude Agent SDK Lab, in the order the work was done.
It builds on Concept 1 (`query()` and the message stream), described in [Tab1-query().md](<Tab1-query().md>).

**Goal:** show how the second argument of `query({ prompt, options })` controls a run:

| Option | Question it answers |
|---|---|
| `model` | Which Claude model runs the agent? |
| `systemPrompt` | How should the agent behave? |
| `maxTurns` | When must it stop (number of turns)? |
| `maxBudgetUsd` | When must it stop (cost)? |
| `includePartialMessages` | How much of the stream do I see? |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/02-options.ts` | **New**: the Concept 2 route |
| `server/index.ts` | Mount the new router on `/api/c2` |
| `src/concepts/Concept02Options.tsx` | **New**: the Concept 2 tab |
| `src/App.tsx` | Add the tab to the navigation |
| `src/styles.css` | Form grid, checkbox, warning card, blinking cursor |
| `README.md` (now `Tab1-query().md`) | Status table, project structure, Step 6 section |

---

## Step 1: Read the existing code

Before writing anything, I read every file of Concept 1 to copy its patterns exactly:

- **`server/concepts/01-query.ts`**: one Express `Router` per concept, calling `query()` and passing the result to `pipe()`.
- **`server/sse.ts`**: `openSse(req, res)` returns `{ abort, send, pipe }`.
  `send(event, data)` writes any named SSE event, which Concept 2 needs to send the options back.
- **`src/concepts/Concept01Query.tsx`**: collects every message in state and derives the cards from it.
- **`src/App.tsx`**: the `concepts` array. A new concept is one more entry in it.

So Concept 2 needs one new server file, one new React file, and one line in each of `index.ts` and `App.tsx`.

## Step 2: Install the dependencies

`sample2` had no `node_modules` folder, so the SDK's type definitions weren't available yet:

```powershell
npm install
npm install-scripts approve esbuild   # printed "Nothing to approve" (already approved in package.json)
npm rebuild esbuild
```

## Step 3: Read the options in the SDK's type definitions

As in Concept 1, the code was written against the **installed** version (`0.3.281`), not from memory.
I searched `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for each option:

```bash
grep -nE "^\s+(model|systemPrompt|maxTurns|maxBudgetUsd|includePartialMessages)\??:" sdk.d.ts
```

What the types say:

```ts
model?: string;                      // "Defaults to the CLI default model"
maxTurns?: number;
maxBudgetUsd?: number;               // "returning an `error_max_budget_usd` result"
includePartialMessages?: boolean;    // "SDKPartialAssistantMessage events will be emitted"

systemPrompt?: string | string[]
  | { type: 'custom'; prompt: string | string[]; snapshot?: boolean }
  | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean; snapshot?: boolean };
```

Two related types were needed to build the UI:

```ts
// The message emitted when includePartialMessages is true
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent;   // message_start, content_block_delta, message_stop, ...
  ...
};

// The result message when a limit stops the run
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | ...;
  ...
};
```

## Step 4: Write the server route

**File:** [server/concepts/02-options.ts](server/concepts/02-options.ts)

Two design decisions:

1. **Only set the options the user chose.** An empty field is left out of the object, so it really means
   "SDK default". This matters most for `systemPrompt`, where "omitted", "a string" and "the preset" behave very differently.
2. **Send the options back before running.** `send("options", options)` emits an extra SSE event,
   so the UI can show exactly what `query()` received.

```ts
const options: Options = {
  tools: [], // still no built-in tools (Concept 3)
  includePartialMessages: body.includePartialMessages,
};
if (body.model) options.model = body.model;
if (body.systemPromptMode === "custom") options.systemPrompt = body.systemPrompt ?? "";
if (body.systemPromptMode === "preset")
  options.systemPrompt = { type: "preset", preset: "claude_code", append: body.systemPrompt || undefined };
if (body.maxTurns) options.maxTurns = body.maxTurns;
if (body.maxBudgetUsd) options.maxBudgetUsd = body.maxBudgetUsd;

send("options", options);

const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
pipe(run);
```

`abortController` is added only at the call, so it isn't included in the echoed JSON.
The `Options` type is imported from the SDK, so TypeScript checks every field.

Then the router was mounted in [server/index.ts](server/index.ts):

```ts
import { concept02 } from "./concepts/02-options.js";
app.use("/api/c2", concept02);
```

## Step 5: Write the React tab

**File:** [src/concepts/Concept02Options.tsx](src/concepts/Concept02Options.tsx)

**The form.** It has one control per option. The defaults are chosen so the first click already shows something:
Haiku (fast and cheap), a pirate system prompt (easy to spot), and partial messages on.

**The request.** Empty number fields become `undefined`, so the server leaves them out:

```ts
maxTurns: Number(maxTurns) || undefined,
maxBudgetUsd: Number(maxBudgetUsd) || undefined,
```

**Handling the new `options` event** next to the usual ones:

```ts
await streamPost("/api/c2/query", body, (event, data) => {
  if (event === "options") setSentOptions(data);
  if (event === "message") setMessages((prev) => [...prev, data]);
  if (event === "error") setError(data.message);
});
```

**Live text from partial messages.** Each `stream_event` wraps one Messages API streaming event.
The text pieces are in `content_block_delta` events with `delta.type === "text_delta"`:

```ts
const liveText = streamEvents
  .map((m) => m.event)
  .filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta")
  .map((e) => e.delta.text)
  .join("");
```

The complete `assistant` message still arrives at the end, so the card shows `finalText || liveText`.
A blinking cursor `▌` is shown until the final text arrives.

**Cards:**

| Card | Content |
|---|---|
| options sent to query() | The echoed `options` JSON |
| system/init | The model that actually ran |
| answer | Live text, then the final text |
| stream_event count | How many partial messages arrived |
| result | Cost, tokens and turns. It turns yellow for `error_*` subtypes, with an explanation |

**Raw log.** A short answer produces over a dozen `stream_event` messages, so a checkbox hides them
from `MessageLog` by default. `MessageLog` itself didn't change.

Finally, the tab was registered in [src/App.tsx](src/App.tsx):

```ts
const concepts = [
  { id: 1, title: "query()", Component: Concept01Query },
  { id: 2, title: "Options", Component: Concept02Options },
];
```

In [src/styles.css](src/styles.css), the new rules added a responsive form grid, inline checkboxes, a `.warn` card, a colour for the `stream_event` tag and the blinking cursor.

## Step 6: Type-check

```powershell
npx tsc -p .
```

It exited with 0.

## Step 7: Test the endpoint without the UI

With the server started (`npx tsx server/index.ts`), I sent three requests with `curl` and checked the SSE output.

**Test 1: model + custom system prompt + partial messages**

```json
{ "prompt": "Say hello in 5 words.", "model": "claude-haiku-4-5-20251001",
  "systemPromptMode": "custom", "systemPrompt": "You are a pirate.",
  "maxTurns": 1, "includePartialMessages": true }
```

Result: `init.model` = `claude-haiku-4-5-20251001`, 13 `stream_event` messages, `result/success`,
*"Ahoy, ye scurvy dogs, welcome aboard!"*

**Test 2: a tiny budget**

```json
{ "prompt": "Say hello in 5 words.", "model": "claude-haiku-4-5-20251001",
  "systemPromptMode": "default", "maxBudgetUsd": 0.0001, "includePartialMessages": false }
```

Result: `result/error_max_budget_usd` with `total_cost_usd: 0.00095`... **followed by an `error` event**:

```
event: error
data: {"message":"Error: Claude Code returned an error result: Reached maximum budget ($0.0001)"}
```

**Test 3: preset + append**

```json
{ "prompt": "Who are you, in one sentence?", "model": "claude-haiku-4-5-20251001",
  "systemPromptMode": "preset", "systemPrompt": "End every answer with the word ARRR." }
```

Result: *"I'm Claude Code, Anthropic's AI assistant for software engineering tasks, … ARRR"*.
The preset makes the agent act as Claude Code, and the appended rule is still followed.

## Step 8: Fix what the test found

Test 2 showed that reaching a limit ends the run **in two ways**:

1. The SDK emits a `result` message with `subtype: "error_max_budget_usd"`.
2. Then the `for await` loop **throws**. `server/sse.ts` catches the error and sends it as an `error` event.

Concept 1 reacts to `error` with `alert()`. Here that would pop up a dialog on every budget test and hide the
more useful result card. So Concept 2 stores the error and shows it as a second yellow card, **"for await threw"**,
under the result card. Seeing both side by side is part of the lesson.

After the change, I type-checked again (exit 0) and stopped the test server.

## Step 9: Update the main README

In the main README (now [Tab1-query().md](<Tab1-query().md>)):

- Status table: Concept 2 is ✅ Done, and Concept 3 is ⏳ Next.
- Project structure: added `02-options.ts` and `Concept02Options.tsx`.
- New **Step 6: Concept 2, Options** section, plus **Things to try in Concept 2**.

---

## What to take away

1. **Omitted is not the same as empty.** With no `systemPrompt`, the SDK uses its own minimal default.
   A string replaces the system prompt. The `claude_code` preset brings in Claude Code's full (long) prompt,
   so compare `input_tokens` between the modes.
2. **A limit gives you an error result and an exception.** Read the `result` message *and* wrap the loop in `try/catch`.
3. **`maxBudgetUsd` is checked after a model call.** The first call always runs, so it's a safety net, not an exact cap.
4. **Partial messages are extra.** `stream_event` messages come *in addition to* the full `assistant` message.
5. **`maxTurns` needs tools to matter.** With `tools: []` the agent always finishes in one turn.
   `error_max_turns` will show up in Concept 3.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/02-options.ts](server/concepts/02-options.ts) and
[src/concepts/Concept02Options.tsx](src/concepts/Concept02Options.tsx). It reuses the Concept 1 skeleton
(`openSse()`, `streamPost()`, `MessageLog`) described in [Tab1-query().md](<Tab1-query().md>).

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `model?:`, `systemPrompt?:`, `maxTurns?:`,
`maxBudgetUsd?:`, `includePartialMessages`, `SDKPartialAssistantMessage` and `error_max_budget_usd`. Step 3 above
shows what they say. The `Options` type is exported, so the server can import it and let TypeScript check every field.

### Step 2: The request body

```ts
// The form the tab sends. Empty fields arrive as undefined (left out of the JSON).
const Body = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(100).optional(),
    systemPromptMode: z.enum(["default", "custom", "preset"]),
    systemPrompt: z.string().max(10000).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    includePartialMessages: z.boolean().optional(),
  })
  .strict();
```

- The browser does not send an `Options` object. It sends the **form**, and the server decides which options to set.
- `systemPromptMode` picks one of the three shapes of `systemPrompt`. The same text field is used as the custom
  prompt or as the `append` text.
- The schema is a zod object, as in Concept 1. `.strict()` refuses unknown keys, and a `maxTurns` of `0` or `-1` is
  refused with a clear message instead of reaching the SDK.

### Step 3: The route

```ts
concept02.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;

  // Only set the options the user actually chose, so "omitted" really means SDK default.
  const options: Options = {
    tools: [], // still no built-in tools (Concept 3)
    includePartialMessages: body.includePartialMessages,
  };
  // …
  // Echo the options (without the AbortController) so the UI shows exactly what query() received.
  send("options", options);
```

- A bad body gets one `error` event and `done`, and `query()` never starts. The tab shows it in the yellow
  "for await threw" card.
- This is the first route that uses `send()` from `openSse()`. The `options` event goes out **before** `query()`
  starts, so it is the first event of every valid run.
- The `if` lines that fill in the other options are in Step 4 above.

### Step 4: Mount the router

In [server/index.ts](server/index.ts), one import and one line:

```ts
import { concept02 } from "./concepts/02-options.js";
// …
app.use("/api/c2", concept02);
```

### Step 5: The React tab

The model list is a constant. The empty id means "leave `model` out":

```tsx
const models = [
  { id: "", label: "(omit: CLI default)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast, cheap)" },
```

`run()` turns the form into the body. Empty fields become `undefined`, and `JSON.stringify` drops them:

```tsx
    const body = {
      prompt,
      model: model || undefined,
      systemPromptMode,
      systemPrompt,
      maxTurns: Number(maxTurns) || undefined,
      maxBudgetUsd: Number(maxBudgetUsd) || undefined,
      includePartialMessages,
    };
```

The result card turns yellow when a limit stopped the run:

```tsx
        <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
```

- The `streamPost()` handler (Step 5 above) stores three things: the echoed options, the messages and the error.
- `text` is `finalText || liveText`: the live text from `stream_event` messages is shown only until the full
  `assistant` message arrives.
- The raw log gets `messages.filter((m) => m.type !== "stream_event")` while the "Hide stream_event" box is ticked.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
  { id: 2, title: "Options", Component: Concept02Options },
```

### Step 6: Check that it works

1. `npx tsc -p .` must print nothing.
2. `npm run dev`, open tab **2. Options** and press **Run query() with options** with the defaults (Haiku, pirate
   prompt, partial messages on). The answer appears token by token, then the result card.
3. Type `0.0001` in `maxBudgetUsd` and run again: a yellow `result/error_max_budget_usd` card, then a yellow
   "for await threw" card.
4. The same route from a terminal: see "Optional: call the Concept 2 endpoint without the UI" below.

## Running the app

These commands are for **PowerShell**, the default profile in Windows Terminal.

### 1. Go to the project folder

The path contains spaces, so keep the quotes:

```powershell
cd "C:\Curso atmira - Los seis pilares del IA Spec-Driven Development (SDD)\Claude Code SDK samples\sample35"
```

### 2. Install dependencies (first time only)

```powershell
npm install
npm install-scripts approve esbuild   # npm 11+: allow esbuild's install script
npm rebuild esbuild
```

### 3. Authenticate (first time only)

Choose one:

```powershell
# Option A: reuse your Claude Code login
claude          # log in when asked, then type /exit

# Option B: use an API key from a .env file
Copy-Item .env.example .env
notepad .env    # ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Start the app

```powershell
npm run dev
```

This runs two processes in the same terminal (see the `scripts` in `package.json`):

| Label | Script | What it runs | Port |
|---|---|---|---|
| `[server]` | `dev:server` | `node --watch --env-file-if-exists=.env --import tsx server/index.ts` (Express + Agent SDK) | 3001 |
| `[web]` | `dev:web` | `vite` (the React UI, which forwards `/api` to port 3001) | 5173 |

The server is ready when it prints `Agent SDK server on http://localhost:3001` and an `Auth: ...` line.

If you prefer each process in its own Windows Terminal tab (`Ctrl+Shift+T`), run one command per tab:

```powershell
npm run dev:server   # tab 1
npm run dev:web      # tab 2
```

### 5. Open the UI

```powershell
start http://localhost:5173
```

Select the **2. Options** tab. Saving a file reloads the app automatically:
`node --watch` restarts the server, and Vite refreshes the browser.

### 6. Optional: call the Concept 2 endpoint without the UI

With the server running, run this in another tab. Use `curl.exe` rather than `curl`, because in
Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest`. Putting the JSON in a file avoids quoting problems:

```powershell
'{"prompt":"Say hello in 5 words.","model":"claude-haiku-4-5-20251001","systemPromptMode":"custom","systemPrompt":"You are a pirate.","includePartialMessages":true}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c2/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

The first event is `event: options` (the options sent to `query()`), then the `event: message` lines, then `event: done`.
Change the JSON to try other options, for example `"maxBudgetUsd":0.0001`.

### 7. Optional: type-check the project

```powershell
npx tsc -p .
```

No output means no errors.

### 8. Stop the app

Press `Ctrl+C` in the terminal. If a port stays busy (`EADDRINUSE`), stop the process that is using it:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

For more troubleshooting (billing errors, `apiKeySource`, proxy errors), see the Troubleshooting table in
[Tab1-query().md](<Tab1-query().md>).
