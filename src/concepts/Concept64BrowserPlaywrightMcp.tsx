import { useEffect, useRef, useState } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type Facts = { version: string; toolNames: string[]; systemPrompt: string; config: unknown };
type Evidence = { verified: boolean; bookings: { name: string; workshop: string; confirmation: string }[]; snapshot?: string; screenshotUrl?: string | null; costUsd?: number };
export function Concept64BrowserPlaywrightMcp() {
  const [facts, setFacts] = useState<Facts>();
  const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState("Alex Learner"); const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<{ name: string; result: unknown }[]>([]);
  const [messages, setMessages] = useState<any[]>([]); const [setup, setSetup] = useState<unknown>();
  const [evidence, setEvidence] = useState<Evidence>(); const [answer, setAnswer] = useState("");
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/c64/facts", { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Loading lesson: HTTP ${response.status}`);
      setFacts(await response.json()); setError("");
    }).catch((error) => { if (!abort.signal.aborted) setError(String(error)); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [attempt]);
  async function start(mode: "guided" | "live") {
    setBusy(true); setError(""); setEvents([]); setMessages([]); setEvidence(undefined); setAnswer(""); setSetup(undefined);
    const abort = new AbortController(); controller.current = abort;
    try {
      await streamPost("/api/c64/run", { mode, name }, (event, data) => {
        if (event === "setup") setSetup(data);
        if (event === "tool") setEvents((all) => [...all, data]);
        if (event === "message") setMessages((all) => [...all, data]);
        if (event === "evidence") setEvidence(data);
        if (event === "answer") setAnswer(data.text);
        if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (error) { setError(abort.signal.aborted ? "Run stopped. A submission may already have happened in the disposable site." : String(error)); }
    finally { setBusy(false); }
  }
  async function loadCode() {
    try { const response = await fetch("/api/c64/code"); if (!response.ok) throw new Error(`Source: HTTP ${response.status}`); setCode(await response.json()); }
    catch (error) { setError(String(error)); }
  }
  return <>
    <h2>64. Browser automation with Playwright MCP</h2>
    <p>Give an agent a browser through an external MCP server. It reads an accessibility snapshot, acts on element references, and checks the resulting page. This lesson books a fictional workshop on a disposable local site.</p>
    <div className="grid">
      <div className="card"><b>Connect</b><p>The SDK starts the pinned Playwright MCP server over stdio. Tool names become <code>mcp__playwright__browser_…</code>. The browser runs headless in a fresh isolated context.</p></div>
      <div className="card"><b>Observe → act → verify</b><p>Navigate, snapshot, type, select, click, wait for confirmation, then snapshot again. Element refs come from the current snapshot; refresh them after page changes.</p></div>
      <div className="card"><b>Keep evidence</b><p>The site records the actual booking. A final snapshot and screenshot explain what the browser saw. A model's success claim alone does not verify a submission.</p></div>
    </div>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((value) => value + 1)}>Retry loading</button>}</div>}
    <h3>A · Configuration and tool contract</h3>
    <p>Requires installed Chrome and Node 24 or newer. To use another Chromium executable, set <code>PLAYWRIGHT_MCP_EXECUTABLE_PATH</code> in <code>.env</code> and restart the server. Each run starts its own loopback site and closes it afterward.</p>
    {facts && <><p className="hint">Pinned <code>@playwright/mcp@{facts.version}</code> · headless · isolated · no personal browser profile</p>
      <details className="card"><summary>External MCP configuration</summary><pre className="wrap">{JSON.stringify(facts.config, null, 2)}</pre></details>
      <details className="card"><summary>Tools used in this lesson</summary><pre>{facts.toolNames.join("\n")}</pre></details></>}
    <h3>B · Run the browser exercise (no model API)</h3>
    <p>The guided run uses a real MCP client and a real browser. Code chooses the next tool call; snapshots supply the element refs. Inspect the streamed tool schemas and results to see the protocol without paying for a model call.</p>
    <div className="card"><label>Fictional attendee name <input value={name} maxLength={40} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <p className="hint">Use 1–40 letters, spaces or hyphens.</p>
      <button disabled={busy || !/^[A-Za-z][A-Za-z -]{0,39}$/.test(name.trim())} onClick={() => start("guided")}>Run guided browser</button>
    </div>
    <h3>C · Let the SDK drive the browser (live, billed)</h3>
    <p>The same task uses <code>query()</code> and Haiku with eight browser tools, no built-in tools, a 16-turn limit, a $0.25 budget and a 120-second deadline. Requires configured Anthropic credentials. Stop or leaving the lesson cancels the run.</p>
    <button disabled={busy || !/^[A-Za-z][A-Za-z -]{0,39}$/.test(name.trim())} onClick={() => start("live")}>Run browser agent (billed)</button>{" "}
    <button disabled={!busy} onClick={() => controller.current?.abort()}>Stop</button>
    <p role="status" aria-live="polite">{busy ? "Browser running… Tool results appear below." : evidence ? "Run finished. Inspect the host evidence below." : "Ready to run."}</p>
    {setup !== undefined && <details className="card"><summary>This run's MCP process configuration</summary><pre className="wrap">{JSON.stringify(setup, null, 2)}</pre></details>}
    {events.map((event, index) => <details className="card" key={index}><summary>{index + 1}. {event.name}</summary><pre className="wrap">{JSON.stringify(event.result, null, 2)}</pre></details>)}
    {answer && <div className="card"><b>Agent report</b><p>{answer}</p></div>}
    {evidence && <div className="card" aria-live="polite"><b>{evidence.verified ? "PASS · host verified the expected booking" : "Expected booking was not verified"}</b>
      <pre className="wrap">{JSON.stringify(evidence.bookings, null, 2)}</pre>
      {evidence.costUsd !== undefined && <p className="hint">Model cost: ${evidence.costUsd.toFixed(4)}</p>}
      {evidence.snapshot && <details><summary>Final accessibility snapshot</summary><pre className="wrap">{evidence.snapshot}</pre></details>}
      {evidence.screenshotUrl ? <><p><a href={evidence.screenshotUrl} target="_blank" rel="noreferrer">Open screenshot</a></p><img src={evidence.screenshotUrl} alt="Browser screenshot of the practice desk after submission" style={{ maxWidth: "100%", height: "auto" }} /></> : <p>No screenshot was captured.</p>}
    </div>}
    <MessageLog messages={messages} />
    <h3>D · Browser state and untrusted pages</h3>
    <p>The imported note attempts to redirect the agent and steal cookies. Treat it as page data. The live run's host hook restricts navigation to the fixture and screenshot writes to <code>proof.png</code>; evaluation, arbitrary code, uploads and file access tools are unavailable.</p>
    <p><code>--isolated</code> discards cookies on close. Persistent profiles retain login state and can conflict across runs; CDP and the browser extension connect to existing sessions. Use disposable profiles for practice. The origin allowlist is a request filter and does not guarantee security isolation or block every redirect. Production automation needs a browser sandbox and network controls.</p>
    <p>Wait for meaningful text rather than a fixed sleep. A ref may become stale when the DOM changes: take a fresh snapshot before retrying. Repeated submission can duplicate real actions, so verify the application state before a retry. Use screenshots for visual review and accessibility snapshots for interactions.</p>
    {facts && <details className="card"><summary>Browser agent system prompt</summary><pre className="wrap">{facts.systemPrompt}</pre></details>}
    <button onClick={loadCode}>Load source code</button>
    {code && Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://github.com/microsoft/playwright-mcp" target="_blank" rel="noreferrer">Official Playwright MCP documentation</a> · <a href="https://code.claude.com/docs/en/agent-sdk/mcp" target="_blank" rel="noreferrer">Agent SDK MCP integration</a>.</p>
  </>;
}
