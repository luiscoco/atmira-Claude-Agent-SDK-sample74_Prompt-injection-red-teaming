# Observability with OpenTelemetry

This file explains Concept 44 (**observability with OpenTelemetry**) of the Claude Agent SDK Lab. So far the course
watched an agent from the inside: the SDK message stream, `total_cost_usd`, `usage` (Concept 15), hooks (Concepts 7
and 20). In production you also want the agent in the same place as the rest of your system: a metrics backend, a log
store, a trace viewer. Claude Code has **OpenTelemetry built in**. This lab runs its own OTLP collector, turns the
telemetry on, and decodes what arrives: the three signals, how they join the SDK stream, what they say about your
content, how to put the agent inside your own trace, other exporters, and what happens when the collector misbehaves.

**Goal:** send an agent's metrics, events and traces to your observability backend, join them with what the host
already knows, keep private content out of them, and know what is lost when the collector has a bad day.

| Concept | Topic | Routes |
|---|---|---|
| 44 | OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`, traces (beta: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` + `OTEL_TRACES_EXPORTER`), the `claude_code.*` metrics (delta), events and spans, the joins (`total_cost_usd`, `session.id`, hook `prompt_id` = `prompt.id`, `tool_use_id`), the content switches `OTEL_LOG_*` (`<REDACTED>` by default), `TRACEPARENT`, the host's `@opentelemetry/api` span (injected by the SDK), `CLAUDE_CODE_PROPAGATE_TRACEPARENT`, subagents in a trace, `http/protobuf`, `prometheus`, cumulative temporality, `OTEL_METRICS_INCLUDE_*`, `console`, `OTEL_EXPORTER_OTLP_HEADERS`, `otelHeadersHelper`, a collector that is down or slow | `/api/c44/facts`, `/signals`, `/privacy`, `/tracing`, `/rich`, `/exporters`, `/collector` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/44-otel-observability.ts` | **New**: the lab collector (OTLP/HTTP, per-lane modes), an API tap, the env helper, the run helper, the six scenarios, the routes |
| `server/index.ts` | Mounts the router on `/api/c44` |
| `src/concepts/Concept44OtelObservability.tsx` | **New**: the tab, Parts A to H, with a metrics table, an events table and a trace waterfall |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The waterfall, the collector rows, the tables |
| `package.json` | **New packages** for the host side: `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` |
| `.gitignore` | Ignores `otel-lab/` |
| `Tab1-query().md` | Adds Concept 44 to the table and the project tree, the sample44 path |

Claude Code itself needs no package: its OpenTelemetry SDK is inside the CLI. The new packages are only for Part E, a
host that has its own tracing.

---

