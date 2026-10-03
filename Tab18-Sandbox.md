# Sandbox, step by step

This file explains how Concept 18 (**Sandbox**) was added to the Claude Agent SDK Lab.
Concept 4 answered *may this tool call run?* (`permissionMode`, `allowedTools`, `canUseTool`). The **sandbox** answers
a different question: *once a Bash command runs, what can it touch?* With `sandbox: { enabled: true }`, Claude Code
starts every Bash command inside an OS-level sandbox that limits the files it can write, the files it can read, and
the hosts it can reach.

There are two parts:

- **A. Does the sandbox start?** The same `{ enabled: true }` passed three ways, and what each one does when the
  sandbox is not available.
- **B. One Bash command, four configurations.** Write, read, network and the model's escape hatch, with
  `canUseTool` and the disk as witnesses.

| Concept | Topic | Routes |
|---|---|---|
| 18 | `sandbox.enabled`, `failIfUnavailable`, `settings.sandbox`, the stderr warning, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands` + `dangerouslyDisableSandbox`, `excludedCommands`, `filesystem.denyRead`, `network.allowedDomains` | `/api/c18/platform`, `/availability`, `/run` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/18-sandbox.ts` | **New**: the three routes |
| `server/index.ts` | Mounts the router on `/api/c18` |
| `src/concepts/Concept18Sandbox.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `.gitignore` | Ignores `sandbox-lab/`, which the server recreates |
| `Tab1-query().md` | Adds Concept 18 to the table of concepts |
| `Tab18-Sandbox.md` | This explanation |

No CSS was added. The lab folder is `sandbox-lab/`, not `sandbox/`: that one belongs to Concept 3.

> **Read this first: on the machine this lab was built on, the sandbox does not start.** It is native Windows 11,
> and the CLI says `the Windows sandbox is not active on this session (feature gate off)`. WSL has no Linux
> distribution (only `docker-desktop`). So every result in this file was observed with the sandbox **unavailable**.
> The lines marked *(docs)* describe what an active sandbox does, from the SDK types and the Claude Code docs; they
> were **not** observed here. On macOS, or on Linux/WSL with `bubblewrap` installed, the same tab shows them for real.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
type Options = {
  sandbox?: SandboxSettings;
  // "When `enabled: true` is passed via this option, `failIfUnavailable` defaults to `true` — if sandbox
  //  dependencies are missing (e.g. `bubblewrap` on Linux) or the platform is unsupported, `query()` will
  //  emit an error result and exit rather than silently running commands unsandboxed."
};

type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  autoAllowBashIfSandboxed?: boolean;     // sandboxed commands do not ask for permission
  allowUnsandboxedCommands?: boolean;     // honor the Bash input `dangerouslyDisableSandbox` (default true)
  excludedCommands?: string[];            // always run outside the sandbox
  filesystem?: { allowWrite?, denyWrite?, denyRead?, allowRead?, ... };  // merged with Edit(...) / Read(...) rules
  network?: { allowedDomains?, deniedDomains?, strictAllowlist?, allowLocalBinding?, ... };
  credentials?: { files?, envVars?, ... };  // deny or mask secrets inside the sandbox
  // ...and platform switches: enableWeakerNestedSandbox, allowAppleEvents, bwrapPath, ripgrep...
};

// sdk-tools.d.ts, the Bash tool input the model writes:
interface BashInput { command: string; dangerouslyDisableSandbox?: boolean; /* ... */ }
```

Two things the types say that matter for the design:

1. The sandbox is **per platform**: Seatbelt on macOS, `bubblewrap` (+ `socat`) on Linux/WSL, and a separate user
   on native Windows. So the first question is *does it start here?*
2. The restrictions come from two places: the `sandbox.filesystem` / `sandbox.network` lists **and** your permission
   rules (`Edit(...)`, `Read(...)`, `WebFetch(domain:...)`).

## Step 2: Try it before writing the lab

Scratch scripts called `query()` directly, with only the `Bash` tool and the `CLAUDE*` variables removed. The key
results:

