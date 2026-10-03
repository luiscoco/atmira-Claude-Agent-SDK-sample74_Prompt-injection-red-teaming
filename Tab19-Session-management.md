# Session management

This file explains how Concept 19 (**Session management**) was added to the Claude Agent SDK Lab.
Concept 6 ([Tab6-Sessions.md](Tab6-Sessions.md)) used one option, `resume`, to continue a conversation. The SDK has
more options that decide **which** session a `query()` writes to, and a set of functions that read and change
sessions **without** starting Claude Code.

There are two parts:

- **A. Where does the next turn go?** `continue`, `resume`, `forkSession`, `resumeSessionAt`, `sessionId` and
  `persistSession: false`, each compared with the sessions that existed before the run.
- **B. The sessions on disk.** `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `renameSession()`,
  `tagSession()`, `forkSession()` and `deleteSession()`.

| Concept | Topic | Routes |
|---|---|---|
| 19 | `continue`, `resume`, `forkSession`, `resumeSessionAt`, `sessionId`, `persistSession`, `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `renameSession()`, `tagSession()`, `forkSession()`, `deleteSession()` | `/api/c19/turn`, `/sessions`, `/sessions/:id`, `/sessions/:id/rename`, `/tag`, `/fork`, `/delete`, `/reset` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/19-session-management.ts` | **New**: the routes |
| `server/index.ts` | Mounts the router on `/api/c19` |
| `src/concepts/Concept19SessionManagement.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `.gitignore` | Ignores `session-lab/` |
| `Tab1-query().md` | Adds Concept 19 to the table of concepts |
| `Tab19-Session-management.md` | This explanation |

No CSS was added.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

**Options** (on `query()`):

```ts
type Options = {
  continue?: boolean;        // "Continue the most recent conversation in the current directory". Not with resume
  resume?: string;           // "Session ID to resume. Loads the conversation history"
  forkSession?: boolean;     // "resumed sessions will fork to a new session ID rather than continuing". Use with resume
  resumeSessionAt?: string;  // "only resume messages up to and including the message with this UUID". Use with resume
  sessionId?: string;        // "Use a specific session ID ... Cannot be used with continue or resume unless forkSession"
  persistSession?: boolean;  // default true. false: "Sessions will not be saved to ~/.claude/projects/"
};
```

**Functions** (imported from the package like `query`). Each one reads or writes the transcript files directly:

```ts
listSessions({ dir?, limit?, offset? }): Promise<SDKSessionInfo[]>
getSessionInfo(sessionId, { dir? }): Promise<SDKSessionInfo | undefined>
getSessionMessages(sessionId, { dir?, limit?, offset? }): Promise<SessionMessage[]>   // [] if not found
renameSession(sessionId, title, { dir? }): Promise<void>
tagSession(sessionId, tag | null, { dir? }): Promise<void>
forkSession(sessionId, { dir?, upToMessageId?, title? }): Promise<{ sessionId }>
deleteSession(sessionId, { dir? }): Promise<void>                                     // throws if not found

type SDKSessionInfo = { sessionId; summary; lastModified; fileSize?; customTitle?; firstPrompt?; gitBranch?; cwd?; tag?; createdAt? };
type SessionMessage = { type: "user" | "assistant" | "system"; uuid; session_id; message; parent_tool_use_id; ... };
```

`dir` is a project directory, meaning the `cwd` the session ran in. Without `dir`, every project is searched.

## Step 2: Try it before writing the lab

A scratch script called the SDK directly, with the `CLAUDE*` variables removed and no tools. It ran two turns
(*colour is green*, then *fruit is mango*) and then tried each option and function on that session.

| Test | Result |
|---|---|
| `resume: A` | Same id `A`. The turn is added to it |
| `continue: true` | Same id `A`: the most recent session in `cwd` |
| `resume: A, forkSession: true` | A **new** id. It knows both facts. `A` is not changed |
| `resume: A, resumeSessionAt: <uuid of turn 1's answer>` | The **same** id `A`, but `getSessionMessages(A)` now shows turn 1 and the new turn: turn 2 was dropped. The model answered *fruit: unknown* |
| The streamed `assistant.uuid` vs the transcript | The same uuid. `resumeSessionAt` accepts either |
| `persistSession: false`, then `resume` it | Not in `listSessions()`. `resume` → `No conversation found with session ID: …` (no `init`, $0) |
| `sessionId: <uuid>` | `init.session_id` is that uuid |
| `sessionId` + `resume`, no `forkSession` | The process exits: `--session-id can only be used with --continue or --resume if --fork-session is also specified` |
| `sessionId` + `resume` + `forkSession` | Works: the fork gets your id |
| `resume: <an id that does not exist>` | `error_during_execution`, `No conversation found…`, $0 |
| `listSessions({ dir })` | Newest first. A `summary` like *Favourite colour green*: the CLI generated a title, and it is also in `customTitle` |
| `forkSession(A, { upToMessageId })` (function) | New id, **new uuids** for every message, only the messages up to that uuid. Title *… (fork)*. About 15 ms, no process |
| `renameSession`, `tagSession` | `summary` and `customTitle` become the new title; `tag` appears |
| `deleteSession(id)` twice | The second throws `Session … not found in project directory for <dir>` |
| `getSessionMessages(<missing id>)` | `[]`, no throw |
| Where is the file? | `~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<sessionId>.jsonl` |

