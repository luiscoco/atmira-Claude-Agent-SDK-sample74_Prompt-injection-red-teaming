/** Lesson 51: deterministic tests of agent code. This router never imports or calls query(). */
import { readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { openSse } from "../sse.js";
import { cases, runCase } from "../testing/cases.js";
import { fakeQuery, transcripts } from "../testing/fixtures.js";
import { runAgent } from "../testing/host.js";

export const concept51 = Router();
const groups = ["all", "tools", "policy", "streams"] as const;
const scenarios = ["success", "complete", "subagent", "budget", "apiError", "invalid", "truncated", "throw", "wait"] as const;

concept51.get("/facts", (_req, res) => res.json({
  cases: cases.map(({ id, name, group, purpose }) => ({ id, name, group, purpose })),
  groups, scenarios, modelApiCalls: 0,
  command: "npm run test:offline",
  boundary: "Real tools, store, hooks and permission callbacks; synthetic SDK messages; no query() or Claude Code process.",
}));

// #region suite-route
concept51.post("/run", async (req, res) => {
  const parsed = z.object({ group: z.enum(groups).default("all"), mutation: z.boolean().default(false) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { abort, send } = openSse(req, res);
  const selected = cases.filter((c) => parsed.data.group === "all" || c.group === parsed.data.group);
  let passed = 0;
  let failed = 0;
  const start = performance.now();
  try {
    send("start", { total: selected.length, mutation: parsed.data.mutation });
    for (const testCase of selected) {
      if (abort.signal.aborted) break;
      const result = await runCase(testCase, parsed.data.mutation);
      if (result.passed) passed++; else failed++;
      if (!abort.signal.aborted) send("case", result);
    }
    if (!abort.signal.aborted) send("summary", { passed, failed, total: selected.length, durationMs: performance.now() - start, modelApiCalls: 0 });
  } catch (error) {
    if (!abort.signal.aborted) send("error", { message: String(error) });
  } finally { res.end(); }
});
// #endregion

// #region replay-route
concept51.post("/replay", async (req, res) => {
  const parsed = z.object({ scenario: z.enum(scenarios), mutation: z.boolean().default(false) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { abort, send } = openSse(req, res);
  try {
    send("fixture", { scenario: parsed.data.scenario, messages: parsed.data.scenario in transcripts ? transcripts[parsed.data.scenario as keyof typeof transcripts] : [], synthetic: true });
    const result = await runAgent(fakeQuery(parsed.data.scenario), { prompt: "Refund one broken mug", signal: abort.signal, timeoutMs: 1000 },
      (text) => { if (!abort.signal.aborted) send("delta", { text }); }, parsed.data.mutation);
    if (!abort.signal.aborted) send("result", result);
  } catch (error) {
    if (!abort.signal.aborted) send("error", { message: String(error) });
  } finally { res.end(); }
});
// #endregion

concept51.get("/code", (_req, res) => {
  const out: Record<string, string> = {};
  for (const file of ["host.ts", "fixtures.ts", "mcp.ts", "cases.ts", "offline.test.ts"]) {
    out[file] = readFileSync(new URL(`../testing/${file}`, import.meta.url), "utf8");
  }
  res.json(out);
});
