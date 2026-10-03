import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

// Must match HARNESSES in server/concepts/24-harnesses.ts.
const harnesses = [
  { id: "manual", title: "1 · Manual loop", pkg: "@anthropic-ai/sdk · messages.create()" },
  { id: "runner", title: "2 · Tool Runner", pkg: "@anthropic-ai/sdk · beta.messages.toolRunner()" },
  { id: "sdk", title: "3 · Agent SDK", pkg: "@anthropic-ai/claude-agent-sdk · query()" },
] as const;
type HarnessId = (typeof harnesses)[number]["id"];

// Must match the switches read in POST /run.
const switchInfo = [
  { name: "gate", label: "approval policy", does: "reserve_stock over 5 units is denied. Each harness puts the check in a different place" },
  { name: "limit", label: "limit: 2 model calls", does: "manual: your counter · runner: max_iterations · sdk: maxTurns" },
  { name: "claudeCode", label: "Claude Code preset (sdk only)", does: "the SDK harness gets Claude Code's system prompt and built-in tools (Read, Grep…); the other two can't" },
];

type Form = { prompt: string; switches: string[] };
const scenarios: { label: string; hint: string; form: Form }[] = [
  {
    label: "1 · Two tools in a row",
    hint: "search_products, then get_stock with the sku it found: two or three model calls in every harness. Compare the tokens: the three send the same system prompt and tools, so the numbers should be close.",
    form: { prompt: "Which keyboards do we sell, and how many are in stock in Madrid?", switches: [] },
  },
  {
    label: "2 · Parallel calls",
    hint: "One response can hold several tool_use blocks. The manual loop has to run all of them and send ALL the results in ONE user message; the runner and the SDK do it for you.",
    form: { prompt: "Give me the stock of every headset and every monitor we sell.", switches: [] },
  },
  {
    label: "3 · A tool throws",
    hint: "get_stock throws for an unknown sku. Manual: your try/catch builds the is_error result. Runner: it catches the throw and sends 'Error: …'. SDK: the handler returns isError. The model reads the error and answers.",
    form: { prompt: "How many units of ZZ-999 are in stock?", switches: [] },
  },
  {
    label: "4 · A write, no policy",
    hint: "reserve_stock changes the (per-run) catalog. With no policy, all three reserve 10 mice. In the SDK, reserve_stock is not in allowedTools, so canUseTool is asked and allows it.",
    form: { prompt: "Reserve 10 wireless mice (MS-202) from Madrid for order 5512.", switches: [] },
  },
  {
    label: "5 · The same write, with a policy",
    hint: "The same prompt with the approval policy. Manual: an if before running the tool. Runner: throw ToolError inside run(). SDK: canUseTool returns { behavior: 'deny' }. The model gets the reason in every case.",
    form: { prompt: "Reserve 10 wireless mice (MS-202) from Madrid for order 5512.", switches: ["gate"] },
  },
  {
    label: "6 · Turn limit",
    hint: "At most 2 model calls. Each harness stops in its own way: your counter, max_iterations (the last message still has stop_reason tool_use), or result subtype error_max_turns. None of them gets to answer.",
    form: { prompt: "Check the stock of KB-101, then MS-202, then HS-303, then MN-404, one at a time, and sum them.", switches: ["limit"] },
  },
  {
    label: "7 · Claude Code's tools",
    hint: "Only the SDK harness has built-in tools: with the preset it reads harness-lab/docs/returns-policy.md with Glob/Grep/Read. The other two have only the shop tools and must say they don't know. Look at the SDK's input tokens: the preset is much bigger.",
    form: { prompt: "Our returns policy is a file in the docs folder: read it and tell me the rule for headsets. Also: is HS-303 in stock in Madrid?", switches: ["claudeCode"] },
  },
  {
    label: "8 · No tool needed",
    hint: "One model call each. The difference in tokens is the harness itself: its system prompt and its tool list. Try it again with the Claude Code preset on.",
    form: { prompt: "Say hello in five words.", switches: [] },
  },
];

type Step =
  | { kind: "response"; n: number; stop_reason: string | null; text: string; tool_uses: { name: string; input: unknown }[]; usage: any; inferred?: boolean }
  | { kind: "tool"; name: string; input: unknown; content: string; is_error: boolean; denied?: boolean; builtin?: boolean }
  | { kind: "init"; tools: string[]; model: string; permissionMode: string }
  | { kind: "thrown"; message: string };
