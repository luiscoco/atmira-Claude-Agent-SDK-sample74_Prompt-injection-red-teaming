# Output styles

This file explains Concept 34 (**output styles**) of the Claude Agent SDK Lab. Concept 9 changed the agent with a
**system prompt**: you replace it, or append to Claude Code's own. An **output style** is a lighter tool. It changes
**how** the agent answers: its voice, the shape of each answer, whether it teaches. It does not change what the agent
can do (tools, permissions, the rest of the prompt). A style is a Markdown file that you **select by name**, so a
team can share a small set of styles, and a user can switch between them.

**Goal:** write a style file and select it from the SDK. Know where Claude Code looks for style files, what the model
really receives (a wire tap shows it), what `keep-coding-instructions` removes from the `claude_code` preset, how to
switch styles in a running session, and the silent failures a host must check for itself.

| Concept | Topic | Routes |
|---|---|---|
| 34 | Output styles: a style file (`name`, `description`, `keep-coding-instructions`, `force-for-plugin`), the `outputStyle` **setting** (there is no `outputStyle` option), the built-in styles (`default`, `Proactive`, `Concise`, `Explanatory`, `Learning`), project / user / plugin styles and `settingSources`, `system/init.output_style` and `available_output_styles`, what reaches the API (a `# Output Style` system-reminder, not the system prompt), what a style removes from the `claude_code` preset, silent failures (unknown name, wrong case, `force-for-plugin`), switching styles in one session (`applyFlagSettings`, `reloadOutputStyles`, `updateSettings('localSettings')`), a host-side check | `/api/c34/styles`, `/who` (SSE), `/compare` (SSE), `/live` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `styles-project/.claude/output-styles/*.md` | **New**: four project styles: `Pirate`, `Tutor`, `Tutor (keeps coding)`, `Code reviewer` |
| `styles-project/discount.js` | **New**: a small file with a bug, which the prompts ask about |
| `styles-user/output-styles/spanish.md` | **New**: a user style (`Spanish`), copied into the fake `CLAUDE_CONFIG_DIR` |
| `styles-plugin/` | **New**: the `acme` plugin with a forced style (`acme:House`) |
| `server/concepts/34-output-styles.ts` | **New**: the options, the wire tap, the system-prompt diff, the host check, `/who`, `/compare`, `/live` |
| `server/index.ts` | Mounts the router on `/api/c34` |
| `src/concepts/Concept34OutputStyles.tsx` | **New**: the tab (Parts A to E): the style files, the columns, one session's turns |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Style badges, columns, verdict colors, turn rows |
| `.gitignore` | Ignores `style-lab/` |
| `Tab1-query().md` | Adds Concept 34 to the table |

---

## Step 1: A style is a Markdown file

```md
---
name: Code reviewer
description: Answers as a code review with a fixed shape. keep-coding-instructions true, because it still writes code.
keep-coding-instructions: true
---
Answer as a code review, in exactly this shape and nothing else:

Verdict: one line (OK, or the most serious problem).
Issues: a numbered list; each item is "file:line: the problem. Why it matters. The fix."
Patch: the corrected code in one code block, only the lines that change.
```

| Frontmatter | Meaning |
|---|---|
| `name` | The name you select. If missing, the file name without `.md`. **Case-sensitive** |
| `description` | Shown in lists (the `/output-style` menu of the terminal) |
| `keep-coding-instructions` | `true`: keep the coding rules of the `claude_code` preset (Step 5). Default `false` |
| `force-for-plugin` | Plugin styles only: the style is applied whenever the plugin is loaded (Step 6) |

Claude Code finds style files in three places, next to its five built-in styles:

| Where | Name | Found when |
|---|---|---|
| `<cwd>/.claude/output-styles/*.md` | `name` | `settingSources` includes `'project'` |
| `CLAUDE_CONFIG_DIR/output-styles/*.md` (normally `~/.claude/`) | `name` | `settingSources` includes `'user'` |
| `<plugin>/output-styles/*.md` | `<plugin>:<name>` | the plugin is in `plugins` |
| built-in | `default`, `Proactive`, `Concise`, `Explanatory`, `Learning` | always |

