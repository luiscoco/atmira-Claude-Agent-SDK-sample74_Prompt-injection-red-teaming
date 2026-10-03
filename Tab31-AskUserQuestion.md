# AskUserQuestion

This file explains Concept 31 (**AskUserQuestion**) of the Claude Agent SDK Lab. When a job leaves a choice open, the
agent can stop in the middle of a run and **ask you** 1 to 4 multiple-choice questions with the built-in
`AskUserQuestion` tool. In the terminal, Claude Code shows them as a dialog. With the SDK, **nothing is shown**: the
questions reach **your** `canUseTool`, and your code must render them, wait for the person, and send the answers back.

**Goal:** build that dialog in your own UI. Know which answers you can send, what the model gets for each one, when the
tool is not there at all, and how the host (a hook, your code) can answer without a person.

| Concept | Topic | Routes |
|---|---|---|
| 31 | AskUserQuestion: the questions (`header`, `options`, `multiSelect`, `preview`), answering from `canUseTool` (`updatedInput.answers`, `annotations`), skip (`deny`) and cancel (`interrupt: true`), a host-side timeout, `toolConfig.askUserQuestion.previewFormat`, answering from a `PreToolUse` hook, a partial answer, when the tool is removed (no `canUseTool`, `permissionPrompts: 'none'`), `bypassPermissions` | `/api/c31/tools` (SSE), `/run` (SSE), `/answer`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/31-ask-user-question.ts` | **New**: the options, `ask()` (the pending question), `/answer` and its checks, the hook, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c31` |
| `src/concepts/Concept31AskUserQuestion.tsx` | **New**: the tab (Parts A to D), the question card, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The question card, option previews, AskUserQuestion rows |
| `.gitignore` | Ignores `ask-lab/` |
| `Tab1-query().md` | Adds Concept 31 to the table |

---

## Step 1: What the model sends

`AskUserQuestion` is a normal built-in tool. Its input (`AskUserQuestionInput` in `sdk-tools.d.ts`):

```ts
{
  questions: [                          // 1 to 4
    {
      question: "Which poetic form would you prefer?",
      header: "Form",                   // a short chip, max 12 characters
      multiSelect: false,
      options: [                        // 2 to 4
        { label: "Haiku", description: "A three-line poem, 5-7-5" },
        { label: "Limerick", description: "Five humorous lines, AABBA", preview: "…" }, // preview is optional
      ],
    },
  ],
}
```

The tool description tells the model **not** to add an "Other" option: the UI adds one. So the lab's card adds
**Other** (a free text field) to every question.

## Step 2: The host answers from `canUseTool`

Claude Code sends the call to the host as a **permission request**. Your `canUseTool` is the dialog.
Simplified from `baseOptions()` and `ask()` in [server/concepts/31-ask-user-question.ts](server/concepts/31-ask-user-question.ts):

```ts
canUseTool: async (tool, input, { signal }) => {
  if (tool === "AskUserQuestion") {
    const answers = await showQuestionsAndWait(input.questions, signal);   // your UI
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  // … other tools
}
```

`answers` maps the **question text** to the answer: `{ "Which poetic form would you prefer?": "Limerick" }`. The
model gets this tool_result:

```
Your questions have been answered: "Which topic…?"="Love", "Which poetic form…?"="Limerick".
You can now continue with these answers in mind.
```

and your code gets `tool_use_result: { questions, answers }` on the `user` message, which is handy to store.

**The run simply waits.** `canUseTool` is an `async` function, so the lab keeps a pending promise per question
(`ask()` in the `ask` region), sends the questions to the browser as an SSE event, and resolves the promise when the
browser POSTs `/api/c31/answer`. Claude Code sets **no time limit**: in a probe, `canUseTool` waited 150 s and the run
went on normally. So the lab adds its **own** limit of 2 minutes (a `deny`, see Step 3). It also answers `deny` when the
run's `signal` is aborted, for example when the browser closes the stream.

