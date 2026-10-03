# Session stores

This file explains Concept 35 (**session stores**) of the Claude Agent SDK Lab. Concepts 6 and 19 resumed, listed,
renamed and forked sessions. All of that works on **one file on one machine**:
`CLAUDE_CONFIG_DIR/projects/<project key>/<session id>.jsonl`. When your app runs on several servers, in containers
that come and go, or in a serverless function, the next request may land on a machine that has never seen that file.
A **session store** fixes that. You give `query()` an adapter to your own storage (a database, S3, Redis…). The SDK
sends it a copy of every transcript line, and can **resume the session from it on any machine**.

**Goal:** write a `SessionStore` adapter, see when the SDK calls each method, resume a session on a second machine,
use the session functions on the store, and know how a store fails, and what the host must check for itself.

| Concept | Topic | Routes |
|---|---|---|
| 35 | Session stores: `sessionStore` (`append`, `load`, `listSessions`, `listSessionSummaries`, `delete`, `listSubkeys`), `SessionKey` (`projectKey`, `sessionId`, `subpath`), `SessionStoreEntry` and dedup by `uuid`, `sessionStoreFlush` (`batched` / `eager`), resume on another machine (the temporary `claude-resume-*` config dir), `continue` with a store, subagent transcripts, a tenant key (`CLAUDE_CODE_PROJECT_DIR_NAME`), the session functions with `{ sessionStore }`, `foldSessionSummary`, `importSessionToStore`, `InMemorySessionStore`, failures (`system/mirror_error`, `loadTimeoutMs`, `persistSession: false`, `enableFileCheckpointing`), a host-side check | `/api/c35/db`, `/entries`, `/reset`, `/run` (SSE), `/manage`, `/failures` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/35-session-stores.ts` | **New**: the `FileSessionStore` adapter, a spy that reports every store call, the two machines, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c35` |
| `src/concepts/Concept35SessionStores.tsx` | **New**: the tab: the machines and the store, Parts A to F |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The store panel, the store-call rows |
| `.gitignore` | Ignores `store-lab/` |
| `Tab1-query().md` | Adds Concept 35 to the table |

---

## Step 1: The problem

Run a session on machine A, then try to resume it on machine B:

```ts
// machine A
const options = { cwd: "/app", env: { ...env, CLAUDE_CONFIG_DIR: "/var/a" } };
for await (const m of query({ prompt: "My name is Ada.", options })) …   // session 9115c304…

// machine B, same cwd, its own CLAUDE_CONFIG_DIR
query({ prompt: "What is my name?", options: { ...options, env: { ...env, CLAUDE_CONFIG_DIR: "/var/b" }, resume: "9115c304-…" } });
// → throws: Claude Code returned an error result: No conversation found with session ID: 9115c304-…
```

The lab has these two machines: `store-lab/machine-a` and `store-lab/machine-b` are two `CLAUDE_CONFIG_DIR`s with the
same `cwd` (`store-lab/work`). Scenario **6** is this failure.

## Step 2: A store is six methods

```ts
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

const store: SessionStore = {
  append(key, entries) { … },        // required: keep a batch of transcript lines
  load(key) { … },                   // required: all the lines of a key, or null
  listSessions(projectKey) { … },    // optional: [{ sessionId, mtime }] (for continue and listSessions())
  listSessionSummaries(projectKey),  // optional: faster listSessions()
  delete(key) { … },                 // optional: for deleteSession()
  listSubkeys(key) { … },            // optional: the subagent transcripts of a session
};

query({ prompt, options: { ...options, sessionStore: store } });
```

| Type | Shape |
|---|---|
| `SessionKey` | `{ projectKey, sessionId, subpath? }`. `projectKey` is the `cwd` with every non-alphanumeric character as `-` (the name of the local folder under `projects/`). `subpath` is `subagents/agent-<id>` for a subagent's transcript |
| `SessionStoreEntry` | `{ type, uuid?, timestamp?, …}`: one line of the JSONL file. Opaque: store it and give it back **deep-equal** (a JSONB column may reorder its keys) |

The lab's store is `FileSessionStore` (**code: adapter**): one JSONL file per key under `store-lab/db/`, and one
`.summary.json` file per session. In a real app you would replace its file calls with calls to your database; the
contract stays the same. The SDK also has an `InMemorySessionStore` (for tests; everything is lost when the process
exits).

