/**
 * CONCEPT 24 — Harnesses: the loop around the model, written by you, by the Tool Runner, or by Claude Code
 *
 * The model only ever answers one request. Everything that makes it an AGENT is the harness around it: send the
 * request, run the tools it asked for, send the results back, stop at the right time, check permissions, keep the
 * conversation. This concept runs the SAME tools and the SAME prompt through three harnesses:
 *
 *   manual   @anthropic-ai/sdk  client.messages.create() in a while loop you write       (you own everything)
 *   runner   @anthropic-ai/sdk  client.beta.messages.toolRunner() + betaZodTool()        (the SDK owns the loop)
 *   sdk      @anthropic-ai/claude-agent-sdk  query() + createSdkMcpServer() + tool()     (Claude Code is the harness)
 *
 * @anthropic-ai/sdk is the plain Claude API client. It was already in node_modules as a dependency of the Agent SDK,
 * and it is now listed in package.json. Both clients read ANTHROPIC_API_KEY from .env.
 *
 * Switches (names only, from the browser): gate (a policy that denies large reservations), limit (at most 2 model
 * calls), claudeCode (the SDK harness gets Claude Code's system prompt and built-in tools; the other two cannot).
 *
 * Routes: GET /tools, GET /code, POST /run (SSE, one harness per request: the tab opens three at once).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { createSdkMcpServer, query, tool, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept24 = Router();

const MODEL = "claude-haiku-4-5-20251001"; // the same model in the three harnesses, so the numbers compare
const MAX_TOKENS = 16000;
const MAX_TURNS = 10; // every harness needs a stop, even when nobody asked for one
const MAX_RUN_MS = 120_000;
const MAX_PROMPT = 2000;
const SYSTEM = "You are the Atmira shop assistant. Use the tools to answer. Be brief: at most 5 lines.";

// Haiku 4.5 prices per million tokens. The Agent SDK computes total_cost_usd itself; for the two API harnesses
// the lab computes it from `usage`, the way you would in your own harness.
const PRICE = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

// The SDK harness gets a cwd with one file, so that with `claudeCode` its built-in Read/Grep have something to find.
const LAB = path.resolve("harness-lab");
function resetLab() {
  rmSync(LAB, { recursive: true, force: true });
  mkdirSync(path.join(LAB, "docs"), { recursive: true });
  writeFileSync(
    path.join(LAB, "docs", "returns-policy.md"),
    "# Returns policy\n\nCustomers can return any product within 30 days. Headsets must be unopened.\nRefunds go back to the original payment method within 5 working days.\n",
  );
}
resetLab();

// #region tools
// ---------------------------------------------------------------------------------------------
// The tools, written ONCE: a zod schema and a plain function. Each harness below wraps them in its own shape.
// ---------------------------------------------------------------------------------------------

type Product = { sku: string; name: string; price: number; stock: Record<string, number> };
const CATALOG: Product[] = [
  { sku: "KB-101", name: "Mechanical keyboard", price: 89, stock: { madrid: 12, lisbon: 0 } },
  { sku: "MS-202", name: "Wireless mouse", price: 29, stock: { madrid: 40, lisbon: 15 } },
  { sku: "HS-303", name: "Noise-cancelling headset", price: 149, stock: { madrid: 3, lisbon: 6 } },
  { sku: "MN-404", name: "27-inch monitor", price: 279, stock: { madrid: 0, lisbon: 2 } },
];

/** Each run gets its own copy of the catalog, so reservations in one harness don't change the others. */
const newShop = () => structuredClone(CATALOG);
type Shop = Product[];

