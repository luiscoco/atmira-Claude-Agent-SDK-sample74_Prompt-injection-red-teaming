/**
 * CONCEPT 44 — Observability with OpenTelemetry
 *
 *   options.env = { ...process.env, CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp",
 *                   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", OTEL_TRACES_EXPORTER: "otlp",
 *                   OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
 *
 * Claude Code has OpenTelemetry built in. There is no SDK option for it: the host turns it on with environment variables,
 * and the Claude Code process exports three signals to an OTLP collector:
 *   - METRICS  (claude_code.cost.usage, token.usage, session.count, active_time.total, …): counters, DELTA by default
 *   - EVENTS   (log records: claude_code.user_prompt, api_request, tool_decision, tool_result, hook_execution_*, …)
 *   - TRACES   (beta: claude_code.interaction → llm_request / tool → tool.execution, subagents nested under their tool)
 * The lab runs its own collector (OTLP/HTTP on a port on 127.0.0.1) and decodes what arrives. It shows:
 *   1. the three signals of one run, and how they join the SDK stream (session.id, prompt.id, tool_use_id, the cost);
 *   2. what is recorded about the CONTENT: prompts, answers and tool inputs are redacted until you opt in;
 *   3. distributed tracing: TRACEPARENT in env, or the host's own @opentelemetry/api span (the SDK injects it itself),
 *      and CLAUDE_CODE_PROPAGATE_TRACEPARENT (a traceparent header on every API call);
 *   4. a trace worth reading: a failing tool, a denied tool, a subagent;
 *   5. other exporters and knobs: http/protobuf, prometheus (pull), cumulative temporality, the attribute switches, console;
 *   6. a collector that misbehaves: 401, OTEL_EXPORTER_OTLP_HEADERS, otelHeadersHelper, down, slow. The run never fails.
 * Routes: GET /facts, POST /signals, /privacy, /tracing, /rich, /exporters, /collector (SSE), GET /code.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";
import { z } from "zod";
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { context, trace, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { openSse } from "../sse.js";

export const concept44 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("otel-lab");
const ROOT = process.cwd();
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replaceAll(LAB, "otel-lab")
    .replaceAll(LAB.replaceAll("\\", "\\\\"), "otel-lab") // the same path inside a JSON string
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…");

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A free port on 127.0.0.1 (listen on 0, read it, close). Used for the Prometheus exporter and a "down" collector. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

// ---------------------------------------------------------------------------------------------
// The lab collector: OTLP/HTTP on its own port. JSON is decoded, protobuf is only counted.
// ---------------------------------------------------------------------------------------------

// #region collector
export type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; service: string; start: number; end: number; attrs: Record<string, any>; events: { name: string; attrs: Record<string, any> }[]; error?: string };
export type LogRec = { seq: number; name: string; at: number; traceId?: string; spanId?: string; attrs: Record<string, any> };
export type Point = { metric: string; unit: string; temporality: "delta" | "cumulative"; value: number; attrs: Record<string, any> };
export type ExportRow = { at: number; lane: string; signal: string; contentType: string; bytes: number; status: number; auth?: string; extra?: string; records?: number };
type Store = { spans: Span[]; logs: LogRec[]; points: Point[]; exports: ExportRow[]; resource: Record<string, any>; raw: string[] };
type Mode = "ok" | "auth" | "slow"; // auth: requires Bearer COLLECTOR_TOKEN; slow: answers after SLOW_MS

const COLLECTOR_TOKEN = "lab-collector-token";
const SLOW_MS = 15_000;
const stores = new Map<string, Store>();
const modes = new Map<string, Mode>();
const exportsBus = new EventEmitter(); // one "export" per OTLP request the collector gets
const store = (lane: string) => stores.get(lane) ?? (stores.set(lane, { spans: [], logs: [], points: [], exports: [], resource: {}, raw: [] }), stores.get(lane)!);

/** An OTLP AnyValue as a plain value (arrays and maps as JSON). */
const any = (v: any): any => (v == null ? v : "stringValue" in v ? v.stringValue : "intValue" in v ? Number(v.intValue) : "doubleValue" in v ? v.doubleValue : "boolValue" in v ? v.boolValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(any) : "kvlistValue" in v ? attrsOf(v.kvlistValue.values) : JSON.stringify(v));
const attrsOf = (a: any[] = []) => Object.fromEntries(a.map((x) => [x.key, any(x.value)]));
const ms = (nano: string | number) => Number(BigInt(nano) / 1_000_000n);

