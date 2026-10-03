/**
 * CONCEPT 5 — Custom tools: createSdkMcpServer + tool() with zod
 *
 * Built-in tools (Concept 3) are Claude Code's. Custom tools are YOURS: a function in this Node process that
 * the model can call. The SDK wraps them in an in-process MCP server, so no extra process or port is needed.
 *
 *   tool(name, description, zodShape, handler, { annotations? })  -> SdkMcpToolDefinition
 *   createSdkMcpServer({ name, version, tools })                  -> { type: "sdk", name, instance }
 *   options.mcpServers = { tasks: server }                        -> the model sees "mcp__tasks__add_task"
 *
 * - The zod shape becomes the tool's JSON Schema, and it is checked BEFORE the handler runs.
 * - The handler returns an MCP CallToolResult: { content: [{ type: "text", text }], isError? }.
 * - Custom tools go through the same permission check as built-in ones: list them in `allowedTools`
 *   (a whole server with "mcp__tasks", or one tool with "mcp__tasks__add_task"), or they are denied.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { createSdkMcpServer, query, tool, type Options, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept05 = Router();

// The MCP CallToolResult type is not re-exported by the SDK, so take it from a handler's return type.
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

// The tasks server edits the same file that Concept 3 seeds, so the "sandbox/ on disk" card shows the changes.
const TASKS_FILE = path.join(SANDBOX, "data", "tasks.json");
type Task = { id: number; title: string; done: boolean };

const readTasks = async (): Promise<Task[]> => JSON.parse(await readFile(TASKS_FILE, "utf8"));
const saveTasks = (tasks: Task[]) => writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2) + "\n");

// Every handler returns a CallToolResult. The model only reads `content`; `isError` tells it the call failed.
const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

type Log = (server: string, toolName: string, args: unknown, result: CallToolResult) => void;

/**
 * Define the tools of each server. `log` wraps every handler, so the browser sees exactly when YOUR code ran
 * and what it returned.
 */
function makeTools(log: Log) {
  const logged =
    <A,>(server: string, name: string, handler: (args: A) => Promise<CallToolResult>) =>
    async (args: A) => {
      const result = await handler(args);
      log(server, name, args, result);
      return result;
    };

  return {
    tasks: [
      tool(
        "list_tasks",
        "List the tasks in the project's task list.",
        { status: z.enum(["all", "open", "done"]).default("all").describe("Which tasks to return") },
        logged("tasks", "list_tasks", async ({ status }) => {
          const all = await readTasks();
          return ok(status === "all" ? all : all.filter((t) => t.done === (status === "done")));
        }),
        { annotations: { readOnlyHint: true } }, // a hint for the client; it does not skip the permission check
      ),
      tool(
        "add_task",
        "Add a new open task to the task list. Returns the created task.",
        { title: z.string().min(3).max(60).describe("Short title, 3 to 60 characters") },
        logged("tasks", "add_task", async ({ title }) => {
          const all = await readTasks();
          const task = { id: Math.max(0, ...all.map((t) => t.id)) + 1, title, done: false };
          await saveTasks([...all, task]);
          return ok(task);
        }),
      ),
      tool(
        "complete_task",
        "Mark a task as done, by id.",
        { id: z.number().int().positive().describe("The task id") },
        logged("tasks", "complete_task", async ({ id }) => {
          const all = await readTasks();
          const task = all.find((t) => t.id === id);
          // A normal return with isError: the model reads the message and can react. Throwing would work too.
          if (!task) return fail(`No task with id ${id}. Existing ids: ${all.map((t) => t.id).join(", ")}.`);
          task.done = true;
          await saveTasks(all);
          return ok(task);
        }),
      ),
    ],
    clock: [
      tool(
        "now",
        "Get the current date and time on the server, optionally in an IANA time zone such as Europe/Madrid.",
        { timeZone: z.string().optional().describe("IANA time zone. Default: the server's zone") },
        logged("clock", "now", async ({ timeZone }) => {
          try {
            const text = new Date().toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" });
            return ok({ now: text, timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
          } catch {
            return fail(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/Madrid.`);
          }
        }),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  };
}

type ServerName = keyof ReturnType<typeof makeTools>;

const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;

// The form the tab sends. Only the servers that makeTools() defines are accepted.
const Body = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(100).optional(),
    servers: z.array(z.enum(["tasks", "clock"] satisfies ServerName[])).max(2),
    tools: z.array(z.string().regex(/^\w+$/, "a tool name")).max(50), // built-in tools, as in Concept 3
    allowedTools: z.array(z.string().trim().min(1).max(200)).max(50),
    permissionMode: z.enum(["default", "acceptEdits", "dontAsk"]).optional(),
    maxTurns: z.number().int().positive().optional(),
  })
  .strict();

// What the model is told about each tool: the zod shape is turned into a JSON Schema (zod 4's z.toJSONSchema).
concept05.get("/tools", (_req, res) => {
  const defs = makeTools(() => {});
  res.json(
    Object.entries(defs).map(([server, tools]) => ({
      server,
      tools: tools.map((t) => ({
        name: `mcp__${server}__${t.name}`,
        description: t.description,
        annotations: t.annotations,
        inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
      })),
    })),
  );
});

// The file the tasks server edits, so the tab can show it before and after a run.
concept05.get("/tasks", async (_req, res) => {
  res.type("text/plain").send(await readFile(TASKS_FILE, "utf8").catch(() => "(missing: press Reset sandbox/)"));
});

concept05.post("/query", (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  const { abort, send, pipe } = openSse(req, res);
  if (!parsed.success) return send("error", { message: badRequest(parsed.error) }), send("done", {}), res.end();
  const body = parsed.data;

  // A server holds a live McpServer instance, so each query() gets its own, built from fresh tool definitions.
  const defs = makeTools((server, toolName, args, result) => send("tool_handler", { server, toolName, args, result }));
  const mcpServers = Object.fromEntries(
    body.servers.filter((name) => Object.hasOwn(defs, name)).map((name) => [name, createSdkMcpServer({ name, version: "1.0.0", tools: defs[name] })]),
  );

  const options: Options = {
    tools: body.tools,
    mcpServers,
    allowedTools: body.allowedTools,
    cwd: SANDBOX,
    settingSources: [], // isolation, as in Concept 3
    strictMcpConfig: true, // only the servers in mcpServers; the machine's own MCP servers stay out
  };
  if (body.permissionMode) options.permissionMode = body.permissionMode;
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;

  // `instance` is a live McpServer object, so show a placeholder in the echoed options.
  send("options", {
    ...options,
    mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([k, s]) => [k, { type: s.type, name: s.name, instance: "[McpServer]" }])),
  });

  const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
  pipe(run);
});
