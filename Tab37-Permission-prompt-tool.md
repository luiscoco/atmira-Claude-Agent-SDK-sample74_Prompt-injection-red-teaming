# The permission prompt tool

This file explains Concept 37 (**the permission prompt tool**) of the Claude Agent SDK Lab. Sometimes a tool call needs
approval: no rule, permission mode or hook has decided it. Claude Code then asks the host "may this run?". Concept 4
answered that question with the `canUseTool` callback. The other way to answer is an **MCP tool**, named by
`permissionPromptToolName`. Claude Code calls that tool with the pending call and reads a `PermissionResult` from its
answer. The tool can live in your process, or in **another process**: a policy service written in any language, shared
by many agents.

**Goal:** see that `canUseTool` and the permission prompt tool are the same mechanism, write a gate in-process and as
a separate process, learn exactly when it is asked, what it can answer (allow, rewrite, remember, deny, stop), and what
happens when the gate itself breaks.

| Concept | Topic | Routes |
|---|---|---|
| 37 | The permission prompt tool: `permissionPromptToolName`, the call `{ tool_name, input, tool_use_id }` and the JSON `PermissionResult` answer, `canUseTool` as `--permission-prompt-tool stdio`, an in-process gate that waits for the user, an external policy gate (stdio MCP server), who is asked and when, `updatedInput`, `updatedPermissions` (`session`, `localSettings`), `interrupt`, invalid answers, failures | `/api/c37/dry`, `/run` (SSE), `/decide`, `/gate-log`, `/who` (SSE), `/answers` (SSE), `/failures` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/37-permission-prompt-tool.ts` | **New**: the in-process gate, the human decisions, the policy gate's config, the dry run, the three tables of cases, the routes |
| `server/concepts/37-policy-gate.mjs` | **New**: the external gate, a stdio MCP server with a JSON policy |
| `server/index.ts` | Mounts the router on `/api/c37` |
| `src/concepts/Concept37PermissionPromptTool.tsx` | **New**: the tab, Parts A to H |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The gate rows, the decision card, the policy editor |
| `.gitignore` | Ignores `gate-lab/` |
| `Tab1-query().md` | Adds Concept 37 to the table and the project tree |

---

## Step 1: The smallest gate

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const gate = createSdkMcpServer({
  name: "gate",
  tools: [
    tool("approve", "Decides whether a tool call may run.",
      { tool_name: z.string(), input: z.looseObject({}), tool_use_id: z.string().optional() },
      async ({ tool_name, input }) => {
        const result = tool_name === "Bash"
          ? { behavior: "deny", message: "No shell in this app." }
          : { behavior: "allow", updatedInput: input };
        return { content: [{ type: "text", text: JSON.stringify(result) }] }; // the answer is TEXT holding JSON
      }),
  ],
});

for await (const m of query({
  prompt: "…",
  options: { tools: ["Write", "Bash"], mcpServers: { gate }, permissionPromptToolName: "mcp__gate__approve" },
})) { /* … */ }
```

- The name is the usual MCP tool name: `mcp__<server>__<tool>`.
- Claude Code calls it with **`{ tool_name, input, tool_use_id }`**. `tool_use_id` is the id of the model's
  `tool_use` block, so the gate can link its decision to the call. Nothing else is sent: no `permission_suggestions`,
  no reason.
- The answer is the **text** of the tool result, and it must be a JSON `PermissionResult`:
  `{ behavior: "allow", updatedInput, updatedPermissions? }` or `{ behavior: "deny", message, interrupt? }`.
- Use **`z.looseObject({})`** for `input`, not `z.record(…)`. Step 9 shows why.

This is the lab's **code: gate**.

## Step 2: One flag, two ways to answer

Scenario **1** is a dry run. It passes six setups to `query()` with a spawner that only records the arguments
(Concept 36), so no Claude Code starts and no API call is made:

| Setup | `--permission-prompt-tool` | Notes |
|---|---|---|
| no approver | not set | 17 args |
| `canUseTool` | **`stdio`** | The answer goes back over stdin, as a `control_response` |
| an SDK MCP tool | `mcp__gate__approve` | The SDK server is not in args: it travels in `control_request/initialize` |
| a stdio MCP tool | `mcp__gate__approve` | The server is in `--mcp-config` (command, args, env with the policy) |
| the tool + `permissionPrompts: 'none'` | `mcp__gate__approve` | Plus `--permission-prompts none` |
| `canUseTool` **and** the tool | — | `query()` throws: *canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.* |

So **`canUseTool` is itself a permission prompt tool**, named `stdio`. There is one slot, and you fill it with a
callback or with an MCP tool.

## Step 3: An in-process gate that asks you

Scenario **2** runs a session whose gate is an SDK MCP tool in the lab's server. Each call waits (a promise) until
the browser answers `POST /decide` (**code: human**). The prompt: write a haiku to `haiku.txt`, then `mkdir archive`,
`mkdir backup`, `rm haiku.txt`. With *Allow*, *Allow and remember*, then *Deny*:

