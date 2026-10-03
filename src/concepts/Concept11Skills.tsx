import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

type Skill = { folder: string; source: string; path: string; frontmatter: Record<string, string>; body: string; files: string[] };
type Run = { options?: any; messages: any[]; commands?: any[]; controls: any[]; error?: string; running: boolean };

const emptyRun = (): Run => ({ messages: [], controls: [], running: true });

/** Runs one SSE request and collects everything it sends into a Run. */
function useRun(url: string) {
  const [run, setRun] = useState<Run | null>(null);
  async function start(body: object) {
    setRun(emptyRun());
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "options") setRun((r) => ({ ...r!, options: data }));
        if (event === "message") setRun((r) => ({ ...r!, messages: [...r!.messages, data] }));
        if (event === "commands") setRun((r) => ({ ...r!, commands: data }));
        if (event === "control") setRun((r) => ({ ...r!, controls: [...r!.controls, data] }));
        if (event === "error") setRun((r) => ({ ...r!, error: data.message }));
      });
    } finally {
      setRun((r) => ({ ...r!, running: false }));
    }
  }
  return { run, start };
}

const finalText = (messages: any[]) =>
  messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

const lastResult = (messages: any[]) => messages.filter((m) => m.type === "result").at(-1);
const promptTokens = (r: any) => r && r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens;
const isSkillFile = (p = "") => /[\\/](\.claude[\\/]skills|skills-plugin)[\\/]/.test(p);

