# Multi-agent orchestration

This file explains Concept 47 (**multi-agent orchestration**) of the Claude Agent SDK Lab. One agent with every tool
and a long prompt gets slow, expensive and confused. Several **specialists** do better: each has a short prompt, only
the tools it needs, and a clear output. Someone has to **orchestrate** them: split the job, run the parts (in
parallel when they are independent), check what comes back, and merge it. Concept 8 introduced subagents; this concept
puts several agents to work together, in the two ways the SDK allows:

- **Model-driven**: one `query()`. A lead agent decides who does what and calls the `Agent` tool; Claude Code runs
  the workers. Your code watches and checks through hooks.
- **Code-driven**: your code is the orchestrator. Every agent is its own `query()`, and your code decides the order,
  runs them in parallel, checks their structured output, stops them and passes the data on.

**Goal:** run a lead with parallel workers and a quality gate; see a 3-level tree and a message sent to a running
worker; build a pipeline, a fan-out with limits and a budget, and an evaluator loop in code; know which way fits
which job.

| Concept | Topic | Routes |
|---|---|---|
| 47 | Multi-agent orchestration: `agent` (the main-thread agent), parallel `Agent` calls, `SubagentStop` with `decision: "block"` and `stop_hook_active`, `spawn_depth`, `task_started` / `task_progress` / `task_notification`, `PreToolUse` with `agent_id`, `Agent(type)` scoping, `run_in_background` + `name` + `SendMessage`, the `Agent` `tool_use_result` (`AgentOutput`), `outputFormat` + zod handoffs, a concurrency limiter, `Promise.allSettled`, `maxBudgetUsd` and a budget guard, a writer session + a critic loop, a checklist | `/api/c47/facts`, `/orchestrator`, `/hierarchy`, `/pipeline`, `/fanout`, `/evaluator` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/47-multi-agent.ts` | **New**: the lab data (5 regional CSV files, an inbox), the lane options, `orchestration()` (stream + hooks → one row per agent), `runAgent()`, `limiter()`, `chatSession()`, the quality gate, the five scenarios, the routes |
| `server/index.ts` | Mounts the router on `/api/c47` |
| `src/concepts/Concept47MultiAgent.tsx` | **New**: the tab, Parts A to H, with the agent timeline |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The timeline bars (depth 1, depth 2, background, failed, stopped) |
| `.gitignore` | Ignores `orchestra-lab/` |
| `Tab1-query().md` | Adds Concept 47 to the table and the project tree, the sample47 path |

No new package.

---

## Step 1: The smallest example of each way

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// MODEL-DRIVEN: the lead is the main thread; it starts the workers with the Agent tool.
const q = query({
  prompt: "Produce the sales report for the regions north, south and east.",
  options: {
    agent: "lead",                                  // = the --agent CLI flag: its prompt, tools and model run the main thread
    agents: {
      lead:    { description: "Coordinates the analysts", prompt: "Start one analyst per region, all in ONE message…", tools: ["Agent(analyst)"] },
      analyst: { description: "Analyses one region",       prompt: "Read <region>.csv… reply REGION=…; TOTAL=…; BEST=…", tools: ["Read"], maxTurns: 4 },
    },
    tools: ["Agent", "Read"],                       // the pool: each agent gets the overlap with its own list
    hooks: { SubagentStop: [{ hooks: [qualityGate] }] },
  },
});

// CODE-DRIVEN: your code runs every agent, with its own prompt, tools and schema.
const tickets = await runAgent("extractor", "Read inbox.txt…", { tools: ["Read"], outputFormat: schema(Tickets) });
const answers = await Promise.all(tickets.map((t) => limit(() => runAgent(t.category, …, { systemPrompt: POLICY[t.category] }))));
```

| | model-driven (the `Agent` tool) | code-driven (one `query()` per agent) |
|---|---|---|
| who plans | the lead model: how many workers, which ones, what to tell them | your code: the order, the fan-out and the retries are written down |
| parallel | several `Agent` calls in **one** assistant message run at the same time | `Promise.all`, with your own concurrency limit |
| handoff | the worker's final text becomes the `Agent` tool_result | `structured_output` (`outputFormat`), checked with zod before the next stage |
| checking | hooks: `SubagentStop` (block + reason sends the worker back), `PreToolUse` | plain code between the calls |
| cost per agent | estimated from each `Agent` `tool_use_result.usage`; `modelUsage` splits by model, not by agent | exact: each `query()` has its own `total_cost_usd` and `maxBudgetUsd` |
| good for | open-ended jobs where the split is not known in advance | repeatable workflows, auditing, SLAs, budgets |