A **spy** wraps the store (**code: spy**). It reports every call to the browser, with its key, its lines and how long
it took. It can also break the store (Part D).

## Step 3: Mirroring: when `append()` is called

Scenario **1** runs one turn on machine A with the store:

```text
0.8 s  system/init
1.6 s  assistant  "OK"
1.6 s  store.append  9115c304  12 lines  queue-operation×2, user, attachment×7, atis-latch, assistant
1.6 s  result/success
1.6 s  host check: 9 of 9 messages with a uuid are in the store
2.7 s  store.append  9115c304  3 lines   last-prompt, cost-state, ai-title
```

- Claude Code **still writes the local file**. Look at machine A in the panel. The SDK receives each new line from
  Claude Code and passes a **copy** to `append()`, after the local write succeeded. The store is a mirror, not a
  replacement.
- **`batched`** (the default) sends the turn's lines in one call, **just before** the `result` message reaches your
  loop, so when you see `result`, the store already has the turn. A last small batch comes when the session closes. The SDK
  also flushes when 500 lines or 1 MiB are pending.
- **`sessionStoreFlush: 'eager'`** (scenario **2**) sends each group of lines as soon as it is written: here 5 calls
  instead of 2, and the first one before the model has answered. More calls, less to lose if the process dies
  in the middle of a turn.
- Most lines have a `uuid` (user, assistant, attachment). Some do not (queue-operation, ai-title, custom-title, tag,
  last-prompt, cost-state, mode). The SDK says: **use `uuid` as an idempotency key** (a retried batch must not add
  rows twice), and append the lines without a `uuid` as they come.

```ts
async append(key, entries) {
  const seen = new Set(this.read(file).map((e) => e.uuid).filter(Boolean));
  const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
  appendFileSync(file, fresh.map((e) => JSON.stringify(e) + "\n").join(""));
  …
}
```

## Step 4: Resume on another machine

Scenario **5** resumes the selected session on machine B, with the store:

```text
0.0 s  store.load         9115c304 → 15 lines
0.0 s  store.listSubkeys  9115c304 → []
1.7 s  system/init        session_id 9115c304-…            (the same id)
1.7 s  temporary CLAUDE_CONFIG_DIR  %TEMP%/claude-resume-a50d9db7-…/projects/<key>/9115c304-….jsonl
2.5 s  assistant          "Your name is Ada, and the secret word is 'tangerine'."
2.5 s  store.append       9115c304  5 lines
       after the session: machine B's CLAUDE_CONFIG_DIR/projects: nothing
```

This is how the SDK does it (read from its code and confirmed by the probes):

1. `load()` and `listSubkeys()` are called **in your process, before Claude Code starts**.
2. The SDK writes the lines to a **temporary** config folder, `%TEMP%/claude-resume-<uuid>/`. It also copies the
   machine's config files there (`.claude.json`, `settings.json`, the credentials file if there is one).
3. It starts Claude Code with `CLAUDE_CONFIG_DIR` pointing there. Claude Code resumes from that file with its usual
   code, and the new turn is mirrored to the **same key** in the store.
4. When the session ends, the temporary folder is deleted. Machine B's own `CLAUDE_CONFIG_DIR` is never written: **the
   store is the only lasting copy** of what happened on B.

**Scenario 7**, `continue: true` with a store: the SDK calls `store.listSessions(projectKey)`, takes the newest `mtime`,
and resumes that one. Without a `listSessions()` method it is refused (Part D).

**Subagents** (scenario **3**): a subagent's transcript is its own key, `subpath: "subagents/agent-<id>"`, with its own
`append()` calls. On resume, `listSubkeys()` finds it and `load()` is called for it too. (Haiku often starts the agent in
the background; then a second turn starts by itself when the agent returns, as in Concept 27.)

## Step 5: The project key, and a tenant key

The default `projectKey` is the cwd's name (`C--…-sample35-store-lab-work`). If you set
`CLAUDE_CODE_PROJECT_DIR_NAME` in `options.env` (1 to 64 letters, digits, `-` or `_`), it is used instead. Use it
as a tenant id when one store serves many customers (scenario **4**, `tenant-acme`).