## Step 1: The smallest example

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const m of query({
  prompt: "Read notes.txt and tell me the next step.",
  options: {
    env: {
      ...process.env,
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",                                  // the master switch
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",                                         // events
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", OTEL_TRACES_EXPORTER: "otlp", // traces are beta: both are needed
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",                           // or grpc, http/protobuf
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",               // + /v1/metrics, /v1/logs, /v1/traces
      OTEL_RESOURCE_ATTRIBUTES: "team=support,tenant=acme",               // your dimensions, on every record
    },
  },
})) {
  if (m.type === "result") console.log(m.total_cost_usd); // the same number as Σ claude_code.cost.usage
}
```

There is **no telemetry option** in `Options`. Everything is an environment variable of the Claude Code process, so it
goes in `options.env` (or in the environment the host passes on). Two things to remember from Concept 16: `options.env`
**replaces** the environment (spread `process.env`), and a server that has `OTEL_*` in its own environment passes them
to every agent. The lab removes `CLAUDE*`, `OTEL_*` and `TRACEPARENT` from the server's env before it adds its own.

## Step 2: The lab collector (Part A)

`the collector` is an Express app on `127.0.0.1`, on a random port, inside the lab server. It stands in for an
OpenTelemetry Collector, Grafana Alloy, Datadog Agent, Honeycomb, etc.

| Endpoint | What it does |
|---|---|
| `POST /l/<lane>/v1/metrics` · `/v1/logs` · `/v1/traces` | OTLP/HTTP. JSON is decoded into the lane's store (points, log records, spans); protobuf is only counted |
| A lane's **mode** | `ok`; `auth` (answers `401` without `Authorization: Bearer lab-collector-token`); `slow` (answers after 15 s) |
| `POST /l/host/v1/traces` | The host's own spans. Each one has a `lab.lane` attribute and goes to that lane's store |

`<lane>` is part of `OTEL_EXPORTER_OTLP_ENDPOINT`, so the tab can show each agent's exports (the **→ collector** rows)
apart, even when six agents run at the same time. A second small server, **the API tap** (Concept 38's idea), sits in
front of the Anthropic API for one lane, to show the headers Claude Code sends.

The short intervals the lab uses (`OTEL_METRIC_EXPORT_INTERVAL: 2000`, logs and traces `1000`) are only there so a
10-second run exports more than once. The defaults are 60 s for metrics and 5 s for logs and traces, and what is left is
flushed when the process exits (Step 8).

## Step 3: One run, three signals (scenario 1)

The agent reads `notes.txt` and answers in one line. What arrived:

```text
system/init  session_id 92decb3e…
→ collector POST /v1/logs     200 · 4 records         (user_prompt, plugin_loaded ×2, managed_settings_resolved)
Read {"file_path":"otel-lab\\work\\signals\\notes.txt"}
hook PreToolUse · input.prompt_id 393efbd8…
→ collector POST /v1/metrics  200 · 11 records
result/success · total_cost_usd $0.0047
→ collector POST /v1/logs     200 · 10 records        (api_request, tool_decision, tool_result, assistant_response…)
→ collector POST /v1/metrics  200 · 6 records
→ collector POST /v1/traces   200 · 7 spans
process exit 1.1 s after the result
```

**Metrics** (scope `com.anthropic.claude_code`), counters, **delta** temporality by default:

| Metric | Unit | Attributes (besides the common ones) |
|---|---|---|
| `claude_code.session.count` | | `start_type` (`fresh`, …) |
| `claude_code.cost.usage` | USD | `model`, `query_source` (`main`, `auxiliary`, `subagent` + `agent.name`) |
| `claude_code.token.usage` | tokens | the same + `type` (`input`, `output`, `cacheRead`, `cacheCreation`) |
| `claude_code.active_time.total` | s | `type` |
| `claude_code.lines_of_code.count`, `commit.count`, `pull_request.count`, `code_edit_tool.decision` | | Only when the agent edits files or runs git (not in these runs) |

**Events** (log records, scope `com.anthropic.claude_code.events`), each with `event.name`, `event.sequence` and
`prompt.id`: `user_prompt`, `api_request` (tokens, `cost_usd`, `duration_ms`, `ttft_ms`, `request_id`, `query_source`),
`assistant_response`, `tool_decision` (`decision`, `source`), `tool_result` (`success`, `duration_ms`, sizes, `error`),
`hook_execution_start` / `_complete`, `subagent_completed`, `plugin_loaded`, `managed_settings_resolved`, and others
such as `api_error` and `compaction`.

**Traces** (scope `com.anthropic.claude_code.tracing`, beta):

```text
interaction                       2090 ms   user_prompt, interaction.sequence, parent.source
├── llm_request                   1267 ms   gen_ai.system=anthropic, tokens, ttft_ms, stop_reason=tool_use, request_id
├── tool  (Read)                    20 ms   tool_name, tool_use_id
│   ├── tool.blocked_on_user        13 ms   the permission step
│   └── tool.execution               6 ms   success
└── llm_request                    728 ms   stop_reason=end_turn
llm_request (generate_session_title)        a trace of its own (see Step 5)
```

**The joins.** The tab checks them after each run, and all of them hold:

| | SDK side | OpenTelemetry side |
|---|---|---|
| cost | `result.total_cost_usd` = 0.004689 | Σ `claude_code.cost.usage` = 0.004689 (main 0.003704 + auxiliary 0.000985) |
| tokens | `result.usage`: input 3114, output 118 | `token.usage{query_source=main}`: input 3114, output 118 |
| session | `system/init.session_id` | `session.id` on every record |
| prompt | a hook's `input.prompt_id` | `prompt.id` on every event of that prompt |
| tool call | `tool_use.id` | `tool_use_id` on the `tool_result` event and the `tool` span |

Two details: `total_cost_usd` **includes** the auxiliary call (the session title) but `result.usage` does not, and
`prompt_id` is in `BaseHookInput` (sdk.d.ts: "Same value emitted on OpenTelemetry events as the `prompt.id` attribute,
so hook output can be joined to OTel events at prompt grain"). That is how you put a hook's own log line next to
Claude Code's events.

## Step 4: What is recorded about the content (scenario 2)

`notes.txt` holds a fake e-mail and card number. Three agents read it and repeat the e-mail. Each lane then searches
**everything its collector received**:

| Field | a · defaults | b · `USER_PROMPTS`, `ASSISTANT_RESPONSES`, `TOOL_DETAILS`, `TOOL_CONTENT` | c · b + `RAW_API_BODIES` |
|---|---|---|---|
| `user_prompt.prompt`, the `interaction` span's `user_prompt` | `<REDACTED>` | the prompt | the prompt |
| `assistant_response.response` | `<REDACTED>` | the answer, with the e-mail | the same |
| `tool_result.tool_input`, the `tool` span's `file_path` | not sent | the path | the path |
| the `tool` span's event `tool.output` | not sent | **the file's content** | the same |
| `api_request_body` / `api_response_body` events | not sent | not sent | **every request**: system prompt, tools, conversation |
| the e-mail appears | **0×** | 2× | 4× |
| the system prompt appears | no | no | **yes** |

The defaults are safe: lengths and sizes are sent, text is not. Each switch is a decision about personal data and
secrets: the text a user typed, what a tool read from disk, and with `OTEL_LOG_RAW_API_BODIES` your whole system
prompt. Turn them on for a debugging environment, not for every tenant in production.

## Step 5: Inside your own trace (scenario 3)

Your service already has a trace for the request that started the agent. Three lanes:

```text
a · no parent
  interaction                     (root: parent.source = "none")
  llm_request generate_session_title   (another trace)

