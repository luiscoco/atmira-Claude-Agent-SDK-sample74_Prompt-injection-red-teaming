import assert from "node:assert/strict";
import type { Options, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../capstone/store.js";
import { deskOptions, REFUND_LIMIT_CENTS, type Approver } from "../capstone/agent.js";
import { T } from "../capstone/tools.js";
import { fakeQuery } from "./fixtures.js";
import { runAgent } from "./host.js";
import { withDesk } from "./mcp.js";

export type Group = "tools" | "policy" | "streams";
export type TestCase = { id: string; group: Group; name: string; purpose: string; check: (mutation: boolean) => Promise<void> };
const refund = { order_id: "A-1001", amount_cents: 1800, reason: "One broken mug" };
const base = { session_id: "offline-session-51", transcript_path: "unused.jsonl", cwd: process.cwd() };
const signal = () => new AbortController().signal;

// #region policy-harness
async function withOptions(check: (options: Options, store: Store, approvals: string[]) => Promise<void>, allow = true) {
  const store = new Store();
  const approvals: string[] = [];
  const approver: Approver = async (request) => {
    approvals.push(request.toolUseId);
    return { allow, by: "unit-test approver", message: allow ? undefined : "Customer declined" };
  };
  const { options, setSession } = deskOptions({ store, customerId: "C-1", workspace: process.cwd(), approver, abort: new AbortController(), persist: false });
  setSession(base.session_id);
  try { await check(options, store, approvals); }
  finally {
    const server = options.mcpServers?.desk;
    if (server?.type === "sdk") await server.instance.close();
  }
}

// Invoke only the matching registered callback. This tests the function, NOT Claude Code's hook scheduling.
async function preTool(options: Options, tool: string, input: Record<string, unknown>, agent_id?: string) {
  const hookInput: PreToolUseHookInput = { ...base, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tool-51", ...(agent_id ? { agent_id } : {}) };
  const matcher = options.hooks?.PreToolUse?.find((m) => !m.matcher || new RegExp(m.matcher).test(tool));
  assert.ok(matcher, "Expected a registered matching hook");
  return await matcher.hooks[0](hookInput, hookInput.tool_use_id, { signal: signal() }) as SyncHookJSONOutput;
}
// #endregion

// #region cases
export const cases: TestCase[] = [
  { id: "tool-inventory", group: "tools", name: "Real MCP tool inventory", purpose: "The in-memory client discovers all five registered tools.", check: async () => {
    await withDesk(new Store(), "C-1", async (client) => {
      const list = await client.listTools();
      assert.deepEqual(list.tools.map((t) => t.name).sort(), ["create_ticket", "get_customer", "get_order", "issue_refund", "list_orders"]);
    });
  } },
  { id: "tenant-read", group: "tools", name: "Another customer's order stays private", purpose: "A direct real-tool call for B-2001 by C-1 returns isError.", check: async () => {
    await withDesk(new Store(), "C-1", async (client) => {
      const result = await client.callTool({ name: "get_order", arguments: { order_id: "B-2001" } });
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /espresso|49900|Ben Okafor/i);
    });
  } },
  { id: "refund-effect", group: "tools", name: "Refund writes cents and trusted attribution", purpose: "Assert the database effect and host-supplied approver, not the reply wording.", check: async () => {
    const store = new Store();
    await withDesk(store, "C-1", async (client) => {
      const result = await client.callTool({ name: "issue_refund", arguments: refund });
      assert.notEqual(result.isError, true);
      assert.equal(store.orderOf("C-1", "A-1001")!.refundedCents, 1800);
      assert.equal(store.data.refunds.length, 1);
      assert.equal(store.data.refunds[0].approvedBy, "unit-test approver");
      assert.equal(store.data.refunds[0].session, base.session_id);
    });
  } },
  { id: "refund-schema", group: "tools", name: "Invalid amounts fail schema validation", purpose: "Zero, negative, fractional and string amounts never write a refund.", check: async () => {
    const store = new Store();
    await withDesk(store, "C-1", async (client) => {
      for (const amount_cents of [0, -1, 1.5, "1800"]) {
        const result = await client.callTool({ name: "issue_refund", arguments: { ...refund, amount_cents } });
        assert.equal(result.isError, true);
      }
      assert.equal(store.data.refunds.length, 0);
    });
  } },
  { id: "refund-balance", group: "tools", name: "A second refund cannot exceed the remaining balance", purpose: "The tool re-checks state on every invocation.", check: async () => {
    const store = new Store();
    await withDesk(store, "C-1", async (client) => {
      await client.callTool({ name: "issue_refund", arguments: refund });
      const result = await client.callTool({ name: "issue_refund", arguments: { ...refund, amount_cents: 4000 } });
      assert.equal(result.isError, true);
      assert.equal(store.data.refunds.length, 1);
      assert.equal(store.orderOf("C-1", "A-1001")!.refundedCents, 1800);
    });
  } },
  { id: "tenant-write", group: "tools", name: "Another customer's refund is blocked", purpose: "The tool independently enforces tenant ownership, even without hooks.", check: async () => {
    const store = new Store();
    await withDesk(store, "C-1", async (client) => {
      const result = await client.callTool({ name: "issue_refund", arguments: { ...refund, order_id: "B-2001" } });
      assert.equal(result.isError, true);
      assert.equal(store.data.refunds.length, 0);
    });
  } },
  { id: "ticket-effect", group: "tools", name: "Escalation creates a tenant-scoped ticket", purpose: "Check priority, ownership and fresh-store isolation.", check: async () => {
    const store = new Store();
    await withDesk(store, "C-1", async (client) => {
      await client.callTool({ name: "create_ticket", arguments: { subject: "Supervisor needed", priority: "high", notes: "Refund above limit" } });
      assert.equal(store.data.tickets.length, 1);
      assert.equal(store.data.tickets[0].customerId, "C-1");
      assert.equal(store.data.tickets[0].priority, "high");
      assert.equal(new Store().data.tickets.length, 0);
    });
  } },
  { id: "guard-limit", group: "policy", name: "Refund guard enforces the $150 boundary", purpose: "Exactly the limit is allowed by the hook; one cent above is denied and audited.", check: async () => {
    await withOptions(async (options, store, approvals) => {
      // Give this fixture enough refundable balance to isolate the per-call limit.
      store.orderOf("C-1", "A-1001")!.totalCents = 20000;
      assert.deepEqual(await preTool(options, T.issueRefund, { ...refund, amount_cents: REFUND_LIMIT_CENTS }), {});
      const output = await preTool(options, T.issueRefund, { ...refund, amount_cents: REFUND_LIMIT_CENTS + 1 });
      assert.equal(output.hookSpecificOutput?.hookEventName, "PreToolUse");
      assert.ok(output.hookSpecificOutput && "permissionDecision" in output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(store.data.audit.at(-1)?.outcome, "blocked");
      assert.equal(approvals.length, 0);
    });
  } },
  { id: "guard-ownership", group: "policy", name: "Refund guard rejects foreign orders", purpose: "The hook's deny includes a reason and leaves business state untouched.", check: async () => {
    await withOptions(async (options, store) => {
      const output = await preTool(options, T.issueRefund, { ...refund, order_id: "B-2001" });
      assert.ok(output.hookSpecificOutput && "permissionDecision" in output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(store.data.refunds.length, 0);
    });
  } },
  { id: "caller-guard", group: "policy", name: "File reading depends on the caller", purpose: "Main-thread Read is denied; a subagent Read reaches the next policy layer.", check: async () => {
    await withOptions(async (options) => {
      const output = await preTool(options, "Read", { file_path: "policies/refunds.md" });
      assert.ok(output.hookSpecificOutput && "permissionDecision" in output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.deepEqual(await preTool(options, "Read", { file_path: "policies/refunds.md" }, "policy-agent"), {});
    });
  } },
  { id: "permission-default", group: "policy", name: "Unknown tools fail closed", purpose: "Bash is denied, a safe lookup is allowed, neither asks the approver.", check: async () => {
    await withOptions(async (options, _store, approvals) => {
      const context = { signal: signal(), toolUseID: "permission-51", requestId: "request-51" };
      const denied = await options.canUseTool!("Bash", { command: "echo unsafe" }, context);
      const allowed = await options.canUseTool!(T.getOrder, { order_id: "A-1001" }, context);
      assert.ok(denied);
      assert.ok(allowed);
      assert.equal(denied.behavior, "deny");
      assert.equal(allowed.behavior, "allow");
      assert.deepEqual(approvals, []);
    });
  } },
  ...([true, false] as const).map((allow): TestCase => ({
    id: allow ? "approval-allow" : "approval-deny", group: "policy", name: allow ? "Approval is attributed and audited" : "Denial is returned and audited",
    purpose: "Call the real canUseTool callback with a deterministic approver; it does not execute the tool.", check: async () => {
      await withOptions(async (options, store, approvals) => {
        const result = await options.canUseTool!(T.issueRefund, refund, { signal: signal(), toolUseID: "refund-51", requestId: "request-51" });
        assert.ok(result);
        assert.equal(result.behavior, allow ? "allow" : "deny");
        assert.deepEqual(approvals, ["refund-51"]);
        assert.equal(store.data.audit.at(-1)?.outcome, allow ? "approved" : "denied");
        assert.equal(store.data.audit.at(-1)?.session, base.session_id);
        assert.equal(store.data.refunds.length, 0);
      }, allow);
    },
  })),
  { id: "post-audit", group: "policy", name: "PostToolUse records error outcomes", purpose: "The audit callback classifies a failed tool response without a model.", check: async () => {
    await withOptions(async (options, store) => {
      await options.hooks!.PostToolUse![0].hooks[0]({ ...base, hook_event_name: "PostToolUse", tool_name: T.getOrder, tool_input: {}, tool_use_id: "bad-order", tool_response: { isError: true } }, "bad-order", { signal: signal() });
      assert.equal(store.data.audit.at(-1)?.outcome, "error");
      assert.equal(store.data.audit.at(-1)?.tool, T.getOrder);
    });
  } },
  { id: "stream-text", group: "streams", name: "Streamed text is not duplicated", purpose: "Deltas, complete assistant message and terminal result yield one answer.", check: async (mutation) => {
    const deltas: string[] = [];
    const result = await runAgent(fakeQuery("success"), { prompt: "Refund one mug" }, (text) => deltas.push(text), mutation);
    assert.equal(result.status, "success");
    assert.equal(result.text, "Refund approved.");
    assert.deepEqual(deltas, ["Refund ", "approved."]);
    assert.deepEqual(result.summary, { resolution: "resolved", refundCents: 1800 });
    assert.equal(result.costUsd, 0);
  } },
  { id: "complete-text", group: "streams", name: "Non-streaming replies still work", purpose: "A complete assistant message and result do not duplicate the answer.", check: async () => {
    assert.equal((await runAgent(fakeQuery("complete"), { prompt: "Hello" })).text, "Refund approved.");
  } },
  { id: "subagent-text", group: "streams", name: "Subagent deltas stay out of the customer reply", purpose: "parent_tool_use_id identifies internal subagent output.", check: async () => {
    const deltas: string[] = [];
    await runAgent(fakeQuery("subagent"), { prompt: "Hello" }, (text) => deltas.push(text));
    assert.deepEqual(deltas, ["Refund ", "approved."]);
  } },
  { id: "budget-result", group: "streams", name: "Budget result is a failure", purpose: "error_max_budget_usd must not look like success.", check: async () => {
    const result = await runAgent(fakeQuery("budget"), { prompt: "Hello" });
    assert.equal(result.status, "error_max_budget_usd");
    assert.match(result.error!, /Budget exceeded/);
  } },
  { id: "success-error", group: "streams", name: "Success subtype with is_error is a failure", purpose: "Inspect is_error as well as subtype.", check: async () => {
    assert.equal((await runAgent(fakeQuery("apiError"), { prompt: "Hello" })).status, "error");
  } },
  { id: "iterator-throw", group: "streams", name: "Iterator exceptions become host errors", purpose: "A synthetic transport failure reaches the caller.", check: async () => {
    const result = await runAgent(fakeQuery("throw"), { prompt: "Hello" });
    assert.equal(result.status, "error");
    assert.match(result.error!, /Synthetic transport failure/);
  } },
  { id: "missing-result", group: "streams", name: "An ended stream is not automatically successful", purpose: "A truncated fixture preserves partial text and reports incomplete.", check: async () => {
    const result = await runAgent(fakeQuery("truncated"), { prompt: "Hello" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.text, "Partial answer");
  } },
  { id: "structured-schema", group: "streams", name: "Structured output is validated at the boundary", purpose: "Invalid enum values and negative refunds cannot become a typed summary.", check: async () => {
    const result = await runAgent(fakeQuery("invalid"), { prompt: "Hello" });
    assert.equal(result.status, "error");
    assert.equal(result.summary, undefined);
  } },
  { id: "resume-forward", group: "streams", name: "Resume and prompt reach the query dependency", purpose: "A spy records host arguments without starting a process.", check: async () => {
    const seen: Array<{ prompt: string; resume?: string }> = [];
    await runAgent(fakeQuery("success", seen), { prompt: "Continue", resume: "prior-session" });
    assert.deepEqual(seen, [{ prompt: "Continue", resume: "prior-session" }]);
  } },
  { id: "already-aborted", group: "streams", name: "Pre-cancelled runs never call the query dependency", purpose: "Cancellation is checked before invoking even the fake query.", check: async () => {
    const abort = new AbortController();
    abort.abort(new Error("Stopped by user"));
    let calls = 0;
    const result = await runAgent((request) => { calls++; return fakeQuery("success")(request); }, { prompt: "Hello", signal: abort.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(calls, 0);
  } },
  { id: "cancel-wait", group: "streams", name: "Cancellation releases a waiting stream", purpose: "An abort-aware fake rejects while awaiting its next message.", check: async () => {
    const abort = new AbortController();
    const pending = runAgent(fakeQuery("wait"), { prompt: "Hello", signal: abort.signal });
    abort.abort(new Error("Stopped by user"));
    assert.equal((await pending).status, "cancelled");
  } },
];
// #endregion

export async function runCase(testCase: TestCase, mutation = false) {
  const start = performance.now();
  try {
    await testCase.check(mutation);
    return { id: testCase.id, name: testCase.name, group: testCase.group, passed: true, durationMs: performance.now() - start };
  } catch (error) {
    return { id: testCase.id, name: testCase.name, group: testCase.group, passed: false, durationMs: performance.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}