Two more things came out of it:

- **Haiku's thinking adds entries.** Each turn had an extra `assistant` entry with only a `thinking` block, and
  `resumeSessionAt` at that entry kept the rest of the turn anyway. The lab sets `thinking: { type: "disabled" }`, so
  each turn is exactly one `user` and one `assistant` entry.
- **Long paths break `dir`.** The first run used a folder in the Windows temp directory (an 8.3 `LUIS~1.COC` path).
  The project folder name went over 200 characters, so it was cut short and a hash was added, and
  `getSessionMessages(id, { dir })` returned `[]`. The lab folder is inside the project, so its name is short.

---

# Part A: Where does the next turn go?

## Step 3: One route, seven modes

**File:** [server/concepts/19-session-management.ts](server/concepts/19-session-management.ts)

Every run uses the same base, in its own folder:

```ts
const LAB = path.resolve("session-lab");

const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 1,
  thinking: { type: "disabled" },
  cwd: LAB,
};
```

`cwd: LAB` matters twice: `continue` picks the most recent session **of that folder**, and `listSessions({ dir: LAB })`
lists only the lab's sessions, not your own Claude Code history.

The browser sends a `mode`, and the server turns it into options. The browser never sends option names:

```ts
switch (mode) {
  case "new":
    return {};
  case "continue":
    return { continue: true };
  case "resume":
    return { resume: sessionId };
  case "fork":
    return { resume: sessionId, forkSession: true };
  case "resumeAt":
    return { resume: sessionId, resumeSessionAt: at };
  case "customId":
    return { sessionId: randomUUID() };
  case "ephemeral":
    return { persistSession: false };
}
```

A zod schema checks the body first: `mode` must be one of the seven, and `sessionId` and `at`, when sent, must be
uuids. Then `optionsFor()` checks that `resume`, `fork` and `resumeAt` have a session, and that `resumeAt` also has a
message. Anything else becomes an `error` event before `query()` is called.

## Step 4: The verdict

To say where a turn went, the route lists the sessions **before** the run, reads `init.session_id` during it, and
checks the disk **after** it:

```ts
const before = await labSessions();
// …
for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") written = msg.session_id;
  yield msg;
}
if (!written) return;
const info = await getSessionInfo(written, { dir: LAB });
send("verdict", {
  mode,
  target,
  mostRecent: before[0]?.sessionId,
  sessionId: written,
  isNew: !before.some((s) => s.sessionId === written),
  persisted: Boolean(info),
  turnsBefore,
  turnsAfter: info ? await turnCount(written) : undefined,
});
```

`labSessions()` is `listSessions({ dir: LAB })`. `turnsBefore` counts the turns of the resumed session (`target`) before the run; `turnsAfter` counts the turns of
the session the run wrote to.

The run card shows it in one line, for example `init.session_id 698a0805 → an existing session · the session you
resumed · turns in it: 1 → 2`. The session it wrote to is then selected in Part B.

Run the presets in this order:

| # | Mode | Prompt | What you see |
|---|---|---|---|
| 1 | New session | Remember colour | A new session, 1 turn |
| 2 | `resume` | Remember fruit | Same session, turns 1 → 2 |
| 3 | `resume + forkSession` | Ask both | A new session, 3 turns: *green, mango*. The original still has 2 |
| 4 | `continue` | (any) | It goes to the **fork**, because the fork is now the most recent session |
| 5 | `resumeSessionAt` on turn 1 | Ask both | The **same** id as the original, turns 2 → 2: turn 2 is gone and the new turn replaced it. *green, unknown* |
| 6 | `sessionId` | Say OK | A new session whose id is the one in the options card |
| 7 | `persistSession: false` | Say OK | An answer and an `init.session_id`, but **not written to disk**. It never appears in Part B |

