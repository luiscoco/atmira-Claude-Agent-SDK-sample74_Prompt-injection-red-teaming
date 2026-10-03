import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const scenarios = ["compatible", "removed-export", "stream-change", "permission-drift", "quality-regression", "missing-evidence"] as const;
export type Scenario = typeof scenarios[number];
export type Gate = { name: string; passed: boolean; evidence: string; recovery: string };
type Metrics = { correctness: number; costUsd: number; latencyMs: number };
export const baseline: Metrics = { correctness: 0.95, costUsd: 0.02, latencyMs: 1000 };
export const limits = { maxQualityDrop: 0.02, maxCostIncrease: 0.2, maxLatencyIncrease: 0.25 };
export const requiredExports = ["query", "tool", "createSdkMcpServer"];

// Application adapter: ignore additive events, but require a recognized successful terminal result.
// These are synthetic records, not captured SDK traffic or a claim about any particular release.
export function inspectStream(messages: unknown[]) {
  let answer = "", terminal = false;
  const unknownTypes: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    if (message.type === "result") {
      terminal = message.subtype === "success" && message.is_error === false && typeof message.result === "string";
      answer = terminal ? message.result as string : "";
    } else if (!["system", "assistant", "user", "stream_event"].includes(String(message.type))) {
      unknownTypes.push(String(message.type));
    }
  }
  return { terminal, answer, unknownTypes };
}

export function compareMetrics(candidate: Metrics) {
  const valid = Object.values(candidate).every((n) => Number.isFinite(n) && n >= 0) && candidate.correctness <= 1;
  return valid && candidate.correctness + 1e-12 >= baseline.correctness - limits.maxQualityDrop
    && candidate.costUsd <= baseline.costUsd * (1 + limits.maxCostIncrease) + 1e-12
    && candidate.latencyMs <= baseline.latencyMs * (1 + limits.maxLatencyIncrease) + 1e-12;
}

export function runWorkshop(scenario: Scenario) {
  const exports = requiredExports.filter((name) => scenario !== "removed-export" || name !== "query");
  const messages = [
    { type: "system", subtype: "init" },
    { type: "future_notice", detail: "Additive metadata" },
    ...(scenario === "missing-evidence" ? [] : [{ type: "result", subtype: "success", is_error: false,
      ...(scenario === "stream-change" ? { answer: "SKU-101, SKU-104" } : { result: "SKU-101, SKU-104" }) }]),
  ];
  const stream = inspectStream(messages);
  // Exercise a boundary policy with the same negative request in both lanes.
  const expectedPermission = { tool: "Bash", input: "delete inventory", behavior: "deny" };
  const candidatePermission = { ...expectedPermission, behavior: scenario === "permission-drift" ? "allow" : "deny" };
  const metrics: Metrics | null = scenario === "missing-evidence" ? null : scenario === "quality-regression"
    ? { correctness: 0.88, costUsd: 0.03, latencyMs: 1500 }
    : { correctness: 0.95, costUsd: 0.021, latencyMs: 1100 };
  const gate = (name: string, passed: boolean, evidence: unknown, recovery: string): Gate => ({ name, passed, evidence: JSON.stringify(evidence), recovery });
  const gates = [
    gate("Public API contract", requiredExports.every((name) => exports.includes(name)), { required: requiredExports, candidate: exports }, "Review release notes and adapt imports; compile against the actual candidate package."),
    gate("Stream and task evidence", stream.terminal && stream.answer === "SKU-101, SKU-104", stream, "Inspect raw events; adapt the application boundary. Missing terminal evidence blocks promotion."),
    gate("Permission boundary", candidatePermission.behavior === expectedPermission.behavior, { baseline: expectedPermission, candidate: candidatePermission }, "Keep denied actions denied. Repeat actual permission, hook and MCP integration tests."),
    gate("Quality, cost and latency", metrics !== null && compareMetrics(metrics), { baseline, candidate: metrics, limits }, "Run repeated representative evals with the same model, prompt, tools and environment; investigate regressions."),
  ];
  return { scenario, mode: "synthetic-offline", gates, eligible: gates.every((row) => row.passed), messages, metrics,
    caveat: "Passing fixture gates permits only this simulation. Actual candidate installs, type checks, integration tests and repeated live evals are still required." };
}

export type ReleaseState = "baseline" | "canary" | "promoted" | "rolled-back";
export function transition(state: ReleaseState, action: "canary" | "promote" | "rollback", eligible: boolean): ReleaseState {
  if (action === "canary" && (state === "baseline" || state === "rolled-back") && eligible) return "canary";
  if (action === "promote" && state === "canary" && eligible) return "promoted";
  if (action === "rollback" && (state === "canary" || state === "promoted")) return "rolled-back";
  throw new Error("Transition blocked: pass gates before canary; promote from canary; roll back only an active candidate.");
}

export async function inventory() {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const lockBytes = readFileSync(new URL("../../package-lock.json", import.meta.url));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const require = createRequire(import.meta.url);
  const packages = ["@anthropic-ai/claude-agent-sdk", "claude-agent-sdk-v2"].map((name) => {
    let installed: string | null = null;
    // package.json is not an exported subpath in these SDKs. Resolve the public entry first.
    try { installed = JSON.parse(readFileSync(join(dirname(require.resolve(name)), "package.json"), "utf8")).version; } catch { /* Missing installations remain visible. */ }
    const declared = manifest.dependencies[name];
    const locked = lock.packages[`node_modules/${name}`]?.version ?? null;
    return { name, declared, locked, installed, matchesLock: installed !== null && installed === locked,
      exactPin: /^(?:npm:@anthropic-ai\/claude-agent-sdk@)?\d+\.\d+\.\d+$/.test(declared) };
  });
  let exports: Record<string, boolean> = {}, importError: string | null = null;
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    exports = Object.fromEntries(requiredExports.map((name) => [name, typeof (sdk as Record<string, unknown>)[name] === "function"]));
  } catch { importError = "Installed SDK could not be imported. Run npm ci and inspect local installation errors."; }
  return { packages, runtime: { node: process.version, platform: process.platform, arch: process.arch },
    lockSha256: createHash("sha256").update(lockBytes).digest("hex"), exports, importError,
    scope: "Read-only local inspection and module import. No query(), Claude process, model call or dependency mutation." };
}
