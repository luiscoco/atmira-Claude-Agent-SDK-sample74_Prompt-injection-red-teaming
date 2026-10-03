/**
 * CONCEPT 37 — The permission prompt tool: an MCP tool answers "may this tool call run?"
 *
 * When a tool call needs approval (no rule, mode or hook decided it), Claude Code asks the host. Concept 4 answered
 * with canUseTool. The other way is an MCP tool:
 *
 *   options.mcpServers = { gate: <an SDK server, or a stdio / http server> }
 *   options.permissionPromptToolName = "mcp__gate__approve"
 *
 *   Claude Code calls   approve({ tool_name, input, tool_use_id })
 *   the tool returns    { content: [{ type: "text", text: JSON.stringify(<PermissionResult>) }] }
 *                       { behavior: "allow", updatedInput, updatedPermissions? } | { behavior: "deny", message, interrupt? }
 *
 * canUseTool is the same mechanism: the SDK sends it as `--permission-prompt-tool stdio`. So the two options cannot be
 * combined (query() throws). The gate tool is hidden from the model. Rules, the permission mode and PreToolUse hooks
 * decide first; the gate is only asked for what would otherwise prompt. permissionPrompts: "none" means nobody is asked.
 *
 * The lab: an in-process gate that waits for YOU (the browser), and an external one, 37-policy-gate.mjs, a separate
 * process with a JSON policy. Routes: POST /dry, POST /run (SSE), POST /decide, POST /gate-log, POST /who (SSE),
 * POST /answers (SSE), POST /failures (SSE), GET /code.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept37 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const LAB = path.resolve("gate-lab");
const RUNS = path.join(LAB, "runs"); // one folder per session: its cwd
const CONFIG = path.join(LAB, "config"); // the fake CLAUDE_CONFIG_DIR of every session
const POLICY_GATE = fileURLToPath(new URL("./37-policy-gate.mjs", import.meta.url));
const GATE_TOOL = "mcp__gate__approve"; // mcp__<server name>__<tool name>

rmSync(LAB, { recursive: true, force: true });
for (const d of [RUNS, CONFIG]) mkdirSync(d, { recursive: true });

const ROOT = process.cwd();
const escaped = (p: string) => JSON.stringify(p).slice(1, -1); // a path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) =>
  s
    .replaceAll(escaped(LAB), "gate-lab")
    .replaceAll(LAB, "gate-lab")
    .replace(/gate-lab[\\/]+runs[\\/]+\w+[\\/]+/g, "") // a file of the run folder: only its name
    .replace(/gate-lab[\\/]+runs[\\/]+\w+/g, "<the run folder>")
    .replaceAll(escaped(ROOT), ".")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…"); // a key must never reach the browser

type Emit = (event: string, data: object) => void;

// Each session works in its own gate-lab/runs/<id> folder. Folders of finished sessions are deleted.
const active = new Set<string>();
function newRun() {
  for (const d of readdirSync(RUNS)) if (!active.has(d)) rmSync(path.join(RUNS, d), { recursive: true, force: true });
  const id = randomUUID().slice(0, 8);
  const work = path.join(RUNS, id);
  mkdirSync(work, { recursive: true });
  active.add(id);
  return { id, work, done: () => active.delete(id) };
}

/** Files under a folder, relative to it, "/" separated. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => !statSync(path.join(dir, f)).isDirectory() || readdirSync(path.join(dir, f)).length === 0)
    .map((f) => f.replaceAll("\\", "/") + (statSync(path.join(dir, f)).isDirectory() ? "/" : ""));
}
const readIf = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 500);

// #region options
function base(work: string, abort: AbortController, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG;
  return {
    model: MODEL,
    cwd: work,
    env,
    tools: ["Write", "Bash"],
    settingSources: [], // no settings files: only this code decides what is allowed
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 8,
    abortController: abort,
    ...extra,
  };
}
// #endregion

// #region gate
// The smallest permission prompt tool: an SDK MCP server (it runs in THIS process) with one tool. Claude Code calls
// it with { tool_name, input, tool_use_id }; the text of the result must be a JSON PermissionResult.
type GateCall = { tool_name: string; input: Record<string, unknown>; tool_use_id?: string };
type Decide = (call: GateCall) => Promise<PermissionResult | string> | PermissionResult | string;

function sdkGate(decide: Decide) {
  return createSdkMcpServer({
    name: "gate",
    tools: [
      tool(
        "approve",
        "Decides whether a tool call may run.",
        // input: z.looseObject({}), NOT z.record(): with a record, the SDK's tools/list fails ("reading 'push'"),
        // Claude Code sees no tool, and exits at the first prompt ("MCP tool … not found").
        { tool_name: z.string(), input: z.looseObject({}), tool_use_id: z.string().optional() },
        async (call) => {
          const answer = await decide(call);
          // A string is sent as it is: Part F uses it to send something that is not a PermissionResult.
          return { content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
        },
      ),
    ],
  });
}

const gateOptions = (decide: Decide): Partial<Options> => ({ mcpServers: { gate: sdkGate(decide) }, permissionPromptToolName: GATE_TOOL });
// #endregion

// #region human
// The in-process gate of Part B waits here until the browser answers (POST /decide), 2 minutes pass, or the run stops.
const ANSWER_TIMEOUT_MS = 120_000; // the host's own limit: Claude Code waits for the gate as long as it takes
type Pending = { run: string; call: GateCall; done: (r: PermissionResult, how: string) => void };
const pending = new Map<string, Pending>(); // "<run id>:<call id>" → the open call

function askTheBrowser(run: string, emit: Emit, signal: AbortSignal): Decide {
  let n = 0;
  return (call) =>
    new Promise((resolve) => {
      const id = String(++n);
      const key = `${run}:${id}`;
      emit("gateCall", { run, id, who: "you", call: { ...call, input: JSON.parse(short(JSON.stringify(call.input))) }, timeoutMs: ANSWER_TIMEOUT_MS });
      const done = (result: PermissionResult, how: string) => {
        if (!pending.delete(key)) return; // already answered
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        emit("gateAnswer", { id, how, sent: JSON.parse(short(JSON.stringify(result))) });
        resolve(result);
      };
      const onAbort = () => done({ behavior: "deny", message: "The run was stopped." }, "aborted");
      const timer = setTimeout(() => done({ behavior: "deny", message: "Nobody answered the permission prompt within 2 minutes." }, "timeout"), ANSWER_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(key, { run, call, done });
    });
}

// The browser's button becomes the PermissionResult the gate returns.
//   allow     → allow, the input unchanged
//   edit      → allow, with YOUR input (updatedInput): the tool runs with it, the model is not told
//   remember  → allow + updatedPermissions: a session rule (Bash: this command's first word), so the next such calls
//               are not asked
//   deny      → deny + your message: the model gets it as an is_error tool_result and goes on
//   stop      → deny + interrupt: the run ends
const DecideBody = z
  .object({
    run: z.string().regex(/^[0-9a-f]{8}$/),
    id: z.string().regex(/^\d{1,3}$/),
    action: z.enum(["allow", "edit", "remember", "deny", "stop"]),
    input: z.record(z.string(), z.unknown()).optional(), // edit only
    message: z.string().trim().min(1).max(300).optional(), // deny and stop
  })
  .strict()
  .refine((b) => (b.action === "edit") === (b.input !== undefined), { message: "input is required for 'edit', and only for it" })
  .refine((b) => b.message === undefined || b.action === "deny" || b.action === "stop", { message: "message is only for 'deny' and 'stop'" });

function toResult(p: Pending, b: z.infer<typeof DecideBody>): PermissionResult {
  const input = p.call.input;
  if (b.action === "allow") return { behavior: "allow", updatedInput: input };
  if (b.action === "edit") return { behavior: "allow", updatedInput: b.input };
  if (b.action === "remember") {
    // A rule for the WHOLE Bash tool would also allow a later `rm`: remember only this command's first word.
    const word = p.call.tool_name === "Bash" ? /^\s*([\w.-]+)/.exec(String(input.command ?? ""))?.[1] : undefined;
    const rule = word ? { toolName: "Bash", ruleContent: `${word}:*` } : { toolName: p.call.tool_name };
    return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "addRules", rules: [rule], behavior: "allow", destination: "session" }] };
  }
  if (b.action === "deny") return { behavior: "deny", message: b.message ?? "The user denied this tool call." };
  return { behavior: "deny", message: b.message ?? "The user stopped the run.", interrupt: true };
}

concept37.post("/decide", (req, res) => {
  const parsed = DecideBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: badRequest(parsed.error) });
  const p = pending.get(`${parsed.data.run}:${parsed.data.id}`);
  if (!p) return res.status(404).json({ error: "No open permission prompt with that id (already answered, timed out, or the run ended)." });
  if (parsed.data.input && JSON.stringify(parsed.data.input).length > 20_000) return res.status(400).json({ error: "input is too large" });
  p.done(toResult(p, parsed.data), parsed.data.action);
  res.json({ ok: true });
});
// #endregion

// #region policy
// The external gate of Part C: Claude Code starts 37-policy-gate.mjs as a stdio MCP server. It is another process,
// it could be written in any language, and the host only gives it a policy. It reports each decision to /gate-log.
const Rule = z
  .object({
    tool: z.string().regex(/^(\*|[A-Za-z][\w-]{0,40})$/, "a tool name, or *"),
    match: z
      .string()
      .max(200)
      .refine((s) => {
        try {
          return new RegExp(s), true;
        } catch {
          return false;
        }
      }, "not a valid regular expression")
      .optional(),
    decision: z.enum(["allow", "deny"]),
    message: z.string().max(200).optional(),
  })
  .strict();
const Policy = z.object({ default: z.enum(["allow", "deny"]), rules: z.array(Rule).max(12) }).strict();
type Policy = z.infer<typeof Policy>;

function policyGate(policy: Policy, gateLog: { url: string; run: string; token: string }): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath, // the same node.exe that runs this server: no PATH lookup
    args: [POLICY_GATE],
    env: { GATE_POLICY: JSON.stringify(policy), GATE_LOG_URL: gateLog.url, GATE_RUN: gateLog.run, GATE_TOKEN: gateLog.token },
  };
}
// #endregion

// The policy gate POSTs here. Only the run that started it (its token) gets the line.
const gateLogs = new Map<string, { token: string; emit: Emit }>();
concept37.post("/gate-log", (req, res) => {
  const b = req.body ?? {};
  const target = gateLogs.get(String(b.run));
  if (!target || target.token !== b.token) return res.status(403).end();
  const { token: _t, run: _r, ...line } = b;
  target.emit("gateLog", JSON.parse(short(JSON.stringify(line))));
  res.end();
});

// #region relay
/** Turns each SDK message into a small event for the browser. */
function relay(m: SDKMessage, emit: Emit, names: Map<string, string>) {
  if (m.type === "system" && m.subtype === "init") return emit("init", { tools: m.tools, gateListed: m.tools.includes(GATE_TOOL), mcp: m.mcp_servers });
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "text" && b.text.trim()) emit("assistant", { text: short(b.text).slice(0, 600) });
      if (b.type === "tool_use") names.set(b.id, b.name), emit("toolUse", { id: b.id, name: b.name, input: short(JSON.stringify(b.input)).slice(0, 400) });
    }
    return;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content as any[]) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
      emit("toolResult", { id: b.tool_use_id, name: names.get(b.tool_use_id) ?? "?", is_error: !!b.is_error, text: short(text).slice(0, 400) });
    }
    return;
  }
  if (m.type === "result")
    emit("result", {
      subtype: m.subtype,
      cost: m.total_cost_usd,
      denials: m.permission_denials.map((d) => d.tool_name),
      text: m.subtype === "success" ? short(m.result).slice(0, 600) : undefined,
    });
}
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /run: one session with a gate. "you": the in-process gate asks the browser. "policy": the external gate.
// ---------------------------------------------------------------------------------------------

