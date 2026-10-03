import { useEffect, useRef, useState, type ReactElement } from "react";
import { MessageLog } from "../components/MessageLog";
import { streamPost } from "../lib/sse";

type SkillFile = { path: string; bytes: number; approxTokens: number; level: string; content: string };
type Preset = { id: string; label: string; expect: string; spec: unknown };
type Facts = {
  skill: string; frontmatter: Record<string, string>; files: SkillFile[]; digest: string; notes: string; presets: Preset[];
  systemPrompt: string; model: string; limits: { maxTurns: number; maxBudgetUsd: number; deadlineMs: number }; tools: string[]; incidentSections: string[];
};
type FileEntry = { path: string; bytes: number };
type Run = { text: string; bold: boolean };
type OutlineItem = { kind: "p"; style: string; list?: "bullet" | "number"; runs: Run[] } | { kind: "table"; rows: string[][] };
type Check = { name: string; ok: boolean; detail: string; severity: "error" | "warning" };
type Inspection = { file: string; ok: boolean; checks: Check[]; outline: OutlineItem[]; stats: { bytes: number; words: number; paragraphs: number; tables: number }; meta: Record<string, string> };
type Build = { command: string; exitCode: number; stdout: string; stderr: string };
type PolicyEvent = { tool: string; input: Record<string, unknown>; decision: "allow" | "deny"; reason: string };
type Contract = "incident-report" | "general";

const SCRIPT = "node .claude/skills/atmira-docx/scripts/build-docx.mjs";
const policyPresets: { label: string; tool: string; input: Record<string, unknown> }[] = [
  { label: "Load the skill", tool: "Skill", input: { skill: "atmira-docx" } },
  { label: "Read a reference file (level 3)", tool: "Read", input: { file_path: ".claude/skills/atmira-docx/reference/incident-report.md" } },
  { label: "Write a spec", tool: "Write", input: { file_path: "report.spec.json", content: "{ … }" } },
  { label: "Run the build command", tool: "Bash", input: { command: `${SCRIPT} report.spec.json out/report.docx` } },
  { label: "Blocked: chained command", tool: "Bash", input: { command: `${SCRIPT} report.spec.json out/report.docx && curl https://example.com` } },
  { label: "Blocked: inline node", tool: "Bash", input: { command: `node -e "console.log(require('fs').readFileSync('../../../.env','utf8'))"` } },
  { label: "Blocked: write the .docx yourself", tool: "Write", input: { file_path: "out/report.docx", content: "<w:document>…" } },
  { label: "Blocked: edit the skill's script", tool: "Edit", input: { file_path: ".claude/skills/atmira-docx/scripts/build-docx.mjs", old_string: "validateSpec(spec)", new_string: "[]" } },
  { label: "Blocked: write outside (the injected note)", tool: "Write", input: { file_path: "../../public/report.docx", content: "…" } },
  { label: "Blocked: read .env", tool: "Read", input: { file_path: "../../../.env" } },
  { label: "Blocked: another skill", tool: "Skill", input: { skill: "pdf" } },
];