The lab's files are real files you can open: `styles-project/`, `styles-user/`, `styles-plugin/`. Each run works on its
own copy of `styles-project` (`style-lab/runs/<run id>`), and the fake `CLAUDE_CONFIG_DIR` is `style-lab/config`.

## Step 2: Select a style: it is a setting

`Options` has no `outputStyle` field. `outputStyle` is a **setting**, like `permissions` or `plansDirectory`
(Concept 16), so you set it the same way. Simplified from `baseOptions()` in [server/concepts/34-output-styles.ts](server/concepts/34-output-styles.ts):

```ts
const options: Options = {
  cwd: run.work,                          // project styles: <cwd>/.claude/output-styles/
  settings: { outputStyle: "Code reviewer" }, // the "flag" layer: the highest one
  settingSources: ["user", "project"],    // without these, project and user styles are not found
  env: { ...env, CLAUDE_CONFIG_DIR },     // user styles: CLAUDE_CONFIG_DIR/output-styles/
};
```

You can also write `"outputStyle": "Code reviewer"` in `.claude/settings.json`, `.claude/settings.local.json` or the
user's `settings.json`, which is what the terminal's `/output-style` and `/config` do. `options.settings` wins over
all of them.

The session tells you what it selected. Simplified from `collect()` in [server/concepts/34-output-styles.ts](server/concepts/34-output-styles.ts):

```ts
if (m.type === "system" && m.subtype === "init") {
  m.output_style;                                              // "Code reviewer"
  (await q.initializationResult()).available_output_styles;   // ["default", "Proactive", …, "Code reviewer", …]
}
```

**Parts A1 and A2** run the same prompt ("Read discount.js. Is there a bug?") in four styles in parallel. The fix is the
same in every column (`price * percent / 100`). The answers differ. Explanatory is told to add `★ Insight` boxes and Learning to
leave a `TODO(human)` for you to write (open "what the API got" to read their texts; a one-question prompt does not always show them). Concise cuts the words, Code reviewer gives a Verdict / Issues / Patch,
Pirate says "Arr!", and Spanish answers in Spanish.

## Step 3: What the model gets

The lab sets `ANTHROPIC_BASE_URL` to a small **wire tap** (as in Concept 29). It forwards every request to the API and
keeps a copy of each main-loop request. This is what a style sends. The style text is **not** in the system prompt.
It comes in the **first user message**, as two system-reminders:

```
<system-reminder>
# Output Style: Code reviewer
Answer as a code review, in exactly this shape and nothing else: …
</system-reminder>
<system-reminder>
Code reviewer output style is active. Remember to follow the specific guidelines for this style.
</system-reminder>
```

Because of that:

- A style works with the SDK's short default system prompt, with the `claude_code` preset, and with your own string
  `systemPrompt`. (Without a preset, all four columns of A1 had the same 62-character system prompt.)
- The style is a message in the history. This matters when you switch styles later (Step 7).

## Step 4: The silent failures (button 0)

**0 · Which style really applied?** runs one short prompt in 7 setups. For each one it shows what `system/init` says
and what the API really got:

| Setup | `system/init.output_style` | The API got | Host check |
|---|---|---|---|
| no `outputStyle` | `default` | no style | default |
| `'Explanatory'` | `Explanatory` | `Explanatory` | applied |
| `'explanatory'` (lowercase) | `explanatory` | **nothing** | **ignored**: names are case-sensitive |
| `'Pirate'`, `settingSources: []` | `Pirate` | **nothing** | **ignored**: the project folder was not read |
| `'Pirate'`, `settingSources: ['user', 'project']` | `Pirate` | `Pirate` | applied |
| `.claude/settings.json` `{ outputStyle: 'Code reviewer' }` | `Code reviewer` | `Code reviewer` | applied |
| `plugins: [acme]` + `'Explanatory'` | `Explanatory` | **`acme:House`** | **replaced** by the forced plugin style |