/** Decode one OTLP/JSON export into the lane's store. Returns the number of records. */
function ingest(lane: string, signal: string, body: any) {
  const s = store(lane);
  let n = 0;
  for (const rm of body.resourceMetrics ?? []) {
    s.resource = attrsOf(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? [])
      for (const m of sm.metrics ?? []) {
        const kind = m.sum ?? m.gauge ?? m.histogram;
        for (const d of kind?.dataPoints ?? []) {
          n++;
          s.points.push({ metric: m.name, unit: m.unit ?? "", temporality: kind.aggregationTemporality === 2 ? "cumulative" : "delta", value: d.asDouble ?? Number(d.asInt ?? d.sum ?? 0), attrs: attrsOf(d.attributes) });
        }
      }
  }
  for (const rl of body.resourceLogs ?? []) {
    s.resource = attrsOf(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? [])
      for (const l of sl.logRecords ?? []) {
        n++;
        const attrs = attrsOf(l.attributes);
        s.logs.push({ seq: Number(attrs["event.sequence"] ?? 0), name: String(any(l.body)), at: Date.parse(attrs["event.timestamp"] ?? "") || ms(l.timeUnixNano ?? 0), traceId: l.traceId || undefined, spanId: l.spanId || undefined, attrs });
      }
  }
  for (const rs of body.resourceSpans ?? []) {
    const res = attrsOf(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? []) {
        n++;
        const attrs = attrsOf(sp.attributes);
        // The host exports its spans to one URL (lane "host"): each span says which lane it belongs to.
        const target = lane === "host" ? String(attrs["lab.lane"] ?? "host") : lane;
        store(target).spans.push({
          traceId: sp.traceId,
          spanId: sp.spanId,
          parentSpanId: sp.parentSpanId || undefined,
          name: sp.name,
          service: String(res["service.name"] ?? "?"),
          start: ms(sp.startTimeUnixNano),
          end: ms(sp.endTimeUnixNano),
          attrs,
          events: (sp.events ?? []).map((e: any) => ({ name: e.name, attrs: attrsOf(e.attributes) })),
          error: sp.status?.code === 2 ? (sp.status.message ?? "error") : undefined,
        });
        if (target !== lane) exportsBus.emit("export", { at: Date.now(), lane: target, signal: "traces (host)", contentType: "application/json", bytes: 0, status: 200, records: 1 } satisfies ExportRow);
      }
  }
  return n;
}

const collector = express();
collector.use(express.raw({ type: () => true, limit: "20mb" })); // the body as bytes: JSON or protobuf
collector.post("/l/:lane/v1/:signal", (req, res) => {
  const { lane, signal } = req.params;
  const body = req.body as Buffer;
  const ct = String(req.headers["content-type"] ?? "");
  const auth = req.headers.authorization;
  const row: ExportRow = { at: Date.now(), lane, signal, contentType: ct, bytes: body.length, status: 200, auth: auth ? auth.replace(COLLECTOR_TOKEN, "lab-…") : undefined, extra: req.headers["x-lab-helper"] ? `x-lab-helper: ${req.headers["x-lab-helper"]}` : undefined };
  const mode = modes.get(lane) ?? "ok";
  if (mode === "auth" && auth !== `Bearer ${COLLECTOR_TOKEN}`) row.status = 401;
  if (row.status === 200 && ct.includes("json")) {
    try {
      const text = body.toString("utf8");
      row.records = ingest(lane, signal, JSON.parse(text));
      store(lane).raw.push(text); // everything the lane received, to search it for the e-mail (POST /privacy)
    } catch {
      row.status = 400;
    }
  }
  if (lane !== "host") store(lane).exports.push(row), exportsBus.emit("export", row);
  const answer = () => (row.status === 200 ? res.status(200).type(ct.includes("json") ? "application/json" : "application/x-protobuf").send(ct.includes("json") ? "{}" : Buffer.alloc(0)) : res.status(row.status).end());
  if (mode === "slow") setTimeout(answer, SLOW_MS);
  else answer();
});
let collectorBase = "";
const collectorReady = new Promise<string>((resolve) => {
  const s = collector.listen(0, "127.0.0.1", () => resolve((collectorBase = `http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
});
/** A lane: an empty store, a mode, and the endpoint to give Claude Code (OTLP adds /v1/metrics, /v1/logs, /v1/traces). */
async function openLane(lane: string, mode: Mode = "ok") {
  stores.delete(lane);
  modes.set(lane, mode);
  return `${await collectorReady}/l/${lane}`;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// The API tap (Concept 38): ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<lane>. It records the traceparent header.
// ---------------------------------------------------------------------------------------------

const tapBus = new EventEmitter();
const tap = http.createServer(async (req, res) => {
  const m = req.url?.match(/^\/w\/([\w-]+)(\/.*)$/);
  if (!m) return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (m[2].startsWith("/v1/messages")) tapBus.emit("call", { lane: m[1], path: m[2].split("?")[0], traceparent: req.headers.traceparent, at: Date.now() });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  try {
    const up = await fetch(UPSTREAM + m[2], { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => void (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k) && (out[k] = v)));
    res.writeHead(up.status, out);
    for await (const c of up.body ?? []) res.write(c);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
const tapReady = new Promise<string>((resolve) => tap.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(tap.address() as AddressInfo).port}`)));

// ---------------------------------------------------------------------------------------------
// The env that turns telemetry on, and one run
// ---------------------------------------------------------------------------------------------

// #region env
/** Everything is in env: there is no telemetry option in query(). Short intervals so the lab sees the data at once. */
function telemetryEnv(endpoint: string, extra: Record<string, string> = {}) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1", // the master switch
    OTEL_METRICS_EXPORTER: "otlp", // metrics: otlp | prometheus | console
    OTEL_LOGS_EXPORTER: "otlp", // events (log records): otlp | console
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", // traces are beta: this switch AND OTEL_TRACES_EXPORTER
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", // grpc | http/protobuf | http/json (the lab's collector decodes JSON)
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, // + /v1/metrics, /v1/logs, /v1/traces
    OTEL_METRIC_EXPORT_INTERVAL: "2000", // default 60000 ms
    OTEL_LOGS_EXPORT_INTERVAL: "1000", // default 5000 ms
    OTEL_TRACES_EXPORT_INTERVAL: "1000",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=lab,team=support", // your own dimensions, on every signal
    ...extra,
  };
}

