/**
 * CONCEPT 46 — Prompt caching and cost optimization
 *
 *   systemPrompt: [handbook, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `Customer: ${name}`]   // static prefix first, per-user part last
 *   settings: { promptCacheTtl: "1h" }                                              // or CLAUDE_CODE_PROMPT_CACHE_TTL=1h
 *   env: { DISABLE_PROMPT_CACHING: "1" }                                             // the off switch (for comparison only)
 *   hooks: { PreModelSwitch: [...] }                                                 // input.estimated_cache_write_usd
 *
 * Claude Code caches the prompt for you: it puts `cache_control` breakpoints on the system prompt and on the last
 * messages of every request. What you control is whether the prefix is BIG enough to be cached (4,096 tokens on
 * Haiku 4.5), STABLE enough to be read again, and how long it lives. The lab puts a wire tap (ANTHROPIC_BASE_URL)
 * between Claude Code and the API, so the tab can show every breakpoint and the usage of every call. It shows:
 *   1. the anatomy: where the breakpoints are, and call 1 writes while call 2 reads (and a prompt too small to cache);
 *   2. the switches: the default 5-minute TTL, promptCacheTtl "1h", DISABLE_PROMPT_CACHING, over a 4-turn session;
 *   3. the cache breakers: a new query() with the same prefix reads the cache; a timestamp, one more tool, another
 *      model, a per-customer suffix do not; SYSTEM_PROMPT_DYNAMIC_BOUNDARY keeps the static part shared;
 *   4. a model switch in the middle of a session: the PreModelSwitch hook sees what the switch will cost, and can deny it.
 * Routes: GET /facts, POST /anatomy, /switches, /breakers, /model-switch (SSE), GET /code.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type HookCallbackMatcher, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept46 = Router();

const MODEL = "haiku";
const LAB = path.resolve("cache-lab");
const ROOT = process.cwd();
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
let tapBase = "";
const short = (s: string) =>
  s
    .replaceAll(LAB, "cache-lab")
    .replaceAll(LAB.replaceAll("\\", "\\\\"), "cache-lab")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…")
    .replaceAll(tapBase || "\u0000", "http://127.0.0.1:<tap>");

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);

// ---------------------------------------------------------------------------------------------
// The handbook: the big, static part of the prompt (about 8,000 tokens), the thing worth caching.
// ---------------------------------------------------------------------------------------------

// #region handbook
const TOPICS = ["Refund eligibility", "Return windows", "Damaged items", "Late deliveries", "Subscription cancellations", "Gift cards", "Store credit", "Price matching", "Warranty claims", "Exchanges", "International orders", "Digital goods", "Bulk orders", "Pre-orders", "Restocking fees", "Lost parcels", "Chargebacks", "Loyalty points", "Promotional codes", "Account closures"];
const REGIONS = ["EU", "UK", "US", "Canada", "Australia"];

/**
 * The support handbook the agent answers from. `edition` goes on the first line: every press of a scenario gets a new
 * one, so it starts with a cold cache (the cache is shared by every request of the same workspace, see Step 5).
 */
export function handbook(edition: string) {
  let s = `Handbook edition ${edition}.\nYou are the support agent of Northwind Outfitters. Answer customers using ONLY this handbook. Quote the section number you used.\n\n# Northwind Outfitters support handbook (v7)\n\n`;
  TOPICS.forEach((t, i) => {
    s += `## ${i + 1}. ${t}\n`;
    REGIONS.forEach((r, k) => {
      const days = 14 + ((i * 7 + k * 3) % 45);
      s += `${i + 1}.${k + 1} (${r}) For ${t.toLowerCase()} the agent must check the order date, the payment method and the item category. The limit is ${days} days from delivery. Above ${50 + i * 10 + k * 5} EUR a team lead approves it. Always log the case with the code ${t.slice(0, 3).toUpperCase()}-${r}-${100 + i * 5 + k} and tell the customer the expected time: ${2 + ((i + k) % 6)} business days.\n`;
    });
    s += "\n";
  });
  return s;
}
const newEdition = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// #endregion

// ---------------------------------------------------------------------------------------------
// The wire tap: ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/<lane>. It forwards every call to the API and records,
// for each /v1/messages request, the cache_control breakpoints it carries and the usage the API answered.
// ---------------------------------------------------------------------------------------------

