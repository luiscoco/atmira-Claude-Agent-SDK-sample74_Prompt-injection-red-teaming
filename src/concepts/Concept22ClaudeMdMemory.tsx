import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

// Must match SWITCHES and SOURCE_SWITCHES in server/concepts/22-claude-md-memory.ts.
const switchInfo: { name: string; label: string; does: string }[] = [
  { name: "noProject", label: 'no "project"', does: "settingSources without project: no CLAUDE.md, no rules" },
  { name: "local", label: '+ "local"', does: "settingSources + local: CLAUDE.local.md" },
  { name: "user", label: '+ "user"', does: "settingSources + user: the fake home's CLAUDE.md" },
  { name: "subdir", label: "cwd: api/", does: "start in a subfolder: parent CLAUDE.md files load too" },
  { name: "exclude", label: "claudeMdExcludes", does: "skip testing.md and api/CLAUDE.md" },
  { name: "preset", label: "claude_code preset", does: "Claude Code's full system prompt (needed for auto memory)" },
  { name: "autoMemory", label: "autoMemoryEnabled", does: "the model may save and read memories (+ Write, Edit)" },
  { name: "agent", label: "subagent", does: "a subagent 'checker' that gets the memory files" },
  { name: "omitClaudeMd", label: "subagent + omitClaudeMd", does: "the same subagent without the memory files" },
];

const ASK = "List every line that starts with 'Marker:' in your instructions or context. Copy each one exactly, one per line, and nothing else.";
const ASK_AGENT = `Use the checker agent in the foreground (not in the background) and wait for it. Pass it this task, word for word: "${ASK}" Then repeat its answer exactly. Do not add anything from your own context.`;

type Form = { prompts: string; switches: string[] };
type MemFile = { file: string; kind: string; loads: string; frontmatter: Record<string, string>; body: string };
type AutoFile = { file: string; frontmatter: Record<string, string>; body: string };
type HookCall = { file: string; memory_type: string; load_reason: string; globs?: string[]; trigger?: string; parent?: string; at: number };
type Snapshot = { when: string; files?: { path: string; type: string; tokens: number }[]; error?: string };