const DEFAULT_POLICY: Policy = {
  default: "deny",
  rules: [
    { tool: "Write", match: "\\.txt$", decision: "allow" },
    { tool: "Bash", match: "^(mkdir|ls|cat) ", decision: "allow" },
    { tool: "Bash", match: "^rm ", decision: "deny", message: "Deleting files needs a ticket (policy-gate)." },
  ],
};

const RunBody = z
  .object({ gate: z.enum(["you", "policy"]), prompt: z.string().trim().min(1).max(2000), policy: Policy.optional() })
  .strict()
  .refine((b) => b.gate === "policy" || b.policy === undefined, { message: "policy is only for gate 'policy'" });

concept37.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (e, d) => send(e, { ...d, at: Date.now() - startedAt });
  const end = () => (send("done", {}), res.end());
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), end();
  const b = parsed.data;
  const run = newRun();
  const token = randomBytes(16).toString("hex");
  try {
    let gate: Partial<Options>;
    if (b.gate === "you") gate = gateOptions(askTheBrowser(run.id, emit, abort.signal));
    else {
      gateLogs.set(run.id, { token, emit });
      const url = `http://127.0.0.1:${req.socket.localPort}${req.baseUrl}/gate-log`;
      gate = { mcpServers: { gate: policyGate(b.policy ?? DEFAULT_POLICY, { url, run: run.id, token }) }, permissionPromptToolName: GATE_TOOL };
    }
    const options = base(run.work, abort, gate);
    emit("opened", {
      run: run.id,
      hostPid: process.pid,
      options: {
        tools: options.tools,
        mcpServers: b.gate === "you" ? { gate: "createSdkMcpServer({ name: 'gate', tools: [approve] }) — in this process" } : { gate: `{ type: 'stdio', command: 'node', args: ['37-policy-gate.mjs'], env: { GATE_POLICY, … } }` },
        permissionPromptToolName: options.permissionPromptToolName,
      },
    });
    const names = new Map<string, string>();
    try {
      for await (const m of query({ prompt: b.prompt, options })) relay(m, emit, names);
    } catch (err) {
      emit("error", { message: errText(err) }); // a deny with interrupt: true ends with error_during_execution, then query() throws
    }
    emit("check", { files: files(run.work), settingsLocal: readIf(path.join(run.work, ".claude", "settings.local.json")) });
  } finally {
    for (const p of pending.values()) if (p.run === run.id) p.done({ behavior: "deny", message: "The run ended." }, "aborted");
    await new Promise((r) => setTimeout(r, 300)); // the gate's last log line can arrive just after the result
    gateLogs.delete(run.id);
    run.done();
    end();
  }
});