// #region wire
export type Breakpoint = { where: string; ttl: string; scope?: string; chars: number; preview: string };
export type WireCall = {
  lane: string;
  sentAt: number; // when Claude Code sent the request (the row is emitted when the answer ends, but belongs here)
  n: number;
  kind: "turn" | "title";
  model: string;
  messages: number;
  turn: number; // which user turn this call belongs to: the user messages that are not tool results
  tools: number;
  systemBlocks: { chars: number; preview: string; cache?: string }[];
  breakpoints: Breakpoint[];
  status: number;
  usage?: { input: number; write5m: number; write1h: number; read: number; output: number };
  cost?: number;
};

// $ per million tokens (list prices). Cache writes: 1.25x input for 5 minutes, 2x for 1 hour. Cache reads: 0.1x.
export const PRICES: { match: RegExp; name: string; input: number; output: number }[] = [
  { match: /haiku-4-5/, name: "Haiku 4.5", input: 1, output: 5 },
  { match: /sonnet-5/, name: "Sonnet 5 / 5.5", input: 2, output: 10 },
  { match: /sonnet-4/, name: "Sonnet 4.x", input: 3, output: 15 },
  { match: /opus-5-5/, name: "Opus 5.5", input: 4, output: 20 },
];
function callCost(model: string, u: NonNullable<WireCall["usage"]>) {
  const p = PRICES.find((x) => x.match.test(model));
  if (!p) return undefined;
  const read = /opus-5-5/.test(model) ? 0.05 : 0.1; // Opus 5.5 reads at 0.05x
  return (u.input * p.input + u.write5m * p.input * 1.25 + u.write1h * p.input * 2 + u.read * p.input * read + u.output * p.output) / 1e6;
}

const cc = (c: any) => (c ? `${c.type}${c.ttl ? ` ttl ${c.ttl}` : " (5m)"}${c.scope ? ` scope ${c.scope}` : ""}` : undefined);
const blockText = (b: any) => (b.type === "text" ? b.text : b.type === "tool_result" ? JSON.stringify(b.content) : b.type === "tool_use" ? `${b.name}(${JSON.stringify(b.input)})` : b.type);

/** Every cache_control in the request, in render order: tools → system → messages. */
function breakpointsOf(body: any): Breakpoint[] {
  const out: Breakpoint[] = [];
  const add = (where: string, c: any, text: string) => out.push({ where, ttl: c.ttl ?? "5m", scope: c.scope, chars: text.length, preview: cut(short(text).replace(/\s+/g, " "), 70) });
  (body.tools ?? []).forEach((t: any, i: number) => t.cache_control && add(`tools[${i}] ${t.name}`, t.cache_control, t.description ?? ""));
  (Array.isArray(body.system) ? body.system : []).forEach((b: any, i: number) => b.cache_control && add(`system[${i}]`, b.cache_control, b.text));
  (body.messages ?? []).forEach((m: any, i: number) =>
    (Array.isArray(m.content) ? m.content : []).forEach((b: any, k: number) => b.cache_control && add(`messages[${i}].content[${k}] (${m.role} ${b.type})`, b.cache_control, blockText(b))),
  );
  if (body.cache_control) add("(top level)", body.cache_control, "");
  return out;
}

