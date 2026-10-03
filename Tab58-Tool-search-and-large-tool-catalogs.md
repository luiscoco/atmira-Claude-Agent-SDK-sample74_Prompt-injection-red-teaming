# 58. Tool search and large tool catalogs

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Tools & extensions → 58. Tool search and large tool catalogs**, or `?lesson=58`. Sample58 uses backend port **3058**, with Vite on **5173** or the next available port.

## What you will learn

Lesson 13 connects MCP servers and lesson 54 designs individual tools. This lesson is about **many** tools. Every tool definition that starts in context costs tokens on every turn, and the model has to pick from all of them. Tool search defers the definitions. The model sees only tool names and server instructions, calls the `ToolSearch` tool, and loads what the task needs.

The lesson covers four levers:

| Lever | Where | Effect |
|---|---|---|
| `ENABLE_TOOL_SEARCH` | `env` passed to `query()` | Unset or `true` defers every MCP tool. `false` loads everything up front. `auto` defers once definitions reach 10% of the context window. `auto:N` uses a custom N%. |
| `alwaysLoad` | `tool(…, { alwaysLoad: true })`, `createSdkMcpServer({ alwaysLoad })` or the server config | Keeps a few hot tools in context, never deferred. |
| `searchHint` | `tool(…, { searchHint })` | Extra words that help the search find the tool. |
| Server `instructions` | `createSdkMcpServer({ instructions })` | Tells the model when to search this server. |