| Test | Result |
|---|---|
| `sandbox: { enabled: true }` | **No `init` message**, one result `error_during_execution`, `$0`, ~2.5 s. Then `for await` **throws** `Claude Code returned an error result: Sandbox required but unavailable: … Set sandbox.failIfUnavailable=false to allow unsandboxed execution.` |
| `sandbox: { enabled: true, failIfUnavailable: false }` | The run works. stderr says `Sandbox disabled: … Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.` |
| `settings: { sandbox: { enabled: true } }` | The same as the line above, **without** setting `failIfUnavailable`: through settings it defaults to `false` |
| `managedSettings: { sandbox: { enabled: true } }` | The same: runs unsandboxed, with only the stderr warning |
| The `init` message | Has **no** sandbox field. stderr is the only place that tells you the sandbox is off |
| Sandbox disabled, `echo x > note.txt`, `permissionMode: "default"` | `canUseTool` **is** called, as without a sandbox. `autoAllowBashIfSandboxed` (default `true`) does **not** auto-approve when there is no sandbox |
| `echo hello` (read-only) | Never asks, with or without the sandbox: read-only commands are always allowed |
| Model asked to set `dangerouslyDisableSandbox: true` | It does; the flag is in the tool input that `canUseTool` receives |
| `curl https://example.com` from Git Bash | Works (`200`); `canUseTool` gets `decisionReason: "This command requires approval"` |

---

# Part A: Does the sandbox start?

## Step 3: The same object, three ways

`/availability` runs the prompt `Reply with the single word: ok` three times in parallel. No tool is needed: the
sandbox is set up when the Claude Code process starts, before the first turn.

```ts
if (variant === "option") options.sandbox = { enabled: true };
if (variant === "optionOpen") options.sandbox = { enabled: true, failIfUnavailable: false };
if (variant === "settings") options.settings = { sandbox: { enabled: true } };
```

Every run passes a `stderr` callback that forwards the lines mentioning the sandbox to the browser:

```ts
function sandboxStderr(send: (event: string, data: unknown) => void) {
  return (data: string) => {
    for (const line of data.split("\n")) if (/sandbox/i.test(line)) send("stderr", line.replace(/^[^\w]*(?=\w)/, "").trim());
  };
}
```

What the three cards show on this machine:

| Card | init | Result | `for await` | stderr |
|---|---|---|---|---|
| `Options.sandbox` | no | `error_during_execution`, $0 | **throws** | `sandbox required but unavailable … refusing to start` |
| `…failIfUnavailable: false` | yes | `success` "ok" | ends normally | `Sandbox disabled … WITHOUT sandboxing` |
| `settings.sandbox` | yes | `success` "ok" | ends normally | `Sandbox disabled … WITHOUT sandboxing` |

The rule: **`Options.sandbox` fails closed, settings fail open.** If your app *needs* the sandbox, pass it through
`Options.sandbox` and handle the throw. If you pass `failIfUnavailable: false` (or use settings files), read stderr,
or you will not know your commands ran unprotected.

*(docs)* Where the sandbox is available, all three cards show `success`, and there is no warning.

When stderr has no sandbox warning, the card says `no warning seen on stderr (not proof that it is active)`. That is
all the lab can know: nothing in the messages says the sandbox **is** active, and on this machine it never was.

---

# Part B: One Bash command, four sandbox configurations

## Step 4: A command the server picks, a folder per column

`/run` takes a column number (0 to 3), a command id and six booleans. The browser never sends a path or a
command. Each column gets its own folder, recreated before every run:

```
sandbox-lab/column-N/
  project/readme.txt     <- cwd
  outside/secret.txt     <- "TOP-SECRET-42", outside cwd
```

The five commands:

| Id | Command | *(docs)* With an active sandbox |
|---|---|---|
| `writeInside` | `echo sandboxed > note.txt && cat note.txt` | Allowed: `cwd` is writable |
| `readOutside` | `cat ../outside/secret.txt` | Allowed (reads are open), unless `filesystem.denyRead` lists the file |
| `writeOutside` | `echo escaped > ../outside/escape.txt && echo written` | Blocked: only `cwd` and `allowWrite` are writable |
| `network` | `curl -s -o /dev/null -w "%{http_code}" https://example.com` | Blocked, unless `allowedDomains` has `example.com` or `curl` is in `excludedCommands` |
| `escapeHatch` | the `writeOutside` command, and the prompt asks for `dangerouslyDisableSandbox: true` | Runs outside the sandbox, after a permission ask; ignored if `allowUnsandboxedCommands: false` |

The six switches build the `sandbox` object. `failIfUnavailable: false` is always set, so the columns also run
where the sandbox cannot start:

```ts
return {
  enabled: true,
  failIfUnavailable: false,
  autoAllowBashIfSandboxed: config.autoAllow,
  allowUnsandboxedCommands: config.allowUnsandboxed,
  ...(config.denySecret && { filesystem: { denyRead: [path.join(outside, "secret.txt")] } }),
  ...(config.allowExample && { network: { allowedDomains: ["example.com"] } }),
  ...(config.excludeCurl && { excludedCommands: ["curl"] }),
};
```

## Step 5: Two witnesses: canUseTool and the disk

