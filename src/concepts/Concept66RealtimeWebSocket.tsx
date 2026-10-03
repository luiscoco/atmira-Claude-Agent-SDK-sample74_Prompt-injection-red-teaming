import { useEffect, useRef, useState } from "react";
import type { Frame } from "../../server/realtime/protocol";

export function Concept66RealtimeWebSocket() {
  const [connection, setConnection] = useState("connecting");
  const [status, setStatus] = useState("ready");
  const [prompt, setPrompt] = useState("Explain why a WebSocket is useful for an agent frontend.");
  const [text, setText] = useState("");
  const [cost, setCost] = useState<number>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Frame[]>([]);
  const [generation, setGeneration] = useState(0);
  const [code, setCode] = useState<Record<string, string>>();
  const socket = useRef<WebSocket | null>(null);
  const currentRun = useRef<string | null>(null);
  const deliberatelyDropped = useRef(false);
  useEffect(() => {
    deliberatelyDropped.current = false;
    let disposed = false, retries = 0, lastSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: WebSocket;
    function connect() {
      if (disposed) return;
      setConnection("connecting");
      const url = new URL("/api/c66/socket", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      active = new WebSocket(url); socket.current = active; lastSeq = 0;
      const thisSocket = active;
      const timeout = window.setTimeout(() => thisSocket.close(), 10000);
      thisSocket.onopen = () => { window.clearTimeout(timeout); };
      thisSocket.onmessage = ({ data }) => {
        if (disposed || active !== thisSocket) return;
        let frame: Frame;
        try { frame = JSON.parse(data); } catch { setError("Invalid JSON received from host."); thisSocket.close(); return; }
        if (!Number.isInteger(frame.seq) || frame.seq <= lastSeq || !frame.data) return;
        lastSeq = frame.seq;
        setEvents((all) => [...all.slice(-199), frame]);
        if (frame.type === "ready") { setConnection("connected"); setError(""); return; }
        if (frame.type === "error") {
          setError(frame.data.message ?? "Host error");
          if (frame.runId === currentRun.current && frame.data.status === "failed") { currentRun.current = null; setBusy(false); setStatus("failed"); }
        }
        if (!frame.runId || frame.runId !== currentRun.current) return;
        if (frame.type === "started") setStatus("streaming");
        if (frame.type === "delta") setText((value) => (value + (frame.data.text ?? "")).slice(0, 100000));
        if (frame.type === "result") { setText((frame.data.text ?? "").slice(0, 100000)); setCost(frame.data.costUsd); }
        if (frame.type === "done") { setStatus(frame.data.status ?? "failed"); setBusy(false); currentRun.current = null; }
      };
      thisSocket.onerror = () => { if (!disposed) setError("WebSocket connection failed. Check the backend and proxy."); };
      thisSocket.onclose = () => {
        window.clearTimeout(timeout);
        if (disposed || active !== thisSocket) return;
        if (currentRun.current) { setStatus("disconnected — run cancelled by host"); setError("Connection lost. Partial output is preserved; start a fresh run after reconnecting."); }
        currentRun.current = null; setBusy(false); socket.current = null;
        if (deliberatelyDropped.current) { setConnection("disconnected"); return; }
        if (retries < 5) {
          const wait = Math.min(8000, 500 * 2 ** retries++) + Math.random() * 250;
          setConnection(`reconnecting (attempt ${retries}/5)`); timer = setTimeout(connect, wait);
        } else setConnection("disconnected");
      };
    }
    setBusy(false); currentRun.current = null; connect();
    return () => { disposed = true; clearTimeout(timer); active?.close(); socket.current = null; currentRun.current = null; };
  }, [generation]);

  function start(mode: "guided" | "live") {
    if (currentRun.current || socket.current?.readyState !== WebSocket.OPEN || connection !== "connected") return;
    const runId = crypto.randomUUID(); currentRun.current = runId;
    setBusy(true); setStatus("starting"); setError(""); setText(""); setCost(undefined); setEvents([]);
    socket.current.send(JSON.stringify({ type: "start", runId, mode, prompt }));
  }
  function cancel() {
    if (currentRun.current && socket.current?.readyState === WebSocket.OPEN) {
      setStatus("cancelling"); socket.current.send(JSON.stringify({ type: "cancel", runId: currentRun.current }));
    }
  }
  function dropConnection() {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    deliberatelyDropped.current = true;
    setConnection("disconnecting");
    socket.current.close(1000, "Connection dropped by learner");
  }
  async function loadCode() {
    try { const response = await fetch("/api/c66/code"); if (!response.ok) throw new Error(`Source: HTTP ${response.status}`); setCode(await response.json()); }
    catch (error) { setError(String(error)); }
  }
  const valid = prompt.trim().length > 0 && prompt.length <= 2000;
  return <>
    <h2>66. Real-time frontends over WebSocket</h2>
    <p>Keep the Agent SDK on your Node host. A browser WebSocket sends commands and receives incremental output over the same bidirectional connection.</p>
    <div className="grid">
      <div className="card"><b>Connect</b><p>HTTP upgrades to WebSocket. The host sends ready, and the browser can start a run.</p></div>
      <div className="card"><b>Stream</b><p>Correlate every frame with a run ID and connection sequence. Append text deltas, then replace them with the authoritative result.</p></div>
      <div className="card"><b>Control</b><p>Send cancel while the host streams. Leaving the lesson or losing the socket aborts its run.</p></div>
    </div>
    <h3>A · Try a real bidirectional connection</h3>
    <div className="card">
      <p role="status" aria-live="polite">Connection: {connection} · Run: {status}</p>
      <label htmlFor="realtime-prompt">Prompt</label>
      <textarea id="realtime-prompt" rows={3} maxLength={2000} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} />
      <p><button disabled={busy || !valid || connection !== "connected"} onClick={() => start("guided")}>Stream guided response (no model API)</button>{" "}
        <button disabled={busy || !valid || connection !== "connected"} onClick={() => start("live")}>Stream live agent (billed)</button>{" "}
        <button disabled={!busy || status === "cancelling"} onClick={cancel}>Cancel run</button>{" "}
        <button disabled={connection !== "connected"} onClick={dropConnection}>Drop connection</button>{" "}
        <button disabled={busy} onClick={() => setGeneration((value) => value + 1)}>Reconnect</button></p>
      <p className="hint">Guided mode uses a deterministic host response over the real socket. Live mode calls Haiku with no tools, one turn, a $0.05 budget and a 60-second host deadline.</p>
      {connection === "disconnected" && deliberatelyDropped.current && <p role="status">Connection deliberately dropped. Press Reconnect to open a new connection. Any interrupted run stays cancelled.</p>}
    </div>
    {error && <p className="card warn" role="alert">{error}</p>}
    <div className="card"><b>Streamed answer</b><pre className="wrap">{text || "Start a run to see incremental output."}</pre>{cost !== undefined && <p>Reported cost: ${cost.toFixed(6)}</p>}</div>
    <details className="card"><summary>Wire frames ({events.length}, latest 200)</summary><pre className="wrap">{JSON.stringify(events, null, 2)}</pre></details>
    <h3>B · Commands and events</h3>
    <pre className="wrap">{`Browser → host: { type: "start", runId, mode, prompt }
Browser → host: { type: "cancel", runId }
Host → browser: { type, runId, seq, data }
ready → started → delta* → result → done
                      ↘ error → done
Cancellation: done.data.status = "cancelled"`}</pre>
    <p>Only one run per connection is accepted. The host validates JSON and rejects duplicate IDs, binary input, oversized frames and excessive commands. Heartbeat ping/pong detects dead sockets. A slow consumer is disconnected when the host's send buffer exceeds 256 KiB.</p>
    <h3>C · Disconnect and reconnect</h3>
    <p>Press Drop connection to close the socket and keep it disconnected. During streaming, the host cancels the run and the browser preserves partial text. Press Reconnect to open a fresh socket, then choose a new run explicitly. Unexpected connection loss triggers automatic recovery with bounded exponential backoff and jitter (five attempts); the interrupted request is never automatically resubmitted.</p>
    <p>This sample does not retain or replay frames. Sequence numbers restart per connection. Durable resumption needs authenticated session ownership, a retained event journal and a last-seen cursor, as well as idempotent commands. See lesson 60 for durable execution.</p>
    <h3>D · WebSocket versus SSE</h3>
    <p>SSE is a one-way HTTP response; earlier lessons pair it with separate POST requests for controls. WebSocket lets both sides send frames on one connection. You define validation, heartbeat, reconnect and run correlation yourself.</p>
    <p>The upgrade requires a matching browser Origin and Host. This local teaching app has no user authentication. Before exposing it publicly, authenticate the upgrade, authorize every run and apply account-level quotas. Use HTTPS/WSS and preserve Host through your proxy.</p>
    <button onClick={loadCode}>Load source code</button>
    {code && Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">Reference: <a href="https://github.com/websockets/ws/blob/master/README.md" target="_blank" rel="noreferrer">ws server, upgrade and heartbeat examples</a>.</p>
  </>;
}
