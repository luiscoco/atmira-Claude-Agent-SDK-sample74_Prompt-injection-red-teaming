/** Application-owned diagnostics; SDK events are evidence, diagnoses are hypotheses. */
export const scenarios = ["success", "denied", "missing", "max-turns", "startup", "api-error", "truncated"] as const;
export type Scenario = typeof scenarios[number];
export type TraceRow = { seq: number; elapsedMs: number; layer: "host" | "sdk" | "hook" | "permission" | "stderr"; kind: string; toolUseId?: string; data: unknown };
export type Finding = { title: string; evidence: number[]; next: string };
export type Bundle = { id: string; mode: "offline" | "live"; scenario: Scenario; startedAt: string; config: Record<string, unknown>; rows: TraceRow[]; findings: Finding[]; debugLog: string; limitations: string };

// Defence in depth for the browser/export. Raw CLI files remain local and may contain sensitive data.
export function redact(value: unknown): unknown {
  if (typeof value === "string") return value
    .replace(/sk-ant-[\w-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(authorization|x-api-key|api[_-]?key|access[_-]?token|password|secret)$/i.test(key) ? "[REDACTED]" : redact(item)]));
  return value;
}

export function createTrace(emit: (row: TraceRow) => void = () => {}) {
  const rows: TraceRow[] = [];
  const start = performance.now();
  return { rows, add(layer: TraceRow["layer"], kind: string, data: unknown, toolUseId?: string) {
    const row: TraceRow = { seq: rows.length + 1, elapsedMs: Math.round(performance.now() - start), layer, kind, data: redact(data), ...(toolUseId ? { toolUseId } : {}) };
    rows.push(row); emit(row); return row;
  } };
}

export function diagnose(rows: TraceRow[]): Finding[] {
  const findings: Finding[] = [];
  const find = (predicate: (r: TraceRow) => boolean) => rows.filter(predicate).map((r) => r.seq);
  const add = (title: string, evidence: number[], next: string) => { if (evidence.length) findings.push({ title, evidence, next }); };
  add("A tool was denied", find((r) => r.kind === "denied"), "Inspect the deciding hook or permission callback and its reason. Change only the rule required by the task; retry in a fresh run.");
  add("A tool failed; the run may still recover", find((r) => r.kind === "PostToolUseFailure" || r.kind === "tool-error"), "Match tool_use_id to the tool input and result. Check the path, cwd and error before editing the prompt.");
  add("Turn limit reached", find((r) => r.kind === "result" && (r.data as any)?.subtype === "error_max_turns"), "Check for repeated tool calls. Compare a bounded higher maxTurns run after resolving the underlying failure.");
  add("Model/API failure", find((r) => r.kind === "result" && (r.data as any)?.is_error && (r.data as any)?.subtype === "success"), "A success subtype alone is insufficient. Inspect errors, assistant error messages and stderr; check authentication or provider status.");
  add("The iterator threw", find((r) => r.kind === "exception"), "Use the earliest error plus stderr. If no init arrived, check process startup, executable, environment and cwd before model behaviour.");
  add("Host cancelled the run", find((r) => r.kind === "cancelled" || r.kind === "timeout"), "Identify whether the client disconnected or the host deadline expired. Partial output does not establish completion.");
  const results = rows.filter((r) => r.kind === "result");
  if (!results.length && !rows.some((r) => ["exception", "cancelled", "timeout"].includes(r.kind))) findings.push({ title: "Stream ended without a terminal result", evidence: find((r) => r.kind === "end"), next: "Treat the run as incomplete. Inspect process logs and transport; do not report partial text as success." });
  if (results.some((r) => (r.data as any)?.subtype === "success" && !(r.data as any)?.is_error)) findings.push({ title: "SDK reported completion", evidence: results.map((r) => r.seq), next: "Verify the answer against the tool evidence. Completion does not prove task correctness, and earlier tool failures may have recovered." });
  return findings;
}

/** Synthetic evidence feeds the same collector and diagnoses as the live run. No SDK is invoked. */
export function replay(scenario: Scenario, trace: ReturnType<typeof createTrace>) {
  const { add } = trace;
  add("host", "config", { cwd: "debug-lab/<run>/work", tools: ["Read"], maxTurns: scenario === "max-turns" ? 1 : 4, synthetic: true });
  if (scenario === "startup") {
    add("stderr", "chunk", "spawn node ENOENT"); add("host", "exception", { message: "Claude Code process could not start: ENOENT" });
  } else {
    add("sdk", "init", { type: "system", subtype: "init", session_id: "synthetic-session", model: "synthetic-model", tools: ["Read"] });
    if (scenario === "api-error") {
      add("stderr", "chunk", "authentication_error: API key sk-ant-demo-secret rejected");
      add("sdk", "result", { type: "result", subtype: "success", is_error: true, errors: ["authentication_error"], total_cost_usd: 0 });
      add("host", "exception", { message: "API request failed after retries" });
    } else if (scenario === "truncated") {
      add("sdk", "assistant", { type: "assistant", message: { content: [{ type: "text", text: "I will inspect the file…" }] } });
    } else {
      const id = "synthetic-read-1";
      add("sdk", "assistant", { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: scenario === "missing" ? "missing.txt" : "notes.txt" } }] } });
      add("hook", "PreToolUse", { tool_name: "Read", tool_use_id: id }, id);
      if (scenario === "denied") {
        add("hook", "denied", { reason: "Lab policy blocks Read", tool_use_id: id }, id);
        add("sdk", "tool-error", { tool_use_id: id, is_error: true, content: "Read denied by lab policy" }, id);
      } else {
        add("permission", "allowed", { tool_name: "Read", reason: "Exact lab fixture path" }, id);
        if (scenario === "missing") {
          add("hook", "PostToolUseFailure", { tool_name: "Read", error: "ENOENT: missing.txt" }, id);
          add("sdk", "tool-error", { tool_use_id: id, is_error: true, content: "File does not exist" }, id);
        } else {
          add("hook", "PostToolUse", { tool_name: "Read", tool_response: "Release: 53\nStatus: ready" }, id);
          add("sdk", "tool-result", { tool_use_id: id, content: "Release: 53\nStatus: ready" }, id);
        }
      }
      add("sdk", "assistant", { type: "assistant", message: { content: [{ type: "text", text: scenario === "success" ? "Release 53 is ready." : "I could not complete the requested file check." }] } });
      add("sdk", "result", { type: "result", subtype: scenario === "max-turns" ? "error_max_turns" : "success", is_error: scenario === "max-turns", session_id: "synthetic-session", total_cost_usd: 0, num_turns: 1 });
    }
  }
  add("host", "end", { synthetic: true });
}
