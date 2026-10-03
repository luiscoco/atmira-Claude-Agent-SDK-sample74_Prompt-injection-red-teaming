import express from "express";
import { concept74 } from "./concepts/74-prompt-injection-redteam.js";
import { concept73 } from "./concepts/73-pr-reviewer-fixer.js";
import { concept72 } from "./concepts/72-document-generation-skills.js";
import { concept71 } from "./concepts/71-data-analysis-agent.js";
import { concept70 } from "./concepts/70-python-sdk.js";
import { concept69 } from "./concepts/69-embedding-sdk.js";
import { concept68, scheduledService } from "./concepts/68-scheduled-event-driven.js";
import { concept67 } from "./concepts/67-multi-tenant-saas.js";
import { createServer } from "node:http";
import { concept66 } from "./concepts/66-realtime-websocket.js";
import { attachRealtime } from "./realtime/socket.js";
import { liveRunner } from "./realtime/agent.js";
import { concept65 } from "./concepts/65-human-approval.js";
import { concept64 } from "./concepts/64-browser-playwright-mcp.js";
import iconv from "iconv-lite";
import { concept01 } from "./concepts/01-query.js";
import { concept02 } from "./concepts/02-options.js";
import { concept03 } from "./concepts/03-tools.js";
import { concept04 } from "./concepts/04-permissions.js";
import { concept05 } from "./concepts/05-custom-tools.js";
import { concept06 } from "./concepts/06-sessions.js";
import { concept07 } from "./concepts/07-hooks.js";
import { concept08 } from "./concepts/08-subagents.js";
import { concept09 } from "./concepts/09-system-prompts.js";
import { concept10 } from "./concepts/10-structured-interrupt.js";
import { concept11 } from "./concepts/11-skills.js";
import { concept12 } from "./concepts/12-streaming-input.js";
import { concept13 } from "./concepts/13-mcp-servers.js";
import { concept14 } from "./concepts/14-thinking-effort-models.js";
import { concept15 } from "./concepts/15-cost-usage.js";
import { concept16 } from "./concepts/16-settings-env.js";
import { concept17 } from "./concepts/17-checkpointing.js";
import { concept18 } from "./concepts/18-sandbox.js";
import { concept19 } from "./concepts/19-session-management.js";
import { concept20 } from "./concepts/20-hooks-in-depth.js";
import { concept21 } from "./concepts/21-slash-commands.js";
import { concept22 } from "./concepts/22-claude-md-memory.js";
import { concept23 } from "./concepts/23-plugins.js";
import { concept24 } from "./concepts/24-harnesses.js";
import { concept25 } from "./concepts/25-compaction-context.js";
import { concept26 } from "./concepts/26-query-control.js";
import { concept27 } from "./concepts/27-background-tasks.js";
import { concept28 } from "./concepts/28-errors-retries.js";
import { concept29 } from "./concepts/29-images-files.js";
import { concept30 } from "./concepts/30-todo-tracking.js";
import { concept31 } from "./concepts/31-ask-user-question.js";
import { concept32 } from "./concepts/32-plan-mode.js";
import { concept33 } from "./concepts/33-mcp-elicitation.js";
import { concept34 } from "./concepts/34-output-styles.js";
import { concept35 } from "./concepts/35-session-stores.js";
import { concept36 } from "./concepts/36-process-spawning.js";
import { concept37 } from "./concepts/37-permission-prompt-tool.js";
import { concept38 } from "./concepts/38-prompt-suggestions.js";
import { concept39 } from "./concepts/39-project-config-root.js";
import { concept40 } from "./concepts/40-resume-drops-turn.js";
import { concept41 } from "./concepts/41-v2-session-api.js";
import { concept42 } from "./concepts/42-web-tools.js";
import { concept43 } from "./concepts/43-remote-mcp-resources.js";
import { concept44 } from "./concepts/44-otel-observability.js";
import { concept45 } from "./concepts/45-cloud-providers.js";
import { concept46 } from "./concepts/46-prompt-caching.js";
import { concept47 } from "./concepts/47-multi-agent.js";
import { concept48 } from "./concepts/48-security-hardening.js";
import { concept49 } from "./concepts/49-deploy-ci-headless.js";
import { concept50 } from "./concepts/50-capstone.js";
import { concept51 } from "./concepts/51-unit-testing.js";
import { concept52 } from "./concepts/52-evals.js";
import { concept53 } from "./concepts/53-debugging.js";
import { concept54 } from "./concepts/54-tool-design.js";
import { concept55 } from "./concepts/55-upgrading-sdk.js";
import { concept56 } from "./concepts/56-agent-teams.js";
import { concept57 } from "./concepts/57-parallel-worktrees.js";
import { concept58 } from "./concepts/58-tool-search.js";
import { concept59 } from "./concepts/59-model-routing.js";
import { concept60 } from "./concepts/60-durable-agents.js";
import { concept61 } from "./concepts/61-agent-as-mcp-server.js";
import { concept63 } from "./concepts/63-safe-database-agent.js";
import { concept62 } from "./concepts/62-retrieval-rag.js";