```text
system/init          tools the model sees: Bash, Write · mcp__gate__approve is not listed · gate connected (sdk)
tool_use Write       toolu_01DA9…
approve()  Write     tool_use_id toolu_01DA9… = the tool_use of 2.87 s        ← the card: you click Allow
approve() returns    {"behavior":"allow","updatedInput":{…}}
approve()  Bash      mkdir archive                                           ← Allow and remember
approve() returns    {…,"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir:*"}],
                      "behavior":"allow","destination":"session"}]}
tool_result Bash     (mkdir backup: never asked, the session rule allowed it)
approve()  Bash      rm haiku.txt                                            ← Deny: "No deletes today."
tool_result Bash     is_error · No deletes today.
result/success       $0.0095 · permission_denials: Bash
the run folder       archive/, backup/, haiku.txt
```

- **The model never sees the gate.** `system/init` lists `Bash, Write` only.
- **The gate can wait.** A 70-second gate worked in the probes: there is no timeout. The lab adds its own: after
  2 minutes it denies, and the message says nobody answered.
- The buttons map to `PermissionResult`s: *Allow* (`updatedInput: input`), *Allow with this input* (your edited
  JSON), *Allow and remember* (a session rule), *Deny* (your message), *Deny and stop the run* (`interrupt: true`).

A lesson from the first test run: *remember* first added a rule for the **whole** `Bash` tool, and it silently
allowed the later `rm haiku.txt` too. The lab now remembers only the command's first word: `Bash(mkdir:*)`.

## Step 4: An external gate: a policy in another process

Scenario **3** uses `server/concepts/37-policy-gate.mjs` (**code: policyGate**). It is a separate Node program, an MCP
server over stdio, that **Claude Code** starts:

```ts
mcpServers: { gate: { type: "stdio", command: process.execPath, args: ["37-policy-gate.mjs"],
                      env: { GATE_POLICY: JSON.stringify(policy), GATE_LOG_URL, GATE_RUN, GATE_TOKEN } } },
permissionPromptToolName: "mcp__gate__approve",
```

The policy is JSON, and you can edit it in the tab. The first rule whose `tool` and `match` fit decides. `match` is a
regular expression on the command (Bash) or the `file_path`:

```json
{ "default": "deny", "rules": [
  { "tool": "Write", "match": "\\.txt$", "decision": "allow" },
  { "tool": "Bash", "match": "^(mkdir|ls|cat) ", "decision": "allow" },
  { "tool": "Bash", "match": "^rm ", "decision": "deny", "message": "Deleting files needs a ticket (policy-gate)." } ] }
```

The prompt: write `notes.txt` and `notes.md`, then `mkdir out`, then `rm notes.txt`:

```text
policy gate   started · pid 40364 · 3 rules, default deny           (the host is pid 40836)
policy gate   Write "notes.txt"     → rule 1  allow
policy gate   Write "notes.md"      → no rule: default  deny         (the model tried it twice)
policy gate   Bash  "mkdir out"     → rule 2  allow
policy gate   Bash  "rm notes.txt"  → rule 3  deny: Deleting files needs a ticket (policy-gate).
result/success  $0.0110 · permission_denials: Write, Write, Bash · files: notes.txt, out/
```

- **One process for the whole session**: every decision has the same pid.
- **The host sees nothing of it** except the tool results and `permission_denials`. The gate reports each decision
  to `POST /gate-log` itself, with a per-run token (a forged line gets 403).
- The policy lives **outside your app**. Another team can own it, and it could be written in any language: Claude
  Code only sees a process that speaks MCP.

## Step 5: Who is asked, and when

Scenario **4** runs the same two steps (write `a.txt`, then `mkdir out`) with seven setups in parallel
(**code: who**). The gate allows everything and records what reaches it:

| Setup | The gate was asked | What happened |
|---|---|---|
| no approver at all | — | Both denied: *"Claude requested permissions to write to a.txt, but you haven't granted it yet."* The model asks the user in its reply |
| the gate | Write, Bash | Both ran |
| + `allowedTools: ['Write']` | Bash | The rule allowed Write |
| + `permissionMode: 'acceptEdits'` | — | The mode allowed both (`mkdir` counts as a file edit) |
| + a `PreToolUse` hook that denies Bash | Write | *PreToolUse:Bash hook error: …*: the gate never saw Bash |
| + `acceptEdits` + a hook that says **`ask`** for Write | Write | A hook's `ask` sends the call to the gate even when the mode would allow it |
| + `permissionPrompts: 'none'` | — | Both denied: *"…this session has no approval surface…"* |

The gate is **asked last**: rules, the permission mode and hooks decide first. It only sees what would otherwise be a
prompt. Read-only commands (`echo`, `ls`) never reach it either.

## Step 6: What the gate can answer

Scenario **5** changes only the gate's answer (**code: answers**):

