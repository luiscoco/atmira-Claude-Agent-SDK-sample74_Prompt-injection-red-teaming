# Durable, long-running agents

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Production & deployment → 60. Durable, long-running agents**, or go to `?lesson=60`. Sample60 uses backend port **3060**. Vite uses **5173**, or the next free port.

## What you will learn

A long agent job will be interrupted. A deploy restarts the server, a container is recreated, a segment hits `maxTurns`, or the API returns a 529. Lesson 6 resumed sessions, lesson 28 retried errors, lesson 35 mirrored transcripts to a store and lesson 40 resumed after an interrupted turn. This lesson combines them into one rule: **make the job durable, not the process.**

Four pieces do it:

| Piece | What it guarantees | Where |
|---|---|---|
| Journal | Progress lives in your own file, written atomically (temp file + rename), outside the model and the transcript | `JournalFiles` |
| Idempotency keys | Every side effect carries a key built from stable ids (`settle:<job>:<refund>`), and the ledger refuses a key it has already applied | `Ledger`, `effectKey()` |
| Lease + heartbeat | At most one live worker per job. The heartbeat renews the lease every 5 s; a dead worker's lease expires after 15 s | `acquireLease()`, `releaseLease()` |
| Supervisor | Runs `query()` in segments bounded by `maxTurns` and `maxBudgetUsd`, and after each segment, crash or error decides: resume, retry, fresh, done or fail | `nextAction()` |

The SDK pieces it uses: `resume` with the journaled `session_id`, `sessionStore` + `sessionStoreFlush: "eager"`, `maxTurns`, `maxBudgetUsd`, `result.subtype` / `terminal_reason`, and in-process MCP tools (`createSdkMcpServer`).

## The lab

A nightly refund batch: 8 refund requests and one policy. Approve only when the purchase was at most 30 days ago, the amount is at most 200.00 EUR and the item is unused. Otherwise reject and name the rule that is broken. R-105 sits exactly on both limits. The tests compute the expected decisions rule by rule.

The agent (`claude-haiku-4-5`, thinking off, a short system prompt) has two tools:
- `next_refund` returns the first refund **the journal** lacks, whatever the model remembers.
- `settle_refund` applies the side effect under its key (pay the customer, or email a rejection), **then** journals the refund.

Each segment gets `maxTurns: 6` (adjustable) and `maxBudgetUsd: 0.15`. The job has caps of 10 segments, $0.60, 3 failed attempts in a row, and 2 segments without progress. The lab drops inherited `CLAUDE*` and model-mapping variables, sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and keeps everything under the ignored `durable-lab/` folder: `jobs/`, `ledger.jsonl`, `store/` and the worker's `config/`.

### A · The job (offline)

The refund table and what the policy says for each refund.

### B · The crash window (offline)

The dangerous moment is **after a side effect and before the journal write**. `simulate(design, crashAfter)` kills the worker there once and restarts it:

| Design (crash after effect 3) | Issued | Applied | Suppressed by key | Duplicates |
|---|---|---|---|---|
| naive: no journal, restart from the first refund | 11 | 11 | – | **3** |
| journal: skip what the journal has | 9 | 9 | – | **1** |
| durable: journal + idempotency keys | 9 | 8 | 1 | **0** |

A journal alone always leaves one duplicate, the refund in the window, wherever the crash lands. Only the key makes the retry harmless. Execution is at least once; the key makes the **effect** happen exactly once.

### C · The supervisor policy (offline)

`GET /policy` shows the real output of `nextAction()` for twelve situations:

| Outcome | Action |
|---|---|
| `error_max_turns`, `error_max_budget_usd`, or `success` with refunds left | **resume** the same session. A segment end is a checkpoint, not a failure |
| crash, `session_id` already journaled | **resume** (the transcript is in the store) |
| crash before the first message | **fresh** session |
| an error, first time | **retry** the same session after a 1 s backoff |
| an error, second time | **fresh** session after 2 s (the session itself may be the problem) |
| "No conversation found…" | **fresh** |
| 3 failed attempts, 10 segments, $0.60 spent, or 2 segments without progress | **fail**: stop and let a human look |
| every refund journaled | **done** |

A fresh session loses nothing that matters, because the continuation prompt ("The job journal shows 5 of 8 refunds settled (R-101, …). Call next_refund…") and the tools are rebuilt from the journal.

### D · Run a durable job live (billed)

Run a job with no drill, or with a **crash drill**. The drill kills the worker right after the Nth side effect, before its journal write: the tool throws and the segment's `AbortController` fires. It can also delete the worker's local transcripts (`config/projects`) to imitate a recreated container. The supervisor then recovers on its own. The page shows every segment, tool call, ledger effect (applied or refused), crash and decision, plus the journal: segments, settled refunds against the policy, cost and heartbeats.

Runs made while building this lesson (SDK 0.3.281, `maxTurns: 6`):

| Run | Segments | Result | Ledger | Cost |
|---|---|---|---|---|
| no drill | start → max_turns → resume → success | 8/8 correct | 8 effects | $0.034 |
| kill after effect 3 + wipe local transcripts | start → **crash** → resume → max_turns → resume → success | 8/8 correct | 8 effects, R-103 repeat **refused** | $0.049 |
| kill after effect 5 | start → max_turns → resume → **crash** → resume → max_turns → resume → success | 8/8 correct | 8 effects, R-105 repeat **refused** | $0.060 |
| `kill -9` of the whole process after 2 refunds, then `/recover` from a new process | refused at once (`leased by worker-… for 10 more s`); after expiry, `expired lease … taken over` → resume → done | 8/8 correct | 8 effects | $0.041 + the lost segment |

