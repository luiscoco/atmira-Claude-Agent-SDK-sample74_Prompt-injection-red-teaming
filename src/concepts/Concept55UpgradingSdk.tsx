import { useEffect, useRef, useState } from "react";
import type { Gate, ReleaseState, Scenario } from "../../server/upgrading/workshop";

type Facts = { inventory: { packages: { name: string; declared: string; locked: string | null; installed: string | null; matchesLock: boolean; exactPin: boolean }[]; runtime: { node: string; platform: string; arch: string }; lockSha256: string; exports: Record<string, boolean>; importError: string | null; scope: string }; scenarios: Scenario[] };
type Report = { scenario: Scenario; gates: Gate[]; eligible: boolean; messages: unknown[]; caveat: string };
const labels: Record<Scenario, string> = { compatible: "Compatible candidate", "removed-export": "Removed public export", "stream-change": "Changed result field", "permission-drift": "Permission became permissive", "quality-regression": "Quality, cost and latency regression", "missing-evidence": "Missing terminal result and evals" };

export function Concept55UpgradingSdk() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [scenario, setScenario] = useState<Scenario>("compatible");
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<ReleaseState>("baseline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch("/api/c55/facts", { signal: controller.signal }), fetch("/api/c55/code", { signal: controller.signal })]).then(async ([a, b]) => {
      if (!a.ok || !b.ok) throw new Error("Could not load lesson 55.");
      const [f, c] = await Promise.all([a.json(), b.json()]);
      if (!controller.signal.aborted) { setFacts(f); setCode(c); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [attempt]);
  async function request(action?: "canary" | "promote" | "rollback") {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/c55/${action ? "transition" : "run"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action ? { scenario, state, action } : { scenario }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted) { if (action) setState(result.state); else setReport(result); }
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); if (pending.current === controller) pending.current = null; }
  }
  return <section>
    <h2>55. Upgrading the SDK safely</h2>
    <p className="lead">Pin a reproducible baseline, test the candidate against your application's contracts, then rehearse promotion and rollback.</p>
    <div className="offline-boundaries">
      <div className="card"><b>Reproduce</b><p>Record SDK, bundled runtime, Node, model, prompt, tools and configuration. Commit the manifest and lockfile together.</p></div>
      <div className="card"><b>Compare</b><p>Type-check imports and options, test streams and denied actions, and repeat task evals with fixed inputs.</p></div>
      <div className="card"><b>Recover</b><p>Canary a known artifact, monitor quality and errors, and retain the previous artifact and compatible session data.</p></div>
    </div>
    {error && <div className="card warn" role="alert">{error}{!facts && <button onClick={() => setAttempt((n) => n + 1)}>Retry loading</button>}</div>}
    <h3>A · Inspect this installation</h3>
    <p>This inspection reads local package metadata and imports the SDK to check public exports. It does not start Claude or use a model API.</p>
    {facts && <>
      <div className="eval-table"><table><thead><tr><th>Package</th><th>Declared</th><th>Locked</th><th>Installed</th><th>Checks</th></tr></thead><tbody>{facts.inventory.packages.map((row) => <tr key={row.name}><td><code>{row.name}</code></td><td>{row.declared}</td><td>{row.locked ?? "Missing"}</td><td>{row.installed ?? "Unavailable"}</td><td>{row.exactPin ? "Exact pin" : "Version range"} · {row.matchesLock ? "Matches lock" : "Check installation"}</td></tr>)}</tbody></table></div>
      <p>Node {facts.inventory.runtime.node} · {facts.inventory.runtime.platform}/{facts.inventory.runtime.arch}</p>
      <details className="card"><summary>Lockfile fingerprint and installed export probe</summary><pre className="wrap">{JSON.stringify({ sha256: facts.inventory.lockSha256, exports: facts.inventory.exports, importError: facts.inventory.importError }, null, 2)}</pre></details>
    </>}
    <p>The <code>claude-agent-sdk-v2</code> alias supports lesson 41's historical API. Treat it as a separate dependency. Review all release notes between baseline and candidate, including bundled Claude runtime and peer dependency changes.</p>
    <h3>B · Run compatibility gates</h3>
    <p>These are synthetic failure drills, not a comparison of two installed SDK versions. The actual application adapter and gate evaluator execute offline. Unknown additive events are recorded; a missing or changed terminal result blocks promotion.</p>
    <label>Candidate scenario<select value={scenario} disabled={busy} onChange={(e) => { setScenario(e.target.value as Scenario); setReport(null); setState("baseline"); setError(""); }}>{(facts?.scenarios ?? Object.keys(labels) as Scenario[]).map((id) => <option key={id} value={id}>{labels[id]}</option>)}</select></label>
    <button className="primary" disabled={busy || !facts} onClick={() => request()}>{busy ? "Working…" : "Run offline gates"}</button>
    {report && <div aria-live="polite">
      <p><b>{report.eligible ? "Fixture gates passed · ready for simulated canary" : "Candidate blocked · retain the baseline"}</b></p>
      {report.gates.map((gate) => <details className="card" key={gate.name} open={!gate.passed}><summary>{gate.passed ? "PASS" : "FAIL"} · {gate.name}</summary><pre className="wrap">{JSON.stringify(JSON.parse(gate.evidence), null, 2)}</pre>{!gate.passed && <p>{gate.recovery}</p>}</details>)}
      <details className="card"><summary>Synthetic raw stream</summary><pre className="wrap">{JSON.stringify(report.messages, null, 2)}</pre></details>
      <p className="hint">{report.caveat}</p>
    </div>}
    <h3>C · Rehearse canary and rollback</h3>
    <p>State: <strong aria-live="polite">{state}</strong>. This exercise changes only browser state. Selecting a scenario resets the exercise. The server independently recomputes fixture eligibility for each transition.</p>
    <div className="row">
      <button disabled={busy || !report?.eligible || !["baseline", "rolled-back"].includes(state)} onClick={() => request("canary")}>Start simulated canary</button>
      <button disabled={busy || state !== "canary"} onClick={() => request("promote")}>Simulate promotion</button>
      <button disabled={busy || !["canary", "promoted"].includes(state)} onClick={() => request("rollback")}>Simulate rollback</button>
    </div>
    <p>A real canary needs representative traffic, a defined observation window and stop thresholds. Route new sessions by artifact version. Test resumption separately; newer transcripts may not be readable by an older runtime. Keep snapshots and avoid destructive data migrations until rollback compatibility is established.</p>
    <h3>D · Apply the workflow to a real upgrade</h3>
    <ol className="steps">
      <li>Save the known-good manifest, lockfile, application artifact and eval baseline. Record runtime and configuration without secrets.</li>
      <li>In an isolated branch or checkout, install an explicit candidate with <code>npm install --save-exact @anthropic-ai/claude-agent-sdk@&lt;candidate-version&gt;</code>. Review the lock diff and required peer dependencies.</li>
      <li>Run <code>npm ci</code>, <code>npm run typecheck</code>, <code>npm run test:offline</code> and <code>npm run build</code>. Exercise MCP, hooks, permissions, cancellation and session resumption with the actual candidate runtime.</li>
      <li>Use lesson 52 for repeated live correctness, cost and latency evals, and lesson 53 to inspect raw evidence. Keep model, prompt, tools and dataset fixed to isolate SDK changes.</li>
      <li>Canary the candidate artifact. Roll back on breached thresholds by redeploying the retained artifact. For a local dependency rollback, restore both known-good package files and run <code>npm ci</code>, then repeat checks.</li>
    </ol>
    <p>Type checks catch API changes, not model behavior or permission regressions. Exact pins and lockfiles reproduce dependencies; they do not freeze remote models, external tools or user settings. Specify systemPrompt and settingSources deliberately and verify their behavior for the selected release.</p>
    <h3>E · Read the implementation</h3>
    {Object.entries(code).map(([file, source]) => <details className="card" key={file}><summary>{file}</summary><pre className="wrap">{source}</pre></details>)}
    <p className="hint">References: <a href="https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Official SDK changelog</a> and <a href="https://code.claude.com/docs/en/agent-sdk/migration-guide" target="_blank" rel="noreferrer">migration guide</a>.</p>
  </section>;
}