b · TRACEPARENT by hand + CLAUDE_CODE_PROPAGATE_TRACEPARENT=1
  → API POST /v1/messages  traceparent: 00-2b8918c5…-36fff5ac…-01     ← the title call: its own trace
  → API POST /v1/messages  traceparent: 00-450652c8…-8692331f…-01     ← the host's trace id
  POST /tickets/42 (host, by hand)          [support-host]
  └── interaction                            parent.source = "env"
      ├── llm_request · tool · llm_request

c · the host's @opentelemetry/api span, two turns in one session
  POST /tickets/42                          [support-host]
  ├── turn 1
  │   ├── interaction  (turn 1)              parent.source = "env"
  │   └── interaction  (turn 2!)
  └── turn 2                                 (empty)
```

What this shows:

- **In an SDK run, Claude Code reads `TRACEPARENT`** (and `TRACESTATE`) and makes its `interaction` span a child of it
  (`parent.source: "env"`). Lane b builds the W3C header by hand, `00-<32 hex trace id>-<16 hex span id>-01`, and sends
  its own span to the collector as OTLP/JSON: no library at all.
- **The Agent SDK does it for you when the host uses OpenTelemetry.** `sdk.mjs` bundles `@opentelemetry/api` and uses
  the same global registration. When `query()` starts Claude Code inside an active span, it puts that span in the
  child's env as `TRACEPARENT` (unless `options.env` sets one). Lane c only registers a `NodeTracerProvider` and calls
  `query()` inside `context.with(trace.setSpan(ctx, turn1), …)`.
- **One parent for the whole session.** The env is read when the process starts, so turn 2's `interaction` is still
  under turn 1. Parent a span that covers the session, or run one `query()` per request.
- **`CLAUDE_CODE_PROPAGATE_TRACEPARENT=1`** adds a `traceparent` header to each API call (seen in the tap), so a
  gateway or proxy between you and the API can join your trace too.
- The **session-title call** (`generate_session_title`) always starts a trace of its own.
- Metrics have no trace context. Join them by `session.id` (and your `OTEL_RESOURCE_ATTRIBUTES`).

```ts
// #region host-otel (shortened)
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "support-host" }),
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${collector}/v1/traces` }))],
});
provider.register(); // global provider + AsyncLocalStorage context + W3C propagator: the SDK sees them
const span = trace.getTracer("host").startSpan("POST /tickets/42");
await context.with(trace.setSpan(context.active(), span), () => run(query({ prompt, options }))); // TRACEPARENT is set for you
span.end();
```

## Step 6: A trace worth reading (scenario 4)

One run: a `Read` of a file that doesn't exist, a `Write` that `canUseTool` denies, and a subagent that reads
`notes.txt`:

```text
interaction                                   9925 ms
├── llm_request
├── tool Read
│   ├── tool.blocked_on_user
│   └── tool.execution  ✗ "File does not exist…"   (status ERROR, error_class TelemetrySafeError)
├── llm_request
├── tool Write
│   └── tool.blocked_on_user                   (no tool.execution: it was denied)
├── llm_request
├── tool Agent  (subagent_type general-purpose)   5208 ms
│   └── tool.execution                            5207 ms
│       ├── llm_request  subagent (agent_id …)
│       ├── tool Read    (the subagent's, with agent_id)
│       │   ├── tool.blocked_on_user
│       │   └── tool.execution
│       └── llm_request  subagent
└── llm_request
```

And in the events and metrics:

| Where | What |
|---|---|
| `tool_decision` for `Write` | `decision: "reject"`, `source: "user_reject"` (a `canUseTool` deny). `Read`: `accept` / `config` (from `allowedTools`) |
| `tool_result` for `Read` | `success: "false"`, `error: "File does not exist…"` |
| `api_request` from the subagent | `query_source: "agent:builtin:general-purpose"`, `agent.name: "general-purpose"` |
| `subagent_completed` | `is_async: true`, `total_tokens`, `total_tool_uses`, `duration_ms` |
| `cost.usage` / `token.usage` | a `query_source: "subagent"` series with `agent.name` |

The model decides, run by run, whether the subagent runs in the foreground or **in the background**, and the trace
shows which. Foreground (above): the `Agent` span lasts as long as the subagent, and the subagent's own tool spans are
inside it. Background (another run of the same scenario): the `Agent` tool returned in 6 ms, the subagent's
`llm_request` spans still nested under it but ran past its end, `subagent_completed` had `is_async: true`, and the
result came back as a new prompt: a second `interaction`, in a trace of its own.

## Step 7: Other exporters and knobs (scenario 5)

| Lane | Env | What the lab saw |
|---|---|---|
| a | `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` | 5 requests, `application/x-protobuf`, about 21 kB (the JSON run is about 45 kB) |
| b | `OTEL_METRICS_EXPORTER=prometheus`, `OTEL_EXPORTER_PROMETHEUS_HOST` / `_PORT` | **Pull.** A scrape from a `PostToolUse` hook got `claude_code_cost_usage_total{…,query_source="main",…} 0.001966` and the others. After the run: nothing to scrape |
| c | `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative`, `OTEL_METRICS_INCLUDE_SESSION_ID=false`, `OTEL_METRICS_INCLUDE_VERSION=true`, `OTEL_SERVICE_NAME=support-bot` | A point is the running total, and an unchanged series is sent again: over three exports `main` went 0.001972 → 0.003687 (delta would send 0.001972, then 0.001715) and `auxiliary` was 0.000987 → 0.000987 (delta sends it once). No `session.id` on the points, `app.version` added, `service.name: support-bot` |
| d | `console` for all three | Nothing to read: no line on stderr, no export. In an SDK run stdout is the protocol, so `console` is for the terminal |

Prometheus fits a long-lived process. An SDK agent often lives for a few seconds, so push (OTLP) is the usual choice.
`OTEL_METRICS_INCLUDE_SESSION_ID=false` matters for cost: a `session.id` label makes one time series per session.

## Step 8: When the collector misbehaves (scenario 6)

Seven agents, seven collectors:

| Collector | The run | Exit after result | Requests sent · accepted | Arrived |
|---|---|---|---|---|
| a · wants a token, none is sent | `result/success` | 0.7 s | 5 · 0 | nothing |
| b · `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer …"` | `result/success` | 1.2 s | 4 · 4 | logs, traces, metrics |
| c · `otelHeadersHelper` in `options.settings` | `result/success` | 1.2 s | 4 · 4 | logs, traces, metrics |
| d · down (a closed port) | `result/success` | 0.7 s | 0 · 0 | nothing |
| e · answers after 15 s | `result/success` | 2.6 s | 1 · 1 | logs (the first batch only) |
| f · slow + `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=8000` | `result/success` | 2.7 s | 1 · 1 | logs (the first batch only) |
| g · slow + `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=300` | `result/success` | 0.9 s | 1 · 1 | logs (the first batch only) |

The times vary by a few tenths of a second from run to run (lane g: 0.9 to 1.1 s); the pattern does not.

What this shows:

