import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Ev = { event: string; data: any };

// Part E: what SDKSession set on its own. Read from the SDKSession constructor in sdk.mjs of 0.2.141.
const FIXED: [string, string, string][] = [
  ["tools", "not passed", "every built-in tool (27 in Claude Code 2.1.141). allowedTools / disallowedTools only filter them"],
  ["mcpServers, strictMcpConfig", "{}, false", "no MCP servers, no in-process tools (createSdkMcpServer, Concept 5)"],
  ["maxTurns, maxBudgetUsd", "undefined", "no limit on a turn's tool loop, no budget"],
  ["thinkingConfig, fallbackModel", "undefined", "the model's default thinking, no fallback"],
  ["systemPrompt, outputFormat", "not passed", "the default claude_code prompt, no structured output"],
  ["includePartialMessages", "false", "no stream_event: no token-by-token UI"],
  ["forkSession, resumeSessionAt", "false, undefined", "a resumed session is always continued, never forked or cut"],
  ["settingSources", "?? []", "no CLAUDE.md, no settings files (query() alone loads them all)"],
  ["abortController", "its own", "none from you: close() ends the input, then aborts after 5 s"],
  ["the Query object", "private", "no interrupt(), setModel(), setPermissionMode(), getContextUsage() (Concepts 12, 26)"],
];

// Part F: the migration table.
const MIGRATION: [string, string, string][] = [
  ["unstable_v2_prompt(text, options)", "query({ prompt: text, options })", "Keep the message whose type is \"result\" (Concept 1)"],
  ["unstable_v2_createSession(options)", "query({ prompt: inputQueue.stream, options })", "Streaming input mode (Concept 12): one process for the whole conversation"],
  ["await session.send(text)", "inputQueue.push({ type: \"user\", message: { role: \"user\", content: text }, parent_tool_use_id: null })", "A message pushed while a turn runs waits in the queue (Concept 12)"],
  ["for await (m of session.stream())", "read the Query until the next result", "V2's stream() returned after each result. A Query is one stream for every turn"],
  ["session.sessionId", "system/init.session_id (or the id you resumed)", "V2 threw until the first message. So does createSession() here"],
  ["session.close() / await using", "close the input queue, or abortController.abort()", "Closing the input is the normal end. abort() kills the process at once"],
  ["unstable_v2_resumeSession(id, options)", "query({ prompt, options: { ...options, resume: id } })", "Sessions are files: the ids V2 wrote still resume (Part C)"],
  ["model (required)", "model (optional)", "query() falls back to the default model"],
  ["settingSources: default []", "settingSources: set it to []", "To keep V2's behavior, say so: query() loads user, project and local settings when it is left out"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype">{(d.at / 1000).toFixed(1)} s</span> : null);
const usd = (n?: number) => (n === undefined ? "" : `$${n.toFixed(4)}`);
const tagOf = (kind: string) => `tag tag-${kind.split("/")[0]}`;

function Timeline({ events }: { events: Ev[] }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "call")
          return (
            <div key={i} className={`tool-call call${d.quiet ? " observer" : ""}`}>
              <span className="tag tag-call">call</span> <code>{d.code}</code>
              {d.note && (
                <>
                  {" "}→ <code className="good">{d.note}</code>
                </>
              )}
              {d.error && (
                <>
                  {" "}→ <code className="bad">throws: {d.error}</code>
                </>
              )}
              {t(d)}
            </div>
          );
        if (event === "message")
          return (
            <div key={i} className="tool-call">
              <span className={tagOf(d.kind)}>{d.kind}</span> <span className="snippet">{d.text}</span>
              {d.cost !== undefined && <span className="subtype">total_cost_usd {usd(d.cost)}</span>}
              {t(d)}
            </div>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span> <span className="snippet">{d.message}</span>
            </div>
          );
        return null;
      })}
    </>
  );
}

