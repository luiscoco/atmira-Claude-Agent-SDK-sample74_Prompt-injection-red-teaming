// Billed: calls the refund desk with the real agent from the command line, e.g.
//   node --env-file-if-exists=.env --import tsx server/agent-mcp/live-check.ts call:O-206 delegate:O-201,O-204,O-206 stdio:O-203
// call:<id>       an MCP client calls review_refund over HTTP (progress printed as it arrives)
// delegate:<ids>  an outer query() agent uses the desk as its http MCP server
// stdio:<id>      starts server/agent-mcp/stdio.ts as a child process and calls it over stdio
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { concept61 } from "../concepts/61-agent-as-mcp-server.js";
import { orderById, policyDecision, sampleMessages } from "./desk.js";

const app = express(); app.use(express.json()); app.use("/api/c61", concept61);
const server = app.listen(0); const base = `http://localhost:${(server.address() as any).port}/api/c61`;
async function sse(route: string, body: unknown) {
  const res = await fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { console.log(res.status, await res.text()); return; }
  for (const chunk of (await res.text()).split("\n\n").filter(Boolean)) {
    const event = chunk.match(/^event: (.*)$/m)?.[1]; const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "null");
    if (event === "done") continue;
    if (event === "init") console.log(` init mcp_servers=${JSON.stringify(data.mcp_servers)} tools=${JSON.stringify(data.tools)}`);
    else console.log(` ${event} ${JSON.stringify(data).slice(0, 600)}`);
  }
}
for (const arg of process.argv.slice(2)) {
  const [kind, value] = arg.split(":");
  console.log(`== ${arg}`);
  if (kind === "call") await sse("call", { orderId: value, customerMessage: sampleMessages[value] });
  else if (kind === "delegate") await sse("delegate", { orderIds: value.split(",") });
  else if (kind === "stdio") {
    const facts = await (await fetch(`${base}/facts`)).json();
    const client = new Client({ name: "live-check", version: "1.0.0" });
    const started = Date.now();
    await client.connect(new StdioClientTransport({ command: process.execPath, args: facts.config.stdio.args, env: process.env as Record<string, string>, stderr: "inherit" }));
    const result = await client.callTool({ name: "review_refund", arguments: { orderId: value, customerMessage: sampleMessages[value] } }, undefined, { timeout: 120_000, onprogress: (p) => console.log(`   progress ${p.progress} ${p.message} +${Date.now() - started} ms`) });
    console.log(` result ${JSON.stringify(result)} expected ${JSON.stringify(policyDecision(orderById(value)!))}`);
    await client.close();
  }
}
console.log(`== server log: ${JSON.stringify(await (await fetch(`${base}/log`)).json()).slice(0, 300)}`);
server.close();
