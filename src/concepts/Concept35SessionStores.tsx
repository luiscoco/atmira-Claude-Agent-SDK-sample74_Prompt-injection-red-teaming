import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Session = { projectKey: string; defaultKey: boolean; sessionId: string; title: string | null; lines: number; types: string[]; subkeys: { subpath: string; lines: number }[]; mtime: number };
type Db = { cwdKey: string; sessions: Session[]; machines: { a: string[]; b: string[] } };
type Ev = { event: string; data: any };

const MIRROR_PROMPT = "My name is Ada and the secret word is 'tangerine'. Reply only OK.";
const RESUME_PROMPT = "What is my name, and what is the secret word? One line.";
const SUB_PROMPT = "Use the Agent tool once, with subagent_type 'general-purpose' and the prompt 'Reply with the name of one fruit, one word'. Then tell me the fruit.";

const id8 = (s?: string) => (s ? s.slice(0, 8) : "");
const keyText = (k: any, cwdKey?: string) => (k ? `${k.projectKey && k.projectKey !== cwdKey ? `${k.projectKey} / ` : ""}${id8(k.sessionId)}${k.subpath ? ` / ${k.subpath}` : ""}` : "");

// Part F: the summary table.
const table: [string, string, string][] = [
  ["Mirror", "sessionStore: { append, load, … }", "Claude Code still writes CLAUDE_CONFIG_DIR/projects/<key>/<id>.jsonl; the SDK sends a copy of each batch of lines to append(). Your store never replaces the local write"],
  ["When append() is called", "sessionStoreFlush: 'batched' (default) | 'eager'", "batched: at the end of each turn (just before the result reaches you), or every 500 lines / 1 MiB; then once more at close. eager: one call per line group, from the first prompt on"],
  ["The key", "{ projectKey, sessionId, subpath? }", "projectKey = the cwd with non-alphanumerics as '-' (the local folder's name), or options.env.CLAUDE_CODE_PROJECT_DIR_NAME. subpath 'subagents/agent-<id>' for a subagent"],
  ["The lines", "SessionStoreEntry: { type, uuid?, timestamp?, … }", "Opaque JSON. user / assistant / attachment lines have a uuid: use it to dedup. queue-operation, ai-title, custom-title, tag, last-prompt, cost-state, mode… have none"],
  ["Resume anywhere", "resume: id + sessionStore", "The SDK calls load() and listSubkeys() BEFORE starting Claude Code, writes the lines to %TEMP%/claude-resume-<uuid>/ and starts it there (deleted at the end). The machine's own CLAUDE_CONFIG_DIR is not written"],
  ["Continue", "continue: true + sessionStore", "The newest session of store.listSessions(projectKey). Without listSessions(): refused"],
  ["Session functions", "listSessions, getSessionInfo, getSessionMessages, renameSession, tagSession, forkSession, deleteSession, listSubagents ({ dir, sessionStore })", "Read with load() (or listSessionSummaries()), write with append(); deleteSession calls delete() and is a no-op if you have none"],
  ["Summaries", "listSessionSummaries() + foldSessionSummary(prev, key, entries, { mtime })", "Optional. Lets listSessions() read one small sidecar per session instead of load()-ing every transcript"],
  ["Migrate", "importSessionToStore(id, store, { dir })", "Copies a local session (and its subagents) into the store, in batches of 500. It reads this process's CLAUDE_CONFIG_DIR"],
  ["append() fails", "rejects 3 times (200 ms, 800 ms backoff) or takes > 60 s", "The batch is dropped, a system/mirror_error message comes, the turn goes on (result: success). Check and re-import"],
  ["load() fails", "loadTimeoutMs (default 60 000)", "query() throws 'SessionStore.load() timed out'. load() returning null = not in the store: Claude Code says 'No conversation found'"],
  ["Does not combine", "persistSession: false · enableFileCheckpointing: true", "Both refused before anything starts: the mirror needs the local write, and file backups are not mirrored"],
];