// scripts/dev-server.mjs compares only server/ and mcp-servers/ source contents.
// Keep child processes from reporting their own generated files to a parent dependency watcher.
// 1. Watch mode sets WATCH_REPORT_DEPENDENCIES=1, and every process the agents start inherits it. A `node slow.mjs`
//    run by the Bash tool (Concepts 26, 27) then reported slow.mjs to the watcher, and since the server rewrites
//    slow.mjs at startup, each restart caused the next one: a restart loop. The server's own files are still watched.
delete process.env.WATCH_REPORT_DEPENDENCIES;
// 2. express.json() loads iconv-lite's encodings on the first POST. In a freshly copied node_modules, that first read
//    of the files was seen as a change, and the restart cut the request (a 502 in the browser). Load them now instead.
iconv.getCodec("utf-8");

const app = express();
app.use("/api/c68", concept68); // Keep signed webhook bytes intact before global JSON parsing.
const scheduledTimer = setInterval(() => {
  try { scheduledService.tick(); } catch { /* Full queue: retain the due occurrence for the next tick. */ }
}, 1000);
scheduledTimer.unref();
// 10mb instead of the default 100kb: Concepts 12 and 29 send images and PDFs as base64 inside the JSON body.
app.use(express.json({ limit: "10mb" }));

// One router per concept: /api/c1/..., /api/c2/..., etc.
app.use("/api/c1", concept01);
app.use("/api/c2", concept02);
app.use("/api/c3", concept03);
app.use("/api/c4", concept04);
app.use("/api/c5", concept05);
app.use("/api/c6", concept06);
app.use("/api/c7", concept07);
app.use("/api/c8", concept08);
app.use("/api/c9", concept09);
app.use("/api/c10", concept10);
app.use("/api/c11", concept11);
app.use("/api/c12", concept12);
app.use("/api/c13", concept13); // also serves the "inventory" MCP server on /api/c13/mcp
app.use("/api/c14", concept14);
app.use("/api/c15", concept15);
app.use("/api/c16", concept16);
app.use("/api/c17", concept17);
app.use("/api/c18", concept18);
app.use("/api/c19", concept19);
app.use("/api/c20", concept20);
app.use("/api/c21", concept21);
app.use("/api/c22", concept22);
app.use("/api/c23", concept23);
app.use("/api/c24", concept24);
app.use("/api/c25", concept25);
app.use("/api/c26", concept26);
app.use("/api/c27", concept27);
app.use("/api/c28", concept28); // also runs the fault proxy (its own port on 127.0.0.1)
app.use("/api/c29", concept29); // also runs the wire tap (its own port on 127.0.0.1)
app.use("/api/c30", concept30);
app.use("/api/c31", concept31); // POST /answer releases a question that canUseTool is waiting on
app.use("/api/c32", concept32); // POST /decide releases a plan that canUseTool("ExitPlanMode") is waiting on
app.use("/api/c33", concept33); // POST /respond answers a form that onElicitation is waiting on; /consent is the sign-in page
app.use("/api/c34", concept34); // runs a wire tap (its own port on 127.0.0.1) to show what a style sends to the API
app.use("/api/c35", concept35); // its store is a folder of JSONL files (store-lab/db); two fake machines share it
app.use("/api/c36", concept36); // starts 36-runner.mjs on first use (its own port on 127.0.0.1): Claude Code in a "box"
app.use("/api/c37", concept37); // Claude Code starts its policy gate (37-policy-gate.mjs), which POSTs to /api/c37/gate-log
app.use("/api/c38", concept38); // runs a wire tap (its own port on 127.0.0.1) to see the suggestion call next to the turns
app.use("/api/c39", concept39); // builds config-root-lab/ on first use: a git repo and two worktrees of it (needs git)
app.use("/api/c40", concept40); // its sessions use drops-lab/config as CLAUDE_CONFIG_DIR, so the tab can read the raw transcripts
app.use("/api/c41", concept41); // runs the removed V2 API of SDK 0.2.141 (npm alias claude-agent-sdk-v2) next to today's query()
app.use("/api/c42", concept42); // runs the "mini web" (HTTPS on its own port on 127.0.0.1, reached as *.127.0.0.1.nip.io) for WebFetch
app.use("/api/c43", concept43); // runs "the remote": an OAuth-protected MCP server (http + sse) on its own port on 127.0.0.1
app.use("/api/c44", concept44); // runs the lab OTLP collector (its own port on 127.0.0.1) that Claude Code exports its telemetry to
app.use("/api/c45", concept45); // runs "the cloud" (its own port on 127.0.0.1): Bedrock, Vertex, Foundry… formats, forwarded to the Anthropic API
app.use("/api/c46", concept46); // runs a wire tap (its own port on 127.0.0.1) that shows every cache_control breakpoint and the cache usage of each call
app.use("/api/c47", concept47); // model-driven (a lead agent + the Agent tool) and code-driven (one query() per agent) orchestration
app.use("/api/c48", concept48); // security hardening: least privilege, boundaries, a managed lock, secret scrubbing/redaction, injection defence (its collector runs on its own port on 127.0.0.1 as the exfiltration witness)
app.use("/api/c49", concept49); // deploy & CI headless: claude -p vs query(), runs ci-kit/agent-review.mjs as a CI step and ci-kit/worker.mjs as a deployed service (its own port on 127.0.0.1)
app.use("/api/c50", concept50); // full-stack capstone: a support-desk agent (custom tools, subagent, hooks, human approval, sessions, streaming, structured wrap-up, evals) over capstone-lab/db.json
app.use("/api/c51", concept51); // offline unit tests: real in-memory tools and callbacks, synthetic streams, no model API
app.use("/api/c52", concept52); // evals in depth: an LLM judge (calibrated on a golden set), N trials per case, a committed regression baseline (evals/baseline.json)
app.use("/api/c53", concept53); // debugging: correlated evidence, offline failures, live Read runs, persisted diagnostic bundles

