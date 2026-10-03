import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Open = { run: string; id: string; serverName: string; message: string; mode: "form" | "url"; requestedSchema?: any; url?: string; timeoutMs: number; receivedAt: number };

// Part A: the server asks, you answer. Each one is a scenario for POST /run.
const partA: { id: string; label: string; hint: string }[] = [
  {
    id: "book",
    label: "1 · A form from the server",
    hint: "The model calls book_room with no details. The rooms server sends elicitation/create with a requestedSchema (room: enum, date: format date, attendees: integer 1–12, projector: boolean). Claude Code hands it to onElicitation, which WAITS for the card below. Try Accept, Decline and Cancel, and try 'Edit as JSON' + 'skip the host's check' with attendees: 50 to see the server refuse it (-32602). About $0.01.",
  },
  {
    id: "cancel",
    label: "2 · The server asks to confirm",
    hint: "One booking already exists (a1b2c3). cancel_booking asks YOU to confirm and give a reason, even though allowedTools lets the tool run without a permission prompt. Leave the box unticked, or decline, and the booking stays: the server decides from your answer, not from the model. About $0.01.",
  },
  {
    id: "calendar",
    label: "3 · Sign in on a web page (URL mode)",
    hint: "connect_calendar wants a URL elicitation (the user signs in on the server's own page). Claude Code 2.1.281 does not declare elicitation.url, so the server checks the capabilities and falls back to a form that carries the link. Open the link, allow or deny, then tick the box: the server asks its page what really happened. About $0.01.",
  },
];

// Part B: the host's side.
const partB: { id: string; label: string; hint: string }[] = [
  {
    id: "policy",
    label: "4 · A hook rewrites your answer",
    hint: "settings.hooks.ElicitationResult runs a COMMAND hook (elicit-hooks/hook.mjs policy) after you answer: more than 6 attendees must use Madrid. Answer Roma with 8 attendees and compare 'host sent' with 'server got' in the host check. SDK callback hooks on both events also run: they see everything, but their answer would be ignored. About $0.01.",
  },
];

// Part D: what you answer, and what the server gets.
const table: [string, string, string][] = [
  ["Accept", "{ action: 'accept', content: { room: 'Roma', … } }", "elicitInput() returns it. The MCP SDK checks content against requestedSchema; a mismatch throws -32602 inside the tool"],
  ["Decline", "{ action: 'decline' }", "The user said no. The tool decides what to do (here: book nothing, tell the model)"],
  ["Cancel", "{ action: 'cancel' }", "The user dismissed the form. The lab's host timeout also sends cancel"],
  ["No onElicitation", "—", "Claude Code declines every elicitation at once: the tool gets { action: 'decline' }"],
  ["Nobody answers", "(onElicitation can wait for ever)", "The SERVER's request timeout fires (-32001) and Claude Code aborts onElicitation's signal. The lab's own 2-minute limit sends cancel first"],
  ["Command hook: Elicitation", "stdout: { hookSpecificOutput: { hookEventName: 'Elicitation', action, content } }", "Answers the form itself: onElicitation is NOT called"],
  ["Command hook: ElicitationResult", "stdout: { hookSpecificOutput: { hookEventName: 'ElicitationResult', action, content } }", "Rewrites the answer after onElicitation, before the server gets it"],
  ["SDK callback hook (Options.hooks)", "return { hookSpecificOutput: { … } }", "Called with the full input (server, message, schema, the answer), but in 2.1.281 its answer is ignored"],
  ["URL mode", "elicitInput({ mode: 'url', url, elicitationId })", "Only if the client declares elicitation.url. Claude Code 2.1.281 declares form only, so the server must check and fall back"],
  ["In-process sdk server", "createSdkMcpServer + elicitInput()", "“Client does not support form elicitation”: only external (stdio/http) servers can elicit"],
];

// ---------------------------------------------------------------------------------------------

/** The initial value of each field, from the schema's defaults. */
function initialValues(schema: any) {
  const v: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<any>(schema?.properties ?? {})) if (p.default !== undefined) v[k] = p.default;
  return v;
}

