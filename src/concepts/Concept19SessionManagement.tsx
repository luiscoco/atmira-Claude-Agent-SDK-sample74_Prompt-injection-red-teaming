import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  tag?: string;
  createdAt?: number;
};
type Turn = { prompt: string; promptUuid: string; answer: string; lastUuid: string; entries: number };
type Detail = { info?: SessionInfo; turns: Turn[]; file: string; entries: { type: string; uuid: string; text: string }[] };
type Lab = { lab: string; transcripts: string; transcriptsExist: boolean; sessions: SessionInfo[] };
type Call = { call: string; ms?: number; result?: unknown; error?: string };

const short = (id?: string) => (id ? id.slice(0, 8) : "—");
const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "—");

async function post(url: string, body: object = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

async function get(url: string) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export function Concept19SessionManagement() {
  const [lab, setLab] = useState<Lab>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [at, setAt] = useState<Turn>();
  const [mode, setMode] = useState<Mode>("new");
  const [calls, setCalls] = useState<Call[]>([]);
  const [loadError, setLoadError] = useState<string>();

  // With nothing selected, the newest session is selected, so the options that need one work at once.
  async function refresh(select = selected) {
    let next: Lab;
    try {
      next = await get("/api/c19/sessions");
      setLoadError(undefined);
    } catch (err) {
      setLoadError(`${String(err).replace(/^Error: /, "")} — is this sample's server running on port 3001?`);
      return;
    }
    setLab(next);
    const still = next.sessions.some((s) => s.sessionId === select) ? select : next.sessions[0]?.sessionId;
    setSelected(still);
    if (still) setDetail((await get(`/api/c19/sessions/${still}`)).result);
    else setDetail(undefined);
    if (still !== selected) setAt(undefined);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function select(id: string) {
    setAt(undefined);
    await refresh(id);
  }

  /** Runs one of the Part B functions and logs the call. */
  async function manage(call: string, url: string, body?: object, select?: (result: any) => string | undefined) {
    try {
      const res = await post(url, body);
      setCalls((prev) => [{ call, ms: res.ms, result: res.result }, ...prev]);
      await refresh(select ? select(res.result) : selected);
    } catch (err) {
      setCalls((prev) => [{ call, error: String(err).replace(/^Error: /, "") }, ...prev]);
    }
  }

  return (
    <section>
      <h2>19 · Session management</h2>
      <p className="lead">
        Every <code>query()</code> writes its conversation to a transcript file, and that file is the session. Part A shows
        the options that decide <b>which</b> session the next turn goes to. Part B reads and changes the transcripts with the
        session functions, which do not start Claude Code or call the model. Every run uses Haiku, no tools, one turn, and{" "}
        <code>cwd: session-lab/</code>, so <code>listSessions({"{ dir }"})</code> only sees the sessions of this lab.
      </p>
      {loadError && (
        <div className="card warn">
          <b>Could not list the sessions</b> — <code>{loadError}</code>
        </div>
      )}
      <TurnPart
        mode={mode}
        setMode={setMode}
        sessionCount={lab?.sessions.length ?? 0}
        selected={selected}
        at={at}
        onWritten={(id) => refresh(id ?? selected)}
      />
      <hr />
      <SessionsPart
        lab={lab}
        selected={selected}
        detail={detail}
        at={at}
        calls={calls}
        onSelect={select}
        onRefresh={() => refresh()}
        onPickTurn={(turn) => {
          setAt(turn);
          setMode("resumeAt");
        }}
        manage={manage}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A: where does the next turn go?
// ---------------------------------------------------------------------------------------------

type Mode = "new" | "continue" | "resume" | "fork" | "resumeAt" | "customId" | "ephemeral";

const MODES: { id: Mode; label: string; option: string; needs?: "session" | "turn"; hint: string }[] = [
  { id: "new", label: "New session", option: "(no session option)", hint: "A new session with a new id." },
  { id: "continue", label: "continue", option: "continue: true", hint: "The most recent session in cwd. You do not pass an id." },
  { id: "resume", label: "resume", option: "resume: id", needs: "session", hint: "Adds the turn to the selected session. Same id." },
  {
    id: "fork",
    label: "resume + forkSession",
    option: "resume: id, forkSession: true",
    needs: "session",
    hint: "A copy of the selected session with a new id. The original is not changed.",
  },
  {
    id: "resumeAt",
    label: "resume + resumeSessionAt",
    option: "resume: id, resumeSessionAt: uuid",
    needs: "turn",
    hint: "Same id, but the turns after the picked one are dropped from the conversation.",
  },
  { id: "customId", label: "sessionId", option: "sessionId: randomUUID()", hint: "A new session with an id you choose (the server makes one)." },
  { id: "ephemeral", label: "persistSession: false", option: "persistSession: false", hint: "Nothing is written to disk: not listed, cannot be resumed." },
];

const presets = [
  { label: "Remember colour", text: "Remember: my favourite colour is green. Reply with one word: OK." },
  { label: "Remember fruit", text: "Remember: my favourite fruit is mango. Reply with one word: OK." },
  { label: "Ask both", text: "What are my favourite colour and fruit? Say 'unknown' for anything I did not tell you. One line." },
];

type Run = { mode: Mode; prompt: string; options?: any; before?: any; verdict?: any; messages: any[]; error?: string };

function Verdict({ run }: { run: Run }) {
  const v = run.verdict;
  if (!v) return null;
  const notes: string[] = [];
  if (v.target) notes.push(v.sessionId === v.target ? "the session you resumed" : `not ${short(v.target)}, the session you resumed`);
  if (run.mode === "continue") notes.push(v.sessionId === v.mostRecent ? "the most recent one" : "not the most recent one");
  if (run.mode === "customId") notes.push(v.sessionId === run.options?.sessionId ? "the id you chose" : "not the id you chose");
  return (
    <div className={`delegation ${v.persisted ? "" : "warn"}`}>
      init.session_id <code>{short(v.sessionId)}</code> →{" "}
      {!v.persisted ? (
        <b>not written to disk</b>
      ) : v.isNew ? (
        <b>a new session</b>
      ) : (
        <b>an existing session</b>
      )}
      {notes.length > 0 && <> · {notes.join(" · ")}</>}
      {v.turnsBefore !== undefined && v.turnsAfter !== undefined && (
        <span className="subtype">
          turns in {v.sessionId === v.target ? "it" : "the new one"}: {v.sessionId === v.target ? `${v.turnsBefore} → ${v.turnsAfter}` : v.turnsAfter}
        </span>
      )}
    </div>
  );
}

function RunCard({ run }: { run: Run }) {
  const m = MODES.find((x) => x.id === run.mode)!;
  const answer = run.messages
    .filter((x) => x.type === "assistant")
    .flatMap((x) => x.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const result = run.messages.find((x) => x.type === "result");
  return (
    <div className="card">
      <b>{m.label}</b> <code className="subtype">{m.option}</code>
      <div className="hint">{run.prompt}</div>
      {answer && <div className="card answer thin">{answer}</div>}
      <Verdict run={run} />
      {result && (
        <div className="hint">
          <span className={`subtype ${result.subtype === "success" ? "" : "bad"}`}>result/{result.subtype}</span> · $
          {result.total_cost_usd.toFixed(4)}
        </div>
      )}
      {run.error && (
        <div className="delegation warn">
          <div className="snippet">{run.error}</div>
        </div>
      )}
      <details>
        <summary className="hint">options sent to query() and raw messages</summary>
        {run.options && <pre>{JSON.stringify(run.options, null, 2)}</pre>}
        <MessageLog messages={run.messages} />
      </details>
    </div>
  );
}

function TurnPart(props: { mode: Mode; setMode: (m: Mode) => void; sessionCount: number; selected?: string; at?: Turn; onWritten: (id?: string) => void }) {
  const { mode, setMode, sessionCount, selected, at, onWritten } = props;
  const [prompt, setPrompt] = useState(presets[0].text);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);

  const current = MODES.find((m) => m.id === mode)!;
  const missing = (current.needs === "session" && !selected) || (current.needs === "turn" && !(selected && at));
  // Why the Send button is disabled, in words: a disabled button alone looks like the page is busy.
  const why = !missing
    ? undefined
    : sessionCount === 0
      ? `There are no sessions yet, so ${current.label} has nothing to work on. Pick "(no session option)", send "Remember colour", then come back to this option.`
      : current.needs === "turn" && selected
        ? 'Pick the turn to keep: click "Use for resumeSessionAt" on a turn in Part B, below.'
        : "Select a session in the table in Part B, below.";

  async function run() {
    const entry: Run = { mode, prompt, messages: [] };
    const update = (change: Partial<Run>) => {
      Object.assign(entry, change);
      setRuns((prev) => [{ ...entry }, ...prev.slice(1)]);
    };
    setRuns((prev) => [entry, ...prev]);
    setRunning(true);
    let written: string | undefined;
    try {
      await streamPost("/api/c19/turn", { prompt, mode, sessionId: selected, at: at?.lastUuid }, (event, data) => {
        if (event === "options") update({ options: data });
        if (event === "before") update({ before: data });
        if (event === "message") update({ messages: [...entry.messages, data] });
        if (event === "verdict") {
          update({ verdict: data });
          if (data.persisted) written = data.sessionId;
        }
        if (event === "error") update({ error: data.message });
      });
    } finally {
      setRunning(false);
      onWritten(written);
    }
  }

  return (
    <>
      <h3>A · Where does the next turn go?</h3>
      <p className="hint">
        Pick an option, then send a prompt. After the run the server compares <code>init.session_id</code> with the sessions
        that existed before, and the session it wrote to is selected in Part B. Try: <i>Remember colour</i> (new),{" "}
        <i>Remember fruit</i> (resume), then <i>Ask both</i> with <b>fork</b>, with <b>resumeSessionAt</b> on turn 1, and with{" "}
        <b>persistSession: false</b>.
      </p>
      <div className="card config">
        {MODES.map((m) => (
          <label key={m.id} className="check">
            <input type="radio" name="c19-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
            <span>
              <code>{m.option}</code> — {m.hint}
            </span>
          </label>
        ))}
        <div className="hint">
          Selected session: <code>{short(selected)}</code>
          {current.needs === "turn" && (
            <>
              {" "}
              · keep up to turn: {at ? <code>{at.prompt.slice(0, 40)}… ({short(at.lastUuid)})</code> : <i>pick one in the transcript below</i>}
            </>
          )}
        </div>
      </div>
      <div className="scenarios">
        {presets.map((p) => (
          <button key={p.label} onClick={() => setPrompt(p.text)}>
            {p.label}
          </button>
        ))}
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="row">
        <button
          className="primary"
          onClick={run}
          disabled={running || missing || !prompt.trim()}
          style={missing && !running ? { cursor: "not-allowed" } : undefined}
        >
          {running ? "Running…" : `Send with ${current.label}`}
        </button>
      </div>
      {why && (
        <div className="card warn">
          <b>Not ready</b> — {why}
        </div>
      )}
      {runs.map((r, i) => (
        <RunCard key={runs.length - i} run={r} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: the sessions on disk
// ---------------------------------------------------------------------------------------------

function SessionsPart(props: {
  lab?: Lab;
  selected?: string;
  detail?: Detail;
  at?: Turn;
  calls: Call[];
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onPickTurn: (turn: Turn) => void;
  manage: (call: string, url: string, body?: object, select?: (result: any) => string | undefined) => Promise<void>;
}) {
  const { lab, selected, detail, at, calls, onSelect, onRefresh, onPickTurn, manage } = props;
  const [title, setTitle] = useState("");
  const [tag, setTag] = useState("");
  const base = `/api/c19/sessions/${selected}`;
  const id = short(selected);

  return (
    <>
      <h3>B · The sessions on disk</h3>
      <p className="hint">
        <code>listSessions({"{ dir }"})</code> lists the lab's sessions, newest first. Select one to read it with{" "}
        <code>getSessionMessages()</code>, grouped here into turns. The other buttons call <code>renameSession()</code>,{" "}
        <code>tagSession()</code>, <code>forkSession()</code> and <code>deleteSession()</code>. Only a session listed for{" "}
        <code>session-lab/</code> can be changed.
      </p>
      <div className="row">
        <button onClick={onRefresh}>Refresh (listSessions)</button>
        <button
          onClick={() => confirm("Delete every session of session-lab/?") && manage("deleteSession() × every lab session", "/api/c19/reset", {}, () => undefined)}
          disabled={!lab?.sessions.length}
        >
          Delete all lab sessions
        </button>
      </div>
      {lab && (
        <div className="hint">
          cwd <code>{lab.lab}</code>
          <br />
          transcripts <code>{lab.transcripts}</code> {lab.transcriptsExist ? "" : <span className="subtype">(not created yet)</span>}
        </div>
      )}

      {lab && lab.sessions.length === 0 && <div className="card">No sessions yet. Send a prompt in Part A.</div>}
      {lab && lab.sessions.length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th></th>
              <th>summary</th>
              <th>id</th>
              <th>tag</th>
              <th>created</th>
              <th>modified</th>
              <th>size</th>
            </tr>
          </thead>
          <tbody>
            {lab.sessions.map((s) => (
              <tr key={s.sessionId}>
                <td>
                  <input type="radio" name="c19-session" checked={s.sessionId === selected} onChange={() => onSelect(s.sessionId)} />
                </td>
                <td>{s.summary}</td>
                <td>
                  <code>{short(s.sessionId)}</code>
                </td>
                <td>{s.tag ?? ""}</td>
                <td>{time(s.createdAt)}</td>
                <td>{time(s.lastModified)}</td>
                <td>{s.fileSize ? `${(s.fileSize / 1024).toFixed(1)} KB` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && detail && (
        <div className="card">
          <b>Session {id}</b> <span className="subtype">{detail.turns.length} turn(s) · {detail.entries.length} entries in the chain</span>
          <div className="hint">
            <code>{detail.file}</code>
          </div>
          <div className="row">
            <input className="inline" style={{ width: 200 }} placeholder="new title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button onClick={() => manage(`renameSession("${id}…", "${title}")`, `${base}/rename`, { title })} disabled={!title.trim()}>
              Rename
            </button>
            <input className="inline" style={{ width: 140 }} placeholder="tag (empty clears)" value={tag} onChange={(e) => setTag(e.target.value)} />
            <button onClick={() => manage(`tagSession("${id}…", ${tag.trim() ? `"${tag}"` : "null"})`, `${base}/tag`, { tag })}>Tag</button>
          </div>
          <div className="row">
            <button onClick={() => manage(`forkSession("${id}…")`, `${base}/fork`, {}, (r) => r.sessionId)}>forkSession() — full copy</button>
            <button onClick={() => confirm(`Delete session ${id}?`) && manage(`deleteSession("${id}…")`, `${base}/delete`)}>deleteSession()</button>
          </div>

          {detail.turns.map((t, i) => (
            <div key={t.promptUuid} className={`card ${at?.lastUuid === t.lastUuid ? "permission" : ""}`}>
              <b>Turn {i + 1}</b> <span className="subtype">last entry {short(t.lastUuid)}</span>
              <div>
                <span className="tag tag-user">you</span> {t.prompt}
              </div>
              <div>
                <span className="tag tag-assistant">claude</span> {t.answer || <i>(no answer)</i>}
              </div>
              <div className="row">
                <button onClick={() => onPickTurn(t)}>Use for resumeSessionAt (Part A)</button>
                <button
                  onClick={() => manage(`forkSession("${id}…", { upToMessageId: turn ${i + 1} })`, `${base}/fork`, { upToMessageId: t.lastUuid }, (r) => r.sessionId)}
                >
                  forkSession() up to here
                </button>
              </div>
            </div>
          ))}

          <details>
            <summary className="hint">getSessionInfo() and the raw chain</summary>
            <pre>{JSON.stringify(detail.info, null, 2)}</pre>
            <pre>{detail.entries.map((e) => `${e.type.padEnd(9)} ${short(e.uuid)}  ${e.text}`).join("\n")}</pre>
          </details>
        </div>
      )}

      {calls.map((c, i) => (
        <div key={calls.length - i} className={`delegation ${c.error ? "warn" : ""}`}>
          <code>{c.call}</code> {c.ms !== undefined && <span className="subtype">{c.ms} ms</span>}
          {c.error ? <div className="snippet">threw → {c.error}</div> : c.result !== undefined && <div className="snippet">→ {JSON.stringify(c.result)}</div>}
        </div>
      ))}
    </>
  );
}
