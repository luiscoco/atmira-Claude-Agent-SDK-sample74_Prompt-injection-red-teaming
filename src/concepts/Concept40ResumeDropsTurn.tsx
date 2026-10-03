import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

// Part E: what the check allows in the discarded range. Read from the CLI's code (claude.exe of SDK 0.3.281): the
// rules are summed up in sdk.d.ts, the exact lists can change between versions.
const ALLOWED: [string, string][] = [
  ["furniture before the prompt", "attachments such as prompt_snapshot, total_tokens_reminder, date… are skipped (not structured_output, mcp_resource, inlined images)"],
  ["the declared prompt", "the first real entry of the range: a human prompt with exactly that uuid"],
  ["its assistant messages", "text and tool_use"],
  ["its tool results", "user entries made only of tool_result blocks"],
  ["system and progress entries, furniture attachments", "bookkeeping of the turn"],
  ["an empty range", "resumeSessionAt at the last entry: nothing is discarded, so nothing is checked"],
];
const REASONS: [string, string][] = [
  ["declared turn id is not a UUID", "resumeDropsTurn is not a UUID (the SDK does not check it)"],
  ["range does not start with the declared turn prompt", "a wrong turn, or a fork point in the middle of the kept turn (its tool_result comes first)"],
  ["declared turn id names a non-prompt user entry", "a tool_result, a meta or compaction entry was named"],
  ["range contains absorbed queued content", "a message the session took in while the turn ran (attachment/queued_command)"],
  ["range contains a user entry not attributable to the declared turn", "another turn's prompt: more than one turn would go"],
  ["range contains a compaction summary / a system-injected turn prompt / a non-furniture attachment", "anything else that is not the turn's own"],
];