const one = (prompts: string[], switches: string[] = []): Form => ({ prompts: prompts.join("\n"), switches });

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · Session start",
    hint: 'settingSources: ["project"]. At the start Claude Code reads CLAUDE.md, the file it imports with @docs/style.md (load_reason "include"), and the rule without paths:. There is no system prompt option at all: CLAUDE.md does not need the claude_code preset.',
    form: one([ASK]),
  },
  {
    label: "2 · No settings",
    hint: "settingSources: [] (SDK isolation mode). No memory file is read: no hook call, memoryFiles is empty, and the model finds no marker.",
    form: one([ASK], ["noProject"]),
  },
  {
    label: "3 · + local",
    hint: 'Adds "local": CLAUDE.local.md is read too (memory_type "Local"). It is for personal notes you do not commit.',
    form: one([ASK], ["local"]),
  },
  {
    label: "4 · + user",
    hint: 'Adds "user": <CLAUDE_CONFIG_DIR>/CLAUDE.md is read (memory_type "User"). The lab points CLAUDE_CONFIG_DIR at memory-lab/home/, so your real ~/.claude is never used.',
    form: one([ASK], ["user"]),
  },
  {
    label: "5 · Read a file in api/",
    hint: 'Nothing new at the start. When the model reads api/orders.js, two more files load: api/CLAUDE.md ("nested_traversal") and the rule with paths: api/**/*.js ("path_glob_match"). Both show the file that triggered them.',
    form: one(["Read api/orders.js. Then: " + ASK]),
  },
  {
    label: "6 · Read a file in web/",
    hint: "web/app.js matches no rule and web/ has no CLAUDE.md: nothing more loads. Compare with 5.",
    form: one(["Read web/app.js. Then: " + ASK]),
  },
  {
    label: "7 · Start in api/",
    hint: "cwd: memory-project/api. api/CLAUDE.md is now read at the START, and so is the CLAUDE.md of the parent folder. Look at which files are missing compared with 1.",
    form: one([ASK], ["subdir"]),
  },
  {
    label: "8 · claudeMdExcludes",
    hint: 'settings.claudeMdExcludes: ["**/.claude/rules/testing.md", "**/api/CLAUDE.md"]. The rule is gone at the start, and reading api/orders.js loads only the path rule, not api/CLAUDE.md.',
    form: one(["Read api/orders.js. Then: " + ASK], ["exclude"]),
  },
  {
    label: "9 · Does it obey?",
    hint: "No markers asked for: the memory files just change the answer. Expect Orbit, 'Hi Ana,' (local), node:test (rule), single quotes (import) and cents (nested, once api/ is read).",
    form: one(["Read api/orders.js, then write a unit test for createOrder. Mention the product name in a comment."], ["local"]),
  },
  {
    label: "10 · With the preset",
    hint: "The same as 1 with the claude_code preset: the same memory files, but a much bigger system prompt, so it costs several times more.",
    form: one([ASK], ["preset"]),
  },
  {
    label: "11 · Auto memory: save",
    hint: "autoMemoryEnabled with autoMemoryDirectory: memory-lab/auto-memory. The model writes one file per memory and an index, MEMORY.md, with Write (no allowedTools rule needed). Part A shows them after the run. The prompt asks for the index because Haiku sometimes skips it, and only MEMORY.md is loaded next time. Without the preset, the model does not know about auto memory.",
    form: one(["Remember for future sessions: my favourite colour is teal. Save it in your memory and add it to the MEMORY.md index."], ["preset", "autoMemory"]),
  },
  {
    label: "12 · Auto memory: recall",
    hint: 'A NEW session (run 11 first). MEMORY.md is in memoryFiles as type "AutoMem" from the start, but InstructionsLoaded does not fire for it. The index line is often enough to answer Teal; sometimes the model also reads the memory file.',
    form: one(["What is my favourite colour? One word, or UNKNOWN."], ["preset", "autoMemory"]),
  },
  {
    label: "13 · Auto memory off",
    hint: "The same question with autoMemoryEnabled: false (the lab's default). The saved memory is still on disk, but MEMORY.md is not loaded: UNKNOWN.",
    form: one(["What is my favourite colour? One word, or UNKNOWN."], ["preset"]),
  },
  {
    label: "14 · Subagent",
    hint: "A subagent defined with agents: { checker }. It gets the memory files too: its answer (the Agent tool result) lists the markers.",
    form: one([ASK_AGENT], ["agent"]),
  },
  {
    label: "15 · omitClaudeMd",
    hint: "The same subagent with omitClaudeMd: true. It runs without the user, project and local memory files, so it finds no marker. The main agent still has them.",
    form: one([ASK_AGENT], ["omitClaudeMd"]),
  },
  {
    label: "16 · /compact",
    hint: 'Two prompts in one session. After /compact the memory files are read again, with load_reason "compact", because the summary replaced the conversation they were part of.',
    form: one(["Say OK.", "/compact"]),
  },
];

/** The marker emoji of a file (its "Marker:" line), so the table matches the model's answer. */
const markerOf = (body: string) => body.match(/Marker:\s*(\S+\s+[A-Z-]+)/)?.[1] ?? "";

/** Text of the main agent's answers. */
const answerOf = (messages: any[]) =>
  messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n");

/**
 * A foreground subagent's own messages are not streamed: its answer is the result of the Agent tool call. The CLI
 * wraps it in a "[Subagent hand-back] … The report follows:" preamble and an "agentId: … <usage>" footer.
 */
