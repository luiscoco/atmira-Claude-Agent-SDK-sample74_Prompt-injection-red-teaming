import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Metadata = "clear" | "vague";
type Config = { mode: string; metadata: Metadata; pinNeedle: boolean };
type Facts = { server: string; model: string; taskPrompt: string; liveAvailable: boolean; tools: { name: string; domain: string; tokens: number; searchHint: string | null }[] };
type Measure = { config: Config; totalTokens: number; maxTokens: number; categories: { name: string; tokens: number; kind: string }[]; mcpToolTokens: number; mcpToolCount: number; loaded: string[] };
const label = (c: Config) => `${c.mode}${c.pinNeedle ? " + alwaysLoad" : ""}${c.metadata === "vague" ? " · vague" : ""}`;
const examples = ["refund duplicate charge", "money back for a double charge", "select:mcp__ops__billing_refund_invoice", "invoice"];
const presets: Config[] = [
  { mode: "false", metadata: "clear", pinNeedle: false },
  { mode: "true", metadata: "clear", pinNeedle: false },
  { mode: "true", metadata: "clear", pinNeedle: true },
  { mode: "auto", metadata: "clear", pinNeedle: false },
  { mode: "auto:5", metadata: "clear", pinNeedle: false },
];
const json = async (url: string, body: unknown, signal?: AbortSignal) => {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
};

