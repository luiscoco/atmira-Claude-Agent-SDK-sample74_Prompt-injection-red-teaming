# Plan mode

This file explains Concept 32 (**Plan mode**) of the Claude Agent SDK Lab. With `permissionMode: 'plan'` the agent first
**looks** at the project (Read, Glob, Grep), writes a **plan**, and asks to leave plan mode with the built-in
`ExitPlanMode` tool. In the terminal, Claude Code shows the plan with "Would you like to proceed?". With the SDK,
**nothing is shown**: the plan reaches **your** `canUseTool`, and your code must show it, wait for the person, and send
back the decision.

**Goal:** build that approval dialog in your own UI. Know each decision you can send and what the model does with it,
how the mode changes afterwards, and who really keeps plan mode read-only (hint: not Claude Code alone).

| Concept | Topic | Routes |
|---|---|---|
| 32 | Plan mode: `permissionMode: 'plan'`, the plan file (`CLAUDE_CONFIG_DIR/plans/`, `plansDirectory`), `ExitPlanMode` in `canUseTool` (`plan`, `planFilePath`), approve with `updatedPermissions` `setMode` (`acceptEdits`) or without (the mode becomes `default`), an edited plan (`updatedInput.plan`, `planWasEdited`), keep planning (`deny` + feedback), cancel (`interrupt: true`), a host-side timeout, `system/status`, `EnterPlanMode`, `planModeInstructions`, a `PreToolUse` policy hook, who blocks writes in plan mode (the CLI without `canUseTool`, your `canUseTool` with it) | `/api/c32/who` (SSE), `/run` (SSE), `/decide`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/32-plan-mode.ts` | **New**: the options, `guard()` (the mode-aware `canUseTool`), `review()` (the pending plan), `/decide` and its checks, the policy hook, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c32` |
| `src/concepts/Concept32PlanMode.tsx` | **New**: the tab (Parts A to D), the plan card, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The plan card, the mode badges, plan rows |
| `.gitignore` | Ignores `plan-lab/` |
| `Tab1-query().md` | Adds Concept 32 to the table |

---

## Step 1: What happens in plan mode

Every run of the lab starts from a fresh copy of a tiny project (`cart.js` and `README.md`) in
`plan-lab/runs/<run id>/`. With `permissionMode: "plan"`, Claude Code adds a plan-mode reminder to the system prompt:
you may only read, and you may write one file, the plan. In the probes, Haiku 4.5 always did the same four things:

1. `Glob` and `Read` the project. The CLI approves these by itself: `canUseTool` is not asked.
2. `Write` the plan, as Markdown, to `CLAUDE_CONFIG_DIR/plans/<slug>.md` (for example
   `plans/add-a-discount-feature-sunny-falcon.md`). This write is also approved by the CLI.
3. Call `ExitPlanMode` with the plan.
4. Wait. Nothing in the project has changed yet.

`ExitPlanMode` takes no input of its own in the types (`ExitPlanModeInput` only has a deprecated `allowedPrompts`).
Claude Code fills it in, so `canUseTool` receives:

```ts
canUseTool("ExitPlanMode", {
  plan: "# Plan: Add Discount Feature to cart.js\n\n## Context\n…",   // the plan file's text
  planFilePath: "…/plan-lab/config/plans/add-a-discount-feature-sunny-falcon.md",
}, { signal, toolUseID, … })   // no suggestions
```

**Name the tool in the prompt.** With "When the plan is ready, ask me to approve it", 2 of 4 runs wrote the plan and
then ended the turn by asking **in plain text**, without calling `ExitPlanMode`. With "…submit it for my approval with
the ExitPlanMode tool", every run called it. The host check flags a run that never asked for approval.

## Step 2: The host decides in `canUseTool`

The lab keeps the call waiting inside `canUseTool` (`review()` in the `review` region), sends the plan to the browser
as an SSE event, and resolves the promise when the browser POSTs `/api/c32/decide`. This is the same pattern as the
question card of Concept 31. The four decisions, simplified from `toResult()` in
[server/concepts/32-plan-mode.ts](server/concepts/32-plan-mode.ts):

