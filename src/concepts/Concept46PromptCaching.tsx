import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Lanes = Record<string, Ev[]>;

const usd = (n?: number) => (n === undefined || Number.isNaN(n) ? "" : `$${n.toFixed(4)}`);
const k = (n?: number) => (n === undefined ? "" : n.toLocaleString("en-US"));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// Costs from the wire tap, by turn. total_cost_usd differences are not used for this: the session title side call runs
// next to turn 1 and is added to whichever result comes after it finishes (turn 1 or turn 2).
const wireCalls = (events: Ev[]) => events.filter((e) => e.event === "wire").map((e) => e.data);
const turnCallCost = (events: Ev[], n: number) => sum(wireCalls(events).filter((c) => c.kind === "turn" && c.turn === n).map((c) => c.cost ?? 0));
const titleCost = (events: Ev[]) => sum(wireCalls(events).filter((c) => c.kind === "title").map((c) => c.cost ?? 0));
const t = (d: any) => (d.at !== undefined ? <span className="subtype" title="time since the start of the run">@ {(d.at / 1000).toFixed(1)} s</span> : null);

// Minimum cacheable prefix (tokens). Shorter prompts are sent with cache_control and silently not cached.
const MINIMUMS: [string, string][] = [
  ["Opus 5.5, Opus 5, Fable 5 / 5.1, Sonnet 5.5", "512"],
  ["Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5", "1,024"],
  ["Opus 4.7", "2,048"],
  ["Haiku 4.5, Opus 4.6, Opus 4.5", "4,096"],
];
// $ per million input / output tokens, and the read multiplier (Opus 5.5 reads at 0.05x, the others at 0.1x).
const CALC_MODELS: Record<string, { input: number; output: number; read: number }> = {
  "Haiku 4.5": { input: 1, output: 5, read: 0.1 },
  "Sonnet 5 / 5.5": { input: 2, output: 10, read: 0.1 },
  "Opus 5.5": { input: 4, output: 20, read: 0.05 },
};

const LANE_TITLE: Record<string, string> = {
  "an-small": "The SDK's default system prompt (short) + Read",
  "an-handbook": "systemPrompt: the handbook (about 8,000 tokens) + Read",
  "sw-5m": "default: 5-minute TTL (API key)",
  "sw-1h": 'settings: { promptCacheTtl: "1h" }',
  "sw-off": "env: DISABLE_PROMPT_CACHING=1",
  "ms-allow": 'setModel("sonnet") · the hook only reports',
  "ms-deny": 'setModel("sonnet") · the hook denies above $0.01',
};

