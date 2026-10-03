import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

export function Concept18Sandbox() {
  const [platform, setPlatform] = useState<{ platform: string; release: string; arch: string }>();
  useEffect(() => {
    fetch("/api/c18/platform").then((r) => r.json()).then(setPlatform);
  }, []);

  return (
    <section>
      <h2>18 · Sandbox</h2>
      <p className="lead">
        Permissions (Concept 4) decide <b>whether</b> a Bash command may run. The <code>sandbox</code> option decides{" "}
        <b>what it can touch</b> once it runs: the OS confines the process to writing inside <code>cwd</code>, reading
        everything except <code>filesystem.denyRead</code>, and reaching only <code>network.allowedDomains</code>. Every
        run here uses Haiku with only the <code>Bash</code> tool, in <code>sandbox-lab/</code>.
      </p>
      {platform && (
        <div className="card warn">
          Server platform: <b>{platform.platform}</b> {platform.release} ({platform.arch}). The sandbox needs Seatbelt
          (macOS), bubblewrap (Linux/WSL) or the Windows sandbox, which is not turned on for every account. Part A tells
          you whether it starts on this machine; if it does not, every column of Part B runs <b>unsandboxed</b>, and the
          disk shows it.
        </div>
      )}
      <AvailabilityPart />
      <hr />
      <CommandsPart />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared: one streamed run and the pieces of it the cards show
// ---------------------------------------------------------------------------------------------

type Ask = { toolName: string; input: any; decisionReason?: string; blockedPath?: string; allowed: boolean };
type Run = { options?: any; messages: any[]; stderr: string[]; asks: Ask[]; disk?: any; error?: string; running: boolean };
const EMPTY: Run = { messages: [], stderr: [], asks: [], running: false };

async function startRun(url: string, body: object, update: (fn: (r: Run) => Run) => void) {
  update(() => ({ ...EMPTY, running: true }));
  try {
    await streamPost(url, body, (event, data) => {
      if (event === "options") update((r) => ({ ...r, options: data }));
      if (event === "message") update((r) => ({ ...r, messages: [...r.messages, data] }));
      if (event === "stderr") update((r) => ({ ...r, stderr: [...r.stderr, data] }));
      if (event === "ask") update((r) => ({ ...r, asks: [...r.asks, data] }));
      if (event === "disk") update((r) => ({ ...r, disk: data }));
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

/** The tool calls with their results, the init message and the result. */
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
    .map((b: any) => ({ id: b.id, input: b.input, result: results.get(b.id) }));
  return { init, result, calls };
}

/**
 * "disabled" when the CLI printed its warning, "no warning seen" otherwise: stderr is the only place the status appears.
 * No warning is not proof that the sandbox is active; it was never seen active on the machine this lab was built on.
 */
function sandboxStatus(run: Run) {
  const asked = run.options?.sandbox?.enabled || run.options?.settings?.sandbox?.enabled;
  if (!asked) return { label: "not requested", cls: "" };
  if (run.stderr.some((l) => /Sandbox disabled/i.test(l))) return { label: "DISABLED (stderr warning): commands run unsandboxed", cls: "bad" };
  if (run.stderr.some((l) => /required but unavailable/i.test(l))) return { label: "unavailable: refused to start", cls: "bad" };
  if (run.running) return { label: "…", cls: "" };
  return { label: "no warning seen on stderr (not proof that it is active)", cls: "" };
}

function Details({ run }: { run: Run }) {
  if (!run.options && run.messages.length === 0) return null;
  return (
    <details>
      <summary className="hint">options sent to query() and raw messages</summary>
      {run.options && <pre>{JSON.stringify(run.options, null, 2)}</pre>}
      <MessageLog messages={run.messages} />
    </details>
  );
}

// ---------------------------------------------------------------------------------------------
// Part A: availability
// ---------------------------------------------------------------------------------------------

const variants = [
  { id: "option", label: "Options.sandbox", shape: "sandbox: { enabled: true }" },
  { id: "optionOpen", label: "…with failIfUnavailable: false", shape: "sandbox: { enabled: true, failIfUnavailable: false }" },
  { id: "settings", label: "settings.sandbox", shape: "settings: { sandbox: { enabled: true } }" },
] as const;
type VariantId = (typeof variants)[number]["id"];

function AvailabilityPart() {
  const [runs, setRuns] = useState<Partial<Record<VariantId, Run>>>({});
  const running = Object.values(runs).some((r) => r?.running);

  function runAll() {
    setRuns({});
    for (const v of variants) startRun("/api/c18/availability", { variant: v.id }, (fn) => setRuns((prev) => ({ ...prev, [v.id]: fn(prev[v.id] ?? EMPTY) })));
  }

  return (
    <>
      <h3>A · Does the sandbox start, and what if it does not?</h3>
      <p className="hint">
        The same <code>{"{ enabled: true }"}</code> three ways. The prompt is "Reply with the single word: ok": the
        sandbox is set up when the process starts, before any tool runs. Compare whether an <code>init</code> message
        arrives, the result, and what <code>for await</code> does at the end.
      </p>
      <button className="primary" onClick={runAll} disabled={running}>
        {running ? "Running…" : "Run the 3 variants in parallel"}
      </button>
      <div className="compare-grid">
        {variants
          .filter((v) => runs[v.id])
          .map((v) => (
            <AvailabilityCard key={v.id} id={v.id} title={v.label} shape={v.shape} run={runs[v.id]!} />
          ))}
      </div>
    </>
  );
}

/** What each outcome means, so an error card does not look like a broken lab. */
function verdict(id: VariantId, run: Run, failed: boolean) {
  const unavailable = run.stderr.some((l) => /Sandbox disabled|required but unavailable/i.test(l));
  if (!unavailable) return failed ? undefined : "Expected where the sandbox works: Bash commands run sandboxed.";
  if (id === "option" && failed)
    return "Expected, and the safe outcome: the sandbox cannot start on this machine, and Options.sandbox defaults to failIfUnavailable: true, so Claude Code refuses to run instead of running unprotected.";
  if (!failed)
    return `"success", but the risky outcome: the sandbox did not start and ${id === "settings" ? "settings.sandbox defaults to failIfUnavailable: false" : "failIfUnavailable: false"}, so commands run WITHOUT a sandbox. Only the stderr warning tells you.`;
  return undefined;
}

function AvailabilityCard({ id, title, shape, run }: { id: VariantId; title: string; shape: string; run: Run }) {
  const { init, result } = readRun(run);
  const status = sandboxStatus(run);
  const explanation = result && !run.running ? verdict(id, run, result.subtype !== "success" || Boolean(run.error)) : undefined;
  return (
    <div className="card config">
      <b>{title}</b>
      <div>
        <code>{shape}</code>
      </div>
      <div className="hint">
        sandbox: <span className={`subtype ${status.cls}`}>{status.label}</span>
      </div>
      <div className="hint">
        init message: <b>{init ? "yes" : run.running ? "…" : "no"}</b>
      </div>
      {run.stderr.map((l, i) => (
        <div key={i} className="snippet">
          stderr: {l}
        </div>
      ))}
      {result && (
        <div className="hint">
          <span className={`subtype ${result.subtype === "success" ? "" : "bad"}`}>{result.subtype}</span> · $
          {result.total_cost_usd.toFixed(4)}
          {result.subtype === "success" ? <> · "{result.result}"</> : <div className="snippet">{result.errors?.join("\n")}</div>}
        </div>
      )}
      {run.error && <div className="snippet">for await threw: {run.error}</div>}
      {!run.running && result && !run.error && <div className="hint">for await ended normally</div>}
      {run.running && <div className="hint">running…</div>}
      {explanation && <div className="delegation">{explanation}</div>}
      <Details run={run} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part B: one command, four sandbox configurations
// ---------------------------------------------------------------------------------------------

const commands = [
  { id: "writeInside", label: "Write inside cwd", command: "echo sandboxed > note.txt && cat note.txt", active: "Allowed: cwd is writable" },
  { id: "readOutside", label: "Read outside cwd", command: "cat ../outside/secret.txt", active: "Allowed, unless denyRead lists the file" },
  { id: "writeOutside", label: "Write outside cwd", command: "echo escaped > ../outside/escape.txt && echo written", active: "Blocked: only cwd (and allowWrite) is writable" },
  { id: "network", label: "Network (curl)", command: 'curl -s -o /dev/null -w "%{http_code}" https://example.com', active: "Blocked (or a permission ask for the new host) unless allowedDomains has example.com, or curl is excluded" },
  { id: "escapeHatch", label: "Escape hatch", command: "…the same write, with dangerouslyDisableSandbox: true", active: "Runs unsandboxed after canUseTool approves it, unless allowUnsandboxedCommands is false" },
] as const;
type CommandId = (typeof commands)[number]["id"];

type Config = { enabled: boolean; autoAllow: boolean; allowUnsandboxed: boolean; denySecret: boolean; allowExample: boolean; excludeCurl: boolean };

const switches: { key: keyof Config; label: string }[] = [
  { key: "enabled", label: "enabled" },
  { key: "autoAllow", label: "autoAllowBashIfSandboxed" },
  { key: "allowUnsandboxed", label: "allowUnsandboxedCommands" },
  { key: "denySecret", label: "filesystem.denyRead: [secret.txt]" },
  { key: "allowExample", label: 'network.allowedDomains: ["example.com"]' },
  { key: "excludeCurl", label: 'excludedCommands: ["curl"]' },
];

const DEFAULTS: Config = { enabled: true, autoAllow: true, allowUnsandboxed: true, denySecret: false, allowExample: false, excludeCurl: false };
const initialColumns: Config[] = [
  { ...DEFAULTS, enabled: false },
  { ...DEFAULTS },
  { ...DEFAULTS, autoAllow: false },
  { ...DEFAULTS, allowUnsandboxed: false, denySecret: true, allowExample: true },
];

function CommandsPart() {
  const [commandId, setCommandId] = useState<CommandId>("writeOutside");
  const [columns, setColumns] = useState(initialColumns);
  const [runs, setRuns] = useState<Record<number, Run>>({});
  const running = Object.values(runs).some((r) => r.running);
  const current = commands.find((c) => c.id === commandId)!;

  const toggle = (i: number, key: keyof Config) => setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, [key]: !c[key] } : c)));

  function runAll() {
    setRuns({});
    columns.forEach((config, column) => startRun("/api/c18/run", { column, commandId, config }, (fn) => setRuns((prev) => ({ ...prev, [column]: fn(prev[column] ?? EMPTY) }))));
  }

  return (
    <>
      <h3>B · One Bash command, four sandbox configurations</h3>
      <p className="hint">
        Each column gets its own <code>project/</code> (cwd) and <code>outside/</code> (with <code>secret.txt</code>).
        <code> canUseTool</code> shows every permission ask and allows only the lab command. After the run the server
        checks the disk itself. The sandbox always has <code>failIfUnavailable: false</code>, so the columns run even
        where the sandbox cannot start. There, compare the disk with the "with an active sandbox" line.
      </p>
      <div className="scenarios">
        {commands.map((c) => (
          <button key={c.id} className={c.id === commandId ? "active" : ""} onClick={() => setCommandId(c.id)} disabled={running}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="card">
        <code>{current.command}</code>
        <div className="hint">With an active sandbox (from the docs): {current.active}.</div>
      </div>
      <div className="compare-grid">
        {columns.map((c, i) => (
          <div key={i} className="card config">
            <b>Column {i + 1}</b>
            {switches.map((s) => (
              <label key={s.key} className="check">
                <input type="checkbox" checked={c[s.key]} disabled={running || (s.key !== "enabled" && !c.enabled)} onChange={() => toggle(i, s.key)} />
                {s.key === "enabled" ? <b>sandbox.enabled</b> : s.label}
              </label>
            ))}
          </div>
        ))}
      </div>
      <button className="primary" onClick={runAll} disabled={running}>
        {running ? "Running…" : "Run the 4 columns in parallel"}
      </button>
      <div className="compare-grid">
        {columns.map((c, i) => (runs[i] ? <CommandCard key={i} title={`Column ${i + 1}`} config={c} run={runs[i]} /> : null))}
      </div>
    </>
  );
}

function CommandCard({ title, config, run }: { title: string; config: Config; run: Run }) {
  const { result, calls } = readRun(run);
  const status = sandboxStatus(run);
  return (
    <div className="card config">
      <b>{title}</b>
      <div className="hint">
        sandbox: <span className={`subtype ${status.cls}`}>{config.enabled ? status.label : "off"}</span>
      </div>
      {calls.map((c) => {
        const ask = run.asks.find((a) => a.input.command === c.input.command);
        return (
          <div key={c.id} className={`tool-call ${ask && !ask.allowed ? "denied" : ""}`}>
            <span className="tag">Bash</span> <code>{c.input.command}</code>
            {c.input.dangerouslyDisableSandbox && <span className="tag tag-error">dangerouslyDisableSandbox</span>}
            <div className="hint">
              canUseTool: <b>{ask ? (ask.allowed ? "asked → allowed" : "asked → denied") : run.running && !c.result ? "…" : "not asked"}</b>
              {ask?.decisionReason && <> · {ask.decisionReason}</>}
              {ask?.blockedPath && <> · blockedPath: {ask.blockedPath}</>}
            </div>
            {c.result && <div className="snippet">{c.result.text.slice(0, 400)}</div>}
          </div>
        );
      })}
      {run.disk && (
        <div className="hint">
          on disk: project/ = [{run.disk["project/"].join(", ")}] · outside/ = [{run.disk["outside/"].join(", ")}]
          {run.disk.escapeOutside && <div className="subtype bad">escape.txt was written outside cwd</div>}
        </div>
      )}
      {run.error && <div className="snippet">⚠ {run.error}</div>}
      {result && (
        <div className="hint">
          <span className={`subtype ${result.subtype === "success" ? "" : "bad"}`}>{result.subtype}</span> · $
          {result.total_cost_usd.toFixed(4)}
        </div>
      )}
      {run.running && <div className="hint">running…</div>}
      <Details run={run} />
    </div>
  );
}