```ts
// Approve, and let the edits run without asking:
{ behavior: "allow", updatedInput: input,
  updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }

// Approve, but I will review each edit:
{ behavior: "allow", updatedInput: input }

// Keep planning:
{ behavior: "deny", message: "The user wants changes to the plan before approving it: <feedback>" }

// Cancel:
{ behavior: "deny", message: "The user rejected the plan and cancelled the job.", interrupt: true }
```

After an approval the model starts coding **in the same run**. Its tool_result:

```
User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: …/plans/add-a-discount-feature-sunny-falcon.md
You can refer back to it if needed during implementation.

## Approved Plan:
# Plan: Add Discount Feature to cart.js
…
```

and your code gets `tool_use_result: { plan, isAgent: false, filePath }` on the `user` message.

Claude Code sets **no time limit** on `canUseTool`. So the lab adds its own 3-minute limit, and it answers with
`deny` + `interrupt: true`: a plan that nobody reviewed must never be implemented. It does the same when the run's
`signal` is aborted.

## Step 3: The mode after approval

The approval changes the permission mode, and every change arrives as a `system/status` message:

| You return | `system/status` | Then |
|---|---|---|
| `allow` + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }]` | `permissionMode: "acceptEdits"` | Edits inside `cwd` no longer reach `canUseTool` |
| `allow`, no `updatedPermissions` | `permissionMode: "default"` | **Every** Edit and Write reaches `canUseTool`, with the suggestion `[{ type: "setMode", mode: "acceptEdits", destination: "session" }]` |
| `deny` (keep planning) | none | The mode stays `plan` |

So "approve" alone does **not** mean "approve and go": it means "leave plan mode, and ask me about each change". That
is the terminal's "Yes, and manually approve edits". To get "Yes, and auto-accept edits", send the `setMode` update.
The lab's two green buttons are exactly these two choices. With **Approve · I review each edit**, watch the orange
`canUseTool Edit` rows: the lab allows them, because they are inside the run folder.

## Step 4: Plan mode is NOT a sandbox

This is the most important result of the probes. What stops a Write to `cart.js` while the mode is `plan`?

The model does, most of the time. Asked "Do not plan. Use the Write tool right now to create hello.txt", Haiku replied
"I'm currently in plan mode, which means I can only take read-only actions". But that only comes from the prompt. Button
**0** makes the model try anyway (a system prompt append says "ALWAYS call the Write tool, even in plan mode") in three
setups:

| Setup | `ExitPlanMode` in the tool list | `canUseTool` asked | `hello.txt` |
|---|---|---|---|
| no `canUseTool` | **no** | — | denied by the **CLI**: "Cannot write to hello.txt while in plan mode.", plus a `system/permission_denied` message with `decision_reason_type: "mode"` |
| a `canUseTool` that allows everything | yes | yes | **WRITTEN**, in plan mode |
| the lab's `guard()` (wrapped in `noReview`, which refuses `ExitPlanMode` at once) | yes | yes | denied by the **host** |

With a `canUseTool`, the CLI does not deny the write. It **asks your function**, and your `allow` wins. Your function is
not even told the mode: the call carries `displayName: "Write"`, `description: "hello.txt"`, `toolUseID`, `requestId`,
no suggestions, and no `permissionMode`. And without a `canUseTool`, the agent can never leave plan mode, because
`ExitPlanMode` is not offered (see Step 7).

So the host must track the mode itself (the `guard` region; the full `guard()` is in Step 4 of "How it was built" below):

```ts
  return async (tool: string, input: Record<string, unknown>, { signal }: { signal: AbortSignal }): Promise<PermissionResult> => {
    if (tool === "ExitPlanMode") return review(run, emit, input, signal);
    const target = String(input.file_path ?? input.path ?? input.pattern ?? "");
    if (!path.resolve(run.work, target || ".").startsWith(run.work)) {
      // … emit a "blocked" event
      return { behavior: "deny", message: "Denied by the lab: only files inside the project folder." };
    }
    if (run.mode === "plan") {
      // … remember the call for the host check, emit a "blocked" event
      return { behavior: "deny", message: "Plan mode is read-only: nothing may change until the user approves your plan. Put this change in the plan instead." };
    }
    // … emit an "asked" event
    return { behavior: "allow", updatedInput: input };
  };