An unknown name gives **no error and no warning**, and `system/init` still reports the name you asked for. So the
host checks it itself (`verdict()`, the `check` region):

```ts
function verdict(asked: string | undefined, init: string | undefined, available: string[], calls: Call[]) {
  const got = calls.at(-1)?.reminders.at(-1)?.name; // the latest style reminder in the conversation
  const target = init ?? asked ?? "default";
  if (!got) {
    if (target === "default") return { got: null, verdict: "default", why: "no style: the model got no style reminder" };
    const near = available.find((a) => a.toLowerCase() === target.toLowerCase());
    // … return verdict "ignored", with "did you mean …?" when only the case differs
  }
  if (got === target) return { got, verdict: "applied", why: `the API got "# Output Style: ${got}"` };
  return { got, verdict: "replaced", why: `system/init says "${target}", but the API got "# Output Style: ${got}"${got.includes(":") ? " (a plugin style with force-for-plugin wins over the setting)" : ""}` };
}
```

`calls` are the API requests the wire tap kept (Step 3), and `available` is `available_output_styles`.

Without a wire tap, check `available_output_styles.includes(name)` before you start the session.

## Step 5: What a style changes in the system prompt (`keep-coding-instructions`)

**Part B** (`3 · keep-coding-instructions`) uses `systemPrompt: { type: "preset", preset: "claude_code" }` and
compares the system prompt with the `default` column, line by line. `Tutor` and `Tutor (keeps coding)` have the **same
text**. Only the frontmatter differs:

| Column | System prompt | What changed |
|---|---|---|
| `default` | 26,584 chars | — |
| `Tutor` | 23,320 chars (−3,264) | The first line, and **the whole `# Doing tasks` section is removed** (16 lines) |
| `Tutor (keeps coding)` | 26,641 chars (+57) | Only the first line |

The first line changes with **any** style:

```
- You are an interactive agent that helps users with software engineering tasks. …
+ You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries. …
```

`# Doing tasks` holds Claude Code's coding rules: don't add features or abstractions beyond the task, no comments by
default, no needless error handling, watch for security holes, prefer editing files to creating new ones. A style for
a **coding** agent should say `keep-coding-instructions: true`. A style that turns the agent into something else (a
tutor, a writer) can leave it out. The built-in `Explanatory` and `Learning` keep them.

## Step 6: A plugin can force its style

```md
---
name: House
description: The company voice. force-for-plugin true, so it is applied whenever the plugin is loaded.
force-for-plugin: true
---
Write in the ACME house style:
- Plain, friendly sentences; no emoji.
- End every answer with the line "— ACME Engineering".
```

A plugin's styles are named `<plugin>:<name>` (`acme:House`), and you can select them like any other style. With
`force-for-plugin: true`, the style is applied **whenever the plugin is loaded**, whatever `outputStyle` says. In
row 7 of button 0, `system/init` said `Explanatory`, but the API got `acme:House`, and the answer ended with
"— ACME Engineering". Outside a plugin, `force-for-plugin` is ignored (the CLI logs a warning).

## Step 7: Switching styles in one session

**Part C** (`4 · Switch mid-session`) runs one session with streaming input (Concept 12), five turns. Between turns
the host calls the `Query`'s control methods (Concept 26):

| Before the turn | The turn's `system/init` | New style reminder on the wire | Answer |
|---|---|---|---|
| (start) `settings: { outputStyle: 'Pirate' }` | `Pirate` | `Pirate` | "Arr! I be Claude…" |
| `q.applyFlagSettings({ outputStyle: 'Concise' })` | `Concise` | `Concise` | One plain sentence |
| writes `.claude/output-styles/haiku.md`, `applyFlagSettings({ outputStyle: 'Haiku' })` | `Haiku` | **none**: ignored | Still plain |
| `q.reloadOutputStyles()`, then the same `applyFlagSettings` | `Haiku` | `Haiku` | A haiku |
| `q.updateSettings('localSettings', { outputStyle: 'Explanatory' })`, `applyFlagSettings({ outputStyle: null })` | `Pirate` | `Pirate` | "Arr! Fair winds…" |

