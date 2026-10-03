import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

const t = (d: any) => (d.at !== undefined ? <span className="subtype" title="time since the start of the run">@ {(d.at / 1000).toFixed(1)} s</span> : null);
const usd = (n?: number) => (n === undefined ? "" : `$${n.toFixed(4)}`);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);
const val = (v: any) => (typeof v === "string" ? v : JSON.stringify(v));

// The env variables that matter, from the probes in Tab44-Observability-with-OpenTelemetry.md (Claude Code 2.1.281).
const ENV: [string, string, string][] = [
  ["CLAUDE_CODE_ENABLE_TELEMETRY", "1", "The master switch. Without it nothing is exported"],
  ["OTEL_METRICS_EXPORTER", "otlp · prometheus · console", "Counters: cost, tokens, sessions, active time, lines of code, commits, PRs, edit decisions"],
  ["OTEL_LOGS_EXPORTER", "otlp · console", "Events (log records): user_prompt, api_request, api_error, tool_decision, tool_result, hook_execution_*, subagent_completed…"],
  ["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA + OTEL_TRACES_EXPORTER", "1 + otlp", "Traces (beta): interaction → llm_request / tool → tool.blocked_on_user, tool.execution"],
  ["OTEL_EXPORTER_OTLP_PROTOCOL / _ENDPOINT / _HEADERS", "grpc · http/protobuf · http/json", "Where and how. Per signal: OTEL_EXPORTER_OTLP_{METRICS,LOGS,TRACES}_*"],
  ["OTEL_METRIC_EXPORT_INTERVAL · OTEL_LOGS_EXPORT_INTERVAL · OTEL_TRACES_EXPORT_INTERVAL", "ms", "Defaults 60000 / 5000 / 5000. Everything left is flushed when the process exits"],
  ["OTEL_RESOURCE_ATTRIBUTES · OTEL_SERVICE_NAME", "k=v,k=v", "Your dimensions (team, tenant, env). They are on the resource and on every point and event"],
  ["OTEL_LOG_USER_PROMPTS · OTEL_LOG_ASSISTANT_RESPONSES", "1", "Without them the text is <REDACTED> (the length is still sent)"],
  ["OTEL_LOG_TOOL_DETAILS · OTEL_LOG_TOOL_CONTENT", "1", "Tool inputs, file paths, commands · what the tool returned (a span event)"],
  ["OTEL_LOG_RAW_API_BODIES", "1", "Every API request and response body, as events: the system prompt, the tools, the whole conversation"],
  ["OTEL_METRICS_INCLUDE_SESSION_ID · _VERSION · _ACCOUNT_UUID", "true / false", "Metric attributes (cardinality). Defaults: session id yes, version no, account yes"],
  ["TRACEPARENT · CLAUDE_CODE_PROPAGATE_TRACEPARENT", "W3C · 1", "Parent the agent's trace to yours · send a traceparent header on every API call"],
];

function ExportRow({ d }: { d: any }) {
  return (
    <div className="tool-call wire otel-export">
      <span className="tag tag-otel">→ collector</span> <code>POST /v1/{d.signal}</code> <code className={d.status >= 400 ? "bad" : "good"}>{d.status}</code>{" "}
      <span className="subtype">
        {d.contentType.replace("application/", "")} · {kb(d.bytes)}
        {d.records !== undefined && ` · ${d.records} records`}
        {d.auth ? ` · Authorization: ${d.auth}` : ""}
        {d.extra ? ` · ${d.extra}` : ""}
      </span>
      {t(d)}
    </div>
  );
}