```

`run.mode` comes from `system/init` (`permissionMode`), from every `system/status`, and from the host's own approval.
The lab sets the mode **as soon as** it approves, because the model's first Edit can reach `canUseTool` before the
`system/status` message has been read. The rule is simple: in plan mode, the CLI has already approved every read-only
call, so **anything that still reaches you would change something**. Deny it.

Two more reasons to keep a path check after the approval. In an early probe with an allow-everything `canUseTool` and
Bash, the model looked **outside** its folder, then (in `acceptEdits`) edited files of another lab and ran `git init`
and `git commit`. `acceptEdits` only auto-approves edits inside `cwd`. Everything else still goes to your function. The
lab gives the agent no Bash, and `guard()` denies any path outside the run folder, in every mode.

## Step 5: Edit the plan, or send it back

**An edited plan.** When the person changes the plan in the card, the lab approves with
`updatedInput: { ...input, plan: "<the edited text>" }`. The probes and the route test showed:

- The tool_result says `## Approved Plan (edited by user):` followed by **your** text.
- `tool_use_result.planWasEdited` is `true`.
- Claude Code **overwrites the plan file** with your text.
- The model follows your version. With a plan edited to "add a SECOND function `totalWithCoupon`, do NOT change
  `total()`, do NOT touch README.md", Haiku said "I see the user has modified the plan", added only `totalWithCoupon`,
  and left `README.md` alone.

**Keep planning.** A `deny` with feedback keeps the mode at `plan`. The model gets `is_error: true` with your message,
**edits its own plan file** (an Edit of `plans/…md`, approved by the CLI), and calls `ExitPlanMode` again. The card
shows plan #2. `result.permission_denials` lists the first call. In the probe, the feedback "also add input validation (discount must be
0-100) and a test file cart.test.js" gave a revised plan, then code with the range check and a new `cart.test.js`.

**Cancel.** `deny` + `interrupt: true` gives the model "The user doesn't want to proceed… STOP what you are doing…". The
result is `error_during_execution` and `query()` throws afterwards, as in Concept 31. `runOnce()` catches it.

## Step 6: Your own planning workflow, and where the plan goes

**`planModeInstructions`** (scenario 2) replaces the **workflow part** of the plan-mode reminder. The CLI keeps the
read-only preamble and the `ExitPlanMode` footer around it. With:

```ts
planModeInstructions: "Write the plan in this exact shape and nothing else: a line 'Goal: …', then at most 4 numbered steps (one file each, under 20 words), then a line 'Risk: …'."
```

the plan was a Goal line, numbered steps and a Risk line, instead of the default "Context / Implementation / Verification"
sections. Use it for your team's plan template.

**`plansDirectory`** (a settings key) moves the plan file. It is relative to the project root:

```ts
settings: { plansDirectory: "plans" }   // → <cwd>/plans/<slug>.md, instead of CLAUDE_CONFIG_DIR/plans/
```

Tick the box in the custom job form to try it. Without it, the plan files of every session share one folder: the lab's
host check therefore reports **this run's** plan file (from `planFilePath`), not the folder's contents.

## Step 7: Entering plan mode, and when the tools are missing

**`EnterPlanMode`** (scenario 3): start in `default` with `EnterPlanMode` in `tools`, and ask the model to plan first.
It calls `EnterPlanMode` with `{}`. `canUseTool` is **not** asked, `system/status` says `permissionMode: "plan"`, and
from there it is the same loop. Your host can also switch modes itself with `query.setPermissionMode("plan")` in a
streaming-input session (Concept 26).

**No `canUseTool`**: `ExitPlanMode` and `EnterPlanMode` are removed from the tool list, as `AskUserQuestion` was in
Concept 31. The model writes the plan, replies "## Plan Complete ✓ … ready for your review", and the run ends in plan mode.
Nothing changed, and nothing can: there is no way out of plan mode in that session.

## Step 8: A policy hook reviews first

A `PreToolUse` hook with `matcher: "ExitPlanMode"` sees the plan **before** `canUseTool` (scenario 4). The lab's hook
requires a test step:

```ts
function planPolicy(emit: Emit): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const plan = String((input.tool_input as { plan?: string }).plan ?? "");
    const ok = /cart\.test\.js/.test(plan);
    emit("policy", { ok, rule: "the plan must name a test file, cart.test.js" });
    if (ok) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Policy: every plan must include a test step that adds cart.test.js." } };
  };
}
```

