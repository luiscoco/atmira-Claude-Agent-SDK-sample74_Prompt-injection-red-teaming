import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept16SettingsEnv() {
  return (
    <section>
      <h2>16 · Settings &amp; env</h2>
      <p className="lead">
        <code>query()</code> starts a Claude Code process. Two things configure it besides the options you have used so
        far: its <b>environment variables</b> (<code>env</code>) and its <b>settings</b>, read from settings files (
        <code>settingSources</code>) and passed in code (<code>settings</code>, <code>managedSettings</code>). Every run
        here uses Haiku in <code>settings-lab/project</code>. Bash can only run <code>printenv</code> and <code>echo</code>,
        so you can see the real environment of the process.
      </p>
      <EnvPart />
      <hr />
      <LayersPart />
      <hr />
      <AccessPart />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared: one streamed run, and what to read out of its messages
// ---------------------------------------------------------------------------------------------

type Run = { options?: any; messages: any[]; error?: string; running: boolean };
const EMPTY: Run = { messages: [], running: false };

async function startRun(url: string, body: object, update: (fn: (r: Run) => Run) => void) {
  update(() => ({ messages: [], running: true }));
  try {
    await streamPost(url, body, (event, data) => {
      if (event === "options") update((r) => ({ ...r, options: data }));
      if (event === "message") update((r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "error") update((r) => ({ ...r, error: data.message }));
    });
  } finally {
    update((r) => ({ ...r, running: false }));
  }
}

function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return JSON.stringify(content);
}

/** The pieces every card shows: the init message, the tool calls with their results, and the result. */
function readRun(run: Run) {
  const init = run.messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = run.messages.find((m) => m.type === "result");
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of run.messages)
    if (m.type === "user" && Array.isArray(m.message.content))
      for (const b of m.message.content) if (b.type === "tool_result") results.set(b.tool_use_id, { text: blockText(b.content), isError: Boolean(b.is_error) });
  const calls = run.messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ id: b.id, name: b.name, input: b.input.command ?? b.input.file_path ?? JSON.stringify(b.input), result: results.get(b.id) }));
  const denied = new Set<string>((result?.permission_denials ?? []).map((d: any) => d.tool_use_id));
  return { init, result, calls, denied };
}