/** Env for the Claude Code process: no CLAUDE* or OTEL* of the server's own env (see Tab16), a config dir per lane. */
function laneEnv(lane: string, telemetry: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !k.startsWith("OTEL") && k !== "TRACEPARENT" && k !== "TRACESTATE"));
  const config = path.join(LAB, "config", lane);
  rmSync(config, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(config, { recursive: true });
  return { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...telemetry };
}

const NOTES = "Ticket 42 (customer ana@example.com, card ending 4242): the refund was approved. Next step: email the customer the refund number RF-7781.";
/** The agent's folder: notes.txt with a fake e-mail and card number (to see what the content switches send). */
function workDir(lane: string) {
  const dir = path.join(LAB, "work", lane);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.txt"), NOTES);
  return dir;
}

function base(lane: string, abort: AbortController, telemetry: Record<string, string | undefined>, extra: Partial<Options> = {}): Options {
  return {
    model: MODEL,
    cwd: workDir(lane),
    env: laneEnv(lane, telemetry),
    tools: ["Read"],
    allowedTools: ["Read"],
    settingSources: [],
    thinking: { type: "disabled" },
    maxTurns: 6,
    abortController: abort,
    ...extra,
  };
}
// #endregion

// #region run
export type RunResult = { subtype: string; text: string; cost: number; usage: any; sessionId?: string; resultAt: number; endAt: number; promptIds: string[]; toolUseIds: string[]; stderr: string[] };

/** One query() (a prompt, or a live session's input). Emits the SDK side as rows; the collector's rows come on their own. */
async function runAgent(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, emit: Emit, hooks: { onResult?: (q: Query) => Promise<void> | void } = {}) {
  const t0 = Date.now();
  const out: RunResult = { subtype: "none", text: "", cost: 0, usage: {}, resultAt: 0, endAt: 0, promptIds: [], toolUseIds: [], stderr: [] };
  // A PreToolUse hook: its input has prompt_id, the same value as the prompt.id attribute of the OTel events.
  const withHooks: Options = {
    ...options,
    stderr: (s) => void out.stderr.push(cut(short(s), 300)),
    hooks: {
      ...options.hooks,
      PreToolUse: [
        ...(options.hooks?.PreToolUse ?? []),
        {
          hooks: [
            async (input: any) => {
              if (input.prompt_id && !out.promptIds.includes(input.prompt_id)) out.promptIds.push(input.prompt_id);
              emit("hook", { event: "PreToolUse", tool: input.tool_name, prompt_id: input.prompt_id, session_id: input.session_id });
              return {};
            },
          ],
        },
      ],
    },
  };
  const q = query({ prompt, options: withHooks });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        out.sessionId = m.session_id;
        emit("init", { session_id: m.session_id, tools: m.tools });
      }
      if (m.type === "assistant")
        for (const b of m.message.content) {
          if (b.type === "text" && b.text.trim()) emit("text", { text: cut(short(b.text), 600) });
          if (b.type === "tool_use") out.toolUseIds.push(b.id), emit("tool", { id: b.id, name: b.name, input: JSON.parse(short(JSON.stringify(b.input))) });
        }
      if (m.type === "user" && Array.isArray(m.message.content))
        for (const b of m.message.content)
          if (b.type === "tool_result") emit("toolResult", { id: b.tool_use_id, isError: !!b.is_error, text: cut(short(typeof b.content === "string" ? b.content : JSON.stringify(b.content)), 300) });
      if (m.type === "result") {
        out.subtype = m.subtype;
        out.cost = m.total_cost_usd;
        out.usage = m.usage;
        out.resultAt = Date.now() - t0;
        out.text = m.subtype === "success" ? short(m.result) : short((m.errors ?? []).join("; "));
        emit("result", { subtype: m.subtype, text: cut(out.text, 800), cost: m.total_cost_usd, turns: m.num_turns, usage: { input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens, cache_read_input_tokens: m.usage.cache_read_input_tokens, cache_creation_input_tokens: m.usage.cache_creation_input_tokens }, session_id: m.session_id });
        await hooks.onResult?.(q);
      }
    }
  } catch (err) {
    if (!options.abortController?.signal.aborted) throw err;
  }
  // The loop ends when the Claude Code process has exited: after its telemetry shutdown (flush) is done or timed out.
  out.endAt = Date.now() - t0;
  emit("exit", { resultAt: out.resultAt, endAt: out.endAt });
  return out;
}