- **Telemetry never fails the run**, and nothing in the SDK stream says an export failed. Watch the data (a "no data
  from service X" alert), not only the runs.
- **Headers:** `OTEL_EXPORTER_OTLP_HEADERS` for a fixed token. `otelHeadersHelper` for one that rotates: Claude Code
  runs the command and uses the JSON object it prints (`{"Authorization": "Bearer …"}`). It works from
  `options.settings` in an SDK run.
- **A slow collector costs data, not time.** The process waits up to 2 s more for its telemetry (it exits about 2.7 s
  after the result instead of about 1 s), then drops what is left. `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` can shorten that wait (lane g: 300 → 0.9 s) but not stretch it (lane f:
  8000 → still 2.7 s): the CLI takes `min(value, 2000)`. The fix is a collector next to the agent (a sidecar, a local agent) that always answers at once.

---

## Things to try in Concept 44

1. In scenario 1, remove `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`. Do the traces stop, with `OTEL_TRACES_EXPORTER` still set?
2. Set `OTEL_LOGS_EXPORT_INTERVAL` to 60000. Does anything arrive before the result? And after it?
3. In scenario 3, lane c, run two `query()` calls (one per turn) instead of one session. Is each interaction under its own turn now?
4. Make an API call fail (a model name that does not exist, or Concept 28's fault proxy as `ANTHROPIC_BASE_URL`) and
   look for the `api_error` event and the `llm_request` span's status.
5. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a real OpenTelemetry Collector (`docker run otel/opentelemetry-collector`) with
   the `debug` exporter, and compare its output with the tab.

## Running the app

```powershell
npm install        # once: this sample adds the @opentelemetry/* packages
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **44. OpenTelemetry** tab. `ANTHROPIC_API_KEY` must be in `.env`. Everything runs on your machine (the
collector and the tap are on 127.0.0.1; only the API is on the internet). With Haiku 4.5: 1 about $0.005, 2 about
$0.015, 3 about $0.016, 4 about $0.02, 5 about $0.019, 6 about $0.033. A full pass costs about $0.11.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c44/facts
curl.exe -N -X POST http://localhost:3001/api/c44/signals -H "Content-Type: application/json" -d "{}"
curl.exe -N -X POST http://localhost:3001/api/c44/collector -H "Content-Type: application/json" -d "{}"
```

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 44 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "sample 44: Observability with OpenTelemetry" (#3 in the list of features the course had not
covered). `sample44-prompts and presentation/sample44.docx` was empty, so the list was the spec. A search of the lab
found no concept that used `OTEL_*` or `CLAUDE_CODE_ENABLE_TELEMETRY`. `sample44/` was a copy of sample43 without
`node_modules`; `npm install` restored it.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab43-Remote-MCP-and-resources.md`, `43-remote-mcp-resources.ts`, `Concept43RemoteMcp.tsx` | The latest style: a server on its own port inside the lab, `sseRoute()`, lanes, `#region` + `/code`, the retrying `/facts`, "Steps followed" |
| `38-prompt-suggestions.ts` | The API tap (`ANTHROPIC_BASE_URL` = a local forwarder) |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types and the CLI

| Found | Used for |
|---|---|
| sdk.d.ts: no telemetry option; `BaseHookInput.prompt_id` ("the `prompt.id` attribute"); `otelHeadersHelper` in `Settings`; `tool_decision` vocabulary in the permission types | Steps 1, 3, 8 |
| The CLI binary (2.1.281): every `OTEL_*` and `CLAUDE_CODE_*OTEL*` variable, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `CLAUDE_CODE_PROPAGATE_TRACEPARENT`, `TRACEPARENT` read only when not interactive, the 8 metric names, the shutdown timeout `min(value, 2000)` | Part A's table, Steps 5 and 8 |
| sdk.mjs: a bundled `@opentelemetry/api` 1.9.0 that injects the active context into the child's env | Step 5, lane c |

### Build step 4: Probe before designing

Three scratchpad scripts (removed at the end) ran a tiny OTLP/HTTP-JSON receiver and `query()` with Haiku 4.5:

| Probe | Result | Decision |
|---|---|---|
| All three signals, `http/json` | 7 requests before the loop ended; cost adds up to `total_cost_usd`; `interaction` parented to `TRACEPARENT` | Scenario 1 and its join table |
| 13 lanes in parallel: defaults, all content switches, console, prometheus, protobuf, cumulative, a rich run, propagate + tap, 401, headers, helper, down, slow | See Steps 4 to 8 | Scenarios 2, 4, 5, 6 |
| Prometheus scraped after `result` | "MetricReader is shutdown" | The lab scrapes from a `PostToolUse` hook |
| `echo hi` as the "denied" tool | Auto-allowed (a read-only command): `accept` | Scenario 4 denies `Write` instead |
| A `NodeTracerProvider` host, two turns in one session | Automatic `TRACEPARENT`; turn 2 under turn 1 | Scenario 3, lane c, and its note |

### Build step 5: Design the concept

- **The collector** inside the lab server, one URL path per lane, a mode per lane (`ok`, `auth`, `slow`), and an
  `export` emitter: every request is a row in the tab.
- **One env helper** (`telemetryEnv()`) with every switch commented, and **one run helper** (`runAgent()`) that adds a
  `PreToolUse` hook (for `prompt_id`) and times the gap between `result` and the end of the loop (the flush).
- **`signals()`**: the lane's points summed per series, the events in `event.sequence` order, the spans. The tab draws
  the waterfall.
- **Six scenarios**, each a route; lanes run in parallel, each with its own `CLAUDE_CONFIG_DIR` and work folder.

### Build step 6: Implement it

| File | What |
|---|---|
| `server/concepts/44-otel-observability.ts` | The collector, the tap, `telemetryEnv()`, `runAgent()`, `liveSession()`, `signals()`, `hostOtel()`, `manualSpan()`, the six routes |
| `src/concepts/Concept44OtelObservability.tsx` | `Trail`, `Metrics`, `Events`, `Waterfall`, `Signals`, `Lanes`, Parts A to H |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md`, `package.json` | Mount, tab, styles, `otel-lab/`, table row and tree, the OTel packages |

`npx tsc --noEmit -p .` passed.

### Build step 7: Test the routes

The lab server was started on 3001 and each route was called with `curl -N`, all five of the multi-lane ones at the
same time. What the tests changed:

- The Prometheus lane's verdict was first built from a value that did not exist yet. It now keeps the hook's scrape
  and shows the samples it got during the run and what a scrape gets after it.
- `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=8000` made no difference to the slow collector (2.7 s, like the default). The
  CLI caps it (`Math.min(value, 2000)`), and Step 8 says so instead of suggesting a longer wait.
- The cumulative lane printed all points in one list. It now shows one running total per `query_source`.

### Build step 8: Run it in the real app

`npm run dev` (all 44 routers on 3001, Vite on 5173). Headless Chrome was driven with `puppeteer-core` (installed in the
scratchpad, not the project): tab 44, then scenarios 1 to 6, then full-page screenshots.

| Check | Page |
|---|---|
| Open tab 44 | Part A's table with the collector's address and the Claude Code version |
| 1 | The trail with the **→ collector** rows, the join table (all ✓), traces / events / metrics |
| 2 to 6 | The three content lanes with their leak counts, three trace lanes with waterfalls and `traceparent` headers, the rich waterfall with the error and the subagent, four exporter lanes, the collector table |
| Console | No error |

The review of the screenshots added two things: lane b of scenario 2 showed the model's *first* message ("I'll read the
file…"), not its answer (now the last one), and Part D now explains why turn 2's interaction is under turn 1.

### Build step 9: Review the tab's output

Two line-by-line reviews of full runs in the tab found eight more things, now fixed:

- Part B said "On the left"; the trail is **above** the tables.
- The `options` rows showed only the variable names, so lanes a and c of scenario 3 read `options TRACEPARENT` although
  it was not set. They now show `name=value` (`TRACEPARENT=(not set)`).
- Lane c's second `result` showed `$0.0065`: the session's total so far, not turn 2's cost. Part D says so now.
- The cumulative lane had only one export per series, so it did not show a running total. It now exports every 700 ms
  and says how many exports it got (`main: 0.001972 → 0.003687`).
- Prometheus' "After the run: ✗ fetch failed" is now explained: the process has exited, nothing listens on the port.
- The "API calls" row of the join table was always ✓. It now checks that there is one `api_request` event per
  `llm_request` span.
- Step 6 described only a background subagent. A later run had a foreground one (a 5 s `Agent` span with the
  subagent's `Read` inside), so Step 6 now shows that trace and describes both.
- Part G said `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` can shorten the wait without a test. Lane g (300 ms) now shows it:
  0.9 s instead of 2.9 s.

The defaults in Part A (60000 / 5000 / 5000 ms) were checked in the CLI: `var Ut=60000,lt=5000,dt=5000`.
