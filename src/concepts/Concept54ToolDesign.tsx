import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Profile = "vague" | "focused";
type Contract = { name: string; description: string; inputSchema: unknown; annotations: unknown };
type Facts = { contracts: Record<Profile, Contract[]>; taskPrompt: string; model: string };
type Summary = { mode: string; status: string; answer: string; calls: number; errors: number; responseBytes: number; costUsd: number };
const examples = {
  search: { name: "catalog_search", input: { category: "camping", maxPriceCents: 3000, limit: 2, responseFormat: "concise" } },
  page: { name: "catalog_search", input: { category: "camping", maxPriceCents: 3000, limit: 2, cursor: "offset:2" } },
  detailed: { name: "catalog_search", input: { category: "camping", maxPriceCents: 3000, limit: 2, responseFormat: "detailed" } },
  missing: { name: "catalog_get", input: { productId: "SKU-999" } },
  invalid: { name: "catalog_get", input: { productId: "Trail mug" } },
};

export function Concept54ToolDesign() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [profile, setProfile] = useState<Profile>("focused");
  const [name, setName] = useState("catalog_search");
  const [input, setInput] = useState(JSON.stringify(examples.search.input, null, 2));
  const [call, setCall] = useState<any>(null);
  const [mode, setMode] = useState("offline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summaries, setSummaries] = useState<Partial<Record<Profile, Summary>>>({});
  const [calls, setCalls] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch("/api/c54/facts", { signal: controller.signal }), fetch("/api/c54/code", { signal: controller.signal })]).then(async ([a, b]) => {
      if (!a.ok || !b.ok) throw new Error("Could not load lesson 54.");
      const [f, c] = await Promise.all([a.json(), b.json()]);
      if (!controller.signal.aborted) { setFacts(f); setCode(c); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, [attempt]);
  function chooseProfile(value: Profile) {
    setProfile(value); setCall(null);
    setName(value === "vague" ? "lookup" : "catalog_search");
    setInput(JSON.stringify(value === "vague" ? { query: "camping" } : examples.search.input, null, 2));
  }
  async function execute() {
    setError(""); setBusy(true); setCall(null);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch("/api/c54/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, name, input: JSON.parse(input) }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json(); if (!controller.signal.aborted) setCall(result);
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  }
  async function run() {
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(true); setError(""); setCalls([]); setMessages([]); setSummaries({});
    try {
      // Each live lane starts a fresh session with the same fixed prompt and model.
      for (const lane of ["vague", "focused"] as const) {
        controller.signal.throwIfAborted();
        await streamPost("/api/c54/run", { profile: lane, mode }, (event, data) => {
          if (controller.signal.aborted) return;
          if (event === "call") setCalls((rows) => [...rows, { ...data, profile: lane }]);
          if (event === "message") setMessages((rows) => [...rows, { ...data, lane }]);
          if (event === "summary") setSummaries((all) => ({ ...all, [lane]: data }));
          if (event === "error") setError((previous) => `${previous}${previous ? "\n" : ""}${lane}: ${data.message}`);
        }, controller.signal);
      }
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  }
  return <section>
    <h2>54. Designing tools the model uses well</h2>
    <p className="lead">A tool is an interface for reasoning. Make its purpose, inputs, evidence and recovery path easy to understand.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Choose an action</b><p>Names and descriptions tell the model when to search and when to fetch details. Explain boundaries and side effects.</p></div>
      <div className="card"><b>Supply valid inputs</b><p>Use stable IDs, explicit units, enums and useful defaults. Validate at the execution boundary.</p></div>
      <div className="card"><b>Reason from results</b><p>Return decision fields, pagination and actionable errors. Keep optional detail behind a response format.</p></div>
    </div>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}
    <h3>A · Inspect the contract</h3>
    <p>Both profiles read the same six-product fixture. The vague tool searches raw records; the focused tools express the user's catalog task.</p>
    <label>Tool design<select value={profile} disabled={busy} onChange={(e) => chooseProfile(e.target.value as Profile)}><option value="vague">Vague · lookup</option><option value="focused">Focused · catalog_search + catalog_get</option></select></label>
    {facts?.contracts[profile].map((contract) => <details className="card" key={contract.name} open><summary><code>mcp__catalog__{contract.name}</code></summary><p>{contract.description}</p><pre className="wrap">{JSON.stringify(contract.inputSchema, null, 2)}</pre><p className="hint">Annotations: {JSON.stringify(contract.annotations)}. readOnlyHint is metadata; the handler and permissions enforce actual behavior.</p></details>)}
    <h3>B · Try real handlers without a model</h3>
    <p>Edit JSON and execute the tool directly. Compare concise/detail sizes, follow nextCursor, then try a missing ID and a malformed ID.</p>
    {profile === "focused" && <div className="row">{Object.entries(examples).map(([label, example]) => <button disabled={busy} key={label} onClick={() => { setName(example.name); setInput(JSON.stringify(example.input, null, 2)); setCall(null); }}>{label}</button>)}</div>}
    <label>Tool<select value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setInput(e.target.value === "catalog_get" ? '{"productId":"SKU-101"}' : JSON.stringify(examples.search.input, null, 2)); }}>{facts?.contracts[profile].map((contract) => <option key={contract.name}>{contract.name}</option>)}</select></label>
    <label>Arguments (JSON)<textarea rows={8} value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} /></label>
    <button className="primary" disabled={busy || !facts} onClick={execute}>Execute offline tool</button>
    {call && <div className="card" aria-live="polite"><b>{call.result.isError ? "Tool error · inspect recovery guidance" : "Tool result"}</b><p>{call.bytes} UTF-8 bytes in the serialized MCP result · {call.elapsedMs} ms handler/validation time</p><pre className="wrap">{JSON.stringify(call.result, null, 2)}</pre><pre className="wrap">{(() => { try { return JSON.stringify(JSON.parse(call.result.content[0].text), null, 2); } catch { return call.result.content[0].text; } })()}</pre></div>}
    <h3>C · Compare the same task</h3>
    <blockquote>{facts?.taskPrompt}</blockquote>
    <label>Comparison mode<select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value); setSummaries({}); setCalls([]); setMessages([]); }}><option value="offline">Offline · scripted calls · no model API</option><option value="live">Live · model authentication required · incurs API cost</option></select></label>
    <p className="hint">Offline runs demonstrate tool contracts, not model behavior. Live runs use {facts?.model}, fresh sessions, eight turns and a $0.25 budget per lane, with a 60-second deadline per lane. Runs execute sequentially.</p>
    <div className="row"><button className="primary" disabled={busy || !facts} onClick={run}>{busy ? "Running…" : mode === "live" ? "Compare live (uses API)" : "Compare offline"}</button>{busy && <button onClick={() => { abortRef.current?.abort(); setBusy(false); setError("Stopped. Partial evidence is preserved."); }}>Stop</button>}</div>
    <div className="compare-grid">{(["vague", "focused"] as const).map((lane) => <div className="card" key={lane}><b>{lane}</b>{summaries[lane] ? <><p>Status: {summaries[lane]!.status} · {summaries[lane]!.mode}</p><p>{summaries[lane]!.calls} calls · {summaries[lane]!.errors} handler errors · {summaries[lane]!.responseBytes} result bytes · ${summaries[lane]!.costUsd.toFixed(4)}</p><pre className="wrap">{summaries[lane]!.answer || (summaries[lane]!.mode === "offline" ? "Scripted calls only; no model answer." : "No final answer received. Inspect the SDK stream.")}</pre></> : <p className="hint">No completed run.</p>}</div>)}</div>
    <p>Expected evidence: SKU-101 (€18) and SKU-104 (€29). Check the answer against tool results. Byte counts measure serialized handler results, not model tokens or the entire prompt. One live run does not establish reliability; use repeated task evals from lesson 52.</p>
    {calls.map((row, i) => <details className="card" key={i}><summary>{row.profile} · {row.name} · {row.bytes} bytes {row.result.isError ? "· error" : ""}</summary><pre className="wrap">{JSON.stringify(row, null, 2)}</pre></details>)}
    <MessageLog messages={messages} />
    <h3>D · Improve one thing, measure again</h3>
    <ol className="steps"><li>Write representative tasks and expected evidence before tuning descriptions.</li><li>Remove overlapping actions; explain when each tool should be chosen.</li><li>Document IDs, units, defaults, limits and empty-result behavior. Return useful recovery instructions with isError.</li><li>Bound responses and expose pagination. Keep evidence fields in concise output.</li><li>Compare task correctness, failed calls, latency and token cost over repeated runs. Fewer calls alone is insufficient.</li></ol>
    <p>An empty search is a successful result with no matches. Unknown IDs are tool errors. Schema-invalid inputs fail before the business handler. The offline wrapper exposes validation errors; live MCP validation may format those errors differently.</p>
    <h3>E · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://www.anthropic.com/engineering/writing-tools-for-agents" target="_blank" rel="noreferrer">Writing effective tools for agents</a> and <a href="https://www.anthropic.com/engineering/building-effective-agents" target="_blank" rel="noreferrer">Building effective agents</a>.</p>
  </section>;
}