/** A streaming-input session (Concept 12): say() sends a turn and waits for its result. */
function liveSession(start: (input: AsyncIterable<SDKUserMessage>, onResult: () => void) => Promise<RunResult>) {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let turnDone: (() => void) | undefined;
  async function* input() {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  const done = start(input(), () => turnDone?.());
  const say = async (text: string) => {
    const t = new Promise<void>((r) => (turnDone = r));
    queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
    wake?.();
    await Promise.race([t, done]);
  };
  const end = async () => ((closed = true), wake?.(), await done);
  return { say, end };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// What a lane received, ready for the tab: metrics summed, events in order, spans (the tab draws the tree)
// ---------------------------------------------------------------------------------------------

// #region signals
/** On every record: who and where. The tab shows them once, not on each row. */
const COMMON = ["user.id", "session.id", "terminal.type", "event.timestamp", "event.sequence", "prompt.id", "organization.id", "user.account_uuid", "user.email", "deployment.environment", "team", "tenant", "app.version"];
const strip = (a: Record<string, any>) => Object.fromEntries(Object.entries(a).filter(([k]) => !COMMON.includes(k)).map(([k, v]) => [k, typeof v === "string" ? cut(short(v), 900) : v]));

function signals(lane: string) {
  const s = store(lane);
  // Metrics: sum the DELTA points per metric + attributes; a CUMULATIVE point already is the total, so keep the last.
  const agg = new Map<string, { metric: string; unit: string; temporality: string; attrs: Record<string, any>; value: number; points: number }>();
  for (const p of s.points) {
    const attrs = strip(p.attrs);
    const k = `${p.metric} ${JSON.stringify(attrs)}`;
    const a = agg.get(k) ?? { metric: p.metric, unit: p.unit, temporality: p.temporality, attrs, value: 0, points: 0 };
    a.value = p.temporality === "delta" ? a.value + p.value : p.value;
    a.points++;
    agg.set(k, a);
  }
  const first = s.logs[0]?.attrs ?? s.points[0]?.attrs ?? {};
  return {
    resource: s.resource,
    common: Object.fromEntries(COMMON.filter((k) => first[k] !== undefined && k !== "event.timestamp" && k !== "event.sequence").map((k) => [k, k === "user.id" ? `${String(first[k]).slice(0, 12)}…` : first[k]])),
    metrics: [...agg.values()].sort((a, b) => a.metric.localeCompare(b.metric)),
    events: [...s.logs].sort((a, b) => a.seq - b.seq || a.at - b.at).map((l) => ({ seq: l.seq, name: l.name.replace(/^claude_code\./, ""), at: l.at, spanId: l.spanId, promptId: l.attrs["prompt.id"], attrs: strip(l.attrs) })),
    spans: s.spans.map((x) => ({ ...x, attrs: strip(x.attrs), events: x.events.map((e) => ({ name: e.name, attrs: strip(e.attrs) })) })),
    exports: s.exports.length,
  };
}

/** Give the last export requests a moment (they are sent before the process exits, but the collector may still be reading). */
const settle = () => sleep(400);
// #endregion

/** An SSE route: parse the body, stream the rows (with their time) and the collector's requests for the run's lanes. */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const emit: Emit = (e, d) => send(e, { ...d, at: (d as any).at !== undefined && (d as any).at > 1e12 ? (d as any).at - startedAt : Date.now() - startedAt });
    const lanes = new Set<string>();
    (emit as any).lanes = lanes;
    const onExport = (r: ExportRow) => lanes.has(r.lane) && emit("export", { ...r });
    const onCall = (c: any) => lanes.has(c.lane) && emit("api", { ...c });
    exportsBus.on("export", onExport);
    tapBus.on("call", onCall);
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await collectorReady;
      await body(parsed.data, abort, emit);
    } catch (err) {
      if (!abort.signal.aborted) emit("error", { message: errText(err) });
    } finally {
      exportsBus.off("export", onExport);
      tapBus.off("call", onCall);
      send("done", {});
      res.end();
    }
  };
}
/** A lane's rows carry its name, and the collector's requests for it are forwarded to this run. */
function laneEmit(emit: Emit, lane: string): Emit {
  ((emit as any).lanes as Set<string>).add(lane);
  return (e, d) => emit(e, { ...d, lane });
}

// ---------------------------------------------------------------------------------------------
// GET /facts
// ---------------------------------------------------------------------------------------------

