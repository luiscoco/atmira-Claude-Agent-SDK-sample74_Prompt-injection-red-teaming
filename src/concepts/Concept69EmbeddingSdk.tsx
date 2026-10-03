import { useEffect, useRef, useState } from "react";
import { applyProposal, type HostEvent, type Proposal, type Snapshot } from "../../server/embedding/protocol";
import { streamPost } from "../lib/sse";
import { readJsonResponse } from "../lib/json-response";

const initial = "function greet(name) {\n  return 'Hello, ' + name;\n}\n";
export function Concept69EmbeddingSdk() {
  const [text, setText] = useState(initial), [version, setVersion] = useState(1), [trusted, setTrusted] = useState(false);
  const [mode, setMode] = useState<"guided" | "live">("guided"), [busy, setBusy] = useState(false), [output, setOutput] = useState("");
  const [events, setEvents] = useState<HostEvent[]>([]), [proposal, setProposal] = useState<Proposal>(), [notice, setNotice] = useState("");
  const [code, setCode] = useState<Record<string, string>>();
  const abort = useRef<AbortController | null>(null), editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => { abort.current?.abort(); }, []);
  function update(next: string) { setText(next); setVersion((v) => v + 1); }
  async function start(action: "explain" | "rewrite") {
    if (abort.current) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setOutput(""); setEvents([]); setProposal(undefined); setNotice("");
    const from = editor.current?.selectionStart ?? 0, to = editor.current?.selectionEnd ?? 0;
    const snapshot: Snapshot = { uri: "demo://greeting.js", version, text, start: from === to ? 0 : from, end: from === to ? text.length : to };
    let terminal = false;
    const timeout = window.setTimeout(() => controller.abort(), 100_000);
    try {
      await streamPost("/api/c69/run", { command: { type: "start", action, mode }, snapshot, trusted }, (_kind, event: HostEvent) => {
        if (controller.signal.aborted) return;
        setEvents((previous) => [...previous.slice(-99), event]);
        if (event.type === "delta") setOutput((previous) => previous + event.text);
        if (event.type === "proposal") setProposal(event.proposal);
        if (event.type === "error") setNotice(event.message);
        if (event.type === "done") { terminal = true; setNotice(`${event.status}. Reported cost: $${event.costUsd.toFixed(5)}.`); }
      }, controller.signal);
      if (!terminal) throw new Error("Host disconnected before the final result. Run again.");
    } catch (error) {
      setProposal(undefined); setNotice(controller.signal.aborted ? "Run stopped. The connection closed and the host cancels its SDK process." : String(error));
    } finally { window.clearTimeout(timeout); if (abort.current === controller) abort.current = null; setBusy(false); }
  }
  function apply() {
    if (!proposal || !trusted) return;
    try { update(applyProposal({ uri: "demo://greeting.js", version, text, start: 0, end: text.length }, proposal)); setProposal(undefined); setNotice("Applied to the demo buffer. In VS Code this is an undoable WorkspaceEdit."); }
    catch (error) { setProposal(undefined); setNotice(String(error)); }
  }
  return <section>
    <h2>69. Embedding the SDK in a desktop app or IDE extension</h2>
    <p>Keep the Agent SDK in a trusted Node host. Send small commands from the interface, stream typed events back, and let the editor own document changes.</p>
    <div className="grid">
      <div className="card"><b>Interface</b><p>A React renderer or VS Code webview sends Explain, Rewrite, Cancel and Apply commands. It receives text and proposals, with no credentials.</p></div>
      <div className="card"><b>Host</b><p>The Node process validates commands, captures selected text, checks workspace trust, owns one run per panel and cancels on disposal.</p></div>
      <div className="card"><b>Editor</b><p>A proposed replacement requires a click. The host checks document identity, version and text before an undoable edit.</p></div>
    </div>
    <h3>A · Capture an editor buffer</h3>
    <p className="hint">Browser teaching adapter: this buffer and trust checkbox simulate the editor. The included VS Code extension reads the actual document and workspace trust in its host. Guided mode uses a fixed comment proposal and costs $0.</p>
    <label className="check"><input type="checkbox" checked={trusted} onChange={(e) => { setTrusted(e.target.checked); if (!e.target.checked) { abort.current?.abort(); setProposal(undefined); } }} />Trust the demo workspace</label>
    <label htmlFor="embedding-buffer">greeting.js · buffer version {version}</label>
    <textarea ref={editor} id="embedding-buffer" rows={7} maxLength={24000} value={text} onChange={(e) => update(e.target.value)} />
    <p className="hint">Select text or leave the selection empty to send the whole demo buffer. You can edit it while a run is active to test stale proposal rejection.</p>
    <label htmlFor="embedding-mode">Execution mode</label>
    <select id="embedding-mode" disabled={busy} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="guided">Guided · no API</option><option value="live">Live Haiku · billed</option></select>
    <div className="row"><button disabled={!trusted || busy || !text} onClick={() => void start("explain")}>Explain selection</button><button disabled={!trusted || busy || !text} onClick={() => void start("rewrite")}>Propose rewrite</button><button disabled={!busy} onClick={() => abort.current?.abort()}>Cancel run</button></div>
    <p className="hint">Live runs have no tools, two turns, a 60-second host deadline and a $0.03 SDK budget threshold. This threshold is not an exact billing cap. Only selected text is sent to the model; credentials stay on the server. Cancelled runs may incur cost without a final cost report.</p>
    <p role="status" aria-live="polite">{busy ? "Streaming from the host…" : notice || "Ready. Trust the demo workspace to begin."}</p>
    <pre className="wrap" aria-label="Streamed response">{output || "Responses appear here."}</pre>
    <h3>B · Review before applying</h3>
    {proposal ? <div className="card"><b>Captured version {proposal.snapshot.version} → proposed replacement</b><div className="compare-grid"><div><p>Before</p><pre className="wrap">{proposal.snapshot.text.slice(proposal.snapshot.start, proposal.snapshot.end)}</pre></div><div><p>After</p><pre className="wrap">{proposal.replacement || "(delete selection)"}</pre></div></div><div className="row"><button disabled={busy || !trusted} onClick={apply}>Apply reviewed edit</button><button disabled={busy} onClick={() => { setProposal(undefined); setNotice("Proposal discarded."); }}>Discard proposal</button></div></div> : <p>No pending proposal. Run Propose rewrite, then change the buffer before clicking Apply to see the version check.</p>}
    <details><summary>Inspect host events ({events.length})</summary><pre className="wrap">{events.map((event) => JSON.stringify(event)).join("\n") || "Each event carries a run ID and sequence number."}</pre></details>
    <h3>C · Run the VS Code extension</h3>
    <p>The example in <code>ide-extension/</code> reuses this host and SDK runner. Run <code>npm run build:extension</code>, then launch VS Code with <code>code --extensionDevelopmentPath=./ide-extension .</code>. Open a JavaScript file and run <b>Lesson 69: Open Agent Panel</b> from the Command Palette.</p>
    <p>The extension captures unsaved selections, renders model text with textContent under a content security policy, uses a diff preview, and applies a WorkspaceEdit only after you review it. Closing the panel or deactivating the extension aborts the run.</p>
    <h3>D · Desktop and packaging decisions</h3>
    <p>In Electron, put this host in the main process or a utility process. Expose a narrow API through a preload with context isolation enabled and node integration disabled; validate sender identity and every IPC message. Use the main process to capture trusted context and apply reviewed changes.</p>
    <p>Ship the Node runtime and SDK subprocess assets correctly, including the CLI. Test the installed build on each target OS, preserve executable permissions, and keep API keys in host storage or an OS credential store. VS Code remote workspaces run workspace extensions on the remote extension host; they do not necessarily use your laptop's environment.</p>
    <p className="hint">The development extension inherits ANTHROPIC_API_KEY from the environment used to launch VS Code. The web lab reads the project's .env through npm run dev. Isolated SDK configuration does not reuse your normal Claude login. This lesson uses independent runs; persistent conversation and resume require host-owned session IDs and lifecycle rules.</p>
    <button onClick={() => { void fetch("/api/c69/code").then(readJsonResponse).then(setCode).catch((error) => setNotice(String(error))); }}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details key={name}><summary>{name}</summary><pre>{source}</pre></details>)}
  </section>;
}
