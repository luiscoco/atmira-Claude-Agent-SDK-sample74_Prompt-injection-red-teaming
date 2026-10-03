import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Category = { name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" };
type Window = {
  id: string;
  label: string;
  settings: Record<string, unknown>;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean;
  categories: Category[];
  mcpTools: { name: string; tokens: number }[];
  error?: string;
};
type Usage = { when: string; totalTokens: number; maxTokens: number; threshold: number | null; enabled: boolean; categories: Category[]; error?: string };
type Boundary = { trigger: string; pre_tokens: number; post_tokens?: number; duration_ms?: number; preserved_messages?: { uuids: string[] }; at: number };
type Recall = { codes: { code: string; owner: string; found: boolean }[]; rollback: boolean; onCall: boolean };
type Ev = { event: string; data: any };

// Must match MODES and SWITCHES in server/concepts/25-compaction-context.ts.
type Form = { mode: "auto" | "manual" | "off"; reports: number; switches: string[] };
const switchInfo = [
  { name: "instructions", label: "PreCompact adds instructions", does: "the hook returns { systemMessage }: it is appended to the summary instructions" },
  { name: "reinject", label: "SessionStart re-injects", does: "after a compaction, SessionStart (source 'compact') returns additionalContext: the on-call engineer" },
  { name: "block", label: "PreCompact blocks", does: "the hook returns { decision: 'block' }: no compaction, the context keeps growing" },
  { name: "huge", label: "huge reports (60k chars)", does: "over about 50,000 characters the CLI saves the tool result to a file and the model gets a 2 KB preview" },
];

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · /compact by hand",
    hint: "Two reports (about 33k tokens), then the user message '/compact Focus on the ops reports.'. PreCompact sees trigger 'manual' and those words as custom_instructions. Watch the chart drop after the boundary. About $0.08.",
    form: { mode: "manual", reports: 2, switches: ["instructions"] },
  },
  {
    label: "2 · Auto-compaction",
    hint: "Five reports in a 100k window. After report 4 the context is at 66k, just under the 67k threshold. In turn 5, before the model call that would go over, Claude Code compacts on its own (trigger 'auto'). Turn 5 continues after the summary. About $0.13.",
    form: { mode: "auto", reports: 5, switches: [] },
  },
  {
    label: "3 · Auto + hooks",
    hint: "The same run with both helper hooks. PreCompact adds 'Keep every incident code with its owner' to the summary instructions. SessionStart re-injects the on-call engineer, a fact that was never in the conversation, after the summary. The recall check shows whether it arrived. About $0.13.",
    form: { mode: "auto", reports: 5, switches: ["instructions", "reinject"] },
  },
  {
    label: "4 · PreCompact blocks",
    hint: "The hook returns decision 'block'. Claude Code asks again before every later request, so PreCompact fires more than once, and the context stays over the threshold. Blocking is only safe while the model's real limit (200k for Haiku) is still far away. About $0.13.",
    form: { mode: "auto", reports: 5, switches: ["block"] },
  },
  {
    label: "5 · Auto-compaction off",
    hint: "autoCompactEnabled: false. Six reports reach about 99k tokens in the '100k' window and nothing stops them: the window is a compaction policy, not a hard limit. Without compaction every request resends everything, so the last turns are the most expensive. About $0.17.",
    form: { mode: "off", reports: 6, switches: [] },
  },
  {
    label: "6 · Huge tool results",
    hint: "Each report is 60,000 characters. Claude Code never puts it in the context: it saves it under compact-lab/config/projects/…/tool-results/ and sends a <persisted-output> preview. The context barely grows, but the buried rollback deadline was never seen. About $0.01.",
    form: { mode: "auto", reports: 2, switches: ["huge"] },
  },
];

// Part C: which knob to use when. Each line was seen in the lab (see Tab25-Compaction-and-context.md).
const knobs: [string, string, string][] = [
  ["q.getContextUsage()", "Measure: categories (used / buffer / free / deferred), totalTokens, autoCompactThreshold", "'summary' is fast between turns; 'full' counts each category"],
  ["settings.autoCompactWindow", "Where compaction measures against: 100,000 to 1,000,000 tokens", "100k → threshold 67k, a 33k 'Autocompact buffer'"],
  ["settings.autoCompactEnabled: false", "No auto-compaction; /compact still works", "a 3k 'Compact buffer' is kept for /compact"],
  ["'/compact <instructions>'", "Compact now, as a user message", "num_turns 0, one summary call, custom_instructions in PreCompact"],
  ["hooks.PreCompact → systemMessage", "Add instructions to the summary call", "appended after the user's /compact words"],
  ["hooks.PreCompact → decision: 'block'", "Cancel this compaction", "asked again before the next request"],
  ["hooks.PostCompact", "Read compact_summary, e.g. to log or check it", "the text that now stands for the conversation"],
  ["hooks.SessionStart, matcher 'compact'", "Put critical context back after every compaction", "additionalContext survives, whatever the summary kept"],
  ["Small tool results", "The cheapest context is the one never added", "over about 50,000 characters the CLI saves the result to a file"],
];