The catch: the session functions only take `{ dir }`, and compute the key from the directory. So
`listSessions({ dir, sessionStore })` looks under the cwd's key and **does not see** the tenant's sessions. The host
must ask the store itself (`store.listSessions("tenant-acme")`). Resuming works if you pass the same env again.

## Step 6: The session functions, on the store

Every function of Concept 19 takes `{ dir, sessionStore }`. With the store, they read with `load()` and write with
`append()`. There is no local file and no Claude Code process (**code: manage**):

| Function | Store calls (seen in Part C) |
|---|---|
| `listSessions({ dir, sessionStore })` | `listSessionSummaries()` + `listSessions()` |
| `getSessionInfo(id, …)`, `getSessionMessages(id, …)` | `load()` |
| `renameSession(id, title, …)` / `tagSession(id, tag, …)` | `append()` of one `custom-title` / `tag` line |
| `forkSession(id, …)` | `load()`, then `append()` of a copy under a new id, with new uuids |
| `deleteSession(id, …)` | `delete()`; a no-op if the store has none (for append-only storage) |
| `listSubagents(id, …)` | `listSubkeys()` |

**Summaries.** `listSessions()` needs a title, the first prompt, a tag… for each session. Without
`listSessionSummaries()` it would `load()` every transcript. With it, the store keeps one small sidecar per session and
updates it in `append()` with the SDK's pure function `foldSessionSummary(prev, key, entries, { mtime })`. The `data`
blob belongs to the SDK: keep it as it is. `mtime` must come from the same clock as `listSessions()`, which is the file's
mtime in the lab.

**Migrating.** `importSessionToStore(id, store, { dir })` copies a local session (with its subagents) into a store, in
batches of 500 lines. Scenario **8** runs a session on machine A **without** the store, imports it, and you can resume
it on B with 5. Two things to know:

- It reads the local file from **this process's** `CLAUDE_CONFIG_DIR`; there is no `env` option. The lab points
  `process.env` at machine A just for that call, one call at a time (**code: import**).
- Importing twice is safe for the messages (dedup by `uuid`). The lines without a `uuid` are added again, as the
  contract says: 15 lines became 21 in the tests. A resume still works.

## Step 7: When the store fails (Part D, button 9)

Six cases, in parallel, each with its own store:

| Case | What the host sees |
|---|---|
| `append()` rejects | 3 attempts per batch (backoff 200 ms, 800 ms), then the batch is **dropped** and a `system/mirror_error` message comes (`error`, `key`). The turn goes on: `result: success`. The host check shows 9 of 9 messages missing. After `importSessionToStore()`, they are all there |
| `load()` is slow (`loadTimeoutMs: 1000`) | `query()` throws `SessionStore.load() timed out after 1000ms`. Your `load()` goes on for 3 s: **the SDK cannot cancel it** |
| A session the store does not have | `load()` returns `null`, Claude Code starts and says `No conversation found` (no API call) |
| `persistSession: false` | Refused before start: the mirror needs the local write ("use `CLAUDE_CONFIG_DIR=/tmp` for ephemeral local writes") |
| `enableFileCheckpointing: true` | Refused: file backups are not mirrored, so `rewindFiles()` would fail after a store-backed resume |
| `continue: true`, no `listSessions()` | Refused: `Options.continue with sessionStore requires store.listSessions to be implemented` |

An `append()` that takes longer than 60 s is not retried either (the call may still land), so a slow database can also
lose a batch.

## Step 8: The host check

`mirror_error` tells you that a batch was lost, and that the local file is still complete (for now). The lab's
`mirrorCheck()` (**code: check**) runs at each `result`, when the batched lines are already in the store. It compares
the `uuid`s of the local file (on a resume, the temporary one) with the store:

```text
host check  store-lab/machine-a/projects/<key>/9115c304….jsonl: 12 lines, 9 with a uuid · store: 12 lines · every message is in the store
host check  …: 13 lines, 9 with a uuid · store: 0 lines · 9 missing (user, attachment×7, assistant)
```

When messages are missing: re-import from the local file **before that machine goes away**, or mark the session as
not resumable elsewhere.

## What to take away

- `sessionStore` **mirrors**: Claude Code still writes the local file, and the SDK copies each batch to `append()`.
- A store-backed **resume works on any machine**: `load()` runs in your process, and Claude Code resumes from a
  temporary config folder that is deleted afterwards.
