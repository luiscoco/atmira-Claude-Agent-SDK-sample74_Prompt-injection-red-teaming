// Billed: runs lesson 59 strategies from the command line, e.g.
//   node --env-file-if-exists=.env --import tsx server/routing/live-check.ts models resolution delegate haiku sonnet opus opus-low rules classifier cascade review
// TASKS=lineup,multiply limits the task set. Prints one line per task and one summary per strategy.
import express from "express";
import { concept59 } from "../concepts/59-model-routing.js";
const app = express(); app.use(express.json()); app.use("/api/c59", concept59);
const server = app.listen(0); const port = (server.address() as any).port; const base = `http://localhost:${port}/api/c59`;
async function sse(route: string, body: unknown) {
  const res = await fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text(); const events = text.split("\n\n").filter(Boolean).map((c) => ({ event: c.match(/^event: (.*)$/m)?.[1], data: JSON.parse(c.match(/^data: (.*)$/m)?.[1] ?? "null") }));
  return events;
}
const which = process.argv.slice(2);
if (which.includes("models")) console.log(JSON.stringify(await (await fetch(`${base}/models`)).json()));
if (which.includes("resolution")) console.log(JSON.stringify(await (await fetch(`${base}/resolution`, { method: "POST" })).json(), null, 1));
if (which.includes("delegate")) { const ev = await sse("delegate", { expertModel: "claude-opus-5-5" }); for (const e of ev) if (["delegation", "summary", "error"].includes(e.event!)) console.log(e.event, JSON.stringify(e.data)); }
for (const s of which.filter((w) => !["models", "resolution", "delegate"].includes(w))) {
  const ev = await sse("run", { strategy: s, ...(process.env.TASKS ? { taskIds: process.env.TASKS.split(",") } : {}) });
  for (const e of ev) {
    if (e.event === "task") console.log(` ${s} ${e.data.task.padEnd(11)} ${e.data.label.padEnd(8)} ${e.data.route.join("->").padEnd(36)} ${e.data.correct ? "OK " : "BAD"} ${JSON.stringify(e.data.answer).slice(0, 40).padEnd(26)} $${e.data.costUsd.toFixed(4)} ${e.data.ms}ms ${e.data.status} ${e.data.usage.map((u: any) => u.model).join("+")}`);
    if (e.event === "summary" || e.event === "error") console.log(e.event, JSON.stringify(e.data));
  }
}
server.close();