What this shows:

- **The switch takes effect on the next turn.** Each turn starts with a new `system/init`, and the new style arrives as
  a **new** reminder in that turn's user message.
- **The old reminders stay in the history** (`Pirate → Concise → Haiku → Pirate`). The model sees all of them, and its
  own earlier answers too, so styles can mix. For a clean switch, start a new session (a fork or a resume keeps the old history).
- **`initializationResult()` is cached.** After `applyFlagSettings`, `(await q.initializationResult()).output_style`
  still said `Pirate`. Read `system/init` instead.
- **A style file written while the session runs is invisible** until `q.reloadOutputStyles()`. Before that, selecting it
  is silently ignored, as in Step 4. `reloadOutputStyles()` returns the new list.
- **`updateSettings('localSettings', …)`** saves the choice the way `/config` does, to `<cwd>/.claude/settings.local.json`.
  It is **refused** ("the localSettings source is disabled for this session") unless `settingSources` includes
  `'local'`, so this session uses `['user', 'project', 'local']`.
- **The layers:** `applyFlagSettings({ outputStyle: null })` removes the value it set. The session then went back to
  `options.settings` (`Pirate`), not to the `Explanatory` just saved in `settings.local.json`: `options.settings` is
  still the higher layer. The saved value is for the **next** session that does not set `options.settings`.

## Step 8: Your own style

The form under Part C writes your style to a real file before the run: to `<run>/.claude/output-styles/` (project) or to
`CLAUDE_CONFIG_DIR/output-styles/` (user; the file name carries the run id and is deleted after the run). Then it runs
the prompt next to `default`. Tick **keep-coding-instructions** and **the `claude_code` preset** to see Step 5 with your
own file. "Show the file that will be written" shows the exact file first.

The server checks the body with zod: a name of letters, digits, spaces and `. ( ) - _`, not a built-in name, and at
most 3000 characters of instructions.

## Step 9: Subagents

A subagent (the `Agent` tool, Concept 8) does **not** get the style. In a probe with `Pirate`, the main agent's
requests carried the `# Output Style: Pirate` reminder, and the subagent's request did not. The main agent still
repeated the subagent's answer in its pirate voice. A subagent's voice comes from its own `prompt`.

## Step 10: Part E, the summary

| You want | Do |
|---|---|
| Change the voice or shape of the answers | An output style, selected with `settings: { outputStyle: 'Name' }` |
| Replace what the agent is | A `systemPrompt` (Concept 9), or an agent (`agent` option) |
| Share styles in a repo | `.claude/output-styles/*.md` + `settingSources` with `'project'` |
| One style for all of a user's projects | `CLAUDE_CONFIG_DIR/output-styles/*.md` + `'user'` |
| A company style everyone gets | A plugin with `force-for-plugin: true` |
| A coding agent with a style | `keep-coding-instructions: true` |
| Know which style is selected | `system/init.output_style` |
| Know it was applied | `available_output_styles.includes(name)`, or look at the request (`# Output Style:`) |
| Switch during a session | `q.applyFlagSettings({ outputStyle })`, from the next turn on (the old reminders stay) |
| A style file added mid-session | `q.reloadOutputStyles()` first |
| Save the user's choice | `q.updateSettings('localSettings', { outputStyle })` with `'local'` in `settingSources` |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/34-output-styles.ts](server/concepts/34-output-styles.ts) and
[src/concepts/Concept34OutputStyles.tsx](src/concepts/Concept34OutputStyles.tsx). The style files are in
[styles-project/](styles-project/), [styles-user/](styles-user/) and [styles-plugin/](styles-plugin/). The tab's
**code** buttons show the regions of the server file (`files`, `options`, `wire`, `system`, `check`, `messages`,
`custom`, `live`).

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `outputStyle`. It is in the **settings** type,
not in `Options` (Step 2 above). Then search for `output_style` and `available_output_styles` (on `system/init` and
in the initialize answer), and for the `Query` methods `applyFlagSettings`, `reloadOutputStyles` and
`updateSettings`. The types do not show what a style sends to the API. That is why the lab has a wire tap (Step 3 of
this section): a style that is silently ignored can only be seen there.