Reference: [Scale with MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) and the API [tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

## The lab

One in-process MCP server, `ops`, holds 64 tools: 8 domains (billing, crm, shipping, inventory, hr, analytics, support, marketing) × 8 actions. Only one tool does anything. `billing_refund_invoice` refunds invoice `INV-2042` and returns `RF-2042-1`. The others are realistic fixtures that compete for context and attention. A **vague** variant renames the refund tool to `billing_op_7`, with the description "Billing operation." and no `searchHint`.

### A · The catalog (offline)

A per-domain table with an estimate of about 4 JSON characters per token: 15,647 tokens for the whole catalog.

### B · Can the model find the right tool? (offline)

A transparent keyword scorer: a name match scores +3, a `searchHint` match +2, a description match +1. Filler words such as "for" or "the" are ignored, because they appear in almost every description. `select:a,b` returns exact names. This scorer is **not** Claude Code's ranking; it shows why metadata decides discoverability. "refund duplicate charge" finds `billing_refund_invoice`. With vague metadata, nothing matches.

### C · What starts in context? (offline plan + real measurement)

The planner applies the documented rules to the estimates. **Measure** starts Claude Code with the catalog, waits for the MCP server, and calls `q.getContextUsage()`. No prompt is sent and no model turn runs. Measured with SDK 0.3.281 and Haiku 4.5 (200k window):

| Configuration | MCP/system tool tokens in context | Deferred |
|---|---|---|
| `false` | 17,045 | 0 |
| `true` | 909 (the ToolSearch tool) | 17,048 |
| `true` + `alwaysLoad` on the refund tool | 909 + 225 | 16,823 |
| `auto` (10% = 20,000) | 909 + 17,045: under the threshold, so loaded up front | 0 |
| `auto:1` | 909 | 17,048 |

Two findings from building this lesson:

- **`tools: []` disables tool search.** That removes `ToolSearch` too, so every MCP tool is counted as in context whatever `ENABLE_TOOL_SEARCH` says. The lab uses `tools: ["ToolSearch"]` to keep only that built-in.
- **The `init` message lists all 65 tool names in every mode**, so it does not show what is in context. `getContextUsage()` does: look at the "MCP tools" (`kind: "used"`) and "MCP tools (deferred)" (`kind: "deferred"`) rows. `mcpTools[].isLoaded` marked only the `alwaysLoad` tool, even in `false` mode, so classify on the categories.

### D · Run the task live (billed, optional)

"Invoice INV-2042 was charged twice… refund the duplicate charge of 49.00 EUR and report the refund ID."

The run uses Haiku 4.5, `tools: ["ToolSearch"]`, a `canUseTool` callback that allows only ToolSearch and the `ops` tools, 8 turns, a $0.15 SDK budget threshold and a 90-second deadline. It needs `ANTHROPIC_API_KEY` in `.env`; the session uses an isolated `toolsearch-lab/config`, not your CLI login. The UI shows each ToolSearch query with the `tool_reference` blocks it returned, each handler call, and a comparison table.

One run of each, during implementation:

| Configuration | Correct | ToolSearch calls | Turns | Input tokens | Cost |
|---|---|---|---|---|---|
| `true`, clear metadata | yes | 1 (`select:mcp__ops__billing_refund_invoice`) | 3 | 8,060 | $0.0123 |
| `false`, clear metadata | yes | 0 | 2 | 36,780 | $0.0288 |
| `true`, vague metadata | yes | 2 (first loaded `billing_get`, `billing_search`, `billing_create`) | 6 | 22,209 | $0.0263 |

Deferral saved about 78% of input tokens despite the extra turn. Vague metadata gave most of that saving back through wrong guesses. These are single runs, not a benchmark; repeat with lesson 52's evals before deciding.

## Apply it to your agent

1. **Measure** `getContextUsage()` with your real MCP servers before tuning anything.
2. Keep tool search on (the default) for large catalogs, and keep `ToolSearch` available.
3. **Pin** the few tools used on nearly every turn with `alwaysLoad`; leave the long tail deferred. Each pinned tool costs context on every turn.
4. **Make tools findable.** Use intent-revealing names, and a first sentence that says when to use the tool. Add a `searchHint` in the user's vocabulary, and server `instructions` that say when to search the server. Claude Code truncates descriptions and instructions at 2,048 characters, so put the key words first.
5. **Use a supported model.** Tool search needs `tool_reference` support: Haiku, Sonnet or Opus 4.5 and later.
6. **Behind a proxy:** a non-first-party `ANTHROPIC_BASE_URL` turns tool search off unless you set `ENABLE_TOOL_SEARCH` explicitly. Only do that if the proxy forwards `tool_reference` blocks. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` keeps it off; the lab strips inherited `CLAUDE*` variables for this reason.
7. **Without tool search,** shrink the catalog per agent instead: subagents with their own tools (lessons 8 and 47), or `allowedTools` per task.

## Implementation and verification

- `server/tool-search/catalog.ts`: the 64-tool catalog, fixture handlers, SDK definitions (`searchHint`, `alwaysLoad`), the token estimate, the offline search and the planner.
- `server/concepts/58-tool-search.ts`: `/facts`, `/code`, `/search` and `/plan` (offline), `/measure` (`getContextUsage()`, no model turn) and `/run` (live SSE). Inputs are validated with zod. Only one Claude Code process runs at a time.
- `src/concepts/Concept58ToolSearch.tsx`: sections A–F.
- `server/tool-search/tool-search.test.ts`: catalog shape, handler errors, discoverability, planner rules, SDK metadata and HTTP validation.

```powershell
npm run typecheck
npm run test:tool-search
npm run test:offline
npm run build
```

Tests make no model calls and do not start Claude Code.

For the browser check, stop the app and run `node --env-file-if-exists=.env --import tsx server/tool-search/browser-smoke.mjs`. It needs Chrome at the default Windows path and free ports 3058, 5188 and 9231. It checks navigation, the offline search, vague metadata, one real `getContextUsage()` measurement and mobile width, and saves a screenshot under the ignored `toolsearch-lab/browser-smoke/`.

Verification passed: typecheck, production build, all 110 offline tests (including six for lesson 58) and the headless Chrome check. The three live runs in section D also completed, for $0.067 in total.

## Steps followed to build this sample

1. Copied sample57 and moved the ports to 3058 (server, Vite proxy, the lesson 56 and 57 smoke scripts).
2. Read the SDK 0.3.281 typings (`alwaysLoad`, `searchHint`, `getContextUsage()` deferred rows) and the Claude Code MCP docs on tool search.
3. Probed the real behavior with no model turns. That surfaced the `tools: []` and `init`-list findings above.
4. Built the catalog, the offline helpers and the route. Added tests, the UI, navigation, the browser smoke check and this document.
5. Verified with tests, the build, the browser check and three live Haiku runs.
