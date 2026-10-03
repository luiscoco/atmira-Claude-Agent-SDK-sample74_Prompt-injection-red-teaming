import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

// Part E: what the CLI does differently with the flag. Read from the CLI's code (claude.exe of SDK 0.3.281): only the
// file list is in sdk.d.ts, the rest can change between versions.
const FROM_ROOT: [string, string][] = [
  [".claude/settings.json, .claude/settings.local.json", "hooks, permissions, env, enableAllProjectMcpServers… (the 'project' and 'local' setting sources)"],
  [".mcp.json", "the project MCP servers (it walks up from the root, not from cwd)"],
  [".claude/commands, skills, agents, output-styles, workflows", "the custom commands and the rest of the .claude config trees"],
  ["CLAUDE_PROJECT_DIR", "for hooks, MCP servers and plugins, and ${CLAUDE_PROJECT_DIR} in their commands"],
  ["the cwd of hooks", "a hook runs in the root, not in the worktree"],
  ["the cwd of helpers", "apiKeyHelper, awsCredentialExport, the GCP auth refresh, the proxy auth helper, LSP servers"],
  ["relative marketplace paths", "a 'file' or 'directory' plugin marketplace source is resolved against the root"],
];
const STAYS: [string, string][] = [
  ["CLAUDE.md, CLAUDE.local.md, .claude/rules", "memory is read from cwd and its parents (Part B shows it: the code word)"],
  ["the tools", "Read, Edit, Bash… work in cwd: the branch's code is what Claude sees and changes"],
  ["user and policy settings", "CLAUDE_CONFIG_DIR/settings.json and managed settings do not move"],
  ["settingSources", "decides WHETHER project settings load at all. Without 'project', the root is not read"],
];
const REFUSED: [string, string][] = [
  ["a relative path", "Error: --project-config-root must be an absolute local path"],
  ["a missing folder, a file", "Error: --project-config-root is not an existing directory that this user can list"],
  ["a network path (\\\\server\\share)", "refused: it must be a local directory"],
  ["background sessions", "'Background sessions are unavailable with --project-config-root': a copy could lose the flag and run the worktree's hooks"],
  ["durable scheduled tasks, --routine", "'Durable scheduled tasks are unavailable in a session started with --project-config-root'; --routine is refused with the flag"],
  ["project-scope MCP changes", "'claude mcp add --scope project' is refused: use the local or user scope"],
  ["project-scope workflow saves", "'Project-scope workflow saves are unavailable in a session started with --project-config-root'"],
  ["a cloud session", "ignores it: it reads project config from its own checkout"],
];

// Part G: the summary table.
const SUMMARY: [string, string, string][] = [
  ["Set it", "projectConfigRoot: '/abs/path/to/trusted/checkout'", "Becomes --project-config-root=<dir>. Absolute, local, an existing folder, or Claude Code exits at startup"],
  ["cwd", "the worktree", "The files, the tools, CLAUDE.md. The branch's code is what Claude reads and edits"],
  ["The root", "the trusted checkout", "Project and local settings, hooks, permissions, .mcp.json, commands, skills, agents, CLAUDE_PROJECT_DIR"],
  ["Hooks", "run in the root", "Only the root's hooks run. Without the option, a branch's hooks run even when nothing is trusted"],
  ["Permissions", "the root's rules", "Without the option, a trusted main checkout makes a branch's permissions.allow apply"],
  ["Trust", "kept per main checkout", "A worktree inherits it; trusting the worktree's own folder does not count"],
  ["No .claude in cwd", "a git fallback", "Without the option, a worktree without .claude/ gets the main checkout's commands, skills and agents, but not its settings"],
  ["Still needed", "settingSources: ['project', …]", "The option says where project config comes from, not whether it loads"],
  ["Use it for", "a host that runs agents on PR branches", "Review bots, CI agents, one worktree per task: the code comes from the branch, the rules from you"],
];

const t = (d: any) => (d.at !== undefined ? <span className="subtype">{(d.at / 1000).toFixed(2)} s</span> : null);
const usd = (n: number) => `$${n.toFixed(6)}`;
const who = (s: string) => (/trusted/.test(s) ? "from-trusted" : /branch/.test(s) ? "from-branch" : "");

function Names({ list }: { list: string[] }) {
  if (!list.length) return <span className="hint">none</span>;
  return (
    <>
      {list.map((n) => (
        <code key={n} className={`origin ${who(n)}`}>
          {n}
        </code>
      ))}
    </>
  );
}

