import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

// Must match SWITCHES in server/concepts/23-plugins.ts. `inventory: true` means it changes what Part B shows.
const switchInfo: { name: string; label: string; does: string; inventory?: boolean }[] = [
  { name: "noPlugins", label: "plugins: []", does: "no plugin at all: the baseline", inventory: true },
  { name: "extra", label: "+ atmira-extra", does: "a second plugin, no manifest, with its own commands/standup.md", inventory: true },
  { name: "broken", label: "+ broken", does: "a plugin whose plugin.json is invalid JSON", inventory: true },
  { name: "skipMcp", label: "skipMcpDiscovery", does: "load atmira-ops without its .mcp.json", inventory: true },
  { name: "strict", label: "strictMcpConfig", does: "only servers from the mcpServers option: plugin servers are dropped too", inventory: true },
  { name: "initialize", label: 'pluginDelivery: "initialize"', does: "send the plugin list over stdin; initializationResult().plugins_applied", inventory: true },
  { name: "team", label: "pluginConfigs team", does: 'settings.pluginConfigs["atmira-ops@inline"].options.team = "Nebula"', inventory: true },
  { name: "noAllow", label: "no allow rule", does: "remove mcp__plugin_atmira-ops_tickets__* from allowedTools" },
  { name: "autoApprove", label: "plugin hook approves", does: "ATMIRA_AUTO_APPROVE=1: the plugin's PreToolUse hook answers allow to every tool" },
  { name: "denyList", label: "disallowedTools", does: "the host removes mcp__plugin_atmira-ops_tickets__list_tickets" },
];

const NO_TOOL = "List the tickets. Use only the tickets MCP tools and no agent. If you have no such tool, answer exactly: NO TICKETS TOOL.";

type Form = { prompt: string; switches: string[] };
type PluginFile = { file: string; part: string; content: string };
type PluginDir = { folder: string; name: string; manifest: any; manifestError?: string; files: PluginFile[] };
type Audit = { at: string; event: string; tool?: string; decision: string; pluginEnv: Record<string, string> };
type Inventory = {
  options: any;
  plugins_applied?: boolean;
  commands: { name: string; description: string; argumentHint?: string; aliases?: string[] }[];
  agents: { name: string; description: string; model?: string }[];
  mcpServers: { name: string; status: string; scope?: string; source?: string; error?: string; tools?: string[] }[];
  plugins: { name: string; path: string; source?: string; version?: string }[];
  error_count: number;
  audit: Audit[];
};
type Step = { step: string; commands?: string[]; agents?: string[]; held?: boolean; error_count?: number; mcpServers?: string[] };

