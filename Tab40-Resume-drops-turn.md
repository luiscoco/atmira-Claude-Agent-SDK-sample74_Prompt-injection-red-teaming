# Resume drops turn

This file explains Concept 40 (**`resumeDropsTurn`**) of the Claude Agent SDK Lab. Concept 19 showed that
`resumeSessionAt` cuts a session after one entry: that is how a host builds "undo", "regenerate" or "rewind". But the cut
takes **everything** after that entry, and a session can hold things the host never saw: a message the user sent while
a tool was running, a task notification, a later turn. With `resumeDropsTurn`, the host names the **one turn** it means to
drop. Claude Code checks the cut first and **refuses** it if anything else would go.

**Goal:** see where the option goes, build a session that absorbed a message mid-turn, and compare ten cuts of it: which
are accepted, which are refused and why. Then undo a turn the way a host should, with the recovery path.

| Concept | Topic | Routes |
|---|---|---|
| 40 | `resumeDropsTurn`: the flag `--resume-drops-turn=<id>`, its startup checks, the check of the discarded range, the refusal (`error_during_execution`, $0), a message queued mid-turn (`attachment/queued_command`), which uuid to fork at, host-chosen prompt uuids, the recovery path | `/api/c40/dry`, `/build` (SSE), `/state`, `/cases` (SSE), `/undo` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/40-resume-drops-turn.ts` | **New**: the options, the dry run, the chain reader, the lab session, the guarded resume, the ten cases, the undo, the routes |
| `server/index.ts` | Mounts the router on `/api/c40` |
| `src/concepts/Concept40ResumeDropsTurn.tsx` | **New**: the tab, Parts A to G |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The chain table, the absorbed row, accepted and refused outcomes |
| `.gitignore` | Ignores `drops-lab/` |
| `Tab1-query().md` | Adds Concept 40 to the table and the project tree |

---

## Step 1: The smallest example

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// "Undo turn 3": keep turns 1-2, drop turn 3, and ONLY turn 3.
for await (const m of query({
  prompt: "Let's try that again.",
  options: {
    resume: sessionId,
    forkSession: true,                   // optional: keep the original session as it is
    resumeSessionAt: lastEntryOfTurn2,   // Concept 19: cut the chain after this entry
    resumeDropsTurn: promptUuidOfTurn3,  // this concept: "and the cut must hold only turn 3"
  },
})) {
  if (m.type === "result" && m.subtype === "error_during_execution" &&
      m.errors.some((e) => e.startsWith("Resume rejected by --resume-drops-turn:"))) {
    // Do not retry: resume plainly (no resumeSessionAt, no resumeDropsTurn) and tell the user.
  }
}
```

The host knows `promptUuidOfTurn3` without reading the transcript: it sets `uuid` on the `SDKUserMessage` it streams
(Concept 12), and Claude Code keeps that uuid for the prompt.

## Step 2: The lab

The server uses its own `CLAUDE_CONFIG_DIR` (`drops-lab/config`), so the tab can read the raw transcript JSONL.
`getSessionMessages()` (Concept 19) leaves attachments out, and here the attachments matter. Scenario **2** builds one
session with **one `query()` and streaming input**. Each prompt carries a uuid the host chose:

```text
turn 1   "Remember: my fruit is mango."
turn 2   "Remember: my colour is teal."
turn 3   "Run node -e setTimeout(…, 5000) with Bash"   ← 1 s into the Bash call, the host sends "my city is Oslo"
turn 4   "Remember: my pet is a cat."
```

