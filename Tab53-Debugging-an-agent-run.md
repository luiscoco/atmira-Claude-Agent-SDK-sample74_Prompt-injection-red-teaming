# Debugging an agent run

Lesson 53 brings together hooks (20), error recovery (28), telemetry (44), offline tests (51) and evals (52).
The goal is to explain a single run with evidence before changing a prompt or raising a limit.

Run `npm ci`, then `npm run dev`. Open **Production & deployment → 53. Debugging an agent run**.
Sample53 uses backend port **3053**; Vite uses 5173 or the next free port printed in the terminal.
Use Node 24 or newer.

## Start with offline evidence

```powershell
npm run test:debugging
npm run test:offline
npx tsc --noEmit
npx vite build
```

The test commands do not load `.env`, call a model or launch Claude Code. The seven browser replays feed synthetic
events into the same trace collector and diagnosis function used by live runs. They teach event interpretation;
they do not establish actual model behaviour or callback scheduling.

| Scenario | First useful evidence | What to inspect |
|---|---|---|
| Successful file check | Read input and tool result | Whether the answer matches the file |
| Denied | PreToolUse denial | Policy reason; no execution failure hook is expected |
| Missing file | PostToolUseFailure and error tool result | File path and cwd; permission was allowed |
| Turn limit | error_max_turns result | Repeated actions and bounded maxTurns |
| Startup | stderr and iterator exception without init | Runtime, executable, cwd and environment |
| API error | success subtype with is_error = true, then exception | Errors, auth and provider diagnostics |
| Truncated | End without result | Incomplete transport/process evidence |

A result whose subtype is `success` is insufficient: check `is_error`. A tool error may recover and end with a
successful result. An iterator can throw after producing a result; this lab preserves both events. Partial text
without a terminal result must not be treated as completion. Even successful completion needs task verification.

## Inspect a real process

Choose **Live** and explicitly run the diagnostic. This requires Claude authentication and incurs API cost.
The lab uses `claude-haiku-4-5-20251001`, only the Read tool, no project settings sources, a fresh working folder,
and a permission callback that allows only the selected fixture path. A PreToolUse hook supplies the deliberate
denial and enforces the fixture path even when Read is auto-approved without invoking the callback. No bypass
mode is used. Each run starts a new session; there is no resume or replay of real side effects.

The four live scenarios are success, denied, missing and max-turns. Model choices can vary: inspect the actual
trace instead of assuming a scenario triggered its intended failure. The turn-limit scenario always uses
`maxTurns: 1`. To compare, run success with a higher limit. Denied and missing can be compared with success,
which changes the controlled fixture condition. Raising a limit will not fix a missing file or policy denial.

The live options include:

```typescript
const options = {
  cwd: work,
  tools: ["Read"],
  settingSources: [],
  maxTurns: 4,
  abortController,
  includePartialMessages: true,
  debugFile: absoluteLogPath,
  stderr: (chunk: string) => trace.add("stderr", "chunk", chunk),
};
```

`debugFile` implicitly enables CLI debugging. Without it, the lab still captures stderr. stderr is a process
diagnostic channel; it is not the assistant's reply or a terminal success signal. The CLI's own debug output
and SDK stream are different evidence sources. Use the SDK options rather than adding console output to the
subprocess protocol stream.

The host aborts at 60 seconds and on browser disconnect. Stop preserves already-received rows in the browser.
After cancellation finishes, **Recover saved bundle** reads the completed diagnostic file. A stopped request
cannot receive the final SSE event, so recovery may need to be retried briefly. Run IDs are validated; the API
never accepts arbitrary paths. Saved bundles survive server restarts until `debug-lab/` is removed.

## Correlate before diagnosing

The timeline contains sequence numbers and milliseconds since collection began. Filter by SDK, hook,
permission, stderr or host. Paste a `tool_use_id` from an assistant tool_use block to find its hook events,
decision and tool result. Callback arrival may precede a streamed message; timestamps are host observations,
not a perfect distributed ordering. Each diagnosis links to the rows supporting it and suggests the next check.

Keep selected options, the model/session reported by init, result subtype, is_error, cost, errors and any
exception. Inspect the earliest cause as well as the final symptom. A missing init suggests startup trouble;
an init followed by a tool denial points to a different layer. Debug logs help but do not replace outcome checks.

## Preserve and verify

Each run saves `debug-lab/<UUID>/bundle.json`. Download includes the selected config, redacted trace, diagnosis
suggestions and at most the first 128 KB of CLI debug output. Individual stderr chunks are capped at 8 KB.
Raw CLI debug files remain on disk and can include prompts, paths and sensitive text. The browser/export
redactor masks common credentials and sensitive field names; it is best effort, so review before sharing.
No environment-variable snapshot is exported. The entire generated lab is ignored by version control.

After locating a cause, change one condition, run a fresh bounded comparison, and verify the answer against
its tool evidence. Add a regression test for host/policy logic with lesson 51, and measure model task quality
with lesson 52. This diagnostic lab's suggestions are not a guarantee that a task succeeded.

Implementation: `server/concepts/53-debugging.ts`, `server/debugging/trace.ts`,
`src/concepts/Concept53Debugging.tsx`, and `server/debugging/debugging.test.ts`.

Reference: [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