The lab's data: five regional CSV files (`north.csv` … `central.csv`, 5 products each) and an `inbox.txt` with five
customer emails. The server knows every right answer (total 4,845 units, East is the top region), so it can check what
the agents report. Every agent is Haiku 4.5 with thinking off.

## Step 2: One row per agent (the lab's instrument)

The timeline in every part is built from what the SDK already sends. In a model-driven run:

| Source | What it gives | Depth |
|---|---|---|
| `system/task_started` | `tool_use_id` (the row's id), `task_id` (= the agent's `agent_id`), `subagent_type`, `spawn_depth`, `is_backgrounded`, `prompt` | every depth |
| `system/task_progress` | `description` (e.g. "Reading east.csv"), `usage.total_tokens`, `tool_uses` | every depth |
| `system/task_notification` | `status`, `summary` (the report), `usage.duration_ms` | every depth |
| `user` message with `tool_use_result` | the `Agent` tool's `AgentOutput`: `resolvedModel`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage` | the agent that made the call is at most depth 1 |
| `assistant` / `user` messages with `parent_tool_use_id` | the worker's tool calls and results | **depth 1 only** |
| `PreToolUse` hook | `tool_name`, `tool_input`, and `agent_id` (absent on the main thread) | every depth |

```ts
const preToolUse: HookCallback = async (input) => {
  if (input.tool_name === "Agent") callerOf.set(input.tool_use_id, input.agent_id ?? "main"); // who starts whom
  else emit("tool", { row: row(input.agent_id), name: input.tool_name, input: input.tool_input }); // every depth
  return {};
};
// task_started: rowOf.set(m.task_id, m.tool_use_id); parent = callerOf.get(m.tool_use_id)
```

The row of a worker is the id of the `Agent` tool_use that started it. Its `task_id` is the same value as the
`agent_id` in the hooks of everything it does, so the two maps give the whole tree. In a code-driven run the row is
simply one `runAgent()` call (a `query()`), and its cost is exact.

## Step 3: Orchestrator and workers, with a quality gate (Part B, about $0.03)

