# Settings & env, step by step

This file explains how Concept 16 (**Settings & env**) was added to the Claude Agent SDK Lab.
`query()` does not call the API itself: it starts a **Claude Code process** and talks to it. Up to now every option
was a direct instruction to that process (`model`, `tools`, `maxTurns`…). This concept looks at the two things that
configure the process **around** those options: its environment variables and its settings.

There are three parts:

- **A. `env`.** What the process inherits, and what happens when you set `env` yourself.
- **B. The settings layers.** `settingSources`, `settings`, `managedSettings`, and `resolveSettings()` to see the
  merged result without starting Claude.
- **C. Which files the agent can reach.** `additionalDirectories`, and a `permissions.deny` rule loaded from a
  settings file.

| Concept | Topic | Routes |
|---|---|---|
| 16 | `env`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `settingSources`, `settings` (object or path), `managedSettings`, `resolveSettings()`, `additionalDirectories`, `permissions.deny` | `/api/c16/files`, `/env-run`, `/resolve`, `/layers-run`, `/access-run` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/16-settings-env.ts` | **New**: the five routes |
| `server/index.ts` | Mounts the router on `/api/c16` |
| `src/concepts/Concept16SettingsEnv.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `settings-lab/project/.claude/settings.json` | **New**: project settings (`env`, a `deny` rule) |
| `settings-lab/project/.claude/settings.local.json` | **New**: local settings (`env`) |
| `settings-lab/project/readme.txt`, `secret.txt` | **New**: two files inside the `cwd` |
| `settings-lab/shared/glossary.txt` | **New**: a file outside the `cwd` |
| `settings-lab/flag-settings.json` | **New**: a settings file passed by path |
| `Tab1-query().md` | Adds Concept 16 to the table of concepts |
| `Tab16-Settings-and-env.md` | This explanation |

No CSS was added.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
type Options = {
  env?: { [envVar: string]: string | undefined };
  // "When set, this value REPLACES the subprocess environment entirely — it is not merged with process.env."
  settingSources?: SettingSource[];     // 'user' | 'project' | 'local'. "When omitted, all sources are loaded"
                                        // "Pass [] to disable filesystem settings (SDK isolation mode)."
  settings?: string | Settings;         // "loaded into the 'flag settings' layer, which has the highest priority
                                        //  among user-controlled settings". Equivalent to --settings.
  managedSettings?: Settings;           // policy tier, "filtered restrictive-only"
  additionalDirectories?: string[];     // "Additional directories Claude can access beyond the current working directory"
};