// ---------------------------------------------------------------------------------------------
// POST /dry: which flags the SDK builds for each way of answering. No process, no API call.
// ---------------------------------------------------------------------------------------------

// #region dry
// A spawner that only records SpawnOptions, and a fake process that exits at once (see Concept 36).
function fakeProcess(): SpawnedProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const p = {
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    stdout,
    killed: false,
    exitCode: null as number | null,
    kill: () => false,
    on: (e: string, l: (...a: any[]) => void) => (events.on(e, l), p),
    once: (e: string, l: (...a: any[]) => void) => (events.once(e, l), p),
    off: (e: string, l: (...a: any[]) => void) => (events.off(e, l), p),
  };
  setTimeout(() => ((p.exitCode = 0), stdout.end(), events.emit("exit", 0, null)), 10);
  return p as SpawnedProcess;
}

async function argsOf(options: Options): Promise<string[]> {
  let got: SpawnOptions | undefined;
  const q = query({ prompt: "(dry run)", options: { ...options, spawnClaudeCodeProcess: (o) => ((got = o), fakeProcess()) } });
  try {
    for await (const _ of q) break;
  } catch (err) {
    if (!got) throw err; // query() refused the options before any spawn
  }
  return got!.args;
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
// #endregion

const allowAll: Decide = (c) => ({ behavior: "allow", updatedInput: c.input });
const DRY: { key: string; label: string; shown: string; options: () => Partial<Options> }[] = [
  { key: "none", label: "no approver", shown: "—", options: () => ({}) },
  { key: "canUseTool", label: "canUseTool (Concept 4)", shown: "canUseTool: async (name, input) => …", options: () => ({ canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }) }) },
  { key: "sdk", label: "an SDK MCP tool", shown: "mcpServers: { gate: createSdkMcpServer(…) }, permissionPromptToolName: 'mcp__gate__approve'", options: () => gateOptions(allowAll) },
  {
    key: "stdio",
    label: "a stdio MCP tool",
    shown: "mcpServers: { gate: { type: 'stdio', command: 'node', args: ['37-policy-gate.mjs'] } }, permissionPromptToolName: 'mcp__gate__approve'",
    options: () => ({ mcpServers: { gate: policyGate(DEFAULT_POLICY, { url: "http://127.0.0.1/x", run: "dry", token: "dry" }) }, permissionPromptToolName: GATE_TOOL }),
  },
  { key: "promptsNone", label: "the tool + permissionPrompts: 'none'", shown: "…, permissionPromptToolName: 'mcp__gate__approve', permissionPrompts: 'none'", options: () => ({ ...gateOptions(allowAll), permissionPrompts: "none" }) },
  { key: "both", label: "canUseTool AND the tool", shown: "canUseTool: …, permissionPromptToolName: 'mcp__gate__approve'", options: () => ({ ...gateOptions(allowAll), canUseTool: async () => ({ behavior: "deny", message: "x" }) }) },
];