export function Concept58ToolSearch() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [queryText, setQueryText] = useState(examples[0]);
  const [metadata, setMetadata] = useState<Metadata>("clear");
  const [hits, setHits] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [searchCount, setSearchCount] = useState(0);
  const [config, setConfig] = useState<Config>({ mode: "true", metadata: "clear", pinNeedle: false });
  const [contextWindow, setContextWindow] = useState(200_000);
  const [planned, setPlanned] = useState<any>(null);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [events, setEvents] = useState<{ kind: string; data: any }[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [summaries, setSummaries] = useState<any[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch("/api/c58/facts", { signal: controller.signal }), fetch("/api/c58/code", { signal: controller.signal })]).then(async ([a, b]) => {
      if (!a.ok || !b.ok) throw new Error("Could not load lesson 58.");
      const [f, c] = await Promise.all([a.json(), b.json()]);
      if (!controller.signal.aborted) { setFacts(f); setCode(c); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, [attempt]);
  // The planner is pure and cheap: recompute whenever an input changes.
  useEffect(() => {
    const controller = new AbortController();
    json("/api/c58/plan", { ...config, contextWindow }, controller.signal).then(setPlanned).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [config, contextWindow]);

  async function runSearch(text = queryText, profile = metadata) {
    // Clear the previous card first, so pressing the button again visibly re-runs the search.
    setError(""); setHits(null); setSearching(true);
    try {
      const result = await json("/api/c58/search", { query: text, metadata: profile });
      setSearchCount((n) => n + 1);
      setHits({ ...result, query: text, metadata: profile });
    } catch (e) { setError(String(e)); }
    finally { setSearching(false); }
  }
  async function measure(configs: Config[]) {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(true); setError(""); setMeasures([]);
    try {
      // One Claude Code process per configuration, one after another (the server allows one at a time).
      for (const c of configs) {
        const result = await json("/api/c58/measure", c, controller.signal);
        if (!controller.signal.aborted) setMeasures((rows) => [...rows, result]);
      }
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  }
  async function run() {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(true); setError(""); setEvents([]); setMessages([]);
    try {
      await streamPost("/api/c58/run", config, (event, data) => {
        if (controller.signal.aborted) return;
        if (event === "message") setMessages((rows) => [...rows, data]);
        else if (event === "summary") setSummaries((rows) => [...rows, data]);
        else if (event === "error") setError((previous) => `${previous}${previous ? "\n" : ""}${data.message}`);
        else if (event !== "done") setEvents((rows) => [...rows, { kind: event, data }]);
      }, controller.signal);
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  }
  const stop = () => { abortRef.current?.abort(); setBusy(false); setError("Stopped. Partial evidence is preserved."); };
  const byDomain = facts ? Object.entries(facts.tools.reduce<Record<string, { count: number; tokens: number }>>((all, row) => {
    all[row.domain] ??= { count: 0, tokens: 0 }; all[row.domain].count++; all[row.domain].tokens += row.tokens; return all;
  }, {})) : [];
  const totalEstimate = facts?.tools.reduce((sum, row) => sum + row.tokens, 0) ?? 0;
  const tokensOf = (m: Measure, kind: string) => m.categories.filter((row) => row.kind === kind && /MCP|System tools/.test(row.name)).reduce((sum, row) => sum + row.tokens, 0);

  return <section>
    <h2>58. Tool search and large tool catalogs</h2>
    <p className="lead">Every tool definition you load costs context on every turn. Tool search defers definitions: the model sees tool names, searches, and loads only what the task needs.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Defer</b><p><code>ENABLE_TOOL_SEARCH</code> decides whether MCP tool schemas start in context (<code>false</code>), are deferred (<code>true</code>, the default), or are deferred above a threshold (<code>auto</code>, <code>auto:N</code>).</p></div>
      <div className="card"><b>Discover</b><p>The model calls <code>ToolSearch</code> with <code>select:name</code> or keywords. The result holds <code>tool_reference</code> blocks; those definitions are now loaded.</p></div>
      <div className="card"><b>Pin</b><p><code>alwaysLoad</code> (per tool or per server) keeps a few hot tools in context. <code>searchHint</code>, names, descriptions and server instructions decide what can be found.</p></div>
    </div>
    {error && <div className="card warn" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}

    <h3>A · The catalog</h3>
    <p>One in-process MCP server, <code>{facts?.server}</code>, with {facts?.tools.length ?? "…"} tools across 8 domains. Only <code>billing_refund_invoice</code> does something; the rest are realistic fixtures that compete for attention and context.</p>
    <table className="tools"><thead><tr><th>Domain</th><th>Tools</th><th>Estimated tokens</th></tr></thead><tbody>
      {byDomain.map(([domain, row]) => <tr key={domain}><td>{domain}</td><td>{row.count}</td><td>{row.tokens.toLocaleString("en")}</td></tr>)}
      <tr><td><b>total</b></td><td><b>{facts?.tools.length}</b></td><td><b>{totalEstimate.toLocaleString("en")}</b></td></tr>
    </tbody></table>
    <p className="hint">Estimate: about 4 characters of JSON (name, description, input schema) per token. Section C measures the real numbers.</p>

    <h3>B · Can the model find the right tool? (offline)</h3>
    <p>A transparent keyword scorer: name match +3, <code>searchHint</code> +2, description +1. It is <b>not</b> Claude Code's ranking; it shows why metadata decides discoverability.</p>
    <div className="row">{examples.map((text) => <button key={text} disabled={busy} onClick={() => { setQueryText(text); runSearch(text); }}>{text}</button>)}</div>
    <label>Search query<input value={queryText} onChange={(e) => setQueryText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} /></label>
    <label>Needle metadata<select value={metadata} onChange={(e) => { const value = e.target.value as Metadata; setMetadata(value); runSearch(queryText, value); }}>
      <option value="clear">Clear · billing_refund_invoice + description + searchHint</option>
      <option value="vague">Vague · billing_op_7 · "Billing operation."</option>
    </select></label>
    <button className="primary" disabled={!facts || searching || !queryText.trim()} onClick={() => runSearch()}>{searching ? "Searching…" : "Search offline"}</button>
    {hits && <div className="card" aria-live="polite"><b>{hits.mode === "select" ? "select: exact names" : "keyword ranking"} · {hits.hits.length} hit(s)</b>
      <p className="hint">Search #{searchCount} · "{hits.query}" · {hits.metadata} metadata · {hits.mode === "select" ? "names" : "terms"}: {hits.terms.length ? hits.terms.join(", ") : "none (only filler words)"}</p>
      {hits.hits.length ? <table className="tools"><tbody>{hits.hits.map((hit: any) => <tr key={hit.name}><td><code>{hit.name}</code></td><td>{hit.score}</td><td>{hit.matched.join(" ")}</td></tr>)}</tbody></table>
        : <p>No match. The refund tool exists{hits.metadata === "vague" ? ", but its vague name and description share no words with the request" : ""}. A real search would return nothing, or the wrong tools.</p>}</div>}

    <h3>C · What starts in context? (plan offline, then measure)</h3>
    <div className="card config">
      <label>ENABLE_TOOL_SEARCH<select value={config.mode.startsWith("auto:") ? "auto:N" : config.mode} disabled={busy} onChange={(e) => setConfig({ ...config, mode: e.target.value === "auto:N" ? "auto:5" : e.target.value })}>
        <option value="true">true · defer every MCP tool (the default when unset)</option>
        <option value="false">false · load every tool upfront</option>
        <option value="auto">auto · defer above 10% of the window</option>
        <option value="auto:N">auto:N · custom threshold</option>
      </select></label>
      {config.mode.startsWith("auto:") && <label>N = {config.mode.slice(5)}%<input type="range" min={0} max={100} value={Number(config.mode.slice(5))} disabled={busy} onChange={(e) => setConfig({ ...config, mode: `auto:${e.target.value}` })} /></label>}
      <label className="check"><input type="checkbox" checked={config.pinNeedle} disabled={busy} onChange={(e) => setConfig({ ...config, pinNeedle: e.target.checked })} /> Pin the refund tool with <code>tool(…, {"{"} alwaysLoad: true {"}"})</code></label>
      <label>Needle metadata<select value={config.metadata} disabled={busy} onChange={(e) => setConfig({ ...config, metadata: e.target.value as Metadata })}><option value="clear">clear</option><option value="vague">vague</option></select></label>
      <label>Context window (planner only)<select value={contextWindow} disabled={busy} onChange={(e) => setContextWindow(Number(e.target.value))}><option value={100000}>100,000</option><option value={200000}>200,000</option><option value={1000000}>1,000,000</option></select></label>
    </div>
    {planned && <div className="card"><b>Offline plan: {planned.defer ? "deferred" : "loaded upfront"}</b><p>{planned.rule}</p>
      <p>{planned.upfront.length} tool(s) upfront ≈ {planned.upfrontTokens.toLocaleString("en")} tokens · {planned.deferredCount} deferred ≈ {planned.deferredTokens.toLocaleString("en")} tokens</p>
      <p className="hint">Near the threshold the CLI's own token count and window size decide, so the estimate can land on the other side. Measure to be sure.</p></div>}
    <p>Measuring starts Claude Code with this catalog and calls <code>getContextUsage()</code>. No prompt is sent and no model turn runs.</p>
    <div className="row">
      <button className="primary" disabled={busy || !facts} onClick={() => measure([config])}>Measure this configuration</button>
      <button disabled={busy || !facts} onClick={() => measure(presets)}>Measure 5 presets</button>
      {busy && <button onClick={stop}>Stop</button>}
    </div>
    {measures.length > 0 && <table className="tools compare"><thead><tr><th>Configuration</th><th>Tool tokens in context</th><th>Deferred</th><th>Total in context</th><th>Pinned (isLoaded)</th></tr></thead><tbody>
      {measures.map((m, i) => <tr key={i}><td>{label(m.config)}</td><td>{tokensOf(m, "used").toLocaleString("en")}</td><td>{tokensOf(m, "deferred").toLocaleString("en")}</td><td>{m.totalTokens.toLocaleString("en")} / {m.maxTokens.toLocaleString("en")}</td><td>{m.loaded.map((name) => name.replace("mcp__ops__", "")).join(", ") || "none"}</td></tr>)}
    </tbody></table>}
    {measures.map((m, i) => <details className="card" key={i}><summary>{label(m.config)} · categories</summary><pre className="wrap">{JSON.stringify(m.categories, null, 2)}</pre></details>)}
    <p className="hint">Tool tokens in context include "System tools", which is where the ToolSearch tool itself appears. With <code>false</code> there is no ToolSearch tool. The init message lists all 65 tools in every mode, so it does not show what is in context; <code>getContextUsage()</code> does.</p>

    <h3>D · Run the task live (billed)</h3>
    <blockquote>{facts?.taskPrompt}</blockquote>
    <p className="hint">Uses {facts?.model}, only <code>ToolSearch</code> among the built-ins, the configuration from section C, 8 turns, a $0.15 SDK budget threshold and a 90-second deadline. Needs <code>ANTHROPIC_API_KEY</code> in .env{facts && !facts.liveAvailable ? " (not set on this server)" : ""}.</p>
    <div className="row"><button className="primary" disabled={busy || !facts?.liveAvailable} onClick={run}>{busy ? "Running…" : `Run live with ${label(config)}`}</button>{busy && <button onClick={stop}>Stop</button>}{summaries.length > 0 && !busy && <button onClick={() => setSummaries([])}>Clear comparison</button>}</div>
    {events.map((row, i) => <div className="card" key={i}>
      {row.kind === "search" ? <><b>ToolSearch</b> <code>{JSON.stringify(row.data.input)}</code><p>Loaded: {row.data.loaded.length ? row.data.loaded.map((name: string) => <code key={name}>{name} </code>) : "nothing"}</p></>
        : row.kind === "call" ? <><b>Handler {row.data.isError ? "error" : "call"}</b> <code>{row.data.name}</code><pre className="wrap">{JSON.stringify(row.data.args)} → {JSON.stringify(row.data.result)}</pre></>
        : row.kind === "init" ? <span className="hint">init: {row.data.tools} tool names announced · ToolSearch {row.data.toolSearch ? "present" : "absent"}</span>
        : <span className="hint">{row.kind}: {JSON.stringify(row.data.config)}</span>}
    </div>)}
    {summaries.length > 0 && <table className="tools compare"><thead><tr><th>Configuration</th><th>Status</th><th>Correct</th><th>Searches</th><th>Turns</th><th>Input tokens</th><th>Cost</th></tr></thead><tbody>
      {summaries.map((s, i) => <tr key={i}><td>{label(s.config)}</td><td>{s.status}</td><td>{s.correct ? "yes" : "no"}</td><td>{s.searches.length}</td><td>{s.turns}</td><td>{s.inputTokens.toLocaleString("en")}</td><td>${s.costUsd.toFixed(4)}</td></tr>)}
    </tbody></table>}
    {summaries.length > 0 && <p className="hint">Correct means the refund handler succeeded and the answer contains RF-2042-1. Input tokens add uncached, cache-write and cache-read tokens across all turns. One run is an anecdote; repeat with lesson 52's evals before deciding.</p>}
    <MessageLog messages={messages} />

    <h3>E · Apply it to your agent</h3>
    <ol className="steps">
      <li>Measure first: call <code>getContextUsage()</code> with your real MCP servers and look at the "MCP tools" and "MCP tools (deferred)" rows.</li>
      <li>Keep tool search on (the default) for large catalogs. Keep <code>ToolSearch</code> available: <code>tools: []</code> removes it, and then nothing can be deferred.</li>
      <li>Pin the few tools used on almost every turn with <code>alwaysLoad</code>; leave the long tail deferred.</li>
      <li>Make tools findable: intent-revealing names, a first sentence that says when to use the tool, a <code>searchHint</code> with user vocabulary, and server <code>instructions</code> that say when to search this server.</li>
      <li>Use a model with <code>tool_reference</code> support (Haiku, Sonnet or Opus 4.5 and later). Behind a non-first-party <code>ANTHROPIC_BASE_URL</code>, set <code>ENABLE_TOOL_SEARCH</code> explicitly, and only if the proxy forwards those blocks.</li>
      <li>If tool search is not an option, shrink the catalog per agent instead: subagents with their own tool lists (lessons 8 and 47), or <code>allowedTools</code> per task.</li>
    </ol>

    <h3>F · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search" target="_blank" rel="noreferrer">Scale with MCP tool search</a> and <a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool" target="_blank" rel="noreferrer">Tool search tool (API)</a>.</p>
  </section>;
}
