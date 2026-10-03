import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
const usd = (n?: number) => (n === undefined || Number.isNaN(n) ? "" : `$${n.toFixed(4)}`);
const sec = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);
const of = (events: Ev[], name: string) => events.filter((e) => e.event === name).map((e) => e.data);
const last = (events: Ev[], name: string) => of(events, name).at(-1);
const Exit = ({ code }: { code: any }) => <span className={`exit e${code}`}>exit {String(code)}</span>;

// The fields of a result message a pipeline branches on (the same view for the CLI's JSON and the SDK's message).
function ResultView({ r }: { r: any }) {
  if (!r) return null;
  return (
    <table className="tools compare">
      <tbody>
        {[
          ["subtype", r.subtype],
          ["is_error", String(r.is_error)],
          ["terminal_reason", r.terminal_reason],
          ["num_turns", r.num_turns],
          ["structured_output", r.structured_output && JSON.stringify(r.structured_output)],
          ["errors", r.errors?.length ? r.errors.join("; ") : undefined],
          ["permission_denials", r.permission_denials?.length ? r.permission_denials.map((d: any) => `${d.tool} ${d.input}`).join(" · ") : "[]"],
          ["total_cost_usd", usd(r.total_cost_usd)],
        ]
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => (
            <tr key={k as string}><td><code>{k}</code></td><td className="snippet">{v as string}</td></tr>
          ))}
      </tbody>
    </table>
  );
}