concept37.post("/dry", async (_req, res) => {
  const rows = await Promise.all(
    DRY.map(async (d) => {
      const row = { key: d.key, label: d.label, shown: d.shown };
      try {
        const args = await argsOf(base(RUNS, new AbortController(), d.options()));
        const mcp = flag(args, "--mcp-config");
        return { ...row, promptTool: flag(args, "--permission-prompt-tool") ?? null, prompts: flag(args, "--permission-prompts") ?? null, mcpConfig: mcp ? short(mcp).slice(0, 400) : null, argCount: args.length };
      } catch (err) {
        return { ...row, error: errText(err) };
      }
    }),
  );
  res.json({ rows });
});

// ---------------------------------------------------------------------------------------------
// POST /who, /answers, /failures: many short sessions in parallel, one table row each
// ---------------------------------------------------------------------------------------------

const TWO_STEPS = "First write the word hello into a.txt with the Write tool. Then run `mkdir out` with the Bash tool. Then reply with one line saying what happened.";

type RowSpec = {
  key: string;
  label: string;
  shown: string;
  prompt?: string;
  /** The options of the row. `gate` wraps a Decide so that every call is recorded in the row. */
  options: (gate: (d: Decide) => Partial<Options>, work: string) => Partial<Options>;
  note?: (r: RowOut) => string;
};
type RowOut = {
  key: string;
  label: string;
  shown: string;
  asked: { tool: string; answer: string }[];
  toolUses: string[];
  results: { name: string; is_error: boolean; text: string }[];
  tools: string[];
  mcp: string[];
  files: string[];
  aTxt: string | null;
  settingsLocal: string | null;
  denials: string[];
  outcome: string;
  text: string;
  cost: number;
  note?: string;
  at?: number;
};