Row 5 is the surprise. `resumeSessionAt` does not make a copy: it rewrites the session you resumed. If you want to
keep the original, add `forkSession: true` too, or fork first with the function (Part B).

> **`continue` needs no id, and that is its risk.** It takes whatever session was modified last in `cwd`. In row 4
> that was the fork, not the session you were "in". Use `resume` with a stored id when it matters which session you
> continue.

---

# Part B: The sessions on disk

## Step 5: List and read

`GET /sessions` returns `listSessions({ dir: LAB })` plus the transcript folder:

```ts
const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects", LAB.replace(/[^a-zA-Z0-9]/g, "-"));
```

`GET /sessions/:id` reads one session. `getSessionMessages()` returns the conversation **chain**: it follows each
entry's parent back from the newest one, so turns dropped by `resumeSessionAt` are not returned (they are still in the
file, which is why the file keeps growing). The route groups the chain into turns:

```ts
for (const m of messages) {
  if (m.type === "user") turns.push({ prompt: textOf(m), promptUuid: m.uuid, answer: "", lastUuid: m.uuid, entries: 1 });
  else if (m.type === "assistant" && turns.length) {
    const turn = turns[turns.length - 1];
    turn.answer += textOf(m);
    turn.lastUuid = m.uuid;
    turn.entries++;
  }
}
```

`lastUuid` is the uuid to pass to `resumeSessionAt` or `upToMessageId` to keep a turn **whole**. The SDK's own
comment on `resumeDropsTurn` says the same: *"fork at the KEPT turn's last chain entry"*.

## Step 6: Change a session

Each button calls one function, with `{ dir: LAB }`:

| Button | Call | Result |
|---|---|---|
| Rename | `renameSession(id, title)` | `summary` and `customTitle` change. A few ms |
| Tag | `tagSession(id, tag)`, or `null` when the box is empty | `tag` appears or is cleared |
| forkSession() — full copy | `forkSession(id)` | A new session *… (fork)*. The fork is selected |
| forkSession() up to here | `forkSession(id, { upToMessageId: turn.lastUuid })` | A copy that ends at that turn, with new uuids |
| Use for resumeSessionAt | (nothing yet) | Picks the turn and switches Part A to `resumeSessionAt` |
| deleteSession() | `deleteSession(id)` | The file is removed. You are asked to confirm first |
| Delete all lab sessions | `deleteSession()` for each listed session | An empty lab, to start again |

None of them starts Claude Code or calls the model, so they cost nothing.

**The function and the option both fork, in different ways.** `forkSession()` copies the file now, with no turn, and
you `resume` the copy later. `forkSession: true` forks as part of a `query()` that runs a turn. Both leave the
original alone. The JSDoc of `forkSession()` adds that its copy starts **without** file checkpoints (Concept 17):
*"file-history snapshots are not copied"*, so `rewindFiles()` has nothing to rewind there. This was not tried here.

**Only lab sessions can be changed.** Before calling a function, the server checks that the id is a uuid **and** that
`listSessions({ dir: LAB })` lists it. Without `dir`, `deleteSession()` searches every project, so a uuid from your own
Claude Code history would be deleted too.

---

## What to take away

1. **A session is a file**: `~/.claude/projects/<cwd>/<sessionId>.jsonl`. The `cwd` decides the folder.
2. **`resume` continues, `forkSession` copies, `resumeSessionAt` cuts.** Only the fork gets a new id. A cut keeps the
   id and drops the later turns from the chain.
3. **`continue: true` is "the latest session in cwd"**, whatever that is. Prefer `resume` with a stored id.
4. **`sessionId` lets you choose the id.** With `resume` or `continue` it needs `forkSession`.
5. **`persistSession: false` writes nothing.** You still get a `session_id`, but it cannot be resumed.
6. **The session functions work on the files directly.** No process, no model, no cost. Always pass `dir`.
7. **Keep turns whole.** Give `resumeSessionAt` / `upToMessageId` the **last** uuid of the turn you want to keep.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/19-session-management.ts](server/concepts/19-session-management.ts) and
[src/concepts/Concept19SessionManagement.tsx](src/concepts/Concept19SessionManagement.tsx).

### Step 1: Read the types, then probe

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `resumeSessionAt`, `forkSession`,
`persistSession`, `listSessions`, `getSessionMessages` and `SDKSessionInfo` (see Step 1 above). The scratch script of
Step 2 above decided two details of the lab: thinking is turned off, and the lab folder is inside the project, so its
path stays short.