Across 7 finished jobs the ledger holds 56 effects: 8 per job and no duplicates.

What the runs showed:

- **Resume works from the store alone.** After the wipe, the local `projects/` folder was gone, yet `resume` loaded the session from the `FileSessionStore`. One stored transcript holds the prompts of all three segments.
- **At a limit the SDK yields the error result and then throws** `Claude Code returned an error result: Reached maximum number of turns (6)`. The first version treated that throw as an API error and backed off before retrying. Keep the result you already received, and let `subtype` / `terminal_reason` decide.
- **The model retries a failed tool call in the same turn.** After the drill's tool error, Haiku called `settle_refund` again before the abort landed, and called it once more after the resume. The key refused the repeat, and the journal recorded the refund as settled.
- **A killed process loses its segment's cost.** `total_cost_usd` is cumulative per session, so the journal keeps the highest value seen per session. A segment that dies before its result reports nothing, and in this run the resumed session did not carry it either. Bill from your provider's usage reports, not only from the journal.
- **`num_turns` counts the turn that crossed the limit.** A segment stopped by `maxTurns: 6` reports `num_turns: 7`; the page's Turns column shows the raw value.
- **Journal the segment before it runs.** A segment is written as `running` when it starts, so a worker that dies leaves a visible `abandoned` row instead of a silent gap.

### E · Jobs on disk

`GET /jobs` lists every journal with its progress, effects, lease and cost, and flags **orphans**: running, not driven here, and with an expired lease. **Recover** (`POST /recover`) picks one up. A job whose lease is still live is refused, so two workers never drive the same job. **Stop (graceful)** releases the lease at once; a crashed process cannot, so its lease simply expires. To see this end to end, restart `npm run dev` in the middle of a job, wait 15 s, then click Recover.

## Apply it to your agent

1. Keep progress in your own store (a journal or a table), written atomically. The transcript is context for the model, not your source of truth.
2. Let the tools read that store, so "next item" can never return finished work.
3. Give every side effect an idempotency key built from stable ids, never from model output. Make the effect store refuse a repeated key, and pass the key on to payment and email APIs that accept one.
4. Run long work as segments with `maxTurns` and `maxBudgetUsd`, and `resume` between them.
5. Journal `session_id` from the first message. If the worker's disk can disappear, mirror the transcript to a `sessionStore` with `sessionStoreFlush: "eager"` (the default `"batched"` flushes only at the end of a turn).
6. Decide the next step with a pure, tested policy: resume, retry with backoff, start fresh from the journal, or fail. Cap segments, cost, attempts and streaks without progress.
7. Hold a lease with a heartbeat. Release it on a graceful stop and let it expire on a crash.

Reference: [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

## Implementation and verification

- `server/durable/workshop.ts`: the refunds and the policy; `JournalFiles` (atomic writes); `Ledger` (idempotent JSONL); the lease functions; `nextAction()` and `backoffMs()`; the prompts; `simulate()`; and a trimmed `FileSessionStore` (lesson 35's adapter).
- `server/concepts/60-durable-agents.ts`: `/facts`, `/code`, `/simulate`, `/policy` and `/jobs` (offline); `/reset`; `/run` (a new job, with an optional drill, live SSE, 300-second deadline); `/recover` (an orphaned or stopped job, live SSE). `drive()` is the supervisor: lease, heartbeat, segments, journal and decisions. Inputs are validated with zod, and one job runs at a time per process.
- `src/concepts/Concept60DurableAgents.tsx`: sections A–G.
- `server/durable/durable.test.ts`: the policy key, the simulation for every crash point, the ledger and atomic journal, the lease, every `nextAction()` branch and the backoff, the continuation prompt, the store round trip, and HTTP validation.
- `server/durable/live-check.ts`: the billed command-line runs (`clean`, `crash:N`, `wipe:N`, `recover:<jobId>`; `TURNS=` sets `maxTurns`).

```powershell
npm run typecheck
npm run test:durable
npm run test:offline
npm run build
```

The tests make no model calls and do not start Claude Code.

For the browser check, stop the app and run `node --env-file-if-exists=.env --import tsx server/durable/browser-smoke.mjs`. It needs Chrome at the default Windows path and free ports 3060, 5190 and 9233. It checks navigation, the refund table, the crash-window table (3/1/0 duplicates, then 8/1/0 after moving the slider), the supervisor's five actions and mobile width. It saves a screenshot under the ignored `durable-lab/browser-smoke/`. It makes no model calls.

Verification passed: typecheck, production build, all 124 offline tests (seven of them for lesson 60) and the headless Chrome check. All live runs while building, including the drills and the process-kill recovery, cost about $0.34.

## Steps followed to build this sample

1. Copied sample59 and moved the ports to 3060 (server, Vite proxy and the lessons 56–59 smoke scripts).
2. Read the SDK 0.3.281 typings: `resume`, `sessionId`, `forkSession`, `persistSession`, `sessionStore` / `sessionStoreFlush` / `loadTimeoutMs`, `maxTurns`, `maxBudgetUsd`, `SDKResultError` subtypes, `terminal_reason`, and the cumulative semantics of `total_cost_usd` and `modelUsage` across resumes.
3. Wrote the pure workshop and its tests first: policy, journal, ledger, lease, supervisor policy and simulation.
4. Built the supervisor route and probed it live. This surfaced the throw after a limit result, which the first version retried as an error.
5. Ran the drills (with and without wiping local transcripts) and a real `kill -9` of the process, followed by recovery from a new process. Then I journaled each segment before it runs, so a dead worker's segment is visible.
6. Added the UI, navigation, the browser check and this document.