/** One /v1/messages request as the wire tap saw it: its breakpoints and what the API said about the cache. */
function WireCallView({ c, showBreakpoints = true }: { c: any; showBreakpoints?: boolean }) {
  const u = c.usage ?? { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  const total = u.input + u.write5m + u.write1h + u.read || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className={`tool-call cache-call ${c.kind === "title" ? "observer" : ""}`}>
      <span className="tag tag-cache">→ API #{c.n}</span> <b className="subtype">{c.kind === "title" ? "session title (side call)" : `turn ${c.turn}`}</b> <code>{c.model}</code>{" "}
      <span className="subtype">
        · {plural(c.messages, "message")} · {plural(c.tools, "tool")} · {usd(c.cost)} · sent @ {(c.at / 1000).toFixed(1)} s
      </span>
      <div className="cache-bar" title={`input ${u.input} · cache write ${u.write5m + u.write1h} · cache read ${u.read}`}>
        <div className="cb-read" style={{ width: pct(u.read) }} />
        <div className="cb-write" style={{ width: pct(u.write5m) }} />
        <div className="cb-write1h" style={{ width: pct(u.write1h) }} />
        <div className="cb-input" style={{ width: pct(u.input) }} />
      </div>
      <div className="snippet">
        <span className="cb-key cb-read" /> read {k(u.read)} · <span className="cb-key cb-write" /> write 5m {k(u.write5m)}
        {u.write1h > 0 && (
          <>
            {" "}
            · <span className="cb-key cb-write1h" /> write 1h {k(u.write1h)}
          </>
        )}{" "}
        · <span className="cb-key cb-input" /> uncached {k(u.input)} · output {k(u.output)}
      </div>
      {showBreakpoints && c.kind === "turn" && (
        <details>
          <summary className="subtype">{c.breakpoints.length} cache_control breakpoints</summary>
          <table className="tools compare cache-bps">
            <tbody>
              {c.breakpoints.map((b: any, i: number) => (
                <tr key={i}>
                  <td>
                    <code>{b.where}</code>
                  </td>
                  <td>
                    <code>ttl {b.ttl}</code>
                    {b.scope && <code className="good"> scope {b.scope}</code>}
                  </td>
                  <td className="snippet">
                    {k(b.chars)} chars · {b.preview}
                  </td>
                </tr>
              ))}
              {!c.breakpoints.length && (
                <tr>
                  <td className="subtype">(none: caching is off)</td>
                </tr>
              )}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Trail({ events }: { events: Ev[] }) {
  // In time order: a wire call's `at` is when it was sent, so it lands before the tool call or result it produced.
  const ordered = [...events].sort((a, b) => (a.data.at ?? 0) - (b.data.at ?? 0));
  return (
    <>
      {ordered.map(({ event, data: d }, i) => {
        if (event === "wire") return <WireCallView key={i} c={d} />;
        if (event === "options")
          return (
            <details key={i} className="tool-call call">
              <summary>
                <span className="tag tag-call">options</span> <span className="snippet">{d.title ?? d.systemPrompt ?? ""}</span>
              </summary>
              <pre className="wrap tur">{JSON.stringify(Object.fromEntries(Object.entries(d).filter(([x]) => x !== "at" && x !== "lane")), null, 2)}</pre>
            </details>
          );
        if (event === "user")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">user #{d.n}</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "tool")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-call">{d.name}</span> <code>{JSON.stringify(d.input).slice(0, 120)}</code>
            </div>
          );
        if (event === "result") {
          const own = turnCallCost(events, d.n);
          // The difference of the running totals also holds any side call that finished during this turn (the session title).
          const extra = d.turnCost - own > 0.00005 ? ` (+ ${usd(d.turnCost - own)} of the session title call)` : "";
          return (
            <div key={i} className={`tool-call ${d.isError ? "denied" : ""}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>result #{d.n}</span> <span className="snippet">{d.text}</span>
              <div className="subtype">
                this turn's API calls {usd(own)} · total_cost_usd {usd(d.cost)}, up {usd(d.turnCost)}{extra} · result.usage: input {k(d.usage.input)}, cache write {k(d.usage.cacheWrite)}, cache read{" "}
                {k(d.usage.cacheRead)}
              </div>
            </div>
          );
        }
        if (event === "hook")
          return (
            <div key={i} className={`tool-call ${d.decision === "deny" ? "denied" : ""}`}>
              <span className="tag tag-hook">{d.name}</span> {d.decision && <b className={d.decision === "deny" ? "bad" : "good"}>{d.decision}</b>}
              <pre className="wrap tur">{JSON.stringify(d.input, null, 2)}</pre>
            </div>
          );
        if (event === "setModel")
          return (
            <div key={i} className={`tool-call ${d.ok ? "" : "denied"}`}>
              <span className={`tag ${d.ok ? "tag-system" : "tag-error"}`}>await q.setModel("sonnet")</span> <span className="snippet">{d.ok ? "resolved" : `rejected: ${d.error}`}</span>
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

const verdictOf = (lanes: Lanes, l: string) => lanes[l]?.find((e) => e.event === "verdict")?.data;
const trailOf = (lanes: Lanes, l: string) => (lanes[l] ?? []).filter((e) => e.event !== "verdict");

/** Part A: what N requests with the same prefix cost without a cache, with 5 minutes and with 1 hour. */
function Calculator() {
  const [model, setModel] = useState("Haiku 4.5");
  const [prefix, setPrefix] = useState(8000);
  const [requests, setRequests] = useState(10);
  const [gap, setGap] = useState(2);
  const [perRequest, setPerRequest] = useState(50);
  const [output, setOutput] = useState(100);
  const p = CALC_MODELS[model];
  const M = 1e6;
  const tail = requests * (perRequest * p.input + output * p.output); // the part that is never cached: the new question and the answer
  const none = (requests * prefix * p.input + tail) / M;
  // A cache entry lives TTL minutes from the start of the last request that wrote or READ it.
  const cached = (ttlMin: number, writeX: number) => {
    const writes = gap < ttlMin ? 1 : requests;
    return (writes * prefix * p.input * writeX + (requests - writes) * prefix * p.input * p.read + tail) / M;
  };
  const five = cached(5, 1.25);
  const hour = cached(60, 2);
  const best = Math.min(none, five, hour);
  const num = (v: number, set: (n: number) => void, min = 0) => <input type="number" value={v} min={min} onChange={(e) => set(Math.max(min, Number(e.target.value) || 0))} />;
  const row = (label: string, cost: number, note: string) => (
    <tr className={cost === best ? "cache-best" : ""}>
      <td>{label}</td>
      <td>
        <b>{usd(cost)}</b>
      </td>
      <td>{none > 0 ? `${Math.round((1 - cost / none) * 100)}%` : ""}</td>
      <td className="snippet">{note}</td>
    </tr>
  );
  return (
    <div className="card config">
      <div className="form-grid cache-calc">
        <label>
          model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {Object.keys(CALC_MODELS).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>cached prefix (tokens){num(prefix, setPrefix)}</label>
        <label>requests{num(requests, setRequests, 1)}</label>
        <label>minutes between requests{num(gap, setGap)}</label>
        <label>new tokens per request{num(perRequest, setPerRequest)}</label>
        <label>output tokens per request{num(output, setOutput)}</label>
      </div>
      <table className="tools compare">
        <thead>
          <tr>
            <th>cache</th>
            <th>cost</th>
            <th>saved</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          {row("off", none, `every request pays the full prefix: ${requests} × ${k(prefix)} tokens at $${p.input}/M`)}
          {row("5 minutes (default)", five, gap < 5 ? "1 write (1.25×), then reads (0.1×): each read restarts the 5 minutes" : `gap ≥ 5 min: the entry expires, every request writes again (1.25×): worse than off`)}
          {row("1 hour", hour, gap < 60 ? `1 write (2×), then reads (${p.read}×)` : "gap ≥ 60 min: every request writes again (2×)")}
        </tbody>
      </table>
      <p className="hint">
        Break-even: with 5 minutes, <b>2 requests</b> (1.25 + 0.1 = 1.35 &lt; 2); with 1 hour, <b>3 requests</b> (2 + 0.1 + 0.1 = 2.2 &lt; 3). Pick 1 hour only when the gaps between requests are between
        5 and 60 minutes. The prices are list prices; the prefix must also be above the model's minimum.
      </p>
    </div>
  );
}

export function Concept46PromptCaching() {
  const [facts, setFacts] = useState<any>(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [anatomy, setAnatomy] = useState<Lanes>({});
  const [switches, setSwitches] = useState<Lanes>({});
  const [breakers, setBreakers] = useState<Lanes>({});
  const [msw, setMsw] = useState<Lanes>({});

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
    get("/api/c46/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c46/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, set: (f: (p: Lanes) => Lanes) => void) {
    set(() => ({}));
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, {}, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done" && data.lane) set((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] }));
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const btn = (key: string, label: string, url: string, set: (f: (p: Lanes) => Lanes) => void) => (
    <button className={running === key ? "active" : ""} onClick={() => run(key, url, set)} disabled={!!running}>
      {running === key ? "Running…" : label}
    </button>
  );
  const lanesCard = (lanes: Lanes, order: string[]) => (
    <div className="compare-grid lanes43">
      {order.map((l) => (
        <div key={l} className="card">
          <b>{LANE_TITLE[l] ?? lanes[l]?.find((e) => e.event === "options")?.data.title ?? l}</b>
          <Trail events={trailOf(lanes, l)} />
          {!lanes[l]?.length && <span className="hint">Waiting…</span>}
        </div>
      ))}
    </div>
  );
  const BREAKER_LANES = ["br-cold", "br-same", "br-time", "br-tool", "br-model", "br-suffix", "br-bound-a", "br-bound-b", "br-bound-proxy"];

  return (
    <section>
      <h2>46 · Prompt caching and cost optimization</h2>
      <p className="lead">
        Every call of an agent re-sends the whole prompt: the system prompt, the tools, the conversation so far. <b>Prompt caching</b> lets the API keep that prefix for a few minutes and
        read it back at a tenth of the price. Claude Code already puts the <code>cache_control</code> breakpoints in every request; your job is to make the prefix <b>big enough</b> to
        be cached, <b>stable enough</b> to be read again, and to choose <b>how long</b> it lives. A wire tap between Claude Code and the API shows every breakpoint and what the cache did.
      </p>
      <div className="card">
        <pre>{`import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Which section covers chargebacks?",
  options: {
    model: "haiku",
    systemPrompt: [handbook, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, \`Customer: \${customer}\`], // static first, per-user part last
    settings: { promptCacheTtl: "5m" },   // "5m" (default on an API key) or "1h"
  },
});
// result.modelUsage[model].cacheCreationInputTokens (written, 1.25×) · .cacheReadInputTokens (read, 0.1×)`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}

      <h3>A · The rules, and a calculator</h3>
      <p className="hint">
        SDK {facts?.sdkVersion ?? "…"} · Claude Code {facts?.claudeCodeVersion ?? "…"} · the wire tap: <code>{facts?.tap ?? "…"}</code> · the lab's handbook: {k(facts?.handbookChars)} characters
        (about 8,200 Haiku tokens).
      </p>
      <div className="compare-grid">
        <div className="card">
          <b>What a cached token costs</b>
          <table className="tools compare">
            <tbody>
              <tr>
                <td>cache write, 5 minutes</td>
                <td>
                  <b>1.25×</b> input
                </td>
              </tr>
              <tr>
                <td>cache write, 1 hour</td>
                <td>
                  <b>2×</b> input
                </td>
              </tr>
              <tr>
                <td>cache read (restarts the TTL)</td>
                <td>
                  <b>0.1×</b> input (0.05× on Opus 5.5)
                </td>
              </tr>
              <tr>
                <td>uncached input</td>
                <td>1×</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">The cache is a prefix match, in the order tools → system → messages. One changed byte and everything after it is written again.</p>
        </div>
        <div className="card">
          <b>Minimum prefix that can be cached</b>
          <table className="tools compare">
            <tbody>
              {MINIMUMS.map(([m, n]) => (
                <tr key={m}>
                  <td>{m}</td>
                  <td>
                    <b>{n}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Below it the request is still sent with breakpoints, and simply nothing is cached: no error, just zeros.</p>
        </div>
        <div className="card">
          <b>The TTL settings (sdk.d.ts)</b>
          <div className="snippet">
            <code>promptCacheTtl</code>: {facts?.promptCacheTtl ?? "…"}
          </div>
          <div className="snippet">
            <code>subagentPromptCacheTtl</code>: {facts?.subagentPromptCacheTtl ?? "…"}
          </div>
        </div>
      </div>
      <Calculator />

      <h3>B · The anatomy of a cached run</h3>
      <p className="hint">
        One agent, one question, two API calls (<code>Read</code>, then the answer). Left: the SDK's own short system prompt, about 1,500 tokens, <b>below Haiku's 4,096 minimum</b>. Right:
        the same with the handbook as <code>systemPrompt</code>. Open the breakpoints: Claude Code marks the system prompt and the last message blocks (at most 4 per request). About $0.02.
      </p>
      <div className="scenarios">{btn("anatomy", "1 · Two calls, two prompts", "/api/c46/anatomy", setAnatomy)}</div>
      {Object.keys(anatomy).length > 0 && (
        <>
          {lanesCard(anatomy, ["an-small", "an-handbook"])}
          {["an-small", "an-handbook"].every((l) => verdictOf(anatomy, l)) &&
            (() => {
              const [first, second] = wireCalls(anatomy["an-handbook"]).filter((c) => c.kind === "turn");
              if (!first?.usage || !second?.usage) return null;
              const u = second.usage;
              // The same call at Haiku 4.5 list prices ($1 / $5 per million) with every input token uncached.
              const uncached = ((u.input + u.write5m + u.write1h + u.read) * 1 + u.output * 5) / 1e6;
              return (
                <p className="hint">
                  Small prompt: {usd(verdictOf(anatomy, "an-small").run.cost)}, nothing cached although every call carried breakpoints (and no handbook, so it cannot name a section:
                  that is expected). Handbook: {usd(verdictOf(anatomy, "an-handbook").run.cost)}.
                  Its first turn call <b>wrote</b> {k(first.usage.write5m + first.usage.write1h)} tokens ({usd(first.cost)}); the second <b>read</b> {k(u.read)} of them and wrote only the{" "}
                  {k(u.write5m + u.write1h)} new ones ({usd(second.cost)}). Without the cache that second call would have cost about {usd(uncached)}, {Math.round(uncached / second.cost)}× more.
                </p>
              );
            })()}
        </>
      )}

      <h3>C · The switches: 5 minutes, 1 hour, off</h3>
      <p className="hint">
        The same 4-turn session on the handbook, three ways at once. <code>settings.promptCacheTtl</code> (or <code>CLAUDE_CODE_PROMPT_CACHE_TTL</code>) sets the TTL of the main conversation;{" "}
        <code>DISABLE_PROMPT_CACHING=1</code> removes every breakpoint (there are also <code>DISABLE_PROMPT_CACHING_HAIKU</code> / <code>_SONNET</code> / <code>_OPUS</code>). About $0.07.
      </p>
      <div className="scenarios">{btn("switches", "2 · One session, three cache settings", "/api/c46/switches", setSwitches)}</div>
      {Object.keys(switches).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>lane</th>
                {[1, 2, 3, 4].map((n) => (
                  <th key={n}>turn {n}</th>
                ))}
                <th>session title</th>
                <th>session total</th>
                <th>turn calls: write · read · uncached</th>
              </tr>
            </thead>
            <tbody>
              {["sw-5m", "sw-1h", "sw-off"].map((l) => {
                const v = verdictOf(switches, l);
                const evs = switches[l] ?? [];
                return (
                  <tr key={l}>
                    <td>{LANE_TITLE[l]}</td>
                    {[1, 2, 3, 4].map((n) => (
                      <td key={n}>{wireCalls(evs).some((c) => c.kind === "turn" && c.turn === n) ? usd(turnCallCost(evs, n)) : ""}</td>
                    ))}
                    <td className="subtype">{usd(titleCost(evs))}</td>
                    <td>
                      <b>{usd(v?.run.cost)}</b>
                    </td>
                    <td className="snippet">{v && `${k(v.wire.write)} · ${k(v.wire.read)} · ${k(v.wire.input)}${v.ttls.length ? ` (ttl ${v.ttls.join(", ")})` : " (no breakpoints)"}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            Turn 1 is the most expensive with a cache (it writes); every later turn reads. With caching off each turn pays the whole handbook again. The 1-hour TTL pays a double write, so it
            only wins when the requests come more than 5 and less than 60 minutes apart (see the calculator). The turn costs come from the wire tap; the session title is a side call that
            Claude Code makes next to turn 1 (too short to cache). <code>total_cost_usd</code> counts it in the first result after it finishes: turn 1 or turn 2 here. In a one-turn run it can be
            missing altogether, because the run ends first (Part D, runs b and h).
          </p>
          <details className="card">
            <summary>Each lane's calls</summary>
            {lanesCard(switches, ["sw-5m", "sw-1h", "sw-off"])}
          </details>
        </>
      )}

      <h3>D · What breaks the cache</h3>
      <p className="hint">
        Nine <code>query()</code> calls, <b>one after the other</b>, with one edition of the handbook. The cache is not per session: it belongs to your workspace, so a new{" "}
        <code>query()</code> with the same prefix reads what another one wrote. Lanes g and h put a per-customer line after <code>SYSTEM_PROMPT_DYNAMIC_BOUNDARY</code>. Claude Code only splits there
        on a <b>first-party URL</b>; the lab turns that on for g and h (see the readme), and lane i shows the same prompt behind a proxy. About $0.10.
      </p>
      <div className="scenarios">{btn("breakers", "3 · Nine runs: hit or miss?", "/api/c46/breakers", setBreakers)}</div>
      {Object.keys(breakers).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>run</th>
                <th>system blocks on the wire</th>
                <th>cache write · read</th>
                <th>turn call · total_cost_usd</th>
                <th>expected</th>
              </tr>
            </thead>
            <tbody>
              {BREAKER_LANES.map((l) => {
                const v = verdictOf(breakers, l);
                const o = breakers[l]?.find((e) => e.event === "options")?.data;
                const hit = v && v.wire.read > 0;
                return (
                  <tr key={l}>
                    <td>{o?.title ?? l}</td>
                    <td className="snippet">
                      {v?.system.map(
                        (b: any, i: number) =>
                          !b.preview.startsWith("x-anthropic-billing-header") && ( // block 0: Claude Code's own header line, never cached
                            <div key={i}>
                              [{i}] {k(b.chars)} ch {b.cache ? <code className={b.cache.includes("global") ? "good" : ""}>{b.cache}</code> : "-"} · {b.preview.slice(0, 40)}
                            </div>
                          ),
                      )}
                    </td>
                    <td>{v && `${k(v.wire.write)} · ${k(v.wire.read)}`}</td>
                    <td>
                      {v && (
                        <>
                          <b>{usd(turnCallCost(breakers[l], 1))}</b> <span className="subtype">· {usd(v.run.cost)}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {v && (
                        <>
                          <b className={hit ? "good" : "bad"}>{hit ? "hit" : "miss"}</b> <span className="subtype">{(v.expect === "read") === hit ? "✓ as expected" : "✗ unexpected"}</span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            A hit reads about 8,000 tokens and its turn call costs about $0.001; a miss writes them again for about $0.010 (<code>total_cost_usd</code> may add $0.001 for the session title
            call). A breakpoint only hits when <b>everything before it</b> is identical: a timestamp at the top (c), a different tool list (d, tools come first), another model (e, caches are per
            model; Sonnet 5 also counts the tokens differently). Appending the customer line to the system prompt (f) is <b>not</b> enough: it is inside the same cached block, so that block
            changes. Put what changes after <code>SYSTEM_PROMPT_DYNAMIC_BOUNDARY</code> (its own block, g and h, on a first-party URL) or in the user message.
          </p>
          <details className="card">
            <summary>Each run's calls</summary>
            {lanesCard(breakers, BREAKER_LANES)}
          </details>
        </>
      )}

      <h3>E · Switching models in the middle of a session</h3>
      <p className="hint">
        A new model starts with a cold cache, so <code>q.setModel()</code> after a long conversation re-writes all of it. The <code>PreModelSwitch</code> hook gets the estimate first (
        <code>context_tokens</code>, <code>prompt_cache_warm</code>, <code>estimated_cache_write_usd</code>) and may deny the switch: then <code>setModel()</code> rejects and the session stays on
        its model and its cache. <code>PostModelSwitch</code> reports the switch after it happened. About $0.05.
      </p>
      <div className="scenarios">{btn("msw", '4 · setModel("sonnet") after turn 1', "/api/c46/model-switch", setMsw)}</div>
      {Object.keys(msw).length > 0 && (
        <>
          {lanesCard(msw, ["ms-allow", "ms-deny"])}
          {["ms-allow", "ms-deny"].every((l) => verdictOf(msw, l)) && (
            <p className="hint">
              Allowed: {usd(verdictOf(msw, "ms-allow").run.cost)} on {verdictOf(msw, "ms-allow").models.join(" + ")}. Denied: {usd(verdictOf(msw, "ms-deny").run.cost)}, all on{" "}
              {verdictOf(msw, "ms-deny").models.join(", ")}. The estimate excludes the answer, and it counts the tokens of the old model: Sonnet 5 counted more of them.
            </p>
          )}
        </>
      )}

      <h3>F · A cost checklist for agents</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>lever</th>
            <th>how, in the SDK</th>
            <th>seen in</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Keep the prefix stable", "No timestamps, ids or user names in systemPrompt; a fixed tool list; one model per session; systemPrompt snapshot (the default) so it cannot change mid-session", "D, E"],
            ["Static first, dynamic last", "systemPrompt: [static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, perUser] or preset + excludeDynamicSections: true (cwd, memory, git status move to the first user message)", "D g–i"],
            ["Make the static part worth caching", "Long instructions or reference text go in the system prompt, once; they must pass the model's minimum", "B"],
            ["Choose the TTL by the gaps", "5 minutes for steady traffic (each read restarts it); promptCacheTtl / subagentPromptCacheTtl \"1h\" for gaps of 5 to 60 minutes", "A, C"],
            ["Reuse sessions", "streaming input, or resume within the TTL: every turn reads the conversation so far instead of starting over", "C"],
            ["The right model for each job", "model: \"haiku\" for simple agents and subagents (AgentDefinition.model); a switch forfeits the cache, so decide at the start", "E"],
            ["Fewer tokens in", "tools: only the tools the agent needs (each definition is prompt), settingSources: [] and strictMcpConfig, small tool results", "Tab3, Tab25"],
            ["Fewer tokens out", "effort, thinking, maxTurns; and maxBudgetUsd as the safety net", "Tab14, Tab15"],
            ["Measure", "result.modelUsage[model].cacheReadInputTokens / cacheCreationInputTokens, and total_cost_usd per turn (the difference of the running totals)", "all"],
          ].map(([a, b, c]) => (
            <tr key={a}>
              <td>
                <b>{a}</b>
              </td>
              <td className="snippet">{b}</td>
              <td>{c}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>G · The code</h3>
      <div className="row">
        {["handbook", "wire", "options", "run", "scenario-anatomy", "scenario-switches", "scenario-breakers", "scenario-model-switch"].map(
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