const fmt = (n: number) => n.toLocaleString("en");
const color = (c: Category) =>
  c.kind === "free" ? "transparent" : c.kind === "buffer" ? "repeating-linear-gradient(45deg, #999 0 4px, transparent 4px 8px)" : c.name === "Messages" ? "#c96442" : c.name.startsWith("System tools") ? "#5b7fb8" : c.name === "Skills" ? "#8a5bb8" : c.name === "MCP tools" ? "#6a9a58" : "#b8995b";

/** The window as one bar: used categories, then the buffer, then free space. Deferred rows are outside the window. */
function WindowBar({ categories, max, threshold }: { categories: Category[]; max: number; threshold: number | null }) {
  const inWindow = categories.filter((c) => c.kind !== "deferred");
  const order = [...inWindow.filter((c) => c.kind === "used"), ...inWindow.filter((c) => c.kind === "free"), ...inWindow.filter((c) => c.kind === "buffer")];
  return (
    <div className="ctx-bar">
      {order.map((c) => (
        <div key={c.name} title={`${c.name}: ${fmt(c.tokens)}`} style={{ width: `${(c.tokens / max) * 100}%`, background: color(c) }} />
      ))}
      {threshold !== null && <div className="ctx-threshold" style={{ left: `${(threshold / max) * 100}%` }} title={`auto-compact at ${fmt(threshold)}`} />}
    </div>
  );
}

/** One column per getContextUsage() call during the run; a dashed line at the threshold. */
function History({ points, boundaries }: { points: Usage[]; boundaries: Boundary[] }) {
  const ok = points.filter((p) => !p.error);
  if (!ok.length) return null;
  const max = Math.max(...ok.map((p) => p.maxTokens), ...ok.map((p) => p.totalTokens));
  const threshold = ok[ok.length - 1].threshold;
  return (
    <div className="card">
      <b>Context after each turn</b> <span className="subtype">q.getContextUsage({"{ detail: 'summary' }"}).totalTokens</span>
      <div className="ctx-history">
        {threshold !== null && <div className="ctx-line" style={{ bottom: `${(threshold / max) * 100}%` }} title={`auto-compact threshold ${fmt(threshold)}`} />}
        {ok.map((p, i) => (
          <div key={i} className="ctx-col" title={`${p.when}: ${fmt(p.totalTokens)}`}>
            <span>{Math.round(p.totalTokens / 1000)}k</span>
            <div style={{ height: `${(p.totalTokens / max) * 100}%` }} />
            <small>{p.when.replace("after turn ", "t")}</small>
          </div>
        ))}
      </div>
      <div className="hint">
        window {fmt(ok[ok.length - 1].maxTokens)} tokens · {threshold !== null ? `auto-compact at ${fmt(threshold)} (dashed line)` : "auto-compact off"}
        {boundaries.map((b, i) => (
          <span key={i}>
            {" "}
            · compaction {i + 1} ({b.trigger}): {fmt(b.pre_tokens)} → {b.post_tokens !== undefined ? fmt(b.post_tokens) : "?"}
          </span>
        ))}
      </div>
    </div>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        if (event === "turn")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">turn {data.index + 1}</span> {t}
              <div className="snippet">{data.prompt}</div>
            </div>
          );
        if (event === "tool") return null; // the toolResult row below says more
        if (event === "toolResult")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-mcp-stdio">tool result</span> <code>{fmt(data.chars)} characters</code> {t}
              <div className="snippet">{data.head.split("\n").slice(0, data.head.startsWith("<persisted-output>") ? 6 : 2).join("\n")}</div>
            </div>
          );
        if (event === "assistant")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> {t}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "status")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/status</span> <code>{JSON.stringify(data.status)}</code>
              {data.compact_result && <code> compact_result: {data.compact_result}</code>}
              {data.compact_error && <code> {data.compact_error}</code>} {t}
            </div>
          );
        if (event === "boundary")
          return (
            <div key={i} className="tool-call boundary">
              <span className="tag tag-system">system/compact_boundary</span> <code>trigger: {data.trigger}</code> {t}
              <div className="snippet">
                pre_tokens {fmt(data.pre_tokens)} → post_tokens {data.post_tokens !== undefined ? fmt(data.post_tokens) : "?"} · {data.duration_ms} ms · preserved_messages:{" "}
                {data.preserved_messages?.uuids.length ?? 0}
              </div>
            </div>
          );
        if (event === "hook")
          return (
            <div key={i} className={`tool-call ${data.returned?.decision === "block" ? "denied" : ""}`}>
              <span className="tag tag-pre">hook {data.event}</span> {t}
              <div className="snippet">
                {data.event === "PreCompact" && `trigger: ${data.trigger} · custom_instructions: ${JSON.stringify(data.custom_instructions)}`}
                {data.event === "SessionStart" && `source: ${data.source}`}
                {data.event === "PostCompact" && `trigger: ${data.trigger} · compact_summary: ${fmt(data.compact_summary.length)} characters (below)`}
                {data.returned && Object.keys(data.returned).length > 0 && `\nreturned ${JSON.stringify(data.returned)}`}
              </div>
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result</span> <code>{data.subtype}</code>
              <span className="subtype">
                num_turns {data.num_turns} · total ${data.cost.toFixed(4)}
              </span>{" "}
              {t}
            </div>
          );
        return null;
      })}
    </div>
  );
}