function Hooks({ hooks }: { hooks: any[] }) {
  if (!hooks.length) return <span className="hint">no hook ran</span>;
  return (
    <>
      {hooks.map((h, i) => (
        <div key={i} className="snippet">
          <code className={`origin ${who(h.script)}`}>{h.script} hook</code> {h.event}
          <div className="hint">
            cwd <code>{h.cwd}</code> · CLAUDE_PROJECT_DIR <code>{h.CLAUDE_PROJECT_DIR}</code>
          </div>
          <div className="hint">
            settings env: LAB_SETTINGS={h.LAB_SETTINGS ?? "(unset)"}, LAB_LOCAL={h.LAB_LOCAL ?? "(unset)"} · ANTHROPIC_API_KEY in its env: <b className={h.sawApiKey ? "bad" : ""}>{h.sawApiKey ? "yes" : "no"}</b>
          </div>
        </div>
      ))}
    </>
  );
}

function Setup({ r }: { r: any }) {
  return (
    <>
      <b>{r.label}</b>
      <div className="hint">
        cwd <code>{r.cwd}</code>
      </div>
      <div className="hint">
        projectConfigRoot {r.root ? <code>{r.root}</code> : "(not set)"}
        {r.sources !== '["project","local"]' && (
          <>
            {" "}
            · settingSources <code>{r.sources}</code>
          </>
        )}
      </div>
    </>
  );
}

function WhereTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>commands · skills · agents (system/init)</th>
          <th>.mcp.json</th>
          <th>the hooks that ran</th>
          <th>CLAUDE.md</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <Setup r={r} />
            </td>
            <td>
              {r.init ? (
                <>
                  <div>
                    <Names list={r.init.commands} />
                  </div>
                  <div>
                    <Names list={r.init.skills} /> <Names list={r.init.agents} />
                  </div>
                </>
              ) : (
                <code className="bad">{r.error}</code>
              )}
            </td>
            <td>{r.init && <Names list={r.init.mcp} />}</td>
            <td>
              <Hooks hooks={r.hooks} />
            </td>
            <td>
              <code className={`origin ${r.answer === "MAPLE" ? "from-trusted" : r.answer === "BIRCH" ? "from-branch" : ""}`}>{r.answer.length > 20 ? "(no code word)" : r.answer}</code>
              <div className="hint">{usd(r.cost)}</div>
              {r.note && <div className="hint">{r.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TakeoverTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>trusted in .claude.json</th>
          <th>Bash: node -e "console.log(42)"</th>
          <th>the hooks that ran</th>
          <th>what Claude Code said</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <Setup r={r} />
            </td>
            <td>{r.trust ? <code>{r.trust}</code> : <span className="hint">nothing</span>}</td>
            <td>
              {r.bash.length ? (
                r.bash.slice(0, 1).map((b: any, i: number) => (
                  <div key={i}>
                    <code className={b.ran ? "bad" : "good"}>{b.ran ? `ran: ${b.output}` : `denied: ${b.output}`}</code>
                  </div>
                ))
              ) : (
                <span className="hint">no Bash call</span>
              )}
              <div className="hint">
                permission_denials: {r.denials.length} · {usd(r.cost)}
              </div>
            </td>
            <td>
              <Hooks hooks={r.hooks} />
            </td>
            <td>
              {r.error && <code className="bad">{r.error}</code>}
              {r.warnings.map((w: string, i: number) => (
                <div key={i} className="snippet">
                  stderr: {w}
                </div>
              ))}
              {!r.warnings.length && !r.error && <span className="hint">no warning</span>}
              {r.note && <div className="hint">{r.note}</div>}
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
        if (event === "options")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">options</span> {t(data)}
              <pre className="wrap snippet">{JSON.stringify({ cwd: data.cwd, projectConfigRoot: data.projectConfigRoot, tools: data.tools, prompt: data.prompt }, null, 2)}</pre>
              <div className="hint">trusted in .claude.json: {data.trust}</div>
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> {t(data)} <span className="subtype">cwd {data.cwd}</span>
              <div>
                commands <Names list={data.commands} /> · skills <Names list={data.skills} /> · agents <Names list={data.agents} /> · MCP <Names list={data.mcp} />
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
        if (event === "bash")
          return (
            <div key={i} className={`tool-call ${data.ran ? "" : "denied"}`}>
              <span className="tag tag-user">Bash</span> {t(data)} <code>{data.command}</code>
              <div className="snippet">{data.ran ? data.output : `denied: ${data.output}`}</div>
            </div>
          );
        if (event === "summary")
          return (
            <div key={i} className={`tool-call ${data.error ? "denied" : ""}`}>
              <span className={`tag ${data.error ? "tag-error" : "tag-result"}`}>{data.error ? "Claude Code exited" : "result"}</span> {t(data)} <span className="subtype">{usd(data.cost)}</span>
              {data.error && <div className="snippet bad">{data.error}</div>}
              {data.warnings
                .filter((w: string) => w !== data.error)
                .map((w: string, j: number) => (
                  <div key={j} className="snippet">
                    stderr: {w}
                  </div>
                ))}
              <div>
                <Hooks hooks={data.hooks} />
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

export function Concept39ProjectConfigRoot() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ part: string; text: string } | null>(null);
  const [cost, setCost] = useState(0);
  const [dry, setDry] = useState<{ flags: any[]; checks: any[] } | null>(null);
  const [rows, setRows] = useState<Record<string, any[]>>({});
  // Part D
  const [cwd, setCwd] = useState("pr");
  const [root, setRoot] = useState("repo");
  const [trust, setTrust] = useState(false);
  const [bash, setBash] = useState(false);
  const [prompt, setPrompt] = useState("/release");
  const [events, setEvents] = useState<Ev[]>([]);

  const fail = () => setError("Could not reach /api/c39 — is this sample's server running on port 3001?");
  useEffect(() => {
    // `npm run dev` starts Vite and the server together; while the server is loading, Vite's proxy answers 502.
    let stop = false;
    const load = async (tries = 15) => {
      try {
        const c = await fetch("/api/c39/code").then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
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

  const PART: Record<string, string> = { dry: "A", where: "B", takeover: "C", try: "D" };
  const begin = (id: string, h: string) => (setRunning(id), setHint({ part: PART[id], text: h }), setError(null));
  const hintAt = (part: string) => hint?.part === part && <p className="hint">{hint.text}</p>;

  async function dryRun() {
    begin("dry", "Left: query() with a spawner that records the args (Concept 36), no Claude Code. Right: the real Claude Code with a root it refuses. It exits before any API call, so this costs nothing.");
    try {
      const r = await fetch("/api/c39/dry", { method: "POST" }).then((x) => x.json());
      if (r.error) setError(r.error);
      else setDry(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function runTable(route: "where" | "takeover", h: string) {
    begin(route, h);
    const got: any[] = [];
    setRows((r) => ({ ...r, [route]: [] }));
    try {
      await streamPost(`/api/c39/${route}`, {}, (event, data) => {
        if (event === "error") return setError(data.message);
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

  async function tryIt() {
    begin("try", "One session with your combination. Try /release (a custom command both checkouts have, with different text), /branch-only, or a question about the code word. About $0.001 per run, $0.003 with Bash.");
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost("/api/c39/try", { cwd, root, trust, bash, prompt }, (event, data) => {
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

  const btn = (id: string, label: string, onClick: () => void) => (
    <button disabled={!!running} className={running === id ? "active" : ""} onClick={onClick}>
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
      <h2>39 · projectConfigRoot</h2>
      <p className="lead">
        A host that runs Claude on a pull request checks the branch out in a <b>git worktree</b> and uses it as <code>cwd</code>. But the branch can carry its own{" "}
        <code>.claude/settings.json</code>: hooks that run on your machine, permission rules, MCP servers. With <code>projectConfigRoot</code>, the <b>code</b> comes from the worktree
        and the <b>project config</b> comes from a checkout you trust.
      </p>
      <div className="card">
        <b>The lab</b> <span className="subtype">config-root-lab/, built on first use with git</span>
        <pre className="wrap snippet">
          {`repo/          branch main   · the trusted checkout · CLAUDE.md "MAPLE" · hook, commands, skill, agent, .mcp.json named "trusted"
repo-pr-42/    branch pr-42  · a git worktree       · CLAUDE.md "BIRCH" · the same files named "branch" + permissions.allow: ["Bash", "Read"]
repo-docs/     branch docs   · a git worktree       · CLAUDE.md "MAPLE" · no .claude/, no .mcp.json`}
        </pre>
        <div className="hint">
          Each hook writes who it is, where it ran and what it saw to a log (never the key itself). <code className="origin from-trusted">trusted</code> and{" "}
          <code className="origin from-branch">branch</code> are coloured everywhere.
        </div>
      </div>
      <div className="row">
        <span className="subtype">spent ${cost.toFixed(4)} (the total_cost_usd of every session)</span>
      </div>

      <h3>A · Where the option goes, and what Claude Code refuses</h3>
      <div className="scenarios">{btn("dry", "1 · Dry run: the flag, and three bad roots", dryRun)}</div>
      {hintAt("A")}
      {dry && (
        <div className="grid2">
          <table className="tools compare">
            <thead>
              <tr>
                <th>setup</th>
                <th>the CLI arg</th>
              </tr>
            </thead>
            <tbody>
              {dry.flags.map((r) => (
                <tr key={r.key}>
                  <td>
                    <code>{r.shown}</code>
                  </td>
                  <td>{r.args.length ? <code>{r.args.join(" ")}</code> : <span className="hint">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="tools compare">
            <thead>
              <tr>
                <th>projectConfigRoot</th>
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
      {dry && <p className="hint">The SDK passes the value as it is, a relative path too. It is Claude Code that checks it, and query() throws "exited with code 1".</p>}

      <h3>B · Where each piece of config comes from</h3>
      <div className="scenarios">
        {btn("where", "2 · Six setups, the same question", () =>
          runTable("where", "Six sessions in parallel, no tools, the same prompt: 'what is the project code word?'. The code word shows where CLAUDE.md came from, system/init shows the commands, skills, agents and MCP servers, and the hook log shows the settings. About $0.005."),
        )}
      </div>
      {hintAt("B")}
      {rows.where?.length > 0 && <WhereTable rows={rows.where} />}

      <h3>C · A pull request tries to take over</h3>
      <div className="scenarios">
        {btn("takeover", "3 · The PR's hook and its permissions.allow", () =>
          runTable("takeover", "Four sessions in the PR worktree, with Bash available but no allowedTools. Only two things change: projectConfigRoot, and which folder the fake CLAUDE_CONFIG_DIR/.claude.json trusts (what the terminal's trust dialog stores). About $0.01 to $0.03 (it depends on the prompt cache)."),
        )}
      </div>
      {hintAt("C")}
      {rows.takeover?.length > 0 && <TakeoverTable rows={rows.takeover} />}

      <h3>D · Try a combination</h3>
      <div className="row">
        <label className="hint">cwd</label>
        {select(cwd, setCwd, [
          ["pr", "repo-pr-42 (the PR worktree)"],
          ["docs", "repo-docs (no .claude)"],
          ["repo", "repo (the trusted checkout)"],
        ])}
        <label className="hint">projectConfigRoot</label>
        {select(root, setRoot, [
          ["repo", "repo (absolute)"],
          ["none", "(not set)"],
          ["pr", "repo-pr-42 (absolute)"],
          ["relative", "'../repo' (relative)"],
          ["missing", "a missing folder"],
        ])}
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={trust} disabled={!!running} onChange={(e) => setTrust(e.target.checked)} /> the main checkout is trusted
        </label>
        <label className="check">
          <input type="checkbox" checked={bash} disabled={!!running} onChange={(e) => setBash(e.target.checked)} /> tools: ['Bash']
        </label>
      </div>
      <div className="row">
        <input className="inline-input wide" maxLength={2000} value={prompt} disabled={!!running} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && prompt.trim() && !running && tryIt()} />
        {btn("try", "4 · Run it", tryIt)}
      </div>
      {hintAt("D")}
      {events.length > 0 && (
        <div className="card">
          <Timeline events={events} />
        </div>
      )}

      <h3>E · What the root changes, what it does not, what is refused</h3>
      <p className="hint">
        The first list is in <code>sdk.d.ts</code>. The details (helpers, refusals) were read from the CLI's code (<code>claude.exe</code> of SDK 0.3.281) and can change between versions.
      </p>
      <Pairs head={["read from the root", "what"]} rows={FROM_ROOT} />
      <Pairs head={["stays with cwd (or elsewhere)", "why"]} rows={STAYS} />
      <Pairs head={["refused", "what Claude Code says"]} rows={REFUSED} />

      <h3>F · The code</h3>
      <div className="row">
        {["options", "lab", "dry", "run", "where", "takeover", "try"].map(
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

      <h3>G · projectConfigRoot, in one table</h3>
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
