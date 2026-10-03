import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

// Part A: what each tool does, and where. From the probes in Tab42-Web-tools.md (Claude Code 2.1.281).
const HOW: [string, string, string][] = [
  ["Who does the work", "Anthropic's API: Claude Code makes a second API call with the server-side web_search tool", "Claude Code itself: it downloads the page on your machine (User-Agent: Claude-User)"],
  ["What the agent sees", "The hits (title + url) and that call's own summary of them", "Not the page: the answer of a small model (Haiku) to the prompt the agent wrote, about the page as Markdown"],
  ["Cost", "$10 per 1,000 searches (modelUsage[model].webSearchRequests) + the tokens of the second call", "Only tokens: the small model's call. No fee for the download"],
  ["Rules it follows", "allowed_domains / blocked_domains in its input", "https only (http is upgraded), no localhost, same-host redirects only, long pages cut, a cache per process"],
  ["How the host controls it", "PreToolUse hook: updatedInput (force allowed_domains), deny, count", "Permission rules WebFetch(domain:…) + permissionMode, PreToolUse deny, PostToolUse updatedToolOutput"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype" title="time since the start of the run">@ {(d.at / 1000).toFixed(1)} s</span> : null);
const num = (n?: number) => (n === undefined ? "" : n.toLocaleString("en-US")); // 296,672, whatever the browser's locale
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s); // "…" only when something was cut
const usd = (n?: number) => (n === undefined ? "" : `$${n.toFixed(4)}`);
const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

function Hits({ hits }: { hits: { title: string; url: string }[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? hits : hits.slice(0, 4);
  return (
    <ul className="files">
      {shown.map((h) => (
        <li key={h.url}>
          <a href={h.url} target="_blank" rel="noreferrer">
            {h.title}
          </a>{" "}
          <code className="uuid">{host(h.url)}</code>
        </li>
      ))}
      {hits.length > 4 && (
        <li>
          <button className="link" onClick={() => setAll(!all)}>
            {all ? "fewer" : `+${hits.length - 4} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

function ToolRow({ d }: { d: any }) {
  const i = d.input ?? {};
  if (d.name === "StructuredOutput")
    return (
      <div className="tool-call web-call">
        <span className="tag tag-result">StructuredOutput</span> <span className="snippet">the report (outputFormat, Concept 10)</span>
        {t(d)}
      </div>
    );
  return (
    <div className="tool-call web-call">
      <span className={`tag tag-${d.name === "WebSearch" ? "search" : "fetch"}`}>{d.name}</span>{" "}
      {d.name === "WebSearch" ? (
        <>
          <code>{i.query}</code>
          {i.allowed_domains && <code className="good"> allowed_domains: {JSON.stringify(i.allowed_domains)}</code>}
        </>
      ) : (
        <>
          <code>{i.url}</code>
          <div className="hint">prompt: "{i.prompt}"</div>
        </>
      )}
      {t(d)}
    </div>
  );
}

function ResultRow({ d }: { d: any }) {
  const o = d.output ?? {};
  if (d.name === "StructuredOutput") return null;
  if (o.error)
    return (
      <div className="tool-call denied">
        <span className="tag tag-error">{d.name} ✗</span> <span className="snippet">{o.error}</span>
        {t(d)}
      </div>
    );
  if (d.name === "WebSearch")
    return (
      <div className="tool-call web-result">
        <span className="tag tag-search">WebSearch →</span> {o.hits?.length ?? 0} hits for <code>{o.query}</code>
        <span className="subtype">search took {o.durationSeconds?.toFixed?.(1)} s</span>
        {t(d)}
        <Hits hits={o.hits ?? []} />
        {o.commentary && (
          <details className="thinking">
            <summary>the search call's own summary ({o.commentary.length} chars)</summary>
            <div className="thinking-text">{o.commentary}</div>
          </details>
        )}
      </div>
    );
  return (
    <div className="tool-call web-result">
      <span className="tag tag-fetch">WebFetch →</span>{" "}
      <code className={o.code >= 400 ? "bad" : o.code >= 300 ? "" : "good"}>
        {o.code} {o.codeText}
      </code>{" "}
      {/* Parallel fetches finish in any order: the URL says which call this result belongs to. */}
      <code className="uuid">{o.url}</code>{" "}
      <span className="subtype">
        {num(o.bytes)} bytes downloaded · fetch took {num(o.durationMs)} ms
      </span>
      {t(d)}
      <pre className="tur wrap">{o.result}</pre>
    </div>
  );
}

function CostCard({ d }: { d: any }) {
  return (
    <div className="card web-cost">
      <b>result/{d.subtype}</b> · {d.turns} turns · total_cost_usd <b>{usd(d.cost)}</b>
      {d.searchFee > 0 && <span className="subtype">of which {usd(d.searchFee)} is the search fee</span>}
      <table className="tools usage">
        <thead>
          <tr>
            <th>where</th>
            <th>input tokens</th>
            <th>output tokens</th>
            <th>web searches</th>
            <th>cost</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>result.usage</code> (the agent's own calls)
            </td>
            <td>{num(d.mainLoop.inputTokens)}</td>
            <td>{num(d.mainLoop.outputTokens)}</td>
            <td />
            <td />
          </tr>
          {d.models.map((m: any) => (
            <tr key={m.model}>
              <td>
                <code>modelUsage["{m.model}"]</code> (every call)
              </td>
              <td>{num(m.inputTokens)}</td>
              <td>{num(m.outputTokens)}</td>
              <td>{m.webSearchRequests}</td>
              <td>{usd(m.costUSD)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        The difference between the two input columns is the web tools' side calls: the search call, and the small model that read each page. They are not
        in <code>usage</code>, but they are in <code>modelUsage</code> and in the cost.
      </p>
      {d.denials?.length > 0 && (
        <p className="hint">
          <b>permission_denials:</b> {d.denials.map((x: any) => `${x.tool}(${x.input.url ?? x.input.query})`).join(", ")}
        </p>
      )}
    </div>
  );
}

function Trail({ events }: { events: Ev[] }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "prompt")
          return (
            <details key={i} className="tool-call">
              <summary>
                <span className="tag tag-user">prompt</span> <span className="snippet">{d.prompt.split("\n")[0].slice(0, 110)}…</span>
              </summary>
              <pre className="wrap tur">{d.prompt}</pre>
            </details>
          );
        if (event === "options")
          return (
            <details key={i} className="tool-call call">
              <summary>
                <span className="tag tag-call">options</span>{" "}
                <span className="snippet">{Object.keys(d).filter((k) => k !== "at" && k !== "systemPrompt").map((k) => `${k}: ${JSON.stringify(d[k])}`).join(" · ")}</span>
              </summary>
              {d.systemPrompt && <pre className="wrap tur">{d.systemPrompt}</pre>}
            </details>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> Claude Code {d.version} · tools: <code>{d.tools.join(", ")}</code>
              {t(d)}
            </div>
          );
        if (event === "tool") return <ToolRow key={i} d={d} />;
        if (event === "toolResult") return <ResultRow key={i} d={d} />;
        if (event === "wire")
          return (
            <div key={i} className="tool-call wire">
              <span className="tag tag-wire">mini web</span>{" "}
              <code>
                GET {d.host}
                {d.path}
              </code>{" "}
              → <code className={d.status >= 400 ? "bad" : ""}>{d.status}</code> <span className="subtype">{num(d.bytes)} bytes</span>
            </div>
          );
        if (event === "hook")
          return (
            <div key={i} className={`tool-call hook ${d.decision === "deny" || d.found?.length ? "denied" : ""}`}>
              <span className={`tag tag-${d.hook === "PreToolUse" ? "pre" : "post"}`}>
                {d.hook}({d.tool})
              </span>{" "}
              {d.decision && <code className={d.decision === "deny" ? "bad" : "good"}>{d.decision}</code>} {d.used && <span className="subtype">used {d.used}</span>}{" "}
              {d.url && <code className="uuid">{d.url}</code>}{" "}
              {d.reason && <span className="snippet">{d.reason}</span>}
              {d.after && !d.before && <code> → {JSON.stringify(d.after.allowed_domains)}</code>}
              {d.before && (
                <div className="snippet">
                  {JSON.stringify(d.before)} → {JSON.stringify(d.after)}
                </div>
              )}
              {d.found &&
                (d.found.length ? (
                  <div className="snippet">
                    redacted {d.found.length} line(s) before the model saw them: {d.found.map((f: string) => `"${f}"`).join(" ")}
                  </div>
                ) : (
                  <span className="subtype">nothing suspicious in the result</span>
                ))}
              {t(d)}
            </div>
          );
        if (event === "text")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "result") return <CostCard key={i} d={d} />;
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

function FetchTable({ table }: { table: any }) {
  return (
    <>
      <p className="hint">
        Every request had <code>User-Agent: {table.userAgent}</code> and <code>Accept: {table.accept}</code>.
      </p>
      <table className="tools compare">
        <thead>
          <tr>
            <th>URL the agent asked for</th>
            <th>calls</th>
            <th>requests the mini web saw</th>
            <th>what came back</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r: any) => (
            <tr key={r.url}>
              <td>
                <code>{r.url.replace(/:\d+/, ":…")}</code>
              </td>
              <td>{r.calls}</td>
              <td>{r.requests.length ? r.requests.map((x: string) => <div key={x}><code>{x}</code></div>) : <code className="bad">none</code>}</td>
              <td>
                {r.outputs.map((o: any, k: number) => (
                  <div key={k} className="snippet">
                    {o?.error ? <span className="bad">✗ {clip(o.error, 90)}</span> : `${o?.code} · ${num(o?.bytes)} B · ${clip(String(o?.result ?? "").replace(/\s+/g, " ").trim(), 110)}`}
                  </div>
                ))}
              </td>
              <td>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Lane({ lane, events }: { lane: string; events: Ev[] }) {
  const v = events.find((e) => e.event === "verdict")?.data;
  const fetched = events.find((e) => e.event === "toolResult" && e.data.name === "WebFetch")?.data;
  const hook = events.find((e) => e.event === "hook")?.data;
  const yes = (b: boolean, good: boolean) => <code className={b === good ? "good" : "bad"}>{b ? "yes" : "no"}</code>;
  return (
    <div className="card">
      <b>{LANE_LABEL[lane]}</b>
      {fetched && (
        <>
          <div className="hint">what WebFetch gave the agent:</div>
          <pre className="tur wrap">{fetched.output?.result}</pre>
        </>
      )}
      {hook && (
        <div className="hint">
          PostToolUse: {hook.found.length ? <b className="bad">redacted {hook.found.length} line(s)</b> : "found nothing"}
        </div>
      )}
      {v && (
        <>
          <table className="tools usage">
            <tbody>
              <tr>
                <td>the injected review reached the agent</td>
                <td>{yes(v.injectionInToolResult, false)}</td>
              </tr>
              <tr>
                <td>the HTML comment reached it</td>
                <td>{yes(v.commentSurvived, false)}</td>
              </tr>
              <tr>
                <td>the answer quotes the review to the user</td>
                <td>{yes(v.answerQuotesIt, false)}</td>
              </tr>
              <tr>
                <td>the answer obeys it ("1 EUR" or "password", outside the quote)</td>
                <td>{yes(v.answerObeysIt, false)}</td>
              </tr>
            </tbody>
          </table>
          <div className="answer thin">{v.answer}</div>
          <span className="subtype">{usd(v.cost)}</span>
        </>
      )}
      {!v && <span className="hint">Running…</span>}
    </div>
  );
}
const LANE_LABEL: Record<string, string> = {
  summary: "a · a question (no guard)",
  verbatim: "b · the reviews word for word (no guard)",
  guarded: "c · b + a PostToolUse guard",
};

const statusClass = (s: string) => (s === "fetched" ? "good" : s === "search hit" ? "" : "bad");

function Report({ r }: { r: any }) {
  const rep = r.report;
  const budget = r.used;
  return (
    <div className="card research-report">
      <div className="row">
        <span className="tag tag-result">report</span>
        <span className="subtype">
          {r.model} · {r.depth} · {r.domains.length ? `domains: ${r.domains.join(", ")}` : "any domain"}
        </span>
      </div>
      <p>
        <b>Q:</b> {r.question}
      </p>
      {rep ? (
        <>
          <div className="answer">{rep.answer}</div>
          <h4>Findings, with every citation checked against what the tools returned</h4>
          <table className="tools compare">
            <thead>
              <tr>
                <th>claim</th>
                <th>confidence</th>
                <th>sources</th>
              </tr>
            </thead>
            <tbody>
              {r.checks.map((c: any, i: number) => (
                <tr key={i}>
                  <td>{c.claim}</td>
                  <td>
                    <code>{c.confidence}</code>
                  </td>
                  <td>
                    {c.sources.map((s: any) => (
                      <div key={s.url}>
                        <code className={statusClass(s.status)}>{s.status}</code>{" "}
                        <a href={s.url} target="_blank" rel="noreferrer" className="snippet">
                          {s.url}
                        </a>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            <code className="good">fetched</code>: the agent read that page (WebFetch, 200). <code>search hit</code>: it only saw a title and a URL.{" "}
            <code className="bad">never seen</code>: no tool returned that URL in this run.
          </p>
          {rep.openQuestions?.length > 0 && (
            <>
              <h4>Open questions</h4>
              <ul className="files">
                {rep.openQuestions.map((q: string) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className="hint">
          No report: the run ended with <code>{r.run.subtype}</code>. {r.run.text}
        </p>
      )}
      <h4>Budget</h4>
      <div className="grid2">
        <div>
          searches {budget.searches} / {budget.limits.searches}
          <div className="meter">
            <div style={{ width: `${Math.min(100, (budget.searches / budget.limits.searches) * 100)}%` }} />
          </div>
          fetches {budget.fetches} / {budget.limits.fetches}
          <div className="meter">
            <div style={{ width: `${Math.min(100, (budget.fetches / budget.limits.fetches) * 100)}%` }} />
          </div>
        </div>
        <div>
          cost {usd(r.run.cost)} / maxBudgetUsd ${budget.maxBudgetUsd}
          <div className="meter">
            <div style={{ width: `${Math.min(100, (r.run.cost / budget.maxBudgetUsd) * 100)}%` }} />
          </div>
          <span className="subtype">
            {r.run.turns} turns · search fee {usd(r.run.searchFee)} · models: {r.run.models.map((m: any) => m.model).join(", ")}
          </span>
        </div>
      </div>
      <details className="thinking">
        <summary>The sources ledger: every URL the tools returned ({r.sources.length})</summary>
        <ul className="files">
          {r.sources.map((s: any) => (
            <li key={s.url}>
              <code className={statusClass(s.how)}>{s.how}</code> <span className="snippet">{s.url}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function Concept42WebTools() {
  const [facts, setFacts] = useState<any>(null);
  const [waiting, setWaiting] = useState(false); // the server is still starting
  const [code, setCode] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);

  const [question, setQuestion] = useState("What is the current Active LTS version of Node.js?");
  const [basics, setBasics] = useState<Ev[]>([]);
  const [fetchEvents, setFetchEvents] = useState<Ev[]>([]);
  const [fetchTable, setFetchTable] = useState<any>(null);
  const [lanes, setLanes] = useState<Record<string, Ev[]>>({});
  const [guard, setGuard] = useState<Ev[]>([]);
  const [research, setResearch] = useState({ question: "What is the Model Context Protocol, who created it, and when was it released?", depth: "quick", model: "haiku", domains: "" });
  const [researchEvents, setResearchEvents] = useState<Ev[]>([]);
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    // The server needs a few seconds to start (and restarts when a file changes, node --watch). Until it answers, Vite
    // returns 502: try again every 1.5 s for up to 45 s, instead of leaving Parts A, C and G empty.
    let stopped = false;
    const get = async (url: string) => {
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) return r.json();
          if (![502, 503, 504].includes(r.status) || i >= 30) throw new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`);
        } catch (e) {
          if (i >= 30 || !(e instanceof TypeError)) throw e; // TypeError: no connection at all
        }
        if (stopped) throw new Error("unmounted");
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    const done = () => !stopped && setWaiting(false);
    get("/api/c42/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(done);
    get("/api/c42/code").then((c) => !stopped && setCode(c)).catch(() => {});
    get("/api/c42/state").then((s) => !stopped && setReport(s)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, body: unknown, onEvent: (event: string, data: any) => void) {
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done") onEvent(event, data);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }

  const collect = (set: (f: (p: Ev[]) => Ev[]) => void) => (event: string, data: any) => set((p) => [...p, { event, data }]);

  function startBasics() {
    setBasics([]);
    run("basics", "/api/c42/basics", { question }, collect(setBasics));
  }
  function startFetchLab() {
    setFetchEvents([]);
    setFetchTable(null);
    run("fetch", "/api/c42/fetch-lab", {}, (event, data) => (event === "table" ? setFetchTable(data) : setFetchEvents((p) => [...p, { event, data }])));
  }
  function startInjection() {
    const all = ["summary", "verbatim", "guarded"];
    setLanes(Object.fromEntries(all.map((l) => [l, []])));
    run("injection", "/api/c42/injection", { lanes: all }, (event, data) => data.lane && setLanes((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] })));
  }
  function startGuard() {
    setGuard([]);
    run("guard", "/api/c42/guard", {}, collect(setGuard));
  }
  function startResearch() {
    setResearchEvents([]);
    setReport(null);
    const domains = research.domains.split(/[\s,]+/).filter(Boolean);
    run("research", "/api/c42/research", { ...research, domains }, (event, data) => (event === "report" ? setReport(data) : setResearchEvents((p) => [...p, { event, data }])));
  }

  const btn = (key: string, label: string, onClick: () => void, disabled = false) => (
    <button className={running === key ? "active" : ""} onClick={onClick} disabled={!!running || disabled}>
      {running === key ? "Running…" : label}
    </button>
  );
  const guardCheck = guard.find((e) => e.event === "check")?.data;

  return (
    <section>
      <h2>42 · Web tools: a research agent with WebSearch and WebFetch</h2>
      <p className="lead">
        Two built-in tools give an agent the web. <code>WebSearch</code> runs a search on Anthropic's side and returns titles and URLs.{" "}
        <code>WebFetch</code> downloads a page on your machine and returns what a small model answered about it. This lab looks at both from the inside, runs them
        against a tiny HTTPS site it controls (the "mini web"), guards them with permission rules and hooks, and ends with a research agent that cites its sources.
      </p>
      <div className="card">
        <pre>{`const q = query({
  prompt: "Which Node.js version is the current Active LTS?",
  options: {
    tools: ["WebSearch", "WebFetch"],                    // the web tools, and nothing else
    allowedTools: ["WebSearch", "WebFetch(domain:nodejs.org)"],
    permissionMode: "dontAsk",                            // a fetch outside nodejs.org is denied
    outputFormat: { type: "json_schema", schema },        // a report with findings and their URLs
    maxBudgetUsd: 0.15,
  },
});`}</pre>
      </div>

      {waiting && !facts && (
        <div className="card warn">
          Waiting for the server on port 3001 to start… (the tab retries on its own)
        </div>
      )}

      <h3>A · The two tools</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th />
            <th>WebSearch</th>
            <th>WebFetch</th>
          </tr>
        </thead>
        <tbody>
          {HOW.map((r) => (
            <tr key={r[0]}>
              <td>
                <b>{r[0]}</b>
              </td>
              <td>{r[1]}</td>
              <td>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {facts && (
        <>
          <p className="hint">
            Their input and output types, read now from <code>sdk-tools.d.ts</code>. The output is what arrives in <code>tool_use_result</code> on the{" "}
            <code>user</code> message that carries the tool result.
          </p>
          <div className="grid2">
            {["WebSearchInput", "WebFetchInput", "WebSearchOutput", "WebFetchOutput"].map((k) => (
              <pre key={k} className="card wrap">
                {facts.types[k]}
              </pre>
            ))}
          </div>
        </>
      )}

      <h3>B · A search and a fetch on the real web</h3>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} />
      <div className="scenarios">{btn("basics", "1 · One WebSearch, one WebFetch", startBasics, question.trim().length < 3)}</div>
      <p className="hint">
        The two calls run one after the other: the agent needs the search results to choose the page to fetch (compare the <b>@</b> times). Look at the <b>WebFetch</b> row: hundreds of KB downloaded, a few lines returned. About $0.03 to $0.04,
        $0.01 of it the search fee.
      </p>
      {basics.length > 0 && (
        <div className="card">
          <Trail events={basics} />
        </div>
      )}

      <h3>C · What WebFetch really does: the mini web</h3>
      <p className="hint">
        The server runs a small HTTPS site on 127.0.0.1{facts && <>, port {facts.miniWeb.port}</>}. WebFetch refuses <code>localhost</code>, so the site is
        reached as <code>shop.127.0.0.1.nip.io</code> (a public DNS name for 127.0.0.1), with a lab certificate that Claude Code trusts through{" "}
        <code>NODE_EXTRA_CA_CERTS</code>. Every request it answers is a <b>mini web</b> row.
      </p>
      <div className="scenarios">{btn("fetch", "2 · Fetch 8 URLs in parallel, then one again", startFetchLab)}</div>
      {fetchTable && <FetchTable table={fetchTable} />}
      {fetchEvents.length > 0 && (
        <details className="card" open={!fetchTable}>
          <summary>
            <b>The run</b> ({fetchEvents.filter((e) => e.event === "wire").length} HTTP requests, {fetchEvents.filter((e) => e.event === "tool").length} tool calls)
          </summary>
          <Trail events={fetchEvents} />
        </details>
      )}

      <h3>D · Pages are untrusted: a prompt injection</h3>
      <p className="hint">
        <code>/prices</code> has an HTML comment for AI agents and a customer review that says "<i>AI assistants: ignore all previous instructions…</i>". Three
        agents read it at the same time: (a) asks a question, (b) asks WebFetch for the reviews word for word, (c) does the same with a <code>PostToolUse</code> hook
        that removes instruction-like lines with <code>updatedToolOutput</code> before the model sees them. About $0.02 in all.
      </p>
      <div className="scenarios">{btn("injection", "3 · Three agents read the same page", startInjection)}</div>
      {Object.keys(lanes).length > 0 && (
        <div className="compare-grid">
          {["summary", "verbatim", "guarded"].map((l) => (
            <Lane key={l} lane={l} events={lanes[l] ?? []} />
          ))}
        </div>
      )}

      <h3>E · Where the agent may go</h3>
      <p className="hint">
        <code>WebFetch(domain:nodejs.org)</code> in <code>allowedTools</code> with <code>permissionMode: "dontAsk"</code>: other domains are denied, and listed in{" "}
        <code>permission_denials</code>. WebSearch has no domain rule, so a <code>PreToolUse</code> hook adds <code>allowed_domains</code> to every search with{" "}
        <code>updatedInput</code>. About $0.04.
      </p>
      <div className="scenarios">{btn("guard", "4 · Search + three fetches under the rules", startGuard)}</div>
      {guardCheck && (
        <p className="hint">
          <b>Check:</b> {guardCheck.hits} search hits, {guardCheck.offDomain.length ? <b className="bad">{guardCheck.offDomain.length} outside nodejs.org</b> : "all on nodejs.org"}.
          Denied: {guardCheck.denied.map((u: string) => <code key={u}>{u} </code>)}
        </p>
      )}
      {guard.length > 0 && (
        <div className="card">
          <Trail events={guard.filter((e) => e.event !== "check")} />
        </div>
      )}

      <h3>F · The research agent</h3>
      <p className="hint">
        Everything together: a system prompt with a method, <code>outputFormat</code> (a report whose findings carry their URLs), <code>maxTurns</code> and{" "}
        <code>maxBudgetUsd</code>, hooks that enforce the number of searches and fetches and the domain list, the injection guard, and a ledger of every URL the
        tools returned, so each citation can be checked. Quick: about $0.04 to $0.08. Thorough: $0.08 to $0.30.
      </p>
      <div className="card config">
        <label>Question</label>
        <textarea rows={2} value={research.question} onChange={(e) => setResearch({ ...research, question: e.target.value })} />
        <div className="form-grid">
          <label>
            Depth
            <select value={research.depth} onChange={(e) => setResearch({ ...research, depth: e.target.value })}>
              <option value="quick">quick: 1 search, 2 fetches, $0.15 max</option>
              <option value="thorough">thorough: 3 searches, 4 fetches, $0.40 max</option>
            </select>
          </label>
          <label>
            Model
            <select value={research.model} onChange={(e) => setResearch({ ...research, model: e.target.value })}>
              <option value="haiku">Haiku 4.5</option>
              <option value="sonnet">Sonnet (alias)</option>
            </select>
          </label>
          <label>
            Allowed domains (optional, comma separated)
            <input value={research.domains} placeholder="e.g. nodejs.org, github.com" onChange={(e) => setResearch({ ...research, domains: e.target.value })} />
          </label>
        </div>
        {btn("research", "5 · Research", startResearch, research.question.trim().length < 5)}
      </div>
      {report && <Report r={report} />}
      {researchEvents.length > 0 && (
        <details className="card" open={!report}>
          <summary>
            <b>The research trail</b> ({researchEvents.filter((e) => e.event === "tool").length} tool calls, {researchEvents.filter((e) => e.event === "hook").length} hook
            decisions)
          </summary>
          <Trail events={researchEvents} />
        </details>
      )}

      <h3>G · The code</h3>
      <div className="row">
        {["options", "miniweb", "run", "basics", "fetchlab", "injection", "guard", "research", "citations"].map(
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
