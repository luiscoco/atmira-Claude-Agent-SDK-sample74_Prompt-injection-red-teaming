/**
 * The refund desk over stdio: the client (Claude Code, Claude Desktop, an Agent SDK query()) starts this file as a
 * child process and speaks JSON-RPC on its stdin/stdout.
 *
 *   claude mcp add refund-desk -- node --import <tsx loader URL> <absolute path to this file>
 *
 * stdout belongs to the protocol: a single console.log() here would corrupt it. Log to stderr only.
 * REFUND_DESK_FAKE=1 swaps the agent for the scripted runner (no model calls), handy for wiring a client up.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildDeskServer, DeskState, scriptedRunner } from "./desk.js";
import { realRunner } from "./agent.js";

console.log = console.error; // anything an import prints goes to stderr, never into the protocol stream
const fake = process.env.REFUND_DESK_FAKE === "1";
const server = buildDeskServer(fake ? scriptedRunner("ok", 200) : realRunner, new DeskState(), "stdio");
await server.connect(new StdioServerTransport());
console.error(`refund-desk MCP server on stdio (${fake ? "scripted runner, no model calls" : "real agent"})`);