const answerText = (a: PermissionResult | string) =>
  typeof a === "string"
    ? `"${a}" (not JSON)`
    : a.behavior === "allow"
      ? `allow${a.updatedPermissions ? " + updatedPermissions" : ""}`
      : `deny: ${a.message}${a.interrupt ? " (interrupt)" : ""}`;

async function runRow(spec: RowSpec, abort: AbortController): Promise<RowOut> {
  const run = newRun();
  const r: RowOut = { key: spec.key, label: spec.label, shown: spec.shown, asked: [], toolUses: [], results: [], tools: [], mcp: [], files: [], aTxt: null, settingsLocal: null, denials: [], outcome: "", text: "", cost: 0 };
  const gate = (d: Decide) =>
    gateOptions(async (call) => {
      try {
        const a = await d(call);
        r.asked.push({ tool: call.tool_name, answer: answerText(a) });
        return a;
      } catch (err) {
        r.asked.push({ tool: call.tool_name, answer: `threw: ${errText(err)}` });
        throw err;
      }
    });
  const names = new Map<string, string>();
  try {
    for await (const m of query({ prompt: spec.prompt ?? TWO_STEPS, options: base(run.work, abort, { maxTurns: 6, ...spec.options(gate, run.work) }) })) {
      if (m.type === "system" && m.subtype === "init") (r.tools = m.tools), (r.mcp = m.mcp_servers.map((s) => `${s.name}: ${s.status}`));
      if (m.type === "assistant")
        for (const c of m.message.content) if (c.type === "tool_use") names.set(c.id, c.name), r.toolUses.push(`${c.name} ${short(JSON.stringify(c.input)).slice(0, 120)}`);
      if (m.type === "user" && Array.isArray(m.message.content))
        for (const c of m.message.content as any[])
          if (c.type === "tool_result") r.results.push({ name: names.get(c.tool_use_id) ?? "?", is_error: !!c.is_error, text: short(typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join(" ")).slice(0, 260) });
      if (m.type === "result") {
        r.cost = m.total_cost_usd;
        r.denials = m.permission_denials.map((d) => d.tool_name);
        r.outcome = `result: ${m.subtype}`;
        if (m.subtype === "success") r.text = short(m.result).slice(0, 300);
      }
    }
  } catch (err) {
    r.outcome = `query() threw: ${errText(err)}`;
  }
  r.files = files(run.work);
  r.aTxt = readIf(path.join(run.work, "a.txt"));
  r.settingsLocal = readIf(path.join(run.work, ".claude", "settings.local.json"));
  r.note = spec.note?.(r);
  run.done();
  return r;
}