export function Concept25CompactionContext() {
  const [windows, setWindows] = useState<Window[] | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [events, setEvents] = useState<Ev[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [options, setOptions] = useState<unknown>(null);
  const [summaries, setSummaries] = useState<string[]>([]);
  const [recall, setRecall] = useState<Recall | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [controller, setController] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = () => setError("Could not reach /api/c25 — is this sample's server running on port 3001?");
    fetch("/api/c25/window")
      .then((r) => r.json())
      .then(setWindows)
      .catch(fail);
    fetch("/api/c25/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(fail);
  }, []);

  const toggle = (s: string) => setForm({ ...form, switches: form.switches.includes(s) ? form.switches.filter((x) => x !== s) : [...form.switches, s] });

  async function run() {
    setError(null);
    setEvents([]);
    setUsage([]);
    setSummaries([]);
    setRecall(null);
    setCost(null);
    setBusy(true);
    const ctrl = new AbortController();
    setController(ctrl);
    try {
      await streamPost(
        "/api/c25/run",
        form,
        (event, data) => {
          if (event === "options") return setOptions(data);
          if (event === "usage") return setUsage((u) => [...u, data]);
          if (event === "recall") return setRecall(data);
          if (event === "error") return setError(data.message);
          if (event === "done") return;
          if (event === "hook" && data.event === "PostCompact") setSummaries((s) => [...s, data.compact_summary]);
          if (event === "result") setCost(data.cost); // total_cost_usd is cumulative in one session
          setEvents((e) => [...e, { event, data }]);
        },
        ctrl.signal,
      );
    } catch (err) {
      setError(ctrl.signal.aborted ? "Stopped from the browser." : String(err));
    } finally {
      setBusy(false);
      setController(null);
    }
  }

  const boundaries = events.filter((e) => e.event === "boundary").map((e) => e.data as Boundary);

  return (
    <section>
      <h2>25 · Compaction & context</h2>
      <p className="lead">
        Every request sends the whole conversation again, so the <b>context</b> grows with each tool result. When it gets close to the window,
        Claude Code <b>compacts</b>: one extra model call writes a summary, and the summary replaces the old messages. This tab measures the window with{" "}
        <code>getContextUsage()</code>, fills it with large reports, and shows manual and automatic compaction, the hooks around it, and what the model
        still knows afterwards.
      </p>

      <h3>A · The window before the first message</h3>
      <p className="hint">
        Four setups, measured with <code>q.getContextUsage()</code> on a session that has not sent anything yet, so no model call is made. Solid colours
        are used, the striped part is the buffer compaction keeps free, and the red line is where auto-compaction fires.
      </p>
      {windows && (
        <div className="compare-grid ctx-grid">
          {windows.map((w) =>
            w.error ? (
              <div key={w.id} className="card warn">
                <b>{w.label}</b>
                <div className="snippet">{w.error}</div>
              </div>
            ) : (
              <div key={w.id} className="card">
                <b>{w.label}</b>
                <div className="subtype">{fmt(w.totalTokens)} used of {fmt(w.maxTokens)}</div>
                <WindowBar categories={w.categories} max={w.maxTokens} threshold={w.autoCompactThreshold} />
                <table className="tools">
                  <tbody>
                    {w.categories.map((c) => (
                      <tr key={c.name}>
                        <td>
                          <span className="swatch" style={{ background: color(c) }} />
                          {c.name}
                        </td>
                        <td>{fmt(c.tokens)}</td>
                        <td className="subtype">{c.kind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="snippet">
                  autoCompactThreshold: {w.autoCompactThreshold === null ? "—" : fmt(w.autoCompactThreshold)}
                  {"\n"}isAutoCompactEnabled: {String(w.isAutoCompactEnabled)}
                </div>
              </div>
            ),
          )}
        </div>
      )}
      {!windows && !error && <p className="hint">Starting four sessions to measure them…</p>}

      <h3>B · Fill it up</h3>
      <p className="hint">
        One session (streaming input, Concept 12). Each turn reads one ops report of about 16k tokens from an MCP tool. The last turn asks, without tools,
        for every incident code, the rollback deadline hidden in the middle of report 2, and the on-call engineer (who appears in no report). The window
        is set to 100k (<code>autoCompactWindow</code>), the smallest the CLI accepts, so compaction happens within a few turns.
      </p>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            disabled={busy}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}
      <div className="row">
        {(["auto", "manual", "off"] as const).map((m) => (
          <label key={m} className="check">
            <input type="radio" name="c25mode" checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} />{" "}
            <code>{m === "auto" ? "auto-compaction" : m === "manual" ? "/compact after the reports" : "autoCompactEnabled: false"}</code>
          </label>
        ))}
        <label className="check">
          reports{" "}
          <select value={form.reports} onChange={(e) => setForm({ ...form, reports: Number(e.target.value) })} style={{ width: "auto", margin: 0 }}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        {switchInfo.map((s) => (
          <label key={s.name} className="check" title={s.does}>
            <input type="checkbox" checked={form.switches.includes(s.name)} onChange={() => toggle(s.name)} /> <code>{s.label}</code>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run the session"}
        </button>
        {busy && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      <History points={usage} boundaries={boundaries} />
      {usage.length > 0 && !usage[usage.length - 1].error && (
        <div className="card">
          <b>Now: {usage[usage.length - 1].when}</b>
          <span className="subtype">
            {fmt(usage[usage.length - 1].totalTokens)} of {fmt(usage[usage.length - 1].maxTokens)}
          </span>
          <WindowBar categories={usage[usage.length - 1].categories} max={usage[usage.length - 1].maxTokens} threshold={usage[usage.length - 1].threshold} />
        </div>
      )}

      {recall && (
        <div className="card">
          <b>What the model still knew at the end</b> <span className="subtype">the answer to the last turn, checked for each fact</span>
          <table className="tools">
            <tbody>
              {recall.codes.map((c) => (
                <tr key={c.code}>
                  <td>{c.found ? "✅" : "❌"}</td>
                  <td>
                    {c.code} · {c.owner}
                  </td>
                  <td className="subtype">top of its report</td>
                </tr>
              ))}
              <tr>
                <td>{recall.rollback ? "✅" : "❌"}</td>
                <td>rollback deadline: Friday 17:00</td>
                <td className="subtype">one line in the middle of report 2</td>
              </tr>
              <tr>
                <td>{recall.onCall ? "✅" : "❌"}</td>
                <td>on call: Marta Ruiz</td>
                <td className="subtype">only in the SessionStart hook's additionalContext</td>
              </tr>
            </tbody>
          </table>
          {cost !== null && <div className="snippet">session cost: ${cost.toFixed(4)}</div>}
        </div>
      )}

      {summaries.map((s, i) => (
        <details key={i} className="card">
          <summary>
            <b>compact_summary {summaries.length > 1 ? i + 1 : ""}</b> <span className="subtype">from PostCompact: the text that replaced the conversation</span>
          </summary>
          <pre className="wrap">{s}</pre>
        </details>
      ))}

      {events.length > 0 && (
        <div className="card">
          <b>Events</b>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">options sent to query()</summary>
          <pre className="wrap">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}
      <div className="row">
        {["options", "hooks", "usage", "messages"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>C · Which knob, when</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>knob</th>
            <th>what it does</th>
            <th>seen in the lab</th>
          </tr>
        </thead>
        <tbody>
          {knobs.map(([k, what, seen]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{what}</td>
              <td>{seen}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