function MachineFiles({ title, dir, list }: { title: string; dir: string; list: string[] }) {
  return (
    <div className="card store-machine">
      <b>{title}</b> <span className="subtype">CLAUDE_CONFIG_DIR = {dir}</span>
      {list.length === 0 ? (
        <div className="hint">no local transcript</div>
      ) : (
        <ul className="files">
          {list.map((f) => (
            <li key={f} className="snippet">
              {f.replace(/^projects\/[^/]+\//, "projects/<key>/")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StorePanel({ db, selected, setSelected }: { db: Db; selected: string | null; setSelected: (s: string) => void }) {
  const [open, setOpen] = useState<{ key: string; entries: string[] } | null>(null);
  async function show(s: Session, subpath?: string) {
    const k = `${s.sessionId}/${subpath ?? ""}`;
    if (open?.key === k) return setOpen(null);
    const q = new URLSearchParams({ projectKey: s.projectKey, sessionId: s.sessionId, ...(subpath && { subpath }) });
    const r = await fetch(`/api/c35/entries?${q}`).then((r) => r.json());
    setOpen({ key: k, entries: r.entries ?? [r.error] });
  }
  return (
    <div className="card store-db">
      <b>The store</b> <span className="subtype">new FileSessionStore('store-lab/db') · one JSONL file per key</span>
      {db.sessions.length === 0 && <div className="hint">empty: run 1 first</div>}
      {db.sessions.map((s) => (
        <div key={s.sessionId} className={`store-row ${selected === s.sessionId ? "picked" : ""}`}>
          <label className="check">
            <input type="radio" checked={selected === s.sessionId} onChange={() => setSelected(s.sessionId)} />
            <span>
              <code>{id8(s.sessionId)}</code> {s.title && <b>{s.title}</b>} {!s.defaultKey && <span className="tag tag-tenant">{s.projectKey}</span>}
            </span>
          </label>
          <div className="hint">
            <button className="link" onClick={() => show(s)}>
              {s.lines} lines
            </button>{" "}
            · {s.types.join(", ")}
          </div>
          {s.subkeys.map((k) => (
            <div key={k.subpath} className="hint">
              ↳ <code>{k.subpath}</code>{" "}
              <button className="link" onClick={() => show(s, k.subpath)}>
                {k.lines} lines
              </button>
            </div>
          ))}
          {open?.key.startsWith(s.sessionId + "/") && (
            <pre className="wrap store-lines">
              {open.entries.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function Timeline({ events, cwdKey }: { events: Ev[]; cwdKey?: string }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        if (event === "store")
          return (
            <div key={i} className={`tool-call store-call ${data.error ? "denied" : ""}`}>
              <span className="tag tag-store">store.{data.method}</span> <code>{keyText(data.key, cwdKey)}</code> {data.count !== undefined && <b>{data.count} lines</b>} {t}{" "}
              <span className="subtype">{data.ms} ms</span>
              {data.types && <div className="snippet">{data.types.join(", ")}</div>}
              {data.result !== undefined && data.result !== null && <div className="snippet">→ {JSON.stringify(data.result)}</div>}
              {data.result === null && <div className="snippet">→ null (never written)</div>}
              {data.error && <div className="snippet">rejected: {data.error}</div>}
            </div>
          );
        if (event === "msg")
          return (
            <div key={i} className={`tool-call ${data.bad ? "denied" : ""}`}>
              <span className={`tag tag-${String(data.kind).split("/")[0].split(" ")[0]}`}>{data.kind}</span> {t}
              <div className="snippet">{data.detail}</div>
            </div>
          );
        if (event === "materialized")
          return (
            <div key={i} className="tool-call verdict">
              <span className="tag tag-verdict">temporary CLAUDE_CONFIG_DIR</span> <code>{data.dir}</code> {t}
              <div className="hint">The SDK wrote the loaded lines here and started Claude Code with this folder. It is deleted when the session ends.</div>
              <div className="snippet">{data.files.map((f: string) => f.replace(/^projects\/[^/]+\//, "projects/<key>/")).join("\n")}</div>
            </div>
          );
        if (event === "check")
          return (
            <div key={i} className={`tool-call verdict ${data.ok ? "" : "denied"}`}>
              <span className="tag tag-verdict">host check</span> {t}
              <div className="snippet">
                {data.localFile.replace(/projects\/[^/]+\//, "projects/<key>/")}: {data.localLines} lines, {data.localWithUuid} with a uuid · store: {data.storedLines} lines ·{" "}
                {data.missing === 0 ? <b>every message is in the store</b> : <b className="bad">{data.missing} missing ({data.missingTypes.join(", ")})</b>}
              </div>
            </div>
          );
        if (event === "tenant")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-tenant">tenant key</span>
              <div className="snippet">
                listSessions({"{ dir, sessionStore }"}) → {JSON.stringify(data.viaDir.map(id8))} (it looks under the cwd's key)
                {"\n"}store.listSessions('{data.tenant}') → {JSON.stringify(data.viaKey.map(id8))}
              </div>
            </div>
          );
        if (event === "outcome")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">after the session</span>{" "}
              <span className="subtype">
                machine {data.machine.toUpperCase()}'s CLAUDE_CONFIG_DIR/projects: {data.machineFiles.length ? data.machineFiles.length + " file(s)" : "nothing"}
              </span>
              {data.text && <div className="answer thin">{data.text}</div>}
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span>
              <div className="snippet">{data.message}</div>
            </div>
          );
        return null;
      })}
    </div>
  );
}

function FailTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>setup</th>
          <th>store calls</th>
          <th>what the host sees</th>
          <th>host check</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td>
              <code>{r.shown}</code>
            </td>
            <td className="hint">{r.calls}</td>
            <td>
              <code className={/threw|error|mirror_error/.test(r.outcome) ? "bad" : ""}>{r.outcome}</code>
              {r.note && <div className="hint">{r.note}</div>}
            </td>
            <td className="hint">
              {r.check && (
                <div>
                  after the turn: {r.check.missing} of {r.check.localWithUuid} messages missing
                </div>
              )}
              {r.repaired && <div>after importSessionToStore(): {r.repaired.missing === 0 ? "all there" : `${r.repaired.missing} missing`}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept35SessionStores() {
  const [db, setDb] = useState<Db | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [options, setOptions] = useState<{ prompt: string; options: any } | null>(null);
  const [managed, setManaged] = useState<any>(null);
  const [failRows, setFailRows] = useState<any[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [shown, setShown] = useState<"run" | "manage" | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState(0);
  const [mirrorPrompt, setMirrorPrompt] = useState(MIRROR_PROMPT);
  const [resumePrompt, setResumePrompt] = useState(RESUME_PROMPT);
  const [title, setTitle] = useState("Ada's session");

  const fail = () => setError("Could not reach /api/c35 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together, and the server needs a few seconds to load: while it is not
    // listening, Vite's proxy answers 502. Try again for about 15 s before showing the error.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const [d, c] = await Promise.all(["/api/c35/db", "/api/c35/code"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))));
        if (!stop) (setDb(d), setCode(c), setError(null));
      } catch {
        if (stop) return;
        if (tries > 1) setTimeout(() => load(tries - 1), 1000);
        else fail();
      }
    };
    load();
    return () => void (stop = true);
  }, []);

  const picked = db?.sessions.find((s) => s.sessionId === selected);
  // A session kept under a tenant key is resumed with the same CLAUDE_CODE_PROJECT_DIR_NAME.
  const tenantOf = (s?: Session) => (s && !s.defaultKey ? { tenant: s.projectKey } : {});

  async function run(label: string, body: any, h: string) {
    setRunning(label);
    setShown("run");
    setHint(h);
    setError(null);
    setOptions(null);
    const got: Ev[] = [];
    setEvents([]);
    let sid: string | undefined;
    try {
      await streamPost("/api/c35/run", body, (event, data) => {
        if (event === "opened") return setOptions(data);
        if (event === "done") return data.db && setDb(data.db);
        if (event === "outcome") (sid = data.sessionId), setCost((c) => c + (data.cost ?? 0));
        if (event === "error") setError(data.message);
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
    return sid;
  }

  async function manage(label: string, body: any, h?: string) {
    setRunning(label);
    setShown("manage");
    setHint(h ?? null);
    setError(null);
    try {
      const r = await fetch("/api/c35/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      setManaged({ action: body.action, ...r });
      if (r.db) setDb(r.db);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function mirror(label: string, extra: any, h: string, prompt = mirrorPrompt) {
    const sid = await run(label, { machine: "a", store: true, prompt, ...extra }, h);
    if (sid) setSelected(sid);
  }

  async function importDemo() {
    const h =
      "First a session on machine A WITHOUT the store (only the local file), then importSessionToStore(id, store, { dir }) copies it in. Run 5 afterwards to resume it on machine B. Importing twice is safe for the messages (dedup by uuid), but the lines without a uuid are added again, as the contract says. About $0.001.";
    const sid = await run("import", { machine: "a", store: false, prompt: "The color of the day is teal. Reply only OK." }, h);
    if (!sid) return;
    await manage("import", { action: "importSessionToStore", sessionId: sid }, h);
    setSelected(sid);
  }

  async function failures() {
    setRunning("failures");
    setError(null);
    const rows: any[] = [];
    setFailRows([]);
    try {
      await streamPost("/api/c35/failures", {}, (event, data) => {
        if (event === "failRow") setFailRows((rows.push(data), [...rows])), setCost((c) => c + (data.cost ?? 0));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function reset() {
    const r = await fetch("/api/c35/reset", { method: "POST" }).then((r) => r.json()).catch(fail);
    if (r) setDb(r), setSelected(null), setEvents([]), setManaged(null), setFailRows([]), setShown(null);
  }

  const btn = (id: string, label: string, onClick: () => void, needs?: boolean) => (
    <button key={id} disabled={!!running || (needs && !selected)} className={running === id ? "active" : ""} onClick={onClick}>
      {running === id ? "Running…" : label}
    </button>
  );
  const fn = (action: string, extra: any = {}, h?: string) => btn(action, action + "()", () => manage(action, { action, ...(action !== "listSessions" && { sessionId: selected }), ...extra }, h), action !== "listSessions");

  return (
    <section>
      <h2>35 · Session stores</h2>
      <p className="lead">
        A session normally lives in <b>one file on one machine</b>: <code>CLAUDE_CONFIG_DIR/projects/&lt;key&gt;/&lt;id&gt;.jsonl</code>. Give{" "}
        <code>query()</code> a <code>sessionStore</code> and the SDK also sends every line of that file to <b>your storage</b> (a database, S3, Redis…), and
        can <b>resume the session from there on any machine</b>. This tab has two fake machines (two <code>CLAUDE_CONFIG_DIR</code>s, the same{" "}
        <code>cwd</code>) and one store: a folder of JSONL files written by a 60-line adapter.
      </p>

      {db && (
        <div className="store-panel">
          <MachineFiles title="Machine A" dir="store-lab/machine-a" list={db.machines.a} />
          <StorePanel db={db} selected={selected} setSelected={setSelected} />
          <MachineFiles title="Machine B" dir="store-lab/machine-b" list={db.machines.b} />
        </div>
      )}
      <div className="row">
        <button className="link" disabled={!!running} onClick={reset}>
          empty the store and both machines
        </button>
        <span className="subtype">selected session: {selected ? id8(selected) : "none"} · spent ${cost.toFixed(4)}</span>
      </div>

      <h3>A · Mirror a session to the store</h3>
      <label className="hint">prompt for 1, 2 and 4 (one turn, no tools)</label>
      <textarea rows={2} maxLength={2000} value={mirrorPrompt} onChange={(e) => setMirrorPrompt(e.target.value)} />
      <div className="scenarios">
        {btn("m1", "1 · New session on machine A", () =>
          mirror("m1", {}, "sessionStore on machine A. Watch WHEN store.append() is called: the batch of the turn arrives just before the result, then a last small one (titles, cost) when the session closes. The host check compares the local file's uuids with the store. About $0.001."),
        )}
        {btn("m2", "2 · sessionStoreFlush: 'eager'", () =>
          mirror("m2", { flush: "eager" }, "The same with sessionStoreFlush: 'eager': one append() per group of lines, the first one before the model has answered. More calls, less to lose if the process dies. About $0.001."),
        )}
        {btn("m3", "3 · With a subagent", () =>
          mirror("m3", { subagent: true }, "The Agent tool runs a subagent. Its transcript is another key: subpath 'subagents/agent-<id>'. On resume the SDK finds it with listSubkeys() and loads it too. Haiku often runs the agent in the background: then a second turn starts by itself when it returns (Concept 27). About $0.02.", SUB_PROMPT),
        )}
        {btn("m4", "4 · A tenant key", () =>
          mirror("m4", { tenant: "tenant-acme" }, "options.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'tenant-acme' replaces the projectKey (normally the cwd's name). Good for one store shared by many customers, but listSessions({ dir }) looks under the cwd's key and misses it. Select it and run 5: the resume sends the same CLAUDE_CODE_PROJECT_DIR_NAME. About $0.001."),
        )}
      </div>

      <h3>B · Resume it on another machine</h3>
      <label className="hint">prompt for 5, 6 and 7 · the session: the one selected in the store</label>
      <textarea rows={2} maxLength={2000} value={resumePrompt} onChange={(e) => setResumePrompt(e.target.value)} />
      <div className="scenarios">
        {btn(
          "r5",
          "5 · Resume on machine B from the store",
          () =>
            run("r5", { machine: "b", store: true, resume: selected, prompt: resumePrompt, ...tenantOf(picked) }, "Machine B has never seen this session. The SDK calls store.load() and store.listSubkeys() BEFORE Claude Code starts, writes the lines to a temporary CLAUDE_CONFIG_DIR, and starts Claude Code there. The new turn goes to the same key in the store; machine B's own folder stays empty. About $0.001."),
          true,
        )}
        {btn(
          "r6",
          "6 · The same without the store",
          () => run("r6", { machine: "b", store: false, resume: selected, prompt: resumePrompt, ...tenantOf(picked) }, "No sessionStore: Claude Code looks in machine B's own CLAUDE_CONFIG_DIR, where there is nothing. This is the problem the store solves. No API call."),
          true,
        )}
        {btn("r7", "7 · continue: true on machine B", () =>
          run("r7", { machine: "b", store: true, continue: true, prompt: resumePrompt }, "continue: true with a store: the SDK asks store.listSessions(projectKey) and resumes the newest one. About $0.001."),
        )}
      </div>

      <h3>C · The session functions, on the store</h3>
      <p className="hint">
        The functions of Concept 19 take <code>{"{ dir, sessionStore }"}</code>: <code>dir</code> gives the projectKey, the store replaces the files. No Claude
        Code process, no API call (except 8).
      </p>
      <div className="scenarios">
        {fn("listSessions", {}, "listSessions({ dir, sessionStore }) uses listSessionSummaries() when the store has it: one small sidecar per session (kept up to date with foldSessionSummary in append()).")}
        {fn("getSessionInfo")}
        {fn("getSessionMessages", {}, "load() the transcript, then rebuild the conversation chain from it. Only user/assistant messages are returned.")}
        {fn("listSubagents", {}, "listSubkeys() of the session. Run 3 first to have one.")}
        {fn("forkSession", {}, "load() the source, then append() a copy under a new session id, with new uuids.")}
        {fn("deleteSession", {}, "store.delete(). The local files on the machines are not touched.")}
      </div>
      <div className="row">
        <input className="inline-input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        {fn("renameSession", { title }, "Appends one 'custom-title' line (no uuid) to the session.")}
        {fn("tagSession", { tag: "demo" }, "Appends one 'tag' line.")}
      </div>
      <div className="scenarios">{btn("import", "8 · A local session → importSessionToStore()", importDemo)}</div>

      <h3>D · When the store fails</h3>
      <div className="row">
        <button disabled={!!running} className={running === "failures" ? "active" : ""} onClick={failures}>
          {running === "failures" ? "Checking…" : "9 · Six failures"}
        </button>
        <span className="subtype">6 cases in parallel, each with its own store · about $0.001</span>
      </div>
      {failRows.length > 0 && <FailTable rows={failRows} />}

      {hint && <p className="hint">{hint}</p>}
      {shown === "run" && (events.length > 0 || running) && (
        <div className="card">
          <b>Messages and store calls, in order</b> <span className="subtype">{running ? "running…" : "done"}</span>
          <Timeline events={events} cwdKey={db?.cwdKey} />
        </div>
      )}
      {shown === "manage" && managed && (
        <div className="card">
          <b>{managed.action}()</b>
          {managed.calls.length > 0 && <Timeline events={managed.calls.map((c: any) => ({ event: "store", data: c }))} cwdKey={db?.cwdKey} />}
          {managed.error ? <div className="snippet bad">{managed.error}</div> : <pre className="wrap">{JSON.stringify(managed.result, null, 2)}</pre>}
        </div>
      )}
      {options !== null && shown === "run" && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
        </details>
      )}

      <h3>E · The code</h3>
      <div className="row">
        {["adapter", "spy", "options", "messages", "check", "manage", "import"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>F · What a store does, and what it does not</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>What</th>
            <th>How</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([k, a, b]) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>
                <code>{a}</code>
              </td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
