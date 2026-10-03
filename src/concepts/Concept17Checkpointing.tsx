import { useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept17Checkpointing() {
  return (
    <section>
      <h2>17 · File checkpointing &amp; rewind</h2>
      <p className="lead">
        With <code>enableFileCheckpointing: true</code>, Claude Code backs up a file before <code>Write</code> or{" "}
        <code>Edit</code> changes it, with one checkpoint per user message. <code>q.rewindFiles(userMessageUuid)</code>{" "}
        puts the files back as they were when that message arrived. Every run here uses Haiku in{" "}
        <code>checkpoint-lab/</code>, which starts with <code>plan.md</code> and <code>config.json</code>.
      </p>
      <LivePart />
      <hr />
      <AfterPart />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared: the folder on disk, the rewind result, and a compact timeline
// ---------------------------------------------------------------------------------------------

type FileEntry = { name: string; content: string };
type Rewind = { turn?: number; dryRun: boolean; ms?: number; result?: any; error?: string; via?: string };
type Entry = { kind: "message"; data: any } | { kind: "checkpoint"; data: any } | { kind: "rewind"; data: Rewind } | { kind: "control"; data: any };

async function post(url: string, body: object) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

function Files({ files, title }: { files: FileEntry[]; title: string }) {
  return (
    <div className="card">
      <b>{title}</b> <span className="hint">what is on disk right now</span>
      <div className="compare-grid">
        {files.map((f) => (
          <div key={f.name}>
            <code>{f.name}</code>
            <pre>{f.content}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function RewindLine({ r }: { r: Rewind }) {
  const call = `${r.via ?? "q"}.rewindFiles(${r.turn ? `uuid of message #${r.turn}` : "uuid"}${r.dryRun ? ", { dryRun: true }" : ""})`;
  const res = r.result;
  return (
    <div className={`delegation ${r.error || res?.canRewind === false ? "warn" : ""}`}>
      <code>{call}</code> {r.ms !== undefined && <span className="subtype">{r.ms} ms</span>}
      {r.error && <div className="snippet">threw → {r.error}</div>}
      {res && res.canRewind === false && <div className="snippet">canRewind: false · {res.error}</div>}
      {res?.canRewind && r.dryRun && (
        <div className="snippet">
          would change {res.filesChanged?.length ?? 0} file(s): {res.filesChanged?.join(", ") || "none"} · +{res.insertions} −{res.deletions}
        </div>
      )}
      {res?.canRewind && !r.dryRun && <div className="snippet">rewound · skippedLinks: {res.skippedLinks ?? 0} (a real rewind does not list the files)</div>}
    </div>
  );
}

function Timeline({ log, actions }: { log: Entry[]; actions?: (checkpoint: any) => React.ReactNode }) {
  let previousTotal = 0;
  return (
    <>
      {log.map((e, key) => {
        const d = e.data;
        if (e.kind === "checkpoint")
          return (
            <div key={key} className="card">
              <b>You #{d.turn}</b> <span className="subtype">checkpoint {d.uuid.slice(0, 8)}</span>
              <div>{d.text}</div>
              {actions && <div className="row">{actions(d)}</div>}
            </div>
          );
        if (e.kind === "rewind") return <RewindLine key={key} r={d} />;
        if (e.kind === "control")
          return (
            <div key={key} className={`delegation ${d.error ? "warn" : ""}`}>
              <code>{d.method}</code>
              {d.error && <div className="snippet">threw → {d.error}</div>}
            </div>
          );
        if (d.type === "assistant")
          return (
            <div key={key}>
              {d.message.content.map((b: any, i: number) =>
                b.type === "text" ? (
                  <div key={i} className="card answer thin">
                    {b.text}
                  </div>
                ) : b.type === "tool_use" ? (
                  <div key={i} className="tool-call">
                    <span className="tag">{b.name}</span> <code>{b.input.command ?? b.input.file_path?.split(/[\\/]/).pop() ?? JSON.stringify(b.input)}</code>
                    {(b.name === "Write" || b.name === "Edit") && <span className="subtype">tracked</span>}
                    {b.name === "Bash" && <span className="subtype bad">not tracked</span>}
                  </div>
                ) : null,
              )}
            </div>
          );
        if (d.type === "user" && d.isReplay) return <div key={key} className="hint">echo of your message · uuid <code>{d.uuid.slice(0, 8)}</code></div>;
        if (d.type === "result") {
          const turnCost = d.total_cost_usd - previousTotal;
          previousTotal = d.total_cost_usd;
          return (
            <div key={key} className="hint">
              <span className={`subtype ${d.subtype === "success" ? "" : "bad"}`}>result/{d.subtype}</span> · this turn ${turnCost.toFixed(4)}
              {d.permission_denials?.length > 0 && <> · {d.permission_denials.length} permission denial(s)</>}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

const rawMessages = (log: Entry[]) => log.filter((e) => e.kind === "message").map((e) => e.data).filter((m) => m.subtype !== "thinking_tokens");

// ---------------------------------------------------------------------------------------------
// Part A: a live session, one checkpoint per message
// ---------------------------------------------------------------------------------------------

const presets = [
  { label: "1. Edit plan.md", text: "Use the Edit tool to add the line '- update the docs' at the end of plan.md. Reply with one word: done." },
  {
    label: "2. Version + changelog",
    text: "Use the Write tool to create changelog.md with the line: 1.1.0 - docs updated. Then use the Edit tool to change the version in config.json to 1.1.0. Reply with one word: done.",
  },
  {
    label: "3. Change it with Bash",
    text: "Run exactly this Bash command: echo 'written by bash' > bash-note.txt . Then run exactly this Bash command: sed -i 's/write the tests/WRITE THE TESTS/' plan.md . Do not use any other tool. Reply with one word: done.",
  },
  { label: "Ask from memory", text: "Without using any tool, from memory only: what is the version in config.json, and which files exist? One line." },
  { label: "Read the files again", text: "Read config.json and plan.md and say what they contain now. One line each." },
];

function LivePart() {
  const [checkpointing, setCheckpointing] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [options, setOptions] = useState<any>();
  const [text, setText] = useState(presets[0].text);
  const [error, setError] = useState<string | null>(null);
  const [rewinding, setRewinding] = useState(false);

  const add = (entry: Entry) => setLog((prev) => [...prev, entry]);

  async function start() {
    setLog([]);
    setFiles([]);
    setError(null);
    setOpen(true);
    try {
      await streamPost("/api/c17/session", { checkpointing }, (event, data) => {
        if (event === "session") setSessionId(data.id);
        if (event === "options") setOptions(data);
        if (event === "files") setFiles(data);
        if (event === "checkpoint") add({ kind: "checkpoint", data });
        if (event === "message") add({ kind: "message", data });
        if (event === "error") setError(data.message);
      });
    } finally {
      setOpen(false);
      setSessionId(null);
    }
  }

  async function send() {
    try {
      setError(null);
      await post("/api/c17/send", { id: sessionId, text });
    } catch (err) {
      setError(String(err));
    }
  }

  async function rewind(checkpoint: any, dryRun: boolean) {
    setRewinding(true);
    try {
      const { result } = await post("/api/c17/rewind", { id: sessionId, uuid: checkpoint.uuid, dryRun });
      add({ kind: "rewind", data: { turn: checkpoint.turn, dryRun, ...result } });
    } catch (err) {
      add({ kind: "rewind", data: { turn: checkpoint.turn, dryRun, error: String(err).replace(/^Error: /, "") } });
    } finally {
      setRewinding(false);
    }
  }

  const sent = log.filter((e) => e.kind === "checkpoint").length;
  const results = log.filter((e) => e.kind === "message" && e.data.type === "result").length;
  const busy = open && sent > results;

  return (
    <>
      <h3>A · A live session: one checkpoint per message</h3>
      <p className="hint">
        Start a session and send the numbered presets in order. The server gives each message its own <code>uuid</code>, and
        that uuid is the checkpoint. Use <b>Preview</b> (<code>dryRun</code>, nothing changes) and <b>Rewind</b> on any
        message, and watch the files: they go back to how they were <b>before</b> that message ran. You can also rewind
        forward to a later message. Then try <i>Ask from memory</i>: the files went back, but the conversation did not.
      </p>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={checkpointing} onChange={() => setCheckpointing(!checkpointing)} disabled={open} />
          <code>enableFileCheckpointing</code>
        </label>
        <button className="primary" onClick={start} disabled={open}>
          {open ? "Session open" : "Start session (resets checkpoint-lab/live)"}
        </button>
        <button onClick={() => post("/api/c17/end", { id: sessionId }).catch((err) => setError(String(err)))} disabled={!sessionId}>
          Close input (end session)
        </button>
      </div>

      <div className="scenarios">
        {presets.map((p) => (
          <button key={p.label} onClick={() => setText(p.text)}>
            {p.label}
          </button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="row">
        <button className="primary" onClick={send} disabled={!sessionId || busy || !text.trim()}>
          {busy ? "Turn running…" : "Send"}
        </button>
      </div>

      {files.length > 0 && <Files files={files} title="checkpoint-lab/live" />}

      <Timeline
        log={log}
        actions={(c) => (
          <>
            <button onClick={() => rewind(c, true)} disabled={!sessionId || busy || rewinding}>
              Preview (dryRun)
            </button>
            <button onClick={() => rewind(c, false)} disabled={!sessionId || busy || rewinding}>
              Rewind to before this message
            </button>
          </>
        )}
      />

      {error && (
        <div className="card warn">
          <b>Error</b> — <code>{error}</code>
        </div>
      )}
      {!open && log.length > 0 && !error && <div className="card">The session ended. Its Query is closed, so these buttons no longer work (see Part B).</div>}

      {(options || log.length > 0) && (
        <details>
          <summary className="hint">options sent to query() and raw messages</summary>
          {options && <pre>{JSON.stringify(options, null, 2)}</pre>}
          <MessageLog messages={rawMessages(log)} />
        </details>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: rewind after the query has ended
// ---------------------------------------------------------------------------------------------

function AfterPart() {
  const [prompt, setPrompt] = useState(
    "Use the Edit tool to change the version in config.json to 2.0.0, and use the Write tool to create release.md with the line: 2.0.0 released. Reply with one word: done.",
  );
  const [log, setLog] = useState<Entry[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [checkpoint, setCheckpoint] = useState<{ uuid: string; sessionId: string }>();
  const [running, setRunning] = useState(false);
  const [rewinding, setRewinding] = useState(false);

  const add = (entry: Entry) => setLog((prev) => [...prev, entry]);

  async function run() {
    setLog([]);
    setFiles([]);
    setCheckpoint(undefined);
    setRunning(true);
    try {
      await streamPost("/api/c17/oneshot", { prompt }, (event, data) => {
        if (event === "files") setFiles(data);
        if (event === "checkpoint") setCheckpoint(data);
        if (event === "control") add({ kind: "control", data });
        if (event === "message") add({ kind: "message", data });
        if (event === "error") add({ kind: "control", data: { method: "for await threw", error: data.message } });
      });
    } finally {
      setRunning(false);
    }
  }

  async function resumeRewind(dryRun: boolean) {
    setRewinding(true);
    try {
      const res = await post("/api/c17/resume-rewind", { ...checkpoint, dryRun });
      add({ kind: "rewind", data: { dryRun, ms: res.ms, result: res.result, via: "query({ resume }) → q2" } });
      setFiles(res.files);
    } catch (err) {
      add({ kind: "rewind", data: { dryRun, error: String(err).replace(/^Error: /, ""), via: "query({ resume }) → q2" } });
    } finally {
      setRewinding(false);
    }
  }

  return (
    <>
      <h3>B · After the query has ended</h3>
      <p className="hint">
        A string prompt closes the query after its <code>result</code>, so there is no live <code>Query</code> to call{" "}
        <code>rewindFiles()</code> on. The uuid comes from <code>extraArgs: {'{ "replay-user-messages": null }'}</code>,
        which echoes your message back. To rewind later, the server <b>resumes</b> the session with an input that sends
        nothing (no turn, no model call) and calls <code>rewindFiles()</code> on the new query.
      </p>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="row">
        <button className="primary" onClick={run} disabled={running || rewinding || !prompt.trim()}>
          {running ? "Running…" : "Run query() with a string prompt (resets checkpoint-lab/oneshot)"}
        </button>
        <button onClick={() => resumeRewind(true)} disabled={!checkpoint || running || rewinding}>
          Preview via resume (dryRun)
        </button>
        <button onClick={() => resumeRewind(false)} disabled={!checkpoint || running || rewinding}>
          Rewind via resume
        </button>
      </div>
      {checkpoint && (
        <div className="hint">
          echoed user message uuid <code>{checkpoint.uuid}</code> · session <code>{checkpoint.sessionId}</code>
        </div>
      )}
      {files.length > 0 && <Files files={files} title="checkpoint-lab/oneshot" />}
      <Timeline log={log} />
      <MessageLog messages={rawMessages(log)} />
    </>
  );
}