`return {}` passes the plan on: the person decides.

The task does not mention tests, so the first plan fails. The model gets
`PreToolUse:ExitPlanMode hook error: Policy: every plan must include a test step…`, `canUseTool` is not asked, the model
adds `cart.test.js` to its plan, and the second plan reaches your card. After approval, `cart.test.js` was created.

A hook **cannot approve a plan for the user**. With `permissionDecision: "allow"`, `canUseTool` was **still** called for
`ExitPlanMode`. That is unlike `AskUserQuestion`, where a hook's `allow` answered the question (Concept 31). So return
`{}` when the plan passes, and let the person decide.

## Step 9: The host check

After each run, the lab compares the project with its starting copy, and the changed files with the plan it approved:

- the mode timeline, for example `plan → acceptEdits`, or `default → plan → acceptEdits` for scenario 3
- every decision: `revise`, `approve (acceptEdits) edited`, …
- every call the host denied because the mode was still `plan`
- each changed file, and whether the **approved** plan names it. A file changed without an approved plan, or not named
  in it, is shown in red.
- "The model never called ExitPlanMode" when the run ended without asking, with this run's plan file

As in Concepts 30 and 31: trust what your code saw, not what the model says it did.

## Step 10: Part D, the summary

| You want | Do |
|---|---|
| Plan first, then code | `permissionMode: "plan"`, `ExitPlanMode` in `tools`, a `canUseTool`, and name `ExitPlanMode` in the prompt |
| Show the plan | Read `input.plan` (and `input.planFilePath`) in `canUseTool("ExitPlanMode")` |
| "Yes, auto-accept edits" | `allow` + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]` |
| "Yes, but ask me about each edit" | `allow` alone: the mode becomes `default` |
| Change the plan before approving | `allow` with `updatedInput: { ...input, plan: yourText }` |
| More planning | `deny` with the feedback as the message |
| Stop everything | `deny` + `interrupt: true`, and catch the error `query()` throws |
| A time limit | Your own timer, and `deny` + `interrupt` when it fires |
| Really read-only | Track the mode (`system/init`, `system/status`, your approvals) and deny in `canUseTool` while it is `plan` |
| Your own plan template | `planModeInstructions` |
| The plan file in the project | `settings: { plansDirectory: "plans" }` |
| Rules every plan must pass | A `PreToolUse` hook on `ExitPlanMode` that denies with a reason |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/32-plan-mode.ts](server/concepts/32-plan-mode.ts) and
[src/concepts/Concept32PlanMode.tsx](src/concepts/Concept32PlanMode.tsx). The tab's **code** buttons show the same
regions (`options`, `guard`, `review`, `decide`, `hook`, `messages`, `check`). The pattern is the one of Concept 31:
if you built that tab, this one reuses its shape.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `PermissionMode` (`'plan'` is one of the
values), `PermissionResult` and its `updatedPermissions`, the `PermissionUpdate` with `type: 'setMode'`,
`planModeInstructions`, `plansDirectory` (a settings key) and `SDKStatusMessage` (the `system/status` message).
`ExitPlanModeInput` is in `sdk-tools.d.ts`, and it has almost nothing (Step 1 above). The types do not say that the
CLI fills in `plan` and `planFilePath`, or who blocks a Write in plan mode. Probes found that first, and button 0
(`POST /who`) shows it again.

### Step 2: The folders and the starting project

```ts
const LAB = path.resolve("plan-lab");
const RUNS = path.join(LAB, "runs");
const CONFIG_DIR = path.join(LAB, "config");
// …
// The project every run starts from.
const PROJECT: Record<string, string> = {
  "cart.js": "export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return sum;\n}\n",
  "README.md": "# Shop\n\nA tiny cart module. `total(items)` returns the cart total.\n",
};