The message sent during turn 3 does not become a turn of its own. Claude Code **absorbs** it into turn 3, as an
`attachment/queued_command` after the tool result, and the model answered both (*"built. Also noted: your city is
Oslo"*). Only four `result` messages come back. The chain (from the tab, one build):

```text
#13 t3 user                         Run exactly this with the Bash tool…      ← turn 3's prompt (the host's uuid)
#14 t3 attachment/total_tokens_reminder
#15 t3 assistant                    [tool_use Bash]
#16 t3 user (tool_result)
#17 t3 attachment/queued_command    Also remember: my city is Oslo.            ← the host never "saw" this as a turn
#18 t3 attachment/total_tokens_reminder
#19 t3 assistant                    The output is: built. Also noted: your city is Oslo.
#20 t4 user                         Remember: my pet is a cat.
```

Every case after this **forks** that session (`forkSession: true`), so the lab session never changes. Each case asks
the same question: *"What do you know about me: fruit, colour, city, pet?"* The answer shows what survived the cut.

## Step 3: Where the option goes, and what is refused at startup

Scenario **1** costs nothing:

| Options | The CLI args | Claude Code at startup |
|---|---|---|
| `resume` + `resumeSessionAt` | `--resume=<id> --resume-session-at=<uuid>` | |
| … + `resumeDropsTurn` | … `--resume-drops-turn=<uuid>` | |
| … + `forkSession: true` | … `--fork-session` … | |
| `resumeDropsTurn: ''` | `--resume-drops-turn=` (the SDK only checks `!== undefined`) | |
| `resume` + `resumeDropsTurn`, no `resumeSessionAt` | | `Error: --resume-drops-turn requires --resume-session-at` |
| `resumeSessionAt` + `resumeDropsTurn`, no `resume` | | `Error: --resume-session-at requires --resume` |

The SDK does not check the value. Claude Code does: at startup for the missing options (exit code 1, `query()`
throws), and when it loads the session for the rest.

## Step 4: Ten cuts of the same session

Scenario **3** runs ten resumes, four at a time. Results from the tab:

| Case | `resumeSessionAt` · `resumeDropsTurn` | Outcome | The answer, or the reason |
|---|---|---|---|
| keep turns 1–2, **no guard** | end of turn 2 · (not set) | accepted | *"mango, teal, but I don't have your city or pet"* |
| keep turns 1–2, drop turn 3 | end of turn 2 · turn 3 | **refused**, $0 | `range contains absorbed queued content; entry 4 [type=attachment (queued_command)…]` |
| keep turn 1, drop turn 2 | end of turn 1 · turn 2 | **refused**, $0 | `range contains a user entry not attributable to the declared turn` (turn 3's prompt) |
| keep turns 1–3, drop turn 4 | end of turn 3 · turn 4 | accepted | *"mango, teal, Oslo, pet unknown"* |
| the same, at turn 3's streamed assistant uuid | #19 · turn 4 | accepted | (in that build, the assistant message was turn 3's last entry) |
| fork mid-turn 3 (its `tool_use`) | #15 · turn 4 | **refused**, $0 | `range does not start with the declared turn prompt; first discarded entry 0 [type=user…]` (turn 3's own tool_result) |
| keep turns 1–3, but name turn 3 | end of turn 3 · turn 3 | **refused**, $0 | `range does not start with the declared turn prompt` (turn 4's prompt comes first) |
| `resumeDropsTurn: 'turn-4'` | end of turn 3 · `turn-4` | **refused**, $0 | `declared turn id is not a UUID: turn-4` |
| keep all four, name turn 4 | end of turn 4 · turn 4 | accepted | nothing is discarded, so there is nothing to check |
| no `resumeSessionAt` | · turn 4 | exited | `Error: --resume-drops-turn requires --resume-session-at` |

- **The first two rows are the point of the concept.** A plain cut after turn 2 **succeeds**, and the city is gone.
  The host meant to drop turn 3 (a Bash call), but the message the user sent during it went too, with no warning. With
  `resumeDropsTurn`, the same cut is refused.
- **A refusal is cheap and safe.** It is a `result` with `subtype: "error_during_execution"`. `errors[0]` is
  `Resume rejected by --resume-drops-turn: resuming at <uuid> would discard entries not attributable to turn <uuid>:
  <reason>`. `total_cost_usd` is 0 (no API call), and nothing is written. Then `query()` throws *"Claude Code returned
  an error result"*, so read the `result` before the loop ends.
- **Fork at the last entry of the turn you keep.** A uuid in the middle of turn 3 (its `tool_use`) leaves turn 3's
  tool result in the discarded range, and that is refused. The streamed assistant uuid works for a text turn: what may
  follow it (a `prompt_snapshot`, a `total_tokens_reminder`) is "furniture", and the check skips it. In one build,
  turn 1 ended with a `prompt_snapshot` after its assistant message.
- An accepted guarded cut is an ordinary `resumeSessionAt`. With `forkSession` you get a new id; without it, the same
  session is cut (Concept 19).

## Step 5: Undo a turn, like a host

Scenario **4** runs `undoTurn()`. It forks at the last entry of turn N-1, names turn N's prompt, and on a refusal takes
the **recovery path**:

```text
undo turn 3, recover on
  guarded resume   refused  $0         range contains absorbed queued content …
  recovery         no retry: clear the fork target, resume plainly (resumeSessionAt and resumeDropsTurn unset)
  plain resume     accepted $0.017     "fruit mango, colour teal, city Oslo, pet cat"
```

`sdk.d.ts` spells out why a host must not retry: *"the refusal is deterministic, so re-sending the same fork request
fails forever"*. Clear the pending fork target, resume plainly, keep the evidence, and tell the user why the undo did
not happen. (A real host could also offer a narrower undo, or show the absorbed message.)

## Step 6: What the check allows, and why it refuses

From `sdk.d.ts`, and in detail from the CLI's code (`claude.exe` of `0.3.281`, which can change). The discarded range is
every chain entry after `resumeSessionAt`:

1. Leading "furniture" (attachments such as `prompt_snapshot`, `total_tokens_reminder`, `date`) is skipped. It does not
   include `structured_output`, `mcp_resource` or inlined images.
2. If nothing is left, the resume is accepted.
3. The first real entry must be a human prompt with **exactly** the declared uuid.
4. After it, only the turn's own entries: assistant messages, tool results, `system` and `progress` entries, furniture.
5. Anything else refuses: a `queued_command`, another turn's prompt, a compaction summary, a system-injected prompt, a
   non-furniture attachment, or an externally sourced user entry.

**End-turn tool sessions** (`outputFormat: { type: 'json_schema' }`, or an MCP tool with `_meta['claude/endTurn']`)
are singled out in `sdk.d.ts`. There, a turn ends with a tool result and a `structured_output` attachment, not with an
assistant message. So fork at that attachment, not at the last assistant uuid. The lab could not reproduce this: with
`0.3.281`, a `json_schema` turn still ended with an assistant message.

**Print mode only.** The SDK always runs in print mode. An interactive `claude --resume` and background-job workers
ignore both options: no cut, no guard, no error.

## Step 7: What changes, and what does not

| What | How | What happens |
|---|---|---|
| Set it | `resumeDropsTurn: '<prompt uuid>'` with `resume` + `resumeSessionAt` | `--resume-drops-turn=<id>`. Without `resumeSessionAt`, exit at startup |
| Accepted | the range is that turn only | A normal truncating resume |
| Refused | anything else in the range | `error_during_execution`, `Resume rejected by --resume-drops-turn:`, $0, nothing written |
| On a refusal | no retry | Clear the fork target, resume plainly, tell the user |
| Fork point | the kept turn's last entry | The streamed assistant uuid is fine for a text turn; never mid-turn |
| Prompt uuid | `uuid` on your `SDKUserMessage` | The host knows it without reading the transcript |

## Things to try in Concept 40

1. Run 1: which missing option does the SDK itself refuse? (None. Claude Code does.)
2. Run 2, then find the `queued_command` row in the chain. Which turn is it in, and what came back as `result`s?
3. Run 3 and compare the first two rows: which is worse for a user, the answer of row 1 or the refusal of row 2?
4. In 4, undo turn 3 with *recover* off, then on. Then undo turn 4 at *tool_use (mid-turn)*: why is a correct turn
   number not enough?
5. Build again and rerun 3. Do the reasons stay the same? (The uuids change, the rules do not.)

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **40. resumeDropsTurn** tab. `ANTHROPIC_API_KEY` must be in `.env`. Start the app from a normal terminal, not
from inside Claude Code (see Tab16). With Haiku 4.5: scenario 1 costs nothing, 2 about $0.017, 3 about $0.07 (the five
refused rows cost $0), and 4 about $0.017 when it reaches the API ($0 for a refusal without recovery).

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -X POST http://localhost:3001/api/c40/dry
curl.exe -N -X POST http://localhost:3001/api/c40/build
curl.exe -N -X POST http://localhost:3001/api/c40/cases
```

`node_modules` was copied from sample39, so `npm install` is not needed. Run the scenarios in order: 3 and 4 need the
session of 2. A full pass costs about $0.11.

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 40 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

As in samples 28 to 39, the request said "implement the following feature sample" with no feature text. After
Concept 39, five `Options` fields of `sdk.d.ts` (`0.3.281`) were still used nowhere in `server/` or `src/`: `betas`,
`maxThinkingTokens`, `onUserDialog`, `resumeDropsTurn` and `supportedDialogKinds`. **`resumeDropsTurn`** was chosen:

- It builds on Concept 19 (`resumeSessionAt`) and Concept 12 (streaming input). It fixes a real data-loss bug in
  any host with an "undo" or "regenerate" button.
- It can be shown with real, cheap runs, and every refusal costs $0 (Claude Code checks before any API call).
- The others are deprecated (`maxThinkingTokens`) or model-specific (`betas`). `onUserDialog` and
  `supportedDialogKinds` need a dialog the lab cannot trigger on demand (a refusal fallback).

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab39-Project-config-root.md`, `39-project-config-root.ts`, `Concept39ProjectConfigRoot.tsx` | The latest style: strict zod bodies, SSE rows run in parallel, `#region` + `/code`, the dry run with a fake process, a summary table |
| `19-session-management.ts`, `Tab19-Session-management.md` | `resumeSessionAt`, *"keep turns whole"*, and that a cut without `forkSession` rewrites the same session |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types, the SDK and the CLI

| Found | Used for |
|---|---|
| `Options.resumeDropsTurn` in `sdk.d.ts`: the check, the refusal prefix, *"MUST map a refusal … to their rewind-recovery path … not retry"*, the end-turn tool rule, *"PRINT/HEADLESS LANE ONLY"* | Every part |
| `SDKUserMessage.uuid`, and `ForkSessionOptions.upToMessageId`: *"or from the `uuid` you supplied on a streamed SDKUserMessage"* | Host-chosen prompt uuids (Part B) |
| In `sdk.mjs`: `--resume-drops-turn=<id>` when `!== undefined`, with no check | Part A |
| In `claude.exe`: the startup errors (`requires --resume-session-at`, `requires --resume`) and the validator: the "furniture" attachment list, the leading-skip exceptions (`structured_output`, `mcp_resource`, `inlined_image_paths`), and every refusal reason | Parts A, C and E |

### Build step 4: Probe before designing

Scratchpad scripts used their own `CLAUDE_CONFIG_DIR` and ran real Haiku 4.5 sessions:

| Probe | Result | Decision |
|---|---|---|
| A 3-turn session, forks with each pair of options | Dropping the last turn: accepted, the same as `resumeSessionAt`. Dropping two turns, a wrong turn, a random uuid, `"turn-3"`: refused, $0, nothing written, then `query()` throws. Without `resumeSessionAt`: exit at startup. A plain cut of two turns: accepted, silently | The table of Part C |
| Without `forkSession` | Accepted, and the **same** session is cut (as in Concept 19) | Every lab resume forks |
| Streaming input: a message sent during a 6 s Bash call | Absorbed into the running turn as `attachment/queued_command`. There is no extra `result`. The prompts kept the host's uuids | The lab session of Part B |
| Guarded cut of that turn | `range contains absorbed queued content`. The plain cut lost *"my city is Oslo"* | The key row of Part C and the default of Part D |
| Fork at the streamed assistant uuid | Accepted: the `prompt_snapshot` after it is furniture | A row in Part C |
| A `json_schema` turn, forked at the last assistant uuid | Accepted: with `0.3.281` it still ended with an assistant message | The end-turn rule is only described (Part E), not shown |

The first run of probe 1 did not load `.env`: the refusals still came back (they need no API), and the accepted
runs said *"Not logged in"*. A good hint that the check runs before any API call.

### Build step 5: Design the concept

- **One lab session** (`drops-lab/`, with its own `CLAUDE_CONFIG_DIR`), built by one `query()` with streaming input:
  four turns with host-chosen uuids, and a message sent 1 s into turn 3's Bash call.
- **The raw chain**: the server reads the JSONL (walking `parentUuid` back from the newest entry), because
  `getSessionMessages()` leaves attachments out. It marks each turn's prompt, its last entry, its last assistant and its
  `tool_use`.
- **Every resume forks** the lab session and asks the same question, so the answer shows what survived.
- **`undoTurn()`**: the guarded resume, then the recovery path on a refusal (match on the prefix, no retry).
- **Routes**: `POST /dry` (JSON), `POST /build` (SSE), `GET /state`, `POST /cases` (SSE, one row each, four at a time),
  `POST /undo` (SSE), `GET /code`.

### Build step 6: Implement it

| File | What was done |
|---|---|
| `server/concepts/40-resume-drops-turn.ts` | New: `base()`, `recordingProcess()` + `startup()` for `/dry`, `chainOf()` + `turnsOf()`, `buildSession()`, `resumeOnce()`, the `CASES` table and `pool()`, `undoTurn()` |
| `src/concepts/Concept40ResumeDropsTurn.tsx` | New: `Chain`, `CasesTable`, `Timeline`, Parts A to G |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md` | Mount, tab, chain styles, `drops-lab/`, table row and tree, the sample40 path |

`npx tsc --noEmit -p .` passed. It caught one thing: `SDKUserMessage.uuid` is typed as a UUID template string, not
`string`.

### Build step 7: Test the routes

A scratchpad script mounted **only** the Concept 40 router on port **3140**, with `.env` loaded and the `CLAUDE*`
variables removed. `drive.mjs` printed each route's output.

| Test | Result |
|---|---|
| `/code`, `/dry`, `/state` | 7 regions; the args and the two startup errors of Step 3; `null` before a build |
| `/build` | Four turns and one queued message; the chain of Step 2 |
| `/cases` | The ten rows of Step 4 |
| `/undo` | Turn 3 with recovery (refused, then a plain resume that kept Oslo), turn 4 at the `tool_use` without recovery (refused), a bad body (a zod error) |

What the tests changed:

- In streaming input, every `result` carries the session's **running** `total_cost_usd`. The tab counts only the last
  one for the build, and labels each as *"so far"*.
- `system/init` comes once per turn in streaming input. The timeline now shows only the first.

### Build step 8: Run it in the real app

Vite ran on port **5199** with a scratchpad config whose proxy pointed to the 3140 server. Headless Edge was driven
through the DevTools protocol (profile in `%TEMP%\c40-edge`): tab 40, then scenarios 1, 2, 3 and 4 (undo turn 3,
recover on).

| Check | Page |
|---|---|
| Open tab 40 | 7 code buttons, the session of the route tests restored by `/state` |
| 1 | The two tables of Part A |
| 2 | The timeline (the queued message at 5.3 s, during the Bash call) and the 23-entry chain with the marks |
| 3 | The ten rows, the reasons without their uuids |
| 4 | Refused, recovery, plain resume: *"mango, teal, Oslo, cat"* |
| Console | No error |

What using the app changed:

- The *"streamed assistant uuid"* row claimed a `prompt_snapshot` had been skipped. In that build, turn 3's assistant
  message was its last entry, so the row was the same fork point as the row above. The note now depends on the chain
  (checked with `tsc`, then confirmed by a later full run of scenarios 1 to 4 in the app: the row showed the new note,
  and the tab's total, $0.1050, matched the sum of the sessions' costs).

All test processes were stopped, and `drops-lab/`, the probe folders and the Edge profile were deleted.

Costs: about $0.30 for all the probes, route tests and the browser test.
