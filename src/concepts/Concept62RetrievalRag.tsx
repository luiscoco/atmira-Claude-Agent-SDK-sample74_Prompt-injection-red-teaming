import { useEffect, useRef, useState } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type Hit = { id: string; title: string; heading: string; text: string; score: number };
type Exercise = { id: string; question: string; query: string; expected: string | null };
type Facts = { documents: { id: string; title: string; tenant: string; status: string; text: string }[]; chunks: unknown[]; exercises: Exercise[]; systemPrompt: string; searchSchema: unknown; model: string };
type Answer = { status: string; answer: string; citations: { sourceId: string; quote: string }[]; sources: Hit[]; costUsd: number };
export function Concept62RetrievalRag() {
  const [facts, setFacts] = useState<Facts>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("return unused products window");
  const [question, setQuestion] = useState("How many days do I have to return unused products?");
  const [topK, setTopK] = useState(3);
  const [hits, setHits] = useState<Hit[]>();
  const [evaluations, setEvaluations] = useState<(Exercise & { ids: string[]; pass: boolean })[]>();
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<Answer>();
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<any[]>([]);
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/c62/facts", { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Loading lesson: HTTP ${response.status}`);
      setFacts(await response.json()); setError("");
    }).catch((error) => { if (!abort.signal.aborted) setError(String(error)); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [attempt]);
  async function retrieve() {
    setSearching(true); setError("");
    try {
      const response = await fetch("/api/c62/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, topK }) });
      if (!response.ok) throw new Error(`Search: HTTP ${response.status}`);
      setHits((await response.json()).hits);
    } catch (error) { setError(String(error)); } finally { setSearching(false); }
  }
  async function evaluate() {
    try { const response = await fetch("/api/c62/eval"); if (!response.ok) throw new Error(`Evaluation: HTTP ${response.status}`); setEvaluations(await response.json()); }
    catch (error) { setError(String(error)); }
  }
  async function live() {
    setBusy(true); setAnswer(undefined); setMessages([]); setCalls([]); setError("");
    controller.current = new AbortController();
    try {
      await streamPost("/api/c62/query", { question }, (event, data) => {
        if (event === "message") setMessages((all) => [...all, data]);
        if (event === "retrieval") setCalls((all) => [...all, data]);
        if (event === "answer") setAnswer(data);
        if (event === "error") setError(data.message);
      }, controller.current.signal);
    } catch (error) { setError(controller.current.signal.aborted ? "Run stopped." : String(error)); }
    finally { setBusy(false); }
  }
  async function loadCode() {
    try { const response = await fetch("/api/c62/code"); if (!response.ok) throw new Error(`Source: HTTP ${response.status}`); setCode(await response.json()); }
    catch (error) { setError(String(error)); }
  }
  return <>
    <h2>62. Retrieval (RAG) through custom tools</h2>
    <p>Keep knowledge in your application. Let the agent search it on demand, read a few passages, then answer with citations. RAG means retrieval-augmented generation: the model receives evidence through tool results.</p>
    <div className="grid">
      <div className="card"><b>Index</b><p>Split fictional Markdown policies at headings. Give each passage a stable source ID. This small lab computes BM25-style lexical scores; no embeddings or vector database are needed.</p></div>
      <div className="card"><b>Retrieve</b><p><code>search_knowledge</code> returns up to five passages. The host filters tenant and current versions before ranking. The model cannot change those filters.</p></div>
      <div className="card"><b>Generate and check</b><p>The agent cites exact quotes or abstains. The host checks citation IDs and quotes against passages retrieved in this run. These checks do not prove that every claim follows from the evidence.</p></div>
    </div>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((value) => value + 1)}>Retry loading</button>}</div>}
    <h3>A · The knowledge corpus</h3>
    <p>Acme has current policies, an archived policy, another tenant's private policy, and an imported note containing an instruction attack. Search excludes archived and other-tenant passages; the note remains visible to demonstrate that retrieval is not a trust boundary.</p>
    {facts && <>
      <p className="hint">{facts.documents.length} documents · {facts.chunks.length} heading-based chunks · live model: <code>{facts.model}</code></p>
      {facts.documents.map((doc) => <details className="card" key={doc.id}><summary>{doc.title} · {doc.tenant} · {doc.status}</summary><pre className="wrap">{doc.text}</pre></details>)}
    </>}
    <h3>B · Inspect retrieval (offline)</h3>
    <p>Choose an exercise or enter keywords. Scores measure keyword relevance, not factual accuracy or model confidence. Lexical search can miss paraphrases; try another query when no passage matches.</p>
    <div className="card">
      <label>Exercise <select defaultValue="returns" disabled={busy} onChange={(event) => {
        const exercise = facts?.exercises.find((item) => item.id === event.target.value);
        if (exercise) { setQuery(exercise.query); setQuestion(exercise.question); setHits(undefined); }
      }}>{facts?.exercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.question}</option>)}</select></label>
      <label>Search keywords <input value={query} maxLength={300} onChange={(event) => setQuery(event.target.value)} /></label>
      <label>Passage limit <select value={topK} onChange={(event) => setTopK(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((number) => <option key={number}>{number}</option>)}</select></label>
      <button disabled={searching || !query.trim()} onClick={retrieve}>{searching ? "Searching…" : "Search offline"}</button>
    </div>
    {hits && <div aria-live="polite">{!hits.length && <p>No matching passages. Reformulate the query or abstain; do not guess.</p>}{hits.map((hit) => <div className="card" key={hit.id}><b>{hit.id} · {hit.heading}</b><p className="hint">{hit.title} · score {hit.score}</p><p>{hit.text}</p></div>)}</div>}
    <h3>C · Retrieval regression exercises (offline)</h3>
    <p>Check ranking and no-match behavior without a model. The injection exercise expects the hostile note to be retrieved; safe answer generation must still reject its instructions.</p>
    <button onClick={evaluate}>Run retrieval checks</button>
    {evaluations && <div className="scroll-x"><table className="compare"><thead><tr><th>Case</th><th>Expected top source</th><th>Retrieved sources</th><th>Result</th></tr></thead><tbody>{evaluations.map((item) => <tr key={item.id}><td>{item.id}</td><td>{item.expected ?? "no matches"}</td><td>{item.ids.join(", ") || "none"}</td><td>{item.pass ? "PASS" : "FAIL"}</td></tr>)}</tbody></table></div>}
    <h3>D · Ask the retrieval agent (live, billed)</h3>
    <p>One isolated <code>query()</code> with two read-only custom tools, a six-turn limit, a $0.10 budget and a 90-second deadline. Requires your configured Anthropic credentials. Tool results and raw SDK messages stream below.</p>
    <div className="card"><label>Question <textarea value={question} maxLength={2000} disabled={busy} onChange={(event) => setQuestion(event.target.value)} /></label>
      <button disabled={busy || !question.trim()} onClick={live}>Ask agent (billed)</button> <button disabled={!busy} onClick={() => controller.current?.abort()}>Stop</button>
    </div>
    {calls.map((call, index) => <details className="card" key={index} open><summary>Custom tool: {call.name}</summary><pre className="wrap">{JSON.stringify(call, null, 2)}</pre></details>)}
    {answer && <div className="card" aria-live="polite"><b>{answer.status === "answered" ? "Answer · citations checked" : "Insufficient evidence"}</b><p>{answer.answer}</p>
      {answer.citations.map((citation, index) => <blockquote key={index}><code>{citation.sourceId}</code><p>{citation.quote}</p></blockquote>)}<p className="hint">Cost: ${answer.costUsd.toFixed(4)} · {answer.sources.length} distinct passages retrieved</p></div>}
    <MessageLog messages={messages} />
    <h3>E · The tool contract and implementation</h3>
    {facts && <><details className="card"><summary>Search input schema</summary><pre className="wrap">{JSON.stringify(facts.searchSchema, null, 2)}</pre></details><details className="card"><summary>Agent system prompt</summary><pre className="wrap">{facts.systemPrompt}</pre></details></>}
    <button onClick={loadCode}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
    <p>For a larger corpus, replace the search function with your vector or hybrid retriever while keeping server-side access filters, bounded passages and source IDs. Evaluate retrieval recall separately from answer faithfulness.</p>
    <p className="hint">Reference: <a href="https://code.claude.com/docs/en/agent-sdk/custom-tools" target="_blank" rel="noreferrer">Agent SDK custom tools</a>.</p>
  </>;
}