const REVIEW_TIMEOUT_MS = 180_000; // the host's own limit: Claude Code waits for canUseTool forever
```

- `newRun(mode)` makes `plan-lab/runs/<run id>` and writes a fresh copy of `PROJECT` into it. The host check compares
  the folder with `PROJECT` at the end.
- The `Run` object holds the mode **as the host knows it** (`mode`), a mode timeline (`modes`), every decision, the
  approved plan and the calls the host blocked.
- `setMode()` changes `run.mode`, adds a row to the timeline, and emits a `mode` event. It does nothing when the mode
  is the same.

### Step 3: The options

```ts
function baseOptions(run: Run, emit: Emit, extra: Partial<Options> = {}): Options {
  // …
  return {
    model: MODEL,
    cwd: run.work,
    permissionMode: run.mode, // "plan": explore read-only, write the plan, call ExitPlanMode
    tools: PLAN_TOOLS, // ExitPlanMode must be in the list, like any tool (no Bash: see Tab32 Step 4)
    // canUseTool is the host's approval dialog. Without it, the model does not get ExitPlanMode at all.
    canUseTool: guard(run, emit),
    // … settingSources: [], persistSession: false, thinking disabled, maxTurns: 30, env
    ...extra,
  };
}
```

- `PLAN_TOOLS` is `["Read", "Glob", "Grep", "Write", "Edit", "ExitPlanMode"]`. There is no Bash, so the agent cannot
  leave its folder with a shell command.
- `maxTurns: 30` is higher than in Concept 31: after the approval, the same run also does the coding.

### Step 4: The mode-aware guard: `guard()`

```ts
function guard(run: Run, emit: Emit) {
  return async (tool: string, input: Record<string, unknown>, { signal }: { signal: AbortSignal }): Promise<PermissionResult> => {
    if (tool === "ExitPlanMode") return review(run, emit, input, signal);
    const target = String(input.file_path ?? input.path ?? input.pattern ?? "");
    if (!path.resolve(run.work, target || ".").startsWith(run.work)) {
      emit("blocked", { tool, target: short(target), why: "outside the run folder" });
      return { behavior: "deny", message: "Denied by the lab: only files inside the project folder." };
    }
    if (run.mode === "plan") {
      run.blocked.push({ tool, target: short(target) });
      emit("blocked", { tool, target: short(target), why: "plan mode" });
      return { behavior: "deny", message: "Plan mode is read-only: nothing may change until the user approves your plan. Put this change in the plan instead." };
    }
    // After a plain approval (mode "default"), every edit comes here. The lab allows it and shows it.
    emit("asked", { tool, target: short(target), mode: run.mode });
    return { behavior: "allow", updatedInput: input };
  };
}
```

- Step 4 above shows the same function without its events. The path check runs in **every** mode.
- `run.mode` is the host's own copy of the mode. `canUseTool` is not told the mode, so the host must keep it.
- `guard()` returns a function, so each run gets a `canUseTool` bound to its own `Run`.

### Step 5: Hold the plan: `review()`

The same pending-promise pattern as `ask()` in Concept 31. The plan waits in a map until the browser decides:

```ts
type Pending = { run: Run; input: Record<string, unknown>; done: (r: PermissionResult, d: Decision) => void };
const pending = new Map<string, Pending>(); // "<run id>:<plan id>" → the plan waiting for a decision

function review(run: Run, emit: Emit, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
  const id = String(++run.plans);
  const plan = String(input.plan ?? "");
  if (input.planFilePath) run.planFile = String(input.planFilePath);
  emit("plan", { run: run.id, id, plan, planFilePath: short(String(input.planFilePath ?? "")), timeoutMs: REVIEW_TIMEOUT_MS });
  return new Promise((resolve) => {
    const key = `${run.id}:${id}`;
    const done = (result: PermissionResult, d: Decision) => {
      if (!pending.delete(key)) return; // already decided
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run.decisions.push(d);
      if (result.behavior === "allow") {
        run.approvedPlan = String(result.updatedInput?.plan ?? plan);
        // Set the mode NOW: the model's first edit can reach canUseTool before system/status is read.
        setMode(run, d.mode ?? "default", d.mode === "acceptEdits" ? "approved with setMode" : "approved (no setMode: plan mode ends in 'default')", emit);
      }
      // … emit a "decision" event
      resolve(result);
    };
    const onAbort = () => done({ behavior: "deny", message: "The run was aborted.", interrupt: true }, { id, how: "aborted" });
    // Nobody reviewed in time: never implement an unreviewed plan. Stop the run.
    const timer = setTimeout(() => done({ behavior: "deny", message: "Nobody reviewed the plan in time. Do not implement it.", interrupt: true }, { id, how: "timeout" }), REVIEW_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, { run, input, done });
  });
}
```

- Each `ExitPlanMode` call gets a new id (`plan #1`, `plan #2` after "Keep planning").
- `setMode()` runs **inside** `done()`, before `resolve()`. So the guard already knows the new mode when the first
  Edit arrives.
