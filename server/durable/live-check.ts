// Billed: runs lesson 60 jobs from the command line and prints every supervisor event, e.g.
//   node --env-file-if-exists=.env --import tsx server/durable/live-check.ts clean crash:3 wipe:3 recover:<jobId>
// clean = no drill; crash:N = kill the worker after the Nth side effect; wipe:N = the same, and delete the local transcripts.
// TURNS=6 sets maxTurns per segment.
import express from "express";
import { concept60 } from "../concepts/60-durable-agents.js";
const app = express(); app.use(express.json()); app.use("/api/c60", concept60);
const server = app.listen(0); const port = (server.address() as any).port; const base = `http://localhost:${port}/api/c60`;
const segmentTurns = Number(process.env.TURNS ?? 6);
async function sse(route: string, body: unknown) {
  const res = await fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { console.log(res.status, await res.text()); return; }
  let last: any;
  for (const chunk of (await res.text()).split("\n\n").filter(Boolean)) {
    const event = chunk.match(/^event: (.*)$/m)?.[1]; const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "null");
    if (event === "journal") { last = data; continue; }
    if (event === "heartbeat" || event === "done") continue;
    if (event === "tool") console.log(`   tool ${data.name} ${JSON.stringify(data.input)}`);
    else if (event === "segment") console.log(` segment ${data.n} ${data.mode} resume=${data.resume ?? "-"}`);
    else console.log(` ${event} ${JSON.stringify(data)}`);
  }
  if (last) console.log(` final ${last.jobId} ${last.status} settled ${last.settledCount}/${last.total} correct ${last.correct} effects ${last.effects.length} cost $${last.costUsd.toFixed(4)} segments ${last.segments.map((s: any) => `${s.n}:${s.mode}:${s.outcome}->${s.action}`).join(" ")}`);
}
for (const arg of process.argv.slice(2)) {
  const [kind, value] = arg.split(":");
  console.log(`== ${arg}`);
  if (kind === "recover") await sse("recover", { jobId: value, segmentTurns });
  else await sse("run", { segmentTurns, ...(kind === "crash" || kind === "wipe" ? { crashAfter: Number(value) } : {}), wipeLocal: kind === "wipe" });
}
server.close();
