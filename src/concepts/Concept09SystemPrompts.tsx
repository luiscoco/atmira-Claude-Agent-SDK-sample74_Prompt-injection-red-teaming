import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";
import { MessageLog } from "../components/MessageLog";

const variants = [
  { id: "omitted", label: "omitted", shape: "(no systemPrompt)" },
  { id: "custom", label: "string", shape: 'systemPrompt: "..."' },
  { id: "blocks", label: "string[] + boundary", shape: "[static, BOUNDARY, dynamic]" },
  { id: "preset", label: "preset", shape: '{ preset: "claude_code" }' },
  { id: "append", label: "preset + append", shape: '{ preset: "claude_code", append }' },
  { id: "claudeMd", label: "preset + CLAUDE.md", shape: 'settingSources: ["project"], cwd' },
] as const;

type VariantId = (typeof variants)[number]["id"];
type Run = { options?: any; messages: any[]; error?: string; running: boolean };

export function Concept09SystemPrompts() {
  const [prompt, setPrompt] = useState("Who are you, who am I, and which rules do you follow? Two sentences max.");
  const [customPrompt, setCustomPrompt] = useState("You are Pip, a pirate parrot. Answer in at most two short sentences, squawking like a parrot.");
  const [appendText, setAppendText] = useState("Always end your answer with the word ARRR.");
  const [userName, setUserName] = useState("Luis");
  const [selected, setSelected] = useState<VariantId[]>(variants.map((v) => v.id));
  const [runs, setRuns] = useState<Partial<Record<VariantId, Run>>>({});
  const [claudeMd, setClaudeMd] = useState("");

  useEffect(() => {
    fetch("/api/c9/claude-md").then((r) => r.text()).then(setClaudeMd);
  }, []);

  const running = Object.values(runs).some((r) => r?.running);

  function toggle(id: VariantId) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  function update(id: VariantId, change: (run: Run) => Run) {
    setRuns((prev) => ({ ...prev, [id]: change(prev[id] ?? { messages: [], running: false }) }));
  }

  async function runOne(variant: VariantId) {
    update(variant, () => ({ messages: [], running: true }));
    try {
      await streamPost("/api/c9/query", { prompt, variant, customPrompt, appendText, userName }, (event, data) => {
        if (event === "options") update(variant, (r) => ({ ...r, options: data }));
        if (event === "message") update(variant, (r) => ({ ...r, messages: [...r.messages, data] }));
        if (event === "error") update(variant, (r) => ({ ...r, error: data.message }));
      });
    } finally {
      update(variant, (r) => ({ ...r, running: false }));
    }
  }

  function runAll() {
    setRuns({});
    // Same user prompt, one query() per variant, all at once.
    selected.forEach(runOne);
  }

  return (
    <section>
      <h2>9 · System prompts</h2>
      <p className="lead">
        The same user prompt behaves very differently depending on <code>systemPrompt</code> and{" "}
        <code>settingSources</code>. Run the variants side by side and compare the <b>answers</b> and the{" "}
        <b>prompt tokens</b> each system prompt costs.
      </p>

      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} disabled={running} />

      <table className="tools">
        <thead>
          <tr>
            <th />
            <th>Variant</th>
            <th>Shape sent to query()</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr key={v.id}>
              <td>
                <input type="checkbox" checked={selected.includes(v.id)} onChange={() => toggle(v.id)} disabled={running} />
              </td>
              <td>{v.label}</td>
              <td>
                <code>{v.shape}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form-grid">
        <label>
          <b>string</b>: custom system prompt
          <textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} rows={3} disabled={running} />
        </label>
        <label>
          <b>preset + append</b>: extra rules
          <textarea value={appendText} onChange={(e) => setAppendText(e.target.value)} rows={3} disabled={running} />
        </label>
        <label>
          <b>string[]</b>: user name (goes after the boundary)
          <input value={userName} onChange={(e) => setUserName(e.target.value)} disabled={running} />
        </label>
      </div>

      <details className="card">
        <summary>
          <b>claude-md-project/CLAUDE.md</b> (loaded only by <i>preset + CLAUDE.md</i>)
        </summary>
        <pre>{claudeMd}</pre>
      </details>

      <button onClick={runAll} disabled={running || !prompt.trim() || selected.length === 0}>
        {running ? "Running…" : `Run ${selected.length} variant(s) in parallel`}
      </button>

      {Object.keys(runs).length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th>Variant</th>
              <th>Answer</th>
              <th>Prompt tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {variants
              .filter((v) => runs[v.id])
              .map((v) => {
                const run = runs[v.id]!;
                const result = run.messages.find((m) => m.type === "result");
                const text = run.messages
                  .filter((m) => m.type === "assistant")
                  .flatMap((m) => m.message.content)
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n");
                // Everything the model read before answering: fresh + cache-written + cache-read tokens.
                const u = result?.usage;
                const promptTokens = u && u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
                return (
                  <tr key={v.id}>
                    <td>{v.label}</td>
                    <td className="snippet">{run.error ? `⚠ ${run.error}` : text || (run.running ? "…" : "")}</td>
                    <td title={u && `input ${u.input_tokens} · cache write ${u.cache_creation_input_tokens} · cache read ${u.cache_read_input_tokens}`}>
                      {promptTokens?.toLocaleString() ?? ""}
                      {u?.cache_read_input_tokens > 0 && <div className="hint">{u.cache_read_input_tokens.toLocaleString()} from cache</div>}
                    </td>
                    <td>{result ? `$${result.total_cost_usd.toFixed(4)}` : ""}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}

      {variants
        .filter((v) => runs[v.id])
        .map((v) => {
          const run = runs[v.id]!;
          return (
            <details key={v.id} className="card">
              <summary>
                <b>{v.label}</b>: options sent to query() and raw messages
              </summary>
              {run.options && <pre>{JSON.stringify(run.options, null, 2)}</pre>}
              <MessageLog messages={run.messages} />
            </details>
          );
        })}
    </section>
  );
}