concept44.get("/facts", async (_req, res) => {
  try {
    const url = await collectorReady;
    const dts = readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"), "utf8").replaceAll("\r\n", "\n");
    const promptId = dts.match(/\/\*\*\n\s*\* UUID correlating a user prompt[\s\S]*?\*\/\n\s*prompt_id\?: string;/)?.[0] ?? "prompt_id: not found";
    const version = JSON.parse(readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).claudeCodeVersion;
    res.json({ collector: url, claudeCodeVersion: version, promptIdDoc: promptId.replace(/\n\s*\*\s?/g, " ").replace(/\/\*\*|\*\//g, "").replace(/\s+/g, " ").trim() });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /signals: one run, the three signals, and how they join the SDK stream
// ---------------------------------------------------------------------------------------------

// #region scenario-signals
concept44.post(
  "/signals",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const lane = "signals";
    const e = laneEmit(emit, lane);
    const telemetry = telemetryEnv(await openLane(lane));
    e("options", { env: { ...telemetry, OTEL_EXPORTER_OTLP_ENDPOINT: telemetry.OTEL_EXPORTER_OTLP_ENDPOINT.replace(collectorBase, "http://127.0.0.1:<collector>") } });
    const run = await runAgent("Read notes.txt and tell me the next step for ticket 42. One line.", base(lane, abort, telemetry), e);
    await settle();
    const sig = signals(lane);
    e("signals", sig);

    // The joins: the SDK stream and the OTel data describe the same run.
    const costOf = (src?: string) => sig.metrics.filter((m) => m.metric === "claude_code.cost.usage" && (!src || m.attrs.query_source === src)).reduce((a, m) => a + m.value, 0);
    const tokens = (type: string, src: string) => sig.metrics.filter((m) => m.metric === "claude_code.token.usage" && m.attrs.type === type && m.attrs.query_source === src).reduce((a, m) => a + m.value, 0);
    const otelPromptIds = [...new Set(sig.events.map((x) => x.promptId).filter(Boolean))];
    const otelToolIds = sig.events.filter((x) => x.name === "tool_result").map((x) => x.attrs.tool_use_id);
    const apiEvents = sig.events.filter((x) => x.name === "api_request").length; // one event and one span per API call
    const llmSpans = sig.spans.filter((x) => x.name === "claude_code.llm_request").length;
    e("check", {
      rows: [
        { what: "cost", sdk: `result.total_cost_usd = ${run.cost.toFixed(6)}`, otel: `Σ claude_code.cost.usage = ${costOf().toFixed(6)} (main ${costOf("main").toFixed(6)} + auxiliary ${costOf("auxiliary").toFixed(6)})`, ok: Math.abs(costOf() - run.cost) < 1e-6 },
        { what: "tokens (main)", sdk: `result.usage: input ${run.usage.input_tokens}, output ${run.usage.output_tokens}`, otel: `claude_code.token.usage{query_source=main}: input ${tokens("input", "main")}, output ${tokens("output", "main")}`, ok: tokens("input", "main") === run.usage.input_tokens && tokens("output", "main") === run.usage.output_tokens },
        { what: "session", sdk: `system/init.session_id = ${run.sessionId}`, otel: `session.id = ${sig.common["session.id"]}`, ok: run.sessionId === sig.common["session.id"] },
        { what: "prompt", sdk: `PreToolUse hook input.prompt_id = ${run.promptIds.join(", ") || "(no hook call)"}`, otel: `prompt.id on the events = ${otelPromptIds.join(", ")}`, ok: run.promptIds.length > 0 && run.promptIds.every((p) => otelPromptIds.includes(p)) },
        { what: "tool call", sdk: `tool_use.id = ${run.toolUseIds.join(", ")}`, otel: `tool_result event tool_use_id = ${otelToolIds.join(", ")}`, ok: run.toolUseIds.length > 0 && run.toolUseIds.every((t) => otelToolIds.includes(t)) },
        { what: "API calls", sdk: "(not in the stream)", otel: `${apiEvents} api_request events · ${llmSpans} llm_request spans`, ok: apiEvents > 0 && apiEvents === llmSpans },
      ],
      timing: `result after ${(run.resultAt / 1000).toFixed(1)} s; the process exited ${((run.endAt - run.resultAt) / 1000).toFixed(1)} s later, after flushing ${sig.exports} export requests`,
    });
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /privacy: what is recorded about the content, with and without the OTEL_LOG_* switches
// ---------------------------------------------------------------------------------------------

// #region scenario-privacy
const CONTENT = { OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1", OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1" };
const PRIVACY_LANES = {
  "pv-default": {},
  "pv-content": CONTENT,
  "pv-raw": { ...CONTENT, OTEL_LOG_RAW_API_BODIES: "1" },
} as Record<string, Record<string, string>>;

concept44.post(
  "/privacy",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await Promise.all(
      Object.entries(PRIVACY_LANES).map(async ([lane, extra]) => {
        const e = laneEmit(emit, lane);
        const telemetry = telemetryEnv(await openLane(lane), extra);
        e("options", { env: extra });
        const run = await runAgent("Read notes.txt. What is the customer's e-mail and the next step? One line.", base(lane, abort, telemetry), e);
        await settle();
        const sig = signals(lane);
        const ev = (n: string) => sig.events.filter((x) => x.name === n);
        const toolSpan = sig.spans.find((x) => x.name === "claude_code.tool");
        const bodies = ev("api_request_body");
        const everything = store(lane).raw.join("\n");
        e("verdict", {
          fields: [
            ["user_prompt · prompt", ev("user_prompt")[0]?.attrs.prompt],
            ["assistant_response · response (the last)", ev("assistant_response").filter((x) => x.attrs.query_source === "sdk").at(-1)?.attrs.response],
            ["interaction span · user_prompt", sig.spans.find((x) => x.name === "claude_code.interaction")?.attrs.user_prompt],
            ["tool_result · tool_input", ev("tool_result")[0]?.attrs.tool_input],
            ["tool span · file_path", toolSpan?.attrs.file_path],
            ["tool span · event tool.output", toolSpan?.events.find((x) => x.name === "tool.output")?.attrs.content],
            ["api_request_body events", bodies.length ? `${bodies.length} events, ${bodies.reduce((a, x) => a + String(x.attrs.body ?? "").length, 0)} chars (the whole request: system prompt, tools, messages)` : undefined],
            ["api_response_body events", ev("api_response_body").length ? `${ev("api_response_body").length} events` : undefined],
          ],
          leaks: { email: everything.split("ana@example.com").length - 1, card: everything.split("4242").length - 1, systemPrompt: everything.includes("You are a Claude agent") },
          bytes: store(lane).exports.reduce((a, x) => a + x.bytes, 0),
          cost: run.cost,
        });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /tracing: the host's trace around the agent: none, TRACEPARENT by hand, @opentelemetry/api (the SDK injects it)
// ---------------------------------------------------------------------------------------------

// #region host-otel
/** The host's own OpenTelemetry, set up once: a tracer provider exporting to the lab collector (lane "host"). */
let hostTracer: Tracer | undefined;
async function hostOtel() {
  if (hostTracer) return hostTracer;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "support-host" }),
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${await collectorReady}/l/host/v1/traces` }))],
  });
  // register(): the global tracer provider, an AsyncLocalStorage context manager and the W3C propagator. The Agent SDK
  // bundles @opentelemetry/api and uses the same globals: when query() starts Claude Code inside an active span, it puts
  // that span in the child's env as TRACEPARENT (unless options.env already sets TRACEPARENT).
  provider.register();
  hostTracer = trace.getTracer("lab-host");
  return hostTracer;
}
// #endregion

// #region traceparent
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
/** Lane b: no OTel library. The host makes the ids, passes TRACEPARENT, and exports its own span as OTLP/JSON. */
async function manualSpan(lane: string, name: string, traceId: string, spanId: string, start: number, end: number) {
  const nano = (t: number) => `${BigInt(t) * 1_000_000n}`;
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "support-host" } }] },
        scopeSpans: [{ scope: { name: "lab-host-manual" }, spans: [{ traceId, spanId, name, kind: 2, startTimeUnixNano: nano(start), endTimeUnixNano: nano(end), attributes: [{ key: "lab.lane", value: { stringValue: lane } }] }] }],
      },
    ],
  };
  await fetch(`${await collectorReady}/l/host/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
// #endregion

// #region scenario-tracing
const TR_PROMPT = "Read notes.txt and tell me the refund number. One line.";

concept44.post(
  "/tracing",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    // a · telemetry on, no parent: each interaction is the root of its own trace
    const none = (async () => {
      const lane = "tr-none";
      const e = laneEmit(emit, lane);
      const telemetry = telemetryEnv(await openLane(lane));
      e("options", { env: { TRACEPARENT: "(not set)" } });
      await runAgent(TR_PROMPT, base(lane, abort, telemetry), e);
    })();

    // b · the host passes TRACEPARENT itself, and CLAUDE_CODE_PROPAGATE_TRACEPARENT puts it on every API call
    const manual = (async () => {
      const lane = "tr-manual";
      const e = laneEmit(emit, lane);
      const traceId = hex(16);
      const spanId = hex(8);
      const traceparent = `00-${traceId}-${spanId}-01`; // W3C: version-traceid-parentid-flags (01 = sampled)
      const telemetry = telemetryEnv(await openLane(lane), { TRACEPARENT: traceparent, CLAUDE_CODE_PROPAGATE_TRACEPARENT: "1", ANTHROPIC_BASE_URL: `${await tapReady}/w/${lane}` });
      e("options", { env: { TRACEPARENT: traceparent, CLAUDE_CODE_PROPAGATE_TRACEPARENT: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:<tap>/w/tr-manual (to see the headers)" } });
      const start = Date.now();
      await runAgent(TR_PROMPT, base(lane, abort, telemetry), e);
      await manualSpan(lane, "POST /tickets/42 (host, by hand)", traceId, spanId, start, Date.now());
      e("host", { action: "POST /v1/traces with the host's span (OTLP/JSON, written by hand)", detail: `traceId ${traceId}, spanId ${spanId}` });
    })();

    // c · the host uses @opentelemetry/api: query() inside an active span. Two turns in one session.
    const auto = (async () => {
      const lane = "tr-auto";
      const e = laneEmit(emit, lane);
      const tracer = await hostOtel();
      const telemetry = telemetryEnv(await openLane(lane));
      const attributes = { "lab.lane": lane };
      const request = tracer.startSpan("POST /tickets/42", { attributes });
      const inRequest = trace.setSpan(context.active(), request);
      const turn1 = tracer.startSpan("turn 1", { attributes }, inRequest);
      e("options", { env: { TRACEPARENT: "(not set: the SDK injects the active span)" } });
      e("host", { action: 'context.with(trace.setSpan(ctx, turn1), () => query({ prompt: session, options }))', detail: `the active span: turn 1 (${turn1.spanContext().spanId})` });
      const s = liveSession((input, onResult) => context.with(trace.setSpan(inRequest, turn1), () => runAgent(input, base(lane, abort, telemetry), e, { onResult })));
      await s.say(TR_PROMPT);
      turn1.end();
      const turn2 = tracer.startSpan("turn 2", { attributes }, inRequest);
      e("host", { action: "turn 2: a new active span, the same session", detail: `turn 2 (${turn2.spanContext().spanId})` });
      await context.with(trace.setSpan(inRequest, turn2), () => s.say("And what is the customer's card ending? One line."));
      turn2.end();
      await s.end();
      request.end();
    })();

    await Promise.all([none, manual, auto].map((p) => p.catch((err) => emit("error", { message: errText(err) }))));
    await settle();
    for (const lane of ["tr-none", "tr-manual", "tr-auto"]) laneEmit(emit, lane)("verdict", signals(lane));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /rich: a trace worth reading: a failing tool, a denied tool, a subagent
// ---------------------------------------------------------------------------------------------

// #region scenario-rich
concept44.post(
  "/rich",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const lane = "rich";
    const e = laneEmit(emit, lane);
    const telemetry = telemetryEnv(await openLane(lane), { OTEL_LOG_TOOL_DETAILS: "1" });
    const options = base(lane, abort, telemetry, {
      tools: ["Read", "Write", "Agent"],
      allowedTools: ["Read", "Agent"], // Write is not allowed: it goes to canUseTool, which denies it
      canUseTool: async (name) => ({ behavior: "deny", message: `${name} is not allowed in this lab` }),
      maxTurns: 10,
    });
    e("options", { tools: options.tools, allowedTools: options.allowedTools, canUseTool: "deny everything it is asked about", env: { OTEL_LOG_TOOL_DETAILS: "1" } });
    const prompt = "Do these in order: 1) Read missing.txt. 2) Write 'done' to done.txt. 3) Use the Agent tool (a general-purpose subagent) to read notes.txt and report the refund number. Then answer in one line.";
    e("prompt", { prompt });
    await runAgent(prompt, options, e);
    await settle();
    e("signals", signals(lane));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /exporters: http/protobuf, prometheus, cumulative + the attribute switches, console
// ---------------------------------------------------------------------------------------------

// #region scenario-exporters
concept44.post(
  "/exporters",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    const prompt = "Read notes.txt and tell me the refund number. One line.";
    const lanes: Record<string, () => Promise<void>> = {
      "ex-protobuf": async () => {
        const lane = "ex-protobuf";
        const e = laneEmit(emit, lane);
        const extra = { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" };
        e("options", { env: extra });
        await runAgent(prompt, base(lane, abort, telemetryEnv(await openLane(lane), extra)), e);
        await settle();
        const ex = store(lane).exports;
        e("verdict", { text: `${ex.length} requests, ${[...new Set(ex.map((x) => x.contentType))].join(", ")}, ${ex.reduce((a, x) => a + x.bytes, 0)} bytes in all. The lab collector only reads JSON, so it counts them.` });
      },
      "ex-prometheus": async () => {
        const lane = "ex-prometheus";
        const e = laneEmit(emit, lane);
        const port = await freePort();
        const extra = { OTEL_METRICS_EXPORTER: "prometheus", OTEL_EXPORTER_PROMETHEUS_HOST: "127.0.0.1", OTEL_EXPORTER_PROMETHEUS_PORT: String(port) };
        e("options", { env: extra });
        const scrape = () => fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text()).catch((err) => `✗ ${errText(err)}`);
        const samples = (text: string) => text.split("\n").filter((l) => l && !l.startsWith("#"));
        let during: string[] = [];
        // Pull, not push: something must scrape Claude Code's /metrics while it runs. Here: a PostToolUse hook.
        const hook = async () => {
          during = samples(await scrape());
          e("host", { action: `GET http://127.0.0.1:${port}/metrics (from a PostToolUse hook)`, detail: `${during.length} samples` });
          return {};
        };
        await runAgent(prompt, base(lane, abort, telemetryEnv(await openLane(lane), extra), { hooks: { PostToolUse: [{ hooks: [hook] }] } }), e);
        const after = (await scrape()).trim();
        e("verdict", {
          text: `During the run: ${during.length} samples, for example:`,
          sample: during.filter((l) => /cost_usage|session_count/.test(l)).map((l) => cut(l.replace(/user_id="[^"]+"/, 'user_id="…"').replace(/session_id="([\w]{8})[^"]*"/, 'session_id="$1…"'), 400)),
          after: `After the run: ${cut(after, 160)}`,
        });
      },
      "ex-cumulative": async () => {
        const lane = "ex-cumulative";
        const e = laneEmit(emit, lane);
        const extra = { OTEL_METRIC_EXPORT_INTERVAL: "700", OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative", OTEL_METRICS_INCLUDE_SESSION_ID: "false", OTEL_METRICS_INCLUDE_VERSION: "true", OTEL_SERVICE_NAME: "support-bot", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=lab,tenant=acme" };
        e("options", { env: extra });
        await runAgent(prompt, base(lane, abort, telemetryEnv(await openLane(lane), extra)), e);
        await settle();
        const pts = store(lane).points.filter((p) => p.metric === "claude_code.cost.usage");
        // Cumulative: every export repeats each series' running total (a delta export only has what changed).
        const series = [...new Set(pts.map((p) => String(p.attrs.query_source)))].map((src) => `${src}: ${pts.filter((p) => p.attrs.query_source === src).map((p) => p.value.toFixed(6)).join(" → ")}`);
        const metricExports = store(lane).exports.filter((x) => x.signal === "metrics").length;
        e("verdict", { text: `service.name = ${store(lane).resource["service.name"]} · claude_code.cost.usage (${pts[0]?.temporality}) in ${metricExports} metric exports: ${series.join(" · ")} · point attributes: ${Object.keys(pts[0]?.attrs ?? {}).join(", ")} (no session.id)` });
      },
      "ex-console": async () => {
        const lane = "ex-console";
        const e = laneEmit(emit, lane);
        const extra = { OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "console" };
        e("options", { env: extra });
        const run = await runAgent(prompt, base(lane, abort, telemetryEnv(await openLane(lane), extra)), e);
        e("verdict", { text: `result/${run.subtype}: the SDK stream is intact. Lines on stderr: ${run.stderr.length}. Requests to the collector: ${store(lane).exports.length}. In an SDK run stdout is the protocol, so the console exporter gives you nothing to read.` });
      },
    };
    await Promise.all(Object.values(lanes).map((f) => f().catch((err) => emit("error", { message: errText(err) }))));
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /collector: the collector misbehaves. The agent's run is never affected; the data may be.
// ---------------------------------------------------------------------------------------------

// #region scenario-collector
const HELPER = `// otelHeadersHelper: Claude Code runs it and uses the JSON object it prints as the OTLP headers (a token that rotates)
console.log(JSON.stringify({ Authorization: "Bearer ${COLLECTOR_TOKEN}", "x-lab-helper": "minted at " + new Date().toISOString().slice(11, 19) }));
`;
const COLLECTOR_LANES: Record<string, { title: string; mode: Mode; env?: Record<string, string>; settings?: (dir: string) => object; down?: boolean }> = {
  "co-401": { title: "the collector wants a token, none is sent", mode: "auth" },
  "co-headers": { title: "OTEL_EXPORTER_OTLP_HEADERS", mode: "auth", env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${COLLECTOR_TOKEN}` } },
  "co-helper": { title: "otelHeadersHelper (settings)", mode: "auth", settings: (dir) => ({ otelHeadersHelper: `node "${path.join(dir, "headers-helper.mjs")}"` }) },
  "co-down": { title: "the collector is down", mode: "ok", down: true },
  "co-slow": { title: `the collector answers after ${SLOW_MS / 1000} s`, mode: "slow" },
  "co-slow-wait": { title: "slow, and CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=8000", mode: "slow", env: { CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS: "8000" } },
  "co-slow-short": { title: "slow, and CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=300", mode: "slow", env: { CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS: "300" } },
};

concept44.post(
  "/collector",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await Promise.all(
      Object.entries(COLLECTOR_LANES).map(async ([lane, L]) => {
        const e = laneEmit(emit, lane);
        let endpoint = await openLane(lane, L.mode);
        if (L.down) endpoint = `http://127.0.0.1:${await freePort()}/l/${lane}`; // nothing listens there
        const extra = { ...L.env };
        const options = base(lane, abort, telemetryEnv(endpoint, extra));
        if (L.settings) {
          writeFileSync(path.join(options.cwd!, "headers-helper.mjs"), HELPER);
          options.settings = L.settings(options.cwd!) as Options["settings"];
        }
        e("options", { env: { ...extra, ...(L.down && { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:<a closed port>" }), ...(L.env?.OTEL_EXPORTER_OTLP_HEADERS && { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer lab-…" }) }, ...(L.settings && { settings: { otelHeadersHelper: 'node "headers-helper.mjs"' } }) });
        const run = await runAgent("Read notes.txt and tell me the refund number. One line.", options, e);
        await settle();
        const ex = store(lane).exports;
        e("verdict", {
          subtype: run.subtype,
          resultAt: run.resultAt,
          exitAfter: run.endAt - run.resultAt,
          sent: ex.length,
          accepted: ex.filter((x) => x.status === 200).length,
          signals: [...new Set(ex.filter((x) => x.status === 200).map((x) => x.signal))],
          cost: run.cost,
        });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept44.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