## Step 3: Every kind of answer, and what the model gets

| You | `canUseTool` returns | The model's tool_result |
|---|---|---|
| Pick an option | `allow`, `answers: { q: "Limerick" }` | "Your questions have been answered: …" |
| Several options (`multiSelect`) | `allow`, `answers: { q: "Pepperoni, Mushrooms" }` | The same: several labels are **one string**, joined with `", "` |
| Your own text (Other) | `allow`, `answers: { q: "about my cat Miso" }` | "The user answered: … **Read the answers carefully — they may request clarification, changes, or that you not proceed** — and follow what they actually say." |
| A note | `allow`, `annotations: { q: { notes: "make it funny" } }` | The "The user answered" text, with `notes: make it funny` after the answer |
| Skip | `deny`, `message` | `is_error: true` with your message. The model goes on, and `result.permission_denials` lists the call |
| Cancel | `deny`, `message`, `interrupt: true` | "The user doesn't want to proceed… STOP what you are doing…". The result is `error_during_execution`, and **`query()` throws** afterwards, so catch it |
| Nobody answers | (Claude Code waits forever) | The lab's timeout sends `deny` "Choose sensible defaults yourself and say which ones you chose" |

Two details from the probes:

- **The wording changes** as soon as an answer is not exactly an option label (even `"green"` for the label
  `"Green"`) or has a note. Then the model is told to read the answers carefully, and it often asks back in plain text
  instead of doing the work. With "about my cat Miso" as the answer to both questions, Haiku replied that it needed a
  form before it could go on.
- **Write the `deny` message as an instruction.** "Choose sensible defaults yourself and say which ones you chose"
  made the model write "Since you skipped the questions, I'll choose… Topic: Nature, Form: Haiku".

## Step 4: When the model does NOT get the tool

The tool is only offered when there is a host that can answer. Button **0** runs 6 setups ("Reply ok"), with
`tools: ["Read", "AskUserQuestion"]`, and reads `system/init`:

| Setup | `AskUserQuestion` in `system/init` |
|---|---|
| `canUseTool` set | yes |
| no `canUseTool` | **no** |
| `canUseTool` + `permissionPrompts: 'none'` | **no** |
| a `PreToolUse` hook, no `canUseTool` | **no** (a hook alone does not bring it back) |
| `canUseTool` + `bypassPermissions` | yes, but the SDK warns: *canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call* |
| `canUseTool`, default tool set (no `tools` option) | yes (34 tools) |

