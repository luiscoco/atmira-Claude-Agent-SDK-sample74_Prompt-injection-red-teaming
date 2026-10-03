/**
 * CONCEPT 13 — an EXTERNAL MCP server over stdio
 *
 * This file is NOT imported by the lab's server. It is a separate Node program. Claude Code starts it as a child
 * process when a query() lists it in `mcpServers`:
 *
 *   notes: { type: "stdio", command: process.execPath, args: ["--import", "tsx", "mcp-servers/notes-server.ts"], env: {...} }
 *
 * and talks JSON-RPC with it over stdin/stdout. So:
 * - stdout belongs to the protocol: never console.log() here (it would corrupt the JSON-RPC stream). Use stderr.
 * - Its configuration arrives through `env` (NOTES_DIR, LAB_LOG_URL), not through function arguments.
 * - It could be written in any language: Claude Code only sees a process that speaks MCP.
 *
 * To show when it runs, it POSTs a small log line to the lab server (LAB_LOG_URL), if that variable is set.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const NOTES_DIR = process.env.NOTES_DIR ?? process.cwd();
const LOG_URL = process.env.LAB_LOG_URL;
const startedAt = Date.now();

/** Fire-and-forget: the lab's browser tab shows these lines as "notes (stdio) process" events. */
function log(method: string, detail?: unknown) {
  if (!LOG_URL) return;
  fetch(LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "notes", transport: "stdio", pid: process.pid, method, detail }),
  }).catch(() => {});
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

async function noteFiles() {
  const entries = await readdir(NOTES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name)).map((e) => e.name);
}

const server = new McpServer(
  { name: "lab-notes", version: "1.0.0" },
  { instructions: "Read-only access to the plain-text notes of the lab's sandbox folder." },
);

server.registerTool(
  "list_notes",
  {
    description: "List the note files (.txt and .md) in the notes folder.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    const files = await noteFiles();
    log("tools/call list_notes", { files });
    return text(files);
  },
);

server.registerTool(
  "search_notes",
  {
    description: "Find every line in the notes that contains a text (case-insensitive). Returns file, line number and line.",
    inputSchema: { text: z.string().min(2).describe("Text to look for, at least 2 characters") },
    annotations: { readOnlyHint: true },
  },
  async ({ text: needle }) => {
    const hits: { file: string; line: number; text: string }[] = [];
    for (const file of await noteFiles()) {
      const lines = (await readFile(path.join(NOTES_DIR, file), "utf8")).split(/\r?\n/);
      lines.forEach((line, i) => line.toLowerCase().includes(needle.toLowerCase()) && hits.push({ file, line: i + 1, text: line }));
    }
    log("tools/call search_notes", { text: needle, hits: hits.length });
    return text(hits);
  },
);

server.registerTool(
  "server_process",
  {
    description: "Describe the process this MCP server runs in: pid, parent pid, uptime, working directory and configuration.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    const info = {
      pid: process.pid,
      parentPid: process.ppid, // the Claude Code process, not the lab's Node server
      uptimeMs: Date.now() - startedAt,
      cwd: process.cwd(),
      notesDir: NOTES_DIR,
      // Only whether they are set: never send secrets to the model.
      envReceived: {
        NOTES_DIR: Object.hasOwn(process.env, "NOTES_DIR"),
        LAB_LOG_URL: Object.hasOwn(process.env, "LAB_LOG_URL"),
        ANTHROPIC_API_KEY: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
      },
    };
    log("tools/call server_process", info);
    return text(info);
  },
);

await server.connect(new StdioServerTransport());
log("process started", { parentPid: process.ppid, cwd: process.cwd() });
console.error(`lab-notes MCP server running on stdio (pid ${process.pid})`); // stderr: safe