`permissionMode` is `"default"`, so any command that is not auto-approved goes to `canUseTool`. The lab's
`canUseTool` sends every ask to the browser and allows **only** the lab command, so the model cannot wander off:

```ts
const canUseTool: Options["canUseTool"] = async (toolName, input, { decisionReason, blockedPath }) => {
  const allowed = toolName === "Bash" && typeof input.command === "string" && input.command.trim() === lab.command;
  // blockedPath is absolute; relative to the column folder it fits on the card (e.g. outside\escape.txt).
  send("ask", { toolName, input, decisionReason, blockedPath: blockedPath && path.relative(dirs(column).root, blockedPath), allowed });
  return allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the lab command may run in this lab." };
};
```

After the run, the server lists `project/` and `outside/` itself (`disk` event). That is the proof of what the command
did, whatever the model says about it.

## Step 6: What the columns show

The default columns are: **1** no sandbox; **2** sandbox with the defaults; **3** `autoAllowBashIfSandboxed: false`;
**4** `allowUnsandboxedCommands: false` + `denyRead` + `allowedDomains`.

On this machine (sandbox unavailable), all four columns gave the **same** result for every command:

| Command | canUseTool | Output / disk |
|---|---|---|
| Write inside cwd | asked → allowed | `note.txt` created |
| Read outside cwd | asked → allowed | `TOP-SECRET-42`, even in column 4 with `denyRead` |
| Write outside cwd | asked → allowed, `blockedPath: outside\escape.txt` | `outside/escape.txt` created |
| Network | asked → allowed (`This command requires approval`) | `200`, even in column 4 |
| Escape hatch | asked → allowed, input has `dangerouslyDisableSandbox: true` | `outside/escape.txt` created, even in column 4 |

Columns 2–4 each show `sandbox: DISABLED (stderr warning)`. That is the lesson of this machine: **a sandbox that
did not start protects nothing**, however it is configured. The permission layer still works (every write went to
`canUseTool`), but the rules in `sandbox.filesystem` and `sandbox.network` do nothing.

Look at `blockedPath` on the write-outside cards: the **permission** layer parsed the redirect and reports the file
outside `cwd` it would write (the server shortens it to `outside\escape.txt`). That is Concept 4's working-directory
check, and it works with or without a sandbox. It only *asks*, though: once `canUseTool` says allow, nothing stops
the write. Blocking it after approval is the sandbox's job.

*(docs)* With an active sandbox, the columns differ:

| Command | Col 1 (off) | Col 2 (defaults) | Col 3 (no auto-allow) | Col 4 (strict) |
|---|---|---|---|---|
| Write inside cwd | asked | runs, **not asked** | asked, then sandboxed | runs, not asked |
| Read outside cwd | asked | runs, not asked | asked | **blocked** by `denyRead` |
| Write outside cwd | asked, file written | **fails** inside the sandbox | asked, then fails | fails |
| Network | asked, `200` | **blocked**, or an ask for the new host (`strictAllowlist: true` makes it a hard deny) | asked, then the same | `200` (allowed domain) |
| Escape hatch | asked, file written | **asked** (runs unsandboxed if allowed) | asked | flag **ignored**, write fails |

Treat the second table as a hypothesis to check on macOS or Linux/WSL, not as a result.

---

## What to take away

1. **Permissions and sandbox are two layers.** Permissions decide whether a command runs; the sandbox decides what
   it can reach. `autoAllowBashIfSandboxed` links them: a sandboxed command can skip the permission ask.
2. **The sandbox is per platform.** macOS: Seatbelt. Linux/WSL: `bubblewrap` + `socat`. Native Windows: the Windows
   sandbox, which may not be enabled for your account.
3. **`Options.sandbox` fails closed.** `failIfUnavailable` defaults to `true` there: an error result with no model
   call, then `for await` throws.
4. **Settings fail open.** The same object through `settings` or `managedSettings`, or with `failIfUnavailable: false`,
   runs **unsandboxed**, and the only sign is a line on stderr. `init` has no sandbox field.
5. **No sandbox, no auto-allow.** When the sandbox is off, `autoAllowBashIfSandboxed` does not approve anything, and
   `canUseTool` is still asked.
6. **The model has an escape hatch.** `dangerouslyDisableSandbox: true` on the Bash input. It goes through
   permissions; set `allowUnsandboxedCommands: false` to make the sandbox mandatory.
7. **Check the disk, not the model.** A command's effect is on disk or in its output; the model's summary is not
   evidence.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/18-sandbox.ts](server/concepts/18-sandbox.ts) and
[src/concepts/Concept18Sandbox.tsx](src/concepts/Concept18Sandbox.tsx).