app.use("/api/c54", concept54);
app.use("/api/c55", concept55);
app.use("/api/c56", concept56);
app.use("/api/c57", concept57);
app.use("/api/c58", concept58); // tool search over a 64-tool catalog: offline search/planner, getContextUsage() per ENABLE_TOOL_SEARCH mode, optional live run
app.use("/api/c59", concept59); // model routing: fixed models vs rule, classifier and cascade routers over a graded task set; subagent models; alias resolution
app.use("/api/c60", concept60); // durable agents: a journal, an idempotent ledger, a lease + heartbeat and a supervisor that resumes query() segments after crashes (state in durable-lab/)
app.use("/api/c61", concept61); // the agent as an MCP server: the refund desk on /api/c61/mcp (Streamable HTTP, bearer token) and server/agent-mcp/stdio.ts (stdio)
app.use("/api/c62", concept62);
app.use("/api/c63", concept63);
app.use("/api/c64", concept64);
app.use("/api/c65", concept65);
app.use("/api/c66", concept66);
app.use("/api/c67", concept67);
app.use("/api/c69", concept69);
app.use("/api/c70", concept70);
app.use("/api/c71", concept71); // data-analysis agent: host-computed numbers, a computation ledger and a verified structured report
app.use("/api/c72", concept72); // document generation with Skills: a skill folder with a build script, a tool policy and host-side .docx inspection
app.use("/api/c73", concept73); // autonomous PR reviewer and fixer: a trigger gate, a read-only reviewer, host triage, a scoped fixer in a git worktree, a host test run and a GitHub review payload
app.use("/api/c74", concept74); // prompt-injection red-teaming: an attack corpus, canary oracles, five defence layers, an offline worst-case matrix + CI gate, a detector bench, live trials and an adaptive attacker

// HTTP routes and the WebSocket upgrade share sample74's backend port.
const server = createServer(app);
attachRealtime(server, liveRunner);
server.listen(3074, () => {
  console.log("Agent SDK server on http://localhost:3074");
  // ANTHROPIC_API_KEY comes from .env (loaded by `--env-file-if-exists` in package.json).
  // The SDK passes process.env to the Claude Code process, so no code is needed to use it.
  const key = process.env.ANTHROPIC_API_KEY;
  console.log(key ? `Auth: ANTHROPIC_API_KEY from .env (${key.slice(0, 10)}…${key.slice(-4)})` : "Auth: no API key, using Claude Code login");
});