/** The usage of a streamed answer: message_start has the input side, message_delta the final output_tokens. */
function usageOf(sse: string) {
  let u: any = {};
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type === "message_start") u = { ...e.message.usage };
      if (e.type === "message_delta" && e.usage) u = { ...u, ...e.usage };
    } catch {}
  }
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return { input: u.input_tokens ?? 0, write5m: (u.cache_creation_input_tokens ?? 0) - w1h, write1h: w1h, read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

const laneCalls = new Map<string, { calls: WireCall[]; onCall: (c: WireCall) => void }>();

const tap = http.createServer(async (req, res) => {
  const [, lane = "", ...rest] = (req.url ?? "/").split("/");
  const upPath = `/${rest.join("/")}`;
  const t = laneCalls.get(lane);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  let call: WireCall | undefined;
  if (t && req.method === "POST" && upPath.startsWith("/v1/messages") && !upPath.includes("count_tokens")) {
    try {
      const j = JSON.parse(body.toString("utf8"));
      const first = JSON.stringify(j.messages?.[0]?.content ?? "");
      call = {
        lane,
        sentAt: Date.now(),
        n: t.calls.length + 1,
        kind: first.includes("<session>") ? "title" : "turn", // the side call that names the session (Tab38)
        model: j.model,
        messages: j.messages?.length ?? 0,
        // Counted from the request itself, so it does not depend on when the call finishes (the title call can end after the turn's result).
        turn: (j.messages ?? []).filter((m: any) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"))).length,
        tools: (j.tools ?? []).length,
        systemBlocks: (Array.isArray(j.system) ? j.system : []).map((b: any) => ({ chars: b.text.length, preview: cut(short(b.text).replace(/\s+/g, " "), 70), cache: cc(b.cache_control) })),
        breakpoints: breakpointsOf(j),
        status: 0,
      };
      t.calls.push(call);
    } catch {}
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  const got: Buffer[] = [];
  try {
    const up = await fetch(UPSTREAM + upPath, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => void (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k) && (out[k] = v)));
    res.writeHead(up.status, out);
    for await (const c of up.body ?? []) res.write(c), got.push(Buffer.from(c));
    res.end();
    if (call) {
      call.status = up.status;
      if (up.status === 200) {
        call.usage = usageOf(Buffer.concat(got).toString("utf8"));
        call.cost = callCost(call.model, call.usage);
      }
    }
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
  if (call && t) t.onCall(call);
});
const tapReady = new Promise<string>((resolve) => tap.listen(0, "127.0.0.1", () => resolve((tapBase = `http://127.0.0.1:${(tap.address() as AddressInfo).port}`))));
// #endregion

// ---------------------------------------------------------------------------------------------
// Options: a clean env (Tab16), a config dir and a work folder per lane, every call through the tap
// ---------------------------------------------------------------------------------------------

// #region options
/**
 * Claude Code only splits the prompt at SYSTEM_PROMPT_DYNAMIC_BOUNDARY (and marks the static part `scope: "global"`)
 * when it talks to the Anthropic API itself. Behind any other ANTHROPIC_BASE_URL (a gateway, a proxy, this lab's tap)
 * it does not. `firstPartyUrl` lanes set _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, an internal switch of the CLI, so
 * the tap can show what a first-party request looks like. In your app you set nothing: no ANTHROPIC_BASE_URL.
 */
function laneOptions(lane: string, env: Record<string, string>, abort: AbortController, extra: Partial<Options> = {}, firstPartyUrl = false): Options {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_BASE_URL|DISABLE_PROMPT_CACHING|ENABLE_PROMPT_CACHING|FORCE_PROMPT_CACHING)/.test(k)));
  const config = path.join(LAB, "config", lane);
  const cwd = path.join(LAB, "work", lane);
  for (const d of [config, cwd]) rmSync(d, { recursive: true, force: true, maxRetries: 3 }), mkdirSync(d, { recursive: true });
  writeFileSync(path.join(cwd, "notes.txt"), "Ticket 42: the refund was approved. Refund number RF-7781. Customer region: EU.");
  return {
    model: MODEL,
    cwd,
    env: {
      ...clean,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ANTHROPIC_BASE_URL: `${tapBase}/${lane}`, // every API call goes through the wire tap
      ...(firstPartyUrl && { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" }),
      ...env,
    },
    tools: [],
    allowedTools: [],
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    maxTurns: 4,
    abortController: abort,
    ...extra,
  };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// Running an agent: one prompt, or a session of several turns (streaming input, Tab12)
// ---------------------------------------------------------------------------------------------

// #region run
export type Turn = { n: number; text: string; cost: number; turnCost: number; subtype: string; isError: boolean; usage: { input: number; cacheWrite: number; cacheRead: number; output: number } };
export type RunResult = { turns: Turn[]; cost: number; modelUsage: { model: string; input: number; cacheWrite: number; cacheRead: number; output: number; costUSD: number }[]; error?: string };

function modelUsageOf(m: any) {
  return Object.entries<any>(m.modelUsage ?? {}).map(([model, u]) => ({ model, input: u.inputTokens, cacheWrite: u.cacheCreationInputTokens, cacheRead: u.cacheReadInputTokens, output: u.outputTokens, costUSD: u.costUSD }));
}

/**
 * Runs `prompts` as the turns of one session. `between(n, q)` runs after turn n (to call q.setModel(), Scenario 4).
 * The result of each turn carries the RUNNING total (Tab15): a turn's cost is the difference with the previous one.
 */
async function runSession(prompts: string[], options: Options, emit: Emit, between?: (n: number, q: ReturnType<typeof query>) => Promise<void>): Promise<RunResult> {
  const out: RunResult = { turns: [], cost: 0, modelUsage: [] };
  const inbox: (SDKUserMessage | null)[] = [];
  let wake = () => {};
  const push = (m: SDKUserMessage | null) => (inbox.push(m), wake());
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (!inbox.length) await new Promise<void>((r) => (wake = r));
      const m = inbox.shift();
      if (!m) return;
      yield m;
    }
  }
  const say = (text: string) => push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
  const q = query({ prompt: input(), options });
  say(prompts[0]);
  emit("user", { n: 1, text: prompts[0] });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") emit("init", { model: m.model, tools: m.tools });
      if (m.type === "assistant")
        for (const b of m.message.content) if (b.type === "tool_use") emit("tool", { name: b.name, input: JSON.parse(short(JSON.stringify(b.input))) });
      if (m.type === "result") {
        const n = out.turns.length + 1;
        const turn: Turn = {
          n,
          text: cut(short(m.subtype === "success" ? m.result : (m.errors ?? []).join("; ")), 300),
          cost: m.total_cost_usd,
          turnCost: m.total_cost_usd - out.cost,
          subtype: m.subtype,
          isError: m.is_error,
          usage: { input: m.usage.input_tokens, cacheWrite: m.usage.cache_creation_input_tokens, cacheRead: m.usage.cache_read_input_tokens, output: m.usage.output_tokens },
        };
        out.turns.push(turn);
        out.cost = m.total_cost_usd;
        out.modelUsage = modelUsageOf(m);
        emit("result", turn);
        if (n < prompts.length) {
          await between?.(n, q);
          say(prompts[n]);
          emit("user", { n: n + 1, text: prompts[n] });
        } else push(null);
      }
    }
  } catch (err) {
    if (!options.abortController?.signal.aborted && !String(err).includes("returned an error result")) out.error = errText(err);
  }
  return out;
}
// #endregion

