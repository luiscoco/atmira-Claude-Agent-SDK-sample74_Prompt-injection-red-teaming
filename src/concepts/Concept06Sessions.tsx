import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept06Sessions() {
  const [prompt, setPrompt] = useState("Remember that my favorite color is green.");
  const [messages, setMessages] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [options, setOptions] = useState<any>(null);
  const [running, setRunning] = useState(false);

  function newSession() {
    setMessages([]);
    setSessionId(null);
    setOptions(null);
    setPrompt("Remember that my favorite color is green.");
  }

  async function run() {
    setRunning(true);
    try {
      await streamPost("/api/c6/query", { prompt, resume: sessionId }, (event, data) => {
        if (event === "options") setOptions(data);
        if (event === "message") {
          setMessages((previous) => [...previous, data]);
          if (data.type === "system" && data.subtype === "init") setSessionId(data.session_id);
        }
        if (event === "error") setMessages((previous) => [...previous, { type: "error", message: data.message }]);
      });
    } finally {
      setRunning(false);
    }
  }

  const init = messages.filter((message) => message.type === "system" && message.subtype === "init").at(-1);
  const results = messages.filter((message) => message.type === "result");
  const text = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.message.content)
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");

  return (
    <section>
      <h2>6 · Sessions with resume</h2>
      <p className="lead">
        The first <code>query()</code> creates a session. Send its <code>system/init.session_id</code> back as
        <code> options.resume</code> to continue with the same conversation.
      </p>

      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} disabled={running} />
      <div className="row">
        <button className="primary" onClick={run} disabled={running || !prompt.trim()}>
          {running ? "Running..." : sessionId ? "Continue session" : "Start session"}
        </button>
        <button onClick={newSession} disabled={running}>New session</button>
      </div>

      {sessionId && (
        <div className="card">
          <b>Active session</b> <code>{sessionId}</code>
          <div className="hint">This ID is sent as <code>resume</code> on the next run.</div>
        </div>
      )}
      {options && <div className="card"><b>options sent to query()</b><pre>{JSON.stringify(options, null, 2)}</pre></div>}
      {init && <div className="card"><b>Latest system/init</b> — session <code>{init.session_id}</code>, model <code>{init.model}</code></div>}
      {text && <div className="card answer">{text}</div>}
      {results.length > 0 && <div className="card"><b>Runs in this session:</b> {results.length}</div>}
      <MessageLog messages={messages} />
    </section>
  );
}