- Unlike Concept 31, the timeout and the abort use `interrupt: true`: an unreviewed plan must stop the run.

### Step 6: Release it: `POST /decide`

```ts
const DecideBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["approve", "revise", "cancel"]),
    mode: z.enum(["acceptEdits", "default"]).optional(), // approve only
    plan: z.string().trim().min(1).max(20_000).optional(), // approve only: the user's edited plan
    feedback: z.string().trim().min(1).max(2000).optional(), // revise only (required there)
  })
  .strict()
  .refine((b) => b.action === "approve" || (b.mode === undefined && b.plan === undefined), { message: "mode and plan are only for 'approve'" })
  .refine((b) => (b.action === "revise") === (b.feedback !== undefined), { message: "feedback is required for 'revise', and only for it" })
  .refine((b) => b.action !== "approve" || b.mode !== undefined, { message: "approve needs a mode: 'acceptEdits' or 'default'" });
```

`toResult()` turns the body into the `PermissionResult` of Step 2 above. The approve branch:

```ts
  const edited = b.plan !== undefined && b.plan !== String(p.input.plan ?? "").trim();
  return {
    result: {
      behavior: "allow",
      updatedInput: edited ? { ...p.input, plan: b.plan } : p.input,
      ...(b.mode === "acceptEdits" && { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }),
    },
    decision: { ...d, mode: b.mode, edited },
  };
```

- The three `refine()` rules make each action carry exactly the fields it needs. A bad body gets a 400.
- A plan counts as edited only when its text really changed. Otherwise the model's own `input` goes back.
- The route answers 404 when no plan is waiting with that id (already decided, timed out, or the run ended).

### Step 7: Follow the mode, and the policy hook

`relay()` turns each SDK message into an event. Three lines keep the host's view of the mode up to date:

```ts
  if (m.type === "system" && m.subtype === "init")
    return emit("init", { model: m.model, permissionMode: m.permissionMode, tools: m.tools, hasExit: m.tools.includes("ExitPlanMode"), hasEnter: m.tools.includes("EnterPlanMode") });
  // Every mode change (ExitPlanMode approved, EnterPlanMode, setPermissionMode) arrives as system/status.
  if (m.type === "system" && m.subtype === "status" && m.permissionMode) return emit("status", { permissionMode: m.permissionMode }), setMode(run, m.permissionMode, "system/status", emit);
  // With no canUseTool, the CLI itself denies writes in plan mode, and says so here.
  if (m.type === "system" && m.subtype === "permission_denied") return emit("cliDenied", { tool: m.tool_name, reason: m.decision_reason_type, message: short(m.message ?? "") });
```

- `system/status` is how scenario 3 (`EnterPlanMode`) reaches `plan`: nobody asks the host, so the host must read it.
- A `Write` into a `plans/` folder is remembered as `run.planFile`, so the host check can show this run's plan file.
- `planPolicy()` is the hook of Step 8 above. It emits a `policy` event, and returns `{}` when the plan names
  `cart.test.js`.
- `check()` compares the folder with `PROJECT` (`changedFiles()`), and marks each changed file with `inPlan`: is it
  named in the approved plan?

### Step 8: The routes `/run` and `/who`

`POST /run` builds the extra options from the scenario:

```ts
    const extra: Partial<Options> = { abortController: abort };
    if (b.scenario === "instructions") extra.planModeInstructions = INSTRUCTIONS;
    if (b.scenario === "custom" && b.planModeInstructions) extra.planModeInstructions = b.planModeInstructions;
    if (b.scenario === "custom" && b.plansInProject) extra.settings = { plansDirectory: "plans" }; // relative to cwd
    if (b.scenario === "policy") extra.hooks = { PreToolUse: [{ matcher: "ExitPlanMode", hooks: [planPolicy(emit)] }] };
    if (b.scenario === "enter") extra.tools = [...PLAN_TOOLS, "EnterPlanMode"]; // the model switches to plan mode itself
```

