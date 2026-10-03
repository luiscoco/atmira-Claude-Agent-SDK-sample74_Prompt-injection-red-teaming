import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

// Must match SWITCHES and HOOKS in server/concepts/21-slash-commands.ts.
const switchInfo: { name: string; label: string; does: string }[] = [
  { name: "skillTool", label: 'tools + "Skill"', does: "the MODEL can run commands" },
  { name: "bash", label: 'tools + "Bash"', does: "!`cmd` lines can run" },
  { name: "noShell", label: "disableSkillShellExecution", does: "!`cmd` lines become a placeholder" },
  { name: "verbatim", label: "verbatimPrompts: true", does: "no slash-command dispatch" },
  { name: "noProject", label: "settingSources: []", does: ".claude/commands/ is not scanned" },
];
const hookInfo = [{ name: "freeze-release", does: 'UserPromptExpansion: decision "block" for /release' }];

type Form = { prompt: string; switches: string[]; hooks: string[] };
type Command = { name: string; file: string; frontmatter: Record<string, string>; body: string };
type Listed = { custom: { name: string; description: string; argumentHint: string }[]; builtin: string[] };
type HookCall = { name: string; event: string; input: any; output: any; at: number };

const one = (prompt: string, switches: string[] = [], hooks: string[] = []): Form => ({ prompt, switches, hooks });

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · A command",
    hint: "The CLI finds .claude/commands/standup.md and puts its body in the prompt before the model runs. The model follows it and reads data/sprint.json. There is no Skill tool: the user's /name doesn't need it.",
    form: one("/standup"),
  },
  {
    label: "2 · $ARGUMENTS",
    hint: "Everything after the name replaces $ARGUMENTS. The observer row shows UserPromptExpansion with command_name and command_args, before UserPromptSubmit.",
    form: one("/greet Ana"),
  },
  {
    label: "3 · Positional & named",
    hint: 'Positional arguments are 0-BASED: $0 is the first one ($1 is the second). Words in quotes count as one argument. arguments: [id, priority, title] in the frontmatter gives them names: $id, $priority, $title.',
    form: one('/ticket 42 high "Fix the CSV export"'),
  },
  {
    label: "4 · @file",
    hint: "The body has @src/cart.js: the file's content is put in the prompt when the command expands, so no Read call is needed (Haiku sometimes reads it anyway). Usually one turn.",
    form: one("/review"),
  },
  {
    label: "5 · Subfolder",
    hint: 'frontend/component.md is the command "frontend:component". Try "/component Button": it is not a command, so the text goes to the model.',
    form: one("/frontend:component Button"),
  },
  {
    label: "6 · Unknown command",
    hint: "No file, no built-in: the prompt goes to the model as plain text. You pay for a turn, and the model answers about a command it doesn't have.",
    form: one("/nope hello"),
  },
  {
    label: "7 · Shell, no Bash",
    hint: 'env-check has two !`…` lines. Bash is not in tools, so the expansion fails: 0 turns, $0, local_command: "custom", and the error arrives as <local-command-stderr>.',
    form: one("/env-check"),
  },
  {
    label: "8 · Shell with Bash",
    hint: "Bash is in tools but not in allowedTools. ls data is read-only, so it runs anyway. node -e is not, so it runs only because the command's allowed-tools: Bash(node -e:*) grants it. The model gets both outputs in one turn.",
    form: one("/env-check", ["bash"]),
  },
  {
    label: "9 · Shell disabled",
    hint: "settings.disableSkillShellExecution: each !`…` line becomes a placeholder and never runs. Bash is not in tools here: with it, the model would just run ls and node itself.",
    form: one("/env-check", ["noShell"]),
  },
  {
    label: "10 · Model per command",
    hint: "whoami.md has model: claude-sonnet-5. options.model is Haiku, but system/init and the result's modelUsage say Sonnet. Only this command's turn changes model.",
    form: one("/whoami"),
  },
  {
    label: "11 · The model runs one",
    hint: 'With "Skill" in tools the model sees the commands and can run one itself: Skill { skill: "greet", args: "Ana" }. 3 turns instead of 1.',
    form: one("Use the greet command to greet Ana.", ["skillTool"]),
  },
  {
    label: "12 · User-only command",
    hint: "release.md has disable-model-invocation: true. The model is not told about it, even with the Skill tool. Now type /release 2.0: the user can run it.",
    form: one("Use the release command to announce version 2.0.", ["skillTool"]),
  },
  {
    label: "13 · Built-in: /context",
    hint: "A built-in runs inside Claude Code: 0 turns, $0, result.local_command: \"context\". Try /cost, /model, /usage too. /help is not available in the SDK.",
    form: one("/context"),
  },
  {
    label: "14 · Untrusted text",
    hint: "Imagine /release 9.9 came from a ticket, not from the user. verbatimPrompts: true delivers it as plain text: no dispatch, no UserPromptExpansion, no release. Untick it to see the difference.",
    form: one("/release 9.9", ["verbatim"]),
  },
  {
    label: "15 · Block a command",
    hint: 'freeze-release answers decision: "block" on UserPromptExpansion. The model is never called: 0 turns, $0, and a system/informational warning.',
    form: one("/release 2.0", [], ["freeze-release"]),
  },
  {
    label: "16 · No project settings",
    hint: "settingSources: [] means .claude/commands/ is not scanned. /greet is unknown, so the text goes to the model.",
    form: one("/greet Ana", ["noProject"]),
  },
];