const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · A plugin command",
    hint: "/atmira-ops:standup is commands/standup.md. The CLI expands it before the model sees it (no Skill call), and the command tells the model to use the plugin's MCP tool. The plugin's SessionStart hook added a line of context: look for the '— atmira-ops' signature.",
    form: { prompt: "/atmira-ops:standup Ana", switches: [] },
  },
  {
    label: "2 · The short name",
    hint: "/standup without the namespace is NOT expanded by the CLI. The model gets the text '/standup Ana' and calls Skill(\"atmira-ops:standup\") itself, with no args: 4 turns instead of 2. It usually keeps 'Ana' from your text, but once it wrote 'Stand-up for ' with no name.",
    form: { prompt: "/standup Ana", switches: [] },
  },
  {
    label: "3 · A plugin skill",
    hint: "No slash: the model picks the plugin skill from its description and calls Skill(\"atmira-ops:ticket-format\"). The body arrives in a synthetic user message whose base directory is inside the plugin.",
    form: { prompt: "Write a ticket: the login page freezes on Safari.", switches: [] },
  },
  {
    label: "4 · A plugin agent",
    hint: "agents/reviewer.md becomes subagent_type \"atmira-ops:reviewer\". Its answer is the Agent tool result. The host's own PreToolUse hook (foreground) and the plugin's PreToolUse hook both run on that Agent call.",
    form: { prompt: "Get ticket ATM-102, then ask the atmira-ops:reviewer agent to review it. Repeat its answer.", switches: [] },
  },
  {
    label: "5 · MCP + userConfig default",
    hint: "server_info shows how the plugin's MCP server was started: ${CLAUDE_PLUGIN_ROOT} became the plugin folder, and ${user_config.team} the manifest's default, Orbit. The hook's CLAUDE_PLUGIN_OPTION_TEAM is NOT set for a default.",
    form: { prompt: "Call server_info and show the result.", switches: [] },
  },
  {
    label: "6 · userConfig from pluginConfigs",
    hint: 'settings.pluginConfigs["atmira-ops@inline"].options.team = "Nebula". The MCP server gets Nebula, and now the hook process has CLAUDE_PLUGIN_OPTION_TEAM=Nebula too.',
    form: { prompt: "Call server_info and show the result.", switches: ["team"] },
  },
  {
    label: "7 · The plugin's hook blocks",
    hint: "The plugin's PreToolUse hook denies get_ticket for ATM-999. The model gets 'hook error: atmira-ops: ATM-999 is confidential.', and result.permission_denials lists the call.",
    form: { prompt: "Get ticket ATM-999 and tell me its title.", switches: [] },
  },
  {
    label: "8 · Two plugins, one name",
    hint: "atmira-extra has no plugin.json, so its name is the folder name. Both plugins have commands/standup.md: they live side by side as atmira-ops:standup and atmira-extra:standup.",
    form: { prompt: "/atmira-extra:standup", switches: ["extra"] },
  },
  {
    label: "9 · skipMcpDiscovery",
    hint: "{ type: \"local\", path, skipMcpDiscovery: true }: commands, agents, skills and hooks load, but .mcp.json is not read. Use it when your app runs the plugin's MCP server itself.",
    form: { prompt: NO_TOOL, switches: ["skipMcp"] },
  },
  {
    label: "10 · strictMcpConfig",
    hint: "strictMcpConfig: true keeps only the servers in the mcpServers option. The plugin's server is dropped too, although the rest of the plugin loads.",
    form: { prompt: NO_TOOL, switches: ["strict"] },
  },
  {
    label: "11 · No allow rule",
    hint: "Without mcp__plugin_atmira-ops_tickets__* in allowedTools, the plugin's tool is denied like any other: loading a plugin does not approve its tools. The plugin's hook ran but gave no decision.",
    form: { prompt: "List the tickets.", switches: ["noAllow"] },
  },
  {
    label: "12 · Plugin hook approves",
    hint: "The same, but the plugin's hook answers permissionDecision: \"allow\". The tool runs although the host never allowed it. A plugin's hooks have the same power as yours: only load plugins you trust.",
    form: { prompt: "List the tickets.", switches: ["noAllow", "autoApprove"] },
  },
  {
    label: "13 · disallowedTools wins",
    hint: "The same approving hook, plus disallowedTools with list_tickets. The tool is removed from the model's list (2 MCP tools in init), so no hook can bring it back. The other two tools are still approved by the hook if the model tries them.",
    form: { prompt: "Call the list_tickets tool.", switches: ["noAllow", "autoApprove", "denyList"] },
  },
  {
    label: "14 · pluginDelivery",
    hint: 'pluginDelivery: "initialize" sends the plugin list over stdin instead of one --plugin-dir flag per plugin (Windows limits a command line to 32,767 characters). initializationResult().plugins_applied confirms they loaded.',
    form: { prompt: "Say OK.", switches: ["initialize"] },
  },
];

const text = (content: any) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "");

/** Every tool call, with its result, and whether it came from a subagent. */
function toolCalls(messages: any[]) {
  const results = new Map<string, any>();
  for (const m of messages) if (m.type === "user" && Array.isArray(m.message.content)) for (const b of m.message.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  return messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ ...b, sub: !!m.parent_tool_use_id, result: results.get(b.id) })));
}

/** Text of the main agent's answers. */
const answerOf = (messages: any[]) =>
  messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n");

/** A foreground subagent's answer is the Agent tool result, wrapped in a hand-back preamble and an agentId footer. */
const handBack = (t: string) => t.replace(/^[\s\S]*?The report follows:\s*/, "").replace(/\n+agentId:[\s\S]*$/, "").trim();

const partTag: Record<string, string> = { manifest: "tag-system", command: "tag-assistant", agent: "tag-result", skill: "tag-user", hooks: "tag-pre", mcp: "tag-error" };