/** @alpha: "Resolve the effective Claude Code settings ... without spawning the Claude CLI." */
function resolveSettings(opts?: { cwd?; settingSources?; managedSettings?; serverManagedSettings? }): Promise<{
  effective: Settings;                                        // merged result
  provenance: Partial<Record<keyof Settings, ProvenanceEntry>>; // who set each TOP-LEVEL key
  sources: Array<{ source; settings; path?; policyOrigin? }>;   // per source, low → high precedence
}>;
```

Note what `resolveSettings()` does **not** take: `settings`. The flag layer only exists when `query()` runs.

## Step 2: Try it before writing the lab

Scratch scripts called `query()` and `resolveSettings()` directly, with a folder `settings-lab/project` that has
both a `.claude/settings.json` and a `.claude/settings.local.json`. Bash could only run `printenv` and `echo`, so the
model printed the real environment of the Claude Code process.

| Test | Result |
|---|---|
| `env: { LAB_TEAM }` only, server has `ANTHROPIC_API_KEY` | Works, but `apiKeySource` becomes `"none"`: the key is gone and the run **falls back to the login** |
| `env: { ...process.env, LAB_TEAM }` | `LAB_TEAM` is set and the key is kept |
| `env: { ...process.env, ANTHROPIC_API_KEY: undefined }` | Removes just that variable |
| Project `env.LAB_LAYER=project` + `Options.env.LAB_LAYER=options.env` | Bash sees **`project`**: `settings.env` wins over `Options.env` |
| project + local + `settings` (flag) | Bash sees the flag value. The `env` objects are **merged key by key** |
| `deny` rules in two layers | The arrays are **concatenated**, not replaced |
| `managedSettings: { model, permissions.deny }` | `model` is **dropped silently**; the `deny` rule is added |
| `settingSources: ["user"]` with no `model` option | The run used the model from `~/.claude/settings.json` (Opus). With `model` set, `Options.model` wins |
| `settingSources` omitted | All three files, **plus the plugins** enabled in your user settings |
| Read a file outside `cwd` in `dontAsk` mode | Denied. With `additionalDirectories: [thatFolder]` it is read |
| `deny: ["Read(./secret.txt)"]` in project settings | Read is denied; the model then tries `cat` through Bash, and that is denied too |

> **Running inside Claude Code.** The first runs showed `apiKeySource: "none"` everywhere, because the scripts were
> started from a Claude Code terminal, and its `CLAUDECODE` / `CLAUDE_CODE_*` variables were inherited (see
> Tab1). That is itself a Part A lesson: **the process inherits everything in your environment**. The tests were
> repeated with those variables removed.

---

# Part A: `env`

## Step 3: Four ways to pass the environment

`/env-run` runs the same prompt four times, in parallel. Only `env` changes:

```ts
if (variant === "spread") options.env = { ...process.env, LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
if (variant === "only") options.env = { LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
if (variant === "removeKey") options.env = { ...process.env, ANTHROPIC_API_KEY: undefined, LAB_TEAM: team };
```

The model runs `printenv` for `LAB_TEAM` and `CLAUDE_AGENT_SDK_CLIENT_APP`, and says whether `ANTHROPIC_API_KEY` is
`set` or `unset` (the key itself is never printed). The card shows `apiKeySource` from the `system/init` message.

| Variant | `LAB_TEAM` | key | `apiKeySource` |
|---|---|---|---|
| omitted | empty | set | `ANTHROPIC_API_KEY` |
| spread + yours | `sdd-team` | set | `ANTHROPIC_API_KEY` |
| yours only | `sdd-team` | **unset** | **`none`** (login) |
| remove one | `sdd-team` | unset | `none` |

*Yours only* is the trap: it looks like it works, but the bill moved from the API key to your subscription (or the
run fails on a machine with no login). Always spread `process.env` unless you want a clean environment on purpose.

`CLAUDE_AGENT_SDK_CLIENT_APP` is the variable the SDK documents for naming your app in the `User-Agent` header.

The options echo does not print the whole environment: the server shows `"...process.env": "73 inherited variables"`
and only the variables that differ. Values of keys that look secret are masked.

---

# Part B: The settings layers

## Step 4: The files

```text
settings-lab/
  project/                      <- cwd of every run
    .claude/settings.json        { env: { LAB_LAYER: "project", LAB_PROJECT_NOTE }, permissions: { deny: ["Read(./secret.txt)"] } }
    .claude/settings.local.json  { env: { LAB_LAYER: "local", LAB_LOCAL_NOTE } }
    readme.txt, secret.txt
  shared/glossary.txt            <- outside cwd (Part C)
  flag-settings.json             { env: { LAB_LAYER: "flag (from settings-lab/flag-settings.json)" } }
```

The precedence, low → high: **user** → **project** → **local** → **flag** (`settings`) → **managed** (policy).

## Step 5: `resolveSettings()` and a real run

The form builds one body. **Resolve** sends it to `/resolve`, which calls:

```ts
const resolved = await resolveSettings({ cwd: options.cwd, settingSources: options.settingSources, managedSettings: options.managedSettings });
```

It takes about 10 ms and makes no API call. The tab shows `sources` (which file each layer came from, and its keys),
`provenance` and `effective`. **Run** sends the same body to `/layers-run`, which builds the same options for
`query()`, and the model prints `LAB_LAYER`, `LAB_PROJECT_NOTE` and `LAB_LOCAL_NOTE`:

| Preset | `LAB_LAYER` | Why |
|---|---|---|
| No files (`[]`) | empty | SDK isolation mode: no settings at all |
| project | `project` | |
| project + local | `local` | local is above project; `LAB_PROJECT_NOTE` survives (key-by-key merge) |
| + settings (inline) | `flag (inline object)` | the flag layer is above the files |
| (no preset) `settings:` radio set to the path | `flag (from …flag-settings.json)` | `settings` also takes a path to a JSON file |
| Options.env vs project | **`project`** | `settings.env` is applied over the process environment |
| managedSettings | `project` | managed `model` is dropped; `deny` gains `Bash(rm:*)` |

Two things `resolveSettings()` shows that a run cannot:

1. **Provenance is per top-level key.** With project + local, `env` is credited to `local`, although
   `LAB_PROJECT_NOTE` came from project. `sources` has the per-layer detail.
2. **`managedSettings` keeps only restrictive keys.** Your `model` is not in `effective`, and nothing warns you.

If you tick **user** (or omit `settingSources`), the tab shows your real `~/.claude/settings.json`, with secret-looking
values masked. The run stays on Haiku, because `Options.model` wins over `model` in any settings file, but the
`system/init` message now lists your **plugins**. `settingSources: []` is what keeps a server's runs independent of
whoever's machine it is on.

---

# Part C: Which files the agent can reach

## Step 6: `additionalDirectories` and a `deny` rule

`/access-run` asks the model to read one of three files (chosen by key, never a path from the browser), with two
switches: `settingSources: ["project"]` and `additionalDirectories: [settings-lab/shared]`. The permission mode is
`dontAsk`, so anything not allowed is refused instead of asked.

| Column | File | Result |
|---|---|---|
| 1 | `shared/glossary.txt`, neither switch | Read denied (outside `cwd`), then Bash `cat` denied: 2 permission denials |
| 2 | `shared/glossary.txt`, `additionalDirectories` | Read works |
| 3 | `project/secret.txt`, neither switch | Read works: inside `cwd` and no rule loaded |
| 4 | `project/secret.txt`, `settingSources: ["project"]` | *"File is in a directory that is denied by your permission settings."* |

Column 3 against column 4 is the point: a `deny` rule in a settings file only protects anything when
`settingSources` loads that file. If your server depends on a rule, pass it in code (`settings` or
`disallowedTools`), not only in a file.

---

## What to take away

1. **`env` replaces, it does not merge.** Write `{ ...process.env, ... }`. Set a variable to `undefined` to remove it.
2. **Check `apiKeySource` in `system/init`.** It tells you which credential really paid for the run.
3. **`settingSources` omitted means *all* files**, including the user's plugins and model. Use `[]` on a server and
   add only what you need.
4. **Order: user → project → local → flag (`settings`) → managed.** Objects merge key by key, arrays concatenate.
5. **`settings.env` beats `Options.env`; `Options.model` beats `settings.model`.** Test the ones you rely on.
6. **`resolveSettings()` is free and fast** (`@alpha`). Use it to explain a configuration before paying for a run.
   It does not include `settings`, and its provenance is per top-level key.
7. **`managedSettings` is for restrictions only.** Other keys are dropped without a warning.
8. **`additionalDirectories` opens folders outside `cwd`; a `deny` rule only works if its file is loaded.**

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/16-settings-env.ts](server/concepts/16-settings-env.ts) and
[src/concepts/Concept16SettingsEnv.tsx](src/concepts/Concept16SettingsEnv.tsx).

### Step 1: Read the types, then probe

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `env`, `settingSources`, `settings`,
`managedSettings`, `additionalDirectories` and `resolveSettings` (see Step 1 above). Then the scratch scripts of
Step 2 above ran each option on its own. The lab only shows what those scripts saw first.

### Step 2: The folders and one base configuration

```ts
const LAB = path.resolve("settings-lab");
const PROJECT = path.join(LAB, "project");
const SHARED = path.join(LAB, "shared"); // outside cwd: only reachable with additionalDirectories
const FLAG_FILE = path.join(LAB, "flag-settings.json");
// …
const BASE: Options = {
  model: HAIKU,
  cwd: PROJECT,
  tools: ["Bash", "Read"],
  allowedTools: ["Bash(printenv:*)", "Bash(echo:*)"],
  permissionMode: "dontAsk",
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 4,
};
```

- Every route starts from `{ ...BASE }` and changes one or two options. So each difference you see comes from one
  option only.
- `settingSources: []` is the starting point: no settings file is read unless a part turns it on.
- `dontAsk` with only `printenv` and `echo` allowed means the model can print the environment, and anything else is
  refused instead of asked.

### Step 3: Two helpers: the prompt and the echo

```ts
function printenvPrompt(vars: string[], extra: string[] = []) {
  const command = [...vars.map((v) => `echo "${v}=$(printenv ${v})"`), ...extra].join("; ");
  return `Run exactly this one Bash command and reply with its raw output only, nothing else: ${command}`;
}
```

```ts
function echo(options: Options) {
  if (!options.env) return options;
  const env = options.env;
  const inherited = Object.keys(env).filter((k) => env[k] !== undefined && env[k] === process.env[k]);
  const changed = Object.fromEntries(Object.entries(env).filter(([k]) => !inherited.includes(k)).map(([k, v]) => [k, v === undefined ? "undefined (removed)" : mask(v, k)]));
  const summary = inherited.length ? { "...process.env": `${inherited.length} inherited variables` } : {};
  return { ...options, env: { ...summary, ...changed } };
}
```

- `echo NAME=$(printenv NAME)` prints an empty value when a variable is missing, instead of failing.
- `echo()` builds the options the UI shows. It never sends the whole server environment: the inherited part becomes
  one line (`"...process.env": "73 inherited variables"`), and only the changed variables are listed.
- `mask()` hides the value of any key that looks secret (`key`, `token`, `secret`, `password`, `auth`). It is also
  used on your real user settings in Part B.

### Step 4: Part A: the `/env-run` route

```ts
concept16.post("/env-run", (req, res) => {
  const parsed = EnvBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { variant, team } = parsed.data;

  const options: Options = { ...BASE };
  const app = "atmira-lab/16";
  if (variant === "spread") options.env = { ...process.env, LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
  if (variant === "only") options.env = { LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
  if (variant === "removeKey") options.env = { ...process.env, ANTHROPIC_API_KEY: undefined, LAB_TEAM: team };

  send("options", { ...echo(options), parentHasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
```

- `EnvBody` (a zod schema, see Step 6) checks the body first. A bad body ends the stream with an `error` event and
  a `done` event, before anything starts.
- One request is one variant. The browser sends four requests in parallel, one per column.
- `parentHasKey` tells the tab whether the server itself has a key. Without it, all four columns look the same, and
  the tab shows a warning.
- `openSse()` (from [server/sse.ts](server/sse.ts)) gives `send`, `pipe` and an `abort` controller. `pipe()` sends
  every SDK message as a `message` event and ends with `done`.

### Step 5: Part B: one function for both `/resolve` and `/layers-run`

```ts
function layersOptions(body: LayersBody): Options {
  const options: Options = { ...BASE };
  if (body.sources) options.settingSources = body.sources;
  else delete options.settingSources;
  if (body.flag === "inline") options.settings = parse(body.flagJson, "settings");
  if (body.flag === "file") options.settings = FLAG_FILE;
  const managed = parse(body.managedJson, "managedSettings");
  if (managed) options.managedSettings = managed;
  if (body.optionsEnvLayer) options.env = { ...process.env, LAB_LAYER: body.optionsEnvLayer };
  return options;
}
```

- `sources: null` means "omit `settingSources`", so the key is deleted (all three files are read). The tab also
  sends `omit`, the state of its checkbox, but the server only reads `sources`.
- The flag file is chosen by the server (`FLAG_FILE`). The browser only says `"file"`, never a path.
- `parse()` throws a clear message when the JSON typed in the form is not valid.

Both routes call it. `/resolve` returns JSON and starts nothing:

```ts
const resolved = await resolveSettings({ cwd: options.cwd, settingSources: options.settingSources, managedSettings: options.managedSettings });
res.json({
  took: Date.now() - startedAt,
  // …
  flag: options.settings ?? null,
  effective: mask(resolved.effective),
  provenance: resolved.provenance,
  sources: resolved.sources.map((s) => ({ ...s, settings: mask(s.settings) })),
});
```

- `flag` is sent on its own because `resolveSettings()` has no `settings` input (see Step 5 above).
- A body that does not fit `LayersBody` is refused with `400` and `{ error }` before `layersOptions()` runs. JSON
  typed in the form that does not parse becomes a `400` too.
- `/layers-run` builds the same options, sends them as an `options` event, and pipes `query()` with a
  `printenvPrompt` for `LAB_LAYER`, `LAB_PROJECT_NOTE` and `LAB_LOCAL_NOTE`. On bad JSON it sends `error` and `done`.

`GET /files` reads the three settings files, so the tab can show them.

### Step 6: Part C: the `/access-run` route, and the checks on every body

```ts
const FILES = {
  readme: path.join(PROJECT, "readme.txt"), // inside cwd
  secret: path.join(PROJECT, "secret.txt"), // inside cwd, denied by project settings
  glossary: path.join(SHARED, "glossary.txt"), // outside cwd
};

const AccessBody = z
  .object({
    file: z.enum(["readme", "secret", "glossary"]), // a key of FILES, never a path
    projectSettings: z.boolean(),
    additionalDir: z.boolean(),
  })
  .strict();
// …
  const options: Options = { ...BASE };
  if (projectSettings) options.settingSources = ["project"];
  if (additionalDir) options.additionalDirectories = [SHARED];
```

- The browser sends a key (`readme`, `secret`, `glossary`) and two booleans. The path comes from `FILES`. Any
  other key is refused.
- The two switches map to exactly one option each, so each column of the table in Step 6 above is one combination.
- Every route that reads a body has a schema like this one (`EnvBody`, `LayersBody`, `AccessBody`). `.strict()`
  refuses unknown keys. `badRequest()` turns the zod issues into one line, such as
  `Bad request: file: Invalid option: expected one of "readme"|"secret"|"glossary"`.

### Step 7: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept16 } from "./concepts/16-settings-env.js";
// …
app.use("/api/c16", concept16);
```

### Step 8: The React tab

The tab has three parts (`EnvPart`, `LayersPart`, `AccessPart`). They all use the same helper to run one streamed
request and keep its state:

```tsx
async function startRun(url: string, body: object, update: (fn: (r: Run) => Run) => void) {
  update(() => ({ messages: [], running: true }));
  try {
    await streamPost(url, body, (event, data) => {
      if (event === "options") update((r) => ({ ...r, options: data }));
      if (event === "message") update((r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}
```

- Part A calls it four times at once, one per variant, and stores each run under its id:
  `startRun("/api/c16/env-run", { variant: v.id, team }, (fn) => setRuns((prev) => ({ ...prev, [v.id]: fn(prev[v.id] ?? EMPTY) })))`.
- `readRun()` reads the messages of one run: the `system/init` message (for `apiKeySource` and `plugins`), each tool
  call with its result, and the `permission_denials` of the result. `RunCard` draws them.
- Part B builds one body from the form. **Resolve** sends it with `fetch` to `/api/c16/resolve`, **Run** calls
  `resolve()` and then `startRun("/api/c16/layers-run", body, …)`. When "omitted" is ticked, the body has
  `sources: null`.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 16, title: "Settings & env", Component: Concept16SettingsEnv },
```

### Step 9: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev` from a normal terminal, open tab 16, and click **Run the 4 env variants in parallel**: "yours only"
   shows `apiKeySource: none`.
3. In Part B, pick **project + local** and click **Resolve (no model call)**, then **Run query() with these layers**.
4. In Part C, click **Run the 4 columns in parallel**: column 4 has a permission denial.
5. Send a bad body, for example `{"variant":"bogus","team":"x"}` to `/env-run`: the stream has only an `error`
   event and `done`.
6. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 16

1. In Part A, comment out the key in `.env`, restart, and run again. What does the warning card say?
2. In Part B, pick *project + local*, then edit `settings.local.json` to remove `LAB_LAYER`. Resolve again: who wins now?
3. Add `"model": "claude-sonnet-5"` to the inline `settings`. Does the run change model? Why not?
4. Put `{ "permissions": { "allow": ["Bash(ls:*)"] } }` in `managedSettings`. Is it in `effective`?
5. In Part C, set all four columns to `readme.txt` and try every switch. Is anything denied?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**16. Settings & env**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.
Start the server from a normal terminal, not from inside Claude Code, or Part A shows `apiKeySource: "none"` in every
column. Costs on Haiku: $0.003 to $0.014 per column in Part A, about $0.004 per Part B run, $0.004 to $0.012 per
Part C column. **Resolve** is free.

The routes can also be called without the UI. For Part B the server reads `sources` (`null` means "omit
`settingSources`"), `flag`, `flagJson`, `managedJson` and `optionsEnvLayer`. The tab also sends `omit`, which the
server accepts and ignores:

```powershell
'{"sources":["project","local"],"flag":"file","flagJson":"","managedJson":"","optionsEnvLayer":""}' | Set-Content body.json
curl.exe -X POST http://localhost:3001/api/c16/resolve -H "Content-Type: application/json" -d "@body.json"
curl.exe -N -X POST http://localhost:3001/api/c16/layers-run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
