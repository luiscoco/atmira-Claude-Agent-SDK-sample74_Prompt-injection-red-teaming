import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept12StreamingInput() {
  return (
    <section>
      <h2>12 · Streaming input mode</h2>
      <p className="lead">
        When <code>prompt</code> is an <code>AsyncIterable&lt;SDKUserMessage&gt;</code> instead of a string, one{" "}
        <code>query()</code> is a <b>live session</b>. It takes many turns, accepts messages while it is busy, and can be
        changed while it runs with <code>setModel()</code>, <code>setPermissionMode()</code> and other control requests.
      </p>
      <LiveSession />
      <hr />
      <PromptStyles />
    </section>
  );
}

type Entry = { kind: "control"; data: any } | { kind: "message"; data: any };
type Image = { media_type: string; data: string; name: string; url: string };

async function post(route: string, body: object) {
  const res = await fetch(`/api/c12/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json.result;
}

// ---------------------------------------------------------------------------------------------
// Parts A and B: one live session
// ---------------------------------------------------------------------------------------------

const presets = [
  { label: "Long answer", text: "Write a numbered list of 30 fun facts about octopuses, one short line each." },
  { label: "Redirect", text: "Stop. Instead, just say BANANA." },
  { label: "Create a file", text: "Create hello.txt containing the word hi. Do not ask, just do it." },
  { label: "Which model?", text: "Which model are you? One line." },
  { label: "Memory", text: "List every message I have sent you in this conversation, one short line each." },
  { label: "Describe image", text: "Describe this image in one sentence." },
];

const modes = ["default", "acceptEdits", "plan", "dontAsk"] as const;
const fallbackModels = ["claude-haiku-4-5-20251001", "claude-sonnet-5"];

function LiveSession() {
  const [startMode, setStartMode] = useState<string>("default");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [text, setText] = useState(presets[0].text);
  const [priority, setPriority] = useState("");
  const [image, setImage] = useState<Image | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [model, setModel] = useState(fallbackModels[1]);
  const [mode, setMode] = useState<string>("acceptEdits");

  async function start() {
    setLog([]);
    setError(null);
    setModels([]);
    setOpen(true);
    try {
      await streamPost("/api/c12/session", { permissionMode: startMode }, (event, data) => {
        if (event === "session") setSessionId(data.id);
        if (event === "models") setModels(data);
        if (event === "control") setLog((prev) => [...prev, { kind: "control", data }]);
        if (event === "message") setLog((prev) => [...prev, { kind: "message", data }]);
        if (event === "error") setError(data.message);
      });
    } finally {
      setOpen(false);
      setSessionId(null);
    }
  }

  async function run(route: string, body: object = {}) {
    try {
      setError(null);
      await post(route, { id: sessionId, ...body });
    } catch (err) {
      setError(String(err));
    }
  }

  async function send() {
    const clientId = crypto.randomUUID();
    if (image) setPreviews((prev) => ({ ...prev, [clientId]: image.url }));
    await run("send", {
      text,
      priority: priority || undefined,
      clientId,
      ...(image && { image: { media_type: image.media_type, data: image.data }, imageName: image.name }),
    });
    setImage(null);
  }

  function pickImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 5_000_000) return setError("Pick an image under 5 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result); // data:image/png;base64,....
      setImage({ media_type: file.type, data: url.split(",")[1], name: file.name, url });
    };
    reader.readAsDataURL(file);
  }

  // Derived from the stream: turns, queue, and what the latest system messages say.
  const messages = log.filter((e) => e.kind === "message").map((e) => e.data);
  const pushed = log.filter((e) => e.kind === "control" && e.data.method === "push user message").length;
  const results = messages.filter((m) => m.type === "result");
  const busy = open && pushed > results.length;
  const waiting = Math.max(0, pushed - results.length - 1);
  const inits = messages.filter((m) => m.type === "system" && m.subtype === "init");
  const lastInit = inits.at(-1);
  const lastMode = messages.filter((m) => m.type === "system" && (m.subtype === "init" || m.subtype === "status") && m.permissionMode).at(-1);
  const modelChoices: string[] = models.length ? [...fallbackModels, ...models.map((m) => m.value)] : fallbackModels;

  return (
    <>
      <h3>A · One query(), many turns</h3>
      <p className="hint">
        Start a session, then send messages. Each one is a new turn in the same process. You can send while the agent is
        still answering: the message waits in the queue, unless you send it with <code>priority: "now"</code>.
      </p>
      <div className="row">
        <label className="check">
          <code>permissionMode</code> at start
          <select value={startMode} onChange={(e) => setStartMode(e.target.value)} disabled={open} style={{ width: "auto", margin: 0 }}>
            {modes.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={start} disabled={open}>
          {open ? "Session open" : "Start session"}
        </button>
        <button onClick={() => run("end")} disabled={!sessionId}>
          Close input (end session)
        </button>
      </div>

      {open && (
        <div className="card">
          <b>Session</b> <code>{lastInit?.session_id ?? "starting…"}</code>
          <div className="hint" style={{ margin: 0 }}>
            {pushed} message(s) sent · {results.length} result(s) · {inits.length} <code>system/init</code> (one per turn, same
            session_id, same process) · {busy ? <b>turn running</b> : "idle"}
            {waiting > 0 && <> · <b>{waiting} waiting in the queue</b></>} · model <code>{lastInit?.model ?? "?"}</code> · permissionMode{" "}
            <code>{lastMode?.permissionMode ?? "?"}</code> · session total ${(results.at(-1)?.total_cost_usd ?? 0).toFixed(4)}
          </div>
        </div>
      )}

      <div className="scenarios">
        {presets.map((p) => (
          <button key={p.label} onClick={() => setText(p.text)}>
            {p.label}
          </button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="row">
        <label className="check">
          <code>priority</code>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: "auto", margin: 0 }}>
            <option value="">(not set)</option>
            <option value="now">now</option>
            <option value="next">next</option>
            <option value="later">later</option>
          </select>
        </label>
        <label className="check">
          image
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(e.target.files?.[0])} />
        </label>
        {image && <img className="thumb" src={image.url} alt={image.name} />}
        <button className="primary" onClick={send} disabled={!sessionId || !text.trim()}>
          {busy ? "Send (while busy)" : "Send"}
        </button>
      </div>

      <h3>B · Change the session while it is alive</h3>
      <p className="hint">
        Control requests go to the running process. Try: <i>Create a file</i> in <code>default</code> mode (denied, there is no{" "}
        <code>canUseTool</code>), then switch to <code>acceptEdits</code> and ask again. Or switch the model and ask{" "}
        <i>Which model?</i>. The model list comes from <code>q.supportedModels()</code>.
      </p>
      <div className="row">
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: "auto", margin: 0 }}>
          {[...new Set(modelChoices)].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button onClick={() => run("model", { model })} disabled={!sessionId}>
          await q.setModel()
        </button>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "auto", margin: 0 }}>
          {modes.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button onClick={() => run("permission-mode", { mode })} disabled={!sessionId}>
          await q.setPermissionMode()
        </button>
        <button onClick={() => run("context")} disabled={!sessionId}>
          await q.getContextUsage()
        </button>
      </div>

      <Timeline log={log} previews={previews} />

      {error && (
        <div className="card warn">
          <b>Error</b> — <code>{error}</code>
        </div>
      )}
      {!open && log.length > 0 && !error && <div className="card">The session ended (the input iterable was closed).</div>}

      <MessageLog messages={messages.filter((m) => m.type !== "stream_event" && m.subtype !== "thinking_tokens")} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part C: generator vs. string
// ---------------------------------------------------------------------------------------------

function PromptStyles() {
  const [log, setLog] = useState<Entry[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  async function run(variant: "generator" | "string") {
    setLog([]);
    setRunning(variant);
    try {
      await streamPost("/api/c12/script", { variant }, (event, data) => {
        if (event === "control") setLog((prev) => [...prev, { kind: "control", data }]);
        if (event === "message") setLog((prev) => [...prev, { kind: "message", data }]);
        if (event === "error") setLog((prev) => [...prev, { kind: "control", data: { method: "for await threw", error: data.message } }]);
      });
    } finally {
      setRunning(null);
    }
  }

  return (
    <>
      <h3>C · Two ways to write the prompt</h3>
      <p className="hint">
        Both send the same first message. The generator yields three scripted messages, and waits for each result before it
        yields the next. The string sends one message and closes the input, so the session ends after one turn.
      </p>
      <div className="row">
        <button className="primary" onClick={() => run("generator")} disabled={!!running}>
          {running === "generator" ? "Running…" : "prompt: async function* (3 turns)"}
        </button>
        <button className="primary" onClick={() => run("string")} disabled={!!running}>
          {running === "string" ? "Running…" : 'prompt: "a string"'}
        </button>
      </div>
      <Timeline log={log} previews={{}} />
      <MessageLog messages={log.filter((e) => e.kind === "message").map((e) => e.data).filter((m) => m.subtype !== "thinking_tokens")} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Timeline: user messages, streamed text, tool calls, control requests and results
// ---------------------------------------------------------------------------------------------

function Timeline({ log, previews }: { log: Entry[]; previews: Record<string, string> }) {
  // `text` items are the assistant's answer, built from text_delta stream events; the rest are ready-made nodes.
  type Item = { key: number; className: string; text?: string; node?: React.ReactNode };
  const items: Item[] = [];
  let current: Item | null = null;
  let previousTotal = 0; // total_cost_usd is a running total for the session, so a turn costs the difference
  const add = (item: Item) => {
    current = null;
    items.push(item);
  };

  log.forEach((e, key) => {
    const d = e.data;
    if (e.kind === "control") {
      if (d.method === "push user message" || d.method === "yield user message") {
        add({
          key,
          className: "card",
          node: (
            <>
              <b>You</b> <span className="subtype">{d.method} at {d.ms} ms</span>
              {d.priority && <span className="subtype">priority "{d.priority}"</span>}
              <div>{d.text}</div>
              {d.image && (previews[d.clientId] ? <img className="thumb" src={previews[d.clientId]} alt={d.image} /> : <div className="subtype">+ image {d.image}</div>)}
            </>
          ),
        });
      } else {
        add({
          key,
          className: `delegation ${d.error ? "warn" : ""}`,
          node: (
            <>
              <code>{d.method}</code> <span className="subtype">{d.ms !== undefined && `at ${d.ms} ms`}</span>
              {d.error && <div className="snippet">→ {d.error}</div>}
              {d.usage && <ContextUsage usage={d.usage} />}
            </>
          ),
        });
      }
    } else if (d.type === "stream_event" && d.event.type === "content_block_delta" && d.event.delta.type === "text_delta") {
      if (!current) items.push((current = { key, className: "card answer", text: "" }));
      current.text += d.event.delta.text;
    } else if (d.type === "assistant") {
      for (const b of d.message.content) {
        if (b.type === "tool_use") add({ key, className: "tool-call", node: <><code>{b.name}</code> <span className="snippet">{JSON.stringify(b.input)}</span></> });
      }
    } else if (d.type === "user") {
      const content = d.message.content;
      if (typeof content === "string" && content.includes("local-command-stdout")) {
        add({ key, className: "hint", node: <>Echo from the CLI: <code>{content.replace(/<\/?local-command-stdout>/g, "")}</code></> });
      }
      if (Array.isArray(content)) {
        for (const b of content.filter((b: any) => b.type === "tool_result")) {
          const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          add({ key, className: `tool-call ${b.is_error ? "denied" : ""}`, node: <span className="snippet">→ {out.slice(0, 300)}</span> });
        }
      }
    } else if (d.type === "system" && d.subtype === "init") {
      add({ key, className: "hint", node: <>system/init · model <code>{d.model}</code> · permissionMode <code>{d.permissionMode}</code> · session <code>{d.session_id.slice(0, 8)}</code></> });
    } else if (d.type === "system" && d.subtype === "status" && d.permissionMode) {
      add({ key, className: "hint", node: <>system/status · permissionMode is now <code>{d.permissionMode}</code></> });
    } else if (d.type === "result") {
      const turnCost = d.total_cost_usd - previousTotal;
      previousTotal = d.total_cost_usd;
      add({
        key,
        className: `card ${d.subtype === "success" ? "" : "warn"}`,
        node: (
          <>
            <b>result/{d.subtype}</b> · {d.duration_ms} ms · this turn ${turnCost.toFixed(4)} · session total ${d.total_cost_usd.toFixed(4)}
            {d.permission_denials?.length > 0 && <span className="subtype">{d.permission_denials.length} permission denial(s)</span>}
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

function ContextUsage({ usage }: { usage: any }) {
  return (
    <div>
      <div className="meter">
        <div style={{ width: `${Math.max(usage.percentage, 1)}%` }} />
      </div>
      <span className="subtype">
        {usage.totalTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens ({usage.percentage}%) ·{" "}
        {usage.categories.map((c: any) => `${c.name} ${c.tokens.toLocaleString()}`).join(" · ")}
      </span>
    </div>
  );
}
