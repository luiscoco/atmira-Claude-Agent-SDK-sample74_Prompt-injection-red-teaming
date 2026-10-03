# Model routing

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Production & deployment → 59. Model routing**, or go to `?lesson=59`. Sample59 uses backend port **3059**. Vite uses **5173**, or the next free port.

## What you will learn

Lesson 14 covered `model`, `fallbackModel`, `supportedModels()` and `setModel()`. Lesson 46 cut cost with caching. This lesson combines them into a routing policy: **send each task to the cheapest model that completes it**. It then shows how to check whether the policy actually saves money.

The SDK gives you three places to route:

| Where | SDK surface | Typical router |
|---|---|---|
| Per call | `query({ options: { model } })` | Rules (free) or a cheap classifier (one more billed call per task) |
| Mid-session | `q.setModel(id)` in a streaming-input session | A cascade: start cheap, escalate when a check fails |
| Per agent | `agents: { expert: { model } }` | A cheap orchestrator delegates hard work to a stronger subagent |

`result.modelUsage` is the bill for each model in one `query()` call. It covers the main loop, subagents and auxiliary calls. Use it to measure a router, not `total_cost_usd` alone.

Model IDs and prices (per million tokens, first-party API):

| Tier | Model ID | Input | Output |
|---|---|---|---|
| light | `claude-haiku-4-5` | $1 | $5 |
| standard | `claude-sonnet-5-5` | $2 | $10 |
| deep | `claude-opus-5-5` | $4 | $20 |

## The lab

13 tasks, each with one checkable answer, labeled light (4), standard (3) or deep (6). Examples: extract an invoice ID; classify sentiment; convert a time between time zones; predict what `[10, 9, 1].sort()` prints; solve a five-person lineup puzzle; count integers whose digits sum to 10; find the last three digits of 7^222. The tests compute the answer key (brute force, BigInt, `Date`) rather than trusting it.

Each call has no tools, a one-line system prompt, and structured output (`{ answer, confidence }`), so the routed model dominates the bill. It also gets 4 turns and a $0.10 budget threshold. The lab sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and drops inherited `CLAUDE*`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, so the route alone decides which model runs. Sessions use an isolated `routing-lab/config`.

### A · Tiers and tasks (offline)

The price table, the task set and the rule router's decision for each task. The rules: "how many / puzzle / positions" → deep, "extract / classify / convert" → light, otherwise standard. They misroute three tasks:
- "How many vowels…" is easy but goes to deep.
- "Compute 48271 × 9377" and "What are the last three digits…" are hard but go to standard.

### B · The naive projection (offline)

Price per token × assumed tokens per task. This spreadsheet says Haiku is 4× cheaper than Opus ($0.025 vs $0.101 for the set). Section C shows what actually happened.

### C · Eight strategies, live (billed)

| Strategy | What it does |
|---|---|
| `haiku`, `sonnet`, `opus` | One model for everything |
| `opus-low` | Opus with `effort: "low"`: the one-model alternative to measure before building a router |
| `rules` | Rule router → `query({ model })` |
| `classifier` | Haiku classifies the tier (structured output), then `query({ model })` |
| `cascade` | Haiku answers. If it reports low confidence or its answer fails the task's format check, `setModel("claude-opus-5-5")` runs in the same session and the task is asked again |
| `review` | Haiku drafts, then `setModel(Opus)` always checks the draft: draft-then-verify |

One run of each, during implementation (SDK 0.3.281). All 104 answers were correct:

| Strategy | Correct | Total cost | Cost per correct | Median time per task | Spend by model |
|---|---|---|---|---|---|
| haiku | 13/13 | $0.1415 | $0.0109 | 8.8 s | Haiku $0.1415 |
| sonnet | 13/13 | $0.0794 | $0.0061 | 5.9 s | Sonnet $0.0794 |
| opus | 13/13 | $0.0893 | $0.0069 | 5.8 s | Opus $0.0893 |
| opus-low | 13/13 | $0.0822 | $0.0063 | 7.5 s | Opus $0.0822 |
| **rules** | 13/13 | **$0.0739** | **$0.0057** | 5.2 s | Haiku $0.0069 · Sonnet $0.0315 · Opus $0.0354 |
| classifier | 13/13 | $0.1210 | $0.0093 | 13.8 s | router $0.0544 included |
| cascade | 13/13 | $0.1005 | $0.0077 | 8.8 s | Haiku only: 0 escalations |
| review | 13/13 | $0.3429 | $0.0264 | 12.9 s | Haiku $0.1097 · Opus $0.2333 |

What the numbers say:

- **Price per token is not cost per task.** Haiku 4.5 got every hard task right, but it thought at length to do it. On `power-mod` it spent $0.036 and 39 s, against $0.0097 and 6 s for Opus. On `weekday` it spent $0.023 and 30 s, against $0.0033 and 4 s for Sonnet. "Always Haiku" was the **most expensive** fixed strategy, the opposite of the projection.
- **The simple baselines are hard to beat.** Rules won by 7% over Sonnet alone. Opus at low effort was close to both, with one model and one prompt cache (caches are per model).
- **A classifier must cost less than it saves.** Its 13 routing calls cost $0.054, 45% of the strategy's bill. It also sent five of the six deep tasks to Sonnet; Sonnet solved them, so here that cost nothing.
- **A cascade only helps when the cheap model fails.** Haiku never reported low confidence and never produced a malformed answer, so the cascade cost the same as "always Haiku". Self-reported confidence cannot catch confident mistakes; cascade on a real check such as tests, a schema or a validator.
- **Escalating mid-session is not free.** `review` shows `setModel()` working on every task: both models appear in one `modelUsage`. Opus starts with a cold cache, because the cache Haiku wrote cannot be reused by Opus, and it re-reads Haiku's attempt.