function rowsRoute(specs: RowSpec[]) {
  return async (req: import("express").Request, res: import("express").Response) => {
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    try {
      // order: the row's place in the list. The rows finish in any order; the tab sorts them back.
      await Promise.all(specs.map(async (s, order) => send("row", { ...(await runRow(s, abort)), order, at: Date.now() - startedAt })));
    } finally {
      send("done", {});
      res.end();
    }
  };
}

// #region who
// Who is asked, and when? The same two steps (Write a.txt, then Bash mkdir out) with a gate that allows everything.
// The "asked" column shows what reached the gate: everything else was decided before it.
const allowAndRecord = (gate: (d: Decide) => Partial<Options>) => gate(allowAll);
const hook = (matcher: string, decision: "allow" | "deny" | "ask"): Partial<Options> => {
  const cb: HookCallback = async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: `a PreToolUse hook says ${decision}` } });
  return { hooks: { PreToolUse: [{ matcher, hooks: [cb] }] } };
};

const WHO: RowSpec[] = [
  { key: "nobody", label: "no approver at all", shown: "(no canUseTool, no permissionPromptToolName)", options: () => ({}) },
  { key: "gate", label: "the gate", shown: "permissionPromptToolName: 'mcp__gate__approve'", options: allowAndRecord },
  { key: "allowed", label: "+ an allow rule", shown: "… + allowedTools: ['Write']", options: (g) => ({ ...allowAndRecord(g), allowedTools: ["Write"] }) },
  { key: "mode", label: "+ a permission mode", shown: "… + permissionMode: 'acceptEdits'", options: (g) => ({ ...allowAndRecord(g), permissionMode: "acceptEdits" }) },
  { key: "hookDeny", label: "+ a hook that denies Bash", shown: "… + PreToolUse(Bash) → permissionDecision: 'deny'", options: (g) => ({ ...allowAndRecord(g), ...hook("Bash", "deny") }) },
  { key: "hookAsk", label: "+ a hook that asks, in acceptEdits", shown: "… + acceptEdits + PreToolUse(Write) → permissionDecision: 'ask'", options: (g) => ({ ...allowAndRecord(g), permissionMode: "acceptEdits", ...hook("Write", "ask") }) },
  { key: "promptsNone", label: "+ permissionPrompts: 'none'", shown: "… + permissionPrompts: 'none'", options: (g) => ({ ...allowAndRecord(g), permissionPrompts: "none" }) },
];
// #endregion

