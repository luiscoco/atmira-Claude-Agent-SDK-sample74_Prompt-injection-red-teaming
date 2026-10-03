import { useEffect, useRef, useState } from "react";
import { streamPost } from "../lib/sse";
import { readJsonResponse } from "../lib/json-response";
import type { PythonEvent } from "../../server/python-sdk/bridge";

const prompts = {
  query: "Explain Python async iterators in two sentences.",
  conversation: "Explain the difference between query() and ClaudeSDKClient in the Python Agent SDK.",
  tool: "What is 19 + 23?",
};
export function Concept70PythonSdk() {
  const [exercise, setExercise] = useState<keyof typeof prompts>("query");
  const [prompt, setPrompt] = useState(prompts.query), [mode, setMode] = useState<"guided" | "live">("guided");
  const [busy, setBusy] = useState(false), [events, setEvents] = useState<PythonEvent[]>([]), [notice, setNotice] = useState("");
  const [code, setCode] = useState<Record<string, string>>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function run() {
    if (abort.current) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setEvents([]); setNotice("");
    let terminal = false;
    const timer = window.setTimeout(() => controller.abort(), 100_000);
    try {
      await streamPost("/api/c70/run", { mode, exercise, prompt }, (_kind, event: PythonEvent) => {
        if (controller.signal.aborted) return;
        setEvents((old) => [...old.slice(-199), event]);
        if (event.type === "error") setNotice(event.text ?? "Python run failed.");
        if (event.type === "done") { terminal = true; if (event.status === "completed") setNotice("Exercise completed."); }
      }, controller.signal);
      if (!terminal) throw new Error("Connection closed before the final Python event. Run again.");
    } catch (error) { setNotice(controller.signal.aborted ? "Stopped. The host terminates Python and its CLI process. Live runs may still incur cost." : String(error)); }
    finally { window.clearTimeout(timer); abort.current = null; setBusy(false); }
  }
  return <section className="python-sdk-lesson">
    <h2>70. The Python SDK</h2>
    <p>Use <code>claude-agent-sdk</code> to drive the Claude Code agent loop from Python. This lesson runs a Python process behind the existing Node server and streams its JSON-lines events to the browser.</p>
    <div className="grid">
      <div className="card"><b>query()</b><p>A one-shot async iterator. Inspect typed messages and text blocks; the final ResultMessage includes session ID, usage and cost.</p></div>
      <div className="card"><b>ClaudeSDKClient</b><p>An async context manager for interactive conversations. Send with query(), receive with receive_response(), then send a follow-up on the same client.</p></div>
      <div className="card"><b>Python tools & hooks</b><p>Wrap an async function with @tool, register an in-process MCP server, and run a PreToolUse callback before execution.</p></div>
    </div>
    <h3>A · Install and choose an interpreter</h3>
    <p>Python 3.10+ is required. Platform wheels bundle a Claude Code CLI; source installs may use a separately installed native CLI. Installing the TypeScript SDK does not install the Python SDK.</p>
    <pre>{"python -m venv .venv\n# Windows\n.\\.venv\\Scripts\\python.exe -m pip install -r python-sdk/requirements.txt\n# macOS / Linux\n.venv/bin/python -m pip install -r python-sdk/requirements.txt"}</pre>
    <p className="hint">The host automatically uses the local .venv, then falls back to python on PATH. For another environment, set PYTHON_SDK_EXECUTABLE to its executable path in .env and restart npm run dev. Live mode also requires ANTHROPIC_API_KEY. Credentials stay on the server.</p>
    <h3>B · Run a Python exercise</h3>
    <label htmlFor="python-exercise">Exercise</label>
    <select id="python-exercise" disabled={busy} value={exercise} onChange={(e) => { const next = e.target.value as keyof typeof prompts; setExercise(next); setPrompt(prompts[next]); }}>
      <option value="query">One-shot query()</option><option value="conversation">Two-turn ClaudeSDKClient</option><option value="tool">Custom calculator + PreToolUse hook</option>
    </select>
    <label htmlFor="python-mode">Execution mode</label>
    <select id="python-mode" disabled={busy} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="guided">Guided · fixed fixtures · no API</option><option value="live">Live Python SDK · billed Haiku</option></select>
    <label htmlFor="python-prompt">Prompt</label>
    <textarea id="python-prompt" rows={3} maxLength={2000} disabled={busy || mode === "guided"} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
    <p className="hint">Guided mode runs actual Python validation, arithmetic and hook functions with fixed events. It does not use the SDK or your prompt. Live conversation mode adds “Summarize your previous answer in one sentence” as its second turn.</p>
    <div className="row"><button disabled={busy || !prompt.trim()} onClick={() => void run()}>Run Python exercise</button><button disabled={!busy} onClick={() => abort.current?.abort()}>Cancel</button></div>
    <p role="status" aria-live="polite">{busy ? "Python is running…" : notice || "Ready. Start with guided mode."}</p>
    <pre className="wrap" aria-label="Python output">{events.filter((event) => event.type === "text").map((event) => `Turn ${event.turn}: ${event.text}`).join("\n\n") || "Assistant text appears here."}</pre>
    <details open><summary>Python event trace ({events.length})</summary><pre className="wrap">{events.map((event) => JSON.stringify(event)).join("\n") || "Inspect system, hook, tool, text, result and done events."}</pre></details>
    <p className="hint">Live runs disable built-in tools and project settings, use private CLI configuration, allow at most three agentic turns per query, and set a $0.03 budget threshold per query (not an exact billing cap). The second conversation query can add cost. Python has a 75-second deadline; the host has a 90-second deadline. Text streams as complete assistant blocks; token streaming requires StreamEvent and include_partial_messages.</p>
    <h3>C · Translate TypeScript to Python</h3>
    <table><thead><tr><th>TypeScript</th><th>Python</th></tr></thead><tbody>
      <tr><td>query({"{ prompt, options }"})</td><td>query(prompt=..., options=ClaudeAgentOptions(...))</td></tr>
      <tr><td>for await (const message of run)</td><td>async for message in query(...)</td></tr>
      <tr><td>message.type === "assistant"</td><td>isinstance(message, AssistantMessage)</td></tr>
      <tr><td>allowedTools / maxTurns / settingSources</td><td>allowed_tools / max_turns / setting_sources</td></tr>
      <tr><td>tool() + createSdkMcpServer()</td><td>@tool + create_sdk_mcp_server()</td></tr>
    </tbody></table>
    <p><code>allowed_tools</code> auto-approves named tools; it does not remove other tools. This lab uses <code>tools=[]</code> to disable built-ins, strict MCP configuration and a deny callback for other tools. The calculator validates finite numeric inputs independently of its schema.</p>
    <h3>D · Lifecycle, errors and source</h3>
    <p>Keep send and receive inside the same async context. Exiting ClaudeSDKClient disconnects it; use client.interrupt() to interrupt a turn while keeping a client open. This browser lab cancels the whole process instead. Check ResultMessage.is_error and subtype, handle missing results, and distinguish installation, connection, process and JSON-decoding failures in your application. Session resume uses a host-owned session ID; this lab starts a fresh session for every run.</p>
    <button onClick={() => { void fetch("/api/c70/code").then(readJsonResponse).then(setCode).catch((error) => setNotice(String(error))); }}>Load Python and bridge source</button>
    {code && Object.entries(code).map(([name, source]) => <details key={name}><summary>{name}</summary><pre>{source}</pre></details>)}
    <p><a href="https://code.claude.com/docs/en/agent-sdk/python" target="_blank" rel="noreferrer">Python SDK reference</a> · <a href="https://github.com/anthropics/claude-agent-sdk-python" target="_blank" rel="noreferrer">Official Python SDK repository</a></p>
  </section>;
}