function RunCard({ title, shape, run }: { title: string; shape?: string; run: Run }) {
  const { init, result, calls, denied } = readRun(run);
  return (
    <div className="card config">
      <b>{title}</b>
      {shape && (
        <div>
          <code>{shape}</code>
        </div>
      )}
      {init && (
        <div className="hint">
          apiKeySource: <b>{init.apiKeySource}</b> · model: {init.model}
          {init.plugins?.length > 0 && <> · plugins: {init.plugins.map((p: any) => p.name).join(", ")}</>}
        </div>
      )}
      {calls.map((c) => (
        <div key={c.id} className={`tool-call ${denied.has(c.id) ? "denied" : ""}`}>
          <span className="tag">{c.name}</span> <code>{c.input.length > 90 ? c.input.slice(0, 90) + "…" : c.input}</code>
          {c.result && <div className="snippet">{c.result.text.slice(0, 600)}</div>}
        </div>
      ))}
      {run.error && <div className="snippet">⚠ {run.error}</div>}
      {result && (
        <div className="hint">
          <span className={`subtype ${result.subtype === "success" ? "" : "bad"}`}>{result.subtype}</span> · $
          {result.total_cost_usd.toFixed(4)}
          {result.permission_denials?.length > 0 && <> · {result.permission_denials.length} permission denial(s)</>}
        </div>
      )}
      {run.running && <div className="hint">running…</div>}
      {(run.options || run.messages.length > 0) && (
        <details>
          <summary className="hint">options sent to query() and raw messages</summary>
          {run.options && <pre>{JSON.stringify(run.options, null, 2)}</pre>}
          <MessageLog messages={run.messages} />
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A: env
// ---------------------------------------------------------------------------------------------

const envVariants = [
  { id: "omitted", label: "env omitted", shape: "(no env)" },
  { id: "spread", label: "spread + yours", shape: "env: { ...process.env, LAB_TEAM, CLAUDE_AGENT_SDK_CLIENT_APP }" },
  { id: "only", label: "yours only", shape: "env: { LAB_TEAM, CLAUDE_AGENT_SDK_CLIENT_APP }" },
  { id: "removeKey", label: "remove one", shape: "env: { ...process.env, ANTHROPIC_API_KEY: undefined, LAB_TEAM }" },
] as const;
type EnvId = (typeof envVariants)[number]["id"];

function EnvPart() {
  const [team, setTeam] = useState("sdd-team");
  const [runs, setRuns] = useState<Partial<Record<EnvId, Run>>>({});
  const running = Object.values(runs).some((r) => r?.running);

  function runAll() {
    setRuns({});
    for (const v of envVariants)
      startRun("/api/c16/env-run", { variant: v.id, team }, (fn) => setRuns((prev) => ({ ...prev, [v.id]: fn(prev[v.id] ?? EMPTY) })));
  }

  const parentHasKey = Object.values(runs).find((r) => r?.options)?.options.parentHasKey;

  return (
    <>
      <h3>A · env: the environment of the Claude Code process</h3>
      <p className="hint">
        Without <code>env</code> the process inherits <code>process.env</code>, and that is how <code>.env</code>'s{" "}
        <code>ANTHROPIC_API_KEY</code> reaches it (Concept 1). With <code>env</code> set, the process gets{" "}
        <b>only</b> that object, not a merge. Compare <code>apiKeySource</code> in the four columns.
      </p>
      <div className="form-grid">
        <label>
          Value for <code>LAB_TEAM</code>
          <input value={team} onChange={(e) => setTeam(e.target.value)} disabled={running} />
        </label>
      </div>
      <button className="primary" onClick={runAll} disabled={running || !team.trim()}>
        {running ? "Running…" : "Run the 4 env variants in parallel"}
      </button>
      {parentHasKey === false && (
        <div className="card warn">
          The server has no <code>ANTHROPIC_API_KEY</code> (no <code>.env</code>, or it is empty), so every column uses the
          login and the key columns look the same. Put a key in <code>.env</code> to see the difference.
        </div>
      )}
      <div className="compare-grid">
        {envVariants
          .filter((v) => runs[v.id])
          .map((v) => (
            <RunCard key={v.id} title={v.label} shape={v.shape} run={runs[v.id]!} />
          ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: settings layers
// ---------------------------------------------------------------------------------------------

const SOURCES = ["user", "project", "local"] as const;
type Source = (typeof SOURCES)[number];

const presets: { label: string; state: Partial<LayersState> }[] = [
  { label: "No files ([])", state: { omit: false, sources: [], flag: "none", managedJson: "", optionsEnvLayer: "" } },
  { label: "project", state: { omit: false, sources: ["project"], flag: "none", managedJson: "", optionsEnvLayer: "" } },
  { label: "project + local", state: { omit: false, sources: ["project", "local"], flag: "none", managedJson: "", optionsEnvLayer: "" } },
  { label: "+ settings (inline)", state: { omit: false, sources: ["project", "local"], flag: "inline", managedJson: "", optionsEnvLayer: "" } },
  { label: "Options.env vs project", state: { omit: false, sources: ["project"], flag: "none", managedJson: "", optionsEnvLayer: "options.env" } },
  {
    label: "managedSettings",
    state: { omit: false, sources: ["project"], flag: "none", managedJson: '{\n  "model": "claude-opus-5-5",\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}', optionsEnvLayer: "" },
  },
];

type LayersState = {
  omit: boolean;
  sources: Source[];
  flag: "none" | "inline" | "file";
  flagJson: string;
  managedJson: string;
  optionsEnvLayer: string;
};

function LayersPart() {
  const [state, setState] = useState<LayersState>({
    omit: false,
    sources: ["project", "local"],
    flag: "none",
    flagJson: '{\n  "env": { "LAB_LAYER": "flag (inline object)" }\n}',
    managedJson: "",
    optionsEnvLayer: "",
  });
  const [files, setFiles] = useState<{ project: string; local: string; flagFile: string }>();
  const [resolved, setResolved] = useState<any>();
  const [run, setRun] = useState<Run>();

  useEffect(() => {
    fetch("/api/c16/files").then((r) => r.json()).then(setFiles);
  }, []);

  const set = (change: Partial<LayersState>) => {
    setState((s) => ({ ...s, ...change }));
    setResolved(undefined);
  };
  const body = { ...state, sources: state.omit ? null : SOURCES.filter((s) => state.sources.includes(s)) };

  async function resolve() {
    const res = await fetch("/api/c16/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setResolved(await res.json());
  }

  function runIt() {
    resolve();
    startRun("/api/c16/layers-run", body, (fn) => setRun((prev) => fn(prev ?? EMPTY)));
  }

  function toggle(s: Source) {
    set({ sources: state.sources.includes(s) ? state.sources.filter((x) => x !== s) : [...state.sources, s] });
  }

  return (
    <>
      <h3>B · The settings layers</h3>
      <p className="hint">
        Settings come in layers, from low to high precedence: <b>user</b> (<code>~/.claude/settings.json</code>) →{" "}
        <b>project</b> (<code>.claude/settings.json</code>) → <b>local</b> (<code>.claude/settings.local.json</code>) →{" "}
        <b>flag</b> (<code>settings</code>) → <b>managed</b> (policy). <code>settingSources</code> picks which files are
        read. <b>Resolve</b> calls <code>resolveSettings()</code>, which merges them like the CLI does without starting it
        (free). <b>Run</b> starts <code>query()</code> and prints <code>LAB_LAYER</code>, so you can check the result.
      </p>

      <details className="card">
        <summary>
          The files in <b>settings-lab/</b>
        </summary>
        <h4>project/.claude/settings.json</h4>
        <pre>{files?.project}</pre>
        <h4>project/.claude/settings.local.json</h4>
        <pre>{files?.local}</pre>
        <h4>flag-settings.json (used by settings: "path")</h4>
        <pre>{files?.flagFile}</pre>
      </details>

      <div className="scenarios">
        {presets.map((p) => (
          <button key={p.label} onClick={() => set(p.state)} disabled={run?.running}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="card config">
        <div className="row">
          <b>settingSources:</b>
          <label className="check">
            <input type="checkbox" checked={state.omit} onChange={() => set({ omit: !state.omit })} /> omitted (= all three)
          </label>
          {SOURCES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={state.omit || state.sources.includes(s)} disabled={state.omit} onChange={() => toggle(s)} /> {s}
            </label>
          ))}
        </div>
        {(state.omit || state.sources.includes("user")) && (
          <div className="hint">
            "user" reads your real <code>~/.claude/settings.json</code>. Values of keys that look secret are hidden. The
            runs still use Haiku, because <code>Options.model</code> wins over <code>model</code> from any settings file.
          </div>
        )}
        <div className="row">
          <b>settings:</b>
          {(["none", "inline", "file"] as const).map((f) => (
            <label key={f} className="check">
              <input type="radio" checked={state.flag === f} onChange={() => set({ flag: f })} />{" "}
              {f === "none" ? "omitted" : f === "inline" ? "inline object" : 'path: "settings-lab/flag-settings.json"'}
            </label>
          ))}
        </div>
        {state.flag === "inline" && <textarea rows={3} value={state.flagJson} onChange={(e) => set({ flagJson: e.target.value })} style={{ fontFamily: "monospace" }} />}
        <div className="form-grid">
          <label>
            <b>managedSettings</b> (JSON, optional)
            <textarea rows={4} value={state.managedJson} onChange={(e) => set({ managedJson: e.target.value })} style={{ fontFamily: "monospace" }} placeholder='{ "permissions": { "deny": ["Bash(rm:*)"] } }' />
          </label>
          <label>
            <b>Options.env</b> <code>LAB_LAYER</code> (optional)
            <input value={state.optionsEnvLayer} onChange={(e) => set({ optionsEnvLayer: e.target.value })} placeholder="e.g. options.env" />
            <span className="hint">Sent as env: {"{ ...process.env, LAB_LAYER }"}. Does it beat a settings file?</span>
          </label>
        </div>
        <div className="row">
          <button onClick={resolve}>Resolve (no model call)</button>
          <button className="primary" onClick={runIt} disabled={run?.running}>
            {run?.running ? "Running…" : "Run query() with these layers"}
          </button>
        </div>
      </div>

      {resolved && <Resolved data={resolved} />}
      {run && <RunCard title="query() with these layers" run={run} />}
    </>
  );
}

function Resolved({ data }: { data: any }) {
  if (data.error) return <div className="card warn">⚠ {data.error}</div>;
  const where = (e: any) => e.path?.replace(/^.*[\\/](\.claude[\\/])/, "…/$1") ?? (e.policyOrigin ? `policyOrigin: ${e.policyOrigin}` : "");
  return (
    <div className="card">
      <b>resolveSettings()</b> <span className="hint">took {data.took} ms, no API call</span>
      <h4>sources (low → high precedence)</h4>
      <table className="tools">
        <thead>
          <tr>
            <th>source</th>
            <th>file</th>
            <th>keys</th>
          </tr>
        </thead>
        <tbody>
          {data.sources.map((s: any, i: number) => (
            <tr key={i}>
              <td>
                <span className="tag">{s.source}</span>
              </td>
              <td>
                <code>{where(s)}</code>
              </td>
              <td>
                <code>{Object.keys(s.settings).join(", ")}</code>
              </td>
            </tr>
          ))}
          {data.flag && (
            <tr>
              <td>
                <span className="tag tag-error">flag</span>
              </td>
              <td colSpan={2} className="hint">
                <code>settings</code> is not an input of <code>resolveSettings()</code>. <code>query()</code> applies it on top of the files: {JSON.stringify(data.flag)}
              </td>
            </tr>
          )}
          {data.sources.length === 0 && !data.flag && (
            <tr>
              <td colSpan={3} className="hint">
                No sources: the process starts with no settings at all.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <h4>provenance: who set each top-level key</h4>
      <table className="tools">
        <tbody>
          {Object.entries(data.provenance).map(([key, e]: [string, any]) => (
            <tr key={key}>
              <td>
                <code>{key}</code>
              </td>
              <td>
                <span className="tag">{e.source}</span>
              </td>
              <td>
                <code>{where(e)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Provenance is per <b>top-level</b> key: <code>env</code> is credited to the highest layer that has an{" "}
        <code>env</code>, even when some of its variables came from a lower one. Use <code>sources</code> to see the
        nested keys.
      </p>
      <h4>effective (merged)</h4>
      <pre>{JSON.stringify(data.effective, null, 2)}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part C: additionalDirectories and permissions.deny
// ---------------------------------------------------------------------------------------------

const FILES = {
  readme: "project/readme.txt (inside cwd)",
  secret: "project/secret.txt (inside cwd)",
  glossary: "shared/glossary.txt (outside cwd)",
} as const;
type FileKey = keyof typeof FILES;
type Access = { file: FileKey; projectSettings: boolean; additionalDir: boolean };

const initialColumns: Access[] = [
  { file: "glossary", projectSettings: false, additionalDir: false },
  { file: "glossary", projectSettings: false, additionalDir: true },
  { file: "secret", projectSettings: false, additionalDir: false },
  { file: "secret", projectSettings: true, additionalDir: false },
];

function AccessPart() {
  const [columns, setColumns] = useState(initialColumns);
  const [runs, setRuns] = useState<Record<number, Run>>({});
  const running = Object.values(runs).some((r) => r.running);

  const change = (i: number, patch: Partial<Access>) => setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function runAll() {
    setRuns({});
    columns.forEach((c, i) => startRun("/api/c16/access-run", c, (fn) => setRuns((prev) => ({ ...prev, [i]: fn(prev[i] ?? EMPTY) }))));
  }

  return (
    <>
      <h3>C · Which files the agent can reach</h3>
      <p className="hint">
        Reading inside <code>cwd</code> needs no permission. Reading outside it needs <code>additionalDirectories</code>{" "}
        (or an allow rule). A <code>permissions.deny</code> rule in a settings file blocks a file even inside{" "}
        <code>cwd</code>, but only when <code>settingSources</code> loads that file. Watch the model try another tool
        when <code>Read</code> is refused.
      </p>
      <div className="compare-grid">
        {columns.map((c, i) => (
          <div key={i} className="card config">
            <label>
              File
              <select value={c.file} onChange={(e) => change(i, { file: e.target.value as FileKey })} disabled={running}>
                {Object.entries(FILES).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={c.projectSettings} onChange={() => change(i, { projectSettings: !c.projectSettings })} disabled={running} />
              settingSources: ["project"]
            </label>
            <label className="check">
              <input type="checkbox" checked={c.additionalDir} onChange={() => change(i, { additionalDir: !c.additionalDir })} disabled={running} />
              additionalDirectories: [shared]
            </label>
          </div>
        ))}
      </div>
      <button className="primary" onClick={runAll} disabled={running}>
        {running ? "Running…" : "Run the 4 columns in parallel"}
      </button>
      <div className="compare-grid">
        {columns.map((c, i) =>
          runs[i] ? <RunCard key={i} title={`${i + 1}. ${FILES[c.file].split(" ")[0]}`} shape={[c.projectSettings && 'settingSources: ["project"]', c.additionalDir && "additionalDirectories: [shared]"].filter(Boolean).join(", ") || "(neither)"} run={runs[i]} /> : null,
        )}
      </div>
    </>
  );
}