// #region answers
// What the gate can answer. The gate's answer is the ONLY thing that changes between the rows.
const deny = (message: string, interrupt = false): PermissionResult => ({ behavior: "deny", message, ...(interrupt && { interrupt }) });
const onlyBash = (a: (c: GateCall) => PermissionResult | string): Decide => (c) => (c.tool_name === "Bash" ? a(c) : { behavior: "allow", updatedInput: c.input });

const ANSWERS: RowSpec[] = [
  { key: "allow", label: "allow", shown: "{ behavior: 'allow', updatedInput: input }", options: (g) => g(allowAll) },
  {
    key: "rewrite",
    label: "allow, with another input",
    shown: "{ behavior: 'allow', updatedInput: { ...input, content: 'REWRITTEN BY THE GATE' } } · Bash: { command: 'mkdir gate-dir' }",
    options: (g) => g((c) => ({ behavior: "allow", updatedInput: c.tool_name === "Write" ? { ...c.input, content: "REWRITTEN BY THE GATE" } : { ...c.input, command: "mkdir gate-dir" } })),
    note: (r) => `The model asked for "hello" and "out". a.txt contains ${JSON.stringify(r.aTxt)}, and the folder is ${r.files.filter((f) => f.endsWith("/")).join(", ") || "missing"}. The tool results do not say the input changed, so the model's reply can be wrong.`,
  },
  { key: "deny", label: "deny Bash", shown: "{ behavior: 'deny', message: 'mkdir is not allowed here.' }", options: (g) => g(onlyBash(() => deny("mkdir is not allowed here."))) },
  { key: "interrupt", label: "deny Bash + interrupt", shown: "{ behavior: 'deny', message: 'Stop.', interrupt: true }", options: (g) => g(onlyBash(() => deny("Stop.", true))) },
  {
    key: "session",
    label: "allow + a session rule",
    shown: "{ behavior: 'allow', updatedInput, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }",
    prompt: "Run `mkdir one` with the Bash tool. When it is done, run `mkdir two` with the Bash tool. Then reply with one line.",
    options: (g) => g((c) => ({ behavior: "allow", updatedInput: c.input, updatedPermissions: [{ type: "addRules", rules: [{ toolName: c.tool_name }], behavior: "allow", destination: "session" }] })),
    note: (r) => `${r.toolUses.length} Bash calls, ${r.asked.length} gate call(s): the rule answered the rest. It lives only in this session.`,
  },
  {
    key: "local",
    label: "allow + a rule saved to a file",
    shown: "updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir:*' }], behavior: 'allow', destination: 'localSettings' }]",
    prompt: "Run `mkdir one` with the Bash tool. Then reply DONE.",
    options: (g) => g((c) => ({ behavior: "allow", updatedInput: c.input, updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "mkdir:*" }], behavior: "allow", destination: "localSettings" }] })),
    note: (r) => (r.settingsLocal ? `Claude Code wrote .claude/settings.local.json in the cwd: ${r.settingsLocal.replace(/\s+/g, " ")}. A later session that loads 'local' settings is not asked for mkdir.` : "No .claude/settings.local.json was written."),
  },
  { key: "notJson", label: "not a PermissionResult", shown: "the text 'yes please'", options: (g) => g(() => "yes please") },
];
// #endregion