/** Turns URLs inside the server's message into links. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/\S+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Field({ name, p, required, value, onChange }: { name: string; p: any; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const label = (
    <label htmlFor={`f-${name}`}>
      {p.title ?? name}
      {required && " *"} <span className="subtype">{name}: {p.type}{p.format ? ` (${p.format})` : ""}{p.enum ? " enum" : ""}</span>
    </label>
  );
  let input;
  if (p.type === "boolean")
    input = (
      <label className="check">
        <input id={`f-${name}`} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> <span>{p.description ?? "yes"}</span>
      </label>
    );
  else if (p.enum)
    input = (
      <select id={`f-${name}`} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(choose)</option>
        {p.enum.map((o: string) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  else if (p.type === "integer" || p.type === "number")
    input = <input id={`f-${name}`} type="number" min={p.minimum} max={p.maximum} step={p.type === "integer" ? 1 : "any"} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  else input = <input id={`f-${name}`} type={p.format === "date" ? "date" : p.format === "email" ? "email" : "text"} maxLength={p.maxLength} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)} />;
  return (
    <div className="elicit-field">
      {label}
      {input}
      {p.description && p.type !== "boolean" && <p className="hint">{p.description}</p>}
    </div>
  );
}

/** The host's form: what Claude Code would show in the terminal, rendered by your own UI from requestedSchema. */
function FormCard({ open }: { open: Open }) {
  const schema = open.requestedSchema ?? { properties: {} };
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(schema));
  const [asJson, setAsJson] = useState(false);
  const [json, setJson] = useState("");
  const [skipCheck, setSkipCheck] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((open.receivedAt + open.timeoutMs - now) / 1000));
  const required: string[] = schema.required ?? [];

  async function send(action: "accept" | "decline" | "cancel") {
    setErrors([]);
    const body: any = { run: open.run, id: open.id, action };
    if (action === "accept" && open.mode === "form") {
      if (asJson) {
        try {
          body.content = JSON.parse(json);
        } catch {
          return setErrors(["The JSON does not parse."]);
        }
      } else body.content = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      if (skipCheck) body.skipCheck = true;
    }
    setSending(true);
    try {
      const r = await fetch("/api/c33/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return setErrors(j.errors ?? [j.error ?? `HTTP ${r.status}`]);
      // The card closes when the "answer" event comes back on the run's stream.
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card permission elicit-card">
      <b>{open.serverName} asks you</b>{" "}
      <span className="subtype">
        onElicitation is waiting · form #{open.id} · mode {open.mode} · the host gives up in {left} s
      </span>
      <div className="elicit-message">
        <Linked text={open.message} />
      </div>
      {open.mode === "url" && open.url && (
        <p>
          <a href={open.url} target="_blank" rel="noreferrer">
            {open.url}
          </a>
        </p>
      )}
      {open.mode === "form" &&
        (asJson ? (
          <textarea rows={6} value={json} onChange={(e) => setJson(e.target.value)} aria-label="content as JSON" />
        ) : (
          Object.entries<any>(schema.properties ?? {}).map(([k, p]) => <Field key={k} name={k} p={p} required={required.includes(k)} value={values[k]} onChange={(v) => (setErrors([]), setValues((o) => ({ ...o, [k]: v })))} />)
        ))}
      {errors.length > 0 && (
        <ul className="elicit-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={sending} onClick={() => send("accept")} title="{ action: 'accept', content }">
          Accept
        </button>
        <button disabled={sending} onClick={() => send("decline")} title="{ action: 'decline' }: the user said no">
          Decline
        </button>
        <button disabled={sending} onClick={() => send("cancel")} title="{ action: 'cancel' }: the user dismissed the form">
          Cancel
        </button>
        {open.mode === "form" && (
          <button
            onClick={() => {
              if (!asJson) setJson(JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)), null, 2));
              setAsJson(!asJson);
            }}
          >
            {asJson ? "Back to the form" : "Edit as JSON"}
          </button>
        )}
      </div>
      {open.mode === "form" && (
        <label className="check">
          <input type="checkbox" checked={skipCheck} onChange={(e) => setSkipCheck(e.target.checked)} /> <span>skip the host's check (send content that breaks the schema, and let the server refuse it)</span>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v));

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "init":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/init</span> <code>{data.model}</code>{" "}
                {data.mcp_servers.map((s: any) => (
                  <code key={s.name} className={s.status === "connected" ? "" : "bad"}>
                    {s.name}: {s.status}{" "}
                  </code>
                ))}
                {t}
                <div className="snippet">{data.tools.join(", ")}</div>
              </div>
            );
          case "server":
            return (
              <div key={i} className={`tool-call server ${data.method.includes("error") ? "denied" : ""}`}>
                <span className="tag tag-mcp-stdio">rooms server (pid {data.pid})</span> <code>{data.method}</code> {t}
                {data.detail !== undefined && <pre className="wrap tur">{json(data.detail)}</pre>}
              </div>
            );
          case "form":
            return (
              <div key={i} className="tool-call elicit">
                <span className="tag tag-call">onElicitation</span> <code>{data.serverName}</code> <span className="subtype">form #{data.id} · mode {data.mode} · waiting for you…</span> {t}
                <div className="snippet">{data.message}</div>
                {data.requestedSchema && <pre className="wrap tur">requestedSchema: {json(data.requestedSchema)}</pre>}
              </div>
            );
          case "answer":
            return (
              <div key={i} className={`tool-call call ${data.result.action === "accept" ? "" : "denied"}`}>
                <span className="tag tag-call">host → ElicitationResult</span> <code>{data.result.action}</code> <span className="subtype">by {data.how}</span> {t}
                <pre className="wrap tur">{json(data.result)}</pre>
              </div>
            );
          case "callbackHook":
            return (
              <div key={i} className="tool-call call">
                <span className="tag tag-pre">SDK callback hook</span> <code>{data.event}</code> <span className="subtype">server {data.server} · returns {"{}"} (an answer here would be ignored)</span> {t}
                <div className="snippet">{data.event === "Elicitation" ? `sees the form: ${data.fields.join(", ")}` : `sees the answer: ${data.action} ${json(data.content)}`}</div>
              </div>
            );
          case "commandHook":
            return (
              <div key={i} className={`tool-call call ${data.answer ? "" : ""}`}>
                <span className="tag tag-post">command hook</span> <code>{data.event}</code> <span className="subtype">hook.mjs {data.mode}</span> {t}
                <div className="snippet">
                  {data.event === "ElicitationResult" && `got: ${data.action} ${json(data.content)} → `}
                  {data.answer ? `answers: ${json(data.answer)}` : "no answer ({}): the answer goes on unchanged"}
                </div>
              </div>
            );
          case "consent":
            return (
              <div key={i} className={`tool-call server ${data.state === "granted" ? "" : "denied"}`}>
                <span className="tag tag-mcp-stdio">sign-in page</span> <code>{data.state}</code> <span className="subtype">{data.account ?? ""} · typed on the server's page, not in the form</span> {t}
              </div>
            );
          case "elicitationComplete":
            return (
              <div key={i} className="tool-call elicit">
                <span className="tag tag-system">system/elicitation_complete</span> <code>{data.server}</code> <span className="subtype">{data.elicitation_id}</span> {t}
              </div>
            );
          case "apiError":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">API error</span> <code className="bad">{data.error}</code> {t}
                <div className="snippet">
                  {data.text} — a synthetic assistant message written by Claude Code: the model never ran.
                  {data.error === "billing_error" && " Add credit to the account of ANTHROPIC_API_KEY (or use another key) and restart the server."}
                </div>
              </div>
            );
          case "assistant":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-assistant">assistant</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-pre">tool_use {data.name}</span> {t}
                <div className="snippet">{data.input}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> <code>{data.name}</code> {data.is_error && <code className="bad">is_error</code>} {t}
                <div className="snippet">{data.text || "(empty)"}</div>
              </div>
            );
          case "result":
            return (
              <div key={i} className={`tool-call ${data.is_error || data.apiError ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                {data.apiError && <code className="bad"> but the API failed: {data.apiError}</code>}
                <span className="subtype">
                  num_turns {data.num_turns} · ${data.cost?.toFixed(4)}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "check":
            return <Check key={i} data={data} />;
          case "error":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">error</span>
                <div className="snippet">{data.message}</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

const booking = (b: any) => `${b.id}: ${b.room} ${b.date}, ${b.attendees} people${b.projector ? ", projector" : ""}`;

function Check({ data }: { data: any }) {
  return (
    <div className="tool-call verdict">
      <span className="tag tag-verdict">host check</span>{" "}
      <span className="subtype">
        tools: {data.toolCalls.map((t: string) => t.replace("mcp__rooms__", "")).join(", ") || "none"} · {data.forms} form{data.forms === 1 ? "" : "s"} reached onElicitation
      </span>
      {data.apiError && <div className="snippet bad">The API refused the call ({data.apiError}): the model never ran.</div>}
      {!data.apiError && data.pairs.length === 0 && <div className="snippet bad">The rooms server never asked: the model did not call a tool that elicits.</div>}
      {data.pairs.map((p: any, i: number) => {
        const sent = p.sent ? `${p.sent.action} ${json(p.sent.content)}` : "(nothing: a hook answered)";
        const got = p.got.action === "error" ? `error: ${p.got.message}` : `${p.got.action} ${json(p.got.content)}`;
        const changed = p.sent && p.got.action !== "error" && (p.sent.action !== p.got.action || json(p.sent.content) !== json(p.got.content));
        return (
          <div key={i} className={`snippet ${p.got.action === "error" || changed ? "bad" : ""}`}>
            #{i + 1} host sent: {sent} · server got: {got}
            {changed && " · CHANGED on the way (an ElicitationResult hook)"}
          </div>
        );
      })}
      {data.added.map((b: any) => (
        <div key={b.id} className="snippet">
          booked: {booking(b)}
        </div>
      ))}
      {data.removed.map((b: any) => (
        <div key={b.id} className="snippet">
          cancelled: {booking(b)}
        </div>
      ))}
      {!data.apiError && data.added.length === 0 && data.removed.length === 0 && <div className="snippet">The bookings did not change.</div>}
    </div>
  );
}

function WhoTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>options</th>
          <th>onElicitation called</th>
          <th>hook</th>
          <th>the server got</th>
          <th>booked</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>
              <code>{r.shown}</code>
            </td>
            <td>{r.handlerCalled ? "yes" : "no"}</td>
            <td>{r.commandHook ? "command hook answered" : r.callbackCalled ? "callback called, answer ignored" : ""}</td>
            <td>
              {r.error ? (
                <code className="bad">{String(r.error).replace("Claude Code returned an error result: ", "")}</code>
              ) : r.serverGot === undefined ? (
                <code>the model did not call book_room</code>
              ) : (
                <>
                  <code className={r.serverGot === "accept" ? "" : "bad"}>{r.serverGot}</code>
                  {r.serverError && <div className="hint">{r.serverError}</div>}
                </>
              )}
            </td>
            <td className="hint">{r.booked ? booking(r.booked) : r.serverGot === "accept" && r.label.startsWith("in-process") ? "(an sdk server keeps no file here)" : ""}</td>
            <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept33McpElicitation() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [options, setOptions] = useState<{ prompt: string; options: any; bookings: any[] } | null>(null);
  const [whoRows, setWhoRows] = useState<any[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Book a room for a design review with 3 people, and show me all bookings afterwards.");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c33/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c33 — is this sample's server running on port 3001?"));
  }, []);

  async function run(label: string, body: any, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    setOpen(null);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c33/run", body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data);
        if (event === "form") setOpen({ ...data, receivedAt: Date.now() });
        if (event === "answer") setOpen((o) => (o && o.id === data.id ? null : o));
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
      setOpen(null);
    }
  }

  async function who() {
    setRunning("who");
    setError(null);
    const rows: any[] = [];
    setWhoRows([]);
    try {
      await streamPost("/api/c33/who", {}, (event, data) => {
        if (event === "whoRow") setWhoRows((rows.push(data), [...rows]));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = events.filter((e) => e.event === "result").reduce((s, e) => s + (e.data.cost ?? 0), 0);
  const forms = events.filter((e) => e.event === "form").length;
  const button = (s: { id: string; label: string; hint: string }) => (
    <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, { scenario: s.id }, s.hint)}>
      {s.label}
    </button>
  );

  return (
    <section>
      <h2>33 · MCP elicitation</h2>
      <p className="lead">
        An MCP tool can stop halfway and <b>ask the user</b>: the server sends <code>elicitation/create</code> with a message and a JSON schema, Claude Code
        passes it to <b>your</b> <code>onElicitation</code>, and your UI shows the form. The answer goes straight back to the server. The model never sees the
        form, only what the tool returns. This tab is that host, for the lab's <code>rooms</code> MCP server (stdio).
      </p>

      <h3>A · The server asks, you answer</h3>
      <div className="row">
        <button disabled={!!running} className={running === "who" ? "active" : ""} onClick={who}>
          {running === "who" ? "Checking…" : "0 · Who answers the form?"}
        </button>
        <span className="subtype">the same book_room call in 5 setups, in parallel · about $0.03</span>
      </div>
      {whoRows.length > 0 && <WhoTable rows={whoRows} />}
      <div className="scenarios">{partA.map(button)}</div>

      <h3>B · The host has a say too</h3>
      <p className="hint">
        Hooks run around <code>onElicitation</code>: an <code>Elicitation</code> hook can answer before any person sees the form, an{" "}
        <code>ElicitationResult</code> hook can change the answer after. Only <b>command</b> hooks (a program in <code>settings.hooks</code>) can do that in
        this version.
      </p>
      <div className="scenarios">{partB.map(button)}</div>

      <div className="card config">
        <label>your own job (the agent has only the rooms server's tools: book_room, cancel_booking, connect_calendar, list_bookings, client_capabilities; one booking, a1b2c3, exists)</label>
        <textarea rows={3} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%" }} />
        <div className="row">
          <button className="primary" disabled={!!running || !prompt.trim()} onClick={() => run("custom", { scenario: "custom", prompt }, null)}>
            {running === "custom" ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {open && <FormCard key={`${open.run}:${open.id}`} open={open} />}
      {(events.length > 0 || running) && running !== "who" && (
        <div className="card">
          <b>Events</b>{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · {forms} form{forms === 1 ? "" : "s"} · ${cost.toFixed(4)}
          </span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
          <pre className="wrap">bookings at the start: {JSON.stringify(options.bookings)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {Object.keys(code).map((r) => (
          <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
            code: {r}
          </button>
        ))}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>D · What you answer, and what the server gets</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>You</th>
            <th>The host returns</th>
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