type Summary = {
  turns: number;
  toolCalls: number;
  totals: { input: number; output: number; cacheWrite: number; cacheRead: number };
  cost: number;
  stop: string;
  answer: string;
  duration_ms: number;
  sdk?: { num_turns: number; resultUsageInput: number; resultUsageOutput: number };
};
type Lane = { steps: Step[]; summary?: Summary; context?: { owner: string; messages: unknown[] | null }; options?: unknown; error?: string; busy: boolean };
const emptyLane = (): Lane => ({ steps: [], busy: false });

// Part C: where each responsibility lives. The file references point at server/concepts/24-harnesses.ts.
const duties: [string, string, string, string][] = [
  ["Send the request, read stop_reason", "while loop + messages.create()", "the runner (for await)", "Claude Code"],
  ["Hold the conversation", "your messages array", "runner.params.messages", "the Claude Code process (sessions, resume)"],
  ["Tool schema", "z.toJSONSchema() by hand", "betaZodTool (from zod)", "tool() (from a zod shape)"],
  ["Validate the tool input", "schema.safeParse()", "the runner (zod parse)", "the MCP server (zod)"],
  ["Run the tools, send results", "your for loop, one user message", "the runner", "Claude Code"],
  ["A tool fails", "your try/catch → is_error", "the runner catches → is_error", "handler returns isError"],
  ["Approval / permissions", "an if before running", "inside run(): throw ToolError", "allowedTools + canUseTool (+ hooks, modes)"],
  ["Stop after N calls", "your counter", "max_iterations", "maxTurns → error_max_turns"],
  ["Cost", "you multiply usage by prices", "you multiply usage by prices", "total_cost_usd, modelUsage"],
  ["Built-in tools", "none", "none (server tools you add)", "Read, Edit, Bash, Grep, WebFetch, Agent…"],
  ["Context full", "your problem", "compaction (beta)", "auto-compaction"],
  ["Hooks, skills, subagents, MCP, plugins", "—", "—", "Concepts 7, 8, 11, 13, 20, 23"],
  ["Where it runs", "your process", "your process", "a Claude Code child process"],
];

const short = (v: unknown, n = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** The model answers in Markdown: show **bold** as bold, and keep the rest as text (the boxes keep line breaks). */
function Md({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}
    </>
  );
}

/**
 * The Agent SDK streams one assistant message per content block, all with the same id: merge them into one row.
 * Its messages carry stop_reason: null, so the row shows the stop reason the blocks imply, marked as inferred.
 */
function addStep(steps: Step[], step: Step): Step[] {
  const last = steps[steps.length - 1];
  let row = step;
  if (step.kind === "response" && last?.kind === "response" && last.n === step.n) {
    row = { ...last, text: [last.text, step.text].filter(Boolean).join("\n"), tool_uses: [...last.tool_uses, ...step.tool_uses], stop_reason: step.stop_reason ?? last.stop_reason };
    steps = steps.slice(0, -1);
  }
  if (row.kind === "response" && (!row.stop_reason || row.inferred)) row = { ...row, stop_reason: row.tool_uses.length ? "tool_use" : "end_turn", inferred: true };
  return [...steps, row];
}