- `newRun(b.scenario === "enter" ? "default" : "plan")`: only scenario 3 starts outside plan mode.
- `RunBody` refuses `planModeInstructions` and `plansInProject` for any scenario but `custom`.
- As in Concept 31, the `finally` block closes every plan of this run that is still waiting.

`POST /who` runs the same forced Write in three setups, in parallel. The lab's row reuses `guard()`, but refuses a
plan at once, so the check does not wait 3 minutes:

```ts
        const labGuard = guard(run, quiet);
        const noReview = async (t: string, i: Record<string, unknown>, o: any): Promise<PermissionResult> =>
          t === "ExitPlanMode" ? ((row.stoppedAtPlan = true), { behavior: "deny", message: "This check does not review plans.", interrupt: true }) : labGuard(t, i, o);
        const canUseTool = s.key === "none" ? undefined : spy(s.key === "allowAll" ? allowAll : noReview);
```

- `spy()` wraps each `canUseTool` and sets `row.asked`, so the table can show "canUseTool asked".
- `FORCE`, a system prompt append, makes the model **try** the Write. After the run, the route checks whether
  `hello.txt` exists.

### Step 9: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept32 } from "./concepts/32-plan-mode.js";
// …
app.use("/api/c32", concept32); // POST /decide releases a plan that canUseTool("ExitPlanMode") is waiting on
```

### Step 10: The React tab

`run()` streams the events of `POST /run`. It keeps the plan card (`open`) and the mode badge (`mode`) up to date:

```tsx
await streamPost("/api/c32/run", body, (event, data) => {
  if (event === "done") return;
  if (event === "opened") return setOptions(data), setMode(data.options.permissionMode);
  if (event === "mode") setMode(data.mode);
  if (event === "plan") setOpen({ ...data, receivedAt: Date.now() });
  if (event === "decision") setOpen((o) => (o && o.id === data.id ? null : o));
  got.push({ event, data });
  setEvents([...got]);
});
```

`PlanCard` shows the plan (or a textarea to edit it) and sends the decision:

```tsx
async function send(action: "approve" | "revise" | "cancel", mode?: "acceptEdits" | "default") {
  setSending(true);
  setError(null);
  const body: any = { run: open.run, id: open.id, action };
  if (action === "approve") body.mode = mode;
  if (action === "approve" && edited) body.plan = plan.trim();
  if (action === "revise") body.feedback = feedback.trim();
  try {
    const r = await fetch("/api/c32/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
```

- The two approve buttons are `send("approve", "acceptEdits")` and `send("approve", "default")`: the two choices of
  Step 3 above.
- `edited` is `plan.trim() !== open.plan.trim()`, so an unchanged plan is never sent back.
- **Keep planning** stays disabled until the feedback box has text, because the server requires `feedback`.
- `WhoTable` draws the rows of `POST /who`, with "WRITTEN in plan mode" in red.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 32, title: "Plan mode", Component: Concept32PlanMode },
```

### Step 11: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 32, press **0**: one row says "WRITTEN in plan mode".
3. Press **1**, and approve with **Approve · auto-accept edits**: the badge goes `plan → acceptEdits`, and the host
   check lists each changed file and whether the approved plan names it.
4. Press **4**: the first plan is refused by the policy hook, and only the second one reaches the card.

## How to try it

1. `npm run dev`, then open the **32. Plan mode** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Who keeps plan mode read-only?** and find the red "WRITTEN in plan mode" row.
3. Press **1 · Plan, then you decide**. When the card appears, read the plan and press **Approve · auto-accept edits**.
   Watch the `system/status` row and the host check. Run it again and try **Approve · I review each edit** (count the
   `canUseTool Edit` rows), **Edit the plan** then approve, **Keep planning** with feedback, and **Cancel the job**.
4. Press **2 · Your own plan format** and compare the plan's shape with scenario 1.
5. Press **3 · The model enters plan mode**: the mode badge goes `default → plan → acceptEdits`.
6. Press **4 · A policy hook reviews first**: the first plan is refused before you see it.
7. Write your own job in the form, with your own `planModeInstructions` and the `plansDirectory` box.

Each scenario costs about $0.05 or less (Haiku 4.5), and button 0 about $0.04. A plan waits for your decision for up to
3 minutes.