const SHOP_TOOLS = {
  search_products: {
    description: "Search the catalog by words in the product name. Returns sku, name and price.",
    schema: z.object({ query: z.string().min(1).describe("Words to look for, e.g. 'keyboard'") }),
    run: (shop: Shop, { query }: { query: string }) => {
      const words = query.toLowerCase().split(/\s+/);
      return shop.filter((p) => words.some((w) => p.name.toLowerCase().includes(w))).map(({ sku, name, price }) => ({ sku, name, price }));
    },
  },
  get_stock: {
    description: "Units in stock per warehouse for one sku.",
    schema: z.object({ sku: z.string().describe("A sku such as KB-101") }),
    run: (shop: Shop, { sku }: { sku: string }) => {
      const p = shop.find((x) => x.sku === sku);
      if (!p) throw new Error(`Unknown sku ${sku}. Known: ${shop.map((x) => x.sku).join(", ")}`); // each harness must turn this into a tool error
      return { sku, stock: p.stock };
    },
  },
  reserve_stock: {
    description: "Reserve units of a sku in one warehouse for a customer order. Changes the stock.",
    // .max(100): without it, zod's int() writes "maximum": 9007199254740991 (the largest safe integer) into the schema.
    schema: z.object({ sku: z.string(), warehouse: z.enum(["madrid", "lisbon"]), qty: z.number().int().positive().max(100) }),
    run: (shop: Shop, { sku, warehouse, qty }: { sku: string; warehouse: "madrid" | "lisbon"; qty: number }) => {
      const p = shop.find((x) => x.sku === sku);
      if (!p) throw new Error(`Unknown sku ${sku}`);
      if (p.stock[warehouse] < qty) throw new Error(`Only ${p.stock[warehouse]} units of ${sku} in ${warehouse}`);
      p.stock[warehouse] -= qty;
      return { reserved: qty, sku, warehouse, left: p.stock[warehouse] };
    },
  },
};
type ToolName = keyof typeof SHOP_TOOLS;
const TOOL_NAMES = Object.keys(SHOP_TOOLS) as ToolName[];

/** The host's approval policy (the `gate` switch). Returns a reason to deny, or null to allow. */
function policy(name: string, input: any): string | null {
  if (name.endsWith("reserve_stock") && input?.qty > 5) return `Policy: reservations over 5 units need a manager (asked for ${input.qty}).`;
  return null;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// What every harness reports to the browser, in one shape, so the three columns can be compared.
// ---------------------------------------------------------------------------------------------

type Send = (event: string, data: unknown) => void;
type Setup = { prompt: string; gate: boolean; limit: boolean; claudeCode: boolean; signal: AbortSignal; send: Send };
type Totals = { input: number; output: number; cacheWrite: number; cacheRead: number };
const addUsage = (t: Totals, u: Anthropic.Usage | Anthropic.Beta.BetaUsage) => {
  t.input += u.input_tokens;
  t.output += u.output_tokens;
  t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  t.cacheRead += u.cache_read_input_tokens ?? 0;
};
const costOf = (t: Totals) => (t.input * PRICE.input + t.output * PRICE.output + t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6;
const textOf = (content: { type: string }[]) =>
  content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
const toolUsesOf = (content: { type: string }[]) =>
  content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input }));

// #region manual
// ---------------------------------------------------------------------------------------------
// Harness 1: the manual loop. Every line of agent behaviour is here, because nobody else writes it.
// ---------------------------------------------------------------------------------------------

const manualTools: Anthropic.Tool[] = TOOL_NAMES.map((name) => ({
  name,
  description: SHOP_TOOLS[name].description,
  input_schema: z.toJSONSchema(SHOP_TOOLS[name].schema) as Anthropic.Tool.InputSchema, // you convert the schema
}));

async function runManual({ prompt, gate, limit, signal, send }: Setup) {
  const client = new Anthropic();
  const shop = newShop();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]; // YOU hold the conversation
  const totals: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const maxTurns = limit ? 2 : MAX_TURNS;
  let turns = 0;
  let toolCalls = 0;
  let stop = "";
  let answer = "";

  while (true) {
    if (turns >= maxTurns) {
      stop = `your turn counter (${maxTurns})`; // without this check, a confused model loops forever
      break;
    }
    turns++;
    const response = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: manualTools, messages }, { signal });
    addUsage(totals, response.usage);
    answer = textOf(response.content);
    send("step", { kind: "response", n: turns, stop_reason: response.stop_reason, text: answer, tool_uses: toolUsesOf(response.content), usage: response.usage });

    messages.push({ role: "assistant", content: response.content }); // keep every answer, or a follow-up loses it
    if (response.stop_reason === "pause_turn") continue; // resend to continue
    if (response.stop_reason !== "tool_use") {
      stop = `stop_reason "${response.stop_reason}"`; // end_turn, max_tokens, refusal...: the model is done
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
      toolCalls++;
      const result = executeManual(shop, call, gate);
      send("step", { kind: "tool", name: call.name, input: call.input, ...result });
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.is_error });
    }
    messages.push({ role: "user", content: results }); // ALL results of one turn in ONE user message
  }
  send("context", { owner: "your messages array", messages });
  return { turns, toolCalls, totals, cost: costOf(totals), stop, answer };
}