function AuditTable({ lines }: { lines: Audit[] }) {
  if (!lines.length) return null;
  return (
    <table className="tools">
      <thead>
        <tr>
          <th>event</th>
          <th>tool</th>
          <th>decision</th>
          <th>CLAUDE_PLUGIN_* in the hook process</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((a, i) => (
          <tr key={i}>
            <td>
              <span className="tag tag-pre">{a.event}</span>
            </td>
            <td>
              <code>{a.tool ?? "—"}</code>
            </td>
            <td>{a.decision}</td>
            <td className="snippet">
              {Object.entries(a.pluginEnv)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Concept23Plugins() {
  const [dirs, setDirs] = useState<PluginDir[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [invSwitches, setInvSwitches] = useState<string[]>(["extra", "broken"]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [messages, setMessages] = useState<any[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [control, setControl] = useState<any>(null);
  const [sentOptions, setSentOptions] = useState<any>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [reloadMessages, setReloadMessages] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inventory" | "run" | "reload" | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetch("/api/c23/plugins")
      .then((r) => r.json())
      .then((d) => setDirs(d.plugins))
      .catch(() => setError("Could not list the plugins — is this sample's server running on port 3001?"));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  async function loadInventory() {
    setInventory(null);
    setError(null);
    setElapsed(0);
    setBusy("inventory");
    try {
      const r = await fetch("/api/c23/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ switches: invSwitches }) });
      const data = await r.json();
      if (data.error) setError(data.error);
      else setInventory(data);
    } catch (err) {
      setError(`${String(err)} — is this sample's server running on port 3001?`);
    } finally {
      setBusy(null);
    }
  }

  async function stream(kind: "run" | "reload", url: string, body: unknown) {
    setError(null);
    setSentOptions(null);
    setElapsed(0);
    setBusy(kind);
    const ctrl = new AbortController();
    setController(ctrl);
    try {
      await streamPost(
        url,
        body,
        (event, data) => {
          if (event === "options") setSentOptions(data);
          if (event === "audit") setAudit((prev) => [...prev, data]);
          if (event === "control") setControl(data);
          if (event === "step") setSteps((prev) => [...prev, data]);
          if (event === "message") (kind === "run" ? setMessages : setReloadMessages)((prev) => [...prev, data]);
          if (event === "error") setError(data.message);
        },
        ctrl.signal,
      );
    } catch (err) {
      setError(ctrl.signal.aborted ? "Stopped from the browser." : `${String(err)} — is this sample's server running on port 3001?`);
    } finally {
      setBusy(null);
      setController(null);
    }
  }

  function run() {
    setMessages([]);
    setAudit([]);
    setControl(null);
    stream("run", "/api/c23/run", { prompt: form.prompt, switches: form.switches });
  }

  function reload() {
    setMessages([]); // the message log below then shows the reload session
    setSteps([]);
    setReloadMessages([]);
    stream("reload", "/api/c23/reload", {});
  }

  const result = messages.find((m) => m.type === "result");
  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  const calls = toolCalls(messages);
  const answer = answerOf(messages);
  const reloadAnswer = answerOf(reloadMessages);
  const opened = dirs.flatMap((d) => d.files.map((f) => ({ ...f, key: `${d.folder}/${f.file}` }))).find((f) => f.key === openFile);
  const builtinAgents = inventory?.agents.filter((a) => !a.name.includes(":")) ?? [];

  return (
    <section>
      <h2>23 · Plugins in depth</h2>
      <p className="lead">
        A plugin is one folder that adds several things at once: slash commands, subagents, skills, hooks and MCP servers. It is loaded with{" "}
        <code>plugins: [{"{"} type: "local", path {"}"}]</code>, and its manifest name becomes the namespace of every part. Haiku, no thinking,{" "}
        <code>settingSources: []</code>, and a fake <code>CLAUDE_CONFIG_DIR</code> (<code>plugins-lab/home</code>), because Claude Code creates each plugin's
        data folder there.
      </p>

      <h3>A · The plugins on disk</h3>
      {dirs.map((d) => (
        <div key={d.folder} className="card">
          <b>{d.folder}/</b>{" "}
          {d.manifestError ? (
            <span className="subtype">⚠ plugin.json is invalid: {d.manifestError}</span>
          ) : d.manifest ? (
            <span className="subtype">
              name <code>{d.manifest.name}</code> · version {d.manifest.version ?? "—"}
              {d.manifest.userConfig && <> · userConfig: {Object.keys(d.manifest.userConfig).join(", ")}</>}
            </span>
          ) : (
            <span className="subtype">no .claude-plugin/plugin.json: the name is the folder name</span>
          )}
          <div className="row">
            {d.files.map((f) => (
              <button key={f.file} className="link" onClick={() => setOpenFile(openFile === `${d.folder}/${f.file}` ? null : `${d.folder}/${f.file}`)}>
                <span className={`tag ${partTag[f.part] ?? ""}`}>{f.part}</span> {f.file}
              </button>
            ))}
          </div>
        </div>
      ))}
      {opened && (
        <div className="card">
          <b>{opened.key}</b>
          <pre>{opened.content}</pre>
        </div>
      )}

      <h3>B · What the session sees</h3>
      <p className="hint">
        No prompt is sent, so this costs nothing: the session starts, then <code>initializationResult()</code>, <code>mcpServerStatus()</code> and{" "}
        <code>reloadPlugins()</code> answer. Only <code>reloadPlugins()</code> reports <code>error_count</code>: a broken plugin is otherwise silent.
      </p>
      <div className="row">
        {switchInfo
          .filter((s) => s.inventory)
          .map((s) => (
            <label key={s.name} className="check" title={s.does}>
              <input type="checkbox" checked={invSwitches.includes(s.name)} onChange={() => setInvSwitches(toggle(invSwitches, s.name))} /> <code>{s.label}</code>
            </label>
          ))}
      </div>
      <div className="row">
        <button className="primary" onClick={loadInventory} disabled={!!busy}>
          {busy === "inventory" ? `Loading… ${elapsed} s` : "Open a session (no model call)"}
        </button>
      </div>
      {inventory && (
        <div className="card">
          <b>plugins</b> <span className="subtype">reloadPlugins().plugins · error_count: {inventory.error_count}</span>
          {inventory.plugins_applied !== undefined && <span className="subtype">plugins_applied: {String(inventory.plugins_applied)}</span>}
          <table className="tools">
            <tbody>
              {inventory.plugins.map((p) => (
                <tr key={p.source ?? p.name}>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>{p.source}</td>
                  <td>{p.version ?? "—"}</td>
                  <td className="subtype">{p.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inventory.error_count > 0 && <div className="snippet">⚠ {inventory.error_count} plugin(s) failed to load and are missing from this list.</div>}

          <b>commands</b> <span className="subtype">initializationResult().commands, without the built-in ones</span>
          <table className="tools">
            <tbody>
              {inventory.commands.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code>/{c.name}</code> {c.argumentHint}
                  </td>
                  <td>{c.description}</td>
                  <td className="subtype">{c.aliases?.length ? `aliases: ${c.aliases.join(", ")}` : ""}</td>
                </tr>
              ))}
              {inventory.commands.length === 0 && (
                <tr>
                  <td>(none)</td>
                </tr>
              )}
            </tbody>
          </table>

          <b>agents</b> <span className="subtype">initializationResult().agents · plus {builtinAgents.length} built-in ({builtinAgents.map((a) => a.name).join(", ")})</span>
          <table className="tools">
            <tbody>
              {inventory.agents
                .filter((a) => a.name.includes(":"))
                .map((a) => (
                  <tr key={a.name}>
                    <td>
                      <code>{a.name}</code>
                    </td>
                    <td>{a.description}</td>
                    <td>{a.model}</td>
                  </tr>
                ))}
            </tbody>
          </table>

          <b>MCP servers</b> <span className="subtype">mcpServerStatus()</span>
          <table className="tools">
            <tbody>
              {inventory.mcpServers.map((s) => (
                <tr key={s.name}>
                  <td>
                    <code>{s.name}</code>
                  </td>
                  <td>{s.status}</td>
                  <td>
                    scope {s.scope} · source {s.source}
                  </td>
                  <td className="snippet">{s.tools?.join("\n") ?? s.error}</td>
                </tr>
              ))}
              {inventory.mcpServers.length === 0 && (
                <tr>
                  <td>(none)</td>
                </tr>
              )}
            </tbody>
          </table>

          <b>the plugin's hooks</b> <span className="subtype">what hooks/audit.mjs wrote: SessionStart runs even without a prompt</span>
          <AuditTable lines={inventory.audit} />
          <details>
            <summary>options sent to query()</summary>
            <pre>{JSON.stringify(inventory.options, null, 2)}</pre>
          </details>
        </div>
      )}

      <h3>C · A run</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
            disabled={!!busy}
          >
            {s.label}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}
      <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2} />
      <div className="row">
        {switchInfo.map((s) => (
          <label key={s.name} className="check" title={s.does}>
            <input type="checkbox" checked={form.switches.includes(s.name)} onChange={() => setForm({ ...form, switches: toggle(form.switches, s.name) })} />{" "}
            <code>{s.label}</code>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={run} disabled={!!busy || !form.prompt.trim()}>
          {busy === "run" ? `Running… ${elapsed} s` : "Run query()"}
        </button>
        {busy && busy !== "inventory" && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      {init && (
        <div className="card">
          <b>system/init</b>{" "}
          <span className="subtype">
            plugins: {init.plugins.map((p: any) => `${p.source ?? p.name}${p.version ? " " + p.version : ""}`).join(", ") || "—"}
          </span>
          <div className="snippet">
            mcp_servers: {init.mcp_servers.map((s: any) => `${s.name} (${s.status}${s.source ? ", " + s.source : ""})`).join(", ") || "—"}
            {"\n"}MCP tools: {init.tools.filter((t: string) => t.startsWith("mcp__")).join(", ") || "—"}
            {"\n"}slash_commands (plugin): {init.slash_commands.filter((c: string) => c.includes(":")).join(", ") || "—"}
            {"\n"}skills: {init.skills.join(", ") || "—"}
            {"\n"}agents (plugin): {(init.agents ?? []).filter((a: string) => a.includes(":")).join(", ") || "—"}
            {control && `\ninitializationResult().plugins_applied: ${String(control.plugins_applied)}`}
          </div>
        </div>
      )}
      {audit.length > 0 && (
        <div className="card">
          <b>the plugin's hooks</b> <span className="subtype">one line per call of hooks/audit.mjs</span>
          <AuditTable lines={audit} />
        </div>
      )}
      {calls.length > 0 && (
        <div className="card">
          <b>tool calls</b>
          <table className="tools">
            <tbody>
              {calls.map((c) => {
                const out = text(c.result?.content);
                return (
                  <tr key={c.id}>
                    <td>
                      {c.sub && <span className="subtype">subagent </span>}
                      <code>{c.name}</code>
                    </td>
                    <td className="snippet">{JSON.stringify(c.input).slice(0, 160)}</td>
                    <td className="snippet">{c.result ? (c.name === "Agent" ? handBack(out) : out).slice(0, 300) : "…"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {answer && <div className="card answer">{answer}</div>}
      {result && (
        <div className="card">
          <b>result/{result.subtype}</b> — {result.duration_ms} ms · {result.num_turns} turn(s) · total ${result.total_cost_usd.toFixed(4)}
          {result.permission_denials?.length > 0 && (
            <div className="snippet">permission_denials: {result.permission_denials.map((d: any) => d.tool_name).join(", ")}</div>
          )}
        </div>
      )}

      <h3>D · Reloading plugins in a live session</h3>
      <p className="hint">
        On a copy of atmira-ops in <code>plugins-lab/live-plugin</code>: the session opens, a command and an agent are written into the plugin,{" "}
        <code>q.reloadPlugins()</code> picks them up, the new command runs, and then a second server is added to <code>.mcp.json</code>.
      </p>
      <div className="row">
        <button className="primary" onClick={reload} disabled={!!busy}>
          {busy === "reload" ? `Running… ${elapsed} s` : "Run the reload demo"}
        </button>
      </div>
      {steps.length > 0 && (
        <table className="tools">
          <thead>
            <tr>
              <th>step</th>
              <th>plugin commands</th>
              <th>plugin agents</th>
              <th>other</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.step}>
                <td>{s.step}</td>
                <td className="snippet">{s.commands?.join("\n")}</td>
                <td className="snippet">{s.agents?.join("\n")}</td>
                <td className="snippet">
                  {s.held !== undefined && `held: ${s.held}\n`}
                  {s.error_count !== undefined && `error_count: ${s.error_count}\n`}
                  {s.mcpServers && `mcpServers: ${s.mcpServers.join(", ")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {reloadAnswer && <div className="card answer">{reloadAnswer}</div>}

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
      <MessageLog messages={messages.length ? messages : reloadMessages} />
    </section>
  );
}