function subagentAnswer(messages: any[]) {
  const blocks = messages.flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []));
  const ids = blocks.filter((b: any) => b.type === "tool_use" && b.name === "Agent").map((b: any) => b.id);
  return blocks
    .filter((b: any) => b.type === "tool_result" && ids.includes(b.tool_use_id))
    .map((b: any) => (typeof b.content === "string" ? b.content : b.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")))
    .map((t: string) => t.replace(/^[\s\S]*?The report follows:\s*/, "").replace(/\n+agentId:[\s\S]*$/, "").trim())
    .join("\n\n");
}

/** memory-project/ paths as the server returns them in /files. */
const toProject = (p: string) => p.replace(/^memory-project\//, "");

export function Concept22ClaudeMdMemory() {
  const [files, setFiles] = useState<MemFile[]>([]);
  const [auto, setAuto] = useState<AutoFile[]>([]);
  const [openBody, setOpenBody] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<HookCall[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [controller, setController] = useState<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const loadFiles = () =>
    fetch("/api/c22/files")
      .then((r) => r.json())
      .then((d) => {
        setFiles(d.files);
        setAuto(d.auto);
      })
      .catch(() => setError("Could not list the memory files — is this sample's server running on port 3001?"));

  useEffect(() => {
    loadFiles();
  }, []);

  // A live counter, so a slow run is visibly different from a stuck one.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);

  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const prompts = form.prompts.split("\n").filter((l) => l.trim());

  async function run() {
    setMessages([]);
    setCalls([]);
    setSnapshots([]);
    setSentOptions(null);
    setError(null);
    setElapsed(0);
    setRunning(true);
    const ctrl = new AbortController();
    setController(ctrl);
    try {
      await streamPost(
        "/api/c22/run",
        { prompts, switches: form.switches },
        (event, data) => {
          if (event === "options") setSentOptions(data);
          if (event === "hook") setCalls((prev) => [...prev, data]);
          if (event === "memory") setSnapshots((prev) => [...prev, data]);
          if (event === "message") setMessages((prev) => [...prev, data]);
          if (event === "error") setError(data.message);
        },
        ctrl.signal,
      );
    } catch (err) {
      setError(ctrl.signal.aborted ? "Stopped from the browser." : `${String(err)} — is this sample's server running on port 3001?`);
    } finally {
      setRunning(false);
      setController(null);
      loadFiles(); // auto memory may have written files
    }
  }

  async function reset() {
    await fetch("/api/c22/reset", { method: "POST" });
    loadFiles();
  }

  const results = messages.filter((m) => m.type === "result");
  const text = answerOf(messages);
  const subText = subagentAnswer(messages);
  const first = snapshots[0];
  const last = snapshots.length > 1 ? snapshots[snapshots.length - 1] : undefined;
  const tokensIn = (s: Snapshot | undefined, file: string) => s?.files?.find((f) => toProject(f.path) === file || f.path === file)?.tokens;
  // memoryFiles entries that are not one of the files in Part A (auto memory's MEMORY.md).
  const extra = [...new Map([...(first?.files ?? []), ...(last?.files ?? [])].filter((f) => !files.some((x) => x.file === toProject(f.path) || x.file === f.path)).map((f) => [f.path, f])).values()];
  const ran = results.length > 0;
  // The hook can miss session-start files (see Tab22). memoryFiles is the check. AutoMem never has a hook call.
  const unreported = ran
    ? (first?.files ?? []).filter((f) => f.type !== "AutoMem" && !calls.some((c) => c.file === f.path)).map((f) => f.path)
    : [];

  return (
    <section>
      <h2>22 · CLAUDE.md &amp; memory</h2>
      <p className="lead">
        Memory files are markdown that Claude Code adds to the context: <code>CLAUDE.md</code>, <code>CLAUDE.local.md</code>, the
        user's <code>~/.claude/CLAUDE.md</code>, <code>.claude/rules/*.md</code>, nested <code>CLAUDE.md</code> files and their{" "}
        <code>@imports</code>. <code>settingSources</code> decides which are read, and some load only when Claude reads a matching
        file. Each file has a <b>Marker</b> line, so you can see what reached the model. Haiku, no thinking,{" "}
        <code>cwd: memory-project/</code>.
      </p>

      <h3>A · The memory files</h3>
      <table className="tools">
        <thead>
          <tr>
            <th>file</th>
            <th>kind</th>
            <th>marker</th>
            <th>loaded</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.file}>
              <td>
                <button className="link" onClick={() => setOpenBody(openBody === f.file ? null : f.file)}>
                  {f.file}
                </button>
              </td>
              <td>{f.kind}</td>
              <td>{markerOf(f.body)}</td>
              <td>{f.loads}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {openBody && (
        <div className="card">
          <b>{openBody}</b>
          {Object.entries(files.find((f) => f.file === openBody)?.frontmatter ?? {}).map(([k, v]) => (
            <div key={k} className="snippet">
              {k}: {v}
            </div>
          ))}
          <pre>{files.find((f) => f.file === openBody)?.body}</pre>
        </div>
      )}
      <div className="card">
        <b>memory-lab/auto-memory/</b> <span className="subtype">what auto memory has written ({auto.length} file(s))</span>{" "}
        <button className="link" onClick={reset} disabled={running}>
          reset
        </button>
        {auto.length === 0 && <div className="snippet">(empty: run scenario 11)</div>}
        {auto.map((a) => (
          <details key={a.file}>
            <summary>
              <code>{a.file}</code> {a.frontmatter.description && <span className="subtype">{a.frontmatter.description}</span>}
            </summary>
            <pre>{Object.keys(a.frontmatter).length ? Object.entries(a.frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\n" : ""}{a.body}</pre>
          </details>
        ))}
      </div>

      <h3>B · A run</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
            disabled={running}
          >
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <textarea value={form.prompts} onChange={(e) => setForm({ ...form, prompts: e.target.value })} rows={3} />
      <p className="hint">One prompt per line (up to 4), sent one after the other in one session.</p>
      <div className="row">
        {switchInfo.map((s) => (
          <label key={s.name} className="check" title={s.does}>
            <input type="checkbox" checked={form.switches.includes(s.name)} onChange={() => setForm({ ...form, switches: toggle(form.switches, s.name) })} />{" "}
            <code>{s.label}</code>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={run} disabled={running || !prompts.length}>
          {running ? `Running… ${elapsed} s` : "Run query()"}
        </button>
        {running && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      {(calls.length > 0 || snapshots.length > 0) && (
        <div className="card">
          <b>What was loaded</b> <span className="subtype">InstructionsLoaded hook · getContextUsage().memoryFiles tokens</span>
          <table className="tools">
            <thead>
              <tr>
                <th>file</th>
                <th>marker</th>
                <th>InstructionsLoaded</th>
                <th>{first?.when ?? "memoryFiles"}</th>
                {last && <th>{last.when}</th>}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const hits = calls.filter((c) => toProject(c.file) === f.file || c.file === f.file);
                const start = tokensIn(first, f.file);
                const end = tokensIn(last, f.file);
                return (
                  <tr key={f.file} style={{ opacity: hits.length || start || end ? 1 : 0.45 }}>
                    <td>
                      <code>{f.file}</code>
                    </td>
                    <td>{markerOf(f.body)}</td>
                    <td>
                      {hits.length === 0 && (ran ? "—" : "…")}
                      {hits.map((h, i) => (
                        <div key={i}>
                          <span className="tag tag-pre">{h.load_reason}</span> <span className="subtype">{h.memory_type} · {h.at} ms</span>
                          {h.trigger && <div className="subtype">trigger: {h.trigger}</div>}
                          {h.parent && <div className="subtype">parent: {h.parent}</div>}
                          {h.globs && <div className="subtype">globs: {h.globs.join(", ")}</div>}
                        </div>
                      ))}
                    </td>
                    <td>{start ? `${start} tokens` : "—"}</td>
                    {last && <td>{end ? `${end} tokens` : "—"}</td>}
                  </tr>
                );
              })}
              {extra.map((f) => (
                <tr key={f.path}>
                  <td>
                    <code>{f.path}</code>
                  </td>
                  <td>{f.type}</td>
                  <td>{ran ? "— (no hook call)" : "…"}</td>
                  <td>{tokensIn(first, f.path) ? `${tokensIn(first, f.path)} tokens` : "—"}</td>
                  {last && <td>{tokensIn(last, f.path) ? `${tokensIn(last, f.path)} tokens` : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {unreported.length > 0 && (
            <div className="snippet">
              ⚠ memoryFiles lists {unreported.length} file(s) that InstructionsLoaded never reported: {unreported.join(", ")}. The hook can miss the
              session-start calls; memoryFiles is what actually reached the context.
            </div>
          )}
          {snapshots
            .filter((s) => s.error)
            .map((s, i) => (
              <div key={i} className="snippet">
                getContextUsage() {s.when}: {s.error}
              </div>
            ))}
        </div>
      )}

      {subText && (
        <div className="card">
          <b>subagent's answer</b> <span className="subtype">the Agent tool result</span>
          <div className="answer thin">{subText}</div>
        </div>
      )}
      {text && <div className="card answer">{text}</div>}
      {results.map((r, i) => (
        <div key={i} className="card">
          <b>result/{r.subtype}</b> {results.length > 1 && <span className="subtype">prompt #{i + 1}</span>} — {r.duration_ms} ms · {r.num_turns} turn(s) · total $
          {r.total_cost_usd.toFixed(4)}
        </div>
      ))}

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}

      {sentOptions && (
        <details className="card">
          <summary>
            <b>options sent to query()</b>
          </summary>
          <pre>{JSON.stringify(sentOptions, null, 2)}</pre>
        </details>
      )}
      <MessageLog messages={messages} />
    </section>
  );
}