/** Turns the raw stream into the progressive-disclosure steps: which skill level was loaded, and when. */
function disclosureSteps(prompt: string, messages: any[]) {
  const steps: { level: string; text: string }[] = [];
  if (prompt.trim().startsWith("/")) steps.push({ level: "user", text: `${prompt.trim().split(" ")[0]} typed by the user: the CLI expanded the skill before the model saw it (no Skill tool call)` });
  for (const m of messages) {
    if (m.type === "assistant")
      for (const b of m.message.content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "Skill") steps.push({ level: "2", text: `Skill(${JSON.stringify(b.input)}): the model chose a skill from its listing` });
        else if (b.name === "Read" && isSkillFile(b.input.file_path)) steps.push({ level: "3", text: `Read ${b.input.file_path.split(/[\\/]/).slice(-2).join("/")}: an extra file from the skill's folder` });
        else steps.push({ level: "tool", text: `${b.name} ${b.input.file_path?.split(/[\\/]/).slice(-2).join("/") ?? ""}: a normal tool call the skill asked for` });
      }
    // The Skill tool answers "Launching skill: x"; the SKILL.md body arrives right after, as a synthetic user message.
    if (m.type === "user" && m.isSynthetic && Array.isArray(m.message.content)) {
      const text = m.message.content.map((b: any) => b.text ?? "").join("");
      if (text.startsWith("Base directory for this skill")) steps.push({ level: "2", text: `SKILL.md body injected into the conversation (${text.length} chars, isSynthetic: true)` });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------

const scenarios = [
  { label: "Model picks a skill", prompt: "How are the team tasks going?" },
  { label: "Level 3: extra file", prompt: "Write release notes: added dark mode, fixed the CSV export encoding, removed the old v1 API." },
  { label: "Plugin skill", prompt: "Commit message for: fixed the CSV export encoding in the reports page" },
  { label: "User types /name", prompt: "/deploy-checklist staging" },
  { label: "Hidden from the model", prompt: "Use the deploy-checklist skill for staging." },
  { label: "No skill matches", prompt: "What is the capital of France? One word." },
];

const variants = [
  { id: "isolated", label: "isolated", shape: "settingSources: []" },
  { id: "project", label: "project", shape: 'settingSources: ["project"], cwd' },
  { id: "noBundled", label: "project, no bundled", shape: "+ settings: { disableBundledSkills: true }" },
  { id: "filtered", label: "filtered", shape: '+ skills: ["task-report"]' },
  { id: "plugin", label: "+ plugin", shape: '+ plugins: [{ type: "local", path }], skills: "all"' },
] as const;

type VariantId = (typeof variants)[number]["id"];

export function Concept11Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    fetch("/api/c11/skills").then((r) => r.json()).then(setSkills);
  }, []);

  // Part A
  const [invokePrompt, setInvokePrompt] = useState(scenarios[0].prompt);
  const invoke = useRun("/api/c11/invoke");

  // Part B
  const [loadPrompt, setLoadPrompt] = useState("List every skill you can use, one per line, name only. Nothing else.");
  const [loads, setLoads] = useState<Partial<Record<VariantId, Run>>>({});

  // Part C
  const [subPrompt, setSubPrompt] = useState("How are the team tasks going? Ask the reporter agent and give me its answer verbatim.");
  const [reloadPrompt, setReloadPrompt] = useState("Hello!");
  const sub = useRun("/api/c11/subagent");
  const reload = useRun("/api/c11/reload");

  const loading = Object.values(loads).some((r) => r?.running);

  function updateLoad(id: VariantId, change: (run: Run) => Run) {
    setLoads((prev) => ({ ...prev, [id]: change(prev[id] ?? emptyRun()) }));
  }

  async function runLoad(variant: VariantId) {
    updateLoad(variant, emptyRun);
    try {
      await streamPost("/api/c11/load", { prompt: loadPrompt, variant }, (event, data) => {
        if (event === "options") updateLoad(variant, (r) => ({ ...r, options: data }));
        if (event === "message") updateLoad(variant, (r) => ({ ...r, messages: [...r.messages, data] }));
        if (event === "commands") updateLoad(variant, (r) => ({ ...r, commands: data }));
        if (event === "error") updateLoad(variant, (r) => ({ ...r, error: data.message }));
      });
    } finally {
      updateLoad(variant, (r) => ({ ...r, running: false }));
    }
  }

  function runAllLoads() {
    setLoads({});
    variants.forEach((v) => runLoad(v.id));
  }

  return (
    <section>
      <h2>11 · Skills</h2>
      <p className="lead">
        A <b>skill</b> is a folder with a <code>SKILL.md</code>: instructions the agent loads <i>only when it needs them</i>. Part A shows what a
        skill is and how it gets invoked. Part B shows which options decide the skills the agent has. Part C covers subagents and reloading.
      </p>

      {/* ------------------------------------------------------------------------------------ */}
      <h3>A · Fundamentals: anatomy and progressive disclosure</h3>

      <div className="card">
        <b>Three levels, loaded as late as possible</b>
        <ol className="steps">
          <li>
            <b>Level 1 · listing</b>: every skill's <code>name</code> + <code>description</code> (the frontmatter) is always in context. This is
            how the model decides <i>when</i> to use a skill, so the description must say when.
          </li>
          <li>
            <b>Level 2 · SKILL.md body</b>: injected only when the model calls the <code>Skill</code> tool, or the user types{" "}
            <code>/name</code>.
          </li>
          <li>
            <b>Level 3 · extra files</b>: templates, data, scripts in the same folder. Read with <code>Read</code>/<code>Bash</code> only if the
            body says so.
          </li>
        </ol>
      </div>

      {skills.map((s) => (
        <details key={s.path} className="card">
          <summary>
            <b>{s.frontmatter.name ?? s.folder}</b> <span className="hint">({s.source})</span> <code>{s.path}/SKILL.md</code>
            {s.frontmatter["disable-model-invocation"] === "true" && <span className="tag tag-error">user-only</span>}
          </summary>
          <h4>Level 1 · frontmatter</h4>
          <table className="tools">
            <tbody>
              {Object.entries(s.frontmatter).map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Level 2 · body</h4>
          <pre>{s.body}</pre>
          <h4>Level 3 · other files in the folder</h4>
          {s.files.length ? (
            <ul className="files">
              {s.files.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">none</p>
          )}
        </details>
      ))}

      <p className="hint">
        Every scenario runs with all four skills loaded (<code>settingSources: ["project"]</code> + <code>plugins</code> +{" "}
        <code>skills: "all"</code>). Watch which levels get loaded.
      </p>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button key={s.label} className={s.prompt === invokePrompt ? "active" : ""} onClick={() => setInvokePrompt(s.prompt)} disabled={invoke.run?.running}>
            {s.label}
          </button>
        ))}
      </div>
      <textarea value={invokePrompt} onChange={(e) => setInvokePrompt(e.target.value)} rows={2} disabled={invoke.run?.running} />
      <button onClick={() => invoke.start({ prompt: invokePrompt })} disabled={invoke.run?.running || !invokePrompt.trim()}>
        {invoke.run?.running ? "Running…" : "Run"}
      </button>

      {invoke.run && (
        <>
          <div className="card">
            <b>What got loaded</b>
            <ol className="steps">
              <li>
                <span className="tag">1</span> Listing of every model-visible skill (always, before the prompt)
              </li>
              {disclosureSteps(invokePrompt, invoke.run.messages).map((s, i) => (
                <li key={i}>
                  <span className={`tag ${s.level === "2" || s.level === "3" ? "tag-assistant" : s.level === "user" ? "tag-user" : ""}`}>{s.level}</span> {s.text}
                </li>
              ))}
              {!invoke.run.running && !invoke.run.messages.some((m) => m.type === "assistant" && m.message.content.some((b: any) => b.name === "Skill")) && !invokePrompt.trim().startsWith("/") && (
                <li className="hint">No Skill call: only level 1 was paid for.</li>
              )}
            </ol>
          </div>
          <RunSummary run={invoke.run} />
        </>
      )}

      {/* ------------------------------------------------------------------------------------ */}
      <hr />
      <h3>B · Loading skills into the agent</h3>
      <p className="hint">
        The same prompt, five option sets, in parallel. <b>Discovered</b> = <code>q.supportedCommands()</code> (skills defined by the user,
        project or a plugin). <b>Model sees</b> = what the model itself answers. They are not the same thing.
      </p>
      <textarea value={loadPrompt} onChange={(e) => setLoadPrompt(e.target.value)} rows={2} disabled={loading} />
      <table className="tools">
        <tbody>
          {variants.map((v) => (
            <tr key={v.id}>
              <td>{v.label}</td>
              <td>
                <code>{v.shape}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={runAllLoads} disabled={loading || !loadPrompt.trim()}>
        {loading ? "Running…" : "Run the 5 variants in parallel"}
      </button>

      {Object.keys(loads).length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th>Variant</th>
              <th>
                Discovered <span className="hint">(init.skills)</span>
              </th>
              <th>Model sees</th>
              <th>Prompt tokens</th>
            </tr>
          </thead>
          <tbody>
            {variants
              .filter((v) => loads[v.id])
              .map((v) => {
                const run = loads[v.id]!;
                const init = run.messages.find((m) => m.type === "system" && m.subtype === "init");
                const result = lastResult(run.messages);
                return (
                  <tr key={v.id}>
                    <td>{v.label}</td>
                    <td className="snippet">
                      {run.commands?.map((c) => c.name).join("\n") || (run.commands ? "(none)" : "")}
                      {init && <div className="hint">init.skills: {init.skills.length} in total</div>}
                    </td>
                    <td className="snippet">{run.error ? `⚠ ${run.error}` : finalText(run.messages) || (run.running ? "…" : "")}</td>
                    <td>{promptTokens(result)?.toLocaleString() ?? ""}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}

      {variants
        .filter((v) => loads[v.id])
        .map((v) => (
          <details key={v.id} className="card">
            <summary>
              <b>{v.label}</b>: options sent to query() and raw messages
            </summary>
            <RunSummary run={loads[v.id]!} />
          </details>
        ))}

      {/* ------------------------------------------------------------------------------------ */}
      <hr />
      <h3>C · Advanced loading</h3>

      <div className="card">
        <b>Preload a skill into a subagent</b>: <code>{'agents: { reporter: { skills: ["task-report"], ... } }'}</code>. The main agent has{" "}
        <code>skills: []</code>, so it cannot use the skill itself and has to delegate. The subagent starts with the SKILL.md already in its
        context, so you will see <b>no Skill call</b>, just its Read.
        <textarea value={subPrompt} onChange={(e) => setSubPrompt(e.target.value)} rows={2} disabled={sub.run?.running} />
        <button className="primary" onClick={() => sub.start({ prompt: subPrompt })} disabled={sub.run?.running}>
          {sub.run?.running ? "Running…" : "Run with subagent"}
        </button>
        {sub.run && (
          <ol className="steps">
            {sub.run.messages
              .filter((m) => m.type === "assistant")
              .flatMap((m) => m.message.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ sub: !!m.parent_tool_use_id, b })))
              .map(({ sub: isSub, b }: any, i: number) => (
                <li key={i}>
                  <span className={`tag ${isSub ? "tag-user" : "tag-assistant"}`}>{isSub ? "subagent" : "main"}</span> {b.name}{" "}
                  <code>{b.input.subagent_type ?? b.input.skill ?? b.input.file_path?.split(/[\\/]/).slice(-2).join("/")}</code>
                </li>
              ))}
          </ol>
        )}
      </div>
      {sub.run && <RunSummary run={sub.run} />}

      <div className="card">
        <b>Reload skills in a live session</b>: the server opens a streaming-input session, writes a new{" "}
        <code>atmira-greeting/SKILL.md</code> to disk, and asks for the skill list before and after <code>q.reloadSkills()</code>. The skill
        is deleted again when the run ends.
        <input value={reloadPrompt} onChange={(e) => setReloadPrompt(e.target.value)} disabled={reload.run?.running} />
        <button className="primary" onClick={() => reload.start({ prompt: reloadPrompt })} disabled={reload.run?.running}>
          {reload.run?.running ? "Running…" : "Write skill + reload"}
        </button>
        {reload.run && (
          <ol className="steps">
            {reload.run.controls.map((c, i) => (
              <li key={i}>
                <code>{c.step}</code>
                {c.skills && <div className="snippet">{c.skills.join(", ")}</div>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {reload.run && <RunSummary run={reload.run} />}
    </section>
  );
}

/** The answer, the cost and the raw stream of one run. */
function RunSummary({ run }: { run: Run }) {
  const result = lastResult(run.messages);
  const text = finalText(run.messages);
  return (
    <>
      {run.error && <div className="card warn">⚠ {run.error}</div>}
      {(text || run.running) && <div className="card answer">{text || "…"}</div>}
      {result && (
        <p className="hint">
          {result.subtype} · {result.num_turns} turns · {promptTokens(result).toLocaleString()} prompt tokens · ${result.total_cost_usd.toFixed(4)}
        </p>
      )}
      {run.options && (
        <details className="card">
          <summary>Options sent to query()</summary>
          <pre>{JSON.stringify(run.options, null, 2)}</pre>
        </details>
      )}
      <MessageLog messages={run.messages} />
    </>
  );
}