/** An SSE route: parse the body, open the lanes' taps, stream every event with the lane and the time. */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, lane: (name: string) => Emit, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    // `at`: ms since the start of the route. A wire call is timed by when it was SENT, so the tab can put it before the
    // tool call or result it produced (its event only goes out once the answer has been read).
    const emit: Emit = (e, d) => send(e, { ...d, at: ("sentAt" in d ? (d.sentAt as number) : Date.now()) - startedAt });
    const opened: string[] = [];
    const lane = (name: string): Emit => {
      laneCalls.set(name, { calls: [], onCall: (c) => emit("wire", c) });
      opened.push(name);
      return (e, d) => emit(e, { ...d, lane: name });
    };
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await tapReady;
      await body(parsed.data, abort, lane, emit);
    } catch (err) {
      if (!abort.signal.aborted) emit("error", { message: errText(err) });
    } finally {
      for (const l of opened) laneCalls.delete(l);
      send("done", {});
      res.end();
    }
  };
}
const calls = (lane: string) => (laneCalls.get(lane)?.calls ?? []).filter((c) => c.kind === "turn");
const sumCalls = (lane: string) => calls(lane).reduce((a, c) => ({ input: a.input + (c.usage?.input ?? 0), write: a.write + (c.usage?.write5m ?? 0) + (c.usage?.write1h ?? 0), read: a.read + (c.usage?.read ?? 0) }), { input: 0, write: 0, read: 0 });

// ---------------------------------------------------------------------------------------------
// GET /facts
// ---------------------------------------------------------------------------------------------