- Dedup by `uuid`; store lines as opaque JSON; add `listSessions` for `continue`, `listSubkeys` for subagents, and
  `listSessionSummaries` + `foldSessionSummary` for fast listings.
- The key is the cwd's name unless you set `CLAUDE_CODE_PROJECT_DIR_NAME`, and then the `{ dir }` functions do not
  find the session.
- Failures are quiet: a failed `append()` is only a `mirror_error` message. Check what reached the store.

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/35-session-stores.ts](server/concepts/35-session-stores.ts) and
[src/concepts/Concept35SessionStores.tsx](src/concepts/Concept35SessionStores.tsx). The tab's **code** buttons show
the same regions.

### Step 1: Read the types, then probe

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `SessionStore`, `SessionKey`,
`SessionStoreEntry`, `sessionStoreFlush`, `loadTimeoutMs`, `foldSessionSummary`, `importSessionToStore` and
`mirror_error`. The types do not say **when** each method is called, so a small script first ran real sessions with
the SDK's `InMemorySessionStore`, wrapped in a logger, and two different `CLAUDE_CONFIG_DIR`s. Everything the tab
shows was seen there first: 2 `append()` calls per turn, `load()` before Claude Code starts, the `claude-resume-*`
folder, the 3 attempts before `mirror_error`.

### Step 2: The folders: two machines, one store

```ts
const LAB = path.resolve("store-lab");
const DB = path.join(LAB, "db"); // the lab's "database": one JSONL file per key
const FAIL = path.join(LAB, "fail"); // one small store per failure row
const WORK = path.join(LAB, "work"); // the cwd, the same on both machines, so the project key is the same
const MACHINE = { a: path.join(LAB, "machine-a"), b: path.join(LAB, "machine-b") } as const; // two CLAUDE_CONFIG_DIRs
```

- A "machine" is only a `CLAUDE_CONFIG_DIR`: that is where Claude Code writes its local transcripts. Two folders are
  enough to show that machine B cannot see machine A's sessions.
- Both machines use the same `cwd`, so both compute the same `projectKey`, and B can find A's session in the store.
- `resetLab()` deletes and recreates these folders when the server starts and when you click "empty the store".

### Step 3: Write the adapter (`FileSessionStore`)

A class that implements `SessionStore` on plain files. The important method is `append()`:

```ts
async append(key: SessionKey, entries: SessionStoreEntry[]) {
  const file = this.file(key);
  mkdirSync(path.dirname(file), { recursive: true });
  // uuid is the idempotency key: a retried batch or a second importSessionToStore() adds nothing twice.
  // Lines without a uuid (titles, tags, cost-state…) are appended as they come.
  const seen = new Set(this.read(file).map((e) => e.uuid).filter(Boolean));
  const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
  appendFileSync(file, fresh.map((e) => JSON.stringify(e) + "\n").join(""));
  if (!key.subpath) {
    const side = file.replace(/\.jsonl$/, ".summary.json");
    const prev: SessionSummaryEntry | undefined = existsSync(side) ? JSON.parse(readFileSync(side, "utf8")) : undefined;
    writeFileSync(side, JSON.stringify(foldSessionSummary(prev, key, fresh, { mtime: Math.floor(statSync(file).mtimeMs) })));
  }
}
```

- `this.file(key)` turns the key into a path: `<projectKey>/<sessionId>.jsonl`, or
  `<projectKey>/<sessionId>/<subpath>.jsonl` for a subagent. It refuses any part with `..` or odd characters, so a
  key can never leave the store's folder.
- **Dedup by `uuid`**: the SDK retries a failed batch, and `importSessionToStore()` may copy lines that are already
  there. Lines without a `uuid` are appended, as the contract asks.
- **The summary sidecar**: `foldSessionSummary()` (from the SDK) computes it. The store only saves it. Later,
  `listSessionSummaries()` reads these small files instead of loading every transcript.
- The other methods are short: `load()` reads the file (or returns `null` when it does not exist),
  `listSessions()` lists the `.jsonl` files with their mtime, `delete()` removes the file, its sidecar and its
  subagents, and `listSubkeys()` lists the subagent files as `subagents/agent-<id>`.

### Step 4: Wrap it in a spy

To show **when** the SDK calls the store, every method goes through `call()`. It times the call and reports it:

```ts
async function call<T>(method: string, info: Omit<StoreCall, "method" | "ms">, fn: () => Promise<T>, summarize: (r: T) => unknown = () => undefined) {
  const t = Date.now();
  try {
    const r = await fn();
    emit({ method, ...info, result: summarize(r), ms: Date.now() - t });
    return r;
  } catch (err) {
    emit({ method, ...info, error: String((err as Error)?.message ?? err), ms: Date.now() - t });
    throw err;
  }
}
const s: SessionStore = {
  append: (key, entries) =>
    call("append", { key, count: entries.length, types: typeCounts(entries) }, async () => {
      if (fault.appendRejects) throw new Error("the database is down");
      return inner.append(key, entries);
    }),
  // … load, listSessionSummaries, delete, listSubkeys: the same pattern
};
if (!fault.noListSessions) s.listSessions = (pk) => call("listSessions", { key: { projectKey: pk } }, () => inner.listSessions(pk), (r) => r.map((x) => x.sessionId.slice(0, 8)));
```

- `emit` sends a `store` SSE event to the browser. That is where the green `store.append` rows of the timeline
  come from.
- The spy can also **break** the store (`fault`): `append` rejects, `load` is slow, or `listSessions` is missing.
  Part D uses these to show each failure without a real broken database.
- The error is re-thrown, so the SDK sees the failure exactly as it would with a real store.

### Step 5: Build the options for one machine

```ts
function baseOptions(s: Setup, abort: AbortController): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = MACHINE[s.machine]; // "which machine": where Claude Code writes its local transcript
  if (s.tenant) env.CLAUDE_CODE_PROJECT_DIR_NAME = s.tenant; // the projectKey, instead of the cwd's name
  return {
    model: MODEL,
    cwd: WORK,
    ...(s.store && { sessionStore: s.store }), // mirror every transcript line to the store
    ...(s.store && s.flush && { sessionStoreFlush: s.flush }), // "batched" (default) or "eager"
    ...(s.resume && { resume: s.resume }), // with a store: load() it first, from any machine
    ...(s.continue && { continue: true }), // with a store: the newest session of store.listSessions()
    // … tools, settingSources: [], thinking disabled, maxTurns, abortController, env
  };
}
```

- Each scenario is only a different `Setup`: which machine, with or without the store, `resume` or `continue`, a
  subagent or a tenant key. Every run goes through the same function.
- `thinking: { type: "disabled" }` and `tools: []` keep the transcript short, so its lines are easy to read in the
  store panel.

### Step 6: Run the query, and see what the SDK did

`collect()` runs one `query()` to the end and sends a short `msg` event for each message. Two parts are specific to
this concept. On a resume, at `system/init`, it looks for the temporary folder the SDK created:

```ts
if (options.sessionStore && (options.resume || options.continue)) {
  // The SDK loaded the session from the store and started Claude Code in a claude-resume-* folder.
  const found = readdirSync(TMP)
    .filter((d) => d.startsWith("claude-resume-") && statSync(path.join(TMP, d)).mtimeMs >= startedAt - 1000)
    .map((d) => path.join(TMP, d))
    .find((d) => files(d).some((f) => f.endsWith(`${m.session_id}.jsonl`)));
```

At the `result`, it runs the host check (Step 8 of the concept): the SDK flushes the turn's batch **before** it
passes the result on, so this is the moment when the store must be complete:

```ts
} else if (m.type === "result") {
  // …
  const key = keyOf();
  if (store && key && o.sessionId) {
    const local = path.join(tempDir ?? String(options.env?.CLAUDE_CONFIG_DIR), "projects", key.projectKey, `${o.sessionId}.jsonl`);
    o.check = mirrorCheck(local, store, { ...key, sessionId: o.sessionId });
    send("check", o.check);
  }
}
```

`mirrorCheck()` reads the local file (or the temporary one on a resume) and the stored file, and counts the `uuid`s
of the local file that are missing from the store.

### Step 7: The routes

`POST /run` is the route behind scenarios 1 to 8. It checks the body with zod, builds the spy and the options, and
streams everything as SSE:

```ts
const RunBody = z
  .object({
    machine: z.enum(["a", "b"]),
    prompt: z.string().trim().min(1).max(2000),
    store: z.boolean(),
    flush: z.enum(["batched", "eager"]).optional(),
    resume: SessionId.optional(),
    continue: z.boolean().optional(),
    subagent: z.boolean().optional(),
    tenant: Tenant.optional(),
  })
  .strict()
  .refine((b) => !(b.resume && b.continue), { message: "resume or continue, not both" })
  .refine((b) => b.store || !b.flush, { message: "flush needs the store" });
```

- The browser never sends a path: only a machine letter, a session id (a uuid) and a tenant name that follows
  Claude Code's own rule (`^[A-Za-z0-9_-]{1,64}$`).
- The route ends with a `done` event that carries a fresh `snapshot()` of the store and both machines, so the panel
  refreshes after every run.

The other routes: `GET /db` (the snapshot), `GET /entries` (the lines of one key), `POST /reset`, `POST /manage`
(the session functions of Part C, through the spy), `POST /failures` (the six rows of Part D, in parallel, each with
its own store in `store-lab/fail/<row>`) and `GET /code` (the `#region` blocks of this file).

`importSessionToStore()` has no `env` option: it reads the local file from **this process's** `CLAUDE_CONFIG_DIR`.
`withConfigDir()` sets it to machine A's folder for the length of one call, one call at a time, and then restores it.

### Step 8: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept35 } from "./concepts/35-session-stores.js";
// …
app.use("/api/c35", concept35); // its store is a folder of JSONL files (store-lab/db); two fake machines share it
```

### Step 9: The React tab

The tab keeps the snapshot of the store (`db`) and the session selected in it. Every scenario button calls `run()`
with a different body. It streams the SSE events into the timeline and refreshes the panel at `done`:

```tsx
async function run(label: string, body: any, h: string) {
  // … reset the timeline and the options
  await streamPost("/api/c35/run", body, (event, data) => {
    if (event === "opened") return setOptions(data);
    if (event === "done") return data.db && setDb(data.db);
    if (event === "outcome") (sid = data.sessionId), setCost((c) => c + (data.cost ?? 0));
    if (event === "error") setError(data.message);
    got.push({ event, data });
    setEvents([...got]);
  });
  return sid;
}
```

- Scenario 5 is `run("r5", { machine: "b", store: true, resume: selected, prompt: resumePrompt, ...tenantOf(picked) }, …)`:
  when the selected session is kept under a tenant key, the resume sends that key again.
- `Timeline` draws one row per event: `store` (green), `msg`, `materialized` (the temporary folder), `check`,
  `tenant` and `outcome`.
- On first load, the tab retries `/db` and `/code` for about 15 s, because `npm run dev` starts Vite before the
  server is listening.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 35, title: "Session stores", Component: Concept35SessionStores },
```

### Step 10: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 35, run **1**: the store panel shows the session, and the timeline ends with "every
   message is in the store".
3. Run **5** (machine B remembers), then **6** (`No conversation found`), then **9** (six rows).
4. The same routes from a terminal: see "Running the app" below.

## Things to try in Concept 35

1. Run 1, then 2: count the `store.append` rows. Open "N lines" in the store to read the stored JSON.
2. Run 5 on the first session, then 6. Look at machine B in the panel after each one.
3. Run 3, then select that session and run 5: see `load()` called twice (the main transcript and the subagent).
4. Run 4, select the `tenant-acme` session, and run 5, then `listSessions()`.
5. Run `renameSession()` and `tagSession()`, then `listSessions()` and `getSessionInfo()`.
6. Run 8, then 8 again with the same prompt, and compare the line counts.
7. Run 9 and read the `append() rejects` row: the turn succeeded, and the store had nothing.

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **35. Session stores** tab. `ANTHROPIC_API_KEY` must be in `.env`. Start the app from a normal terminal, not
from inside Claude Code (see Tab16). With Haiku 4.5 a scenario costs about $0.001 (3, with a subagent, about $0.02).
Part C costs nothing, except 8.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -N -X POST http://localhost:3001/api/c35/run -H "Content-Type: application/json" -d '{\"machine\":\"a\",\"store\":true,\"prompt\":\"My name is Ada. Reply only OK.\"}'
# copy "sessionId" from the "outcome" event, then:
curl.exe -N -X POST http://localhost:3001/api/c35/run -H "Content-Type: application/json" -d '{\"machine\":\"b\",\"store\":true,\"resume\":\"<id>\",\"prompt\":\"What is my name?\"}'
```
