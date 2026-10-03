import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Option = { label: string; description: string; preview?: string };
type Question = { question: string; header: string; multiSelect: boolean; options: Option[] };
type Open = { run: string; id: string; questions: Question[]; timeoutMs: number; receivedAt: number; format: "markdown" | "html" };

// Part A: how the model asks, and what you answer. Each one is a scenario for POST /run.
const partA: { id: string; label: string; hint: string }[] = [
  {
    id: "ask",
    label: "1 · Ask me, then write",
    hint: "The prompt asks for a poem, and tells the model to ask two questions first. The model calls AskUserQuestion; Claude Code sends it to canUseTool, which WAITS until you answer in the card below. Your answer goes back as updatedInput.answers. Try Skip, Cancel, a note, or your own text under “Other”: each one gives the model a different tool_result. About $0.02.",
  },
  {
    id: "multi",
    label: "2 · Multi-select",
    hint: "One question has multiSelect: true, so the card shows checkboxes. Several labels go back as ONE string, joined with “, ” (that is the format the tool expects). About $0.02.",
  },
  {
    id: "preview",
    label: "3 · Options with HTML previews",
    hint: "toolConfig: { askUserQuestion: { previewFormat: 'html' } } tells the model to put an HTML fragment in each option's `preview`. The card renders it in a sandboxed iframe (no scripts). The default format is 'markdown'. About $0.03.",
  },
  {
    id: "unprompted",
    label: "4 · Not asked to ask",
    hint: "“Write a poem to poem.txt.” leaves the topic and form open, but the model just picks. In the probes, neither Haiku 4.5 nor Sonnet 5 asked, even with a system prompt that told them to ask when a choice is open. If you want questions, say so in the prompt. About $0.01.",
  },
];

// Part B: answers that come from the host, not from a person.
const partB: { id: string; label: string; hint: string }[] = [
  {
    id: "hook",
    label: "5 · A hook answers",
    hint: "The same poem job. A PreToolUse hook (matcher: AskUserQuestion) picks from saved preferences and returns permissionDecision: 'allow' with updatedInput.answers. canUseTool is NOT called for this call, and no card appears. Useful for tests, bots, or a “remember my choice” feature. About $0.02.",
  },
  {
    id: "partial",
    label: "6 · A partial answer",
    hint: "Two questions, but the host answers only the first one. That is not an error: the tool_result lists one answer, and in the probes the model made up the other (the fruit varies between runs: “Apple”, “Pear”) and wrote it to the file. The host check flags it. This is why the lab's /answer route refuses an answer that misses a question. About $0.01.",
  },
];

// Part D: the answers you can send, and what the model gets.
const table: [string, string, string][] = [
  ["Pick an option", "allow, answers: { q: 'Limerick' }", "“Your questions have been answered: \"q\"=\"Limerick\". You can now continue…”"],
  ["Several options", "allow, answers: { q: 'Ham, Olives' }", "Same, with the labels joined by “, ”"],
  ["Your own text", "allow, answers: { q: 'about my cat' }", "“The user answered: … Read the answers carefully — they may request clarification…”"],
  ["A note", "allow, annotations: { q: { notes } }", "The same “The user answered” text, with “notes: …” after the answer"],
  ["Skip", "deny, message", "is_error: true, your message. The model goes on (here: with defaults)"],
  ["Cancel", "deny, message, interrupt: true", "“STOP what you are doing…”; result error_during_execution; query() throws"],
  ["Nobody answers", "(no limit: canUseTool can wait for minutes)", "The lab's own 2-minute timeout sends a deny"],
  ["A PreToolUse hook", "permissionDecision: 'allow', updatedInput", "Like an answer; canUseTool is not called"],
  ["No host at all", "no canUseTool, or permissionPrompts: 'none'", "The tool is not in the model's list: it asks in plain text instead"],
  ["bypassPermissions", "canUseTool is never called (the SDK warns)", "The tool stays in the list, but your dialog never sees the question"],
];

// ---------------------------------------------------------------------------------------------