// Part G: the summary table.
const SUMMARY: [string, string, string][] = [
  ["Set it", "resume + resumeSessionAt + resumeDropsTurn: '<prompt uuid>'", "Becomes --resume-drops-turn=<id>. Without resumeSessionAt, Claude Code exits at startup"],
  ["It checks", "the range after resumeSessionAt", "It must start with that prompt and hold only that turn's own entries"],
  ["Accepted", "a normal truncating resume", "The same as resumeSessionAt alone (with forkSession, a new id; without it, the same session)"],
  ["Refused", "error_during_execution, $0", "errors[0] starts with 'Resume rejected by --resume-drops-turn:', no API call, nothing written; query() throws after the result"],
  ["On a refusal", "clear the fork target, resume plainly", "Do not retry: the check is deterministic. Keep the evidence and tell the user"],
  ["Which uuid to keep", "the kept turn's LAST chain entry", "The streamed assistant uuid works for a text turn (only furniture follows). Never a uuid in the middle of the turn"],
  ["Which uuid to drop", "the prompt uuid you sent", "Set uuid on your SDKUserMessage: the host knows it without reading the transcript"],
  ["Where", "print mode only (the SDK)", "An interactive claude --resume and background-job workers ignore both options"],
  ["End-turn tools", "outputFormat json_schema, _meta['claude/endTurn']", "Fork at the structured_output attachment or the carrier, not at the last assistant (per sdk.d.ts; not reproduced here)"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype">{(d.at / 1000).toFixed(2)} s</span> : null);
const usd = (n: number) => `$${n.toFixed(6)}`;
const id8 = (u?: string) => (u ? u.slice(0, 8) : "");

function Status({ r }: { r: any }) {
  const cls = r.status === "accepted" ? "good" : "bad";
  return <code className={cls}>{r.status}</code>;
}

/** The reason without the uuids, which change with every build: the rule is what matters. */
const reasonRule = (s?: string) => (s ?? "").replace(/^resuming at [\w-]+ would discard entries not attributable to turn [\w-]+: /, "");

function Chain({ state }: { state: any }) {
  const turn = (n: number) => state.turns.find((x: any) => x.n === n);
  return (
    <table className="tools compare chain">
      <thead>
        <tr>
          <th>#</th>
          <th>turn</th>
          <th>entry</th>
          <th>uuid</th>
          <th>text</th>
        </tr>
      </thead>
      <tbody>
        {state.chain.map((e: any) => {
          const tr = turn(e.turn);
          const marks = [
            tr?.prompt === e.uuid && "the prompt (resumeDropsTurn names it)",
            tr?.lastUuid === e.uuid && "the turn's last entry",
            tr?.assistantUuid === e.uuid && tr?.lastUuid !== e.uuid && "its last assistant",
            tr?.toolUseUuid === e.uuid && "tool_use (mid-turn)",
          ].filter(Boolean);
          return (
            <tr key={e.i} className={e.kind === "attachment/queued_command" ? "absorbed" : e.turn % 2 ? "turn-odd" : ""}>
              <td>{e.i}</td>
              <td>{e.turn}</td>
              <td>
                <code>{e.kind}</code>
              </td>
              <td>
                <code className="uuid">{id8(e.uuid)}</code>
              </td>
              <td>
                {e.text}
                {marks.length > 0 && <div className="hint">← {marks.join(" · ")}</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CasesTable({ rows, state }: { rows: any[]; state: any }) {
  const where = (u?: string) => {
    if (!u) return "(not set)";
    const e = state?.chain.find((x: any) => x.uuid === u);
    return e ? `#${e.i} ${e.kind} (turn ${e.turn})` : u;
  };
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>resumeSessionAt · resumeDropsTurn</th>
          <th>outcome</th>
          <th>the answer (fruit, colour, city, pet)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <b>{r.label}</b>
            </td>
            <td>
              <div className="hint">at {where(r.options.resumeSessionAt)}</div>
              <div className="hint">drops {r.options.resumeDropsTurn === undefined ? "(not set)" : where(r.options.resumeDropsTurn)}</div>
            </td>
            <td>
              <Status r={r} /> <span className="hint">{usd(r.cost)}</span>
              {r.reason && <div className="snippet">{reasonRule(r.reason)}</div>}
              {r.status === "exited" && <div className="snippet">{r.answer}</div>}
            </td>
            <td>
              {r.status === "accepted" ? r.answer : <span className="hint">no turn ran</span>}
              {r.status === "accepted" && <div className="hint">prompts kept in the fork: {r.kept.length - 1} + the question</div>}
              <div className="hint">{r.note}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pairs({ rows, head }: { rows: [string, string][]; head: [string, string] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>{head[0]}</th>
          <th>{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>
              <code>{k}</code>
            </td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        if (event === "sent")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">{data.turn === "queued" ? "queued mid-turn" : `turn ${data.turn}`}</span> {t(data)} <code className="uuid">uuid {id8(data.uuid)}</code>
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> {t(data)} <span className="subtype">session {data.sessionId}</span>
            </div>
          );
        if (event === "tool")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">tool_use</span> {t(data)} <code>{data.command}</code>
            </div>
          );
        if (event === "assistant")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> {t(data)} <code className="uuid">{id8(data.uuid)}</code>
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result {data.turn}</span> {t(data)} <span className="subtype">{data.subtype} · total_cost_usd so far {usd(data.cost)}</span>
            </div>
          );
        if (event === "attempt")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">options</span> {t(data)} <span className="subtype">keeps {data.keeps}; drops {data.drops}</span>
              <pre className="wrap snippet">{JSON.stringify({ resume: data.resume, forkSession: data.forkSession, resumeSessionAt: data.resumeSessionAt, resumeDropsTurn: data.resumeDropsTurn }, null, 2)}</pre>
            </div>
          );
        if (event === "outcome")
          return (
            <div key={i} className={`tool-call drops-${data.status === "accepted" ? "accepted" : "refused"}`}>
              <span className={`tag ${data.status === "accepted" ? "tag-result" : "tag-error"}`}>{data.step === "recovered" ? "plain resume" : "guarded resume"}</span> {t(data)} <Status r={data} />{" "}
              <span className="subtype">{usd(data.cost)}</span>
              {data.reason && <div className="snippet">Resume rejected by --resume-drops-turn: {data.reason}</div>}
              {data.status === "accepted" && <div className="snippet">{data.answer}</div>}
              {data.status === "exited" && <div className="snippet bad">{data.answer}</div>}
            </div>
          );
        if (event === "recover")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">recovery</span> {t(data)} <span className="subtype">no retry: clear the fork target, resume plainly (resumeSessionAt and resumeDropsTurn unset)</span>
            </div>
          );
        if (event === "summary")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">done</span> {t(data)} <span className="subtype">{usd(data.cost)}</span>
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span> {t(data)}
              <div className="snippet">{data.message}</div>
            </div>
          );
        return null;
      })}
    </div>
  );
}

export function Concept40ResumeDropsTurn() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ part: string; text: string } | null>(null);
  const [cost, setCost] = useState(0);
  const [dry, setDry] = useState<{ flags: any[]; checks: any[] } | null>(null);
  const [state, setState] = useState<any>(null); // the lab session: its turns and its chain
  const [buildEvents, setBuildEvents] = useState<Ev[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  // Part D
  const [turn, setTurn] = useState("3");
  const [at, setAt] = useState("last");
  const [recover, setRecover] = useState(true);
  const [events, setEvents] = useState<Ev[]>([]);

  const fail = () => setError("Could not reach /api/c40 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together; while the server is loading, Vite's proxy answers 502.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const [c, s] = await Promise.all(["code", "state"].map((p) => fetch(`/api/c40/${p}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))));
        if (!stop) setCode(c), setState(s), setError(null);
      } catch {
        if (stop) return;
        if (tries > 1) setTimeout(() => load(tries - 1), 1000);
        else fail();
      }
    };
    load();
    return () => void (stop = true);
  }, []);

  const PART: Record<string, string> = { dry: "A", build: "B", cases: "C", undo: "D" };
  const begin = (id: string, h: string) => (setRunning(id), setHint({ part: PART[id], text: h }), setError(null));
  const hintAt = (part: string) => hint?.part === part && <p className="hint">{hint.text}</p>;

  async function dryRun() {
    begin("dry", "Left: query() with a spawner that records the args (Concept 36), no Claude Code. Right: the real Claude Code with combinations it refuses at startup, before reading any session. This costs nothing.");
    try {
      const r = await fetch("/api/c40/dry", { method: "POST" }).then((x) => x.json());
      if (r.error) setError(r.error);
      else setDry(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function build() {
    begin("build", "One query() with streaming input (Concept 12): four prompts, each with a uuid the host chose. During turn 3's Bash call (5 s), a fifth message is sent. About $0.02.");
    const got: Ev[] = [];
    let last = 0; // in streaming input, total_cost_usd is the session's running total
    setBuildEvents([]);
    setRows([]);
    try {
      await streamPost("/api/c40/build", {}, (event, data) => {
        if (event === "done") return;
        if (event === "result") last = data.cost;
        if (event === "chain") return setState(data);
        if (event === "init" && got.some((g) => g.event === "init")) return; // one per turn in streaming input: the first is enough
        got.push({ event, data });
        setBuildEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setCost((c) => c + last);
      setRunning(null);
    }
  }

  async function runCases() {
    begin("cases", "Ten resumes of the same session, four at a time, each with forkSession: true (the lab session is never changed) and the same question. The refused ones cost $0: Claude Code checks before any API call. About $0.07.");
    const got: any[] = [];
    setRows([]);
    try {
      await streamPost("/api/c40/cases", {}, (event, data) => {
        if (event === "error") return setError(data.message);
        if (event !== "row") return;
        got.push(data);
        got.sort((a, b) => a.order - b.order); // the order of the list, not the order they finished
        setRows([...got]);
        setCost((c) => c + (data.cost ?? 0));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function undo() {
    begin("undo", "What a host's 'undo' button should do: a guarded resume, and on a refusal the recovery path. About $0.017 for a run that reaches Claude, $0 for a refusal.");
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c40/undo", { turn: Number(turn), at, recover }, (event, data) => {
        if (event === "done") return;
        if (event === "summary") setCost((c) => c + (data.cost ?? 0));
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const btn = (id: string, label: string, onClick: () => void, needsSession = false) => (
    <button disabled={!!running || (needsSession && !state)} className={running === id ? "active" : ""} onClick={onClick}>
      {running === id ? "Running…" : label}
    </button>
  );
  const select = (value: string, set: (v: string) => void, options: [string, string][]) => (
    <select className="inline" value={value} disabled={!!running} onChange={(e) => set(e.target.value)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <section>
      <h2>40 · resumeDropsTurn</h2>
      <p className="lead">
        <code>resumeSessionAt</code> (Concept 19) cuts a session after an entry: an "undo", a "regenerate", a rewind. But it cuts <b>everything</b> after it, and a session can hold things the
        host never saw: a message queued while a tool ran, a task notification, a later turn. <code>resumeDropsTurn</code> names the one turn you mean to drop. Claude Code checks the cut,
        and <b>refuses</b> it if anything else would go.
      </p>
      <div className="card">
        <b>The lab</b> <span className="subtype">drops-lab/, its own CLAUDE_CONFIG_DIR, so the raw transcript (attachments too) can be read</span>
        <pre className="wrap snippet">
          {`turn 1   "my fruit is mango"
turn 2   "my colour is teal"
turn 3   Bash: sleep 5 s          ← while it runs, the host sends "my city is Oslo": Claude Code absorbs it into turn 3
turn 4   "my pet is a cat"
every case asks: "What do you know about me: fruit, colour, city, pet?"`}
        </pre>
      </div>
      <div className="row">
        <span className="subtype">spent ${cost.toFixed(4)} (the total_cost_usd of every session)</span>
      </div>

      <h3>A · Where the option goes, and what Claude Code refuses at startup</h3>
      <div className="scenarios">{btn("dry", "1 · Dry run: the flags, and two refusals", dryRun)}</div>
      {hintAt("A")}
      {dry && (
        <div className="grid2">
          <table className="tools compare">
            <thead>
              <tr>
                <th>options</th>
                <th>the CLI args</th>
              </tr>
            </thead>
            <tbody>
              {dry.flags.map((r) => (
                <tr key={r.key}>
                  <td>
                    <code>{r.shown}</code>
                  </td>
                  <td>
                    {r.args.map((a: string) => (
                      <div key={a}>
                        <code>{a}</code>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="tools compare">
            <thead>
              <tr>
                <th>options</th>
                <th>Claude Code at startup</th>
              </tr>
            </thead>
            <tbody>
              {dry.checks.map((r) => (
                <tr key={r.key}>
                  <td>
                    <code>{r.shown}</code>
                  </td>
                  <td>
                    <code className={r.ok ? "good" : "bad"}>{r.message}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dry && <p className="hint">The SDK passes the value as it is, an empty string too (it checks !== undefined). The uuids here are placeholders: no session is read.</p>}

      <h3>B · The session to cut</h3>
      <div className="scenarios">{btn("build", state ? "2 · Build it again" : "2 · Build the session", build)}</div>
      {hintAt("B")}
      {buildEvents.length > 0 && (
        <div className="card">
          <Timeline events={buildEvents} />
        </div>
      )}
      {state && (
        <>
          <p className="hint">
            Session <code>{state.sessionId}</code>: its chain, read from the JSONL (getSessionMessages() leaves attachments out). The{" "}
            <b>queued_command</b> row is the message sent during turn 3. Turns: {state.turns.map((x: any) => `${x.n}${x.byHost ? " (host uuid)" : ""}`).join(", ")}.
          </p>
          <Chain state={state} />
        </>
      )}

      <h3>C · Ten cuts of the same session</h3>
      <div className="scenarios">{btn("cases", "3 · Resume with each pair of options", runCases, true)}</div>
      {!state && <p className="hint">Build the session first (2).</p>}
      {hintAt("C")}
      {rows.length > 0 && <CasesTable rows={rows} state={state} />}

      <h3>D · Undo a turn, like a host</h3>
      <div className="row">
        <label className="hint">undo</label>
        {select(turn, setTurn, [
          ["3", "turn 3 (it absorbed a message)"],
          ["4", "turn 4 (the last one)"],
          ["2", "turn 2 (two turns follow)"],
        ])}
        <label className="hint">fork at the kept turn's</label>
        {select(at, setAt, [
          ["last", "last chain entry"],
          ["assistant", "last assistant uuid (streamed)"],
          ["toolUse", "tool_use (mid-turn: undo turn 4)"],
        ])}
        <label className="check">
          <input type="checkbox" checked={recover} disabled={!!running} onChange={(e) => setRecover(e.target.checked)} /> on a refusal, recover (resume plainly)
        </label>
        {btn("undo", "4 · Undo", undo, true)}
      </div>
      {hintAt("D")}
      {events.length > 0 && (
        <div className="card">
          <Timeline events={events} />
        </div>
      )}

      <h3>E · What the check allows, and why it refuses</h3>
      <p className="hint">
        The rules are in <code>sdk.d.ts</code>. The exact lists were read from the CLI's code (<code>claude.exe</code> of SDK 0.3.281) and can change between versions.
      </p>
      <Pairs head={["allowed in the discarded range", "what"]} rows={ALLOWED} />
      <Pairs head={["refused: the reason", "when"]} rows={REASONS} />

      <h3>F · The code</h3>
      <div className="row">
        {["options", "dry", "chain", "build", "resume", "cases", "undo"].map(
          (r) =>
            typeof code[r] === "string" && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && typeof code[openCode] === "string" && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>G · resumeDropsTurn, in one table</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>What</th>
            <th>How</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {SUMMARY.map(([k, a, b]) => (
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
