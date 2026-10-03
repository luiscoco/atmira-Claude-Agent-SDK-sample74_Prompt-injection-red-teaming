import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type StyleFile = { where: "project" | "user" | "plugin"; file: string; name: string; description: string; keepCoding: boolean; forceForPlugin: boolean; body: string; raw: string };
type Col = { col: number; style: string; [k: string]: any };

// Parts A and B: each one is a POST /compare body. "default" = no outputStyle setting.
const compares: { id: string; label: string; body: any; hint: string }[] = [
  {
    id: "builtin",
    label: "1 · The built-in styles",
    body: { styles: ["default", "Explanatory", "Learning", "Concise"] },
    hint: "The same prompt (find the bug in discount.js) with four built-in styles, in parallel. Only settings.outputStyle changes. Explanatory is told to add ★ Insight boxes and Learning to leave a TODO(human) for YOU to write; Concise cuts the words. Open 'what the API got' in each column: the style is a system-reminder in the first user message. About $0.02.",
  },
  {
    id: "files",
    label: "2 · Your own style files",
    body: { styles: ["default", "Pirate", "Code reviewer", "Spanish"] },
    hint: "Pirate and Code reviewer are project styles (styles-project/.claude/output-styles/, found with settingSources 'project'). Spanish is a user style (CLAUDE_CONFIG_DIR/output-styles/, settingSources 'user'). The same file format for all of them; the name comes from the frontmatter. About $0.02.",
  },
];
const partB: { id: string; label: string; body: any; hint: string }[] = [
  {
    id: "keep",
    label: "3 · keep-coding-instructions",
    body: { styles: ["default", "Tutor", "Tutor (keeps coding)"], preset: true },
    hint: "systemPrompt: the claude_code preset. Tutor and Tutor (keeps coding) have the SAME text; only keep-coding-instructions differs. Look at 'system prompt' in each column: any style changes the first line, and without keep-coding-instructions the whole '# Doing tasks' section is dropped (the coding rules: no extra features, no comments by default, security…). About $0.04.",
  },
];

// Part E: where a style comes from, and what happens.
const table: [string, string, string][] = [
  ["Select a style", "settings: { outputStyle: 'Name' } (the flag layer) · or outputStyle in .claude/settings.json, settings.local.json, CLAUDE_CONFIG_DIR/settings.json", "system/init.output_style = the name. The flag layer wins over the files"],
  ["Built-in styles", "default, Proactive, Concise, Explanatory, Learning", "Always listed in initializationResult().available_output_styles"],
  ["A project style", "<cwd>/.claude/output-styles/<file>.md + settingSources including 'project'", "Listed and applied. Without 'project' in settingSources: not found"],
  ["A user style", "CLAUDE_CONFIG_DIR/output-styles/<file>.md + settingSources including 'user'", "The same, for every project of that user"],
  ["A plugin style", "plugins: [{ type: 'local', path }] with output-styles/<file>.md", "Named '<plugin>:<name>'. With force-for-plugin: true it is applied whatever outputStyle says, and system/init does not tell you"],
  ["The name", "frontmatter name:, or the file name without .md", "Case-sensitive. An unknown name is silently ignored: no error, no warning, init still reports it"],
  ["What the model gets", "a user-message system-reminder: '# Output Style: <name>' + the text, and 'X output style is active…'", "The style is not in the system prompt: it works with the SDK default prompt, the preset or your own string"],
  ["With the claude_code preset", "keep-coding-instructions: true | false (default)", "Any style: the first line becomes 'helps users according to your \"Output Style\"'. false: '# Doing tasks' is removed"],
  ["Switch in a session", "q.applyFlagSettings({ outputStyle }) · null clears it", "Next turn: a new system/init and a new reminder. The old reminders stay in the history: the model may mix styles"],
  ["Save the choice", "q.updateSettings('localSettings', { outputStyle }) + settingSources including 'local'", "Written to <cwd>/.claude/settings.local.json (as /config does). Without 'local': refused ('the localSettings source is disabled'). The flag layer still wins in this session"],
  ["A style file written mid-session", "q.reloadOutputStyles()", "Until you reload, selecting it is silently ignored"],
  ["Subagents", "the Agent tool", "The style is for the main conversation: a subagent's requests carry no style reminder"],
];