### Step 2: The style files and the folders

```ts
const PROJECT_SRC = path.resolve("styles-project");
const USER_SRC = path.resolve("styles-user");
const PLUGIN = path.resolve("styles-plugin");
const LAB = path.resolve("style-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
mkdirSync(RUNS, { recursive: true });
cpSync(USER_SRC, CONFIG_DIR, { recursive: true }); // CONFIG_DIR/output-styles/spanish.md
```

- `newRun()` copies `styles-project` into `style-lab/runs/<run id>`, so each run can write its own files (a custom
  style, a `settings.json`, `haiku.md`) without touching the others.
- The user style is copied once into the fake `CLAUDE_CONFIG_DIR`, where Claude Code looks for user styles.
- On Windows, a Claude Code process that just closed can still hold its folder. `newRun()` wraps `rmSync` in a
  `try`, and leaves that folder for the next run.

`readStyle()` reads a style file the way the CLI does, and `GET /styles` sends the list to the tab:

```ts
  const name = prefix + (fm.name || path.basename(file, ".md"));
  return { where, file: short(path.relative(process.cwd(), file)).replaceAll("\\", "/"), name, description: fm.description ?? "", keepCoding: fm["keep-coding-instructions"] === "true", forceForPlugin: fm["force-for-plugin"] === "true", body: (m?.[2] ?? raw).trim(), raw };
```

- The name falls back to the file name, and a plugin style gets the `acme:` prefix from `plugin.json`.

### Step 3: The wire tap

The tap is a small HTTP server on its own port on `127.0.0.1`. Each run sends its API calls to
`http://127.0.0.1:<port>/w/<run id>`, and the tap forwards them to the real API:

```ts
const REMINDER = /^<system-reminder>\n# Output Style: ([^\n]*)\n([\s\S]*?)\n?<\/system-reminder>/;
const tapRuns = new Map<string, { run: Run; emit: Emit; seen: number }>();

function styleReminders(messages: any[]): Reminder[] {
  const out: Reminder[] = [];
  messages.forEach((m, msg) => {
    if (m.role !== "user") return;
    for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) {
      const r = b.type === "text" ? String(b.text).match(REMINDER) : null;
      if (r) out.push({ msg, name: r[1], text: r[2].trim() });
    }
  });
  return out;
}
```

For each `POST /v1/messages` (not `count_tokens`, not the side call that names the session), the tap keeps a `Call`:

```ts
        const reminders = styleReminders(j.messages);
        const call: Call = { n: t.run.calls.length + 1, system, reminders, fresh: reminders.filter((r) => r.msg >= t.seen) };
        t.seen = j.messages.length;
        t.run.calls.push(call);
```

- `REMINDER` finds the `# Output Style:` reminder of Step 3 above in the user messages.
- `fresh` holds the reminders added since the last call. That is how Part C sees a **new** reminder in a turn.
- `system` drops the billing header and the SDK's one-line identity, and hides the run id, so two runs can be
  compared line by line (Step 5 above).
- The tap listens on port 0 of `127.0.0.1`, so the system picks a free port. `openTap()` registers the run and
  returns its URL.

### Step 4: The options

