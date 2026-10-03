import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

const FIRST_PROMPT = "Create hello.js that prints hello, with the Write tool.";

// Part F: why a suggestion does not come, and what Claude Code drops. Read from the CLI's code (claude.exe of SDK
// 0.3.281): it is not a documented API and can change between versions.
const SKIPS: [string, string][] = [
  ["disabled", "promptSuggestions not true, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false, or promptSuggestionEnabled: false (the env var wins)"],
  ["early_conversation", "fewer than 2 assistant replies in the conversation (the 'first turn' rule: a tool call or a resumed history counts)"],
  ["aborted", "the next message is already queued, or the session is stopped"],
  ["plan_mode", "permissionMode is 'plan'"],
  ["last_response_error", "the last reply was an API error"],
  ["pending_permission, elicitation_active", "a permission prompt or an MCP elicitation is still open"],
  ["cache_cold: uncached", "the last reply had more than 10,000 uncached tokens (input + output)"],
  ["cache_cold: cache_write", "the last reply's uncached tokens plus its cache writes are over 10,000"],
  ["rate_limit", "the account is near or at its plan usage limit (the env var =true keeps them on near the limit, not at it)"],
];
const FILTERS: [string, string][] = [
  ["empty, done", "nothing, or just 'done'"],
  ["meta_text, meta_wrapped", "'nothing to suggest', 'silence', 'stay silent'…, or a text in (…) or […]: the model's way to say 'no suggestion'"],
  ["error_message", "starts like an API error ('api error:', 'prompt is too long'…)"],
  ["prefixed_label", "'Suggestion: …' (a label before a colon)"],
  ["too_few_words, too_many_words, too_long", "one word (except yes, ok, push, commit, deploy… or a /command), more than 12 words, 100 characters or more"],
  ["multiple_sentences, has_formatting", "two sentences, a new line or markdown"],
  ["evaluative", "thanks, looks good, perfect, great…"],
  ["claude_voice", "'Let me…', 'I'll…', 'Here's…', 'You should…': Claude speaking, not the user"],
];