/** Find the tool, validate the input, apply the policy, run it, and turn any error into an is_error result. */
function executeManual(shop: Shop, call: Anthropic.ToolUseBlock, gate: boolean) {
  const def = SHOP_TOOLS[call.name as ToolName];
  if (!def) return { content: `Unknown tool ${call.name}`, is_error: true };
  const parsed = def.schema.safeParse(call.input); // the API does not guarantee the input matches the schema
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, is_error: true };
  const denied = gate ? policy(call.name, parsed.data) : null;
  if (denied) return { content: denied, is_error: true, denied: true };
  try {
    return { content: JSON.stringify(def.run(shop, parsed.data as any)), is_error: false };
  } catch (err) {
    return { content: String(err instanceof Error ? err.message : err), is_error: true };
  }
}
// #endregion

// #region runner
// ---------------------------------------------------------------------------------------------
// Harness 2: the Tool Runner. You write the tools; the SDK sends the requests, runs the tools (validated with the
// zod schema), turns thrown errors into is_error results, and stops when the model stops asking for tools.
// ---------------------------------------------------------------------------------------------

async function runRunner({ prompt, gate, limit, signal, send }: Setup) {
  const client = new Anthropic();
  const shop = newShop();
  let toolCalls = 0;

  const tools = TOOL_NAMES.map((name) =>
    betaZodTool({
      name,
      description: SHOP_TOOLS[name].description,
      inputSchema: SHOP_TOOLS[name].schema,
      run: async (input) => {
        toolCalls++;
        // The approval gate lives INSIDE the tool: throw a ToolError and the runner sends it as an is_error result.
        const denied = gate ? policy(name, input) : null;
        if (denied) {
          send("step", { kind: "tool", name, input, content: denied, is_error: true, denied: true });
          throw new ToolError(denied);
        }
        try {
          const content = JSON.stringify(SHOP_TOOLS[name].run(shop, input as any));
          send("step", { kind: "tool", name, input, content, is_error: false });
          return content;
        } catch (err) {
          send("step", { kind: "tool", name, input, content: String(err instanceof Error ? err.message : err), is_error: true });
          throw err; // the runner catches it and sends "Error: <message>" with is_error: true
        }
      },
    }),
  );

  const runner = client.beta.messages.toolRunner(
    { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools, messages: [{ role: "user", content: prompt }], max_iterations: limit ? 2 : MAX_TURNS },
    { signal },
  );

  const totals: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let turns = 0;
  let last: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    // One iteration = one API response. The runner runs the tools AFTER this yield, before the next request.
    turns++;
    last = message;
    addUsage(totals, message.usage);
    send("step", { kind: "response", n: turns, stop_reason: message.stop_reason, text: textOf(message.content), tool_uses: toolUsesOf(message.content), usage: message.usage });
  }
  const stop = last?.stop_reason === "tool_use" ? `max_iterations (${limit ? 2 : MAX_TURNS})` : `stop_reason "${last?.stop_reason}"`;
  send("context", { owner: "runner.params.messages", messages: runner.params.messages });
  return { turns, toolCalls, totals, cost: costOf(totals), stop, answer: last ? textOf(last.content) : "" };
}
// #endregion

// #region sdk
// ---------------------------------------------------------------------------------------------
// Harness 3: the Agent SDK. Claude Code runs the loop in its own process. You give it tools as an MCP server,
// a permission callback, a turn limit, and read the messages it streams back.
// ---------------------------------------------------------------------------------------------

