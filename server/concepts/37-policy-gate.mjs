/**
 * CONCEPT 37 — an EXTERNAL permission prompt tool: a policy gate as a stdio MCP server
 *
 * This file is NOT imported by the lab's server. Claude Code starts it as a child process, because a query() lists it
 * in `mcpServers` and names its tool in `permissionPromptToolName`:
 *
 *   mcpServers: { gate: { type: "stdio", command: process.execPath, args: ["37-policy-gate.mjs"], env: { GATE_POLICY } } }
 *   permissionPromptToolName: "mcp__gate__approve"
 *
 * Each time Claude Code would ask "may this tool call run?", it calls `approve` with { tool_name, input, tool_use_id }
 * and reads the answer from the text of the result: a JSON PermissionResult, { behavior: "allow", updatedInput } or
 * { behavior: "deny", message }. The model never sees this tool.
 *
 * The policy comes from GATE_POLICY (JSON): the first rule that matches decides, else `default`.
 *   { "default": "deny", "rules": [{ "tool": "Bash", "match": "^mkdir ", "decision": "allow", "message"?: "…" }] }
 * `match` is a regular expression tested on the command (Bash) or the file_path (Write, Edit, Read…).
 *
 * stdout belongs to the MCP protocol: never console.log() here. Each decision is POSTed to the lab (GATE_LOG_URL) so
 * the tab can show it, with this process's pid.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const policy = JSON.parse(process.env.GATE_POLICY ?? '{"default":"deny","rules":[]}');
const rules = policy.rules.map((r) => ({ ...r, re: r.match ? new RegExp(r.match) : null }));

/** Fire-and-forget: the lab's tab shows these lines as "policy gate" rows. */
function log(entry) {
  if (!process.env.GATE_LOG_URL) return;
  fetch(process.env.GATE_LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run: process.env.GATE_RUN, token: process.env.GATE_TOKEN, pid: process.pid, ...entry }),
  }).catch(() => {});
}

/** What a rule's `match` is tested on. */
const subjectOf = (tool, input) => String((tool === "Bash" ? input.command : (input.file_path ?? input.path ?? input.pattern)) ?? "");

function decide(tool, input) {
  const subject = subjectOf(tool, input);
  for (const [i, r] of rules.entries()) {
    if (r.tool !== "*" && r.tool !== tool) continue;
    if (r.re && !r.re.test(subject)) continue;
    const result = r.decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r.message ?? `policy-gate: rule ${i + 1} denies this ${tool} call.` };
    return { rule: i + 1, subject, result };
  }
  const result = policy.default === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `policy-gate: no rule allows this ${tool} call.` };
  return { rule: null, subject, result };
}

const server = new McpServer({ name: "policy-gate", version: "1.0.0" });

server.registerTool(
  "approve",
  {
    description: "Decides whether a tool call may run. Called by Claude Code, never by the model.",
    inputSchema: { tool_name: z.string(), input: z.looseObject({}), tool_use_id: z.string().optional() },
  },
  async ({ tool_name, input, tool_use_id }) => {
    const d = decide(tool_name, input);
    log({ event: "decision", tool_name, tool_use_id, subject: d.subject, rule: d.rule, result: d.result });
    return { content: [{ type: "text", text: JSON.stringify(d.result) }] };
  },
);

await server.connect(new StdioServerTransport());
log({ event: "started", rules: rules.length, default: policy.default });