function Trail({ events }: { events: Ev[] }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "export") return <ExportRow key={i} d={d} />;
        if (event === "api")
          return (
            <div key={i} className="tool-call wire">
              <span className="tag tag-wire">→ API</span> <code>POST {d.path}</code> <span className="subtype">traceparent:</span> <code className={d.traceparent ? "good" : "bad"}>{d.traceparent ?? "(none)"}</code>
              {t(d)}
            </div>
          );
        if (event === "options")
          return (
            <details key={i} className="tool-call call">
              <summary>
                <span className="tag tag-call">options</span> <span className="snippet">{Object.entries(d.env ?? {}).map(([k, v]) => `${k}=${String(v).length > 40 ? `${String(v).slice(0, 40)}…` : v}`).join(", ").slice(0, 220) || "(no extra env)"}</span>
              </summary>
              <pre className="wrap tur">{JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "at" && k !== "lane")), null, 2)}</pre>
            </details>
          );
        if (event === "prompt")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">prompt</span> <span className="snippet">{d.prompt}</span>
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> <span className="subtype">session_id {d.session_id}</span> · tools <code>{d.tools.join(", ")}</code>
              {t(d)}
            </div>
          );
        if (event === "hook")
          return (
            <div key={i} className="tool-call hook">
              <span className="tag tag-host">hook</span> <code>{d.event}</code> {d.tool} · <span className="subtype">input.prompt_id</span> <code>{d.prompt_id ?? "(none)"}</code>
              {t(d)}
            </div>
          );
        if (event === "host")
          return (
            <div key={i} className="tool-call hook">
              <span className="tag tag-host">host</span> <code>{d.action}</code> {d.detail && <span className="snippet">→ {d.detail}</span>}
              {t(d)}
            </div>
          );
        if (event === "tool")
          return (
            <div key={i} className="tool-call web-call">
              <span className="tag tag-call">{d.name}</span> <code>{JSON.stringify(d.input).slice(0, 200)}</code> <span className="subtype">{d.id}</span>
              {t(d)}
            </div>
          );
        if (event === "toolResult")
          return (
            <div key={i} className={`tool-call ${d.isError ? "denied" : "web-result"}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>tool_result</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "text")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result/{d.subtype}</span>{" "}
              <span className="subtype">
                {d.turns} turns · total_cost_usd {usd(d.cost)} · usage in {d.usage.input_tokens} / out {d.usage.output_tokens}
              </span>
              {t(d)}
            </div>
          );
        if (event === "exit")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">process exit</span>{" "}
              <span className="subtype">
                {((d.endAt - d.resultAt) / 1000).toFixed(1)} s after the result (the telemetry flush happens here)
              </span>
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span> <span className="snippet">{d.message}</span>
            </div>
          );
        return null;
      })}
    </>
  );
}

/** The metrics, summed per series (a delta point adds, a cumulative point replaces). */
function Metrics({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare otel-table">
      <thead>
        <tr>
          <th>metric</th>
          <th>attributes (without the common ones)</th>
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => (
          <tr key={i}>
            <td>
              <code>{m.metric.replace("claude_code.", "")}</code>
              <div className="subtype">
                {m.unit} · {m.temporality} · {m.points} pt
              </div>
            </td>
            <td className="snippet">{Object.entries(m.attrs).map(([k, v]) => `${k}=${val(v)}`).join("  ")}</td>
            <td>
              <b>{m.unit === "USD" ? `$${m.value.toFixed(6)}` : Number.isInteger(m.value) ? m.value : m.value.toFixed(3)}</b>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const KEY_ATTRS: Record<string, string[]> = {
  user_prompt: ["prompt", "prompt_length"],
  api_request: ["query_source", "agent.name", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd", "duration_ms", "ttft_ms"],
  assistant_response: ["query_source", "response_length", "response"],
  tool_decision: ["tool_name", "decision", "source", "tool_parameters"],
  tool_result: ["tool_name", "success", "duration_ms", "error", "tool_input", "tool_result_size_bytes"],
  hook_execution_start: ["hook_name"],
  hook_execution_complete: ["hook_name", "num_success", "total_duration_ms"],
  subagent_completed: ["agent_type", "is_async", "total_tokens", "total_tool_uses", "duration_ms"],
  api_request_body: ["body"],
  api_response_body: ["body"],
};

function Events({ rows }: { rows: any[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.filter((r) => !["plugin_loaded", "managed_settings_resolved"].includes(r.name));
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={all} onChange={() => setAll(!all)} /> also plugin_loaded and managed_settings_resolved ({rows.length - rows.filter((r) => !["plugin_loaded", "managed_settings_resolved"].includes(r.name)).length})
      </label>
      <table className="tools compare otel-table">
        <thead>
          <tr>
            <th>#</th>
            <th>event</th>
            <th>key attributes</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const keys = KEY_ATTRS[r.name] ?? Object.keys(r.attrs).filter((k) => k !== "event.name");
            return (
              <tr key={i} className={r.attrs.success === "false" || r.attrs.decision === "reject" ? "otel-bad" : ""}>
                <td>{r.seq}</td>
                <td>
                  <code>{r.name}</code>
                  <div className="subtype">span {r.spanId?.slice(0, 8) ?? "—"}</div>
                </td>
                <td className="snippet">
                  {keys
                    .filter((k) => r.attrs[k] !== undefined)
                    .map((k) => `${k}=${String(val(r.attrs[k])).slice(0, k === "body" ? 300 : 160)}`)
                    .join("  ")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const SPAN_ATTRS = ["tool_name", "subagent_type", "query_source_safe", "input_tokens", "output_tokens", "cache_read_tokens", "ttft_ms", "stop_reason", "decision", "source", "parent.source", "interaction.sequence", "user_prompt", "file_path", "full_command", "agent_id", "success"];

/** The spans as a waterfall: one block per trace, children under their parent, bars on a shared time axis. */
function Waterfall({ spans }: { spans: any[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!spans.length) return <p className="hint">No spans.</p>;
  const ids = new Set(spans.map((s) => s.spanId));
  const t0 = Math.min(...spans.map((s) => s.start));
  const t1 = Math.max(...spans.map((s) => s.end));
  const span = Math.max(1, t1 - t0);
  const traces = [...new Set(spans.map((s) => s.traceId))].map((id) => ({ id, spans: spans.filter((s) => s.traceId === id) }));
  traces.sort((a, b) => b.spans.length - a.spans.length);
  const kids = (list: any[], parent?: string) => list.filter((s) => (parent ? s.parentSpanId === parent : !s.parentSpanId || !ids.has(s.parentSpanId))).sort((a, b) => a.start - b.start);
  const rows: { s: any; depth: number }[][] = traces.map((tr) => {
    const out: { s: any; depth: number }[] = [];
    const walk = (s: any, depth: number) => (out.push({ s, depth }), kids(tr.spans, s.spanId).forEach((k) => walk(k, depth + 1)));
    kids(tr.spans).forEach((r) => walk(r, 0));
    return out;
  });
  return (
    <div className="waterfall">
      {traces.map((tr, ti) => (
        <div key={tr.id} className="wf-trace">
          <div className="subtype">
            trace <code>{tr.id}</code> · {tr.spans.length} spans
            {rows[ti][0]?.s.parentSpanId && !ids.has(rows[ti][0].s.parentSpanId) && <> · the root's parent <code>{rows[ti][0].s.parentSpanId}</code> was not exported</>}
          </div>
          {rows[ti].map(({ s, depth }) => {
            const kind = s.service !== "claude-code" ? "host" : s.name.replace("claude_code.", "").split(".")[0];
            const label = s.attrs.tool_name ?? s.attrs.subagent_type ?? (s.attrs.agent_id ? "subagent" : s.attrs.query_source_safe && s.attrs.query_source_safe !== "sdk" ? s.attrs.query_source_safe : "");
            return (
              <div key={s.spanId}>
                <div className={`wf-row ${open === s.spanId ? "open" : ""}`} onClick={() => setOpen(open === s.spanId ? null : s.spanId)} title="click for the attributes">
                  <div className="wf-name" style={{ paddingLeft: depth * 14 }}>
                    <span className={`wf-dot wf-${kind}`} /> {s.name.replace("claude_code.", "")} {label && <span className="subtype">{label}</span>} {s.error && <b className="bad">✗</b>}
                  </div>
                  <div className="wf-track">
                    <div className={`wf-bar wf-${kind} ${s.error ? "wf-error" : ""}`} style={{ left: `${((s.start - t0) / span) * 100}%`, width: `max(2px, ${((s.end - s.start) / span) * 100}%)` }} />
                  </div>
                  <div className="wf-ms">{s.end - s.start} ms</div>
                </div>
                {open === s.spanId && (
                  <pre className="wrap tur wf-detail">
                    {JSON.stringify(
                      {
                        service: s.service,
                        spanId: s.spanId,
                        parentSpanId: s.parentSpanId,
                        ...Object.fromEntries(Object.entries(s.attrs).filter(([k]) => SPAN_ATTRS.includes(k) || s.service !== "claude-code")),
                        ...(s.error && { status: s.error }),
                        ...(s.events.length && { events: s.events }),
                      },
                      null,
                      2,
                    )}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Signals({ sig }: { sig: any }) {
  const [tab, setTab] = useState<"traces" | "events" | "metrics">("traces");
  return (
    <div className="card otel-signals">
      <p className="hint">
        <b>On every record</b> (the tab hides them below): {Object.entries(sig.common).map(([k, v]) => <code key={k}>{k}={val(v)} </code>)}
        <br />
        <b>resource:</b> {Object.entries(sig.resource).map(([k, v]) => <code key={k}>{k}={val(v)} </code>)}
      </p>
      <div className="row">
        {(["traces", "events", "metrics"] as const).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {k === "traces" ? `traces (${sig.spans.length} spans)` : k === "events" ? `events (${sig.events.length})` : `metrics (${sig.metrics.length} series)`}
          </button>
        ))}
      </div>
      {tab === "traces" && <Waterfall spans={sig.spans} />}
      {tab === "events" && <Events rows={sig.events} />}
      {tab === "metrics" && <Metrics rows={sig.metrics} />}
    </div>
  );
}

const LANE_TITLE: Record<string, string> = {
  "pv-default": "a · the defaults",
  "pv-content": "b · OTEL_LOG_USER_PROMPTS, _ASSISTANT_RESPONSES, _TOOL_DETAILS, _TOOL_CONTENT",
  "pv-raw": "c · the same + OTEL_LOG_RAW_API_BODIES",
  "tr-none": "a · no parent",
  "tr-manual": "b · TRACEPARENT by hand + CLAUDE_CODE_PROPAGATE_TRACEPARENT",
  "tr-auto": "c · the host's @opentelemetry/api span (the SDK injects it), two turns",
  "ex-protobuf": "a · OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
  "ex-prometheus": "b · OTEL_METRICS_EXPORTER=prometheus (pull)",
  "ex-cumulative": "c · cumulative + OTEL_METRICS_INCLUDE_* + OTEL_SERVICE_NAME",
  "ex-console": "d · the console exporters",
  "co-401": "a · the collector wants a token, none is sent",
  "co-headers": "b · OTEL_EXPORTER_OTLP_HEADERS",
  "co-helper": "c · otelHeadersHelper (options.settings)",
  "co-down": "d · the collector is down",
  "co-slow": "e · the collector answers after 15 s",
  "co-slow-wait": "f · slow + CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=8000",
  "co-slow-short": "g · slow + CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=300",
};

function Lanes({ lanes, order, verdict, compact }: { lanes: Record<string, Ev[]>; order: string[]; verdict?: (v: any, lane: string) => React.ReactNode; compact?: boolean }) {
  return (
    <div className="compare-grid lanes43">
      {order.map((l) => {
        const evs = lanes[l] ?? [];
        const v = evs.find((e) => e.event === "verdict")?.data;
        const trail = evs.filter((e) => e.event !== "verdict" && (!compact || !["export", "tool", "toolResult", "hook", "init", "text"].includes(e.event)));
        return (
          <div key={l} className="card">
            <b>{LANE_TITLE[l] ?? l}</b>
            <Trail events={trail} />
            {v && verdict?.(v, l)}
            {!evs.length && <span className="hint">Waiting…</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Concept44OtelObservability() {
  const [facts, setFacts] = useState<any>(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sig, setSig] = useState<Ev[]>([]);
  const [privacy, setPrivacy] = useState<Record<string, Ev[]>>({});
  const [tracing, setTracing] = useState<Record<string, Ev[]>>({});
  const [rich, setRich] = useState<Ev[]>([]);
  const [exporters, setExporters] = useState<Record<string, Ev[]>>({});
  const [coll, setColl] = useState<Record<string, Ev[]>>({});

  useEffect(() => {
    // The server needs a few seconds to start (and restarts on a change): retry for up to 45 s instead of staying empty.
    let stopped = false;
    const get = async (url: string) => {
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) return r.json();
          if (![502, 503, 504].includes(r.status) || i >= 30) throw new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`);
        } catch (e) {
          if (i >= 30 || !(e instanceof TypeError)) throw e;
        }
        if (stopped) throw new Error("unmounted");
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    get("/api/c44/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c44/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, onEvent: (event: string, data: any) => void) {
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, {}, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done") onEvent(event, data);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const collect = (set: (f: (p: Ev[]) => Ev[]) => void) => (event: string, data: any) => set((p) => [...p, { event, data }]);
  const byLane = (set: (f: (p: Record<string, Ev[]>) => Record<string, Ev[]>) => void) => (event: string, data: any) =>
    data.lane && set((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] }));
  const btn = (key: string, label: string, onClick: () => void) => (
    <button className={running === key ? "active" : ""} onClick={onClick} disabled={!!running}>
      {running === key ? "Running…" : label}
    </button>
  );

  const sigData = sig.find((e) => e.event === "signals")?.data;
  const check = sig.find((e) => e.event === "check")?.data;
  const richData = rich.find((e) => e.event === "signals")?.data;

  return (
    <section>
      <h2>44 · Observability with OpenTelemetry</h2>
      <p className="lead">
        Claude Code has OpenTelemetry built in: <b>metrics</b> (cost, tokens, time), <b>events</b> (each prompt, API call, tool decision and result) and, in beta,
        <b> traces</b> (a span per interaction, API call and tool). There is no option in <code>query()</code>: the host turns it on with <b>environment variables</b>,
        and the Claude Code process exports to an OTLP collector. This lab runs its own collector and decodes what arrives: how it joins the SDK stream, what
        it says about your content, how to put the agent inside your own trace, and what happens when the collector misbehaves.
      </p>
      <div className="card">
        <pre>{`const q = query({
  prompt: "Read notes.txt and tell me the next step.",
  options: {
    env: {
      ...process.env,
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", OTEL_TRACES_EXPORTER: "otlp",      // traces are beta
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_RESOURCE_ATTRIBUTES: "team=support,tenant=acme",
    },
  },
});
// A host that already uses @opentelemetry/api: call query() inside an active span, the SDK sets TRACEPARENT for you.`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}

      <h3>A · The switches</h3>
      <p className="hint">
        All of them go in <code>options.env</code> (or the environment the server passes on). Claude Code {facts?.claudeCodeVersion ?? "…"}. The lab's collector: <code>{facts?.collector ?? "…"}</code>, one URL path per
        lane (<code>/l/&lt;lane&gt;/v1/metrics|logs|traces</code>).
      </p>
      <table className="tools compare">
        <thead>
          <tr>
            <th>variable</th>
            <th>values</th>
            <th>what it does</th>
          </tr>
        </thead>
        <tbody>
          {ENV.map((r) => (
            <tr key={r[0]}>
              <td>
                <code>{r[0]}</code>
              </td>
              <td>
                <code>{r[1]}</code>
              </td>
              <td>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>B · One run, three signals</h3>
      <p className="hint">
        The agent reads a file and answers. Below: the SDK stream and the collector's requests (<b>→ collector</b>) in the order they arrive. The run's telemetry is flushed while the
        process exits: that is why <code>query()</code>'s loop ends about a second after <code>result</code>. About $0.005.
      </p>
      <div className="scenarios">
        {btn("signals", "1 · Run with telemetry on", () => {
          setSig([]);
          run("signals", "/api/c44/signals", collect(setSig));
        })}
      </div>
      {sig.length > 0 && (
        <div className="card">
          <Trail events={sig.filter((e) => !["signals", "check"].includes(e.event))} />
        </div>
      )}
      {check && (
        <>
          <p className="hint">
            <b>The joins:</b> the SDK stream and the OTel data describe the same run. {check.timing}.
          </p>
          <table className="tools compare">
            <thead>
              <tr>
                <th></th>
                <th>SDK side</th>
                <th>OpenTelemetry side</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {check.rows.map((r: any) => (
                <tr key={r.what}>
                  <td>
                    <b>{r.what}</b>
                  </td>
                  <td className="snippet">{r.sdk}</td>
                  <td className="snippet">{r.otel}</td>
                  <td>{r.ok ? <b className="good">✓</b> : <b className="bad">✗</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {facts && (
            <p className="hint">
              <code>BaseHookInput.prompt_id</code> (sdk.d.ts): <i>{facts.promptIdDoc}</i>
            </p>
          )}
        </>
      )}
      {sigData && <Signals sig={sigData} />}

      <h3>C · What is recorded about the content</h3>
      <p className="hint">
        <code>notes.txt</code> holds a (fake) e-mail and card number. Three agents read it and repeat the e-mail. Each lane searches <b>everything its collector
        received</b> for them. About $0.015.
      </p>
      <div className="scenarios">
        {btn("privacy", "2 · Three content settings, side by side", () => {
          setPrivacy({});
          run("privacy", "/api/c44/privacy", byLane(setPrivacy));
        })}
      </div>
      {Object.keys(privacy).length > 0 && (
        <Lanes
          lanes={privacy}
          order={["pv-default", "pv-content", "pv-raw"]}
          compact
          verdict={(v) => (
            <>
              <table className="tools compare otel-table">
                <tbody>
                  {v.fields.map(([k, x]: [string, any]) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td className={`snippet ${x === "<REDACTED>" || x == null ? "" : "otel-leak"}`}>{x == null ? <span className="subtype">(not sent)</span> : String(x).slice(0, 220)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                the e-mail appears <b className={v.leaks.email ? "bad" : "good"}>{v.leaks.email}×</b> · the card <b className={v.leaks.card ? "bad" : "good"}>{v.leaks.card}×</b> · the system prompt{" "}
                {v.leaks.systemPrompt ? <b className="bad">yes</b> : <b className="good">no</b>} · {kb(v.bytes)} exported · {usd(v.cost)}
              </p>
            </>
          )}
        />
      )}

      <h3>D · Inside your own trace</h3>
      <p className="hint">
        Your service already has a trace for the request that started the agent. Claude Code reads <code>TRACEPARENT</code> (in an SDK run) and makes its{" "}
        <code>interaction</code> span a child of it. <code>CLAUDE_CODE_PROPAGATE_TRACEPARENT=1</code> also sends a <code>traceparent</code> header on each API call
        (lane b goes through a tap to show it). Lane c uses the OpenTelemetry JS SDK: <code>query()</code> is called inside an active span, and the Agent SDK sets{" "}
        <code>TRACEPARENT</code> itself. About $0.02.
      </p>
      <div className="scenarios">
        {btn("tracing", "3 · No parent, by hand, @opentelemetry/api", () => {
          setTracing({});
          run("tracing", "/api/c44/tracing", byLane(setTracing));
        })}
      </div>
      {Object.keys(tracing).length > 0 && (
        <Lanes
          lanes={tracing}
          order={["tr-none", "tr-manual", "tr-auto"]}
          compact
          verdict={(v) => (
            <div className="otel-signals">
              <Waterfall spans={v.spans} />
            </div>
          )}
        />
      )}
      {Object.keys(tracing).length > 0 && (
        <p className="hint">
          <b>Read lane c twice.</b> Both <code>interaction</code> spans are under <b>turn 1</b>, and <b>turn 2</b> is empty: Claude Code reads{" "}
          <code>TRACEPARENT</code> once, when its process starts, so every turn of a session gets the same parent. Parent a span that covers the whole session (or
          run one <code>query()</code> per request). And in every lane the <code>generate_session_title</code> call is a trace of its own: it never has a parent. (In lane c, the second{" "}
          <code>result</code>'s <code>total_cost_usd</code> is the session's total so far, not turn 2's cost.)
        </p>
      )}

      <h3>E · A trace worth reading</h3>
      <p className="hint">
        One run: a <code>Read</code> that fails, a <code>Write</code> that <code>canUseTool</code> denies, and a subagent. Look for the error on{" "}
        <code>tool.execution</code>, <code>decision=reject source=user_reject</code>, the subagent's API calls under the <code>Agent</code> tool,
        and <code>query_source=subagent</code> in the metrics. About $0.02.
      </p>
      <div className="scenarios">
        {btn("rich", "4 · Error, denial, subagent", () => {
          setRich([]);
          run("rich", "/api/c44/rich", collect(setRich));
        })}
      </div>
      {rich.length > 0 && (
        <details className="card">
          <summary>The SDK stream and the collector's requests ({rich.filter((e) => e.event === "export").length} exports)</summary>
          <Trail events={rich.filter((e) => e.event !== "signals")} />
        </details>
      )}
      {richData && <Signals sig={richData} />}

      <h3>F · Other exporters and knobs</h3>
      <p className="hint">
        The same small run four ways. Prometheus is <b>pull</b>: Claude Code serves <code>/metrics</code> only while it runs, so something has to scrape it then
        (here a <code>PostToolUse</code> hook). About $0.02.
      </p>
      <div className="scenarios">
        {btn("exporters", "5 · protobuf, prometheus, cumulative, console", () => {
          setExporters({});
          run("exporters", "/api/c44/exporters", byLane(setExporters));
        })}
      </div>
      {Object.keys(exporters).length > 0 && (
        <Lanes
          lanes={exporters}
          order={["ex-protobuf", "ex-prometheus", "ex-cumulative", "ex-console"]}
          compact
          verdict={(v) => (
            <div className="hint">
              <b>{v.text}</b>
              {v.sample && <pre className="wrap tur">{v.sample.join("\n")}</pre>}
              {v.after && <div className="snippet">{v.after} (the process has exited: nothing listens on that port any more)</div>}
            </div>
          )}
        />
      )}

      <h3>G · When the collector misbehaves</h3>
      <p className="hint">
        Seven agents, seven collectors. The question for each: did the <b>run</b> suffer, and did the <b>data</b> arrive? About $0.03.
      </p>
      <div className="scenarios">
        {btn("collector", "6 · 401, headers, helper, down, slow (×3)", () => {
          setColl({});
          run("collector", "/api/c44/collector", byLane(setColl));
        })}
      </div>
      {Object.keys(coll).length > 0 && (
        <>
          <table className="tools compare">
            <thead>
              <tr>
                <th>collector</th>
                <th>the run</th>
                <th>exit after result</th>
                <th>requests: sent · accepted</th>
                <th>signals that arrived</th>
              </tr>
            </thead>
            <tbody>
              {["co-401", "co-headers", "co-helper", "co-down", "co-slow", "co-slow-wait", "co-slow-short"].map((l) => {
                const v = coll[l]?.find((e) => e.event === "verdict")?.data;
                return (
                  <tr key={l}>
                    <td>{LANE_TITLE[l]}</td>
                    <td>{v ? <code className={v.subtype === "success" ? "good" : "bad"}>result/{v.subtype}</code> : "…"}</td>
                    <td>{v && `${(v.exitAfter / 1000).toFixed(1)} s`}</td>
                    <td>{v && `${v.sent} · ${v.accepted}`}</td>
                    <td>{v && (v.signals.length ? v.signals.join(", ") : <b className="bad">nothing</b>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            <b>The run never suffers</b>: every lane is <code>result/success</code>, and a failed export is not reported anywhere in the SDK stream. <b>The data
            does</b>: with a 401 or a closed port it is simply lost. A slow collector makes the process wait up to 2 s more for its telemetry (it exits about 2.7 s after the result instead of
            about 1 s), then Claude Code gives up and the rest is lost. <code>CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS</code> can shorten that wait but not stretch it (it is capped at 2000 ms). Send to a
            collector next to the agent (a sidecar or a local agent) that answers at once, and check that data arrives, not only that runs succeed.
          </p>
          <details className="card">
            <summary>Each lane's rows</summary>
            <Lanes lanes={coll} order={["co-401", "co-headers", "co-helper", "co-down", "co-slow", "co-slow-wait", "co-slow-short"]} compact />
          </details>
        </>
      )}

      <h3>H · The code</h3>
      <div className="row">
        {["collector", "env", "run", "signals", "scenario-signals", "scenario-privacy", "host-otel", "traceparent", "scenario-tracing", "scenario-rich", "scenario-exporters", "scenario-collector"].map(
          (r) =>
            typeof code[r] === "string" && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && typeof code[openCode] === "string" && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