| Answer | What happened |
|---|---|
| `allow` | Both ran |
| `allow` with another input (`content: 'REWRITTEN BY THE GATE'`, `command: 'mkdir gate-dir'`) | `a.txt` holds the new text and `gate-dir/` was created. The model still replied *"created a.txt with 'hello' and the out directory"*: **the tool result does not say the input changed** |
| `deny` + message | The model gets an `is_error` tool result with your message. `permission_denials: Bash` |
| `deny` + `interrupt: true` | `result: error_during_execution`, then `query() threw` |
| `allow` + a `session` rule | 2 Bash calls, **1** gate call |
| `allow` + a `localSettings` rule (`Bash(mkdir:*)`) | Claude Code wrote `<cwd>/.claude/settings.local.json`: `{ "permissions": { "allow": ["Bash(mkdir:*)"] } }`. A later session that loads `local` settings is not asked |
| the text `yes please` | A **denial**: *"The permission prompt tool returned an invalid permission result. Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}."* |

## Step 7: When the gate is the problem

Scenario **6** (**code: failures**):

| Case | What the host sees | Why it matters |
|---|---|---|
| `canUseTool` and the gate | `query()` throws at once, $0 | One slot (Step 2) |
| A typo: `mcp__gate__aprove` | `…exited with code 1. stderr: Error: MCP tool mcp__gate__aprove (passed via --permission-prompt-tool) not found. Available MCP tools: mcp__gate__approve` | Found only at the **first prompt**. And the real `mcp__gate__approve` was in the **model's** tool list: a tool is only hidden when it is the named one |
| No MCP server | The same exit, *Available MCP tools: none* | No `result` comes, so the cost is unknown |
| The external gate does not start | `system/init`: `gate: failed`, the session starts anyway, then the same exit | Check `mcp_servers` in `system/init` before you trust the gate |
| The gate throws | `<tool_use_error>Error calling tool (Write): policy service unreachable</tool_use_error>` | A **tool error, not a denial**: `permission_denials` is empty, and the model may retry |
| A `z.record` input schema | `system/init`: `gate: connected`, then the exit with *Available MCP tools: none* | Step 9 |

A gate that returns `isError: true` behaves like one that throws. Fail closed yourself: catch your own errors and
return a `deny`.

## Step 8: What changes, and what does not

| What | How | What happens |
|---|---|---|
| Name the gate | `permissionPromptToolName: 'mcp__<server>__<tool>'` | An MCP tool from `mcpServers` (SDK, stdio or http) answers instead of `canUseTool` |
| It receives | `{ tool_name, input, tool_use_id }` | Nothing more |
| It returns | text = `JSON.stringify(PermissionResult)` | Anything else is a denial |
| The model | `system/init` tools | Does not see the named tool |
| `canUseTool` | `--permission-prompt-tool stdio` | Same slot: never both |
| Order | rules → mode → hooks → the gate | A hook's `ask` reaches it; `permissionPrompts: 'none'` means nobody is asked |
| Rewrite | `updatedInput` | The tool runs with it; the model is not told |
| Remember | `updatedPermissions` | `session`, or a settings file (`localSettings`…). Keep rules narrow |
| Stop | `interrupt: true` | `error_during_execution`, `query()` throws |
| Breaks | throw, `isError`, missing tool | A tool error (retried), or an exit with code 1 at the first prompt |

## Step 9: A trap: `z.record` in an SDK MCP tool

The first version of the lab's in-process gate used `input: z.record(z.string(), z.unknown())`. Every session then
**failed at the first prompt** with *MCP tool mcp__gate__approve … not found. Available MCP tools: none*, although
`system/init` said `gate: connected`. Claude Code's debug log (`debugFile`, Concept 36) showed the cause:

```text
MCP server "gate": tools/list failed (Cannot read properties of undefined (reading 'push')); retrying in 250ms
MCP server "gate" Failed to fetch tools: Cannot read properties of undefined (reading 'push')
```

The SDK (`0.3.281`) cannot list an SDK MCP tool whose schema has a `z.record`, so the server has no tools.
`z.looseObject({})` or `z.any()` list fine and keep every key. The stdio gate, built on `@modelcontextprotocol/sdk`,
did not have the problem, but it uses `z.looseObject({})` too. This is a failure row in scenario 6.

## Things to try in Concept 37

1. Run 1 and compare the `canUseTool` row with the SDK tool row.
2. Run 2. Edit the haiku in the card before you click *Allow with this input*, then compare `haiku.txt` with the
   model's reply.
3. Run 2 again and click *Deny and stop the run* on the first call.
4. In Part C, add `{ "tool": "Write", "match": "\\.md$", "decision": "allow" }` to the policy and run 3 again. Then
   set `"default": "allow"` and remove the `rm` rule: what does the gate now let through?
5. Run 4 and explain each empty "asked" cell.
6. Run 6 and read the typo row: which tool did the model see?

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **37. Permission prompt tool** tab. `ANTHROPIC_API_KEY` must be in `.env`. Start the app from a normal
terminal, not from inside Claude Code (see Tab16). With Haiku 4.5: scenario 1 costs nothing, 2 about $0.01, 3 about
$0.011, 4 about $0.06, 5 about $0.06, 6 about $0.01.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -X POST http://localhost:3001/api/c37/dry
curl.exe -N -X POST http://localhost:3001/api/c37/run -H "Content-Type: application/json" -d '{\"gate\":\"policy\",\"prompt\":\"Write hello into notes.txt. Then run `rm notes.txt` with Bash.\"}'
```