function Triples({ head, rows, code = [true, true, false] }: { head: string[]; rows: [string, string, string][]; code?: boolean[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i}>{code[i] ? <code>{c}</code> : c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Chips({ keys, cls }: { keys: string[]; cls?: string }) {
  return (
    <div className="events-grid">
      {keys.map((k) => (
        <span key={k} className={`ev ${cls ?? ""}`}>
          {k}
        </span>
      ))}
    </div>
  );
}

function CompareTable({ rows }: { rows: any[] }) {
  const order = ["v2", "wrapper", "lean", "resume"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.way) - order.indexOf(b.way));
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>way</th>
          <th>SDK · Claude Code · tools</th>
          <th>processes</th>
          <th>sessions</th>
          <th>turns (ms)</th>
          <th>cost</th>
          <th>turn 3: "What is my name, and what do I teach?"</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) =>
          r.error ? (
            <tr key={r.way}>
              <td>
                <b>{r.label}</b>
              </td>
              <td colSpan={6}>
                <code className="bad">{r.error}</code>
              </td>
            </tr>
          ) : (
            <tr key={r.way}>
              <td>
                <b>{r.label}</b>
              </td>
              <td>
                <code>{r.sdk}</code> · <code>{r.cli}</code> · {r.tools}
              </td>
              <td>
                <b>{r.processes}</b>
                {r.resumed > 0 && <div className="hint">{r.resumed} with --resume</div>}
              </td>
              <td>
                {r.sessionIds.length} <code className="uuid">{r.sessionIds.map((s: string) => s.slice(0, 8)).join(", ")}</code>
              </td>
              <td>{r.turns.map((x: any) => x.ms).join(" · ")}</td>
              <td>{usd(r.cost)}</td>
              <td>{r.turns.at(-1)?.answer}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

export function Concept41V2SessionApi() {
  const [facts, setFacts] = useState<any>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [lastV2, setLastV2] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);

  const [v2Events, setV2Events] = useState<Ev[]>([]);
  const [v2Raw, setV2Raw] = useState<any[]>([]);
  const [resumeEvents, setResumeEvents] = useState<Record<string, Ev[]>>({});
  const [rows, setRows] = useState<any[]>([]);
  const [wayEvents, setWayEvents] = useState<Record<string, Ev[]>>({});

  useEffect(() => {
    const get = (url: string) => fetch(url).then(async (r) => ((r.ok ? r : Promise.reject(new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`))), r.json()));
    get("/api/c41/facts").then(setFacts).catch((e) => setError(String(e)));
    get("/api/c41/code").then(setCode).catch(() => {});
    get("/api/c41/state").then((s) => setLastV2(s.lastV2Session)).catch(() => {});
  }, []);

  async function run(key: string, url: string, body: unknown, onEvent: (event: string, data: any) => void) {
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "error") setError(data.message);
        onEvent(event, data);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }

  function v2(step: "prompt" | "session") {
    setV2Events([]);
    setV2Raw([]);
    run(step, "/api/c41/v2", { step }, (event, data) => {
      if (event === "session") setLastV2(data.id);
      if (event === "message") setV2Raw((p) => [...p, data.raw]);
      if (event !== "done" && event !== "session") setV2Events((p) => [...p, { event, data }]);
    });
  }

  function resume(how: "v2" | "query") {
    setResumeEvents((p) => ({ ...p, [how]: [] }));
    run(`resume-${how}`, "/api/c41/resume", { how }, (event, data) => {
      if (event !== "done") setResumeEvents((p) => ({ ...p, [how]: [...(p[how] ?? []), { event, data }] }));
    });
  }

  function compare() {
    setRows([]);
    setWayEvents({});
    run("compare", "/api/c41/compare", {}, (event, data) => {
      if (event === "row") setRows((p) => [...p, data]);
      if (event === "message") setWayEvents((p) => ({ ...p, [data.way]: [...(p[data.way] ?? []), { event, data }] }));
    });
  }

  const btn = (key: string, label: string, onClick: () => void, disabled = false) => (
    <button className={running === key ? "active" : ""} onClick={onClick} disabled={!!running || disabled}>
      {running === key ? "Running…" : label}
    </button>
  );
  const o = facts?.options;

  return (
    <section>
      <h2>41 · The V2 session API, and how to migrate it to query()</h2>
      <p className="lead">
        From SDK 0.1.54 to 0.2.141 there was a second way to talk to Claude Code: <code>unstable_v2_createSession()</code> gave you a session object with{" "}
        <code>send()</code>, <code>stream()</code> and <code>close()</code>. It was marked <code>@deprecated</code> ("Use <code>query()</code> instead") and removed in
        0.3.142. This lab installs 0.2.141 next to today's SDK (npm alias <code>claude-agent-sdk-v2</code>), runs the old API for real, and writes the same thing with{" "}
        <code>query()</code>.
      </p>
      <div className="card">
        <pre>{`// V2 (0.2.141)                                   // today (0.3.x): streaming input, Concept 12
const session = unstable_v2_createSession(opts);    const q = query({ prompt: inputQueue.stream, options });
await session.send("Hi");                          inputQueue.push(userMessage("Hi"));
for await (const m of session.stream()) { … }      for await (const m of q) { …; if (m.type === "result") /* turn done */ }
session.close();                                   inputQueue.close();`}</pre>
      </div>

      <h3>A · What V2 was, and where it went</h3>
      {facts && (
        <>
          <table className="tools compare">
            <thead>
              <tr>
                <th>SDK</th>
                <th>published</th>
                <th>what happened</th>
              </tr>
            </thead>
            <tbody>
              {facts.history.map((h: any) => (
                <tr key={h.version}>
                  <td>
                    <code>{h.version}</code>
                  </td>
                  <td>{h.date}</td>
                  <td>{h.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Both are installed in this project. What each one exports, checked now with import():</p>
          <table className="tools compare">
            <thead>
              <tr>
                <th>package</th>
                <th>exports</th>
                <th>unstable_v2_*</th>
              </tr>
            </thead>
            <tbody>
              {facts.installed.map((p: any) => (
                <tr key={p.name}>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>{p.exports}</td>
                  <td>{p.v2.length ? p.v2.map((n: string) => <code key={n} className="good">{n} </code>) : <code className="bad">none</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            The doc comments of 0.2.141 (<code>sdk.d.ts</code>): every V2 declaration is <code>@alpha</code> and <code>@deprecated</code>.
          </p>
          <table className="tools compare">
            <tbody>
              {facts.deprecations.map((d: any) => (
                <tr key={d.name}>
                  <td>
                    <code>
                      {d.kind} {d.name}
                    </code>
                  </td>
                  <td>
                    {d.what}
                    <div className="hint">
                      <b>@deprecated</b> {d.deprecated}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>B · The V2 API, live (SDK 0.2.141, Claude Code 2.1.141)</h3>
      <div className="scenarios">
        {btn("prompt", "1 · unstable_v2_prompt()", () => v2("prompt"))}
        {btn("session", "2 · createSession → send / stream × 3 → close", () => v2("session"))}
      </div>
      <p className="hint">
        Every <b>call</b> row is a line of code the server ran, with what it returned or threw. 2 asks three questions in one session: the third only works if the
        session remembers the first. About $0.01 each.
      </p>
      {v2Events.length > 0 && (
        <div className="card">
          <Timeline events={v2Events} />
        </div>
      )}
      <MessageLog messages={v2Raw} />

      <h3>C · Upgrading keeps the sessions</h3>
      <p className="hint">
        A session is a JSONL file in <code>CLAUDE_CONFIG_DIR</code> (here <code>v2-lab/config</code>), not a V2 object. So an app that stored V2 session ids can
        resume them with today's <code>query()</code>: a newer Claude Code reads what 2.1.141 wrote.{" "}
        {lastV2 ? (
          <>
            Last V2 session: <code>{lastV2}</code>.
          </>
        ) : (
          <b>Run 2 first.</b>
        )}
      </p>
      <div className="scenarios">
        {btn("resume-v2", "3 · unstable_v2_resumeSession()", () => resume("v2"), !lastV2)}
        {btn("resume-query", "4 · query({ resume }) with SDK 0.3", () => resume("query"), !lastV2)}
      </div>
      <div className="grid2">
        {(["v2", "query"] as const).map(
          (k) =>
            resumeEvents[k]?.length > 0 && (
              <div key={k} className="card">
                <b>{k === "v2" ? "V2 (0.2.141)" : "query() (0.3.x)"}</b>
                <Timeline events={resumeEvents[k]} />
              </div>
            ),
        )}
      </div>
      {resumeEvents.v2?.length > 0 && resumeEvents.query?.length > 0 && (
        <p className="hint">
          Same session id in both <code>system/init</code> rows, two Claude Code versions. The cost differs because the newer CLI sends a different system prompt and
          tool list, so the prompt cache of the old one does not apply.
        </p>
      )}

      <h3>D · The replacement: createSession() on query()</h3>
      <p className="hint">
        Inside 0.2.141, <code>SDKSession</code> was already an input queue plus the same <code>Query</code> that <code>query()</code> returns. The same thing on
        today's SDK is about 60 lines, and it takes every <code>Options</code> field, and gives back the <code>Query</code>:
      </p>
      {code.wrapper && (
        <details className="card">
          <summary>
            <b>createSession(), resumeSession(), prompt()</b> (server/concepts/41-v2-session-api.ts)
          </summary>
          <pre className="wrap">{code.wrapper}</pre>
        </details>
      )}
      <div className="scenarios">{btn("compare", "5 · The same three turns, four ways, at the same time", compare)}</div>
      <p className="hint">
        <b>processes</b> is counted by <code>41-launcher.mjs</code>, set as <code>pathToClaudeCodeExecutable</code> in every way: it logs a line, then starts the
        real <code>claude.exe</code>. <b>cost</b> is the last <code>total_cost_usd</code>, the session's running total. It depends on the prompt cache: the first run
        of each Claude Code version pays to write it. About $0.04 in all.
      </p>
      {rows.length > 0 && <CompareTable rows={rows} />}
      {Object.keys(wayEvents).length > 0 && (
        <div className="compare-grid">
          {["v2", "wrapper", "lean", "resume"].map(
            (w) =>
              wayEvents[w] && (
                <details key={w} className="card">
                  <summary>
                    <b>{w}</b> ({wayEvents[w].length} messages)
                  </summary>
                  <Timeline events={wayEvents[w]} />
                </details>
              ),
          )}
        </div>
      )}

      <h3>E · The options: V2 took {o?.v2.length ?? "…"}, query() takes {o?.optionCount ?? "…"}</h3>
      {o && (
        <>
          <p className="hint">
            Read now from both <code>sdk.d.ts</code> files: the keys of <code>SDKSessionOptions</code> (0.2.141) and of <code>Options</code> (
            {facts.installed[1].version}). Every V2 option still exists{o.v2Only.length ? `, except ${o.v2Only.join(", ")}` : ""}.
          </p>
          <b>In both</b>
          <Chips keys={o.both} cls="fired" />
          <p />
          <b>Only in query() ({o.queryOnly.length})</b>
          <Chips keys={o.queryOnly} />
        </>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        What <code>SDKSession</code> decided on its own (read from its constructor in <code>sdk.mjs</code> of 0.2.141):
      </p>
      <Triples head={["setting", "V2 passed", "so"]} rows={FIXED} code={[true, true, false]} />

      <h3>F · Migrating, line by line</h3>
      <Triples head={["V2", "today", "note"]} rows={MIGRATION} />

      <h3>G · The code</h3>
      <div className="row">
        {["v2options", "v2session", "v2prompt", "resume", "wrapper", "queryoptions", "compare"].map(
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

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