Without the tool, the model asks **in plain text** ("I don't have access to an AskUserQuestion tool. However, I can
ask you directly here: 1. Nature 2. Technology…") and the run ends. With `bypassPermissions`, your dialog never sees
the question. Don't use that mode if you want the agent to ask.

In the default tool set, `AskUserQuestion` is **not deferred** (unlike the todo tools of Concept 30): the model called
it directly, with no `ToolSearch` first.

## Step 5: The model rarely asks on its own

Button **4** sends "Write a poem to poem.txt." The topic and the form are open, but the model just picks one. In the
probes, neither Haiku 4.5 nor Sonnet 5 asked, even with a system prompt append that said "When a request leaves a real
choice open, ask the user with AskUserQuestion". Sonnet 5 even wrote "The topic is open, so let me pick something".
**If you want questions, ask for them in the prompt**, as the other scenarios do ("Before you write anything, use the
AskUserQuestion tool ONCE with two questions…").

## Step 6: Previews, and `toolConfig`

An option can carry a `preview`: a mockup, a code snippet, a layout. What the model puts there is set by an option:

```ts
toolConfig: { askUserQuestion: { previewFormat: "html" } }   // default: "markdown"
```

- `"markdown"` (the CLI's default): Markdown or ASCII. In the probe, a README layout question had previews like
  `# Project Title\n\n## Features\n- …`. The card shows them in a `<pre>`.
- `"html"`: self-contained HTML fragments, meant for web hosts. Scenario 3 got
  `<h1 style="font-family: … font-weight: 300; …">Welcome</h1>` for each style. **This HTML is written by the model**,
  so the card renders it in `<iframe sandbox="" srcdoc=…>`: `sandbox=""` blocks scripts and gives the fragment its own origin, so
  it cannot reach the page. In the browser test, the page could not read into the preview's iframe either.

The card shows the preview of the option you hover or pick, next to the options.

## Step 7: The host can answer too

An answer does not have to come from a person.

**A `PreToolUse` hook** (scenario 5) can answer before `canUseTool` is asked. Then `canUseTool` is **not called** for
that call. Simplified from `answerFromProfile()` in
[server/concepts/31-ask-user-question.ts](server/concepts/31-ask-user-question.ts):

```ts
hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [async (input) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...input.tool_input, answers: pickFromSavedPreferences(input.tool_input.questions) },
  },
})] }] }
```

That fits tests, bots, or a "remember my choice" feature. The model gets the same "Your questions have been answered"
text. But a hook is not a replacement for `canUseTool`: without `canUseTool` the tool is not offered at all (Step 4).

**A partial answer is dangerous** (scenario 6). The host answers only the first of two questions. That is **not** an
error: the tool_result lists one answer and says "You can now continue". In the probe and in the route test, Haiku
**made up** the second answer (for example "Favorite Fruit: Pear"; the made-up fruit varies between runs), wrote it to `favorites.txt`, and said "I've asked you two
questions and got your answers". So the lab's `/answer` route refuses any answer that misses a question, or names a
question that was not asked (HTTP 400), and the card's **Submit** stays disabled until every question has an answer.

## Step 8: The host check

After each run, the lab lists every question and the answer the host sent: `2/2 questions answered`, or, in red,
"no answer (host): anything the model says about it is made up". This is the same idea as Concept 30's check: trust
what your code saw, not what the model says.

## Step 9: Part D, the summary

| You want | Do |
|---|---|
| The agent to ask the user | Put `AskUserQuestion` in `tools`, set `canUseTool`, and **ask for questions in the prompt** |
| A UI for the questions | Render `questions` in `canUseTool`, wait, return `updatedInput.answers` (question text → label) |
| Several picks | Join the labels with `", "` |
| Free text or a note | Put the text in `answers`, or use `annotations[q].notes`, and expect the model to read it carefully (and maybe ask back) |
| Let the user decline | `deny` with an instruction ("choose defaults and say which") |
| Let the user stop everything | `deny` + `interrupt: true`, and catch the error `query()` throws |
| A time limit | Your own timer in `canUseTool`: Claude Code has none |
| Automatic answers | A `PreToolUse` hook with `updatedInput.answers` (and still a `canUseTool`) |
| Web previews | `toolConfig.askUserQuestion.previewFormat: "html"`, shown in a sandboxed iframe |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/31-ask-user-question.ts](server/concepts/31-ask-user-question.ts) and
[src/concepts/Concept31AskUserQuestion.tsx](src/concepts/Concept31AskUserQuestion.tsx). The tab's **code** buttons show
the same regions (`options`, `ask`, `answer`, `hook`, `messages`, `check`).

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `CanUseTool` (its `signal`), `PermissionResult`
(`updatedInput`, `message`, `interrupt`), `toolConfig` and `ToolConfig` (`askUserQuestion.previewFormat`) and
`permissionPrompts`. The input of the tool is `AskUserQuestionInput` in `sdk-tools.d.ts` (Step 1 above). The types
say what an answer looks like, but not **when** the tool is offered. That is why button 0 (`POST /tools`) was built
first: it reads `system/init` in six setups (Step 4 above).

### Step 2: The folders and the host's time limit

```ts
const LAB = path.resolve("ask-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [RUNS, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
// …
const ANSWER_TIMEOUT_MS = 120_000; // the host's own limit: Claude Code waits for canUseTool forever
```

- Each run works in its own empty folder, `ask-lab/runs/<run id>`. `newRun()` creates it and deletes the folders of
  finished runs (the ids in the `active` set are kept).
- `CONFIG_DIR` is a fake `CLAUDE_CONFIG_DIR`, so the lab's transcripts never mix with yours.
- The `Run` object keeps who answers (`"you"`, `"hook"` or `"host (partial)"`), a counter of questions, and a `log` of
  every question and answer, for the host check.

### Step 3: The options: `canUseTool` is the dialog

```ts
function baseOptions(run: Run, emit: Emit, extra: Partial<Options> = {}): Options {
  // …
  return {
    model: MODEL,
    cwd: run.work,
    tools: [...FILE_TOOLS, "AskUserQuestion"], // it must be in the list, like any tool
    // canUseTool is the host's "dialog". Without it, the model does not get AskUserQuestion at all.
    canUseTool: async (tool, input, { signal }) => {
      if (tool === "AskUserQuestion") return ask(run, emit, input, signal);
      const inside = path.resolve(run.work, String(input.file_path ?? ".")).startsWith(run.work);
      if (FILE_TOOLS.includes(tool) && inside) return { behavior: "allow", updatedInput: input };
      emit("denied", { tool });
      return { behavior: "deny", message: "Denied by the lab: only Read and Write inside the run folder." };
    },
    // The hook scenario: a PreToolUse hook answers instead of the person. Then canUseTool is not called.
    hooks: run.answeredBy === "hook" ? { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [answerFromProfile(run, emit)] }] } : undefined,
    // … settingSources: [], persistSession: false, thinking disabled, maxTurns, env
    ...extra,
  };
}
```

- One `canUseTool` does two jobs: it sends `AskUserQuestion` to `ask()`, and it is a small permission guard for the
  other tools (only Read and Write, only inside the run folder).
- `extra` lets each route add its own options (the `abortController`, `toolConfig`) without a second options builder.

### Step 4: Hold the question: `ask()`

This is the core of the lab. `canUseTool` must return a `PermissionResult`, but the answer comes later, from another
HTTP request. So `ask()` returns a promise, and stores its `resolve` in a map:

```ts
type Pending = { run: Run; questions: Question[]; input: Record<string, unknown>; done: (r: PermissionResult, how: string) => void };
const pending = new Map<string, Pending>(); // "<run id>:<question id>" → the open question

function ask(run: Run, emit: Emit, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
  const questions = input.questions as Question[];
  const id = String(++run.asked);
  emit("question", { run: run.id, id, questions, answeredBy: run.answeredBy === "you" ? undefined : run.answeredBy, timeoutMs: ANSWER_TIMEOUT_MS });
  // … the "host (partial)" scenario answers the first question at once and returns
  return new Promise((resolve) => {
    const key = `${run.id}:${id}`;
    const done = (result: PermissionResult, how: string) => {
      if (!pending.delete(key)) return; // already answered
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // … record the answers for the host check, emit an "answer" event
      resolve(result);
    };
    const onAbort = () => done({ behavior: "deny", message: "The run was aborted." }, "aborted");
    // Nobody answered in time: tell the model to go on with defaults, and to SAY which ones it chose.
    const timer = setTimeout(
      () => done({ behavior: "deny", message: "The user did not answer within 2 minutes. Choose sensible defaults yourself and say which ones you chose." }, "timeout"),
      ANSWER_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, { run, questions, input, done });
  });
}
```

- The `question` SSE event carries `run` and `id`. The browser sends both back, so the server can find the right
  promise.
- There are three ways out: the browser's `POST /answer`, the 2-minute timer, or the run's `signal`. All three call
  the same `done()`.
- `if (!pending.delete(key)) return` makes `done()` run only once. A late answer after the timeout does nothing.

### Step 5: Release it: `POST /answer`

The body is checked with zod, and then turned into a `PermissionResult`:

```ts
const AnswerBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["answer", "skip", "cancel"]),
    answers: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
    notes: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
  })
  .strict();
```

```ts
function toResult(p: Pending, body: z.infer<typeof AnswerBody>): PermissionResult | string {
  if (body.action === "skip") return { behavior: "deny", message: "The user skipped these questions. Choose sensible defaults yourself and say which ones you chose." };
  if (body.action === "cancel") return { behavior: "deny", message: "The user cancelled the job.", interrupt: true };
  // Every question needs an answer: a missing one is NOT an error for the model, it just makes one up (Part B, 6).
  const texts = p.questions.map((q) => q.question);
  const answers = body.answers ?? {};
  const missing = texts.filter((t) => !answers[t]);
  if (missing.length) return `No answer for: ${missing.join(" | ")}`;
  // … the same for a key that is not a question of this call
  const annotations = body.notes && Object.fromEntries(Object.entries(body.notes).map(([q, notes]) => [q, { notes }]));
  return { behavior: "allow", updatedInput: { ...p.input, answers, ...(annotations && { annotations }) } };
}

concept31.post("/answer", (req, res) => {
  // … 400 when the body is not valid
  const p = pending.get(`${parsed.data.run}:${parsed.data.id}`);
  if (!p) return res.status(404).json({ error: "No open question with that id (already answered, timed out, or the run ended)." });
  const result = toResult(p, parsed.data);
  if (typeof result === "string") return res.status(400).json({ error: result });
  p.done(result, parsed.data.action === "answer" ? "you" : parsed.data.action);
  res.json({ ok: true });
});
```

- `toResult()` returns a **string** for a bad answer. The route sends it as a 400, and the question stays open.
- `{ ...p.input, answers }` keeps the original `questions` in `updatedInput`, and adds the answers next to them.
- A notes field becomes `annotations[question].notes`, the shape the tool expects (Step 3 above).
- `POST /answer` is a normal JSON route, not SSE. The run's SSE stream is still open on the other request.

### Step 6: The hook, the relay, the host check

For scenario 5, `answerFromProfile()` returns a `PreToolUse` hook that answers from a small list of "saved
preferences" (`PROFILE`):

```ts
const pick = (q: Question) => q.options.find((o) => PROFILE.some((w) => o.label.toLowerCase().includes(w)))?.label ?? q.options[0].label;
const answers = Object.fromEntries(questions.map((q) => [q.question, pick(q)]));
// …
return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...tool_input, answers } } };
```

- The hook emits the same `question` and `answer` events, with `answeredBy: "hook"`, so the timeline looks the same
  but no card opens.
- `relay()` turns each SDK message into a small event. For an `AskUserQuestion` tool_result, it also sends
  `tool_use_result.answers` and `annotations`.
- `runOnce()` catches the error `query()` throws after `interrupt: true` (Cancel), and sends it as an `error` event.
- `check()` sends the `log` of every question, with `unanswered` counted from the answers that are `null`.

### Step 7: The routes `/run` and `/tools`

`POST /run` checks the body, picks who answers from the scenario, and streams the run as SSE:

```ts
const RunBody = z
  .object({
    scenario: Scenario,
    prompt: z.string().trim().min(1).max(2000).optional(), // custom only
    previewFormat: z.enum(["markdown", "html"]).optional(), // custom only
  })
  .strict()
  .refine((b) => (b.scenario === "custom") === (b.prompt !== undefined), { message: "prompt is required for 'custom', and only for it" })
  .refine((b) => b.scenario === "custom" || b.previewFormat === undefined, { message: "previewFormat is only for 'custom'" });
```

```ts
    const format = b.scenario === "preview" ? "html" : b.previewFormat;
    const options = baseOptions(run, emit, { abortController: abort, ...(format && { toolConfig: { askUserQuestion: { previewFormat: format } } }) });
    emit("opened", { prompt, options: optionsForBrowser(run, options) });
    await runOnce(prompt, options, run, emit);
    check(run, emit);
  } finally {
    active.delete(run.id);
    for (const p of pending.values()) if (p.run === run) p.done({ behavior: "deny", message: "The run ended." }, "aborted");
    end();
  }
```

- The browser sends only a scenario name. The prompts live on the server (`PROMPTS`), except for the custom job.
- The `finally` block closes every question of this run that is still open, so no promise is left waiting.
- `optionsForBrowser()` replaces functions and paths with short labels before the options are shown in the tab.
- `POST /tools` runs the six `SETUPS` in parallel with "Reply with the single word: ok" and `maxTurns: 1`, and sends
  one `toolsRow` event per setup. `GET /code` returns the `#region` blocks of the file.

### Step 8: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept31 } from "./concepts/31-ask-user-question.js";
// …
app.use("/api/c31", concept31); // POST /answer releases a question that canUseTool is waiting on
```

### Step 9: The React tab

`run()` streams the events of `POST /run`. A `question` event opens the card, and the matching `answer` event
closes it:

```tsx
await streamPost("/api/c31/run", body, (event, data) => {
  if (event === "done") return;
  if (event === "opened") {
    fmt = data.options.toolConfig?.askUserQuestion?.previewFormat ?? "markdown";
    return setOptions(data);
  }
  if (event === "question" && !data.answeredBy) setOpen({ ...data, receivedAt: Date.now(), format: fmt });
  if (event === "answer") setOpen((o) => (o && o.id === data.id ? null : o));
  got.push({ event, data });
  setEvents([...got]);
});
```

`QuestionCard` is the dialog. It builds the answers and POSTs them on a separate request:

```tsx
const answerOf = (q: Question) => {
  const p = picked[q.question] ?? [];
  return p.includes(OTHER) ? (other[q.question] ?? "").trim() : p.join(", ");
};
const complete = open.questions.every((q) => answerOf(q));
// …
const r = await fetch("/api/c31/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
```

- A question from a hook (`answeredBy` is set) only adds a row to the timeline. No card opens.
- `p.join(", ")` is the multi-select format. **Other** is added by the card, not by the model.
- **Submit** stays disabled until `complete` is true. The server checks it again (Step 5 of this section).
- The card does not close itself after the POST: it waits for the `answer` event on the stream. The countdown uses
  `receivedAt + timeoutMs`.
- An HTML preview goes into `<iframe className="ask-preview" sandbox="" srcDoc={html} title="option preview" />`
  (Step 6 above).

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 31, title: "AskUserQuestion", Component: Concept31AskUserQuestion },
```

### Step 10: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 31, press **0**: the table shows the red "no" rows.
3. Press **1**, answer the card, and find the `PermissionResult` row, the tool_result and "2/2 questions answered" in
   the host check.
4. Press **6**: the host check shows one red row, a question with no answer.

## How to try it

1. `npm run dev`, then open the **31. AskUserQuestion** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Which setups get AskUserQuestion?** and look at the red "no" rows.
3. Press **1 · Ask me, then write**. When the card appears, answer it and watch the `PermissionResult` row and the
   tool_result. Run it again and try **Skip**, **Cancel the job**, **Other** with your own text, and a note.
4. Press **2 · Multi-select**: pick two toppings and find `"A, B"` in `answers`.
5. Press **3 · Options with HTML previews** and hover over the options.
6. Press **4 · Not asked to ask**: no card, the model just writes.
7. Press **5 · A hook answers** (no card, `canUseTool` is not called) and **6 · A partial answer** (find the red row in
   the host check, and the made-up answer in the file).
8. Write your own job in the form, with either preview format.

Each scenario costs about $0.03 or less (Haiku 4.5). A run with a question waits for you for up to 2 minutes.