const sessions: { label: string; hint: string; prompts: string }[] = [
  {
    label: "Compact & clear",
    hint: "One session, one prompt per line. /compact summarises the conversation (compact_boundary: tokens before → after) and the code word survives. /clear starts a new conversation: new session_id, cost back to $0, the code word is gone.",
    prompts: [
      "Remember this: the code word is PINEAPPLE. Answer only OK.",
      "/greet Ana",
      "/context",
      "/compact Keep only the code word.",
      "What is the code word? One word.",
      "/clear",
      "What is the code word I told you? Answer UNKNOWN if I never told you one. Do not use tools.",
    ].join("\n"),
  },
  {
    label: "Commands in a session",
    hint: "Custom commands and built-ins mix in one conversation. /cost reports the session so far, and total_cost_usd in each result is cumulative.",
    prompts: ["/greet Ana", '/ticket 7 low "Dark mode"', "/cost"].join("\n"),
  },
];

/** Text of the main agent's answers. */
const answerOf = (messages: any[]) =>
  messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n");

/** Local command output: user messages replayed with <local-command-stdout> / <local-command-stderr>. */
const localOutput = (messages: any[]) =>
  messages
    .filter((m) => m.type === "user" && m.isReplay && typeof m.message.content === "string" && m.message.content.includes("<local-command-"))
    .map((m) => m.message.content.replace(/<\/?local-command-(stdout|stderr)>/g, (t: string) => (t.startsWith("</") ? "" : `[${t.slice(15, -1)}] `)));

/** One sentence: how the CLI handled the prompt. */
function verdict(messages: any[], calls: HookCall[]) {
  const result = messages.find((m) => m.type === "result");
  const expansion = calls.find((c) => c.event === "UserPromptExpansion");
  const skill = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content)
    .find((b: any) => b.type === "tool_use" && b.name === "Skill");
  if (!result) return null;
  if (expansion?.output?.decision === "block") return `/${expansion.input.command_name} was blocked by a UserPromptExpansion hook. The model was not called.`;
  if (result.local_command === "custom") return `/${expansion?.input.command_name ?? "?"} failed while expanding (see the local output). The model was not called.`;
  if (result.local_command) return `/${result.local_command} is a built-in. It ran inside Claude Code: the model was not called.`;
  if (expansion) return `/${expansion.input.command_name} was expanded from ${expansion.input.command_source} with args "${expansion.input.command_args}", then sent to the model.`;
  if (skill) return `No expansion. The model ran the command itself: Skill ${JSON.stringify(skill.input)}.`;
  return "No command was dispatched. The prompt went to the model as plain text.";
}