function Preview({ html, format }: { html: string; format: "markdown" | "html" }) {
  // An HTML preview is written by the model: show it in a sandboxed iframe (no scripts, no same-origin access).
  if (format === "html") return <iframe className="ask-preview" sandbox="" srcDoc={html} title="option preview" />;
  return <pre className="ask-preview-md">{html}</pre>;
}

/** The host's "dialog": what Claude Code shows in the terminal, rendered by your own UI. */
function QuestionCard({ open }: { open: Open }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((open.receivedAt + open.timeoutMs - now) / 1000));

  const OTHER = "__other__";
  const answerOf = (q: Question) => {
    const p = picked[q.question] ?? [];
    return p.includes(OTHER) ? (other[q.question] ?? "").trim() : p.join(", ");
  };
  const complete = open.questions.every((q) => answerOf(q));
  const toggle = (q: Question, label: string) => {
    const p = picked[q.question] ?? [];
    const next = q.multiSelect && label !== OTHER ? (p.includes(label) ? p.filter((x) => x !== label) : [...p.filter((x) => x !== OTHER), label]) : [label];
    setPicked({ ...picked, [q.question]: next });
    if (label !== OTHER) setFocus({ ...focus, [q.question]: label });
  };

  async function send(action: "answer" | "skip" | "cancel") {
    setSending(true);
    setError(null);
    const body: any = { run: open.run, id: open.id, action };
    if (action === "answer") {
      body.answers = Object.fromEntries(open.questions.map((q) => [q.question, answerOf(q)]));
      const n = Object.entries(notes).filter(([, v]) => v.trim());
      if (n.length) body.notes = Object.fromEntries(n.map(([k, v]) => [k, v.trim()]));
    }
    try {
      const r = await fetch("/api/c31/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return setError(j.error ?? `HTTP ${r.status}`);
      // The card closes when the "answer" event comes back on the run's stream.
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card permission ask-card">
      <b>Claude is asking you</b> <span className="subtype">canUseTool(“AskUserQuestion”) is waiting · the host gives up in {left} s</span>
      {open.questions.map((q) => {
        const p = picked[q.question] ?? [];
        const shown = q.options.find((o) => o.label === (focus[q.question] ?? q.options.find((x) => x.preview)?.label));
        return (
          <div key={q.question} className="ask-q">
            <div>
              <span className="tag tag-ask">{q.header}</span> <b>{q.question}</b> {q.multiSelect && <span className="subtype">choose one or more</span>}
            </div>
            <div className={shown?.preview ? "ask-body with-preview" : "ask-body"}>
              <div>
                {q.options.map((o) => (
                  <label key={o.label} className="check ask-option" onMouseEnter={() => o.preview && setFocus({ ...focus, [q.question]: o.label })}>
                    <input type={q.multiSelect ? "checkbox" : "radio"} name={`${open.id}-${q.question}`} checked={p.includes(o.label)} onChange={() => toggle(q, o.label)} />
                    <span>
                      <b>{o.label}</b> <span className="hint">{o.description}</span>
                    </span>
                  </label>
                ))}
                <label className="check ask-option">
                  <input type={q.multiSelect ? "checkbox" : "radio"} name={`${open.id}-${q.question}`} checked={p.includes(OTHER)} onChange={() => toggle(q, OTHER)} />
                  <span>
                    <b>Other</b> <span className="hint">(added by the host, not by the model)</span>
                  </span>
                </label>
                {p.includes(OTHER) && <input placeholder="your own answer" maxLength={500} value={other[q.question] ?? ""} onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} />}
                <input className="ask-notes" placeholder="note (optional) → annotations[question].notes" maxLength={500} value={notes[q.question] ?? ""} onChange={(e) => setNotes({ ...notes, [q.question]: e.target.value })} />
              </div>
              {shown?.preview && (
                <div>
                  <span className="subtype">preview: {shown.label}</span>
                  <Preview html={shown.preview} format={open.format} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="row">
        <button className="primary" disabled={!complete || sending} onClick={() => send("answer")}>
          Submit
        </button>
        <button disabled={sending} onClick={() => send("skip")} title="deny with a message: the model goes on">
          Skip
        </button>
        <button disabled={sending} onClick={() => send("cancel")} title="deny with interrupt: true: the run stops">
          Cancel the job
        </button>
        {!complete && <span className="subtype">answer every question to submit</span>}
      </div>
      {error && <div className="snippet bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "init":
            return (
              <div key={i} className={`tool-call ${data.hasAsk ? "" : "denied"}`}>
                <span className="tag tag-system">system/init</span> <code>{data.model}</code>{" "}
                <span className="subtype">tools: {data.tools.join(", ")}</span> {t}
                {!data.hasAsk && <div className="snippet">AskUserQuestion is not in the list.</div>}
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
              <div key={i} className={`tool-call ${data.name === "AskUserQuestion" ? "ask" : ""}`}>
                <span className={`tag ${data.name === "AskUserQuestion" ? "tag-ask" : "tag-pre"}`}>tool_use {data.name}</span> {t}
                <div className="snippet">{data.input}</div>
              </div>
            );
          case "question":
            return (
              <div key={i} className="tool-call ask">
                <span className="tag tag-call">{data.answeredBy === "hook" ? "PreToolUse hook" : "canUseTool"}</span> <code>AskUserQuestion</code>{" "}
                <span className="subtype">{data.answeredBy ? `answered by the ${data.answeredBy}` : "waiting for your answer…"}</span> {t}
                {data.questions.map((q: Question) => (
                  <div key={q.question} className="snippet">
                    [{q.header}] {q.question} {q.multiSelect ? "(multiSelect)" : ""} → {q.options.map((o) => o.label + (o.preview ? " (+preview)" : "")).join(" | ")}
                  </div>
                ))}
              </div>
            );
          case "answer":
            return (
              <div key={i} className={`tool-call call ${data.result.behavior === "deny" ? "denied" : ""}`}>
                <span className="tag tag-call">host → {data.how === "hook" ? "hook output" : "PermissionResult"}</span> <code>{data.how}</code> {t}
                <pre className="wrap tur">{JSON.stringify(data.result)}</pre>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""} ${data.name === "AskUserQuestion" ? "ask" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> <code>{data.name}</code> {data.is_error && <code className="bad">is_error</code>} {t}
                <div className="snippet">{data.text || "(empty)"}</div>
                {data.tool_use_result && <pre className="wrap tur">tool_use_result: {JSON.stringify(data.tool_use_result)}</pre>}
              </div>
            );
          case "denied":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">canUseTool denied</span> <code>{data.tool}</code> {t}
              </div>
            );
          case "result":
            return (
              <div key={i} className={`tool-call ${data.is_error || data.apiError ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code>
                {data.apiError && <code className="bad"> but the API failed: {data.apiError}</code>}
                <span className="subtype">
                  num_turns {data.num_turns} · ${data.cost?.toFixed(4)}
                  {data.denials.length > 0 && ` · permission_denials: ${data.denials.join(", ")}`}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          case "check":
            return (
              <div key={i} className="tool-call verdict">
                <span className="tag tag-verdict">host check</span>{" "}
                <code className={data.unanswered || data.apiError ? "bad" : ""}>
                  {data.questions.length - data.unanswered}/{data.questions.length} questions answered
                </code>{" "}
                <span className="subtype">files written: {data.files.join(", ") || "none"}</span>
                {data.apiError ? (
                  <div className="snippet bad">The API refused the call ({data.apiError}): the model never ran, so this run shows nothing about AskUserQuestion.</div>
                ) : (
                  data.questions.length === 0 && <div className="snippet">The model asked nothing.</div>
                )}
                {data.questions.map((q: any, k: number) => (
                  <div key={k} className={`snippet ${q.answer === null ? "bad" : ""}`}>
                    {q.question} → {q.answer === null ? `no answer (${q.how}): anything the model says about it is made up` : `“${q.answer}” (${q.how})`}
                  </div>
                ))}
              </div>
            );
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

function ToolsTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>options</th>
          <th>AskUserQuestion in system/init</th>
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
            <td>{r.error ? <code className="bad">{r.error.replace("Claude Code returned an error result: ", "API error: ")}</code> : <code className={r.hasAsk ? "" : "bad"}>{r.hasAsk ? `yes (${r.toolCount} tools)` : `no (${r.toolCount} tools)`}</code>}</td>
            <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept31AskUserQuestion() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [options, setOptions] = useState<{ prompt: string; options: any } | null>(null);
  const [toolsRows, setToolsRows] = useState<any[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Plan a weekend trip for me and write it to trip.txt. Before planning, use the AskUserQuestion tool to ask me what you need to know (up to 3 questions).");
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c31/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c31 — is this sample's server running on port 3001?"));
  }, []);

  async function run(label: string, body: any, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    setOpen(null);
    const got: Ev[] = [];
    setEvents([]);
    let fmt: "markdown" | "html" = "markdown";
    try {
      await streamPost("/api/c31/run", body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") {
          fmt = data.options.toolConfig?.askUserQuestion?.previewFormat ?? "markdown";
          return setOptions(data);
        }
        if (event === "question" && !data.answeredBy) setOpen({ ...data, receivedAt: Date.now(), format: fmt });
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

  async function checkTools() {
    setRunning("tools");
    setError(null);
    const rows: any[] = [];
    setToolsRows([]);
    try {
      await streamPost("/api/c31/tools", {}, (event, data) => {
        if (event === "toolsRow") setToolsRows((rows.push(data), [...rows]));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = events.filter((e) => e.event === "result").reduce((s, e) => s + (e.data.cost ?? 0), 0);
  const asked = events.filter((e) => e.event === "question").length;
  const button = (s: { id: string; label: string; hint: string }) => (
    <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, { scenario: s.id }, s.hint)}>
      {s.label}
    </button>
  );

  return (
    <section>
      <h2>31 · AskUserQuestion</h2>
      <p className="lead">
        When a job leaves a choice open, the agent can stop and <b>ask you</b>: the built-in <code>AskUserQuestion</code> tool sends 1 to 4 multiple-choice
        questions. Claude Code does not show them: they reach <b>your</b> <code>canUseTool</code>, which renders them, waits for the answer, and returns it as{" "}
        <code>updatedInput.answers</code>. This tab is that host: a live question card, multi-select, previews, skip and cancel, a hook that answers for you,
        and what goes wrong with a partial answer.
      </p>

      <h3>A · The agent asks, you answer</h3>
      <div className="row">
        <button disabled={!!running} className={running === "tools" ? "active" : ""} onClick={checkTools}>
          {running === "tools" ? "Checking…" : "0 · Which setups get AskUserQuestion?"}
        </button>
        <span className="subtype">6 short turns in parallel (“Reply ok”) · about $0.03</span>
      </div>
      {toolsRows.length > 0 && <ToolsTable rows={toolsRows} />}
      <div className="scenarios">{partA.map(button)}</div>

      <h3>B · The host answers</h3>
      <p className="hint">
        An answer does not have to come from a person. A <code>PreToolUse</code> hook can answer, and so can your own code, but the model trusts whatever it
        gets, including an answer that is missing.
      </p>
      <div className="scenarios">{partB.map(button)}</div>

      <div className="card config">
        <label>your own job (the agent works in a fresh, empty folder; it has Read, Write and AskUserQuestion)</label>
        <textarea rows={3} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%" }} />
        <div className="row">
          <span className="subtype">previewFormat</span>
          <label className="check">
            <input type="radio" checked={format === "markdown"} onChange={() => setFormat("markdown")} /> markdown
          </label>
          <label className="check">
            <input type="radio" checked={format === "html"} onChange={() => setFormat("html")} /> html
          </label>
          <button className="primary" disabled={!!running || !prompt.trim()} onClick={() => run("custom", { scenario: "custom", prompt, previewFormat: format }, null)}>
            {running === "custom" ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {open && <QuestionCard key={`${open.run}:${open.id}`} open={open} />}
      {(events.length > 0 || running) && running !== "tools" && (
        <div className="card">
          <b>Events</b>{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · {asked} AskUserQuestion call{asked === 1 ? "" : "s"} · ${cost.toFixed(4)}
          </span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["options", "ask", "answer", "hook", "messages", "check"].map(
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

      <h3>D · What you send, and what the model gets</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>You</th>
            <th>canUseTool returns</th>
            <th>The model's tool_result</th>
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