// Part H: the summary table.
const SUMMARY: [string, string, string][] = [
  ["Turn it on", "promptSuggestions: true", "Sent in control_request/initialize, not as a CLI flag. Off by default"],
  ["What you get", "{ type: 'prompt_suggestion', suggestion, uuid, session_id }", "At most one per turn, about 1 s AFTER the result: keep reading the stream after result"],
  ["How it is made", "one more API call", "The whole conversation + a '[SUGGESTION MODE: …]' user message. Same model, system prompt and tools as the turn"],
  ["Not on turn 1", "fewer than 2 assistant replies", "A single prompt with a tool call already gets one; so does a resumed session"],
  ["Only when useful", "nothing queued, not plan mode", "A message already waiting cancels it; plan mode never gets one"],
  ["Filtered", "Claude Code drops weak answers", "'(silence)', 'thanks', too long, two sentences, Claude's voice… A dropped suggestion was still paid"],
  ["Switches", "option · env var · setting", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false/true beats promptSuggestionEnabled in settings (any layer)"],
  ["Cheap because cached", "the same prefix as the turn", "It reads the turn's prompt cache. If the last reply was mostly uncached (over 10,000 tokens), no call is made"],
  ["Where the cost goes", "the NEXT result's total_cost_usd", "The suggestion comes after its result, so it is billed in the next one; the last suggestion of a session is in none"],
  ["Use it", "a chip the user can accept", "Send it as the next user message, or put it in the input box. It is a prediction, not an instruction: never run it on your own"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype">{(d.at / 1000).toFixed(2)} s</span> : null);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const usd = (n: number) => `$${n.toFixed(6)}`;
const usage = (u: any) => (u ? `in ${u.input} · cache write ${u.cacheWrite} · cache read ${u.cacheRead} · out ${u.output}` : "");

function WireRow({ d }: { d: any }) {
  return (
    <div className={`tool-call wire ${d.kind === "suggestion" ? "suggest" : ""} ${d.status !== "done" ? "denied" : ""}`}>
      <span className={`tag ${d.kind === "suggestion" ? "tag-suggest" : "tag-wire"}`}>wire #{d.n} · {d.kind}</span> {t(d)}{" "}
      <span className="subtype">
        {d.model} · {d.messages} messages · {d.tools} tools · {d.status === "done" ? `${usage(d.usage)} · ${usd(d.cost)}` : d.status}
      </span>
      {d.text !== undefined && <div className="snippet">answered: {JSON.stringify(d.text)}</div>}
      {d.instruction && (
        <details>
          <summary className="hint">the SUGGESTION MODE message (its first lines)</summary>
          <pre className="wrap snippet">{d.instruction}</pre>
        </details>
      )}
    </div>
  );
}

function Chat({ events, open, onUse }: { events: Ev[]; open: boolean; onUse: (text: string, send: boolean) => void }) {
  // Which wire calls does each result's total_cost_usd add? The ones that finished since the previous result.
  let prevTotal = 0;
  let since: any[] = [];
  const lastSuggestion = events.map((e) => e.event).lastIndexOf("suggestion");
  const lastUser = events.map((e) => e.event).lastIndexOf("user");
  return (
    <div>
      {events.map(({ event, data }, i) => {
        if (event === "wire") since.push(data);
        if (event === "opened")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">options</span> {t(data)}
              <pre className="wrap snippet">{pretty(data.options)}</pre>
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> {t(data)} <span className="subtype">tools: {data.tools.join(", ")}</span>
            </div>
          );
        if (event === "user")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">user</span> {t(data)} {data.from === "suggestion" && <span className="subtype good">the suggestion, accepted</span>} {data.queued && <span className="subtype">queued: a turn is running</span>}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "assistant")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> {t(data)}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "toolUse")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">tool_use</span> <b>{data.name}</b> {t(data)}
              <div className="snippet">{data.input}</div>
            </div>
          );
        if (event === "toolResult")
          return (
            <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
              <span className="tag tag-user">tool_result</span> {t(data)}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "wire") return <WireRow key={i} d={data} />;
        if (event === "dropped")
          return (
            <div key={i} className="tool-call suggest denied">
              <span className="tag tag-suggest">no prompt_suggestion</span> {t(data)}
              <div className="hint">
                The suggestion call #{data.n} answered {JSON.stringify(data.text)}, and Claude Code's filters dropped it (Part F). The host is not told: the lab only knows because
                nothing came within 2 s. Type your own message, or end the chat.
              </div>
            </div>
          );
        if (event === "result") {
          const delta = data.total - prevTotal;
          const calls = since;
          prevTotal = data.total;
          since = [];
          const sum = calls.reduce((s, c) => s + (c.cost ?? 0), 0);
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result/{data.subtype}</span> {t(data)}{" "}
              <span className="subtype">
                total_cost_usd {usd(data.total)} · this result adds {usd(delta)}
              </span>
              <div className="hint">
                = the wire calls since the previous result: {calls.map((c) => `#${c.n} ${c.kind} ${usd(c.cost ?? 0)}`).join(" + ") || "none"} = {usd(sum)}
                {calls.some((c) => c.kind === "suggestion") && " · the previous turn's suggestion is billed here"}
              </div>
              {open && i === events.length - 1 && <div className="hint">waiting for a prompt_suggestion… (it comes after the result)</div>}
            </div>
          );
        }
        if (event === "suggestion")
          return (
            <div key={i} className="tool-call suggest">
              <span className="tag tag-suggest">prompt_suggestion</span> {t(data)}
              <div className="suggestion-chip">
                <span>{data.suggestion}</span>
                {open && i === lastSuggestion && i > lastUser && (
                  <>
                    <button className="primary" onClick={() => onUse(data.suggestion, true)}>
                      Send it
                    </button>
                    <button onClick={() => onUse(data.suggestion, false)}>Edit it</button>
                  </>
                )}
              </div>
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

function RowsTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>each turn</th>
          <th>the suggestion calls on the wire</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const calls = r.wire.filter((c: any) => c.kind === "suggestion");
          const last = r.wire.filter((c: any) => c.kind === "main").at(-1);
          return (
            <tr key={r.key}>
              <td>
                <b>{r.label}</b>
                <div>
                  <code>{r.shown}</code>
                </div>
              </td>
              <td>
                {r.turns.map((x: any) => (
                  <div key={x.n}>
                    turn {x.n} <span className="hint">({x.replies} repl{x.replies === 1 ? "y" : "ies"})</span> →{" "}
                    {x.suggestion ? <code className="good">{x.suggestion}</code> : <span className="hint">no suggestion</span>}
                  </div>
                ))}
              </td>
              <td>
                {calls.length ? (
                  calls.map((c: any) => (
                    <div key={c.n} className="snippet">
                      #{c.n} {c.status}: {JSON.stringify(c.text ?? "")} <span className="hint">{usage(c.usage)}</span>
                    </div>
                  ))
                ) : (
                  <span className="hint">none{last?.usage ? ` · the last turn's call: ${usage(last.usage)}` : ""}</span>
                )}
              </td>
              <td>
                <code className={/threw/.test(r.outcome) ? "bad" : ""}>total_cost_usd {usd(r.cost)}</code>
                <div className="hint">
                  wire {usd(r.wireCost)}
                  {r.wireCost - r.cost > 0.000001 && ` (+${usd(r.wireCost - r.cost)} never reported: the last suggestion or a late side call)`}
                </div>
                {/threw/.test(r.outcome) && <div className="snippet bad">{r.outcome}</div>}
                {r.note && <div className="hint">{r.note}</div>}
              </td>
            </tr>
          );
        })}
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

export function Concept38PromptSuggestions() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ part: string; text: string } | null>(null);
  const [cost, setCost] = useState(0);
  const [dry, setDry] = useState<any[]>([]);
  // Part B
  const [suggestOn, setSuggestOn] = useState(true);
  const [first, setFirst] = useState(FIRST_PROMPT);
  const [events, setEvents] = useState<Ev[]>([]);
  const [chatId, setChatId] = useState("");
  const [box, setBox] = useState("");
  // Parts C, D, E
  const [rows, setRows] = useState<Record<string, any[]>>({});

  const fail = () => setError("Could not reach /api/c38 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together; while the server is loading, Vite's proxy answers 502.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const c = await fetch("/api/c38/code").then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
        if (!stop) setCode(c), setError(null);
      } catch {
        if (stop) return;
        if (tries > 1) setTimeout(() => load(tries - 1), 1000);
        else fail();
      }
    };
    load();
    return () => void (stop = true);
  }, []);

  const PART: Record<string, string> = { dry: "A", chat: "B", when: "C", switches: "D", cache: "E" };
  const begin = (id: string, h: string) => (setRunning(id), setHint({ part: PART[id], text: h }), setError(null));
  const hintAt = (part: string) => hint?.part === part && <p className="hint">{hint.text}</p>;

  async function dryRun() {
    begin("dry", "Three setups, each passed to query() with a spawner that records the args and what the SDK writes to the process's stdin (Concept 36). No Claude Code, no API call.");
    try {
      const r = await fetch("/api/c38/dry", { method: "POST" }).then((x) => x.json());
      setDry(r.rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function startChat() {
    begin(
      "chat",
      "One streaming session (tools: Read, Write, Edit, Bash; Bash only for node, ls and cat). After each turn, watch the result, then the suggestion call on the wire, then the prompt_suggestion. Send the suggestion as your next message, or type your own. A suggestion like 'commit this' is denied: git is not an allowed tool. About $0.01 per turn.",
    );
    const got: Ev[] = [];
    setEvents([]);
    setBox("");
    try {
      await streamPost("/api/c38/chat", { promptSuggestions: suggestOn, first }, (event, data) => {
        if (event === "done") return;
        if (event === "opened") setChatId(data.chat);
        if (event === "wire") setCost((c) => c + (data.cost ?? 0)); // the wire sees every call, the last suggestion too
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
      setChatId("");
    }
  }

  async function send(text: string, from: "typed" | "suggestion") {
    const r = await fetch("/api/c38/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat: chatId, text, from }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    else setBox("");
  }
  const endChat = () => fetch("/api/c38/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat: chatId }) });

  async function runTable(route: "when" | "switches" | "cache", h: string) {
    begin(route, h);
    const got: any[] = [];
    setRows((r) => ({ ...r, [route]: [] }));
    try {
      await streamPost(`/api/c38/${route}`, {}, (event, data) => {
        if (event !== "row") return;
        got.push(data);
        got.sort((a, b) => a.order - b.order); // the order of the list, not the order they finished
        setRows((r) => ({ ...r, [route]: [...got] }));
        setCost((c) => c + (data.wireCost ?? 0));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const btn = (id: string, label: string, onClick: () => void) => (
    <button disabled={!!running} className={running === id ? "active" : ""} onClick={onClick}>
      {running === id ? "Running…" : label}
    </button>
  );
  const live = running === "chat" && !!chatId;

  return (
    <section>
      <h2>38 · Prompt suggestions</h2>
      <p className="lead">
        With <code>promptSuggestions: true</code>, Claude Code predicts what the user will type next. After each turn, it makes <b>one more API call</b> (the conversation plus a{" "}
        <code>[SUGGESTION MODE]</code> instruction), filters the answer, and sends a <code>prompt_suggestion</code> message <b>after the result</b>. Your app can show it as a chip the
        user accepts with one click, like the grey text in the Claude Code terminal.
      </p>
      <div className="row">
        <span className="subtype">spent ${cost.toFixed(4)} (every call on the wire)</span>
      </div>

      <h3>A · Where the option goes</h3>
      <div className="scenarios">{btn("dry", "1 · Dry run: the args and the initialize request", dryRun)}</div>
      {hintAt("A")}
      {dry.length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th>setup</th>
              <th>a CLI flag?</th>
              <th>control_request/initialize (stdin)</th>
            </tr>
          </thead>
          <tbody>
            {dry.map((r) => (
              <tr key={r.key}>
                <td>
                  <code>{r.shown}</code>
                </td>
                <td>{r.error ? <code className="bad">{r.error}</code> : r.flag.length ? <code>{r.flag.join(" ")}</code> : <span className="hint">none</span>}</td>
                <td>
                  <b>promptSuggestions: {String(r.value)}</b>
                  <div className="hint">
                    <code>{r.initialize}</code>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>B · A chat with suggestions</h3>
      <label className="check">
        <input type="checkbox" checked={suggestOn} disabled={!!running} onChange={(e) => setSuggestOn(e.target.checked)} /> promptSuggestions: {String(suggestOn)}
      </label>
      <label className="hint">the first message (the first turn has 2 replies here, a tool call and the answer, so it already gets a suggestion)</label>
      <textarea rows={2} maxLength={4000} value={first} disabled={!!running} onChange={(e) => setFirst(e.target.value)} />
      <div className="scenarios">
        {btn("chat", "2 · Start the chat", startChat)}
        {live && <button onClick={endChat}>End the chat (close the input)</button>}
      </div>
      {hintAt("B")}
      {(live || events.length > 0) && (
        <div className="card">
          <b>The session, the wire and the suggestions, in order</b> <span className="subtype">{live ? "open" : "ended"}</span>
          <Chat events={events} open={live} onUse={(text, now) => (now ? send(text, "suggestion") : setBox(text))} />
          {live && (
            <div className="row">
              <input className="inline-input wide" maxLength={4000} placeholder="your next message" value={box} onChange={(e) => setBox(e.target.value)} onKeyDown={(e) => e.key === "Enter" && box.trim() && send(box.trim(), "typed")} />
              <button className="primary" disabled={!box.trim()} onClick={() => send(box.trim(), "typed")}>
                Send
              </button>
              <button onClick={endChat}>End the chat</button>
            </div>
          )}
          {live && <p className="hint">The chat stays open until you end it (or 15 minutes pass). Parts C, D and E can run once it has ended.</p>}
        </div>
      )}

      <h3>C · When a suggestion comes</h3>
      <div className="scenarios">
        {btn("when", "3 · Seven conversations", () =>
          runTable("when", "Seven scripted sessions in parallel. Each waits up to 6 s after a result for the suggestion before sending the next turn (except 'already waiting'). The wire shows whether the suggestion call was even made. About $0.02."),
        )}
      </div>
      {hintAt("C")}
      {rows.when?.length > 0 && <RowsTable rows={rows.when} />}

      <h3>D · Who switches it off</h3>
      <div className="scenarios">
        {btn("switches", "4 · The same two turns, seven switches", () => runTable("switches", "Seven sessions in parallel, the same two turns. Only the switch changes. About $0.013."))}
      </div>
      {hintAt("D")}
      {rows.switches?.length > 0 && <RowsTable rows={rows.switches} />}

      <h3>E · Cost and the prompt cache</h3>
      <div className="scenarios">
        {btn("cache", "5 · Four sizes of conversation", () =>
          runTable("cache", "Four sessions in parallel. The suggestion call reads the turn's cache; when the last reply was mostly uncached, Claude Code does not make it. Compare the usage of the last turn's call. About $0.05."),
        )}
      </div>
      {hintAt("E")}
      {rows.cache?.length > 0 && <RowsTable rows={rows.cache} />}

      <h3>F · Why no suggestion came, and what Claude Code drops</h3>
      <p className="hint">
        Read from the CLI's code (<code>claude.exe</code> of SDK 0.3.281). None of this is in <code>sdk.d.ts</code>, so it can change between versions. The host is never told why: it just
        gets no <code>prompt_suggestion</code>.
      </p>
      <Pairs head={["skipped (no call)", "when"]} rows={SKIPS} />
      <Pairs head={["dropped (the call was paid)", "the answer is"]} rows={FILTERS} />

      <h3>G · The code</h3>
      <div className="row">
        {["options", "queue", "relay", "wire", "dry", "rows", "when", "switches", "cache"].map(
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

      <h3>H · Prompt suggestions, in one table</h3>
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