// #region failures
// When the gate itself is the problem.
const FAILURES: RowSpec[] = [
  {
    key: "both",
    label: "canUseTool AND the gate",
    shown: "canUseTool: fn, permissionPromptToolName: 'mcp__gate__approve'",
    options: (g) => ({ ...g(allowAll), canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }) }),
    note: () => "canUseTool IS a permission prompt tool (named 'stdio'), so the SDK refuses two. Nothing started: $0.",
  },
  {
    key: "wrongName",
    label: "a tool name that does not exist",
    shown: "permissionPromptToolName: 'mcp__gate__aprove' (a typo)",
    options: (g) => ({ ...g(allowAll), permissionPromptToolName: "mcp__gate__aprove" }),
    note: (r) => `Claude Code only finds out at the first prompt, then exits with code 1. And ${r.tools.includes(GATE_TOOL) ? "the real mcp__gate__approve was in the MODEL's tool list: it is only hidden when it is the named tool" : "the gate tool was not in the model's tool list"}.`,
  },
  {
    key: "noServer",
    label: "no MCP server",
    shown: "permissionPromptToolName: 'mcp__gate__approve', no mcpServers",
    options: () => ({ permissionPromptToolName: GATE_TOOL }),
    note: () => "The same exit as a typo. No result message comes, so the cost of the turn is unknown.",
  },
  {
    key: "down",
    label: "the external gate does not start",
    shown: "mcpServers: { gate: { type: 'stdio', command: 'node', args: ['-e', 'process.exit(1)'] } }",
    options: () => ({ mcpServers: { gate: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] } }, permissionPromptToolName: GATE_TOOL }),
    note: (r) => `system/init says "${r.mcp.join(", ")}", but the session starts anyway. The exit comes at the first prompt: check mcp_servers in system/init before trusting the gate.`,
  },
  {
    key: "schema",
    label: "an input schema the SDK cannot list",
    shown: "tool('approve', …, { tool_name: z.string(), input: z.record(z.string(), z.unknown()) }, …)",
    options: () => ({
      mcpServers: {
        gate: createSdkMcpServer({
          name: "gate",
          tools: [tool("approve", "Decides whether a tool call may run.", { tool_name: z.string(), input: z.record(z.string(), z.unknown()) }, async (c) => ({ content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: c.input }) }] }))],
        }),
      },
      permissionPromptToolName: GATE_TOOL,
    }),
    note: (r) => `system/init says "${r.mcp.join(", ")}", but the SDK's tools/list fails on z.record, so the server has no tools. Use z.looseObject({}) for input (code: gate).`,
  },
  {
    key: "throws",
    label: "the gate throws",
    shown: "approve: async () => { throw new Error('policy service unreachable') }",
    options: (g) =>
      g(() => {
        throw new Error("policy service unreachable");
      }),
    note: (r) => `A tool error, not a denial: permission_denials has ${r.denials.length} entries, and the model may try again (${r.asked.length} gate calls).`,
  },
];
// #endregion

concept37.post("/who", rowsRoute(WHO));
concept37.post("/answers", rowsRoute(ANSWERS));
concept37.post("/failures", rowsRoute(FAILURES));

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file and the policy gate, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept37.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  const regions = Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()]));
  res.json({ ...regions, policyGate: readFileSync(POLICY_GATE, "utf8").replaceAll("\r\n", "\n"), defaultPolicy: DEFAULT_POLICY });
});