### Step 2: The folder, the modes, and the schemas

`LAB`, `TRANSCRIPTS` and `BASE` are shown in Steps 3 and 5 above. The folder is created when the server starts, and
the list of modes is the only thing the browser can choose from:

```ts
const LAB = path.resolve("session-lab");
mkdirSync(LAB, { recursive: true });
// …
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["new", "continue", "resume", "fork", "resumeAt", "customId", "ephemeral"] as const;
type Mode = (typeof MODES)[number];
const Uuid = z.string().regex(UUID, "must be a uuid");
const ShortText = z.string().trim().max(80); // titles and tags
```

- `mkdirSync` runs at import time. So `listSessions({ dir: LAB })` works even before the first run.
- `Uuid` and `ShortText` are the zod pieces every body schema below is built from. `badRequest()` turns the zod
  issues into one line, such as `Bad request: mode: Invalid option: expected one of "new"|…`.
- `optionsFor(mode, sessionId, at)` (the `switch` in Step 3 above) starts with two checks: `resume`, `fork` and
  `resumeAt` need a session uuid, and `resumeAt` also needs a message uuid. It throws a message the tab can show.

### Step 3: Two small helpers for the transcript

```ts
function textOf(m: SessionMessage): string {
  const content = (m.message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
  return "";
}
```

```ts
const labSessions = () => listSessions({ dir: LAB });
const turnCount = async (id: string) => turnsOf(await getSessionMessages(id, { dir: LAB })).length;
```

- `textOf()` reads the text of one transcript entry. A user prompt is a string; an answer is an array of blocks.
- `turnsOf()` groups the entries into turns (Step 5 above). It skips an `assistant` entry that comes before any user
  entry (the `turns.length` check), and counts the `entries` of each turn.
- `labSessions()` and `turnCount()` always pass `{ dir: LAB }`. Every call in this file does.

### Step 4: Part A: the `/turn` route

```ts
// sessionId: the session selected in Part B (if any); at: the last uuid of the picked turn (if any).
const TurnBody = z
  .object({ prompt: z.string().trim().min(1).max(4000), mode: z.enum(MODES), sessionId: Uuid.optional(), at: Uuid.optional() })
  .strict();

concept19.post("/turn", async (req, res) => {
  const parsed = TurnBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt, mode, sessionId, at } = parsed.data;

  let extra: Options;
  try {
    extra = optionsFor(mode, sessionId, at);
  } catch (err) {
    send("error", { message: String(err) });
    send("done", {});
    return res.end();
  }

  // What existed before the run: to tell "new session" from "existing session", and what continue would pick.
  const before = await labSessions();
  const target = extra.resume;
  const turnsBefore = target ? await turnCount(target) : undefined;

  send("options", { ...BASE, ...extra });
  send("before", { mostRecent: before[0]?.sessionId, count: before.length, turnsBefore });
```

- All the checks happen before `query()`. First the schema (the shape of the body), then `optionsFor()` (what the
  mode needs). A bad body costs nothing: an `error` event, a `done` event, and the stream ends.
- `sessionId` and `at` are optional, because the tab sends them only when a session or a turn is selected.
- `before[0]` is the newest session, the one `continue` should pick. It is sent now and again in the verdict.
- The rest of the route is the generator `run()` of Step 4 above. It reads `init.session_id`, passes every message
  on, and sends `verdict` at the end. When there is no `init` (for example `No conversation found`), no verdict is
  sent.

### Step 5: Part B: one guard for every session route

```ts
async function labSession(req: Request) {
  const id = req.params.id;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Not a session id.");
  if (!(await labSessions()).some((s) => s.sessionId === id)) throw new Error("That session is not in session-lab/.");
  return id;
}

/** Wraps a Part B route: checks the body (400) and the id, runs the SDK call, reports errors as 409. */
function manage<S extends z.ZodType>(Body: S, action: (id: string, body: z.infer<S>) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: badRequest(parsed.error) });
    try {
      const id = await labSession(req);
      const startedAt = Date.now();
      const result = await action(id, parsed.data);
      res.json({ ok: true, ms: Date.now() - startedAt, result });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  };
}
```

- Two checks, written once. The body must fit the route's schema (`400` if not). Then the id must be a uuid **and**
  be listed for `session-lab/` (`409` if not): the "only lab sessions can be changed" rule of Step 6 above.
- Each route is then one short line with its schema. For example the fork route:

```ts
const ForkBody = z.object({ upToMessageId: Uuid.optional(), title: ShortText.min(1).optional() }).strict();
concept19.post(
  "/sessions/:id/fork",
  manage(ForkBody, (id, { upToMessageId, title }) => forkSession(id, { dir: LAB, upToMessageId, ...(title && { title }) })),
);
```

- Rename takes `{ title }` (1 to 80 characters) and tag takes `{ tag }` (at most 80). An empty tag becomes `null`,
  which clears it.
- `GET /sessions/:id` and `POST /sessions/:id/delete` read no body. Their schema is `NoBody`,
  `z.object({}).strict()`, so an unexpected key is refused. `GET /sessions/:id` returns `info`, `turns`, the file
  path and the raw chain.
- `POST /reset` reads no body either. It deletes every session that `labSessions()` lists.

### Step 6: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept19 } from "./concepts/19-session-management.js";
// …
app.use("/api/c19", concept19);
```

### Step 7: The React tab

The top component keeps the list, the selected session and the picked turn, and passes them to both parts.
Part A sends one turn:

```tsx
await streamPost("/api/c19/turn", { prompt, mode, sessionId: selected, at: at?.lastUuid }, (event, data) => {
  if (event === "options") update({ options: data });
  if (event === "before") update({ before: data });
  if (event === "message") update({ messages: [...entry.messages, data] });
  if (event === "verdict") {
    update({ verdict: data });
    if (data.persisted) written = data.sessionId;
  }
  if (event === "error") update({ error: data.message });
});
```

Part B calls one function through `manage()`, and then lists the sessions again:

```tsx
async function manage(call: string, url: string, body?: object, select?: (result: any) => string | undefined) {
  try {
    const res = await post(url, body);
    setCalls((prev) => [{ call, ms: res.ms, result: res.result }, ...prev]);
    await refresh(select ? select(res.result) : selected);
  } catch (err) {
    setCalls((prev) => [{ call, error: String(err).replace(/^Error: /, "") }, ...prev]);
  }
}
```

- `at` is the picked turn. The tab sends its `lastUuid`, so `resumeSessionAt` keeps the whole turn (Step 5 above).
- After a run, `onWritten(written)` calls `refresh()` with the session the turn went to, so Part B selects it.
- The fork buttons pass `(r) => r.sessionId` as `select`, so the new fork is selected at once.
- `refresh()` selects the newest session when nothing is selected. `Verdict` turns the `verdict` event into the one
  line of Step 4 above.
- When an option needs a session and none is selected, the **Send** button is disabled and a "Not ready" card says
  why.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 19, title: "Session management", Component: Concept19SessionManagement },
```

### Step 8: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 19. Pick **(no session option)**, click **Remember colour**, then **Send with New
   session**. The session appears in Part B.
3. Pick `resume: id`, send **Remember fruit**: the verdict says `turns in it: 1 → 2`.
4. In Part B, click **forkSession() — full copy**: the fork is selected, and the call line shows the time in ms.
5. Send a bad body, for example `{"mode":"fly","prompt":"hi"}` to `/turn`: the stream has only an `error` event
   and `done`.
6. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 19

1. After row 3, select the **original** session and send *Ask both* with plain `resume`. What does it know, and what
   does the fork know?
2. Use `resumeSessionAt` on turn 1, then open *getSessionInfo() and the raw chain*. Did `fileSize` go down?
3. Run `continue` twice in a row, then fork, then `continue` again. Which session does each one go to?
4. `forkSession() up to here` on turn 1, then `resume` the copy with *Ask both*. Compare it with row 5: same answer,
   but which one kept the original?
5. Rename a session, then fork it with the function. What is the fork's title?

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite page and select **19. Session management**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. Only one sample can run at a time
(they all use port 3001). Start it from a normal terminal, not from inside Claude Code (see Tab16). Costs on Haiku:
about $0.0003 to $0.002 per turn in Part A. Part B makes no model call.

The routes can also be called without the UI:

```powershell
'{"mode":"new","prompt":"Remember: my favourite colour is green. Reply with one word: OK."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c19/turn -H "Content-Type: application/json" -d "@body.json"
# copy "sessionId" from the "verdict" event, then:
curl.exe http://localhost:3001/api/c19/sessions
curl.exe http://localhost:3001/api/c19/sessions/<sessionId>
curl.exe -X POST http://localhost:3001/api/c19/sessions/<sessionId>/fork -H "Content-Type: application/json" -d "{}"
Remove-Item body.json
```