// A very small Markdown renderer for the job summary: headings, tables, paragraphs (what GitHub would render).
function SummaryMd({ md }: { md: string }) {
  const emoji = (s: string) => s.replace(":white_check_mark:", "✅").replace(":x:", "❌").replace(":warning:", "⚠️");
  const blocks = md.trim().split(/\n\s*\n/);
  return (
    <div className="md-summary">
      {blocks.map((b, i) => {
        if (b.startsWith("## ")) return <h4 key={i}>{emoji(b.slice(3))}</h4>;
        if (b.startsWith("|")) {
          const rows = b.split("\n").filter((l) => !/^\|[-| ]+\|$/.test(l)).map((l) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
          return (
            <table key={i}><thead><tr>{rows[0].map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
              <tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c.replace(/\*\*|`/g, "")}</td>)}</tr>)}</tbody></table>
          );
        }
        return <p key={i} className="snippet">{emoji(b.replace(/<\/?sub>/g, "").replace(/\*\*|`|_/g, ""))}</p>;
      })}
    </div>
  );
}

export function Concept49DeployCiHeadless() {
  const [facts, setFacts] = useState<any>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [code, setCode] = useState<Record<string, string>>({});
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [head, setHead] = useState<Ev[]>([]);
  const [ci, setCi] = useState<Ev[]>([]);
  const [lim, setLim] = useState<Ev[]>([]);
  const [dep, setDep] = useState<Ev[]>([]);
  const [format, setFormat] = useState<"json" | "stream-json">("json");
  const [variant, setVariant] = useState<"buggy" | "clean">("buggy");
  const [drainMs, setDrainMs] = useState(3000);

  useEffect(() => {
    let stopped = false;
    const get = async (url: string) => {
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) return r.json();
          if (![502, 503, 504].includes(r.status) || i >= 30) throw new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`);
        } catch (e) {
          if (i >= 30 || !(e instanceof TypeError)) throw e;
        }
        if (stopped) throw new Error("unmounted");
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    get("/api/c49/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c49/files").then((f) => !stopped && setFiles(f)).catch(() => {});
    get("/api/c49/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => { stopped = true; };
  }, []);

  async function run(key: string, url: string, body: object, set: (e: Ev[]) => void) {
    set([]);
    setRunning(key);
    setError(null);
    const buf: Ev[] = [];
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "done") return;
        if (event === "error") setError(data.message);
        buf.push({ event, data });
        set([...buf]);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const btn = (key: string, label: string, url: string, body: object, set: (e: Ev[]) => void) => (
    <button className={running === key ? "active" : ""} onClick={() => run(key, url, body, set)} disabled={!!running}>
      {running === key ? "Running…" : label}
    </button>
  );

  const cliEnd = last(head, "cli-end");
  const sdkEnd = last(head, "sdk-end");
  const ciExit = last(ci, "exit");
  const depExit = last(dep, "exit");
  const apiFail = [cliEnd?.result?.result, sdkEnd?.result?.result, ...of(lim, "lane-end").map((d) => d.result?.result), ...of(ci, "stderr").map((d) => d.line)]
    .find((t) => typeof t === "string" && /credit balance|invalid x-api-key|authentication_error|not logged in/i.test(t));

  return (
    <section className="ma-wrap">
      <h2>49 · Deploy and CI headless</h2>
      <p className="lead">
        Every tab so far had a person watching. In a CI pipeline or a deployed service <b>nobody is</b>: no terminal, nobody to answer a permission prompt, nobody to notice a loop. A
        headless agent must be <b>scriptable</b> (one JSON result), <b>fail-closed</b> (<code>dontAsk</code>), <b>bounded</b> (turns, dollars, seconds), <b>reproducible</b> (no ambient
        settings or state) and, as a service, <b>operable</b> (probes, backpressure, graceful shutdown). The deliverables are real files in <code>ci-kit/</code>; this tab runs them the way a
        CI runner and a container platform would.
      </p>
      <div className="card">
        <pre>{`// a CI step, headless: fail-closed, bounded, typed, reproducible
for await (const m of query({ prompt: reviewPrompt(diff), options: {
  tools: ["Read", "Grep", "Glob"], allowedTools: ["Read", "Grep", "Glob"],
  permissionMode: "dontAsk",                          // no prompt can hang the job
  outputFormat: { type: "json_schema", schema },      // result.structured_output, validated
  maxTurns: 6, maxBudgetUsd: 0.10, abortController,   // every bound → its own exit code
  settingSources: [], persistSession: false,          // no ambient config, no leftover state
}})) if (m.type === "result") process.exit(exitCodeFor(m));`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}
      {apiFail && (
        <div className="card warn">
          <b>The Anthropic API refused the calls</b> — <code>{apiFail}</code>
          <div className="hint">Check <code>ANTHROPIC_API_KEY</code> in <code>.env</code> (or leave it empty to use your Claude Code login), then restart <code>npm run dev</code>. Until then every run fails at its first call.</div>
        </div>
      )}

      <h3>A · Headless flags ↔ SDK options</h3>
      <p className="hint">SDK {facts?.sdkVersion ?? "…"} · Claude Code {facts?.claudeCodeVersion ?? "…"} · binary <code>{facts?.cli ?? "…"}</code> — the same native binary <code>claude -p</code> is and the SDK starts.</p>
      <table className="tools compare">
        <thead><tr><th>CLI (<code>claude -p</code>)</th><th>SDK option</th><th>why it matters headless</th></tr></thead>
        <tbody>
          {(facts?.flags ?? []).map((f: any) => (
            <tr key={f.cli}><td><code>{f.cli}</code></td><td><code>{f.sdk}</code></td><td className="snippet">{f.doc}</td></tr>
          ))}
        </tbody>
      </table>
      <table className="tools compare">
        <thead><tr><th>exit code</th><th>when (the convention used by this tab and <code>ci-kit/agent-review.mjs</code>)</th></tr></thead>
        <tbody>{(facts?.exitCodes ?? []).map((e: any) => <tr key={e.code}><td><Exit code={e.code} /></td><td className="snippet">{e.when}</td></tr>)}</tbody>
      </table>

      <h3>B · One job, two headless front doors: <code>claude -p</code> and <code>query()</code></h3>
      <p className="hint">
        The same task, schema and limits — once as a <b>CLI step</b> (flags in, stdout JSON out, the exit code decides the step) and once through the <b>SDK</b> (typed options in, typed
        messages out, your code decides the exit code). <code>json</code> prints a single result object; <code>stream-json</code> prints every message as a JSON line — the protocol the
        SDK itself reads. Both run with a clean env and a throw-away <code>CLAUDE_CONFIG_DIR</code>. About $0.02.
      </p>
      <div className="scenarios">
        {btn("head", "Run · CLI then SDK", "/api/c49/headless", { format }, setHead)}
        <label className="subtype">--output-format{" "}
          <select value={format} onChange={(e) => setFormat(e.target.value as any)} disabled={!!running}>
            <option value="json">json</option>
            <option value="stream-json">stream-json</option>
          </select>
        </label>
      </div>
      {head.length > 0 && (
        <div className="compare-grid ci-grid">
          <div className="card">
            <b>CLI</b> {cliEnd && <><Exit code={cliEnd.exitCode} /> <span className="subtype">{sec(cliEnd.ms)} · {cliEnd.stdoutLines} stdout line(s)</span></>}
            {last(head, "cli-start") && <pre className="wrap">{last(head, "cli-start").argv}</pre>}
            {cliEnd && (
              <>
                <div className="snippet"><b>stdout</b> {cliEnd.lineTypes.length > 1 ? cliEnd.lineTypes.join(" → ") : cliEnd.firstLine}</div>
                {cliEnd.stderr && <div className="snippet bad">stderr: {cliEnd.stderr}</div>}
                <ResultView r={cliEnd.result} />
              </>
            )}
          </div>
          <div className="card">
            <b>SDK</b> {sdkEnd && <><Exit code={sdkEnd.exitCode} /> <span className="subtype">{sec(sdkEnd.ms)} · {sdkEnd.messageTypes.length} message(s)</span></>}
            {last(head, "sdk-start") && <pre className="wrap">{JSON.stringify(last(head, "sdk-start").options, null, 1)}</pre>}
            {sdkEnd && (
              <>
                <div className="snippet"><b>messages</b> {sdkEnd.messageTypes.join(" → ")}</div>
                <ResultView r={sdkEnd.result} />
              </>
            )}
          </div>
        </div>
      )}
      {sdkEnd && (
        <p className="hint">Same binary, same result object: <code>structured_output</code> is the validated JSON, <code>subtype</code>/<code>is_error</code> say whether the run finished. The CLI is enough for a one-off step (pipe it to <code>jq</code>). The SDK wins for a <b>gate</b>: hooks, typed messages, your own exit-code policy, annotations — next part.</p>
      )}

      <h3>C · A CI gate: <code>ci-kit/agent-review.mjs</code> as a GitHub Actions step</h3>
      <p className="hint">
        The server runs the script exactly like a runner would: a child process with a clean env, <code>CI=true</code>, and <code>GITHUB_STEP_SUMMARY</code> / <code>GITHUB_OUTPUT</code>{" "}
        pointing at files. The agent reviews a diff of a small repo and returns a schema-validated verdict. <b>stdout</b> carries <code>::error file=…,line=…::</code> annotations (GitHub draws them
        on the PR diff), <b>stderr</b> the log, and the <b>exit code</b> passes or fails the check. <b>buggy</b> introduces a 100× discount bug and an <code>eval()</code> of user input;{" "}
        <b>clean</b> adds an input check. About $0.02.
      </p>
      <div className="scenarios">
        {btn("ci", `Run the step · ${variant} diff`, "/api/c49/ci", { variant }, setCi)}
        <label className="subtype">diff{" "}
          <select value={variant} onChange={(e) => setVariant(e.target.value as any)} disabled={!!running}>
            <option value="buggy">buggy (should fail)</option>
            <option value="clean">clean (should pass)</option>
          </select>
        </label>
      </div>
      {ci.length > 0 && (
        <>
          {last(ci, "step") && (
            <div className="card">
              <div className="snippet"><b>run:</b> {last(ci, "step").run}</div>
              <div className="snippet"><b>env:</b> {last(ci, "step").env.join(", ")} (+ OS plumbing; nothing else is inherited)</div>
              <details><summary className="subtype">change.diff</summary><pre className="wrap">{last(ci, "step").diff}</pre></details>
            </div>
          )}
          <div className="card">
            <b>job log</b> {ciExit && <><Exit code={ciExit.code} /> <span className="subtype">{ciExit.code === 0 ? "check passed" : ciExit.code === 1 ? "check failed: blocking findings" : "check failed: review incomplete"}</span></>}
            <div className="ci-log">
              {ci.filter((e) => e.event === "stdout" || e.event === "stderr").map((e, i) => {
                const l: string = e.data.line;
                const cls = e.event === "stderr" ? "l-log" : l.startsWith("::error") ? "l-err" : l.startsWith("::warning") ? "l-warn" : "l-notice";
                return <div key={i} className={cls}>{e.event === "stderr" ? "  " : "▶ "}{l}</div>;
              })}
            </div>
          </div>
          {ciExit && (
            <div className="compare-grid ci-grid">
              <div className="card"><b>$GITHUB_STEP_SUMMARY</b> <span className="subtype">rendered on the run page</span>{ciExit.summary ? <SummaryMd md={ciExit.summary} /> : <div className="snippet">(empty)</div>}</div>
              <div className="card"><b>$GITHUB_OUTPUT</b> <span className="subtype">steps.review.outputs.*</span><pre className="wrap">{Object.entries(ciExit.outputs ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") || "(empty)"}</pre></div>
            </div>
          )}
        </>
      )}
      {ciExit && (
        <p className="hint">The pipeline never parses prose: the verdict is <code>result.structured_output</code>, and anything other than a <code>success</code> result exits <b>2</b> — “could not review” must never read as “nothing found”. Copy <code>ci-kit/workflows/agent-review.yml</code> into <code>.github/workflows/</code> and add the <code>ANTHROPIC_API_KEY</code> secret to use it for real.</p>
      )}

      <h3>D · Bounded runs: every limit ends cleanly, with its own exit code</h3>
      <p className="hint">
        Four unattended runs in parallel, each with one guard set tight on purpose. <code>maxTurns</code> and <code>maxBudgetUsd</code> end with an error <code>subtype</code>; the timeout is
        your <code>AbortController</code>; <code>dontAsk</code> denies the un-approved <code>Write</code> instantly and records it in <code>permission_denials</code> instead of waiting for a
        click that never comes. One function — <code>exitCodeFor(result)</code> — turns each ending into an exit code. About $0.03.
      </p>
      <div className="scenarios">{btn("lim", "Run · 4 bounded runs", "/api/c49/limits", {}, setLim)}</div>
      {lim.length > 0 && (
        <div className="compare-grid ci-grid">
          {of(lim, "lane-start").map((s) => {
            const end = of(lim, "lane-end").find((d) => d.lane === s.lane);
            const tools = of(lim, "tool").filter((t) => t.lane === s.lane);
            return (
              <div key={s.lane} className={`card sec-lane ${end ? (end.exit.code === 0 ? "sec-ok" : "sec-bad") : ""}`}>
                <b>{s.title}</b> {end && <><Exit code={end.exit.code} /> <span className="subtype">{sec(end.ms)}</span></>}
                <div className="snippet"><b>prompt</b> {s.prompt}</div>
                {tools.map((t, i) => <div key={i} className="tool-call"><span className="tag tag-call">{t.name}</span> <code>{t.input}</code></div>)}
                {end && (
                  <>
                    <div className="snippet"><b>{end.exit.why}</b></div>
                    {end.thrown && <div className="snippet bad">{end.result ? "then threw" : "threw"}: {end.thrown}</div>}
                    {end.abortedAt !== undefined && <div className="snippet">abort() at {sec(end.abortedAt)} → the stream ended at {sec(end.ms)} (the SDK waits for Claude Code to exit)</div>}
                    <ResultView r={end.result} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {of(lim, "lane-end").length === 4 && (
        <p className="hint">No run hangs and no run pretends to pass. Two things a CI script must handle: the SDK <b>yields the error result and then throws</b> (max turns, budget) — so keep the result you already received and report it; and on <b>abort</b> it throws with no result at all, only after Claude Code has shut down (several seconds). Set your timeout well <b>below</b> the runner’s <code>timeout-minutes</code>, or the runner kills the job with no summary at all.</p>
      )}

      <h3>E · Deploy: <code>ci-kit/worker.mjs</code> as a container would run it</h3>
      <p className="hint">
        A long-lived agent service. The server starts the worker the way the <code>Dockerfile</code> would (env-configured, <code>MAX_CONCURRENCY=1</code>), then plays the platform: liveness
        and readiness probes, a long job, a second job while the only slot is busy (<b>429</b> + <code>Retry-After</code>: backpressure, because every job is a whole Claude Code process),
        then <b>SIGTERM</b> in the middle of the long job — a rolling deploy. The worker turns <code>/readyz</code> to 503, refuses new work, waits <code>DRAIN_MS</code>, aborts what is left
        (its caller gets a clean 503, not a reset connection) and exits 0. A short drain aborts the job; a long one lets it finish. About $0.02.
      </p>
      <div className="scenarios">
        {btn("dep", `Run the life cycle · drain ${drainMs / 1000} s`, "/api/c49/deploy", { drainMs }, setDep)}
        <label className="subtype">DRAIN_MS{" "}
          <select value={drainMs} onChange={(e) => setDrainMs(Number(e.target.value))} disabled={!!running}>
            <option value={3000}>3 000 (the job is aborted)</option>
            <option value={30000}>30 000 (the job finishes)</option>
          </select>
        </label>
      </div>
      {dep.length > 0 && (
        <div className="card">
          <b>timeline</b> {depExit && <><Exit code={depExit.code} /> <span className="subtype">{depExit.graceful ? "graceful shutdown" : "not graceful"}</span></>}
          {dep.filter((e) => ["phase", "http", "wlog"].includes(e.event)).map((e, i) =>
            e.event === "phase" ? (
              <div key={i} className="tool-call"><span className="tag tag-phase">platform</span> <b>{e.data.step}</b> <span className="subtype">@ {sec(e.data.at)}</span></div>
            ) : e.event === "http" ? (
              <div key={i} className="tool-call">
                <span className="tag tag-http">{e.data.method} {e.data.path}</span> <span className="subtype">{e.data.label}</span>{" "}
                → <b className={`st-${String(e.data.status)[0]}xx`}>{e.data.status ? `HTTP ${e.data.status}` : "no connection"}</b>
                {e.data.retryAfter && <span className="subtype">· Retry-After: {e.data.retryAfter} s</span>}
                <span className="subtype">· took {sec(e.data.ms)} · @ {sec(e.data.at)}</span>
                <div className="snippet">{JSON.stringify(e.data.body)}</div>
              </div>
            ) : (
              <div key={i} className="snippet" style={{ paddingLeft: 16 }}><span className="tag tag-wlog">worker</span> {e.data.event} {JSON.stringify(Object.fromEntries(Object.entries(e.data).filter(([k]) => !["event", "ts", "at"].includes(k))))}</div>
            ),
          )}
        </div>
      )}
      {depExit && (
        <p className="hint">The worker’s stdout is one JSON object per line — what log collectors ingest. In a real container, <code>tini</code> (PID 1) forwards SIGTERM to node, and <code>DRAIN_MS</code> <b>plus the abort teardown</b> (a few seconds while each Claude Code process exits — compare <code>shutdown.abort</code> with <code>job.end</code> above) must fit in the platform’s grace period (Kubernetes: 30 s), or the SIGKILL arrives first. On Windows the lab sends the same request over IPC, since Windows has no catchable SIGTERM between processes.</p>
      )}

      <h3>F · The kit: copy these into a repository</h3>
      <div className="row">
        {Object.keys(files).map((f) => (
          <button key={f} className={openFile === f ? "active" : ""} onClick={() => setOpenFile(openFile === f ? null : f)}>ci-kit/{f}</button>
        ))}
      </div>
      {openFile && <div className="card"><pre className="wrap">{files[openFile]}</pre></div>}

      <h3>G · A checklist for running agents unattended</h3>
      <table className="tools compare">
        <thead><tr><th>rule</th><th>how</th><th>seen in</th></tr></thead>
        <tbody>
          {[
            ["Never wait for a human", "permissionMode: \"dontAsk\" (--permission-mode dontAsk): un-approved calls are denied and logged in permission_denials", "B, D"],
            ["Ask for a typed result", "outputFormat json_schema (--json-schema); branch on result.subtype and structured_output, never on prose", "B, C"],
            ["Bound every run", "maxTurns, maxBudgetUsd, an AbortController timeout below the runner's timeout-minutes", "D"],
            ["Map endings to exit codes", "0 pass · 1 findings · 2 incomplete · 3 denied · 124 timeout — and incomplete is never a pass", "C, D"],
            ["Speak the runner's language", "::error file=,line=:: annotations on stdout, logs on stderr, Markdown to $GITHUB_STEP_SUMMARY, key=value to $GITHUB_OUTPUT", "C"],
            ["Start from nothing", "a clean env (no inherited CLAUDE*/cloud/GitHub vars), settingSources: [], persistSession: false, a temp CLAUDE_CONFIG_DIR", "B, C"],
            ["Keep the key a secret", "secrets.ANTHROPIC_API_KEY at run time; never in the image or the repo; skip fork PRs that get no secrets", "F"],
            ["Install for the target OS", "npm ci inside the image/runner: the Claude Code binary is a per-platform optional package", "F"],
            ["Run as a service, not a script", "/healthz + /readyz, a concurrency cap with 429 + Retry-After, JSON logs on stdout", "E"],
            ["Shut down gracefully", "on SIGTERM: readiness 503, drain within the grace period, abort the rest, exit 0", "E"],
          ].map(([a, b, c]) => (
            <tr key={a as string}><td><b>{a}</b></td><td className="snippet">{b}</td><td>{c}</td></tr>
          ))}
        </tbody>
      </table>

      <h3>H · The code</h3>
      <div className="row">
        {Object.keys(code).map((r) => (
          <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>{r}</button>
        ))}
      </div>
      {openCode && typeof code[openCode] === "string" && <div className="card"><pre className="wrap">{code[openCode]}</pre></div>}

      {error && <div className="card warn"><b>error</b> — <code>{error}</code></div>}
    </section>
  );
}