// ---------------------------------------------------------------------------------------------

function StyleFiles({ files, builtIn, code }: { files: StyleFile[]; builtIn: string[]; code: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = files.find((f) => f.file === open);
  return (
    <div className="card style-files">
      <b>The lab's styles</b> <span className="subtype">built-in: {builtIn.join(", ")}</span>
      <ul className="files">
        {files.map((f) => (
          <li key={f.file}>
            <button className={open === f.file ? "active" : ""} onClick={() => setOpen(open === f.file ? null : f.file)}>
              {f.name}
            </button>{" "}
            <span className={`tag where-${f.where}`}>{f.where}</span> {f.keepCoding && <code>keep-coding-instructions</code>} {f.forceForPlugin && <code>force-for-plugin</code>}{" "}
            <span className="subtype">{f.file}</span>
            <div className="hint">{f.description}</div>
          </li>
        ))}
        <li>
          <button className={open === "discount.js" ? "active" : ""} onClick={() => setOpen(open === "discount.js" ? null : "discount.js")}>
            discount.js
          </button>{" "}
          <span className="subtype">styles-project/discount.js · the file the prompts ask about</span>
        </li>
      </ul>
      {shown && <pre className="wrap style-raw">{shown.raw}</pre>}
      {open === "discount.js" && <pre className="wrap style-raw">{code}</pre>}
    </div>
  );
}

const Verdict = ({ v }: { v?: string }) => (v ? <span className={`tag v-${v}`}>{v}</span> : null);

function WhoTable({ rows }: { rows: any[] }) {
  return (
    <table className="tools compare">
      <thead>
        <tr>
          <th>setup</th>
          <th>options</th>
          <th>system/init output_style</th>
          <th>listed</th>
          <th>the API got</th>
          <th>host check</th>
          <th>answer</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td>
              <code>{r.shown}</code>
            </td>
            <td>
              <code>{r.init ?? "?"}</code>
            </td>
            <td>{r.listed === undefined ? "" : <code className={r.listed ? "" : "bad"}>{r.listed ? "yes" : "no"}</code>}</td>
            <td>{r.got ? <code>{r.got}</code> : <span className="subtype">no style</span>}</td>
            <td>
              <Verdict v={r.verdict} />
              <div className="hint">{r.why}</div>
            </td>
            <td className="hint">{r.error ? <code className="bad">{r.error}</code> : r.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SystemBox({ s }: { s: any }) {
  return (
    <details className="style-sys">
      <summary className="subtype">
        system prompt: {s.chars} chars{s.same ? " · the same as default" : s.removedChars !== undefined ? ` · ${s.removedChars > 0 ? `−${s.removedChars}` : `+${-s.removedChars}`} vs default` : ""}
        {s.removedHeadings?.length > 0 && <b className="bad"> · removed {s.removedHeadings.join(", ")}</b>}
      </summary>
      <div className="snippet">first line: {s.firstLine}</div>
      <div className="snippet">sections: {s.headings.join(" · ") || "(none: the SDK's short default prompt)"}</div>
      {s.addedCount > 0 && (
        <div className="snippet">
          + {s.addedCount} line(s): {s.added.join(" ⏎ ")}
        </div>
      )}
      {s.removedCount > 0 && (
        <div className="snippet bad">
          − {s.removedCount} line(s):
          {s.removed.map((l: string, i: number) => (
            <div key={i}>{l}</div>
          ))}
          {s.removedCount > s.removed.length && <div>…</div>}
        </div>
      )}
    </details>
  );
}

function Columns({ cols, systems, files }: { cols: Col[]; systems: Record<number, any>; files: Record<number, any> }) {
  return (
    <div className="style-grid">
      {cols.map((c) => (
        <div key={c.col} className={`card style-col v-border-${c.verdict}`}>
          <b>{c.style}</b> <Verdict v={c.verdict} /> <span className="subtype">${c.cost?.toFixed(4)}</span>
          <div className="hint">
            init: <code>{c.init ?? "?"}</code> · {c.why}
          </div>
          {files[c.col] && (
            <details>
              <summary className="subtype">your file: {files[c.col].file}</summary>
              <pre className="wrap style-raw">{files[c.col].text}</pre>
            </details>
          )}
          {c.reminder && (
            <details>
              <summary className="subtype">what the API got (user message {c.reminder.msg})</summary>
              <pre className="wrap style-raw">
                {"<system-reminder>\n# Output Style: "}
                {c.reminder.name}
                {"\n"}
                {c.reminder.text}
                {"\n</system-reminder>"}
              </pre>
            </details>
          )}
          {systems[c.col] && <SystemBox s={systems[c.col]} />}
          {c.tools?.length > 0 && <div className="subtype">tools: {c.tools.join(", ")}</div>}
          {c.apiError && <div className="snippet bad">API error: {c.apiError} — a synthetic message, the model never ran.</div>}
          {c.error && <div className="snippet bad">{c.error}</div>}
          <div className="answer thin style-answer">{c.text || "(no text)"}</div>
        </div>
      ))}
    </div>
  );
}

function LiveTimeline({ events }: { events: { event: string; data: any }[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        if (event === "control")
          return (
            <div key={i} className="tool-call call">
              <span className="tag tag-call">host</span> <code>{data.method}</code> {t}
              <pre className="wrap tur">→ {JSON.stringify(data.result)}</pre>
              {data.note && <div className="hint">{data.note}</div>}
            </div>
          );
        if (event === "turn") {
          const ignored = data.init && data.init !== "default" && data.fresh.length === 0 && data.history.at(-1) !== data.init;
          return (
            <div key={i} className={`tool-call style-turn ${ignored ? "denied" : ""}`}>
              <span className="tag tag-user">turn {data.turn}</span> <span className="subtype">{data.prompt}</span> {t}
              <div className="snippet">
                host asked: {data.asked} · system/init output_style: <b>{data.init}</b> · new style reminder on the wire:{" "}
                {data.fresh.length ? <b>{data.fresh.map((r: any) => r.name).join(", ")}</b> : <b className="bad">none</b>}
                {ignored && " → the style was ignored"}
              </div>
              <div className="snippet">style reminders in the history: {data.history.join(" → ") || "none"}</div>
              <div className="answer thin">{data.text}</div>
            </div>
          );
        }
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span>
              <div className="snippet">{data.message}</div>
            </div>
          );
        return null;
      })}
    </div>
  );
}

function preview(c: { name: string; description: string; keepCoding: boolean; body: string }) {
  const fm = [`name: ${JSON.stringify(c.name.trim())}`, `description: ${JSON.stringify(c.description.trim() || "Written in the lab")}`, ...(c.keepCoding ? ["keep-coding-instructions: true"] : [])];
  return `---\n${fm.join("\n")}\n---\n${c.body.trim()}\n`;
}

export function Concept34OutputStyles() {
  const [lab, setLab] = useState<{ builtIn: string[]; files: StyleFile[]; code: string } | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [cols, setCols] = useState<Col[]>([]);
  const [systems, setSystems] = useState<Record<number, any>>({});
  const [files, setFiles] = useState<Record<number, any>>({});
  const [liveEvents, setLiveEvents] = useState<{ event: string; data: any }[]>([]);
  const [whoRows, setWhoRows] = useState<any[]>([]);
  const [options, setOptions] = useState<{ prompt: string; options: any } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [shown, setShown] = useState<"compare" | "live" | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState({
    name: "Bullet points",
    description: "Only short bullet points",
    keepCoding: true,
    where: "project" as "project" | "user",
    body: "Answer ONLY with 3 to 5 short bullet points, at most 12 words each. Code goes in one block after the bullets.",
  });
  const [prompt, setPrompt] = useState("Read discount.js. Is there a bug? Show the fixed function in your answer. Do not edit any file.");
  const [preset, setPreset] = useState(false);

  useEffect(() => {
    const fail = () => setError("Could not reach /api/c34 — is this sample's server running on port 3001?");
    fetch("/api/c34/styles").then((r) => r.json()).then(setLab).catch(fail);
    fetch("/api/c34/code").then((r) => r.json()).then(setCode).catch(fail);
  }, []);

  async function compare(label: string, body: any, h: string | null) {
    setRunning(label);
    setShown("compare");
    setHint(h);
    setError(null);
    setOptions(null);
    setCols([]);
    setSystems({});
    setFiles({});
    const got: Col[] = [];
    try {
      await streamPost("/api/c34/compare", body, (event, data) => {
        if (event === "opened") setOptions(data);
        if (event === "column") (got.push(data), setCols([...got].sort((a, b) => a.col - b.col)));
        if (event === "system") setSystems((s) => ({ ...s, [data.col]: data }));
        if (event === "customFile") setFiles((f) => ({ ...f, [data.col]: data }));
        if (event === "error") setError(data.message);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function live() {
    const h =
      "One session with streaming input, 5 turns. It starts with Pirate. Between turns the host calls applyFlagSettings, writes a new style file (ignored until reloadOutputStyles), then saves Explanatory with updateSettings and clears the flag. Each turn shows what system/init says and whether a NEW style reminder reached the API. About $0.02.";
    setRunning("live");
    setShown("live");
    setHint(h);
    setError(null);
    setOptions(null);
    const got: { event: string; data: any }[] = [];
    setLiveEvents([]);
    try {
      await streamPost("/api/c34/live", {}, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setOptions(data);
        got.push({ event, data });
        setLiveEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function who() {
    setRunning("who");
    setError(null);
    const rows: any[] = [];
    setWhoRows([]);
    try {
      await streamPost("/api/c34/who", {}, (event, data) => {
        if (event === "whoRow") setWhoRows((rows.push(data), [...rows]));
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  const cost = cols.reduce((s, c) => s + (c.cost ?? 0), 0) + liveEvents.filter((e) => e.event === "turn").reduce((s, e) => s + (e.data.cost ?? 0), 0);
  const button = (s: { id: string; label: string; body: any; hint: string }) => (
    <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => compare(s.label, s.body, s.hint)}>
      {s.label}
    </button>
  );
  const runCustom = () =>
    compare(
      "custom",
      {
        styles: ["default", custom.name.trim()],
        prompt,
        ...(preset && { preset: true }),
        custom: { name: custom.name.trim(), description: custom.description.trim() || undefined, keepCoding: custom.keepCoding, where: custom.where, body: custom.body },
      },
      null,
    );

  return (
    <section>
      <h2>34 · Output styles</h2>
      <p className="lead">
        An <b>output style</b> changes <b>how</b> the agent answers (its voice, the shape of each answer, whether it teaches) and keeps what it can do. It is a
        Markdown file with a little frontmatter, selected with the <code>outputStyle</code> <b>setting</b> (there is no <code>outputStyle</code> option). This
        tab runs the same prompt in several styles, looks at the requests on the wire to see what each style really sends to the model, and switches styles
        inside one session.
      </p>
      {lab && <StyleFiles files={lab.files} builtIn={lab.builtIn} code={lab.code} />}

      <h3>A · Select a style</h3>
      <div className="row">
        <button disabled={!!running} className={running === "who" ? "active" : ""} onClick={who}>
          {running === "who" ? "Checking…" : "0 · Which style really applied?"}
        </button>
        <span className="subtype">7 setups in parallel, one short answer each · about $0.02</span>
      </div>
      {whoRows.length > 0 && <WhoTable rows={whoRows} />}
      <div className="scenarios">{compares.map(button)}</div>

      <h3>B · What a style changes in the system prompt</h3>
      <p className="hint">
        The style text itself is not in the system prompt. With the <code>claude_code</code> preset, though, selecting a style also edits the preset:{" "}
        <code>keep-coding-instructions</code> decides whether its coding rules stay.
      </p>
      <div className="scenarios">{partB.map(button)}</div>

      <h3>C · Switching styles in one session</h3>
      <div className="scenarios">
        <button disabled={!!running} className={running === "live" ? "active" : ""} onClick={live}>
          {running === "live" ? "Running…" : "4 · Switch mid-session"}
        </button>
      </div>

      <div className="card config">
        <label>your own style (written to a file before the run; it runs next to "default")</label>
        <div className="form-grid">
          <label>
            name (case-sensitive)
            <input maxLength={40} value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          </label>
          <label>
            description
            <input maxLength={200} value={custom.description} onChange={(e) => setCustom({ ...custom, description: e.target.value })} />
          </label>
          <label>
            where
            <select value={custom.where} onChange={(e) => setCustom({ ...custom, where: e.target.value as "project" | "user" })}>
              <option value="project">project: &lt;cwd&gt;/.claude/output-styles/</option>
              <option value="user">user: CLAUDE_CONFIG_DIR/output-styles/</option>
            </select>
          </label>
        </div>
        <label>the style's instructions</label>
        <textarea rows={3} maxLength={3000} value={custom.body} onChange={(e) => setCustom({ ...custom, body: e.target.value })} style={{ width: "100%" }} />
        <label>prompt (the agent has the Read tool and discount.js)</label>
        <textarea rows={2} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%" }} />
        <label className="check">
          <input type="checkbox" checked={custom.keepCoding} onChange={(e) => setCustom({ ...custom, keepCoding: e.target.checked })} /> <span>keep-coding-instructions: true</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={preset} onChange={(e) => setPreset(e.target.checked)} /> <span>systemPrompt: {"{ type: 'preset', preset: 'claude_code' }"} (to see what the style does to the system prompt)</span>
        </label>
        <details>
          <summary className="subtype">the file that will be written</summary>
          <pre className="wrap style-raw">{preview(custom)}</pre>
        </details>
        <div className="row">
          <button className="primary" disabled={!!running || !custom.name.trim() || !custom.body.trim() || !prompt.trim()} onClick={runCustom}>
            {running === "custom" ? "Running…" : "Run default vs my style"}
          </button>
        </div>
      </div>

      {hint && <p className="hint">{hint}</p>}
      {shown === "compare" && (cols.length > 0 || running) && (
        <div className="card">
          <b>Columns</b>{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · {cols.length} finished · ${cost.toFixed(4)}
          </span>
          <Columns cols={cols} systems={systems} files={files} />
        </div>
      )}
      {shown === "live" && (liveEvents.length > 0 || running) && (
        <div className="card">
          <b>One session</b>{" "}
          <span className="subtype">
            {running ? "running…" : "done"} · ${cost.toFixed(4)}
          </span>
          <LiveTimeline events={liveEvents} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">prompt and options sent to query()</summary>
          <pre className="wrap">{options.prompt}</pre>
          <pre className="wrap">{JSON.stringify(options.options, null, 2)}</pre>
        </details>
      )}

      <h3>D · The code</h3>
      <div className="row">
        {["files", "options", "wire", "system", "check", "messages", "custom", "live"].map(
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

      <h3>E · Where a style comes from, and what it does</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>What</th>
            <th>How</th>
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
