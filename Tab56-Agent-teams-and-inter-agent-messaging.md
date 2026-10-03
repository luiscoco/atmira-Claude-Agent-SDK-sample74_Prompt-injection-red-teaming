# 56. Agent teams and inter-agent messaging

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Multi-agent systems → 56. Agent teams and inter-agent messaging**, or `?lesson=56`. Sample56 uses backend port **3056**; Vite starts on **5173** or the next available port.

## What this lesson teaches

Lesson 8 introduces subagents and lesson 47 introduces orchestration. This lesson focuses on ownership, dependencies, peer messages and lifecycle. The central exercise is an application-owned protocol executed without a model. It is not an implementation of Claude Code's private mailbox schema.

The [official agent teams documentation](https://code.claude.com/docs/en/agent-teams) distinguishes interactive native teams from SDK sessions: teammates require interactive Claude Code, and named agents in SDK sessions remain subagents. The live section therefore demonstrates a named SDK worker and `SendMessage`, rather than claiming native team support. Native teams are experimental. Verify documentation and your installed runtime when upgrading.

## Walkthrough

Click **Next walkthrough step** to inspect every transition, or **Run full walkthrough** to execute all 16 steps. The receipt list includes five deliberate rejections:

1. Review cannot be claimed until research finishes.
2. Researcher claims research; a competing claimant is rejected.
3. A busy researcher rejects shutdown.
4. Researcher queues evidence directly to reviewer. Repeating the same message ID and payload retains one envelope.
5. Acknowledgment before delivery fails. Delivery and acknowledgment then succeed.
6. Completion with `30` fails the evidence gate. `12 + 18 + 7 = 37` passes and unlocks review.
7. Reviewer claims review and submits `verified: 37`.
8. Both idle workers accept shutdown. Cleanup closes the exercise and retains evidence for inspection.

The offline gate deliberately expects exact fixture evidence; this is not a general arithmetic verifier. The shutdown rules, explicit delivery controls, acknowledgment status and duplicate policy are this application's teaching choices. Native team behavior need not match them.

Reset and send a custom peer message. Delivery moves queued envelopes to delivered; acknowledgment acts on the first delivered envelope for the chosen recipient. Neither completes a task. Sender and recipient selectors simulate roles, rather than authenticating real agents. Commands and receipts remain in browser memory. Requests strictly validate and replay at most 100 commands in isolation, without saving a global team.

For production, use an authenticated identity and durable store. Make claims atomic across processes, associate each envelope with a unique correlation ID, bound retries, and preserve evidence across crashes. This reducer processes claims sequentially within one HTTP request; it does not demonstrate cross-process locking or a distributed delivery guarantee.

## Optional live SDK demo

The live button makes billed Haiku calls using `ANTHROPIC_API_KEY` from `.env`. It creates an isolated workspace and configuration directory under `teams-lab/run-*` and keeps one streaming-input SDK session open:

- Turn one asks the lead to spawn a foreground `calculator` named `researcher` and compute `12 + 18`.
- Turn two asks the lead to use `SendMessage` to that worker or its returned agent ID, adding `7` to the prior total.
- Tool hooks show attempts. The raw SDK stream shows actual tool results, task events and terminal results. The summary separately reports whether messaging was attempted and whether the final answer contains `37`; neither flag proves delivery or numerical correctness.

The run caps each query at eight turns, sets a $0.15 SDK budget and has a 90-second host deadline. The SDK budget is a stop threshold, not a prepayment cap. Disconnecting or clicking Cancel aborts the run. Terminal errors stop the exercise, and the session closes in `finally`. A runtime lacking `SendMessage` reports that limitation. The host does not inject messages directly through a public `query.sendMessage()` method; it prompts Claude to invoke its native tool.

Live outputs depend on the selected model and runtime. Validate the tool response and worker evidence before relying on them. Offline tests do not verify remote models or the bundled Claude process. Isolated configuration means this exercise expects an API key, rather than promising access to an existing CLI login.

## Native terminal exercise

Start an interactive Claude Code session in PowerShell:

```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"
claude --teammate-mode in-process
```

Use the prompt displayed in section D. Give researcher and reviewer separate responsibilities and explicit data, ask for peer evidence, and inspect their reports before requesting shutdown. Consult the linked official documentation for the installed CLI's task tooling and lifecycle. No browser endpoint launches an interactive native team or edits its native inbox files.

## Verification and implementation

```powershell
npm run typecheck
npm run test:teams
npm run test:offline
npm run build
```

`server/teams/workshop.ts` defines the validated commands, reducer and walkthrough. `server/concepts/56-agent-teams.ts` exposes facts, source, replay and live SSE routes. `src/concepts/Concept56AgentTeams.tsx` renders the task board, mailboxes, receipts and live evidence. `server/teams/teams.test.ts` verifies conflicts, dependencies, evidence rejection, delivery ordering, duplicate IDs, shutdown, isolation and HTTP validation without model calls.

The lesson is registered in `src/App.tsx` and `server/index.ts`. The server and Vite proxy both use **3056**. No dependency version changes were needed.

Implementation checks passed: type-check, production build, all 94 offline tests (including 13 lesson 56 tests), and a headless Chrome check of navigation, the full walkthrough, reset, custom messaging and mobile width. The optional live model run was not executed during implementation.

To repeat the browser check, stop the app first and run `node --import tsx server/teams/browser-smoke.mjs`. It requires Chrome at the default Windows installation path and free ports 3056, 5186 and 9229. It saves a desktop screenshot under the ignored `teams-lab/browser-smoke/` folder and closes its browser and servers.