export function Concept21SlashCommands() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [openBody, setOpenBody] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [listed, setListed] = useState<Listed | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<HookCall[]>([]);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<"run" | "session" | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const [sessionText, setSessionText] = useState(sessions[0].prompts);
  const [sessionHint, setSessionHint] = useState(sessions[0].hint);
  const [turns, setTurns] = useState<{ prompt: string; messages: any[] }[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c21/commands")
      .then((r) => r.json())
      .then(setCommands)
      .catch(() => setError("Could not list the commands — is this sample's server running on port 3001?"));
  }, []);

  // A live counter, so a slow run is visibly different from a stuck one.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);

  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  /** Starts a streamed request; Stop closes it and the server's SSE helper aborts the query. */
  async function stream(kind: "run" | "session", url: string, body: unknown, onEvent: (e: string, d: any) => void, onError: (m: string) => void) {
    setElapsed(0);
    setRunning(kind);
    const ctrl = new AbortController();
    setController(ctrl);
    try {
      await streamPost(url, body, onEvent, ctrl.signal);
    } catch (err) {
      onError(ctrl.signal.aborted ? "Stopped from the browser." : `${String(err)} — is this sample's server running on port 3001?`);
    } finally {
      setRunning(null);
      setController(null);
    }
  }

  function run() {
    setMessages([]);
    setCalls([]);
    setListed(null);
    setSentOptions(null);
    setError(null);
    stream(
      "run",
      "/api/c21/run",
      form,
      (event, data) => {
        if (event === "options") setSentOptions(data);
        if (event === "commands") setListed(data);
        if (event === "hook") setCalls((prev) => [...prev, data]);
        if (event === "message") setMessages((prev) => [...prev, data]);
        if (event === "error") setError(data.message);
      },
      setError,
    );
  }

  function runSession() {
    setTurns([]);
    setSessionError(null);
    stream(
      "session",
      "/api/c21/session",
      { prompts: sessionText.split("\n").filter((l) => l.trim()) },
      (event, data) => {
        if (event === "turn") setTurns((prev) => [...prev, { prompt: data.prompt, messages: [] }]);
        // Messages belong to the last prompt pushed.
        if (event === "message") setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, messages: [...t.messages, data] } : t)));
        if (event === "error") setSessionError(data.message);
      },
      setSessionError,
    );
  }

  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
  const text = answerOf(messages);
  const local = localOutput(messages);
  const forUser = messages.filter((m) => m.type === "system" && ["informational", "permission_denied", "conversation_reset", "compact_boundary"].includes(m.subtype));
  const how = verdict(messages, calls);

  return (
    <section>
      <h2>21 · Slash commands</h2>
      <p className="lead">
        A prompt that starts with <code>/</code> is not sent to the model as written. Claude Code looks the name up first: a{" "}
        <b>custom command</b> (<code>.claude/commands/*.md</code>) is expanded into the prompt, a <b>built-in</b> (
        <code>/context</code>, <code>/compact</code>…) runs locally, and an <b>unknown</b> one goes to the model as text. Haiku, no
        thinking, <code>cwd: commands-project/</code>, <code>settingSources: ["project"]</code>.
      </p>

      <h3>A · The command files</h3>
      <table className="tools">
        <thead>
          <tr>
            <th>command</th>
            <th>file</th>
            <th>frontmatter</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((c) => (
            <tr key={c.name}>
              <td>
                <button className="link" onClick={() => setOpenBody(openBody === c.name ? null : c.name)}>
                  /{c.name} {c.frontmatter["argument-hint"] ?? ""}
                </button>
              </td>
              <td>
                <code>{c.file.replace(".claude/commands/", "")}</code>
              </td>
              <td>
                {Object.entries(c.frontmatter)
                  .filter(([k]) => k !== "description" && k !== "argument-hint")
                  .map(([k, v]) => (
                    <div key={k}>
                      <code>
                        {k}: {v}
                      </code>
                    </div>
                  ))}
              </td>
              <td>{c.frontmatter.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {openBody && (
        <div className="card">
          <b>{commands.find((c) => c.name === openBody)?.file}</b> <span className="subtype">the body that replaces the prompt</span>
          <pre>{commands.find((c) => c.name === openBody)?.body}</pre>
        </div>
      )}

      <h3>B · One prompt</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
            disabled={running !== null}
          >
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}

      <input value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} onKeyDown={(e) => e.key === "Enter" && !running && form.prompt.trim() && run()} />
      <div className="row">
        {switchInfo.map((s) => (
          <label key={s.name} className="check" title={s.does}>
            <input type="checkbox" checked={form.switches.includes(s.name)} onChange={() => setForm({ ...form, switches: toggle(form.switches, s.name) })} />{" "}
            <code>{s.label}</code>
          </label>
        ))}
        {hookInfo.map((h) => (
          <label key={h.name} className="check" title={h.does}>
            <input type="checkbox" checked={form.hooks.includes(h.name)} onChange={() => setForm({ ...form, hooks: toggle(form.hooks, h.name) })} /> hook{" "}
            <code>{h.name}</code>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={run} disabled={running !== null || !form.prompt.trim()}>
          {running === "run" ? `Running… ${elapsed} s` : "Run query()"}
        </button>
        {running === "run" && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      {how && (
        <div className={`card ${result?.num_turns === 0 ? "warn" : ""}`}>
          <b>How the prompt was handled</b>
          <div>{how}</div>
        </div>
      )}

      {calls.length > 0 && (
        <div className="card">
          <b>prompt hooks</b> <span className="subtype">ms since the run started</span>
          {calls.map((c, i) => (
            <div key={i} className={`tool-call ${c.output?.decision === "block" ? "denied" : ""} ${c.name === "observer" ? "observer" : ""}`}>
              <span className="subtype">{c.at} ms</span> <span className="tag tag-pre">{c.event}</span> <code>{c.name}</code>
              <div className="snippet">
                {c.event === "UserPromptExpansion"
                  ? `command_name: ${c.input.command_name} · command_args: ${JSON.stringify(c.input.command_args)} · command_source: ${c.input.command_source} · expansion_type: ${c.input.expansion_type}`
                  : `prompt: ${c.input.prompt}`}
              </div>
              <div className="snippet report">{Object.keys(c.output ?? {}).length ? `→ ${JSON.stringify(c.output)}` : "→ {}"}</div>
            </div>
          ))}
        </div>
      )}

      {local.length > 0 && (
        <div className="card warn">
          <b>local command output</b> <span className="subtype">user messages replayed by the CLI, never sent to the model</span>
          {local.map((l, i) => (
            <div key={i} className="snippet">
              {l}
            </div>
          ))}
        </div>
      )}

      {forUser.length > 0 && (
        <div className="card warn">
          {forUser.map((m, i) => (
            <div key={i} className="snippet">
              {m.type}/{m.subtype}: {m.content ?? m.message ?? JSON.stringify(m.compact_metadata ?? { new_conversation_id: m.new_conversation_id })}
            </div>
          ))}
        </div>
      )}

      {text && <div className="card answer">{text}</div>}
      {result && (
        <div className="card">
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · ${result.total_cost_usd.toFixed(4)}
          <div>
            <b>local_command</b>: <code>{result.local_command ?? "(unset: the model loop ran)"}</code> · <b>terminal_reason</b>:{" "}
            <code>{result.terminal_reason ?? "(unset)"}</code>
          </div>
          <div>
            <b>model</b>: init <code>{init?.model}</code> · modelUsage <code>{Object.keys(result.modelUsage ?? {}).join(", ") || "(none)"}</code>
          </div>
        </div>
      )}

      {listed && (
        <details className="card">
          <summary>
            <b>q.supportedCommands()</b>{" "}
            <span className="subtype">
              {listed.custom.length} custom · {listed.builtin.length} built-in · init.slash_commands: {init?.slash_commands.length}
            </span>
          </summary>
          <table className="tools">
            <tbody>
              {listed.custom.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code>
                      /{c.name} {c.argumentHint}
                    </code>
                  </td>
                  <td>{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="snippet">built-in: {listed.builtin.map((b) => `/${b}`).join("  ")}</div>
        </details>
      )}

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

      <h3>C · Several prompts in one session</h3>
      <div className="scenarios">
        {sessions.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setSessionText(s.prompts);
              setSessionHint(s.hint);
            }}
            disabled={running !== null}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sessionHint && <p className="hint">{sessionHint}</p>}
      <textarea value={sessionText} onChange={(e) => setSessionText(e.target.value)} rows={7} />
      <div className="row">
        <button className="primary" onClick={runSession} disabled={running !== null || !sessionText.trim()}>
          {running === "session" ? `Running… ${elapsed} s` : "Run the session"}
        </button>
        {running === "session" && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      {turns.length > 0 && (
        <div className="card">
          <b>turns</b> <span className="subtype">one row per prompt, in one query()</span>
          {turns.map((t, i) => (
            <TurnRow key={i} index={i} prompt={t.prompt} messages={t.messages} />
          ))}
        </div>
      )}
      {sessionError && (
        <div className="card warn">
          <b>error</b> — <code>{sessionError}</code>
        </div>
      )}
    </section>
  );
}

/** One prompt of the session: what it did, what it cost, and the session it ended in. */
function TurnRow({ index, prompt, messages }: { index: number; prompt: string; messages: any[] }) {
  const result = messages.find((m) => m.type === "result");
  const compact = messages.find((m) => m.type === "system" && m.subtype === "compact_boundary");
  const reset = messages.find((m) => m.type === "conversation_reset");
  // Built-ins answer with a synthetic assistant message; custom commands and plain prompts with the model's text.
  const text = answerOf(messages);
  const local = localOutput(messages);
  return (
    <div className="tool-call">
      <div>
        <span className="subtype">#{index + 1}</span> <code>{prompt}</code>{" "}
        {result ? (
          <span className="subtype">
            {result.local_command ? `local_command: ${result.local_command}` : "model"} · {result.num_turns} turn(s) · total ${result.total_cost_usd.toFixed(4)} · session{" "}
            {result.session_id.slice(0, 8)}
          </span>
        ) : (
          <span className="subtype">running…</span>
        )}
      </div>
      {compact && (
        <div className="snippet">
          compact_boundary: {compact.compact_metadata.pre_tokens} → {compact.compact_metadata.post_tokens} tokens ({compact.compact_metadata.trigger})
        </div>
      )}
      {reset && <div className="snippet">conversation_reset: new conversation {reset.new_conversation_id.slice(0, 8)}</div>}
      {local.map((l, i) => (
        <div key={i} className="snippet">
          {l}
        </div>
      ))}
      {text && !compact && <div className="answer thin">{text.length > 600 ? `${text.slice(0, 600)}…` : text}</div>}
    </div>
  );
}