```ts
async function baseOptions(run: Run, emit: Emit, s: Setup, abort: AbortController): Promise<Options> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR; // user styles: CLAUDE_CONFIG_DIR/output-styles/
  env.ANTHROPIC_BASE_URL = await openTap(run, emit); // every API call goes through the wire tap
  return {
    model: MODEL,
    cwd: run.work, // project styles: <cwd>/.claude/output-styles/
    // There is no outputStyle option: the style is a setting. options.settings is the "flag" layer, the highest one.
    ...(s.style !== undefined && { settings: { outputStyle: s.style } }),
    // Project and user styles are only found when their setting source is loaded.
    settingSources: s.sources ?? ["user", "project"],
    // …
    ...(s.preset && { systemPrompt: { type: "preset", preset: "claude_code" } }),
    ...(s.plugin && { plugins: [{ type: "local", path: PLUGIN }] }), // its styles are "acme:<name>"
    // … tools, persistSession: false, thinking disabled, maxTurns, abortController, env
  };
}
```

- Each experiment is only a different `Setup`: a style name, the preset or not, the setting sources, the plugin.
- `"default"` means **no** `settings` at all, not `outputStyle: "default"`.

### Step 5: Run one query, then judge it

`collect()` runs one `query()` to the end. At `system/init` it keeps the style name and the list of styles:

```ts
      if (m.type === "system" && m.subtype === "init") {
        o.init = m.output_style;
        o.available = (await q.initializationResult()).available_output_styles;
        await onInit?.(q);
      }
```

`verdict()` is the host check shown in Step 4 above.

- It compares three things: what the host asked, what `system/init` says, and what the wire tap saw.
- `systemSummary()` (the `system` region) compares a column's system prompt with the `default` column: characters,
  removed headings, removed and added lines.

### Step 6: `POST /compare`, and your own style file

`POST /compare` runs 1 to 5 styles in parallel, one run per column. The body is checked with zod:

```ts
const CompareBody = z
  .object({
    styles: z.array(StyleName).min(1).max(5).refine((a) => new Set(a).size === a.length, { message: "each style once" }),
    prompt: z.string().trim().min(1).max(2000).optional(),
    preset: z.boolean().optional(), // systemPrompt: { type: "preset", preset: "claude_code" }
    custom: Custom.optional(), // your own style file, written into the run before it starts
  })
  .strict()
  .refine((b) => !b.custom || b.styles.includes(b.custom.name), { message: "styles must include the custom style's name" });
```

The custom style becomes a real file before the session starts:

```ts
function writeCustom(run: Run, c: z.infer<typeof Custom>) {
  const dir = c.where === "project" ? path.join(run.work, ".claude", "output-styles") : path.join(CONFIG_DIR, "output-styles");
  const file = path.join(dir, `custom-${run.id}.md`);
  const fm = [`name: ${JSON.stringify(c.name)}`, `description: ${JSON.stringify(c.description || "Written in the lab")}`, ...(c.keepCoding ? ["keep-coding-instructions: true"] : [])];
  writeFileSync(file, `---\n${fm.join("\n")}\n---\n${c.body}\n`);
  return file;
}
```

- `Custom` refuses a built-in name, whatever its case, and limits the name's characters (Step 8 above).
- A user style file is shared by every run, so its name carries the run id, and the `finally` block deletes it.
- Each column is sent as a `column` event as soon as it ends. The `system` events come last, because they need the
  `default` column's system prompt.

### Step 7: `POST /who`: seven setups

```ts
  { key: "case", label: "the wrong case", shown: "settings: { outputStyle: 'explanatory' }", setup: { style: "explanatory" } },
  { key: "nosource", label: "a project style, no setting sources", shown: "settings: { outputStyle: 'Pirate' }, settingSources: []", setup: { style: "Pirate", sources: [] } },
  // …
  { key: "file", label: "from .claude/settings.json", shown: "settingSources: ['project'] + .claude/settings.json { outputStyle: 'Code reviewer' }", setup: { sources: ["project"] }, projectSettings: true },
  { key: "plugin", label: "a plugin forces its style", shown: "plugins: [acme], settings: { outputStyle: 'Explanatory' }", setup: { style: "Explanatory", plugin: true } },
```