async function runSdk({ prompt, gate, limit, claudeCode, signal, send }: Setup) {
  const shop = newShop();
  let toolCalls = 0;

  const server = createSdkMcpServer({
    name: "shop",
    version: "1.0.0",
    // With Claude Code's 37 built-in tools, MCP tools are deferred behind ToolSearch: the model must load them first,
    // and in the tests Haiku then tried to call them through PowerShell. alwaysLoad keeps them in the prompt.
    alwaysLoad: true,
    tools: TOOL_NAMES.map((name) =>
      tool(name, SHOP_TOOLS[name].description, SHOP_TOOLS[name].schema.shape, async (input) => {
        toolCalls++;
        const mcpName = `mcp__shop__${name}`; // the name the model called
        try {
          const content = JSON.stringify(SHOP_TOOLS[name].run(shop, input as any));
          send("step", { kind: "tool", name: mcpName, input, content, is_error: false });
          return { content: [{ type: "text", text: content }] };
        } catch (err) {
          const content = String(err instanceof Error ? err.message : err);
          send("step", { kind: "tool", name: mcpName, input, content, is_error: true });
          return { content: [{ type: "text", text: content }], isError: true };
        }
      }),
    ),
  });

  // The approval gate is a harness feature: canUseTool is asked for every tool not already in allowedTools.
  const canUseTool: CanUseTool = async (toolName, input) => {
    const denied = gate ? policy(toolName, input) : null;
    if (denied) {
      toolCalls++;
      send("step", { kind: "tool", name: toolName, input, content: denied, is_error: true, denied: true });
      return { behavior: "deny", message: denied };
    }
    if (!toolName.startsWith("mcp__shop__") && !["Read", "Glob", "Grep"].includes(toolName)) {
      return { behavior: "deny", message: `${toolName} is not allowed in this lab.` }; // no Bash, Write, WebFetch...
    }
    return { behavior: "allow", updatedInput: input };
  };

  const options: Options = {
    model: MODEL,
    thinking: { type: "disabled" },
    systemPrompt: claudeCode ? { type: "preset", preset: "claude_code", append: SYSTEM } : SYSTEM,
    tools: claudeCode ? { type: "preset", preset: "claude_code" } : [], // [] = no built-in tools, like the other two
    mcpServers: { shop: server },
    strictMcpConfig: true,
    allowedTools: ["mcp__shop__search_products", "mcp__shop__get_stock", "Read", "Glob", "Grep"], // reserve_stock asks canUseTool
    canUseTool,
    maxTurns: limit ? 2 : MAX_TURNS,
    cwd: LAB,
    settingSources: [],
    // The claude_code preset turns on auto memory (Concept 22), which creates ~/.claude/projects/<cwd>/memory/ even
    // with persistSession: false. The lab doesn't need it.
    settings: { autoMemoryEnabled: false },
    persistSession: false,
    abortController: abortFrom(signal),
  };
  send("options", { ...options, mcpServers: { shop: { type: "sdk", name: "shop", instance: "[McpServer]" } }, canUseTool: "[Function canUseTool]", abortController: "[AbortController]", cwd: "harness-lab" });

  const ids = new Map<string, number>(); // the SDK streams one assistant message per content block: group them by id
  const builtinCalls = new Map<string, string>(); // tool_use id -> name, for the tools Claude Code runs itself
  let result: any;
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === "system" && msg.subtype === "init") {
        send("step", { kind: "init", tools: msg.tools, model: msg.model, permissionMode: msg.permissionMode });
      }
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        if (!ids.has(msg.message.id)) ids.set(msg.message.id, ids.size + 1);
        for (const b of msg.message.content) if (b.type === "tool_use" && !b.name.startsWith("mcp__shop__")) builtinCalls.set(b.id, b.name);
        send("step", { kind: "response", n: ids.get(msg.message.id), stop_reason: msg.message.stop_reason, text: textOf(msg.message.content), tool_uses: toolUsesOf(msg.message.content), usage: msg.message.usage });
      }
      // Built-in tools (Read, Glob…) run inside Claude Code, so no handler of yours reports them: read their results here.
      if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content as any[]) {
          if (b.type !== "tool_result" || !builtinCalls.has(b.tool_use_id)) continue;
          toolCalls++;
          const content = typeof b.content === "string" ? b.content : textOf(b.content ?? []);
          send("step", { kind: "tool", name: builtinCalls.get(b.tool_use_id), input: null, content, is_error: !!b.is_error, builtin: true });
        }
      }
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    // After an error result (error_max_turns...), the iterator also THROWS. The result message came first: keep it.
    if (!result) throw err;
    send("step", { kind: "thrown", message: String(err) });
  }
  if (!result) throw new Error("query() ended without a result message."); // e.g. the run was stopped
  // result.usage counts the calls that answered YOUR prompt. modelUsage counts everything the harness spent (in the
  // tests, runs with tool calls had about 900 input tokens more there), and total_cost_usd is priced from it.
  const totals: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const m of Object.values(result.modelUsage ?? {}) as any[]) {
    totals.input += m.inputTokens;
    totals.output += m.outputTokens;
    totals.cacheWrite += m.cacheCreationInputTokens;
    totals.cacheRead += m.cacheReadInputTokens;
  }
  send("context", { owner: "the Claude Code process (not your code)", messages: null });
  return {
    turns: ids.size, // distinct assistant messages = model calls for your prompt
    toolCalls,
    totals,
    cost: result.total_cost_usd, // the harness prices it for you
    stop: `result "${result.subtype}"`,
    answer: result.subtype === "success" ? result.result : "",
    sdk: { num_turns: result.num_turns, resultUsageInput: result.usage.input_tokens, resultUsageOutput: result.usage.output_tokens },
  };
}
// #endregion