/** `hideFinalText`: the answer box below already shows the last model call's text. */
function Timeline({ steps, hideFinalText }: { steps: Step[]; hideFinalText: boolean }) {
  const lastResponse = steps.map((s) => s.kind).lastIndexOf("response");
  return (
    <div>
      {steps.map((s, i) => {
        if (s.kind === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">init</span> {s.tools.length} tools: <span className="snippet">{short(s.tools.join(", "), 220)}</span>
            </div>
          );
        if (s.kind === "thrown")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">query() threw</span> <span className="snippet">{s.message}</span>
            </div>
          );
        if (s.kind === "response")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">model call {s.n}</span>
              {s.stop_reason && (
                <span className="subtype" title={s.inferred ? "The Agent SDK streams stop_reason: null. Inferred from the blocks." : undefined}>
                  {s.stop_reason}
                  {s.inferred && " (inferred)"}
                </span>
              )}
              {/* The model writes its text first, then the tool calls. */}
              {s.text && !(hideFinalText && i === lastResponse) && (
                <div className="snippet">
                  <Md text={short(s.text, 200)} />
                </div>
              )}
              {s.tool_uses.map((t, j) => (
                <div key={j} className="snippet">
                  → {t.name} {short(t.input, 80)}
                </div>
              ))}
            </div>
          );
        return (
          <div key={i} className={`tool-call ${s.is_error ? "denied" : ""}`}>
            <span className={`tag ${s.denied ? "tag-error" : "tag-user"}`}>{s.denied ? "denied" : s.is_error ? "tool error" : "tool ran"}</span> <code>{s.name}</code>
            {s.builtin && <span className="subtype">built-in, run by Claude Code</span>}
            <div className="snippet">{short(s.content, 160)}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Concept24Harnesses() {
  const [tools, setTools] = useState<any>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(scenarios[0].form);
  const [hint, setHint] = useState(scenarios[0].hint);
  const [lanes, setLanes] = useState<Record<HarnessId, Lane>>({ manual: emptyLane(), runner: emptyLane(), sdk: emptyLane() });
  const [controller, setController] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = () => setError("Could not reach /api/c24 — is this sample's server running on port 3001?");
    fetch("/api/c24/tools")
      .then((r) => r.json())
      .then(setTools)
      .catch(fail);
    fetch("/api/c24/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(fail);
  }, []);

  const busy = Object.values(lanes).some((l) => l.busy);
  const toggle = (s: string) => setForm({ ...form, switches: form.switches.includes(s) ? form.switches.filter((x) => x !== s) : [...form.switches, s] });
  const update = (id: HarnessId, change: (l: Lane) => Lane) => setLanes((prev) => ({ ...prev, [id]: change(prev[id]) }));

  async function runOne(id: HarnessId, signal: AbortSignal) {
    try {
      await streamPost(
        "/api/c24/run",
        { harness: id, prompt: form.prompt, switches: form.switches },
        (event, data) => {
          if (event === "step") update(id, (l) => ({ ...l, steps: addStep(l.steps, data) }));
          if (event === "summary") update(id, (l) => ({ ...l, summary: data }));
          if (event === "context") update(id, (l) => ({ ...l, context: data }));
          if (event === "options") update(id, (l) => ({ ...l, options: data }));
          if (event === "error") update(id, (l) => ({ ...l, error: data.message }));
        },
        signal,
      );
    } catch (err) {
      update(id, (l) => ({ ...l, error: signal.aborted ? "Stopped from the browser." : String(err) }));
    } finally {
      update(id, (l) => ({ ...l, busy: false }));
    }
  }

  async function runAll() {
    setError(null);
    const ctrl = new AbortController();
    setController(ctrl);
    setLanes({ manual: { ...emptyLane(), busy: true }, runner: { ...emptyLane(), busy: true }, sdk: { ...emptyLane(), busy: true } });
    // Three requests at the same time: the three harnesses race on the same prompt.
    await Promise.all(harnesses.map((h) => runOne(h.id, ctrl.signal)));
    setController(null);
  }

  const done = harnesses.filter((h) => lanes[h.id].summary);

  return (
    <section>
      <h2>24 · Harnesses</h2>
      <p className="lead">
        A model answers one request. The <b>harness</b> is everything around it that makes an agent: the loop, running tools, errors, limits, permissions,
        the conversation. Here the <b>same tools and prompt</b> run in three harnesses: a loop you write on the Claude API, the API SDK's Tool Runner, and
        the Agent SDK, where Claude Code is the harness. All three use Haiku 4.5 and the same short system prompt.
      </p>

      <h3>A · One tool, three shapes, and the code you write</h3>
      <p className="hint">
        The tools are written once in <code>SHOP_TOOLS</code> (a zod schema and a function). Each harness wants them in its own shape. The buttons
        below show each harness's code from <code>server/concepts/24-harnesses.ts</code>: in the manual loop it is agent logic, in the Agent SDK it is
        mostly configuration.
      </p>
      {tools && (
        <div className="compare-grid">
          <div className="card">
            <b>manual</b> <span className="subtype">Anthropic.Tool</span>
            <p className="hint">Only data, sent as-is in the tools list. Finding, validating and running the function is your code.</p>
            <pre className="wrap">{JSON.stringify(tools.manual, null, 2)}</pre>
          </div>
          <div className="card">
            <b>runner</b> <span className="subtype">betaZodTool()</span>
            <p className="hint">The same data plus run and parse. The runner sends the data and keeps the functions to call them.</p>
            <pre className="wrap">{JSON.stringify(tools.runner, null, 2)}</pre>
          </div>
          <div className="card">
            <b>sdk</b> <span className="subtype">tool() in createSdkMcpServer()</span>
            <p className="hint">An MCP tool. Claude Code lists it to the model as mcp__shop__reserve_stock and calls your handler.</p>
            <pre className="wrap">{JSON.stringify(tools.sdk, null, 2)}</pre>
          </div>
        </div>
      )}
      <div className="row">
        {["tools", "manual", "runner", "sdk"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                {r === "tools" ? "shared tools" : `${r} harness`}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>B · The same prompt in the three harnesses</h3>
      <div className="scenarios">
        {scenarios.map((s) => (
          <button
            key={s.label}
            disabled={busy}
            onClick={() => {
              setForm(s.form);
              setHint(s.hint);
            }}
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
            <input type="checkbox" checked={form.switches.includes(s.name)} onChange={() => toggle(s.name)} /> <code>{s.label}</code>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={runAll} disabled={busy || !form.prompt.trim()}>
          {busy ? "Running…" : "Run the three harnesses"}
        </button>
        {busy && <button onClick={() => controller?.abort()}>Stop</button>}
      </div>

      <div className="compare-grid">
        {harnesses.map((h) => {
          const lane = lanes[h.id];
          return (
            <div key={h.id} className="card">
              <b>{h.title}</b>
              <div className="subtype">{h.pkg}</div>
              {lane.busy && lane.steps.length === 0 && <div className="hint">waiting for the first response…</div>}
              <Timeline steps={lane.steps} hideFinalText={!!lane.summary?.answer} />
              {lane.summary && (
                <>
                  {lane.summary.answer && (
                    <div className="answer thin">
                      <Md text={lane.summary.answer} />
                    </div>
                  )}
                  <div className="snippet">stopped by: {lane.summary.stop}</div>
                </>
              )}
              {lane.error && <div className="snippet">⚠ {lane.error}</div>}
              {lane.context && (
                <details>
                  <summary className="subtype">conversation held by: {lane.context.owner}</summary>
                  {lane.context.messages ? <pre className="wrap">{JSON.stringify(lane.context.messages, null, 2)}</pre> : <p className="hint">Your code never sees it: ask the session (Concepts 6, 19).</p>}
                </details>
              )}
              {lane.options !== undefined && (
                <details>
                  <summary className="subtype">options sent to query()</summary>
                  <pre className="wrap">{JSON.stringify(lane.options, null, 2)}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {done.length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th></th>
              {done.map((h) => (
                <th key={h.id}>{h.title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["model calls", (s: Summary) => s.turns],
                ["tool calls", (s: Summary) => s.toolCalls],
                ["input tokens", (s: Summary) => s.totals.input.toLocaleString()],
                ["cache write / read", (s: Summary) => `${s.totals.cacheWrite.toLocaleString()} / ${s.totals.cacheRead.toLocaleString()}`],
                ["output tokens", (s: Summary) => s.totals.output.toLocaleString()],
                ["cost", (s: Summary) => `$${s.cost.toFixed(4)}`],
                ["time", (s: Summary) => `${(s.duration_ms / 1000).toFixed(1)} s`],
                ["stopped by", (s: Summary) => s.stop],
                ["SDK: num_turns / result.usage in·out", (s: Summary) => (s.sdk ? `${s.sdk.num_turns} / ${s.sdk.resultUsageInput.toLocaleString()} · ${s.sdk.resultUsageOutput}` : "—")],
              ] as [string, (s: Summary) => string | number][]
            ).map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                {done.map((h) => (
                  <td key={h.id}>{value(lanes[h.id].summary!)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>C · Who does what</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>job</th>
            <th>manual loop</th>
            <th>Tool Runner</th>
            <th>Agent SDK</th>
          </tr>
        </thead>
        <tbody>
          {duties.map(([job, ...cells]) => (
            <tr key={job}>
              <td>{job}</td>
              {cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
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