concept46.get("/facts", async (_req, res) => {
  try {
    await tapReady;
    const dts = readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
    // The one-line doc comment right above a Settings field in sdk.d.ts.
    const doc = (name: string) => dts.match(new RegExp(`\\* ([^\\r\\n]+)\\s*\\*\\/\\s*${name}\\?:`))?.[1] ?? "not found";
    res.json({ tap: tapBase, sdkVersion: pkg.version, claudeCodeVersion: pkg.claudeCodeVersion, boundary: SYSTEM_PROMPT_DYNAMIC_BOUNDARY, promptCacheTtl: doc("promptCacheTtl"), subagentPromptCacheTtl: doc("subagentPromptCacheTtl"), handbookChars: handbook(newEdition()).length /* the size the lanes send: the edition id is part of it */, prices: PRICES.map(({ name, input, output }) => ({ name, input, output })) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /anatomy: one agent, two calls (Read, then answer). A small prompt and a big one.
// ---------------------------------------------------------------------------------------------

// #region scenario-anatomy
concept46.post(
  "/anatomy",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    const prompt = "Read notes.txt, then tell me in one line the refund number and which handbook section applies.";
    const lanes: [string, Partial<Options>][] = [
      ["an-small", {}], // the SDK's own short system prompt: about 1,500 tokens with the Read tool
      ["an-handbook", { systemPrompt: handbook(newEdition()) }], // + the handbook: about 9,500 tokens
    ];
    await Promise.all(
      lanes.map(async ([name, extra]) => {
        const e = lane(name);
        const options = laneOptions(name, {}, abort, { tools: ["Read"], allowedTools: ["Read"], ...extra });
        e("options", { systemPrompt: extra.systemPrompt ? `handbook (${String(extra.systemPrompt).length} characters)` : "(not set: the SDK's short default)", tools: ["Read"] });
        const run = await runSession([prompt], options, e);
        e("verdict", { run, wire: sumCalls(name) });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /switches: the same 4-turn session with the default TTL, a 1-hour TTL, and caching off
// ---------------------------------------------------------------------------------------------

// #region scenario-switches
export const QUESTIONS = ["Which section covers gift cards? One line.", "And chargebacks? One line.", "And loyalty points? One line.", "And promotional codes? One line."];
const SWITCH_LANES: Record<string, { title: string; env?: Record<string, string>; settings?: Options["settings"] }> = {
  "sw-5m": { title: "default: 5-minute TTL (an API key)" },
  "sw-1h": { title: 'settings: { promptCacheTtl: "1h" }', settings: { promptCacheTtl: "1h" } },
  "sw-off": { title: "env: DISABLE_PROMPT_CACHING=1", env: { DISABLE_PROMPT_CACHING: "1" } },
};

concept46.post(
  "/switches",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    await Promise.all(
      Object.entries(SWITCH_LANES).map(async ([name, L]) => {
        const e = lane(name);
        // Each lane its own edition: the three lanes must not read each other's cache.
        const options = laneOptions(name, L.env ?? {}, abort, { systemPrompt: handbook(newEdition()), settings: L.settings });
        e("options", { title: L.title, env: L.env, settings: L.settings });
        const run = await runSession(QUESTIONS, options, e);
        e("verdict", { run, wire: sumCalls(name), ttls: [...new Set(calls(name).flatMap((c) => c.breakpoints.map((b) => b.ttl)))] });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /breakers: new query() calls, one after the other, sharing one edition of the handbook.
// Which ones read what the first one wrote?
// ---------------------------------------------------------------------------------------------

// #region scenario-breakers
type Breaker = { title: string; system: (h: string) => Options["systemPrompt"]; question?: string; extra?: Partial<Options>; firstPartyUrl?: boolean; expect: "write" | "read" };
const B = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
export const BREAKERS: Record<string, Breaker> = {
  "br-cold": { title: "a · the first query(): nothing cached yet", system: (h) => h, expect: "write" },
  "br-same": { title: "b · a new query(), same system prompt, another question", system: (h) => h, question: "Which section covers chargebacks? One line.", expect: "read" },
  "br-time": { title: "c · a timestamp on the first line", system: (h) => `Current time: ${new Date().toISOString()}\n${h}`, expect: "write" },
  "br-tool": { title: "d · one more tool (Read)", system: (h) => h, extra: { tools: ["Read"] }, expect: "write" },
  "br-model": { title: "e · another model (sonnet)", system: (h) => h, extra: { model: "sonnet" }, expect: "write" },
  "br-suffix": { title: "f · a per-customer line appended to the prompt", system: (h) => `${h}\nCustomer: Initech (gold tier).`, expect: "write" },
  "br-bound-a": { title: "g · static + BOUNDARY + customer A (first-party URL)", system: (h) => [h, B, "Customer: ACME (gold tier)."], firstPartyUrl: true, expect: "write" },
  "br-bound-b": { title: "h · the same, customer B", system: (h) => [h, B, "Customer: Globex (silver tier)."], firstPartyUrl: true, expect: "read" },
  "br-bound-proxy": { title: "i · the same, customer C, behind a proxy URL", system: (h) => [h, B, "Customer: Umbrella (bronze tier)."], expect: "write" },
};

concept46.post(
  "/breakers",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    const h = handbook(newEdition()); // one edition for all lanes: they can share a cache
    // One after the other: a cache entry can be read only once the request that writes it has started answering.
    for (const [name, L] of Object.entries(BREAKERS)) {
      if (abort.signal.aborted) return;
      const e = lane(name);
      const systemPrompt = L.system(h);
      const options = laneOptions(name, {}, abort, { systemPrompt, ...L.extra }, L.firstPartyUrl);
      if (L.extra?.tools) options.allowedTools = [];
      e("options", { title: L.title, model: options.model, tools: options.tools, firstPartyUrl: !!L.firstPartyUrl, systemPrompt: Array.isArray(systemPrompt) ? systemPrompt.map((s) => (s === B ? "SYSTEM_PROMPT_DYNAMIC_BOUNDARY" : cut(s, 60))) : cut(String(systemPrompt), 60) });
      const run = await runSession([L.question ?? "Which section covers gift cards? One line."], options, e);
      e("verdict", { run, wire: sumCalls(name), expect: L.expect, system: calls(name)[0]?.systemBlocks ?? [] });
    }
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /model-switch: q.setModel() in the middle of a session. PreModelSwitch sees the price of the switch.
// ---------------------------------------------------------------------------------------------

// #region scenario-model-switch
/** A PreModelSwitch hook that allows the switch, or denies it when re-caching would cost more than `maxUsd`. */
function switchHooks(e: Emit, maxUsd?: number): Partial<Record<"PreModelSwitch" | "PostModelSwitch", HookCallbackMatcher[]>> {
  const pick = (i: any) => ({ from_model: i.from_model, to_model: i.to_model, source: i.source, context_tokens: i.context_tokens, prompt_cache_warm: i.prompt_cache_warm, cache_ttl: i.cache_ttl, estimated_cache_write_usd: i.estimated_cache_write_usd, pricing: i.pricing });
  return {
    PreModelSwitch: [
      {
        hooks: [
          async (input: any) => {
            const deny = maxUsd !== undefined && input.prompt_cache_warm && input.estimated_cache_write_usd > maxUsd;
            e("hook", { name: "PreModelSwitch", input: pick(input), decision: deny ? "deny" : "allow" });
            if (!deny) return {};
            return { hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: `Switching would re-cache ${input.context_tokens} tokens (about $${input.estimated_cache_write_usd}). Stay on ${input.from_model}.` } };
          },
        ],
      },
    ],
    PostModelSwitch: [{ hooks: [async (input: any) => (e("hook", { name: "PostModelSwitch", input: pick(input) }), {})] }],
  };
}

concept46.post(
  "/model-switch",
  sseRoute(z.object({}).strict(), async (_b, abort, lane) => {
    const LANES: [string, number | undefined][] = [
      ["ms-allow", undefined], // the hook only reports
      ["ms-deny", 0.01], // the hook denies a switch that would re-cache more than one cent
    ];
    await Promise.all(
      LANES.map(async ([name, maxUsd]) => {
        const e = lane(name);
        const options = laneOptions(name, {}, abort, { systemPrompt: handbook(newEdition()), hooks: switchHooks(e, maxUsd) });
        e("options", { model: MODEL, then: 'q.setModel("sonnet") after turn 1', hook: maxUsd === undefined ? "PreModelSwitch: report only" : `PreModelSwitch: deny when estimated_cache_write_usd > ${maxUsd}` });
        const run = await runSession(QUESTIONS.slice(0, 3), options, e, async (n, q) => {
          if (n !== 1) return;
          try {
            await q.setModel("sonnet");
            e("setModel", { ok: true });
          } catch (err) {
            e("setModel", { ok: false, error: errText(err) }); // a denied switch rejects setModel()
          }
        });
        e("verdict", { run, models: [...new Set(calls(name).map((c) => c.model))] });
      }),
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept46.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