- Each row of the `WHO` array is one `Setup`, so the route is a short `Promise.all` over `baseOptions()`,
  `collect()` and `verdict()`.
- For the `file` row, the route writes `.claude/settings.json` into the run's folder first.
- Each run uses `tools: []` and `maxTurns: 1` with "Say hello in one short sentence.", so the 7 rows are cheap.

### Step 8: `POST /live`: one session, five turns

The session uses streaming input (Concept 12). `inbox()` is a prompt that the host can push messages into:

```ts
function inbox() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
      if (closed) return;
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: queue.shift()! } };
    }
  }
  return { messages: messages(), push: (t: string) => (queue.push(t), wake?.()), close: () => ((closed = true), wake?.()) };
}
```

`live()` then calls the `Query`'s control methods between turns:

```ts
    const r = await q.reloadOutputStyles();
    control("q.reloadOutputStyles()", r.available_output_styles, "re-reads the style folders: Haiku is there now");
    await q.applyFlagSettings({ outputStyle: "Haiku" });
    control("q.applyFlagSettings({ outputStyle: 'Haiku' })", "ok", "the same call, now the style exists");
    await step(); // 4
```

- `step()` pushes the next prompt and reads messages until the `result`. It keeps the turn's `system/init` style and
  the `fresh` reminders from the tap.
- `total_cost_usd` adds up over the session, so `step()` shows each turn's own part (`spent`).
- Each control call is sent as a `control` event, with its result and a note, so the tab shows it between the turns.
- The session uses `sources: ["user", "project", "local"]`, because `updateSettings("localSettings")` is refused
  without `'local'` (Step 7 above).

### Step 9: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept34 } from "./concepts/34-output-styles.js";
// …
app.use("/api/c34", concept34); // runs a wire tap (its own port on 127.0.0.1) to show what a style sends to the API
```

### Step 10: The React tab

The tab loads the style files once (`GET /styles`), and every compare button calls `compare()` with a body from the
`compares` and `partB` arrays:

```tsx
await streamPost("/api/c34/compare", body, (event, data) => {
  if (event === "opened") setOptions(data);
  if (event === "column") (got.push(data), setCols([...got].sort((a, b) => a.col - b.col)));
  if (event === "system") setSystems((s) => ({ ...s, [data.col]: data }));
  if (event === "customFile") setFiles((f) => ({ ...f, [data.col]: data }));
  if (event === "error") setError(data.message);
});
```

- The columns arrive in any order, because the runs are parallel. `sort()` puts them back in button order.
- `Columns` draws one card per style: the verdict, "what the API got" (the reminder), the `SystemBox`, and the answer.
- The custom form calls `compare("custom", { styles: ["default", custom.name.trim()], … })`. `preview()` shows the
  same file that `writeCustom()` will write.
- `live()` streams `POST /live` into `LiveTimeline`, which draws `control` and `turn` rows.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 34, title: "Output styles", Component: Concept34OutputStyles },
```

### Step 11: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 34, and click a style name at the top: the file opens with its frontmatter.
3. Press **0**: two rows are "ignored" and one is "replaced".
4. Press **2**, and open "what the API got" in the Pirate column: the `# Output Style: Pirate` reminder.
5. Press **4**: turn 3 has no new style reminder, and turn 4 has the Haiku one.

## How to try it

1. `npm run dev`, then open the **34. Output styles** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Open the style files at the top (click a name) to see the frontmatter.
3. Press **0 · Which style really applied?** and read the host check column: two rows are ignored, one is replaced.
4. Press **1 · The built-in styles** and **2 · Your own style files**. In each column open **what the API got**.
5. Press **3 · keep-coding-instructions** and open **system prompt** in each column.
6. Press **4 · Switch mid-session** and follow the turns: turn 3 is ignored (orange), and the style history grows.
7. Write your own style in the form, and run it with and without `keep-coding-instructions` and the preset.

Each button costs about $0.02 (Haiku 4.5), and button 3 about $0.04, because it sends the full preset.
