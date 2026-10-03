/**
 * The plugin's MCP server (stdio). Declared in ../.mcp.json, so Claude Code starts it when the plugin loads:
 *
 *   "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/tickets.mjs"]
 *
 * ${CLAUDE_PLUGIN_ROOT} is the plugin's folder, wherever it is installed. Its tools reach the model as
 * mcp__plugin_atmira-ops_tickets__<tool>. stdout is the JSON-RPC stream: never console.log() here.
 */
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FILE = process.env.TICKETS_FILE;
const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const tickets = async () => JSON.parse(await readFile(FILE, "utf8"));

const server = new McpServer({ name: "atmira-tickets", version: "2.1.0" });

server.registerTool(
  "list_tickets",
  { description: "List every ticket: id, title, priority and status.", annotations: { readOnlyHint: true } },
  async () => text((await tickets()).map(({ id, title, priority, status }) => ({ id, title, priority, status }))),
);

server.registerTool(
  "get_ticket",
  {
    description: "Get one ticket with its description.",
    inputSchema: { id: z.string().describe("Ticket id, e.g. ATM-101") },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => {
    const ticket = (await tickets()).find((t) => t.id === id.toUpperCase());
    return ticket ? text(ticket) : { content: [{ type: "text", text: `No ticket ${id}` }], isError: true };
  },
);

// What the process was started with: shows that ${CLAUDE_PLUGIN_ROOT} and ${user_config.team} were substituted.
server.registerTool(
  "server_info",
  { description: "Show how the tickets server was started (team, data file, pid).", annotations: { readOnlyHint: true } },
  async () => text({ team: process.env.ATMIRA_TEAM, ticketsFile: FILE, pid: process.pid }),
);

await server.connect(new StdioServerTransport());
