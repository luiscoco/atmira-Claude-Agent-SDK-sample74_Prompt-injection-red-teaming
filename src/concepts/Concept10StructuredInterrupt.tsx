import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept10StructuredInterrupt() {
  return (
    <section>
      <h2>10 · Structured output & interrupt</h2>
      <p className="lead">
        <b>Part A:</b> <code>outputFormat</code> makes the agent return JSON that matches your schema, in{" "}
        <code>result.structured_output</code>. <b>Part B:</b> stop a run while it is still going, with{" "}
        <code>q.interrupt()</code> (stops the turn, keeps the session) or <code>abortController.abort()</code> (kills the
        process).
      </p>
      <StructuredOutput />
      <hr />
      <Interrupt />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A: structured output
// ---------------------------------------------------------------------------------------------

const scenarios = [
  {
    id: "profile",
    label: "Extract a profile",
    prompt: "Ana García has been writing software for 7 years. She leads the platform team and codes mostly in TypeScript, Go and Rust.",
  },
  {
    id: "review",
    label: "Classify a review",
    prompt: "Review: The course was great and the samples really helped, but the audio in week 2 was hard to follow.",
  },
  { id: "tasks", label: "After a tool call (Read)", prompt: "Read data/tasks.json and summarise the tasks." },
  { id: "conflict", label: "Schema vs. facts", prompt: "Give me the first three prime numbers and their real sum. Never lie about the sum." },
] as const;

type ScenarioId = (typeof scenarios)[number]["id"];

function StructuredOutput() {
  const [schemaId, setSchemaId] = useState<ScenarioId>("profile");
  const [prompt, setPrompt] = useState<string>(scenarios[0].prompt);
  const [schemas, setSchemas] = useState<Record<string, unknown>>({});
  const [messages, setMessages] = useState<any[]>([]);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch("/api/c10/schemas").then((r) => r.json()).then(setSchemas);
  }, []);

  function pick(id: ScenarioId) {
    setSchemaId(id);
    setPrompt(scenarios.find((s) => s.id === id)!.prompt);
  }

  async function run() {
    setMessages([]);
    setValidation(null);
    setError(null);
    setRunning(true);
    try {
      await streamPost("/api/c10/structured", { prompt, schemaId }, (event, data) => {
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "validation") setValidation(data);
        if (event === "error") setError(data.message);
      });
    } finally {
      setRunning(false);
    }
  }

  const result = messages.find((m) => m.type === "result");

  // Every StructuredOutput call and what the CLI answered: "provided successfully" or a schema error (-> retry).
  const results = new Map<string, any>(
    messages
      .filter((m) => m.type === "user" && Array.isArray(m.message.content))
      .flatMap((m) => m.message.content)
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => [b.tool_use_id, b]),
  );
  const calls = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ ...b, result: results.get(b.id) }));

  return (
    <>
      <h3>A · outputFormat: JSON that matches a schema</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.id} className={s.id === schemaId ? "active" : ""} onClick={() => pick(s.id)} disabled={running}>
            {s.label}
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} disabled={running} />
      <details className="card">
        <summary>
          <code>outputFormat.schema</code> (made from a zod schema with <code>z.toJSONSchema()</code>)
        </summary>
        <pre>{JSON.stringify({ type: "json_schema", schema: schemas[schemaId] }, null, 2)}</pre>
      </details>
      <button className="primary" onClick={run} disabled={running || !prompt.trim()}>
        {running ? "Running…" : "Run query() with outputFormat"}
      </button>

      {calls.length > 0 && (
        <div className="card">
          <b>Tool calls</b> (the SDK added <code>StructuredOutput</code> for you)
          {calls.map((c) => (
            <div key={c.id} className={`tool-call ${c.result?.is_error ? "denied" : ""}`}>
              <code>{c.name}</code>
              <div className="snippet">{JSON.stringify(c.input)}</div>
              {c.result && <div className="snippet report">→ {typeof c.result.content === "string" ? c.result.content : JSON.stringify(c.result.content)}</div>}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className={`card ${result.subtype === "success" ? "" : "warn"}`}>
          <b>result/{result.subtype}</b> · terminal_reason <code>{String(result.terminal_reason)}</code> · {result.num_turns} turn(s) · $
          {result.total_cost_usd.toFixed(4)}
          <h4>
            <code>result.structured_output</code>
          </h4>
          <pre>{result.structured_output === undefined ? "undefined" : JSON.stringify(result.structured_output, null, 2)}</pre>
          {result.result && (
            <>
              <h4>
                <code>result.result</code> (the text answer)
              </h4>
              <div className="snippet">{result.result}</div>
            </>
          )}
        </div>
      )}

      {validation && (
        <div className={`card ${validation.success ? "answer" : "warn"}`}>
          <b>Server-side zod safeParse():</b> {validation.success ? "✓ valid and typed" : "✗ not valid"}
          {!validation.success && <pre>{JSON.stringify(validation.issues, null, 2)}</pre>}
        </div>
      )}
      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
        </div>
      )}
      <MessageLog messages={messages} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: interrupt() vs abort()
// ---------------------------------------------------------------------------------------------

type Entry = { kind: "control"; data: any } | { kind: "message"; data: any };

function Interrupt() {
  const [prompt, setPrompt] = useState("Write a numbered list of 40 fun facts about octopuses, one short line each.");
  const [followUp, setFollowUp] = useState("What was the last fact you wrote before I stopped you? Quote it.");
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function start() {
    setLog([]);
    setError(null);
    setOpen(true);
    try {
      await streamPost("/api/c10/run", { prompt }, (event, data) => {
        if (event === "run") setRunId(data.id);
        if (event === "control") setLog((prev) => [...prev, { kind: "control", data }]);
        if (event === "message") setLog((prev) => [...prev, { kind: "message", data }]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setOpen(false);
      setRunId(null);
    }
  }

  async function control(route: "interrupt" | "abort" | "send" | "end", extra: object = {}) {
    const res = await fetch(`/api/c10/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: runId, ...extra }),
    });
    if (!res.ok) setError((await res.json()).error);
  }

  // A turn is running from each user message until its result message.
  const sent = log.filter((e) => e.kind === "control" && e.data.method === "push user message").length;
  const finished = log.filter((e) => e.kind === "message" && e.data.type === "result").length;
  const turnRunning = open && sent > finished;

  const messages = log.filter((e) => e.kind === "message").map((e) => e.data);

  return (
    <>
      <h3>B · Stopping a run: interrupt() vs abort()</h3>
      <p className="hint">
        The prompt is an <code>AsyncIterable&lt;SDKUserMessage&gt;</code> (streaming input mode), so the session stays open
        after each turn. Start a long answer, then stop it with each method and compare what happens next.
      </p>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} disabled={open} />
      <div className="row">
        <button className="primary" onClick={start} disabled={open || !prompt.trim()}>
          {open ? "Session open" : "Start run"}
        </button>
        <button onClick={() => control("interrupt")} disabled={!runId || !turnRunning}>
          ⏸ await q.interrupt()
        </button>
        <button onClick={() => control("abort")} disabled={!runId}>
          ⏹ abortController.abort()
        </button>
      </div>

      {runId && !turnRunning && (
        <div className="card permission">
          <b>The turn ended, but the session is still open.</b> Send another message to the same session, or close the input.
          <textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} rows={2} />
          <div className="row">
            <button className="primary" onClick={() => control("send", { text: followUp })} disabled={!followUp.trim()}>
              Send follow-up
            </button>
            <button onClick={() => control("end")}>Close input (end session)</button>
          </div>
        </div>
      )}

      <Timeline log={log} />

      {error && (
        <div className="card warn">
          <b>for await threw</b> — <code>{error}</code>
          {error.includes("error result") && (
            <div className="hint">
              The input closed while the last result was an error (the interrupted turn), so the SDK throws when the loop ends.
            </div>
          )}
          {error.includes("aborted") && <div className="hint">abort() killed the Claude Code process. The session is gone.</div>}
        </div>
      )}
      {!open && log.length > 0 && !error && <div className="card">The loop ended normally (the input was closed after a successful turn).</div>}

      <MessageLog messages={messages.filter((m) => m.type !== "stream_event")} />
    </>
  );
}

/** Turns the log into a readable conversation: user messages, growing assistant text, control calls and results. */
function Timeline({ log }: { log: Entry[] }) {
  // `text` items are the assistant's answer, built from text_delta stream events; the rest are ready-made nodes.
  type Item = { key: number; className: string; text?: string; node?: React.ReactNode };
  const items: Item[] = [];
  let current: Item | null = null;

  log.forEach((e, key) => {
    const d = e.data;
    if (e.kind === "control") {
      current = null;
      if (d.method === "push user message") {
        items.push({ key, className: "card", node: <><b>You</b> <span className="subtype">at {d.ms} ms</span><div>{d.text}</div></> });
      } else {
        const receipt = d.receipt && <span className="subtype">receipt {JSON.stringify(d.receipt)}</span>;
        items.push({ key, className: "delegation", node: <><code>{d.method}</code> <span className="subtype">at {d.ms} ms</span>{receipt}</> });
      }
    } else if (d.type === "stream_event" && d.event.type === "content_block_delta" && d.event.delta.type === "text_delta") {
      if (!current) items.push((current = { key, className: "card answer", text: "" }));
      current.text += d.event.delta.text;
    } else if (d.type === "user" && Array.isArray(d.message.content)) {
      const note = d.message.content.find((b: any) => b.type === "text")?.text;
      if (note) items.push({ key, className: "hint", node: <>Injected by the SDK: <code>{note}</code></> });
    } else if (d.type === "result") {
      current = null;
      items.push({
        key,
        className: `card ${d.subtype === "success" ? "" : "warn"}`,
        node: (
          <>
            <b>result/{d.subtype}</b> · terminal_reason <code>{String(d.terminal_reason)}</code> · {d.duration_ms} ms · $
            {d.total_cost_usd.toFixed(4)}
          </>
        ),
      });
    }
  });

  return (
    <>
      {items.map((i) => (
        <div key={i.key} className={i.className}>
          {i.text ?? i.node}
        </div>
      ))}
    </>
  );
}