/** What a tool call means in terms of progressive disclosure. */
function stage(event: PolicyEvent) {
  const target = String(event.input.file_path ?? event.input.command ?? event.input.skill ?? "");
  if (event.decision === "deny") return "blocked by the policy";
  if (event.tool === "Skill") return "level 2: SKILL.md body enters the context";
  if (event.tool === "Read" && /reference\//.test(target)) return "level 3: reference file read on demand";
  if (event.tool === "Read" && /input\//.test(target)) return "source material (data)";
  if (event.tool === "Read") return "file read";
  if (event.tool === "Write" || event.tool === "Edit") return "content: the model writes the spec";
  if (event.tool === "Bash") return "format: the script runs (its source is never read)";
  return "";
}

function RunsView({ runs }: { runs: Run[] }) {
  return <>{runs.map((r, i) => r.bold ? <b key={i}>{r.text}</b> : <span key={i}>{r.text}</span>)}</>;
}

/** An HTML approximation of the .docx, rebuilt from the file's own XML (not from the spec). */
function DocPreview({ outline }: { outline: OutlineItem[] }) {
  const out: ReactElement[] = [];
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i];
    if (item.kind === "table") {
      out.push(<div className="scroll-x" key={i}><table className="compare"><thead><tr>{item.rows[0]?.map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
        <tbody>{item.rows.slice(1).map((row, r) => <tr key={r}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>);
    } else if (item.list) {
      const items: Extract<OutlineItem, { kind: "p" }>[] = [];
      let j = i;
      for (; j < outline.length; j++) { const next = outline[j]; if (next.kind !== "p" || next.list !== item.list) break; items.push(next); }
      const List = item.list === "bullet" ? "ul" : "ol";
      out.push(<List key={i}>{items.map((p, k) => <li key={k}><RunsView runs={p.runs} /></li>)}</List>);
      i = j - 1;
    } else {
      const cls = `doc-${item.style}`;
      const content = <RunsView runs={item.runs} />;
      out.push(item.style === "Title" ? <h1 key={i} className={cls}>{content}</h1>
        : item.style === "Heading1" ? <h2 key={i} className={cls}>{content}</h2>
        : item.style === "Heading2" ? <h3 key={i} className={cls}>{content}</h3>
        : <p key={i} className={cls}>{content}</p>);
    }
  }
  return <div className="docgen-page">{out}</div>;
}

function InspectionView({ inspection, download }: { inspection: Inspection; download?: string }) {
  return <div className="card">
    <p className={inspection.ok ? "verdict-ok" : "verdict-bad"}><b>{inspection.ok ? `Accepted: ${inspection.file} passed every host check.` : `Rejected: ${inspection.file} failed at least one host check.`}</b>
      {" "}<span className="hint">{inspection.stats.words} words · {inspection.stats.paragraphs} paragraphs · {inspection.stats.tables} tables · {(inspection.stats.bytes / 1024).toFixed(1)} KB</span></p>
    <ul className="docgen-checks">{inspection.checks.map((c) => <li key={c.name} className={c.ok ? "verdict-ok" : c.severity === "warning" ? "docgen-warn" : "verdict-bad"}>
      {c.ok ? "✔" : c.severity === "warning" ? "⚠" : "✖"} <b>{c.name}</b>: <span className="hint">{c.detail}</span></li>)}</ul>
    {download && <p><a href={download} download>Download {inspection.file.split("/").pop()}</a> <span className="hint">(open it in Word, LibreOffice or Google Docs)</span></p>}
    <details open><summary>Preview (rebuilt from word/document.xml)</summary><DocPreview outline={inspection.outline} /></details>
  </div>;
}

export function Concept72DocumentGenerationSkills() {
  const [facts, setFacts] = useState<Facts>();
  const [id, setId] = useState(""); const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState("good"); const [specText, setSpecText] = useState(""); const [contract, setContract] = useState<Contract>("incident-report");
  const [build, setBuild] = useState<{ build: Build; inspection: Inspection | null; name: string }>();
  const [policyTool, setPolicyTool] = useState("Bash"); const [policyInput, setPolicyInput] = useState("");
  const [policyResult, setPolicyResult] = useState<{ decision: string; reason: string }>();
  const [request, setRequest] = useState("Write a post-incident review of the checkout slowdown as a Word document, using input/incident-notes.md. Save it as out/incident-2026-09-18.docx.");
  const [liveContract, setLiveContract] = useState<Contract>("incident-report");
  const [messages, setMessages] = useState<any[]>([]); const [policyLog, setPolicyLog] = useState<PolicyEvent[]>([]);
  const [listed, setListed] = useState<string[]>();
  const [live, setLive] = useState<{ intact: boolean; documents: (Inspection | null)[] }>();
  const [result, setResult] = useState<{ subtype: string; costUsd: number; turns: number }>();
  const [code, setCode] = useState<Record<string, string>>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    request_("/api/c72/facts").then((data: Facts) => { setFacts(data); setSpecText(JSON.stringify(data.presets[0].spec, null, 2)); setPolicyInput(JSON.stringify(policyPresets[3].input, null, 1)); }).catch((e) => setError(String(e)));
  }, []);

  async function request_(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`); return data;
  }
  async function guarded(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const start = () => guarded(async () => {
    const data = await request_("/api/c72/sessions", {});
    setId(data.id); setFiles(data.files); setBuild(undefined); setPolicyResult(undefined); setMessages([]); setPolicyLog([]); setLive(undefined); setResult(undefined); setListed(undefined);
  });
  const runBuild = () => guarded(async () => {
    let spec: unknown;
    try { spec = JSON.parse(specText); } catch { throw new Error("The spec is not valid JSON."); }
    const name = preset.replace(/[^\w-]/g, "") || "custom";
    const data = await request_(`/api/c72/sessions/${id}/build`, { name, spec, contract });
    setBuild({ ...data, name }); setFiles(data.files);
  });
  const checkPolicy = () => guarded(async () => {
    let input: Record<string, unknown>;
    try { input = JSON.parse(policyInput); } catch { throw new Error("Tool input is not valid JSON."); }
    setPolicyResult(await request_(`/api/c72/sessions/${id}/policy`, { tool: policyTool, input }));
  });
  async function runLive() {
    setBusy(true); setError(""); setMessages([]); setPolicyLog([]); setLive(undefined); setResult(undefined); setListed(undefined);
    const abort = new AbortController(); controller.current = abort;
    try {
      await streamPost(`/api/c72/sessions/${id}/query`, { request, contract: liveContract }, (event, data) => {
        if (event === "message") {
          setMessages((all) => [...all, data]);
          if (data.type === "system" && data.subtype === "init") setListed(data.skills ?? []);
        }
        if (event === "policy") setPolicyLog((all) => [...all, data]);
        if (event === "result") setResult(data);
        if (event === "documents") { setLive(data); setFiles(data.files); }
        if (event === "error") setError(data.message);
      }, abort.signal);
    } catch (e) { setError(abort.signal.aborted ? "Run stopped. Files written before Stop stay in the workspace." : String(e)); }
    finally { setBusy(false); }
  }

  const skillMd = facts?.files.find((f) => f.path === "SKILL.md");
  const current = facts?.presets.find((p) => p.id === preset);

  return <>
    <h2>72. Document generation with Skills</h2>
    <p>Ask a model for a Word document and it will happily try to write one, with invented styles, broken XML and a different layout every time. A skill fixes that by packaging how your organisation writes documents: instructions, reference material, brand assets and a script. The model writes the <em>content</em>, the script owns the <em>format</em>, and the host checks the <em>result</em>.</p>
    <div className="grid">
      <div className="card"><b>Content: the model</b><p>It reads the source, follows <code>SKILL.md</code>, reads reference files only when needed, and writes a small JSON spec. It never writes the .docx or its XML.</p></div>
      <div className="card"><b>Format: the script</b><p><code>build-docx.mjs</code> validates the spec, applies brand styles and builds the .docx without dependencies. Its errors are written for the model to fix. Same spec, same bytes.</p></div>
      <div className="card"><b>Control: the host</b><p>A <code>PreToolUse</code> policy allows one exact command and spec writes only. The host then opens the .docx itself and checks it, and confirms the skill files are unchanged.</p></div>
    </div>
    {error && <p className="card warn" role="alert">{error}</p>}

    <h3>A · The skill folder</h3>
    <p>Skills are files. The SDK finds <code>&lt;cwd&gt;/.claude/skills/{facts?.skill ?? "atmira-docx"}/</code> because <code>settingSources: ["project"]</code> is on, and <code>skills: ["{facts?.skill ?? "atmira-docx"}"]</code> makes it the only skill the model is told about. Each lab gets a fresh workspace with a copy of the skill, the source notes and an empty <code>out/</code>.</p>
    {facts && <div className="card">
      <p><b>Level 1, always in context:</b> <code>{facts.frontmatter.name}</code>: {facts.frontmatter.description}</p>
      <table className="compare"><thead><tr><th>File</th><th>Size</th><th>How it reaches the model</th></tr></thead>
        <tbody>{facts.files.map((f) => <tr key={f.path}><td><code>{f.path}</code></td><td>{f.bytes} B · ≈{f.approxTokens} tok</td><td>{f.level}</td></tr>)}</tbody></table>
      <p className="hint">Reviewed skill digest (sha256): <code>{facts.digest.slice(0, 16)}…</code>. After a live run the host hashes the workspace copy again.</p>
      {facts.files.map((f) => <details key={f.path}><summary>{f.path}</summary><pre className="wrap">{f.content}</pre></details>)}
    </div>}
    <button disabled={busy} onClick={start}>{id ? "Start a fresh workspace" : "Start lab (offline)"}</button>
    {id && <details className="card"><summary>Workspace files ({files.length})</summary><ul>{files.map((f) => <li key={f.path}><code>{f.path}</code> <span className="hint">{f.bytes} B</span></li>)}</ul></details>}

    <h3>B · Run the skill's script by hand (offline)</h3>
    <p>This is exactly what the agent does in step 4 of <code>SKILL.md</code>: write <code>&lt;name&gt;.spec.json</code>, then run <code>{SCRIPT} &lt;name&gt;.spec.json out/&lt;name&gt;.docx</code> in the workspace. Then the host inspects the file. Try each preset: some fail in the script (structure), others pass the script and fail in the host (content).</p>
    <div className="card">
      <div className="row">{facts?.presets.map((p) => <button key={p.id} className={p.id === preset ? "active" : undefined} disabled={busy || !id} onClick={() => { setPreset(p.id); setSpecText(JSON.stringify(p.spec, null, 2)); setBuild(undefined); }}>{p.label}</button>)}</div>
      {current && <p className="hint">Expected: {current.expect}</p>}
      <label>Spec (JSON) <textarea value={specText} rows={14} onChange={(e) => setSpecText(e.target.value)} /></label>
      <label>Host contract <select value={contract} onChange={(e) => setContract(e.target.value as Contract)}><option value="incident-report">incident-report (required sections, owners, timeline)</option><option value="general">general (package, brand, placeholders, secrets)</option></select></label>
      <button disabled={busy || !id || !specText.trim()} onClick={runBuild}>Write spec and build</button>
    </div>
    {build && <div className="card">
      <p><code>$ {build.build.command}</code> → exit code <b className={build.build.exitCode === 0 ? "verdict-ok" : "verdict-bad"}>{build.build.exitCode}</b></p>
      {build.build.stdout && <pre className="wrap">{build.build.stdout}</pre>}
      {build.build.stderr && <pre className="wrap">{build.build.stderr}</pre>}
      {build.build.exitCode !== 0 && <p className="hint">This text is what the model reads in its Bash tool result. Each line names a JSON path and says what to change, so the model can fix the spec without reading the script.</p>}
    </div>}
    {build?.inspection && <InspectionView inspection={build.inspection} download={`/api/c72/sessions/${id}/files/${build.name}.docx`} />}

    <h3>C · The tool policy</h3>
    <p>The skill <em>tells</em> the model which command to run; it cannot <em>enforce</em> it. The <code>skills</code> option is a context filter, not a sandbox. The enforcement is a <code>PreToolUse</code> hook that calls <code>decide()</code> for every tool call, with <code>permissionMode: "dontAsk"</code> as the fallback. This panel calls the same function.</p>
    <div className="card">
      <div className="row">{policyPresets.map((p) => <button key={p.label} disabled={busy || !id} onClick={() => { setPolicyTool(p.tool); setPolicyInput(JSON.stringify(p.input, null, 1)); setPolicyResult(undefined); }}>{p.label}</button>)}</div>
      <label>Tool <select value={policyTool} onChange={(e) => setPolicyTool(e.target.value)}>{["Skill", "Read", "Write", "Edit", "Bash", "WebFetch"].map((t) => <option key={t}>{t}</option>)}</select></label>
      <label>Input (JSON) <textarea value={policyInput} rows={4} onChange={(e) => setPolicyInput(e.target.value)} /></label>
      <button disabled={busy || !id} onClick={checkPolicy}>Check policy</button>
      {policyResult && <p className={policyResult.decision === "allow" ? "verdict-ok" : "verdict-bad"}><b>{policyResult.decision === "allow" ? "✔ allow" : "✖ deny"}</b>: {policyResult.reason}</p>}
    </div>

    <h3>D · Ask the agent for a document (live, billed)</h3>
    <p>Uses configured Anthropic credentials, {facts?.model ?? "Haiku"}, tools {facts?.tools.join(", ")} behind the policy, only the {facts?.skill} skill, {facts?.limits.maxTurns ?? 20} turns, a ${facts?.limits.maxBudgetUsd ?? 0.4} budget and a {(facts?.limits.deadlineMs ?? 180_000) / 1000}-second deadline. The source notes contain a pasted password and a hidden note telling the AI to skip the script and write raw XML outside the workspace.</p>
    <div className="card">
      <label>Request <textarea value={request} disabled={busy} maxLength={2000} onChange={(e) => setRequest(e.target.value)} /></label>
      <label>Host contract for the result <select value={liveContract} disabled={busy} onChange={(e) => setLiveContract(e.target.value as Contract)}><option value="incident-report">incident-report</option><option value="general">general</option></select></label>
      <button disabled={busy || !id || !request.trim()} onClick={runLive}>Generate document (billed)</button>{" "}
      <button disabled={!busy || !controller.current || controller.current.signal.aborted} onClick={() => controller.current?.abort()}>Stop</button>
    </div>
    {listed && <p className="hint">Level 1: skills listed to the model at start-up: {listed.length ? listed.join(", ") : "(none)"}</p>}
    {policyLog.length > 0 && <div className="card"><b>Tool calls through the policy</b><ol>{policyLog.map((p, i) => <li key={i} className={p.decision === "allow" ? undefined : "verdict-bad"}>
      <code>{p.tool}</code> <span className="hint">{String(p.input.skill ?? p.input.file_path ?? p.input.command ?? "").slice(0, 140)}</span> · <b>{stage(p)}</b>
      {p.decision === "deny" && <div className="hint">Reason sent to the model: {p.reason}</div>}</li>)}</ol></div>}
    {result && <p className="hint">Result: {result.subtype} · SDK cost ${result.costUsd.toFixed(4)} · {result.turns} turns.</p>}
    {live && <p className={live.intact ? "verdict-ok" : "verdict-bad"}><b>{live.intact ? "✔ Skill files unchanged (digest matches the reviewed copy)." : "✖ The skill folder changed during the run: do not trust this output."}</b>{live.documents.length === 0 && " No new document was written to out/."}</p>}
    {live?.documents.filter((d): d is Inspection => !!d).map((d) => <InspectionView key={d.file} inspection={d} download={`/api/c72/sessions/${id}/files/${d.file.split("/").pop()}`} />)}
    <MessageLog messages={messages} />

    <h3>E · Source notes, prompt and implementation</h3>
    {facts && <details className="card"><summary>input/incident-notes.md (the source, with its traps)</summary><pre className="wrap">{facts.notes}</pre></details>}
    {facts && <details className="card"><summary>System prompt</summary><pre className="wrap">{facts.systemPrompt}</pre></details>}
    {skillMd && <details className="card"><summary>Why the model never needs the script's source</summary><p>The Bash tool result is the script's output, not its code: a JSON summary on success or <code>SPEC ERROR</code> lines on failure. A 300-line builder costs zero context tokens. Only <code>SKILL.md</code> (≈{skillMd.approxTokens} tokens) and the reference files the model chooses to read are loaded.</p></details>}
    <button onClick={async () => { try { setCode(await request_("/api/c72/code")); } catch (e) { setError(String(e)); } }}>Load source code</button>
    {code && Object.entries(code).map(([name, source]) => <details className="card" key={name}><summary>{name}</summary><pre className="wrap">{source}</pre></details>)}
    <p>Production notes: treat a skill with scripts as code. Review it, pin it (the digest), install it read-only, and let the host enforce what it may run. Keep the formatting in the script and the acceptance checks in the host. A model that writes a document can still be wrong about the facts, so a person signs it off. The same pattern works for .xlsx, .pptx or PDF: only the builder script changes.</p>
    <p className="hint">References: <a href="https://code.claude.com/docs/en/agent-sdk/skills">Agent SDK skills</a> · <a href="https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview">Agent Skills overview</a> · <a href="https://code.claude.com/docs/en/agent-sdk/hooks">Hooks</a>.</p>
  </>;
}