`agent: "lead"` makes the main thread the lead: its system prompt, its tools (`Agent(analyst)` only) and its model. The
lead writes each analyst's prompt itself (one run: just `north`; another: "Analyze the sales data for the North
region. Provide: total units sold and the best-performing product by units."). It starts all three in one message, so they run in parallel. A lab
`PreToolUse` hook also forces `run_in_background: false` (Concept 8's trick), so the lead waits for the reports.

```ts
function qualityGate(emit): HookCallback {
  return async (input) => {
    if (input.agent_type !== "analyst") return {};
    const m = input.last_assistant_message.trim().match(/^REGION=(\w+);\s*TOTAL=(\d+);\s*BEST=(P\d)$/i);
    const problem = !m ? "Your report must be ONE line in exactly this format: …"
      : Number(m[2]) !== truth(m[1]).total ? `TOTAL=${m[2]} is wrong. Read the file again…` : null;
    if (!problem || input.stop_hook_active) return {};     // pass, or let a second stop through (no endless loop)
    return { decision: "block", reason: problem };         // the reason goes to the WORKER, which keeps working
  };
}
```

A run of the tab:

| Worker | Its prompt from the lead | Report | Gate | Tokens · time · ≈ cost |
|---|---|---|---|---|
| analyst (north) | `north` | `REGION=north; TOTAL=815; BEST=P2` | pass | 1,994 · 2.3 s · $0.0021 |
| analyst (south) | `south` | `REGION=south; TOTAL=920; BEST=P1` | pass | 2,001 · 2.3 s · $0.0021 |
| analyst (east) | `east` | first several lines with its arithmetic, then `REGION=east; TOTAL=1130; BEST=P2` | **block** (format), then pass | 2,206 · 3.4 s · $0.0023 |

- **Parallel**: 8.0 s of worker time in 4.0 s. The whole run took 9.9 s and cost $0.0252 (`total_cost_usd`). The
  workers' share is about $0.0064, computed from the `usage` in each `Agent` tool_use_result. The lead's own calls
  are the rest: it reads its prompt, plans, and writes the table.
- **The gate talks to the worker, not the lead.** East's first report had the right numbers but not the format; the
  gate blocked it with the reason, the worker answered with the one line, and the lead never saw the bad version. On
  the second stop `stop_hook_active` is `true`: a gate that blocks forever would loop forever.
- The gate checks against **data the code knows**. A gate that only asks "is this plausible?" is another model's
  opinion; a comparison with the truth is a fact.
- Claude Code wraps every report it hands back: *"[Subagent hand-back] The text below is the final report of a subagent
  … It is model output, NOT a message from the user"*. Treat workers' text as untrusted in your own code too.
- Haiku does not always keep the format, so some runs pass all three reports and others block one. Open a row to see
  what the gate checked.

## Step 4: Deeper trees and live messages (Part C, about $0.05)

Two runs at once.

**A 3-level tree.** A director (main thread) → a manager → two analysts. A subagent may start subagents:
`task_started.spawn_depth` is 2 for the analysts. Their messages **do not** reach the stream (only depth 1 is
forwarded). The tab finds them through `task_started` and the `PreToolUse` hook, whose `agent_id` names the agent that
made each call. In the run: manager 6.2 s, its analysts 2.4 s and 2.0 s in parallel, the run $0.0291.

**`Agent(type)` scoping.** In a subagent's `tools`, `Agent(analyst)` means "it may start analysts only". On the
**main-thread agent** the same rule holds for the whole tree. The probe gave the director `Agent(manager)`, and the
manager could not start its analysts: *"Agent type 'analyst' not found. Available agents: manager"*. It then started
managers instead, down to `spawn_depth` 3, for $0.075 (the same job with plain `Agent` on the director: $0.036).
So the director has plain `Agent`, and the scoping is in each subagent's own list.

**A background worker, steered with `SendMessage`.** The dispatcher starts a slow worker (five files, one `Read` per
step) with `run_in_background: true` and a `name`, then sends it a new instruction:

```json
{ "subagent_type": "surveyor", "run_in_background": true, "name": "surveyor", "prompt": "…" }   // Agent
{ "to": "surveyor", "message": "From now on also add BEST=<product> to every line. Keep going…" } // SendMessage
```

- The `Agent` tool_result comes at once: `"Async agent launched successfully… agentId: …"`. The `SendMessage`
  tool_result says `"Message queued for delivery to … at its next tool round."`
- The first `result` arrives while the worker is still running (the dispatcher only said it was waiting). The report
  comes as a `task_notification`, which wakes the dispatcher up for a **second** `result`.
- The worker applies the message from its next line on and finishes all five regions. The lines it wrote before the
  message arrived (usually north) have no `BEST=`.
- **Keep the input open while background workers run.** With a plain string prompt, Claude Code's input is closed at
  once, and then it *"kills hold-back tasks at the held-result release"* (sdk.d.ts). The first version of this lane
  did that: in every run the worker was cut off after two or three files ("I was stopped while attempting to read
  east.csv… awaiting further instructions", once "I'm receiving permission blocks"), and a resume sent after the first
  `result` never ran. The lane now passes a streaming-input prompt (Tab 12) that stays open until nothing has happened
  for 4 s while no background task runs (`system/background_tasks_changed`), or 120 s at most:

```ts
function heldOpenPrompt(text: string, abort: AbortController, maxMs = 120_000) {
  let close = () => {};
  const closed = new Promise<void>((r) => (close = r));
  async function* prompt() {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    await closed;                              // the session lives as long as this generator does
  }
  return { prompt: prompt(), close };
}
```

- A message to a worker that has **already finished** starts it again, with the message as its prompt (a new
  `task_started` with the same description). The dispatcher uses that: it checks that every region has a line **and**
  every line has `BEST=`, and sends the worker back for what is missing ("north has no BEST"), at most twice. In the
  run: results #2 and #3 were the dispatcher waiting for the corrections, result #4 the complete report ($0.0437).
- **The code checks the orchestrator's answer.** A probe dispatcher wrote "All five regions have been surveyed with …
  BEST for each region" above a north line without `BEST`. A model's summary is a claim, so the route reads the final
  answer and compares every region's line with the data (a table under each lane of Part C: total, best product).
- **The code supervises, and can correct.** Later runs showed a worse case: the worker **guessed** north's `BEST`
  (P1 twice, then P3) without reading the file again, and the dispatcher, which cannot know, accepted it. Because
  this lane's session is held open, the code can talk to the orchestrator: when the session goes quiet, it checks the
  last answer and, if something is wrong, pushes **one** more user turn into the same session:

```ts
const onIdle = () => {
  if (running > 0) return;                                        // a worker is still busy
  const problems = checkReport(lastAnswer, regions).filter((c) => c.total !== "ok" || c.best !== "ok");
  if (!problems.length || corrections >= 1) return held.close(); // right, or already corrected once: stop
  corrections++;
  held.push(`Your code checked your report against the data. Wrong or missing: north (best wrong (P2)). Have the surveyor READ those files again…`);
};
```

  Two runs in a row: the first was right without help; in the second the code caught `BEST=P3`, the dispatcher sent the
  worker back, the worker re-read north.csv, and the final answer passed for all five regions (four results, $0.04).
  One correction and then stop: if it is still wrong, the tab reports the gap instead of looping.
- Lesson: a one-shot `query()` is for foreground work. Background workers need a session that stays open until they
  report; the orchestrator should check the report, and your code should check the orchestrator.

## Step 5: A pipeline, orchestrated by your code (Part D, about $0.03)

Three stages, seven `query()` calls:

| Stage | Agent(s) | Output (the handoff) | Run |
|---|---|---|---|
| 1 extract | one extractor with `Read` and `outputFormat: Tickets` | `{ tickets: [{ id, customer, category, urgency, summary }] }`, checked with zod | 7.0 s, $0.0076 |
| 2 route + answer | the router is **code** (category → specialist); 5 specialists, at most 3 at a time, each with its own policy as `systemPrompt` and `outputFormat: Reply` | `{ reply, escalate, reason }` per ticket | 4.3–5.3 s each, $0.0151 together |
| 3 edit | one editor, no tools, `outputFormat: Digest`, sees only stage 2's data | `{ digest, escalations: [2, 3, 4] }` | 5.0 s, $0.0039 |

```ts
const parsed = Tickets.safeParse(ex.structured);
if (!parsed.success) return stage(1, { error: "the extractor's output does not match the schema: …" }); // stop HERE
const answers = await Promise.all(tickets.map((t) => limit(() => runAgent(`t${t.id}`, …, { systemPrompt: SPECIALISTS[t.category].systemPrompt, outputFormat: schema(Reply) }))));
```

- The whole pipeline: 21 s, about $0.026. The timeline shows the limit: ticket 4 starts only when ticket 1 ends.
- **The handoff is data, not a conversation.** Each stage gets a JSON value in its prompt, never the transcript of the
  stage before. A stage that returns the wrong shape stops the pipeline at once, not three stages later.
- The specialists applied their policies: a duplicate charge refunded at once, a refund after 45 days escalated (the
  policy allows 30), the error 500 escalated as an incident, 15% for 50 seats with a follow-up by a human.
- The code checks the result too: every ticket a specialist escalated must be in the digest's `escalations`. None was
  missing.
- Each specialist saw one ticket and one policy: it cannot mix another customer's data into its answer.
- **Rules must leave no room.** With "urgency is high when a customer is blocked", two runs disagreed on tickets 4
  and 5 (is a user without a password "blocked"?). The rule now says "high ONLY when the customer was charged wrongly
  or a whole team cannot work; everything else is low", and the next run gave high, high, low, low, low.

## Step 6: Fan-out and fan-in, with limits, failures and a budget (Part E, about $0.04)

Six workers (one per region; `islands.csv` does not exist), each a `query()` with `tools: ["Read"]`,
`outputFormat: RegionReport`, `maxTurns: 4` and `maxBudgetUsd: 0.03`:

```ts
const limit = limiter(b.limit);          // at most N Claude Code processes at a time
const guard = childAbort(abort);         // one switch for every worker
const settled = await Promise.allSettled(REGIONS.map((region) => limit(async () => {
  if (guard.signal.aborted) throw new Error("skipped: budget reached");
  const r = await runAgent(region, …, { outputFormat: schema(RegionReport), abortController: childAbort(guard), maxBudgetUsd: 0.03 });
  if ((spent += r.cost) > b.budgetUsd) guard.abort();          // stop the running ones, skip the rest
  const check = verify(region, r.structured);                  // compare with the truth
  return { ...r.structured, check };
})));
// fan-in: an aggregator gets ONLY the verified results, and the list of what is missing
```

| Run | What happened |
|---|---|
| limit 3, budget $0.10 | Peak concurrency 3; each new worker started when one ended. All six right (islands: `found: false`, "ok: reports the file as missing"). About $0.0064 per worker, $0.0398 with the aggregator, 16.6 s. The aggregator's summary: 4,845 units, East on top, islands missing. |
| limit 2, budget $0.008 | After north and south ($0.0128) the guard fired: west, central and islands were **never started**. East finished at the same moment and its answer was kept. |

- **`Promise.allSettled`, not `Promise.all`**: one failed worker must not throw away the others' work.
- **Tell the aggregator what is missing.** It gets the verified results and "Regions without a verified result:
  islands", so it cannot invent a number for them.
- **The code does the arithmetic, the aggregator the words.** A run of the first version wrote "4,845 (combined total
  from north, south, east, and west regions)": the right total, but central left out of the list. Now the code
  computes the total and the top region and passes them in ("use the numbers above exactly; do not compute anything"),
  and checks the summary afterwards: it states 4,845, names the top region, names every verified region and says
  islands is missing. The next run: all eight checks passed.
- **Every worker is a Claude Code process.** A code-driven worker cost about $0.0064: each `query()` starts a process
  (about 1.5–2 s) and sends Claude Code's own system prompt and the `StructuredOutput` tool. A subagent in Part B
  cost about $0.0021 for the same file. Code-driven buys control and exact accounting; model-driven is lighter
  per worker, but the lead's calls come on top.

## Step 7: Evaluator and optimizer (Part F, about $0.02)

A writer and a critic that want different things: an enthusiastic copywriter in **one session** (streaming input,
Tab 12, so it keeps its draft and the brief) and a strict editor, a **new** `query()` every round, which returns
`{ approved, score, issues }`. The work is split by **who can judge it**:

| Checked by | Rules |
|---|---|
| the code (`codeChecks()`, exact, free) | at most 60 words, mentions 4,845, names East, no "!" |
| the critic (the `RUBRIC`) | a sober tone (no hype words, no emojis); every number matches the facts; no fact that is not in the facts (no quarter name, no percentages, no growth claims) |

The critic is told not to judge length, word counts, "!" or the total. The first version gave it every rule, and two
things went wrong:
- It rejected a draft of exactly 60 words (the code: ✓) as "approximately 67 words", and cost a round. Its counts were
  always guesses: "~130" for 100, "~75" for 70, "100+" for 79.
- It approved "Q3 Sales Results", which the writer invented (the facts only say "quarterly"). A rubric only catches
  what it names.

A run with the split:

| Round | Draft | Code checks | Critic | Cost |
|---|---|---|---|---|
| 1 | "🚀 RECORD-BREAKING QUARTER! … crushed it … ON FIRE…" | ✗ 100 words, ✗ 6 "!" | rejected, score 2: emojis, superlatives, "speculation and growth claims not in the facts (momentum, excellence…)" | $0.0074 |
| 2 | "Quarterly Sales Results … This strong performance reflects…" | ✓ 56 words | rejected, score 6: "'strong performance' is a claim not in the facts", "interpretive commentary" | $0.0054 |
| 3 | "Quarterly Sales Results: Our team delivered 4,845 units… East led with 1,130…" | ✓ 36 words | **approved**, score 10 | $0.0051 |

- Total $0.0179 in about 27 s. The feedback of each round is the code's failed checks plus the critic's issues, sent as
  the next turn of the same writer session.
- **Counting is a job for code, tone is a job for a model**: now each rejection is about something only that side can
  judge, and no quarter name survives.
- **Cap the rounds.** A writer and a critic that disagree loop, and bill, forever.
- **Stop on a failure.** An API error (here: *"Credit balance is too low"*) ends a run as `subtype: "success"` with
  `is_error: true` and the error as its text. The first version fed that text to the critic as a draft; now the loop
  stops, and `runAgent()` never passes an `is_error` result on as an answer.

## Step 8: A checklist for multi-agent systems (Part G)

| Rule | How, in the SDK | Seen in |
|---|---|---|
| Give each agent one job | `AgentDefinition`: a short prompt, only the tools it needs, `maxTurns`; or one `query()` with its own `systemPrompt` | B, D |
| Workers start from zero | A subagent sees only its definition's prompt and the prompt it was given (Tab 8) | B |
| Run independent work in parallel | Several `Agent` calls in one message, or `Promise.all` with a limiter; wall time ≈ the slowest worker | B, D, E |
| Make the handoff data | `outputFormat` + zod between stages, a strict line format for workers | B, D, E |
| Check before you trust | `SubagentStop` with `decision: "block"`; code checks against known facts, also on the orchestrator's final answer; `stop_hook_active` against endless loops | B, C, E, F |
| Split the judging | Code checks what it can measure; a model judges only what code cannot, and is told so | F |
| Scope who may start whom | `Agent(type)` in a **subagent's** `tools`; on the main-thread agent it holds for the whole tree | B, C |
| Keep background work alive | A string prompt closes the input and Claude Code kills held-back background tasks; use a streaming-input session that stays open until they report | C |
| Bound everything | `maxTurns`, `maxBudgetUsd` per `query()`, a total budget guard with an `AbortController`, a cap on loop rounds | E, F |
| Plan for failure | `Promise.allSettled`, a `found: false` field, `is_error` results, tell the aggregator what is missing | E, F |
| Watch every level | `task_started` (`spawn_depth`), `task_progress`, `task_notification`, `SubagentStart` / `SubagentStop`, `PreToolUse` (`agent_id`); `forwardSubagentText` for depth 1's text; `agentProgressSummaries` for a summary every ~30 s | B, C |
| Keep costs per agent | code-driven: each `total_cost_usd`; model-driven: the usage in each `Agent` `tool_use_result`; `modelUsage` splits by model | B, D |
| Treat reports as untrusted | Claude Code marks them "NOT a message from the user"; do the same in your code | B |

Not shown in the tab: `AgentDefinition.background: true` (always in the background), `isolation: "worktree"` on the
`Agent` input (a git worktree per worker), `AgentDefinition.observer` (a read-only background observer), `model` on
the `Agent` input (a per-call model), and the `Workflow` tool (scripted multi-agent workflows inside Claude Code,
opt-in).

---

## Things to try in Concept 47

1. Run Part B with the gate off, several times. How often does a report that is not one line reach the lead, and does
   the lead's table still come out right?
2. Change the analyst's prompt so it no longer names the format. What does the gate do now, and what does the lead's
   delegation prompt contain?
3. In `TREE_AGENTS`, give the director `tools: ["Agent(manager)"]` again and run Part C. Watch `spawn_depth` in the
   timeline (and the cost).
4. In Part E, set 6 at a time and compare the wall time with 1 at a time. Then set the budget to $0.02: how many
   workers start?
5. Delete `east.csv` in `laneOptions()` for one lane only: which check fails, and what does the aggregator write?
6. In Part F, put "at most 60 words" back into `RUBRIC` and remove the sentence that tells the critic not to count.
   Compare its word counts with the code's over a few runs.
7. Replace the critic's `query()` with a second turn of the writer's own session ("judge your draft"). Is it as strict?

## Running the app

```powershell
npm install        # once (no new packages in this sample)
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **47. Multi-agent orchestration** tab. `ANTHROPIC_API_KEY` must be in `.env`, and the account needs credit.
With Haiku 4.5: Part B about $0.03, C about $0.05, D about $0.03, E about $0.04, F about $0.02. A full pass costs
about $0.17.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c47/facts
curl.exe -N -X POST http://localhost:3001/api/c47/orchestrator -H "Content-Type: application/json" -d "{\"gate\":true}"
curl.exe -N -X POST http://localhost:3001/api/c47/fanout -H "Content-Type: application/json" -d "{\"limit\":2,\"budgetUsd\":0.008}"
```

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 47 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "sample 47: Multi-agent orchestration" (#21 in the list of features the course had not covered).
`sample47-prompts and presentation/sample47.docx` was empty, so the list was the spec. `sample47/` was a copy of
sample46 without `node_modules` and without its readme; `npm install` restored the packages.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab8-Subagents.md`, `08-subagents.ts` | What is already covered (`agents`, the `Agent` tool, `parent_tool_use_id`, the foreground hook, `task_*`), so this concept builds on it instead of repeating it |
| `Tab46-…md`, `46-prompt-caching.ts`, `Concept46PromptCaching.tsx` | The latest style: lanes, `sseRoute()`, `#region` + `/code`, the retrying `/facts`, "Steps followed" |
| `10-structured-interrupt.ts`, `Tab12`, `Tab15`, `Tab20` | `outputFormat` with `z.toJSONSchema`, streaming input sessions, running cost totals, `Stop` / `SubagentStop` |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the waterfall CSS of Concept 44 to reuse |

### Build step 3: Read the types

| Found | Used for |
|---|---|
| sdk.d.ts: `agent`, `AgentDefinition` (`maxTurns`, `background`, `observer`, `effort`…), `agentProgressSummaries`, `SDKTaskStartedMessage.spawn_depth`, `SubagentStopHookInput.last_assistant_message`, `SubagentStopHookSpecificOutput`, `modelUsage` ("main loop, Task subagents…") | Steps 2 to 4 |
| sdk-tools.d.ts: `AgentInput` (`run_in_background`, `name` "addressable via SendMessage", `model`, `isolation`), `AgentOutput` (`completed` with usage and totals, `async_launched`) | Steps 2 to 4, Part A's table (read live by `/facts`) |

### Build step 4: Probe before designing

Four scratchpad scripts (not part of the project) ran `query()` with Haiku 4.5:

| Probe | Result | Decision |
|---|---|---|
| `agent: "lead"`, 3 analysts, a `SubagentStop` that blocks the first report | The 3 `task_started` 0.5 s apart, all done at 13–14 s: parallel. The blocked worker fixed its report; second stop had `stop_hook_active: true`. `tool_use_result` = `AgentOutput` with usage. `task_progress` came without `agentProgressSummaries` (those only every ~30 s) | Part B with a gate that checks against the data; the per-worker cost from `tool_use_result` |
| A manager with `Agent(analyst)`; `SendMessage` to a background worker; a Sonnet analyst | `spawn_depth: 2`, depth-2 messages missing from the stream, visible in `PreToolUse` with `agent_id`; `SendMessage` "queued for delivery at its next tool round"; `modelUsage` split into Haiku and Sonnet | Part C; the row mapping through hooks |
| The director (main-thread agent) with `Agent(manager)` vs plain `Agent` | Restricted: "Agent type 'analyst' not found. Available agents: manager", managers down to depth 3, $0.075; plain: $0.036 | Plain `Agent` on the director; documented in Step 4 |
| A slow background worker + `SendMessage` | The message applied from the next line, then the worker ended early "awaiting instructions" | First documented as `SendMessage` behavior; the review (Build step 8) found the real cause: the closed input of a one-shot run |

### Build step 5: Design the concept

- **One instrument for model-driven runs**, `orchestration()`: the stream, the `task_*` messages and a `PreToolUse`
  hook become one event per agent (`agent-start`, `tool`, `agent-progress`, `agent-end`, `agent-report`), so one
  **timeline** component shows every part.
- **One helper for code-driven runs**, `runAgent()`: a `query()` as a timeline row, with its exact cost and its
  `structured_output`; plus `limiter()`, `childAbort()` and `chatSession()`.
- **Data the server knows**, so the gate (Part B), the checks (Part E) and the code checks (Part F) compare with facts.
- **Five scenarios**, from the model deciding everything (B, C) to the code deciding everything (D, E, F).

### Build step 6: Implement it

| File | What |
|---|---|
| `server/concepts/47-multi-agent.ts` | `SALES`, `truth()`, `INBOX`, `laneOptions()`, `orchestration()`, `estimate()`, `runAgent()`, `limiter()`, `chatSession()`, `qualityGate()`, the five routes |
| `src/concepts/Concept47MultiAgent.tsx` | `buildRows()`, `Timeline`, `MainEvents`, Parts A to H |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md` | Mount, tab, styles, `orchestra-lab/`, table row and tree |

`npx tsc --noEmit -p .` passed.

### Build step 7: Test the routes and the tab

The router was first mounted alone on a spare port and each route called with `curl -N`; then `npm run dev` ran the
whole lab and a headless Chrome (driven over the DevTools protocol) opened tab 47, pressed the five buttons and took a
screenshot. What the tests changed:

| Problem found | Fix |
|---|---|
| The gate passed east's report of several lines: the pattern matched anywhere in the text | The pattern is anchored (`^…$`) on the trimmed report: the format is part of the contract. The next UI run blocked east once, and the worker fixed it |
| A `PreToolUse` hook parsed a cut JSON string: a long tool input would have thrown inside the hook | The tool input is sent as a cut string |
| A background launch was filtered out: its `tool_use_result` also has an `agentId` | `async_launched` is its own event ("Async agent launched") |
| The multi-line doc comments in `/facts` kept their `*` and the `@example` | `flat()` strips the line prefixes and cuts at `@example` |
| The director's `Agent(manager)` stopped the manager from starting analysts | Plain `Agent` on the director (Build step 4) |
| The dispatcher's worker finished before `SendMessage` arrived | A slow worker (five files, one `Read` per step), and a prompt that says to keep going |
| East finished just as the budget guard fired, and was shown as "completed" **and** "aborted" | An abort after the result does not undo the answer |
| The API key ran out of credit in the middle of Part F: "Credit balance is too low" came as `subtype: "success"`, `is_error: true`, and the loop sent it to the critic as a draft | `runAgent()` and `chatSession()` check `is_error`; the loop stops on a failed writer or an invalid verdict. Tested with the empty balance: Parts D, E and F now stop at once and say why |
| The long `SendMessage` input overflowed its card; the selects stacked their labels | CSS: `overflow-wrap: anywhere`, inline labels |
| A pass with no API credit (every call refused) still printed success summaries: "0 workers, 0.0 s of work in 0.0 s: they ran in parallel", "the gate passed every report this time", "the aggregator was told…" with no aggregator, "0 round(s)", and an empty `modelUsage` | A banner names the refusal and what to do (add credit, or leave the key empty to use the Claude Code login). Each summary appears only when agents did their job; otherwise the part says what failed ("The lead failed before it could start any worker…", "the aggregator was not started"). "They ran in parallel" only when the work time exceeds the wall time |

### Build step 8: Review of a full pass

A full pass with credit was read line by line. Every number the agents reported was right (the gate, the checks and
the digest list agreed with the data). Five things were not:

| Problem in the output | Fix |
|---|---|
| Part C, left: the director's table had the columns "Sales \| Priority" and said "P4 priority level": it relabeled the best product | The director is told the exact columns (region \| total units \| best product) and not to rename anything; the manager passes the analysts' lines on as they are. The next runs: the right table |
| Part C, right: the surveyor stopped after two regions and the dispatcher ended with "waiting for direction"; a resume never ran | The cause was the closed input of a one-shot run, not `SendMessage` (Step 4). The lane keeps its input open until it is idle; the dispatcher resumes a worker whose report is incomplete. Two runs in a row: all five regions |
| Part D: the digest said "Two critical escalations" next to a list of three | The digest must name every escalated ticket as `#<id>`, and the code checks the text as well as the list (missing, not named, listed without being escalated) |
| Step 3 said the lead gives each analyst only its region name; in this pass it wrote a full sentence | Step 3 shows both prompts: the lead writes them, and they vary |
| "result #2 · $0.0227" read as the cost of the second result | The label says `total_cost_usd`, and "(running total)" from the second result on |

### Build step 9: Review of a second full pass

Every number was right again, but four answers contradicted the data or the checks:

| Problem in the output | Fix |
|---|---|
| Part C, right: the dispatcher wrote "BEST for each region" above a north line without `BEST=`: it only checked that five lines exist | The dispatcher checks every field and sends the worker back for what is missing; the route checks the final answer against the data (a table under each lane). The next runs: north corrected, all five ok |
| The first version of that check read "Here are the results for the west and central regions:" as the west row and reported it wrong | It reads `REGION=<region>` if present, else the last line that names the region with a number; tested offline on the texts of the runs (a table, a remark above the report, a missing and a wrong `BEST`) |
| Part F: the critic rejected a draft of exactly 60 words as "approximately 67", and approved an invented "Q3" | The rules are split: code checks the counts, the critic judges tone, numbers and invented facts, and is told not to count (Step 7) |
| Part D: the urgency of tickets 4 and 5 swapped between runs | A rule without room for interpretation (Step 5) |

### Build step 10: Review of a third full pass

| Problem in the output | Fix |
|---|---|
| Part C, right: the worker sent back `north … BEST=` (empty) after 1.1 s without reading the file; the dispatcher then wrote "the north region's best product could not be determined from its data" (it is P2). It had copied the lab's example message, which only asked to *send* the lines again | The example now says to READ the file again; the surveyor may never leave a field empty. When the worker still guessed (P1, P3), the code's check caught it, so the code now sends one correction turn into the held-open session (Step 4) |
| Part E: the aggregator wrote "4,845 (north, south, east, and west)", leaving out central | The code computes the total and the top region; the aggregator only words them, and the code checks its summary (Step 6) |
| The check table showed raw markdown rows ("west \| west \| 1,095 \| P4 \|") | Pipes, stars and backticks are removed from the shown line |
