import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const models = [
  { id: "", label: "(omit: CLI default)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast, cheap)" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
];

export function Concept02Options() {
  const [prompt, setPrompt] = useState("Write a four-line poem about TypeScript.");
  const [model, setModel] = useState("claude-haiku-4-5-20251001");
  const [systemPromptMode, setSystemPromptMode] = useState<"default" | "custom" | "preset">("custom");
  const [systemPrompt, setSystemPrompt] = useState("You are a pirate. Always answer like a pirate.");
  const [maxTurns, setMaxTurns] = useState("1");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("");
  const [includePartialMessages, setIncludePartialMessages] = useState(true);
  const [hideStreamEvents, setHideStreamEvents] = useState(true);

  const [sentOptions, setSentOptions] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setMessages([]);
    setSentOptions(null);
    setError(null);
    setRunning(true);
    const body = {
      prompt,
      model: model || undefined,
      systemPromptMode,
      systemPrompt,
      maxTurns: Number(maxTurns) || undefined,
      maxBudgetUsd: Number(maxBudgetUsd) || undefined,
      includePartialMessages,
    };
    try {
      await streamPost("/api/c2/query", body, (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "message") setMessages((prev) => [...prev, data]);
        // Hitting a limit emits an error result AND makes the iterator throw, so show it rather than alert().
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
    }
  }

  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
  const streamEvents = messages.filter((m) => m.type === "stream_event");

  // With includePartialMessages, text arrives token by token as content_block_delta events.
  const liveText = streamEvents
    .map((m) => m.event)
    .filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta")
    .map((e) => e.delta.text)
    .join("");
  // The complete assistant message still arrives at the end, whether or not partials are on.
  const finalText = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  const text = finalText || liveText;

  return (
    <section>
      <h2>2 · Options</h2>
      <p className="lead">
        The <code>options</code> object controls <b>which model</b> runs, <b>how it behaves</b> (
        <code>systemPrompt</code>), <b>when it must stop</b> (<code>maxTurns</code>, <code>maxBudgetUsd</code>) and{" "}
        <b>how much of the stream you see</b> (<code>includePartialMessages</code>).
      </p>

      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />

      <div className="form-grid">
        <label>
          <code>model</code>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <code>systemPrompt</code>
          <select value={systemPromptMode} onChange={(e) => setSystemPromptMode(e.target.value as any)}>
            <option value="default">(omit: SDK default)</option>
            <option value="custom">string: replaces the system prompt</option>
            <option value="preset">preset "claude_code" + append</option>
          </select>
        </label>
        <label>
          <code>maxTurns</code>
          <input type="number" min={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="(omit)" />
        </label>
        <label>
          <code>maxBudgetUsd</code>
          <input
            type="number"
            min={0}
            step={0.0001}
            value={maxBudgetUsd}
            onChange={(e) => setMaxBudgetUsd(e.target.value)}
            placeholder="(omit) try 0.0001"
          />
        </label>
      </div>

      {systemPromptMode !== "default" && (
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={2}
          placeholder={systemPromptMode === "preset" ? "Text appended to the Claude Code system prompt" : "Your system prompt"}
        />
      )}

      <label className="check">
        <input type="checkbox" checked={includePartialMessages} onChange={(e) => setIncludePartialMessages(e.target.checked)} />
        <code>includePartialMessages</code>: stream the reply token by token
      </label>

      <button onClick={run} disabled={running}>
        {running ? "Running…" : "Run query() with options"}
      </button>

      {sentOptions && (
        <div className="card">
          <b>options sent to query()</b>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </div>
      )}
      {init && (
        <div className="card">
          <b>system/init</b> — model actually used: <code>{init.model}</code>
        </div>
      )}
      {text && (
        <div className="card answer">
          {text}
          {!finalText && <span className="cursor">▌</span>}
        </div>
      )}
      {includePartialMessages && streamEvents.length > 0 && (
        <div className="card">
          <b>stream_event</b> messages received: {streamEvents.length}
        </div>
      )}
      {result && (
        <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)} · in {result.usage.input_tokens} / out {result.usage.output_tokens} tokens
          {result.subtype === "error_max_budget_usd" && <div>The run stopped because it went over <code>maxBudgetUsd</code>.</div>}
          {result.subtype === "error_max_turns" && <div>The run stopped because it reached <code>maxTurns</code>.</div>}
        </div>
      )}
      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
        </div>
      )}

      {messages.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={hideStreamEvents} onChange={(e) => setHideStreamEvents(e.target.checked)} />
          Hide <code>stream_event</code> messages in the raw log
        </label>
      )}
      <MessageLog messages={hideStreamEvents ? messages.filter((m) => m.type !== "stream_event") : messages} />
    </section>
  );
}
