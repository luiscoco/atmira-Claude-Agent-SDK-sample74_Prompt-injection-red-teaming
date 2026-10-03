import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept01Query() {
  const [prompt, setPrompt] = useState("Explain in two sentences what an AI agent is.");
  const [messages, setMessages] = useState<any[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setMessages([]);
    setRunning(true);
    try {
      await streamPost("/api/c1/query", { prompt }, (event, data) => {
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "error") alert(data.message);
      });
    } finally {
      setRunning(false);
    }
  }

  // Pull the interesting pieces out of the stream
  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  return (
    <section>
      <h2>1 · query() and the message stream</h2>
      <p className="lead">
        <code>query({"{ prompt, options }"})</code> returns an async iterable. Each item is an{" "}
        <code>SDKMessage</code>: <b>system/init</b> → <b>assistant</b> → <b>result</b>.
      </p>

      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
      <button onClick={run} disabled={running}>
        {running ? "Running…" : "Run query()"}
      </button>

      {init && (
        <div className="card">
          <b>system/init</b> — session <code>{init.session_id}</code>, model <code>{init.model}</code>,
          tools: {init.tools.length}, cwd <code>{init.cwd}</code>
        </div>
      )}
      {text && <div className="card answer">{text}</div>}
      {result && (
        <div className="card">
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)} · in {result.usage.input_tokens} / out{" "}
          {result.usage.output_tokens} tokens
        </div>
      )}

      <MessageLog messages={messages} />
    </section>
  );
}