/** query() takes an AbortController, the API clients take an AbortSignal: bridge the request's signal to both. */
function abortFrom(signal: AbortSignal) {
  const ctrl = new AbortController();
  signal.addEventListener("abort", () => ctrl.abort());
  return ctrl;
}

const HARNESSES = { manual: runManual, runner: runRunner, sdk: runSdk };

// The request body: a harness name, a prompt, and switch names only.
const RunBody = z
  .object({
    harness: z.enum(["manual", "runner", "sdk"]),
    prompt: z.string().trim().min(1).max(MAX_PROMPT),
    switches: z.array(z.enum(["gate", "limit", "claudeCode"])).max(3).default([]),
  })
  .strict();

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// ---------------------------------------------------------------------------------------------
// GET /tools: one tool in the shape each harness needs
// ---------------------------------------------------------------------------------------------

concept24.get("/tools", (_req, res) => {
  const name: ToolName = "reserve_stock";
  const def = SHOP_TOOLS[name];
  const runnable = betaZodTool({ name, description: def.description, inputSchema: def.schema, run: () => "" });
  res.json({
    name,
    manual: manualTools.find((t) => t.name === name),
    runner: { ...runnable, run: "[Function run]", parse: "[Function parse: zod schema.parse]" },
    sdk: { mcpName: `mcp__shop__${name}`, description: def.description, inputSchema: z.toJSONSchema(def.schema), handler: "[Function handler]" },
  });
});

// ---------------------------------------------------------------------------------------------
// GET /code: the harness code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept24.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, code]) => [name, code.trimEnd()])));
});

// ---------------------------------------------------------------------------------------------
// POST /run: one harness, streamed. The tab opens three of these at the same time.
// ---------------------------------------------------------------------------------------------

concept24.post("/run", async (req, res) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  const { abort, send } = openSse(req, res);
  const finish = () => {
    send("done", {});
    res.end();
  };
  if (!parsed.success) {
    send("error", { message: badRequest(parsed.error) });
    return finish();
  }
  const { harness, prompt, switches } = parsed.data;
  const setup: Setup = { prompt, gate: switches.includes("gate"), limit: switches.includes("limit"), claudeCode: switches.includes("claudeCode"), signal: abort.signal, send };

  const label = `[c24] ${harness} ${JSON.stringify(prompt.slice(0, 40))} switches=${switches.join(",") || "-"}`;
  console.log(`${label} started`);
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  const started = Date.now();
  try {
    const summary = await HARNESSES[harness](setup);
    send("summary", { ...summary, duration_ms: Date.now() - started });
    console.log(`${label} turns=${summary.turns} tools=${summary.toolCalls} $${summary.cost.toFixed(4)} ${summary.stop}`);
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: String(err) });
  } finally {
    clearTimeout(timer);
    finish();
  }
});