### Step 1: Read the types, then probe

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `SandboxSettings`, `failIfUnavailable`,
`autoAllowBashIfSandboxed`, `allowUnsandboxedCommands` and `excludedCommands`, and in `sdk-tools.d.ts` for
`dangerouslyDisableSandbox` (see Step 1 above). The scratch scripts of Step 2 above found the most important fact for
the design: the only sign that the sandbox did not start is a line on stderr.

### Step 2: The folder and the base options

```ts
// Not "sandbox/": that folder belongs to Concept 3.
const LAB = path.resolve("sandbox-lab");
// …
const BASE: Options = {
  model: HAIKU,
  tools: ["Bash"],
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 3,
};
```

- Only the `Bash` tool, and no settings files: every difference between two cards comes from the sandbox options.
- `sandboxStderr()` (Step 3 above) returns the function passed as the `stderr` option. It keeps only the lines that
  mention the sandbox, removes the symbols at the start of the line, and sends each one as a `stderr` event.
- `GET /platform` returns `process.platform`, `os.release()` and `process.arch`, so the tab can say which machine the
  server runs on.

### Step 3: Part A: the `/availability` route

```ts
function availabilityOptions(variant: Variant): Options {
  const options: Options = { ...BASE, cwd: LAB, permissionMode: "dontAsk" };
  if (variant === "option") options.sandbox = { enabled: true };
  if (variant === "optionOpen") options.sandbox = { enabled: true, failIfUnavailable: false };
  if (variant === "settings") options.settings = { sandbox: { enabled: true } };
  return options;
}

concept18.post("/availability", async (req, res) => {
  const parsed = AvailabilityBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { variant } = parsed.data;
  await mkdir(LAB, { recursive: true });

  const options = availabilityOptions(variant);
  send("options", options);
  // No tool is needed: the sandbox is set up when the process starts, before the first turn.
  pipe(query({ prompt: "Reply with the single word: ok", options: { ...options, abortController: abort, stderr: sandboxStderr(send) } }));
});
```

- `AvailabilityBody` is `z.object({ variant: z.enum(["option", "optionOpen", "settings"]) }).strict()`. An unknown
  variant gets an `error` event and `done`, and nothing starts.
- One request is one card. The browser sends the three variants in parallel.
- When `for await` throws (the fail-closed card), `pipe()` in [server/sse.ts](server/sse.ts) catches it and sends an
  `error` event. That is how the tab can say "for await threw".

### Step 4: Part B: the commands and one folder per column

```ts
const COMMANDS = {
  writeInside: { command: "echo sandboxed > note.txt && cat note.txt", extra: "" },
  readOutside: { command: "cat ../outside/secret.txt", extra: "" },
  writeOutside: { command: WRITE_OUTSIDE, extra: "" },
  network: { command: 'curl -s -o /dev/null -w "%{http_code}" https://example.com', extra: "" },
  escapeHatch: { command: WRITE_OUTSIDE, extra: " Set dangerouslyDisableSandbox to true on the Bash call." },
};
// …
function dirs(column: number) {
  const root = path.join(LAB, `column-${column}`);
  return { root, project: path.join(root, "project"), outside: path.join(root, "outside") };
}
```

```ts
async function disk(column: number) {
  const { project, outside } = dirs(column);
  return {
    "project/": (await readdir(project)).sort(),
    "outside/": (await readdir(outside)).sort(),
    noteInside: await exists(path.join(project, "note.txt")),
    escapeOutside: await exists(path.join(outside, "escape.txt")),
  };
}
```

- The commands live on the server. The browser sends only an id, so it can never run a command of its own.
- Each column has its own folder, so four runs in parallel do not see each other's files. `reset(column)` deletes it
  and writes `project/readme.txt` and `outside/secret.txt` again.
- `disk()` is the second witness of Step 5 above: it lists both folders after the run.
- `sandboxFor(config, column)` turns the six switches into the `sandbox` object (shown in Step 4 above). When
  `enabled` is off it returns `undefined`, so column 1 has no `sandbox` key at all.

### Step 5: Part B: the `/run` route

```ts
const RunBody = z
  .object({
    column: z.number().int().min(0).max(3), // it becomes a folder name: sandbox-lab/column-N
    commandId: z.enum(["writeInside", "readOutside", "writeOutside", "network", "escapeHatch"]), // a key of COMMANDS
    config: Config,
  })
  .strict();
```

