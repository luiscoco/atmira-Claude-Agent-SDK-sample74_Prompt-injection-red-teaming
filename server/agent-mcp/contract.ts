/**
 * The tool contract, exercised offline: a real MCP Client talks to the real refund-desk server over an in-memory
 * transport, and a scripted runner stands in for the agent. Every row is what a caller would really receive.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeskServer, DeskState, deskLimits, scriptedRunner, type Runner, type Script } from "./desk.js";

/** Connects a client to a fresh server. `state` is shared when a scenario needs several servers (stateless HTTP). */
export async function connectInMemory(runner: Runner, state = new DeskState()) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildDeskServer(runner, state, "in-memory");
  await server.connect(serverSide);
  const client = new Client({ name: "lesson61-contract", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, server, state, close: async () => { await client.close(); await server.close(); } };
}

/** What tools/list, resources/list and resources/read return: everything a caller learns about the desk. */
export async function describeDesk() {
  const { client, close } = await connectInMemory(scriptedRunner());
  try {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const policy = await client.readResource({ uri: "refund-desk://policy" });
    return { server: client.getServerVersion(), instructions: client.getInstructions(), tools, resources, policy: policy.contents[0] };
  } finally { await close(); }
}

export type ContractRow = {
  scenario: string; call: string; isError: boolean; thrown?: string; text: string; structured?: unknown;
  progress: string[]; serverLog: string; agentRan: boolean; ms: number;
};

type Scenario = {
  scenario: string; script?: Script; args: Record<string, unknown>; tool?: string;
  limits?: Partial<typeof deskLimits>; spentUsd?: number; cancelAfterMs?: number; alsoRunning?: number;
};
export const scenarios: Scenario[] = [
  { scenario: "valid call", args: { orderId: "O-201", customerMessage: "Too dim, still boxed." } },
  { scenario: "input fails the schema", args: { orderId: "201", customerMessage: "" } },
  { scenario: "unknown order", args: { orderId: "O-299", customerMessage: "Refund please." } },
  { scenario: "agent output breaks the output schema", script: "invalid", args: { orderId: "O-202", customerMessage: "Unopened." } },
  { scenario: "agent crashes", script: "throws", args: { orderId: "O-203", customerMessage: "Does not fit." } },
  { scenario: "caller cancels after 100 ms", script: "slow", args: { orderId: "O-204", customerMessage: "Hurts." }, cancelAfterMs: 100 },
  { scenario: "server deadline (150 ms here)", script: "slow", args: { orderId: "O-204", customerMessage: "Hurts." }, limits: { callTimeoutMs: 150 } },
  { scenario: `${deskLimits.maxConcurrent} reviews already running`, args: { orderId: "O-205", customerMessage: "Unopened." }, alsoRunning: deskLimits.maxConcurrent },
  { scenario: "server budget spent", args: { orderId: "O-205", customerMessage: "Unopened." }, spentUsd: deskLimits.serverBudgetUsd },
  { scenario: "tool that does not exist", tool: "approve_everything", args: { orderId: "O-206" } },
];

export async function runScenario(s: Scenario): Promise<ContractRow> {
  const state = new DeskState({ ...deskLimits, ...s.limits });
  state.spentUsd = s.spentUsd ?? 0;
  let agentRan = false;
  const base = scriptedRunner(s.script ?? "ok", 10);
  const runner: Runner = (input, context) => { agentRan = true; return base(input, context); };
  const { client, close } = await connectInMemory(runner, state);
  // Busy: hold `alsoRunning` slow reviews open on their own connections (same shared state), then make the call.
  const release = new AbortController();
  const blockers = await Promise.all(Array.from({ length: s.alsoRunning ?? 0 }, () => connectInMemory(scriptedRunner("slow"), state)));
  const blockerCalls = blockers.map((b) => b.client.callTool({ name: "review_refund", arguments: { orderId: "O-201", customerMessage: "x" } }, undefined, { signal: release.signal }).catch(() => undefined));
  if (blockers.length) await new Promise((resolve) => setTimeout(resolve, 30));
  const call = `${s.tool ?? "review_refund"}(${JSON.stringify(s.args)})`;
  const progress: string[] = [];
  const controller = new AbortController();
  if (s.cancelAfterMs) setTimeout(() => controller.abort("caller gave up"), s.cancelAfterMs);
  const started = Date.now();
  let row: Omit<ContractRow, "serverLog">;
  try {
    await client.listTools(); // the client caches outputSchema from tools/list and validates structuredContent with it
    const result = await client.callTool({ name: s.tool ?? "review_refund", arguments: s.args }, undefined, {
      signal: controller.signal, onprogress: (p) => progress.push(p.message ?? String(p.progress)),
    });
    const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");
    row = { scenario: s.scenario, call, isError: Boolean(result.isError), text, structured: result.structuredContent, progress, agentRan, ms: Date.now() - started };
  } catch (error) {
    row = { scenario: s.scenario, call, isError: true, thrown: String(error), text: "", progress, agentRan, ms: Date.now() - started };
  }
  release.abort("scenario over"); // cancels the blockers' reviews on the server too
  await Promise.all(blockerCalls);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the server write its log line after a cancel
  for (const b of blockers) await b.close();
  await close();
  const own = state.calls.find((entry) => entry.orderId === s.args.orderId);
  return { ...row, serverLog: own ? `${own.outcome}${own.isError ? " (isError)" : ""}` : "no tool run logged" };
}

export async function runContract() {
  const rows: ContractRow[] = [];
  for (const s of scenarios) rows.push(await runScenario(s));
  return rows;
}
