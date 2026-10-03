import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

const HUMAN_PROMPT =
  "Write a haiku about autumn into haiku.txt with the Write tool. Then run `mkdir archive` with Bash, then `mkdir backup` with Bash, then `rm haiku.txt` with Bash. Then reply with one line per step.";
const POLICY_PROMPT = "Write hello into notes.txt and into notes.md with the Write tool. Then run `mkdir out` with Bash, then run `rm notes.txt` with Bash. Reply with one line per step.";

// Part H: the summary table.
const SUMMARY: [string, string, string][] = [
  ["Name the gate", "permissionPromptToolName: 'mcp__<server>__<tool>'", "An MCP tool from mcpServers (SDK, stdio or http). Claude Code calls it instead of asking the host's canUseTool"],
  ["What it receives", "{ tool_name, input, tool_use_id }", "tool_use_id is the id of the model's tool_use block: the gate can link its decision to the call"],
  ["What it returns", "content: [{ type: 'text', text: JSON.stringify(result) }]", "result: { behavior: 'allow', updatedInput, updatedPermissions? } or { behavior: 'deny', message, interrupt? }. Anything else is a denial ('invalid permission result')"],
  ["Hidden from the model", "system/init tools", "The named tool is not in the model's tool list. A typo in the name exposes the real one (Part F)"],
  ["Same as canUseTool", "--permission-prompt-tool stdio", "canUseTool IS a permission prompt tool named 'stdio' (the answer goes over stdin). Both at once: query() throws"],
  ["Asked last", "rules → mode → hooks → the gate", "allowedTools, acceptEdits, a hook's allow/deny decide before it; a hook's 'ask' sends the call to it; permissionPrompts: 'none' means nobody is asked"],
  ["Rewrite a call", "updatedInput", "The tool runs with the gate's input. The tool_result does not say so: the model's reply can describe what it asked for, not what ran"],
  ["Remember", "updatedPermissions: [{ type: 'addRules', …, destination }]", "'session': the next matching calls are not asked. 'localSettings': written to <cwd>/.claude/settings.local.json. Keep rules narrow: Bash(mkdir:*), not Bash"],
  ["Stop", "{ behavior: 'deny', interrupt: true }", "The run ends: result error_during_execution, then query() throws"],
  ["It can wait", "an async tool", "No timeout on the gate: a human can take a minute. Put your own limit in the gate (the lab: 2 minutes, then deny)"],
  ["When the gate breaks", "throws / isError / missing", "A throw or isError is a TOOL error (not in permission_denials; the model may retry). A missing tool or a failed server: Claude Code exits with code 1 at the first prompt"],
  ["SDK server schema", "input: z.looseObject({})", "Not z.record(): the SDK then fails tools/list, the server has no tools, and Claude Code exits at the first prompt"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype">{(d.at / 1000).toFixed(2)} s</span> : null);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function Decision({ d, onDecide }: { d: any; onDecide: (action: string, extra?: object) => Promise<string | null> }) {
  const [input, setInput] = useState(pretty(d.call.input));
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (action: string, extra?: object) => {
    setBusy(true);
    setErr(await onDecide(action, extra));
    setBusy(false);
  };
  const edit = () => {
    try {
      const parsed = JSON.parse(input);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return setErr("input must be a JSON object");
      go("edit", { input: parsed });
    } catch {
      setErr("input is not valid JSON");
    }
  };
  return (
    <div className="card gate-card">
      <b>The gate asks you</b> <span className="subtype">approve({"{"} tool_name: "{d.call.tool_name}", input, tool_use_id {"}"}) · the host denies after 2 minutes</span>
      <textarea rows={Math.min(10, input.split("\n").length + 1)} value={input} onChange={(e) => setInput(e.target.value)} />
      <div className="row">
        <button disabled={busy} className="primary" onClick={() => go("allow")}>
          Allow
        </button>
        <button disabled={busy} onClick={edit}>
          Allow with this input
        </button>
        <button disabled={busy} onClick={() => go("remember")}>
          Allow and remember{d.call.tool_name === "Bash" ? ` (Bash(${String(d.call.input.command ?? "").trim().split(/\s+/)[0]}:*))` : ` (${d.call.tool_name})`}
        </button>
      </div>
      <div className="row">
        <input className="inline-input" maxLength={300} placeholder="message for the model (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button disabled={busy} onClick={() => go("deny", message.trim() ? { message: message.trim() } : undefined)}>
          Deny
        </button>
        <button disabled={busy} onClick={() => go("stop", message.trim() ? { message: message.trim() } : undefined)}>
          Deny and stop the run
        </button>
      </div>
      {err && <div className="snippet bad">{err}</div>}
    </div>
  );
}

function Timeline({ events, open, onDecide }: { events: Ev[]; open: Set<string>; onDecide: (id: string, action: string, extra?: object) => Promise<string | null> }) {
  const uses = new Map<string, number>(); // tool_use id → when the model's tool_use arrived
  for (const { event, data } of events) if (event === "toolUse") uses.set(data.id, data.at);
  return (
    <div>
      {events.map(({ event, data }, i) => {
        if (event === "opened")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">options</span> {t(data)} <span className="subtype">host pid {data.hostPid}</span>
              <pre className="wrap snippet">{pretty(data.options)}</pre>
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> {t(data)}
              <div className="snippet">
                tools the model sees: {data.tools.join(", ")} · {data.gateListed ? <b className="bad">the gate is listed!</b> : "mcp__gate__approve is not listed"} · mcp_servers:{" "}
                {data.mcp.map((s: any) => `${s.name} ${s.status} (${s.source})`).join(", ")}
              </div>
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
              <span className="tag tag-assistant">tool_use</span> <b>{data.name}</b> {t(data)} <span className="subtype">{data.id}</span>
              <div className="snippet">{data.input}</div>
            </div>
          );
        if (event === "gateCall") {
          const linked = data.call.tool_use_id && uses.has(data.call.tool_use_id);
          return (
            <div key={i} className="tool-call gate">
              <span className="tag tag-gate">Claude Code → approve()</span> <b>{data.call.tool_name}</b> {t(data)}
              <div className="snippet">
                tool_use_id {data.call.tool_use_id ?? "(none)"} {linked ? `= the tool_use of ${(uses.get(data.call.tool_use_id)! / 1000).toFixed(2)} s` : ""}
              </div>
              {open.has(data.id) && <Decision d={data} onDecide={(a, x) => onDecide(data.id, a, x)} />}
            </div>
          );
        }
        if (event === "gateAnswer")
          return (
            <div key={i} className={`tool-call gate ${data.sent.behavior === "deny" ? "denied" : ""}`}>
              <span className="tag tag-gate">approve() returns</span> <b>{data.how}</b> {t(data)}
              <pre className="wrap snippet">{JSON.stringify(data.sent)}</pre>
            </div>
          );
        if (event === "gateLog")
          return data.event === "started" ? (
            <div key={i} className="tool-call gate-ext">
              <span className="tag tag-gate-ext">policy gate</span> started {t(data)} <span className="subtype">pid {data.pid} · {data.rules} rules, default {data.default}</span>
            </div>
          ) : (
            <div key={i} className={`tool-call gate-ext ${data.result.behavior === "deny" ? "denied" : ""}`}>
              <span className="tag tag-gate-ext">policy gate, pid {data.pid}</span> <b>{data.tool_name}</b> "{data.subject}" → {data.rule ? `rule ${data.rule}` : "no rule: default"} {t(data)}
              <pre className="wrap snippet">{JSON.stringify(data.result)}</pre>
            </div>
          );
        if (event === "toolResult")
          return (
            <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
              <span className="tag tag-user">tool_result</span> <b>{data.name}</b> {data.is_error && <span className="subtype bad">is_error</span>} {t(data)}
              <div className="snippet">{data.text}</div>
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result/{data.subtype}</span> {t(data)} <span className="subtype">${data.cost.toFixed(4)} · permission_denials: {data.denials.length ? data.denials.join(", ") : "none"}</span>
              {data.text && <div className="answer thin">{data.text}</div>}
            </div>
          );
        if (event === "check")
          return (
            <div key={i} className="tool-call verdict">
              <span className="tag tag-verdict">the run folder, after</span> {t(data)}
              <div className="snippet">{data.files.length ? data.files.join(", ") : "empty"}</div>
              {data.settingsLocal && <pre className="wrap snippet">.claude/settings.local.json: {data.settingsLocal}</pre>}
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

function DryTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>--permission-prompt-tool</th>
          <th>--permission-prompts</th>
          <th>--mcp-config</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <b>{r.label}</b>
              <div>
                <code>{r.shown}</code>
              </div>
            </td>
            {r.error ? (
              <td colSpan={3}>
                <code className="bad">query() threw: {r.error}</code>
              </td>
            ) : (
              <>
                <td>{r.promptTool ? <code className="good">{r.promptTool}</code> : <span className="hint">not set</span>}</td>
                <td>{r.prompts ? <code>{r.prompts}</code> : <span className="hint">—</span>}</td>
                <td className="hint">{r.mcpConfig ? <code>{r.mcpConfig.slice(0, 160)}…</code> : r.key === "sdk" || r.key === "promptsNone" ? "not in args: an SDK server travels in control_request/initialize" : "—"}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowsTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>case</th>
          <th>the gate was asked</th>
          <th>what the model got</th>
          <th>what happened</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <b>{r.label}</b>
              <div>
                <code>{r.shown}</code>
              </div>
            </td>
            <td>
              {r.asked.length ? (
                r.asked.map((a: any, i: number) => (
                  <div key={i}>
                    <b>{a.tool}</b> → <code className={/^allow/.test(a.answer) ? "good" : "bad"}>{a.answer}</code>
                  </div>
                ))
              ) : (
                <span className="hint">never</span>
              )}
            </td>
            <td>
              {r.results.map((x: any, i: number) => (
                <div key={i} className={`snippet ${x.is_error ? "bad" : ""}`}>
                  {x.name}: {x.text.slice(0, 180)}
                </div>
              ))}
            </td>
            <td>
              <code className={/threw/.test(r.outcome) ? "bad" : ""}>{r.outcome.slice(0, 260)}</code>
              <div className="hint">
                files: {r.files.length ? r.files.join(", ") : "none"}
                {r.aTxt !== null && ` · a.txt = ${JSON.stringify(r.aTxt)}`}
                {r.denials.length > 0 && ` · permission_denials: ${r.denials.join(", ")}`} · {r.outcome.startsWith("result") ? `$${r.cost.toFixed(4)}` : r.tools.length ? "no result: cost unknown" : "$0: Claude Code never started"}
              </div>
              {r.text && <div className="snippet">model: {r.text.slice(0, 200)}</div>}
              {r.note && <div className="hint">{r.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept37PermissionPromptTool() {
  const [code, setCode] = useState<Record<string, any>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ part: string; text: string } | null>(null);
  const [cost, setCost] = useState(0);
  const [dry, setDry] = useState<any[]>([]);
  // Parts B and C share the timeline
  const [humanPrompt, setHumanPrompt] = useState(HUMAN_PROMPT);
  const [policyPrompt, setPolicyPrompt] = useState(POLICY_PROMPT);
  const [policy, setPolicy] = useState("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [runId, setRunId] = useState("");
  const [gateOf, setGateOf] = useState<"you" | "policy">("you"); // the part whose run the timeline shows
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Parts D, E, F
  const [rows, setRows] = useState<Record<string, any[]>>({});

  const fail = () => setError("Could not reach /api/c37 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together; while the server is loading, Vite's proxy answers 502.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const c = await fetch("/api/c37/code").then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
        if (!stop) setCode(c), setPolicy(pretty(c.defaultPolicy)), setError(null);
      } catch {
        if (stop) return;
        if (tries > 1) setTimeout(() => load(tries - 1), 1000);
        else fail();
      }
    };
    load();
    return () => void (stop = true);
  }, []);

  const PART: Record<string, string> = { dry: "A", you: "B", policy: "C", who: "D", answers: "E", failures: "F" };
  const begin = (id: string, h: string) => (setRunning(id), setHint({ part: PART[id], text: h }), setError(null));
  const hintAt = (part: string) => hint?.part === part && <p className="hint">{hint.text}</p>;

  async function dryRun() {
    begin("dry", "Six setups, each passed to query() with a spawner that only records the args and a fake process (Concept 36). No Claude Code, no API call.");
    try {
      const r = await fetch("/api/c37/dry", { method: "POST" }).then((x) => x.json());
      setDry(r.rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function run(gate: "you" | "policy") {
    let body: object;
    if (gate === "policy") {
      try {
        body = { gate, prompt: policyPrompt, policy: JSON.parse(policy) };
      } catch {
        return setError("The policy is not valid JSON.");
      }
      begin("policy", "Claude Code starts 37-policy-gate.mjs as a stdio MCP server: another process (see its pid), started once for the whole session. It reads the policy from its environment and reports each decision to the lab. The host itself only sees the tool results. About $0.011.");
    } else {
      body = { gate, prompt: humanPrompt };
      begin("you", "The gate is an SDK MCP tool in this server. Each call waits for your button. Try: allow the Write, 'allow and remember' the first mkdir (the second one is then not asked), deny the rm. Or edit the haiku before allowing it, and compare the file with the model's reply. About $0.01.");
    }
    const got: Ev[] = [];
    setEvents([]);
    setGateOf(gate);
    setOpen(new Set());
    try {
      await streamPost("/api/c37/run", body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") setRunId(data.run);
        if (event === "gateCall") setOpen((s) => new Set(s).add(data.id));
        if (event === "gateAnswer")
          setOpen((s) => {
            const n = new Set(s);
            n.delete(data.id);
            return n;
          });
        if (event === "result") setCost((c) => c + (data.cost ?? 0));
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
      setOpen(new Set());
    }
  }

  async function decide(id: string, action: string, extra?: object): Promise<string | null> {
    const r = await fetch("/api/c37/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: runId, id, action, ...extra }) });
    return r.ok ? null : ((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  }

  async function runTable(route: "who" | "answers" | "failures", h: string) {
    begin(route, h);
    const got: any[] = [];
    setRows((r) => ({ ...r, [route]: [] }));
    try {
      await streamPost(`/api/c37/${route}`, {}, (event, data) => {
        if (event !== "row") return;
        got.push(data);
        got.sort((a, b) => a.order - b.order); // the order of the list, not the order they finished
        setRows((r) => ({ ...r, [route]: [...got] }));
        setCost((c) => c + (data.cost ?? 0));
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
  const live = running === "you" || running === "policy";
  // The timeline shows under the part (B or C) whose button started it.
  const session = (gate: "you" | "policy") =>
    gateOf === gate &&
    (live || events.length > 0) && (
      <div className="card">
        <b>The session, the gate's calls and answers, in order</b> <span className="subtype">{live ? "running…" : "done"}</span>
        <Timeline events={events} open={open} onDecide={decide} />
      </div>
    );

  return (
    <section>
      <h2>37 · The permission prompt tool</h2>
      <p className="lead">
        When a tool call needs approval, Claude Code asks the host. Concept 4 answered with <code>canUseTool</code>. <code>permissionPromptToolName</code> names an{" "}
        <b>MCP tool</b> that answers instead: Claude Code calls it with <code>{"{ tool_name, input, tool_use_id }"}</code> and reads a JSON <code>PermissionResult</code>{" "}
        from its text. The gate can live in your process, or in <b>another process</b> (a policy service), in any language. The model never sees it.
      </p>
      <div className="row">
        <span className="subtype">spent ${cost.toFixed(4)}</span>
      </div>

      <h3>A · Two ways to answer, one flag</h3>
      <div className="scenarios">{btn("dry", "1 · Dry run: the flags of six setups", dryRun)}</div>
      {hintAt("A")}
      {dry.length > 0 && <DryTable rows={dry} />}

      <h3>B · An in-process gate that asks you</h3>
      <label className="hint">prompt for 2 (tools: Write, Bash; the gate: an SDK MCP server in this server)</label>
      <textarea rows={2} maxLength={2000} value={humanPrompt} onChange={(e) => setHumanPrompt(e.target.value)} />
      <div className="scenarios">{btn("you", "2 · Run with the gate: you decide each call", () => run("you"))}</div>
      {hintAt("B")}
      {session("you")}

      <h3>C · An external gate: a policy in another process</h3>
      <label className="hint">the policy (GATE_POLICY): the first rule whose tool and match fit decides; match is a regular expression on the command (Bash) or the file_path</label>
      <textarea rows={Math.min(16, policy.split("\n").length + 1)} className="policy-edit" value={policy} onChange={(e) => setPolicy(e.target.value)} />
      <label className="hint">prompt for 3</label>
      <textarea rows={2} maxLength={2000} value={policyPrompt} onChange={(e) => setPolicyPrompt(e.target.value)} />
      <div className="scenarios">
        {btn("policy", "3 · Run with the policy gate (stdio)", () => run("policy"))}
        <button className="link" disabled={!!running || !code.defaultPolicy} onClick={() => setPolicy(pretty(code.defaultPolicy))}>
          reset the policy
        </button>
      </div>
      {hintAt("C")}
      {session("policy")}

      <h3>D · Who is asked, and when</h3>
      <div className="scenarios">
        {btn("who", "4 · The same two steps, seven setups", () =>
          runTable("who", "Seven sessions in parallel. Each writes a.txt, then runs mkdir out. The gate allows everything and records what reaches it: everything else was decided before it. About $0.06."),
        )}
      </div>
      {hintAt("D")}
      {rows.who?.length > 0 && <RowsTable rows={rows.who} />}

      <h3>E · What the gate can answer</h3>
      <div className="scenarios">
        {btn("answers", "5 · Seven answers", () => runTable("answers", "Seven sessions in parallel. Only the gate's answer changes between the rows. About $0.06."))}
      </div>
      {hintAt("E")}
      {rows.answers?.length > 0 && <RowsTable rows={rows.answers} />}

      <h3>F · When the gate is the problem</h3>
      <div className="scenarios">
        {btn("failures", "6 · Six failures", () => runTable("failures", "Six sessions in parallel. Most of them end with Claude Code exiting at the first prompt, so they cost little. About $0.01."))}
      </div>
      {hintAt("F")}
      {rows.failures?.length > 0 && <RowsTable rows={rows.failures} />}

      <h3>G · The code</h3>
      <div className="row">
        {["options", "gate", "human", "policy", "policyGate", "relay", "dry", "who", "answers", "failures"].map(
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

      <h3>H · The permission prompt tool, in one table</h3>
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