```ts
concept18.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { column, commandId, config } = parsed.data;
  const lab = COMMANDS[commandId];

  await reset(column);
  const sandbox = sandboxFor(config, column);
  const options: Options = { ...BASE, cwd: dirs(column).project, permissionMode: "default", ...(sandbox && { sandbox }) };
  send("options", options);
  // … canUseTool (Step 5 above)
  const prompt = `Run exactly this one Bash command, once, and reply with its raw output only: ${lab.command}${lab.extra}`;
  async function* run() {
    yield* query({ prompt, options: { ...options, abortController: abort, canUseTool, stderr: sandboxStderr(send) } });
    send("disk", await disk(column));
  }
  pipe(run());
});
```

- The body is checked before anything touches the disk, because the column number becomes a folder name. `Config`
  is a strict object of the six booleans, so an unknown switch is refused too.
- `run()` is a small generator: it passes every SDK message on, and after the last one it sends the `disk` event.
- `canUseTool` (Step 5 above) shortens `blockedPath` with `path.relative(dirs(column).root, blockedPath)`. That is
  where `outside\escape.txt` on the card comes from.

### Step 6: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept18 } from "./concepts/18-sandbox.js";
// …
app.use("/api/c18", concept18);
```

### Step 7: The React tab

Both parts use one helper. It keeps every event of one run in a `Run` object:

```tsx
async function startRun(url: string, body: object, update: (fn: (r: Run) => Run) => void) {
  update(() => ({ ...EMPTY, running: true }));
  try {
    await streamPost(url, body, (event, data) => {
      if (event === "options") update((r) => ({ ...r, options: data }));
      if (event === "message") update((r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "stderr") update((r) => ({ ...r, stderr: [...r.stderr, data] }));
      if (event === "ask") update((r) => ({ ...r, asks: [...r.asks, data] }));
      if (event === "disk") update((r) => ({ ...r, disk: data }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}
```

The sandbox line on each card is read from stderr only:

```tsx
function sandboxStatus(run: Run) {
  const asked = run.options?.sandbox?.enabled || run.options?.settings?.sandbox?.enabled;
  if (!asked) return { label: "not requested", cls: "" };
  if (run.stderr.some((l) => /Sandbox disabled/i.test(l))) return { label: "DISABLED (stderr warning): commands run unsandboxed", cls: "bad" };
  if (run.stderr.some((l) => /required but unavailable/i.test(l))) return { label: "unavailable: refused to start", cls: "bad" };
  if (run.running) return { label: "…", cls: "" };
  return { label: "no warning seen on stderr (not proof that it is active)", cls: "" };
}
```

- The last label is careful on purpose: no warning is not proof that the sandbox is active (see Step 3 above).
- Part B starts four runs at once:
  `columns.forEach((config, column) => startRun("/api/c18/run", { column, commandId, config }, …))`.
- `CommandCard` matches each Bash call with its `ask` event by the command text. No `ask` means "not asked".
- `verdict()` adds a sentence to each Part A card, so the fail-closed error card does not look like a broken lab.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 18, title: "Sandbox", Component: Concept18Sandbox },
```

### Step 8: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 18, click **Run the 3 variants in parallel**. On a machine without a sandbox, the first
   card has no `init` message and costs `$0`.
3. In Part B, pick **Write outside cwd** and click **Run the 4 columns in parallel**. Read the "on disk" line of
   each card.
4. Send a bad body, for example `{"variant":"nope"}` to `/availability`: the stream has only an `error` event and
   `done`.
5. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 18

1. Run Part A. Which card has no `init` message? Why is its cost exactly `$0`?
2. In Part B, pick *Read outside cwd* and tick `denyRead` in every column. Does the secret still come back? What does
   the sandbox line of each card say?
3. Untick `sandbox.enabled` in column 2 and compare it with column 1. Is there any difference on this machine?
4. Pick *Escape hatch*. Is `dangerouslyDisableSandbox` in the tool input? Did column 4's
   `allowUnsandboxedCommands: false` change anything here, and why not?
5. On a Mac or on Linux/WSL with `bubblewrap`, run the tab again and fill in the *(docs)* table with what you see.

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**18. Sandbox**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.
Only one sample can run at a time (they all use port 3001). Costs on Haiku: about $0.006 per Part A card (the
fail-closed card is free; a repeat within a few minutes costs about $0.001, because the system prompt and tools come
from the prompt cache, see Concept 15) and about $0.008 per Part B column, so about $0.03 per click of *Run the 4 columns*.

The routes can also be called without the UI:

```powershell
curl.exe http://localhost:3001/api/c18/platform
'{"variant":"option"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c18/availability -H "Content-Type: application/json" -d "@body.json"
'{"column":0,"commandId":"writeOutside","config":{"enabled":true,"autoAllow":true,"allowUnsandboxed":false,"denySecret":false,"allowExample":false,"excludeCurl":false}}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c18/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