These are single runs on a small set, not a benchmark. Move the task set into lesson 52's evals before choosing a policy.

### D · Routing inside one agent (billed)

A Haiku orchestrator (`tools: ["Agent"]`, built-in agents disallowed) classifies a sentence itself and delegates the lineup puzzle to `agents.expert` with `model: "claude-opus-5-5"`. One run: correct, $0.0243. In `modelUsage`, `claude-haiku-4-5` cost $0.0136 (7,710 input tokens, mostly the Agent tool definition, paid on every turn), and `claude-opus-5-5[1m]` cost $0.0107. The subagent ran on the 1M-context variant.

### E · Where a model name really resolves

`supportedModels()` (a control request, so no model turn) maps aliases to concrete models. Three tiny billed calls confirm it:

| Request | Billed model(s) |
|---|---|
| `model: "sonnet"` | `claude-sonnet-5` (not 5.5) |
| `model: "sonnet"` + `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `model: "claude-sonnet-5-5"`, nonessential traffic allowed | `claude-sonnet-5-5` **plus** `claude-haiku-4-5-20251001` (899 input tokens, $0.00094: 39% of that call) |

Three findings from building this lesson:

- **Aliases follow the CLI version.** With SDK 0.3.281, `sonnet` meant Sonnet 5. Pin explicit IDs in routing code. Use `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` to remap an alias centrally.
- **Hidden auxiliary calls.** Unless `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, Claude Code may make a call on its small fast model (`ANTHROPIC_SMALL_FAST_MODEL`). Setting that variable to Sonnet moved the call to Sonnet. Only `modelUsage` shows it.
- **`modelUsage` keys are raw model strings**, for example `claude-opus-5-5[1m]` or the dated Haiku ID. Group by `canonicalModel` if you aggregate.

## Apply it to your agent

1. Build a graded task set from real traffic. Without one, a router is a guess.
2. Measure the one-model baselines first, including your strongest model at lower `effort`. If one of them wins, skip the router.
3. Compare strategies by cost and latency **per correct answer**, from `modelUsage`.
4. Keep the router cheaper than its savings: rules are free but brittle, and a classifier adds a call per task.
5. Cascade on a real verifier, not on self-reported confidence. Remember that escalation pays a cold cache.
6. For agents, give subagents their own `model`, and measure the orchestrator's fixed overhead.
7. Pin model IDs. Use `fallbackModel` (lesson 14) for availability, not quality, and keep `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in mind when you compare bills.

Reference: [Model configuration](https://code.claude.com/docs/en/model-config), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Implementation and verification

- `server/routing/workshop.ts`: models and prices, the 13 tasks, grading, the rule router, the classifier and answer schemas, the cascade's `needsEscalation()` check, and the offline projection.
- `server/concepts/59-model-routing.ts`: `/facts`, `/code` and `/plan` (offline); `/models` (`supportedModels()`, no model turn); `/run` (one strategy, live SSE; three tasks at a time; 240-second deadline); `/delegate` (subagent model, live SSE); `/resolution` (three tiny calls). Inputs are validated with zod, and only one live job runs at a time.
- `src/concepts/Concept59ModelRouting.tsx`: sections A–G.
- `server/routing/routing.test.ts`: the computed answer key and puzzle uniqueness, grading, rule misroutes, cascade decisions, projection order and HTTP validation.
- `server/routing/live-check.ts`: the billed command-line run that produced the tables above.

```powershell
npm run typecheck
npm run test:routing
npm run test:offline
npm run build
```

The tests make no model calls and do not start Claude Code.

For the browser check, stop the app and run `node --env-file-if-exists=.env --import tsx server/routing/browser-smoke.mjs`. It needs Chrome at the default Windows path and free ports 3059, 5189 and 9232. It checks navigation, the task table and its three misroutes, the projection, one real `supportedModels()` call and mobile width. It saves a screenshot under the ignored `routing-lab/browser-smoke/`.

Verification passed: typecheck, production build, all 117 offline tests (seven of them for lesson 59) and the headless Chrome check. The live runs above, including delegation and resolution, cost about $1.06. The probes made while building cost about $0.40 more.

## Steps followed to build this sample

1. Copied sample58 and moved the ports to 3059 (server, Vite proxy and the lessons 56–58 smoke scripts).
2. Read the SDK 0.3.281 typings: `model`, `fallbackModel`, `setModel()`, `supportedModels()` / `ModelInfo.resolvedModel`, `AgentDefinition.model`, `ModelUsage`, `effort` and `outputFormat`. Took the current model IDs and prices from the Claude API reference.
3. Probed the real behavior with a few cents of calls. This surfaced the auxiliary small-model call, the `sonnet` → Sonnet 5 alias, `setModel()` escalation inside one session, and the `[1m]` subagent model key.
4. Built the task set. Haiku solved the first "hard" tasks, so I added three harder ones; it solved those too, but slowly and expensively. That changed the lesson's headline from accuracy to cost per completed task. I added the `review` strategy so the escalation path still runs on every task.
5. Added the route, tests, UI, navigation, the browser check and this document, then ran all eight strategies live.
