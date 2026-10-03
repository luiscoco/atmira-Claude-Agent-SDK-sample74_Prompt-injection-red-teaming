# Claude Agent SDK Lab (TypeScript + React 19.3)

A small learning app that introduces the features of the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`, formerly "Claude Code SDK") one concept at a time.
Each concept has its own tab in the UI, its own server route, and is small enough to read in a few minutes.

| Concept | Topic | Status |
|---|---|---|
| 1 | `query()` and the message stream | ✅ Done |
| 2 | Options: `model`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `includePartialMessages` | ✅ Done |
| 3 | Built-in tools: `tools`, `allowedTools`, `permissionMode`, `cwd` | ✅ Done |
| 4 | Permissions: `canUseTool`, where you approve or deny each tool call from the UI | ✅ Done |
| 5 | Custom tools: `createSdkMcpServer` + `tool()` with zod | ✅ Done |
| 6 | [Sessions: multi-turn chat with `resume`](Tab6-Sessions.md) | ✅ Done |
| 7 | [Hooks: `PreToolUse` / `PostToolUse`](Tab7-Hooks.md) | ✅ Done |
| 8 | [Subagents: `agents`](Tab8-Subagents.md) | ✅ Done |
| 9 | [System prompts: string, `string[]` + boundary, preset, `append`, CLAUDE.md](Tab9-System-prompts.md) | ✅ Done |
| 10 | [Structured output (`outputFormat`) and interrupting a run](Tab10-Structured-output-and-interrupt.md) | ✅ Done |
| 11 | [Skills: `SKILL.md`, progressive disclosure, `skills`, `plugins`, preloading, `reloadSkills()`](Tab11-Skills.md) | ✅ Done |
| 12 | [Streaming input mode: one live session, queued messages, `priority`, images, `setModel()`, `setPermissionMode()`, `getContextUsage()`](Tab12-Streaming-input.md) | ✅ Done |
| 13 | [External MCP servers: `stdio`, `http` (`sse`), server status, `toggleMcpServer()`, `reconnectMcpServer()`, `setMcpServers()`](Tab13-MCP-servers.md) | ✅ Done |
| 14 | [Thinking, effort & models: `thinking` (`adaptive` / `enabled` / `disabled`, `display`), `effort`, `fallbackModel`, `supportedModels()`, `applyFlagSettings({ effortLevel })`, `setMaxThinkingTokens()`](Tab14-Thinking-effort-and-models.md) | ✅ Done |
| 15 | [Cost & usage tracking: `total_cost_usd`, `usage` vs `modelUsage`, per-call `message.usage`, `maxTurns` / `maxBudgetUsd` / `taskBudget`, `rate_limit_event`, `getContextUsage()`, `usage_EXPERIMENTAL…()`](Tab15-Cost-and-usage.md) | ✅ Done |
| 16 | [Settings & env: `env` (replace vs spread), `CLAUDE_AGENT_SDK_CLIENT_APP`, `settingSources`, `settings` (object or path), `managedSettings`, `resolveSettings()`, `additionalDirectories`, `permissions.deny`](Tab16-Settings-and-env.md) | ✅ Done |
| 17 | [File checkpointing & rewind: `enableFileCheckpointing`, `rewindFiles()` (`dryRun`), user message `uuid`, `replay-user-messages`, rewinding a finished session with `resume`](Tab17-Checkpointing-and-rewind.md) | ✅ Done |
| 18 | [Sandbox: `sandbox.enabled`, `failIfUnavailable` (fail closed vs open), `settings.sandbox`, the stderr warning, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands` + `dangerouslyDisableSandbox`, `excludedCommands`, `filesystem.denyRead`, `network.allowedDomains`](Tab18-Sandbox.md) | ✅ Done |
| 19 | [Session management: `continue`, `forkSession`, `resumeSessionAt`, `sessionId`, `persistSession: false`, `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `renameSession()`, `tagSession()`, `forkSession()`, `deleteSession()`](Tab19-Session-management.md) | ✅ Done |
| 20 | [Hooks in depth: `HOOK_EVENTS`, `UserPromptSubmit` (`additionalContext`, `decision: "block"`, `continue: false`), `PermissionRequest`, `PostToolUse` `updatedToolOutput`, `PostToolUseFailure`, `Stop` + `stop_hook_active`, `SubagentStart`/`SubagentStop`, `systemMessage`, a hook that throws vs one that times out, `{ async: true }`](Tab20-Hooks-in-depth.md) | ✅ Done |
| 21 | [Slash commands: `.claude/commands/*.md`, `$ARGUMENTS`, `$0` (0-based), named `arguments`, `@file`, `` !`cmd` `` + `allowed-tools`, `disableSkillShellExecution`, `model`, `disable-model-invocation`, subfolders (`frontend:component`), built-ins (`/context`, `/cost`, `/compact`, `/clear`) and `result.local_command`, `supportedCommands()`, the `UserPromptExpansion` hook, `verbatimPrompts`](Tab21-Slash-commands.md) | ✅ Done |
| 22 | [CLAUDE.md & memory: `settingSources` (`project`, `local`, `user`), `CLAUDE.md`, `CLAUDE.local.md`, `@imports`, `.claude/rules/*.md` with `paths:`, nested `CLAUDE.md`, parent folders, `claudeMdExcludes`, the `InstructionsLoaded` hook, `getContextUsage().memoryFiles`, auto memory (`autoMemoryEnabled`, `autoMemoryDirectory`, `MEMORY.md`), `omitClaudeMd`, reload after `/compact`](Tab22-CLAUDE-md-and-memory.md) | ✅ Done |
| 23 | [Plugins in depth: one plugin with `commands/`, `agents/`, `skills/`, `hooks/hooks.json` and `.mcp.json`, namespacing, `${CLAUDE_PLUGIN_ROOT}`, `CLAUDE_PLUGIN_DATA`, `userConfig` + `pluginConfigs`, `skipMcpDiscovery`, `strictMcpConfig`, `pluginDelivery`, `reloadPlugins()` (`error_count`), plugin hooks vs `allowedTools` / `disallowedTools`](Tab23-Plugins.md) | ✅ Done |
| 24 | [Harnesses: the same tools and prompt in a manual loop on the Messages API (`@anthropic-ai/sdk`, `stop_reason`, `tool_use` / `tool_result`, `is_error`), the Tool Runner (`betaZodTool`, `ToolError`, `max_iterations`) and `query()` (`canUseTool`, `maxTurns` + `error_max_turns`, `result.usage` vs `modelUsage`, `num_turns`, the `claude_code` preset, `createSdkMcpServer({ alwaysLoad })`)](Tab24-Harnesses.md) | ✅ Done |
| 25 | [Compaction & context: `getContextUsage()` categories (`used` / `buffer` / `free` / `deferred`) and `autoCompactThreshold`, `settings.autoCompactWindow`, `autoCompactEnabled`, `/compact <instructions>`, auto-compaction mid-turn, `system/status` `compacting` + `compact_result`, `compact_boundary` (`pre_tokens`, `post_tokens`, `preserved_messages`), the `PreCompact` (`systemMessage`, `decision: "block"`), `PostCompact` (`compact_summary`) and `SessionStart` (`source: "compact"`) hooks, too-large tool results saved as `<persisted-output>`](Tab25-Compaction-and-context.md) | ✅ Done |
| 26 | [Query control methods: a live session driven from the browser (push-queue streaming input + `POST /call`), `initializationResult()`, `supportedModels/Commands/Agents()`, `accountInfo()`, `readFile()`, `setModel()` (`<local-command-stdout>`, per-turn `system/init`), `setPermissionMode()` (`system/status`), `interrupt()` (`still_queued`, `error_during_execution`), `backgroundTasks(toolUseId)`, `stopTask()`, `task_started` / `task_updated` / `task_notification`, `close()`](Tab26-Query-control-methods.md) | ✅ Done |
| 27 | [Background tasks: Bash `run_in_background` and the timeout that moves a command to the background (`timedOutAfterMs`), background subagents (`AgentDefinition.background`, `agentProgressSummaries`), the `Monitor` and `TaskStop` tools, `system/background_tasks_changed` (level) vs `task_started` / `task_updated` / `task_progress` / `task_notification` (edges), the Stop hook's `background_tasks`, the automatic turn after a notification, one-shot runs killing tasks, `interrupt()` + `perTaskStopAffordance`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`](Tab27-Background-tasks.md) | ✅ Done |
| 28 | [Errors, retries & recovery: a fault proxy at `ANTHROPIC_BASE_URL`, `system/api_retry` and `CLAUDE_CODE_MAX_RETRIES`, `retry-after`, `API_TIMEOUT_MS`, `fallbackModel` + `system/model_fallback`, the synthetic assistant message (`error`), the `StopFailure` / `PostToolUseFailure` hooks, `is_error` vs `subtype`, `terminal_reason`, the iterator's throw, `error_max_turns` + `resume`, `AbortError` vs `interrupt()`, startup failures, a host-side `classify()` and retry-by-resume](Tab28-Errors-retries-and-recovery.md) | ✅ Done |
| 29 | [Images & file input: `image` and `document` content blocks in an `SDKUserMessage` (base64, `text`, `url` sources, `title`, `context`, `citations`), what Claude Code changes before the API (resize to 2000 px + coordinate note, JPEG re-encode, `media_type` fix, a text note for bytes that are not an image), citations dropped by the SDK, `Read` on images and PDFs (`tool_use_result`, `isSynthetic`, `pages` + pdftoppm), `@file` in a string prompt, an MCP tool that returns an image, token costs, a wire tap at `ANTHROPIC_BASE_URL`](Tab29-Images-and-file-input.md) | ✅ Done |
| 30 | [Todo tracking: the Task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) vs the older `TodoWrite`, which one each model gets (`CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, the `tools` option), deferred todo tools and `ToolSearch`, `tool_use_result` (`statusChange`, `oldTodos` / `newTodos`), the task files in `CLAUDE_CONFIG_DIR/tasks/`, a live todo board, `CLAUDE_CODE_TASK_LIST_ID` and a plan written by the host (`blockedBy`), resume, the `TaskCreated` / `TaskCompleted` hooks that refuse changes, a host-side check](Tab30-Todo-tracking.md) | ✅ Done |
| 31 | [AskUserQuestion: the agent asks the user 1–4 multiple-choice questions (`header`, `options`, `multiSelect`, `preview`), a host dialog in `canUseTool` that waits for the answer (`updatedInput.answers`, several labels joined by `, `, free text, `annotations` notes), skip (`deny`) and cancel (`interrupt: true`, `query()` throws), a host-side timeout, `toolConfig.askUserQuestion.previewFormat` (HTML previews in a sandboxed iframe), a `PreToolUse` hook that answers, a partial answer the model fills in by itself, when the tool is removed (no `canUseTool`, `permissionPrompts: 'none'`) and `bypassPermissions`](Tab31-AskUserQuestion.md) | ✅ Done |
| 32 | [Plan mode: `permissionMode: 'plan'` (explore read-only, write a plan file to `CLAUDE_CONFIG_DIR/plans/` or `plansDirectory`), an approval dialog in `canUseTool("ExitPlanMode")` (`plan`, `planFilePath`), approve with `updatedPermissions` `setMode` `acceptEdits` or without it (the mode becomes `default`), an edited plan (`updatedInput.plan`, `planWasEdited`), keep planning (`deny` + feedback), cancel (`interrupt: true`), a host-side timeout, `system/status`, `EnterPlanMode`, `planModeInstructions`, a `PreToolUse` policy hook (its `allow` does not skip the user), and why plan mode is not a sandbox (with a `canUseTool`, your function must deny writes while the mode is `plan`)](Tab32-Plan-mode.md) | ✅ Done |
| 33 | [MCP elicitation: an MCP server asks the user in the middle of a tool call (`server.elicitInput()`), `Options.onElicitation` (`serverName`, `message`, `requestedSchema`), `accept` + `content` / `decline` / `cancel`, a form built from the schema, the host's and the server's schema checks (`-32602`), a confirmation the server asks for, client capabilities (form only in 2.1.281) and a URL-mode fallback with a sign-in page, `system/elicitation_complete`, timeouts (`-32001`, the aborted `signal`), `Elicitation` / `ElicitationResult` command hooks that answer or rewrite (callback hooks only watch), in-process servers cannot elicit](Tab33-MCP-elicitation.md) | ✅ Done |
| 34 | [Output styles: a style file (`name`, `description`, `keep-coding-instructions`, `force-for-plugin`), the `outputStyle` **setting** (no `outputStyle` option), the built-in styles, project / user / plugin styles and `settingSources`, `system/init.output_style` and `available_output_styles`, what reaches the API (a `# Output Style` system-reminder in the first user message, not the system prompt), what a style removes from the `claude_code` preset (`# Doing tasks`), silent failures (unknown name, wrong case, a forced plugin style), switching in one session (`applyFlagSettings`, `reloadOutputStyles`, `updateSettings('localSettings')`, the cached `initializationResult()`), subagents get no style, a host-side check through a wire tap](Tab34-Output-styles.md) | ✅ Done |
| 35 | [Session stores: a `SessionStore` adapter (`append`, `load`, `listSessions`, `listSessionSummaries`, `delete`, `listSubkeys`), `SessionKey` and dedup by `uuid`, mirroring with `sessionStoreFlush` (`batched` / `eager`), resume on another machine (`load()` before start, a temporary `claude-resume-*` config dir), `continue` with a store, subagent keys (`subagents/agent-<id>`), a tenant key (`CLAUDE_CODE_PROJECT_DIR_NAME`), the session functions with `{ sessionStore }`, `foldSessionSummary`, `importSessionToStore`, `system/mirror_error`, `loadTimeoutMs`, options that do not combine (`persistSession: false`, `enableFileCheckpointing`), a host-side check](Tab35-Session-stores.md) | ✅ Done |
| 36 | [Custom process spawning: `spawnClaudeCodeProcess` (`SpawnOptions`: `command`, `args`, `cwd`, `env`, the forwarded `signal`; `SpawnedProcess`), the stdin/stdout protocol (`control_request/initialize`, `can_use_tool`, `mcp_message`), a remote runner over TCP (a `SpawnedProcess` that is not a process), host tools that stay on the host, `toolAliases`, `debug` / `debugFile`, `executableArgs`, `stderr` with a custom spawner, the abort sequence, failures](Tab36-Process-spawning.md) | ✅ Done |
| 37 | [The permission prompt tool: `permissionPromptToolName` (an MCP tool answers permission prompts instead of `canUseTool`; it receives `{ tool_name, input, tool_use_id }` and returns a JSON `PermissionResult` as text), `canUseTool` as `--permission-prompt-tool stdio` (the two cannot be combined), an in-process gate that waits for the user, an external policy gate (a stdio MCP server), who is asked and when (rules, `permissionMode`, `PreToolUse` hooks, `permissionPrompts`), `updatedInput`, `updatedPermissions` (`session`, `localSettings`), `interrupt`, invalid answers, failures (a missing tool, a failed server, a gate that throws, the `z.record` schema trap)](Tab37-Permission-prompt-tool.md) | ✅ Done |
| 38 | [Prompt suggestions: `promptSuggestions` (sent in `control_request/initialize`), the `prompt_suggestion` message (at most one per turn, after the `result`), the suggestion API call (the conversation + `[SUGGESTION MODE]`, the same model, system prompt and tools, reading the turn's prompt cache), when it is skipped (fewer than 2 assistant replies, a queued message, plan mode, over 10,000 uncached tokens), the switches (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`, `promptSuggestionEnabled`), the filters, its cost in the next `total_cost_usd`, a chat with a suggestion chip](Tab38-Prompt-suggestions.md) | ✅ Done |
| 39 | [`projectConfigRoot`: the flag `--project-config-root=<dir>` (absolute, local, an existing folder, or Claude Code exits at startup), project config from a trusted checkout while `cwd` is a git worktree (`.claude/settings.json` and `settings.local.json`, hooks and their `cwd`, permissions, `.mcp.json`, commands, skills, agents, `CLAUDE_PROJECT_DIR`), what stays with `cwd` (`CLAUDE.md`, the tools), a PR branch's hooks and `permissions.allow` (trust is kept per main checkout and a worktree inherits it), the git fallback of a worktree without `.claude/`, what is refused with the flag](Tab39-Project-config-root.md) | ✅ Done |
| 40 | [`resumeDropsTurn`: the flag `--resume-drops-turn=<id>` (it requires `resumeSessionAt`, print mode only), a truncating resume that names the one turn it drops, the check of the discarded range (the declared prompt first, then only that turn's own entries), the refusal (`error_during_execution`, `Resume rejected by --resume-drops-turn:`, $0), a message queued mid-turn (`attachment/queued_command`) that a plain `resumeSessionAt` loses without a word, which uuid to fork at, host-chosen prompt uuids on `SDKUserMessage`, the recovery path (no retry, resume plainly)](Tab40-Resume-drops-turn.md) | ✅ Done |
| 41 | [The V2 session API and its migration: `unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt` and `SDKSession` (`send()`, a `stream()` that ends at each `result`, `sessionId`, `close()`), its history (added in 0.1.54, `@deprecated` in 0.2.133, removed in 0.3.142), SDK 0.2.141 installed next to 0.3.x under an npm alias, V2 as a thin wrapper over streaming input, resuming V2 sessions with today's `query()`, a `createSession()` on `query()`, processes and cost of four ways, `SDKSessionOptions` (14 fields) vs `Options`](Tab41-V2-session-API.md) | ✅ Done |
| 42 | [The web tools and a research agent: `WebSearch` (a server-side search in a second API call, `allowed_domains` / `blocked_domains`, $10 per 1,000 searches in `modelUsage[m].webSearchRequests`) and `WebFetch` (a local download read by Haiku: the agent sees an answer, not the page), `tool_use_result` (`WebSearchOutput`, `WebFetchOutput`), `usage` vs `modelUsage`, a local HTTPS "mini web" (`*.127.0.0.1.nip.io`, `NODE_EXTRA_CA_CERTS`) that shows http upgrades, the localhost refusal, same-host redirects only, 404, cut pages and the cache, prompt injection and a `PostToolUse` guard (`updatedToolOutput`), `WebFetch(domain:…)` + `permissionMode: "dontAsk"`, a `PreToolUse` hook that forces `allowed_domains`, a research agent (`outputFormat`, `maxBudgetUsd`, hook-enforced tool budgets, a sources ledger, a citation check)](Tab42-Web-tools.md) | ✅ Done |
| 43 | [Remote MCP servers and MCP resources: a remote server protected by OAuth (the 401 with `WWW-Authenticate`, protected resource and authorization server metadata, dynamic client registration), what Claude Code does with no token (`needs-auth`, or `failed: Incompatible auth server`), with a wrong `headers.Authorization` (`failed`, no OAuth fallback) and with a token the host got (client_credentials), the `needs-auth` cache (`mcp-needs-auth-cache.json`, by server name) and its three fixes, `type: "http"` vs `type: "sse"` on the wire, `ListMcpResourcesTool` / `ReadMcpResourceTool` (only with them in `tools`), `ui://` and templates left out of the list, `blobSavedTo`, `resource_link` → `tool_use_result.resourceLinks`, `@server:uri` not expanded in the SDK (the host reads the resource), `q.readMcpResource()` (`ui://` only, MCP Apps), a live session: an expired token (`setMcpServers()` with a new header), a lost MCP session (404), `list_changed` (`reconnectMcpServer()`), `timeout`](Tab43-Remote-MCP-and-resources.md) | ✅ Done |
| 44 | [Observability with OpenTelemetry: telemetry is turned on with env variables only (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`, traces in beta with `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` + `OTEL_TRACES_EXPORTER`), the three signals decoded by a lab OTLP collector (the `claude_code.*` metrics, delta by default; the events `user_prompt`, `api_request`, `tool_decision`, `tool_result`, `hook_execution_*`, `subagent_completed`; the spans `interaction` → `llm_request` / `tool` → `tool.execution`), the joins with the SDK stream (`total_cost_usd` = Σ `cost.usage`, `session.id`, hook `prompt_id` = `prompt.id`, `tool_use_id`), what is redacted until `OTEL_LOG_USER_PROMPTS` / `_ASSISTANT_RESPONSES` / `_TOOL_DETAILS` / `_TOOL_CONTENT` / `_RAW_API_BODIES`, `TRACEPARENT` by hand or from the host's `@opentelemetry/api` span (the SDK injects it), `CLAUDE_CODE_PROPAGATE_TRACEPARENT`, one parent for every turn of a session, a failing tool / a denied tool / a subagent in a trace, http/protobuf, prometheus (pull), cumulative temporality and `OTEL_METRICS_INCLUDE_*`, console, a collector that misbehaves (401, `OTEL_EXPORTER_OTLP_HEADERS`, `otelHeadersHelper`, down, slow; the 2 s shutdown cap)](Tab44-Observability-with-OpenTelemetry.md) | ✅ Done |
| 45 | [Cloud providers: one env switch picks the provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_MANTLE` / `_ANTHROPIC_AWS` / `_ANTHROPIC_GOOGLE_CLOUD`), a lab "cloud" that speaks each wire format (Bedrock `invoke-with-response-stream` + AWS event stream, Vertex `streamRawPredict`, the Messages API) and checks each credential, `accountInfo().apiProvider`, `initializationResult().models` per provider ($0), `modelUsage[..].provider` / `canonicalModel`, per-provider beta flags, SigV4 / `AWS_BEARER_TOKEN_BEDROCK` / `awsCredentialExport` / Workload Identity Federation / `ANTHROPIC_FOUNDRY_API_KEY` / an LLM gateway, the startup access checks, inference profiles and `ANTHROPIC_BEDROCK_REGION_PREFIX`, application inference profile ARNs, `modelOverrides`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `VERTEX_REGION_<MODEL>`, a model that is not enabled (403 / 404), throttling, `CLAUDE_CODE_MAX_RETRIES`, `fallbackModel` on a 529](Tab45-Cloud-providers.md) | ✅ Done |
| 46 | [Prompt caching and cost optimization: a wire tap shows every `cache_control` breakpoint Claude Code sends (system prompt + last message blocks, at most 4) and the cache usage of each call (`cache_creation` 5m / 1h, `cache_read_input_tokens`), the minimum cacheable prefix (4,096 tokens on Haiku 4.5), a cost calculator (1.25× / 2× writes, 0.1× reads, break-even), `settings.promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` / `subagentPromptCacheTtl`, `DISABLE_PROMPT_CACHING`, cross-session reuse, what breaks the cache (a timestamp, one more tool, another model, a per-customer line), `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and `scope: "global"` (first-party URL only), `excludeDynamicSections`, `setModel()` with the `PreModelSwitch` / `PostModelSwitch` hooks (`estimated_cache_write_usd`, deny), a cost checklist](Tab46-Prompt-caching-and-cost-optimization.md) | ✅ Done |
| 47 | [Multi-agent orchestration: model-driven (a lead as the main-thread agent with `agent`, parallel workers through the `Agent` tool, a `SubagentStop` quality gate with `decision: "block"`, `spawn_depth` and a 3-level tree seen through `task_*` messages and hooks, `Agent(type)` scoping, a background worker steered with `SendMessage`, per-worker cost from the `Agent` `tool_use_result`) and code-driven (a pipeline with `outputFormat` + zod handoffs and a code router, a fan-out with a concurrency limit, `Promise.allSettled`, verification and a budget guard, an evaluator-optimizer loop with a writer session and a critic), a checklist](Tab47-Multi-agent-orchestration.md) | ✅ Done |
| 48 | [Security hardening: defence in depth with tool allow-lists, permission denies and managed settings, clean and scrubbed environments, `PostToolUse` redaction, `PreToolUse` egress guards, prompt-injection containment, canary secrets and a collector-backed verification checklist](Tab48-Security-hardening.md) | ✅ Done |
| 49 | [Deploy and CI headless: scriptable runs, machine-readable verdicts, bounded workers and deployment](Tab49-Deploy-and-CI-headless.md) | ✅ Done |
| 50 | [Full-stack capstone: customer support, tenant-scoped tools, approval, sessions, streaming and evals](Tab50-Full-stack-capstone.md) | ✅ Done |
| 51 | [Unit-testing agents without the API: real in-memory MCP tools, hook and permission callbacks, injected async iterators, synthetic streams, mutation detection and virtual timers](Tab51-Unit-testing-agents-without-the-API.md) | ✅ Done |
| 56 | [Agent teams and inter-agent messaging: task ownership and dependencies, peer mailboxes, delivery and acknowledgment, duplicate retries, evidence gates, shutdown, an optional live named SDK worker and an interactive native-team exercise](Tab56-Agent-teams-and-inter-agent-messaging.md) | ✅ Done |

---

## Quick start

For **sample56**, the backend and Vite proxy use **3056**. Open `?lesson=56` for the latest lesson. The historical examples below retain their original port numbers.

```powershell
npm install
npm run dev
```

Open **http://localhost:5173**.

`npm run dev` uses `concurrently` to start two processes:

| Process | Command | Port |
|---|---|---|
| `server` | `node --watch --env-file-if-exists=.env --import tsx server/index.ts` (Express + Agent SDK) | 3001 |
| `web` | `vite` (React UI, forwards `/api` to 3001) | 5173 |

### Prerequisites

- **Node.js 18+** (built with Node 24.21 and npm 11.19)
- **Authentication**, using either of these:
  - an existing Claude Code login (`claude` CLI already signed in). The SDK reuses it, which is how this project was tested, **or**
  - the `ANTHROPIC_API_KEY` environment variable

---

## Running the app from Windows Terminal

These commands work in **PowerShell**, which is the default profile in Windows Terminal.
Where **Command Prompt (cmd)** needs different syntax, both versions are shown.

### 1. Go to the project folder

The path contains spaces, so it must be in quotes:

```powershell
cd "C:\Curso atmira - Los seis pilares del IA Spec-Driven Development (SDD)\Claude Code SDK samples\sample48"
```

### 2. Check the prerequisites (first time only)

```powershell
node -v          # must be v18 or newer
npm -v
claude --version # optional: shows whether the Claude Code CLI is installed
```

### 3. Install dependencies (first time only, or after pulling changes)

```powershell
npm install
npm install-scripts approve esbuild   # npm 11+ only: allow esbuild's install script
npm rebuild esbuild
```

### 4. Authenticate (first time only)

**Option A: Claude Code login** (recommended; this is how the project was tested)

```powershell
claude   # log in when asked, then type /exit
```

**Option B: API key in a `.env` file** (set up in this project)

1. Copy the template and put your key in it:
   ```powershell
   Copy-Item .env.example .env
   notepad .env          # ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Run `npm run dev` as usual. The `dev:server` script loads the file with Node's built-in flag:
   ```json
   "dev:server": "node --watch --env-file-if-exists=.env --import tsx server/index.ts"
   ```
   `--env-file-if-exists` means the server still starts if `.env` is missing; it then uses the Claude Code login instead.
3. When the server starts, it shows which authentication it is using (the key is masked):
   ```
   Auth: ANTHROPIC_API_KEY from .env (sk-ant-api…abcd)
   ```

No SDK code is needed. `query()` passes `process.env` to the Claude Code process it starts,
and that process reads `ANTHROPIC_API_KEY` from it.
`.env` is listed in `.gitignore`, so the key is never committed. Only `.env.example` (with an empty value) is committed.

**Check which credential was used:** expand the `system / init` message in the UI and look at `apiKeySource`:

| `apiKeySource` | Meaning |
|---|---|
| `"ANTHROPIC_API_KEY"` | The key from `.env` (or from the environment) |
| `"none"` | No API key: the claude.ai login (OAuth) is being used |

> **Notes**
> - An API key is billed through the **Anthropic Console** (pay per use, separate from a Claude subscription).
>   If the account has no credits, every request fails with `billing_error` / *"Credit balance is too low"*.
>   Add credits at console.anthropic.com → Billing, or comment out the line in `.env` to go back to the Claude Code login.
> - If you start the server from **inside a Claude Code session** (for example Claude Code's own terminal tool),
>   the agent inherits that session's login and ignores the key. `apiKeySource` then shows `"none"`.
>   A normal Windows Terminal tab doesn't have this problem.

**Option C: API key as a terminal variable** (instead of `.env`)

```powershell
# PowerShell: current terminal session only
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# PowerShell: permanent for your user (open a NEW terminal afterwards)
setx ANTHROPIC_API_KEY "sk-ant-..."
```

```cmd
:: Command Prompt: current terminal session only
set ANTHROPIC_API_KEY=sk-ant-...
```

### 5. Start the app

**Option A: one terminal (server and web together)**

```powershell
npm run dev
```

Output from both processes appears in the same terminal, labelled `[server]` (blue) and `[web]` (green).
Open **http://localhost:5173**, or start it from the terminal:

```powershell
start http://localhost:5173
```

**Option B: two terminal tabs** (the output of each process is easier to read)

Open a second tab in Windows Terminal with `Ctrl+Shift+T`, `cd` to the project folder in both tabs, then run:

```powershell
# Tab 1: Node server with the Agent SDK (port 3001)
npm run dev:server
```

```powershell
# Tab 2: React UI (port 5173)
npm run dev:web
```

Both options reload automatically: `node --watch` restarts the server and Vite refreshes the browser whenever you save a file.

### 6. Stop the app

Press `Ctrl+C` in each terminal where the app is running. If a port stays busy (`EADDRINUSE`), find and stop the process that is using it:

```powershell
# Which process is using port 3001 (or 5173)?
Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object OwningProcess

# Stop it
Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

```cmd
:: Command Prompt: find the PID, then stop it
netstat -ano | findstr :3001
taskkill /PID <pid> /F
```

### 7. Optional: test the server without the UI

Start only the server (`npm run dev:server`), then run this in another tab.
Use `curl.exe` rather than `curl`, because in Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest`.
Putting the JSON body in a file avoids quoting problems in PowerShell:

```powershell
'{"prompt":"Say hello in 5 words."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c1/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

The `event: message` lines should appear in this order: `system/init` → `assistant` → `result`, followed by `event: done`.

### 8. Optional: type-check the whole project

```powershell
npx tsc -p .
```

No output means no errors.

---

## Architecture: why is there a server?

The Agent SDK **does not run in the browser**. `query()` starts a Claude Code agent
process that can read files, run shell commands and call tools, so it has to run in Node.js.
The React app sends a request to a small Express server, and the server streams each SDK message back:

```
React 19.3 (src/)  ──POST /api/c1/query──▶  Express (server/)  ──query()──▶  Claude Code agent
      ▲                                              │
      └──────── Server-Sent Events: one event per SDKMessage ◀┘
```

- **Server → browser** uses Server-Sent Events (SSE). The request is a POST, and the browser's
  `EventSource` only supports GET, so the client reads and parses the response stream itself
  (see [src/lib/sse.ts](src/lib/sse.ts)).
- **Cancellation:** when the browser disconnects, the server calls `abort()` on an `AbortController`.
  That controller is passed to the SDK's `abortController` option, so the agent run stops too.

---

## Project structure

```
sample48/
├── package.json                          # scripts: dev, dev:server (loads .env), dev:web
├── .env                                  # your ANTHROPIC_API_KEY (git-ignored, never commit)
├── .env.example                          # committed template with an empty key
├── .gitignore                            # also lists every folder the server recreates
├── tsconfig.json                         # shared by client and server (types: node, vite/client)
├── vite.config.ts                        # React plugin + /api proxy to :3001
├── index.html
├── Tab1-query().md … Tab48-*.md          # one guide per concept (this file is Tab 1)
├── sandbox/                              # Concepts 3-5 and others: the agent's working folder (git-ignored, recreated)
├── *-lab/                                # per-concept working folders, e.g. store-lab/ (git-ignored, recreated)
├── *-project/, plugins/, …               # committed inputs some concepts load (skills, commands, styles, plugins)
├── mcp-servers/                          # stdio MCP servers: notes-server.ts (Concept 13), rooms-server.ts (Concept 33)
├── server/
│   ├── index.ts                          # Express app; mounts one router per concept (/api/c1 … /api/c48)
│   ├── sse.ts                            # openSse(): SSE headers, AbortController, pipe(asyncIterable)
│   └── concepts/
│       ├── 01-query.ts                   # Concept 1: query() and the message stream
│       ├── 02-options.ts                 # Concept 2: Options
│       ├── 03-tools.ts                   # Concept 3: Built-in tools + sandbox/ seed, reset and file list
│       ├── 04-permissions.ts             # Concept 4: Permissions: canUseTool + POST /decide
│       ├── 05-custom-tools.ts            # Concept 5: Custom tools: tasks + clock MCP servers, GET /tools, GET /tasks
│       ├── 06-sessions.ts                # Concept 6: Sessions
│       ├── 07-hooks.ts                   # Concept 7: Hooks
│       ├── 08-subagents.ts               # Concept 8: Subagents
│       ├── 09-system-prompts.ts          # Concept 9: System prompts
│       ├── 10-structured-interrupt.ts    # Concept 10: Structured output & interrupt
│       ├── 11-skills.ts                  # Concept 11: Skills
│       ├── 12-streaming-input.ts         # Concept 12: Streaming input
│       ├── 13-mcp-servers.ts             # Concept 13: MCP servers
│       ├── 14-thinking-effort-models.ts  # Concept 14: Thinking, effort & models
│       ├── 15-cost-usage.ts              # Concept 15: Cost & usage
│       ├── 16-settings-env.ts            # Concept 16: Settings & env
│       ├── 17-checkpointing.ts           # Concept 17: Checkpointing & rewind
│       ├── 18-sandbox.ts                 # Concept 18: Sandbox
│       ├── 19-session-management.ts      # Concept 19: Session management
│       ├── 20-hooks-in-depth.ts          # Concept 20: Hooks in depth
│       ├── 21-slash-commands.ts          # Concept 21: Slash commands
│       ├── 22-claude-md-memory.ts        # Concept 22: CLAUDE.md & memory
│       ├── 23-plugins.ts                 # Concept 23: Plugins
│       ├── 24-harnesses.ts               # Concept 24: Harnesses
│       ├── 25-compaction-context.ts      # Concept 25: Compaction & context
│       ├── 26-query-control.ts           # Concept 26: Query control methods
│       ├── 27-background-tasks.ts        # Concept 27: Background tasks
│       ├── 28-errors-retries.ts          # Concept 28: Errors, retries & recovery
│       ├── 29-images-files.ts            # Concept 29: Images & file input
│       ├── 29-make-files.ts              # Concept 29 helper: makes its input images and PDF
│       ├── 30-todo-tracking.ts           # Concept 30: Todo tracking
│       ├── 31-ask-user-question.ts       # Concept 31: AskUserQuestion
│       ├── 32-plan-mode.ts               # Concept 32: Plan mode
│       ├── 33-mcp-elicitation.ts         # Concept 33: MCP elicitation
│       ├── 34-output-styles.ts           # Concept 34: Output styles
│       ├── 35-session-stores.ts          # Concept 35: Session stores
│       ├── 36-process-spawning.ts        # Concept 36: Process spawning
│       ├── 36-runner.mjs                 # Concept 36 helper: the remote runner (the box)
│       ├── 37-permission-prompt-tool.ts  # Concept 37: The permission prompt tool
│       ├── 37-policy-gate.mjs            # Concept 37 helper: the external policy gate (a stdio MCP server)
│       ├── 38-prompt-suggestions.ts      # Concept 38: Prompt suggestions
│       ├── 39-project-config-root.ts     # Concept 39: projectConfigRoot
│       ├── 40-resume-drops-turn.ts       # Concept 40: resumeDropsTurn
│       ├── 41-v2-session-api.ts          # Concept 41: The V2 session API (unstable_v2_*) and its migration to query()
│       ├── 41-launcher.mjs               # Concept 41 helper: stands in for claude.exe and counts the processes
│       ├── 42-web-tools.ts               # Concept 42: Web tools (WebSearch, WebFetch), the mini web and a research agent
│       ├── 42-lab-cert.pem, 42-lab-key.pem  # Concept 42 helper: the mini web's self-signed certificate (lab use only)
│       ├── 43-remote-mcp-resources.ts    # Concept 43: Remote MCP (OAuth, http/sse, a live session) and MCP resources
│       ├── 44-otel-observability.ts      # Concept 44: OpenTelemetry (the lab collector, content switches, TRACEPARENT, exporters, a failing collector)
│       ├── 45-cloud-providers.ts         # Concept 45: Cloud providers (the lab cloud: Bedrock, Vertex, Foundry… formats, credentials, model ids, failures)
│       ├── 46-prompt-caching.ts          # Concept 46: Prompt caching and cost (the wire tap: breakpoints and cache usage; TTLs, breakers, model switch)
│       ├── 47-multi-agent.ts             # Concept 47: Multi-agent orchestration (a lead + parallel workers + a quality gate; a 3-level tree, SendMessage; a pipeline, a fan-out, an evaluator loop)
│       └── 48-security-hardening.ts      # Concept 48: Security hardening (least privilege, managed settings, secret controls and prompt-injection containment)
└── src/
    ├── main.tsx                          # React root
    ├── App.tsx                           # tab navigation; each concept adds one entry
    ├── styles.css                        # light/dark theme
    ├── lib/sse.ts                        # streamPost(): fetch + SSE parser
    ├── components/
    │   └── MessageLog.tsx                # expandable view of every raw SDKMessage
    └── concepts/
        ├── Concept01Query.tsx
        ├── Concept02Options.tsx
        ├── Concept03Tools.tsx
        ├── Concept04Permissions.tsx
        ├── Concept05CustomTools.tsx
        ├── Concept06Sessions.tsx
        ├── Concept07Hooks.tsx
        ├── Concept08Subagents.tsx
        ├── Concept09SystemPrompts.tsx
        ├── Concept10StructuredInterrupt.tsx
        ├── Concept11Skills.tsx
        ├── Concept12StreamingInput.tsx
        ├── Concept13McpServers.tsx
        ├── Concept14ThinkingEffortModels.tsx
        ├── Concept15CostUsage.tsx
        ├── Concept16SettingsEnv.tsx
        ├── Concept17Checkpointing.tsx
        ├── Concept18Sandbox.tsx
        ├── Concept19SessionManagement.tsx
        ├── Concept20HooksInDepth.tsx
        ├── Concept21SlashCommands.tsx
        ├── Concept22ClaudeMdMemory.tsx
        ├── Concept23Plugins.tsx
        ├── Concept24Harnesses.tsx
        ├── Concept25CompactionContext.tsx
        ├── Concept26QueryControl.tsx
        ├── Concept27BackgroundTasks.tsx
        ├── Concept28ErrorsRetries.tsx
        ├── Concept29ImagesFiles.tsx
        ├── Concept30TodoTracking.tsx
        ├── Concept31AskUserQuestion.tsx
        ├── Concept32PlanMode.tsx
        ├── Concept33McpElicitation.tsx
        ├── Concept34OutputStyles.tsx
        ├── Concept35SessionStores.tsx
        ├── Concept36ProcessSpawning.tsx
        ├── Concept37PermissionPromptTool.tsx
        ├── Concept38PromptSuggestions.tsx
        ├── Concept39ProjectConfigRoot.tsx
        ├── Concept40ResumeDropsTurn.tsx
        ├── Concept41V2SessionApi.tsx
        ├── Concept42WebTools.tsx
        ├── Concept43RemoteMcp.tsx
        ├── Concept44OtelObservability.tsx
        ├── Concept45CloudProviders.tsx
        ├── Concept46PromptCaching.tsx
        ├── Concept47MultiAgent.tsx
        └── Concept48SecurityHardening.tsx
```

---

## Steps followed

### Step 0: Check the environment

Checked the tool versions and the latest package versions before writing any code:

```bash
node -v                                        # v24.21.0
npm -v                                         # 11.19.0
npm view react version                         # 19.3.0
npm view @anthropic-ai/claude-agent-sdk version  # 0.3.281
npm view vite version                          # 8.3.0
```

### Step 1: Create the project and install dependencies

1. Created `package.json` with `"type": "module"` and the `dev` scripts.
2. Installed the runtime dependencies:
   ```bash
   npm i react@19.3.0 react-dom@19.3.0 @anthropic-ai/claude-agent-sdk express zod
   ```
3. Installed the development dependencies:
   ```bash
   npm i -D vite @vitejs/plugin-react typescript tsx concurrently \
            @types/react @types/react-dom @types/express @types/node
   ```
4. **npm 11 blocks install scripts by default.** Vite and tsx depend on `esbuild`, which needs its
   postinstall script to run, so it had to be approved explicitly:
   ```bash
   npm install-scripts approve esbuild
   npm rebuild esbuild
   ```

### Step 2: Read the SDK's type definitions

The SDK changes quickly, so the code was written against the installed version's
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` rather than from memory. Key findings:

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`
- `SDKMessage` is a union of many message types. The three main ones are
  `SDKSystemMessage` (`system/init`), `SDKAssistantMessage` and `SDKResultMessage`.
- `Options.tools`: `[]` turns off every built-in tool, and `{ type: 'preset', preset: 'claude_code' }` enables all of them.
- The package also includes a `browser-sdk` entry point, but it connects to a *remote* Claude Code
  over WebSocket. It doesn't replace running the SDK in Node, so this project doesn't use it.

### Step 3: Build the server and the React skeleton

- [server/sse.ts](server/sse.ts): a reusable helper that every concept will use.
- [server/index.ts](server/index.ts): the Express app, which mounts one router per concept.
- [src/lib/sse.ts](src/lib/sse.ts), [src/App.tsx](src/App.tsx) and
  [src/components/MessageLog.tsx](src/components/MessageLog.tsx): the UI shell and the raw message viewer.
- [vite.config.ts](vite.config.ts): sets up the `/api` proxy, so the browser only ever talks to `localhost:5173`.

### Step 4: Concept 1, `query()` and the message stream

**Server:** [server/concepts/01-query.ts](server/concepts/01-query.ts)

```ts
const run = query({
  prompt,
  options: {
    abortController: abort, // stop the agent if the browser disconnects
    tools: [], // no built-in tools yet: pure Q&A (tools come in a later concept)
    maxTurns: 1,
  },
});

pipe(run);
```

`pipe(run)` runs `for await (const msg of run)` and sends each message as an SSE event.

**Client:** [src/concepts/Concept01Query.tsx](src/concepts/Concept01Query.tsx) collects every message and
builds three summary cards from them:

| Message | What it contains |
|---|---|
| `system` / `init` | `session_id`, `model`, `tools`, `cwd`, `mcp_servers`, `permissionMode` |
| `assistant` | `message.content[]`: content blocks (`text` for now; later `tool_use`, `thinking`) |
| `result` / `success` | `result` (final text), `total_cost_usd`, `usage`, `duration_ms`, `num_turns` |

What to take away:

1. `query()` doesn't return a single string. It returns an **async iterable** of messages,
   so the app can show each step of the agent as it happens.
2. The `result` message is always the last one, and it holds the cost and usage data.
3. `options` controls everything else: tools, model, limits, and in later concepts permissions, hooks and sessions.

### Step 5: Check that it works

1. **Type-check:** `npx tsc -p .` must exit with 0. The first run failed on the `import "./styles.css"`
   line. Adding `"vite/client"` to `compilerOptions.types` in `tsconfig.json` fixed it.
2. **Endpoint test without the UI:**
   ```bash
   npx tsx server/index.ts
   curl -N -X POST localhost:3001/api/c1/query \
        -H "Content-Type: application/json" \
        -d '{"prompt":"Say hello in 5 words."}'
   ```
   It returned `system/init` → `assistant` → `result` → `done`. Authentication came from the existing Claude Code login.

---

## Things to try in Concept 1

1. Run the default prompt and expand each entry in **Raw SDK message stream** to see its full JSON.
2. Look at `tools` in `system/init`. It's empty because of `tools: []`.
3. Compare `total_cost_usd` and the token counts across different prompts.
4. Ask for something that needs several steps. `maxTurns: 1` stops the agent after one turn.

---

## Step 6: Concept 2, Options

> A detailed, step-by-step account of how this concept was built is in [Tab2-Options.md](Tab2-Options.md).

**Server:** [server/concepts/02-options.ts](server/concepts/02-options.ts)

The route builds `options` from the form. It only sets the options you chose, so leaving a field empty
really means "use the SDK default". Before calling `query()` it sends the options back as an
`options` SSE event, so the UI shows exactly what the SDK received:

```ts
const options: Options = {
  tools: [], // still no built-in tools (Concept 3)
  includePartialMessages: body.includePartialMessages,
};
if (body.model) options.model = body.model;
if (body.systemPromptMode === "custom") options.systemPrompt = body.systemPrompt ?? "";
if (body.systemPromptMode === "preset")
  options.systemPrompt = { type: "preset", preset: "claude_code", append: body.systemPrompt || undefined };
if (body.maxTurns) options.maxTurns = body.maxTurns;
if (body.maxBudgetUsd) options.maxBudgetUsd = body.maxBudgetUsd;

// Echo the options (without the AbortController) so the UI shows exactly what query() received.
send("options", options);

const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
pipe(run);
```

A custom `systemPrompt` string replaces the system prompt; the preset keeps Claude Code's prompt and adds `append`.

**Client:** [src/concepts/Concept02Options.tsx](src/concepts/Concept02Options.tsx)

| Option | What it does | Where you see it |
|---|---|---|
| `model` | Which Claude model runs the agent. Omit it to use the CLI default | `system/init` → `model` |
| `systemPrompt` (string) | **Replaces** the system prompt completely | The tone of the answer (try the pirate example) |
| `systemPrompt` (`preset: "claude_code"` + `append`) | Keeps Claude Code's full system prompt and adds your text at the end | The answer says it is Claude Code, and follows your appended rule |
| `maxTurns` | Stops after N turns with `result/error_max_turns` | `result.num_turns` |
| `maxBudgetUsd` | Stops once the cost goes over N dollars with `result/error_max_budget_usd` | The yellow result card |
| `includePartialMessages` | Also emits `{ type: "stream_event" }` messages, one per Messages API streaming event | The answer appears token by token |

What to take away:

1. **Omitted is not the same as empty.** With no `systemPrompt`, the SDK uses its own minimal default.
   A string replaces it. The `claude_code` preset gives you the full Claude Code prompt, which is much longer
   (compare `usage.input_tokens` and `total_cost_usd` between the modes).
2. **Limits end the run in two ways at once.** When `maxBudgetUsd` or `maxTurns` is reached, the SDK first emits a
   `result` message with an `error_*` subtype and then the `for await` loop **throws**
   (`Claude Code returned an error result: Reached maximum budget ($0.0001)`). Real code should read the
   `result` message and also catch the error. The UI shows both.
3. **Budget is checked after a model call, not before.** With `maxBudgetUsd: 0.0001` the first call still runs
   (≈ $0.001 on Haiku), and then the run stops. It is a safety net, not an exact cap.
4. **Partial messages are extra, not a replacement.** With `includePartialMessages`, text arrives as
   `stream_event` → `event.type: "content_block_delta"` → `delta.text`. The complete `assistant` message
   still arrives at the end. A short answer can produce a dozen `stream_event` messages, so the raw log hides them by default.

### Check that it works

`npx tsc -p .` exits with 0, and these requests were tested against the running server:

| Request | Result |
|---|---|
| Haiku + custom pirate prompt + partial messages | `init.model` = `claude-haiku-4-5-20251001`, 13 `stream_event` messages, *"Ahoy, ye scurvy dogs, welcome aboard!"* |
| Haiku + `maxBudgetUsd: 0.0001` | `result/error_max_budget_usd` (cost $0.00095), then an `error` event |
| Haiku + preset `claude_code` + append "End every answer with ARRR" | *"I'm Claude Code, … ARRR"* |

```powershell
'{"prompt":"Say hello in 5 words.","model":"claude-haiku-4-5-20251001","systemPromptMode":"custom","systemPrompt":"You are a pirate.","includePartialMessages":true}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c2/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

## Things to try in Concept 2

1. Run the same prompt with each model and compare `duration_ms` and `total_cost_usd`.
2. Switch `systemPrompt` between the three modes and compare `input_tokens`.
3. Set `maxBudgetUsd` to `0.0001` and watch the yellow cards.
4. Turn `includePartialMessages` off and on with a long prompt ("Write a 300-word story"), then untick
   "Hide stream_event messages" to see the raw deltas.
5. `maxTurns` has no visible effect yet: with `tools: []` the agent always finishes in one turn.
   You'll see `error_max_turns` in Concept 3, when the agent can call tools and loop.

---

## Step 7: Concept 3, Built-in tools

> A detailed, step-by-step account of how this concept was built is in [Tab3-Built-in-tools.md](Tab3-Built-in-tools.md).

**Server:** [server/concepts/03-tools.ts](server/concepts/03-tools.ts)

The agent works in a `sandbox/` folder that the server seeds with `notes.txt` and `data/tasks.json`.
`GET /api/c3/files` lists it and `POST /api/c3/reset` restores it, so you can see what each run changed:

```ts
const options: Options = {
  tools: body.toolsMode === "preset" ? { type: "preset", preset: "claude_code" } : body.tools,
  allowedTools: body.allowedTools,
  cwd: cwds[body.cwd] ?? SANDBOX,
  // Isolation: without these, the run also inherits your own ~/.claude settings (extra allow rules,
  // plugins) and MCP servers, so tools you never listed can appear and calls you expect denied can pass.
  settingSources: [],
  strictMcpConfig: true,
};
if (body.permissionMode) options.permissionMode = body.permissionMode;
// bypassPermissions is refused unless you also opt in explicitly.
if (body.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
```

`tools` is a `string[]` or the `claude_code` preset. `allowedTools` holds tool names or rules like `Bash(ls:*)`.
`cwd` comes from a fixed list (`sandbox` or `project`): the browser never sends a path.

**Client:** [src/concepts/Concept03Tools.tsx](src/concepts/Concept03Tools.tsx)

| Option | What it does | Where you see it |
|---|---|---|
| `tools` | Which built-in tools **exist** for the model | `system/init` → `tools` |
| `allowedTools` | Which calls run **without asking**. It doesn't add or remove tools | The call succeeds instead of being denied |
| `permissionMode` | Policy for calls that aren't pre-allowed: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` | `system/init` → `permissionMode`, yellow `tool_result` |
| `cwd` | The folder the agent starts in | `system/init` → `cwd`, the `sandbox/ on disk` card |

The tab pairs each `tool_use` block (in an `assistant` message) with its `tool_result` block (in the next `user` message).
Seven scenario buttons change one option at a time: read-only, Write denied, Write + `allowedTools`,
`acceptEdits`, `plan`, a `Bash(ls:*)` rule with `dontAsk`, and `maxTurns: 2`.

What to take away:

1. **With no `canUseTool`, "ask" means "deny".** In `default` mode, `Write` is refused. The run still ends in
   `result/success`, and the refusal is listed in `result.permission_denials`.
2. **A denied model tries something else.** Before isolation was added, the agent wrote the "denied" file to another
   folder that the machine's user settings allowed. Always set `settingSources` and `strictMcpConfig` on purpose.
3. **Tools make `maxTurns` matter.** Each tool call costs a turn, so `maxTurns: 2` now ends with `error_max_turns`.

### Check that it works

`npx tsc -p .` exits with 0, and all seven scenarios were run against the server:

| Scenario | Result |
|---|---|
| Read-only (`Read`, `Glob`, `Grep`) | Ran without asking, `success` |
| `Write`, `default` mode | `permission_denials: [Write]`, no file |
| `Write` in `allowedTools`, or `acceptEdits` | `sandbox/summary.md` created |
| `plan` | `sandbox/` unchanged, plan written to `~/.claude/plans/` |
| `Bash(ls:*)` + `dontAsk` | `ls -la` ran, `touch hello.txt` denied |
| `maxTurns: 2` | `error_max_turns`, then an `error` event |

## Things to try in Concept 3

1. Run scenarios 2, 3 and 4 in order and watch the `sandbox/ on disk` card. Press **Reset sandbox/** in between.
2. Switch `tools` to the `claude_code` preset and count the tools in `system/init`.
3. In scenario 6, change the rule to `Bash(touch:*)` and see which command is denied now.
4. Set `cwd` to **project root** and ask "How many concepts does App.tsx register?" using only `Read` and `Grep`.
5. Remove `settingSources: []` from the server and run scenario 2 again. Compare the result and `total_cost_usd`.

---

## Step 8: Concept 4, Permissions with `canUseTool`

> A detailed, step-by-step account of how this concept was built is in [Tab4-Permissions.md](Tab4-Permissions.md).

**Server:** [server/concepts/04-permissions.ts](server/concepts/04-permissions.ts)

In Concept 3, a call that needed permission was denied because nobody was there to ask. `canUseTool` is an async
function that the SDK **awaits** before such a call runs. The server parks each request in a `Map`, streams it to the
browser as a `permission_request` SSE event, and resolves the promise when the browser POSTs to `/api/c4/decide`:

```ts
const askTheUser: CanUseTool = (toolName, input, opts) =>
  new Promise<PermissionResult>((resolve) => {
    const id = randomUUID();
    ids.push(id);
    pending.set(id, {
      input,
      suggestions: opts.suggestions,
      // …
    });
    send("permission_request", {
      id,
      toolName,
      input,
      // …
    });
    // …
  });
```

`POST /api/c4/decide` receives `{ id, choice, updatedInput?, message? }` and resolves the promise with one of these
four `PermissionResult` shapes (a summary, not a quote of the route):

```ts
{ behavior: "allow", updatedInput }                       // Allow (optionally with an edited input)
{ behavior: "allow", updatedInput, updatedPermissions }   // Allow always (the SDK's suggestions, forced to "session")
{ behavior: "deny", message }                             // Deny: the model reads the message
{ behavior: "deny", message, interrupt: true }            // Deny + interrupt: the whole run stops
```

**Client:** [src/concepts/Concept04Permissions.tsx](src/concepts/Concept04Permissions.tsx)

Each pending call is shown as an approval card with an editable `input` JSON, a deny message and four buttons.
Seven scenario buttons: approve a write, deny with a message, edit the input, always allow, Bash + interrupt,
a policy written in code (no human), and `allowedTools` skipping the callback.

What to take away:

1. **`canUseTool` is only asked about calls that would "ask".** Read-only tools, `allowedTools` entries and the
   `permissionMode` decide first.
2. **A deny `message` is feedback, not just a refusal.** The model reads it and adapts (e.g. writes `SUMMARY.txt` instead).
3. **`updatedInput` changes what really runs, and the model is not told.** It may still claim it wrote `hello.txt`.
4. **`interrupt: true` ends the run** with `result/error_during_execution`, followed by an `error` event.
5. **Check where `updatedPermissions` would be saved.** For Bash, the SDK suggests `localSettings`, a file on disk.
   The server forces `destination: "session"`.

### Check that it works

`npx tsc -p .` exits with 0, and all seven scenarios were run against the server, answered by a script:

| Scenario | Result |
|---|---|
| Approve a write | `Read` not asked, `Write` asked once, `summary.md` created |
| Deny with a message | The model retried as `SUMMARY.txt`. `permission_denials: [Write]` |
| Edit the input | `edited.txt` created instead of `hello.txt`. The answer still says `hello.txt` |
| Always allow | Asked once (suggestion: `setMode acceptEdits`), then `b.txt` and `c.txt` were written without asking |
| Bash + interrupt | `ls` not asked, `touch` allowed, `rm` denied + interrupt → `error_during_execution` |
| Policy in code | `ok.txt` allowed, `../outside.txt` and `rm notes.txt` denied |
| `allowedTools` wins | The callback was never called |

## Things to try in Concept 4

1. In scenario 2, deny twice with different messages and see how the model reacts.
2. In scenario 3, change only `content`. Then read the answer: does the model know?
3. In scenario 4, press plain **Allow** instead and count the approval cards.
4. Leave an approval card open and close the browser tab. The server's `signal` handler denies the call.
5. Change `permissionMode` to `acceptEdits` in scenario 1. Does the approval card still appear?

---

## Step 9: Concept 5, Custom tools with `createSdkMcpServer` + `tool()`

> A detailed, step-by-step account of how this concept was built is in [Tab5-Custom-tools.md](Tab5-Custom-tools.md).

**Server:** [server/concepts/05-custom-tools.ts](server/concepts/05-custom-tools.ts)

A custom tool is a function in the Node server with a zod schema. `tool()` defines it, `createSdkMcpServer()` groups
tools into an **in-process** MCP server, and `options.mcpServers` gives the servers to `query()`:

```ts
tool(
  "complete_task",
  "Mark a task as done, by id.",
  { id: z.number().int().positive().describe("The task id") },
  logged("tasks", "complete_task", async ({ id }) => {
    const all = await readTasks();
    const task = all.find((t) => t.id === id);
    // A normal return with isError: the model reads the message and can react. Throwing would work too.
    if (!task) return fail(`No task with id ${id}. Existing ids: ${all.map((t) => t.id).join(", ")}.`);
    task.done = true;
    await saveTasks(all);
    return ok(task);
  }),
),
```

```ts
const mcpServers = Object.fromEntries(
  body.servers.filter((name) => Object.hasOwn(defs, name)).map((name) => [name, createSdkMcpServer({ name, version: "1.0.0", tools: defs[name] })]),
);

const options: Options = {
  tools: body.tools,
  mcpServers,
  allowedTools: body.allowedTools,
  // …
  strictMcpConfig: true, // only the servers in mcpServers; the machine's own MCP servers stay out
};
```

`ok()` and `fail()` build the `CallToolResult`: `{ content: [{ type: "text", text }] }`, plus `isError: true` for a
failure. `logged()` reports each handler call to the browser.

Two servers: `tasks` (`list_tasks`, `add_task`, `complete_task` on `sandbox/data/tasks.json`) and `clock` (`now`).
Every handler sends a `tool_handler` SSE event, so the UI shows when **your** code ran. `GET /api/c5/tools` returns each
tool's JSON Schema (`z.toJSONSchema`), which is what the model receives.

**Client:** [src/concepts/Concept05CustomTools.tsx](src/concepts/Concept05CustomTools.tsx)

| Piece | What it is | Where you see it |
|---|---|---|
| `tool(name, description, shape, handler)` | One function the model can call. `args` is typed from the zod shape | **Tool definitions** card |
| `createSdkMcpServer({ name, tools })` | An in-process MCP server: `{ type: "sdk", name, instance }` | `system/init` → `mcp_servers` (`"source": "sdk"`) |
| `options.mcpServers` | Which servers exist for this run | `system/init` → `tools`: `mcp__tasks__add_task`, … |
| `allowedTools: ["mcp__tasks"]` | Run a whole server's tools without asking (`mcp__tasks__add_task` for one) | The call succeeds instead of `permission_denials` |
| `CallToolResult` | `{ content: [{ type: "text", text }], isError? }` | **Tool calls** card, `tool_result` / `is_error` |

What to take away:

1. **The model sees `mcp__<server>__<tool>`**, and that is the name to use in `allowedTools`, `canUseTool` and hooks.
2. **zod runs before your code.** An invalid input (`title: "x"`) returns `MCP error -32602: Input validation error`
   to the model, and the handler never runs.
3. **`isError: true` is the tool's way to say "that failed, here is why".** The model reads the message and adapts.
4. **Custom tools need permission like built-in ones.** Without an allow rule the call is denied, even with
   `readOnlyHint: true`. And `allowedTools` never adds a tool: only `mcpServers` does.
5. **The permission check guards the call, not the handler.** `add_task` writes to disk with your server's rights,
   although the `Write` tool is not enabled.

### Check that it works

`npx tsc -p .` exits with 0, and all eight scenarios were run against the server:

| Scenario | Result |
|---|---|
| Something the model can't know | `mcp__clock__now` ran, the answer has the real time in Madrid |
| Allow one tool | 4 tools attached, only `list_tasks` allowed and used |
| Tools that change data | `add_task`, `complete_task`, `list_tasks`; `tasks.json` changed |
| Handler returns `isError` | *"No task with id 99. Existing ids: 1, 2, 3, 4."* |
| zod rejects the input | `Input validation error ... too_small`, no `tool_handler` event |
| Not in `allowedTools` | `permission_denials: [mcp__clock__now]` |
| Server not attached | `init.tools` has only the clock tool |
| Built-in + custom | `Read notes.txt`, then `add_task` for the TODO line |

## Things to try in Concept 5

1. Open **Tool definitions** and compare the `add_task` JSON Schema with its zod shape in the server file.
2. In scenario 5, change `.min(3)` to `.min(1)` in the server. Run it again: now the handler runs.
3. In scenario 2, ask "Add a task called Demo" instead. Which tool is denied, and what does the model say?
4. Remove `.describe(...)` from `now`'s `timeZone` and ask for "the time in Tokyo". Does the model still pass a valid zone?
5. Combine with Concept 4: in [server/concepts/05-custom-tools.ts](server/concepts/05-custom-tools.ts), add a
   `canUseTool` that allows `list_tasks` and denies `complete_task` with a message.

---

## How it was built, step by step (the lab and Concept 1)

This section follows the order in which the lab's skeleton and its first tab were built, so you can rebuild them
yourself. Every later concept reuses these files. The code comes from [server/index.ts](server/index.ts),
[server/sse.ts](server/sse.ts), [src/lib/sse.ts](src/lib/sse.ts), [src/App.tsx](src/App.tsx),
[server/concepts/01-query.ts](server/concepts/01-query.ts) and [src/concepts/Concept01Query.tsx](src/concepts/Concept01Query.tsx).

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `export declare function query`,
`SDKMessage =`, `SDKSystemMessage` and `SDKResultMessage`. Step 2 above lists what they say. The one fact that shapes
the whole lab: `query()` returns an **async iterable**, so the server needs a way to forward each item as it arrives.

### Step 2: Two processes, one command

The SDK must run in Node, and the UI runs in the browser. So the lab has two processes, started together by
[package.json](package.json):

```json
"dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
"dev:server": "node --watch --env-file-if-exists=.env --import tsx server/index.ts",
"dev:web": "vite"
```

The browser only talks to Vite. [vite.config.ts](vite.config.ts) forwards every `/api` call to the server:

```ts
server: {
  port: 5173,
  proxy: { "/api": "http://localhost:3001" },
```

- `--import tsx` lets Node run the TypeScript files directly. There is no build step for the server.
- `--env-file-if-exists=.env` loads `ANTHROPIC_API_KEY` when the file exists (see "Authenticate" above).
- Thanks to the proxy, the React code uses short URLs such as `/api/c1/query`, and there is no CORS setup.

### Step 3: The SSE helper on the server (`openSse`)

Every concept streams its results the same way, so this helper was written first:

```ts
export function openSse(_req: Request, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  async function pipe(stream: AsyncIterable<unknown>) {
    try {
      for await (const msg of stream) send("message", msg);
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: String(err) });
    } finally {
      send("done", {});
      res.end();
    }
  }

  return { abort, send, pipe };
}
```

- `abort` fires when the browser disconnects. A route passes it to the SDK's `abortController` option, so the agent
  stops too.
- `send()` writes any named event. Concept 1 only needs `message`, but later concepts add their own (`options`,
  `permission_request`, `tool_handler`, …).
- `pipe()` always ends with a `done` event, even after an error. An error thrown by the `for await` loop becomes an
  `error` event, unless the run was aborted on purpose.

### Step 4: The Express app (`server/index.ts`)

```ts
import express from "express";
import iconv from "iconv-lite";
import { concept01 } from "./concepts/01-query.js";
// …
delete process.env.WATCH_REPORT_DEPENDENCIES;
// …
iconv.getCodec("utf-8");

const app = express();
// 10mb instead of the default 100kb: Concepts 12 and 29 send images and PDFs as base64 inside the JSON body.
app.use(express.json({ limit: "10mb" }));

// One router per concept: /api/c1/..., /api/c2/..., etc.
app.use("/api/c1", concept01);
// …
app.listen(3001, () => {
  console.log("Agent SDK server on http://localhost:3001");
```

- Each concept is one Express `Router`, mounted under its own prefix. Adding a concept means one `import` and one
  `app.use` line.
- The two lines before `express()` were added later, to fix restart problems with `node --watch`. The comments in
  the file explain both. `iconv-lite` is listed in `package.json` because the server imports it directly.
- The `listen` callback also prints which authentication is used (the key is masked).

### Step 5: The Concept 1 route

```ts
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The body the tab sends. Anything else is refused before query() starts.
const QueryBody = z.object({ prompt: z.string().trim().min(1).max(10000) }).strict();

concept01.post("/query", (req, res) => {
  const parsed = QueryBody.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const { prompt } = parsed.data;

  const run = query({
    prompt,
    options: {
      abortController: abort, // stop the agent if the browser disconnects
      tools: [], // no built-in tools yet: pure Q&A (tools come in a later concept)
      maxTurns: 1,
    },
  });

  pipe(run);
});
```

- The route does not `await` anything. `pipe()` runs the loop and writes to the response until the run ends.
- The body is checked with zod first. `.strict()` refuses unknown keys, and an empty prompt is refused too.
- A bad body still gets an SSE response: one `error` event with a clear message (for example
  `Bad request: prompt: Too small: expected string to have >=1 characters`), then `done`. The tab shows it with
  `alert()`, and `query()` never starts. Concepts 2 to 5 use the same pattern.

### Step 6: The SSE client (`streamPost`)

The browser's `EventSource` only supports GET, so [src/lib/sse.ts](src/lib/sse.ts) reads the POST response itself:

```ts
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop()!;
    for (const chunk of chunks) {
      const event = chunk.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
```

- A network chunk can end in the middle of an event. The last, unfinished piece stays in `buffer` until the next read.
- Each event is the pair of lines that `send()` writes on the server: `event: <name>` and `data: <json>`.
- Before the loop, a non-OK response throws. A 502 gets a hint: "is the server on port 3001 running?".

### Step 7: The React shell

[src/main.tsx](src/main.tsx) renders `<App />` inside `StrictMode` and loads `styles.css`.
[src/App.tsx](src/App.tsx) holds the list of tabs and shows the active one:

```tsx
// Each new concept adds one entry here.
const concepts = [
  { id: 1, title: "query()", Component: Concept01Query },
```

- A tab is only a React component with no props. The nav buttons are built from this array.
- [src/components/MessageLog.tsx](src/components/MessageLog.tsx) shows every raw message as a `<details>` block with
  its `type` and `subtype`. Every later tab reuses it.

### Step 8: The Concept 1 tab

```tsx
  async function run() {
    setMessages([]);
    setRunning(true);
    try {
      await streamPost("/api/c1/query", { prompt }, (event, data) => {
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "error") alert(data.message);
      });
    } finally {
      setRunning(false);
    }
  }

  // Pull the interesting pieces out of the stream
  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
```

- The tab only stores the list of messages. The cards (`system/init`, the answer, `result`) are computed from that
  list on every render.
- The answer is the `text` blocks of every `assistant` message, joined together.
- `error` shows an `alert()`. Concept 2 replaces it with a card (see [Tab2-Options.md](Tab2-Options.md), Step 8).

### Step 9: Check that it works

1. `npx tsc -p .` must print nothing (`tsconfig.json` sets `noEmit`).
2. `npm run dev`, open tab **1. query()** and press **Run query()**. You should see three cards and the raw stream:
   `system/init` → `assistant` → `result`.
3. Without the UI: the `curl.exe` call in "Optional: test the server without the UI" above.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `esbuild` errors when running `vite` or `tsx` | `npm install-scripts approve esbuild && npm rebuild esbuild` |
| `EADDRINUSE :3001` or `:5173` | Another instance is still running. Stop it, or change the port in `server/index.ts` / `vite.config.ts` |
| Authentication error in the `result` message | Run `claude` once and log in, or set `ANTHROPIC_API_KEY` in `.env` |
| `billing_error` / "Credit balance is too low" | The API key's Console account has no credits. Add credits, or comment out the key in `.env` to use the Claude Code login |
| `apiKeySource: "none"` although `.env` has a key | The server was started from inside a Claude Code session. Start it from a normal terminal |
| `[vite] http proxy error ... ECONNREFUSED` and no `Agent SDK server on ...` line | The server did not start. `tsx watch` hangs under `concurrently` on Windows, which is why `dev:server` uses `node --watch --import tsx` |
| The UI shows nothing after clicking Run | Check the `server` output in the terminal; errors are sent to the UI as an `error` event |
