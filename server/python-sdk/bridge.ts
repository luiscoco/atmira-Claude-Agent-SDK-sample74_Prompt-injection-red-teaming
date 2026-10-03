import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { z } from "zod";

export const inputSchema = z.object({
  mode: z.enum(["guided", "live"]), exercise: z.enum(["query", "conversation", "tool"]),
  prompt: z.string().trim().min(1).max(2000),
}).strict();
export type PythonInput = z.infer<typeof inputSchema>;
export type PythonEvent = { type: string; text?: string; status?: string; [key: string]: unknown };
const root = fileURLToPath(new URL("../../", import.meta.url));
const localPython = fileURLToPath(new URL(process.platform === "win32" ? "../../.venv/Scripts/python.exe" : "../../.venv/bin/python", import.meta.url));
export function pythonExecutable() { return process.env.PYTHON_SDK_EXECUTABLE || (existsSync(localPython) ? localPython : "python"); }

/** One request -> one Python process. stdin is data; never construct a shell command. */
export async function runPython(input: PythonInput, signal: AbortSignal, emit: (event: PythonEvent) => void,
  options: { executable?: string; script?: string; deadlineMs?: number } = {}) {
  inputSchema.parse(input);
  if (signal.aborted) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_DEFAULT_") && !["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].includes(key)));
  const child = spawn(options.executable ?? pythonExecutable(), ["-u", options.script ?? fileURLToPath(new URL("../../python-sdk/lesson.py", import.meta.url))], {
    cwd: root, shell: false, windowsHide: true, detached: process.platform !== "win32",
    env: { ...env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let terminal = false, stopped = false, bytes = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!child.pid) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  };
  const fail = (text: string) => {
    if (!terminal && !signal.aborted) { terminal = true; emit({ type: "error", text }); emit({ type: "done", status: "failed" }); }
    stop();
  };
  const timer = setTimeout(() => fail("Python process exceeded the 90-second host deadline."), options.deadlineMs ?? 90_000);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const lines = createInterface({ input: child.stdout });
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256_000) fail("Python output exceeded the lesson limit."); });
  lines.on("line", (line) => {
    if (terminal || stopped || signal.aborted) return;
    try {
      const event = JSON.parse(line) as PythonEvent;
      if (!event || !["system", "text", "tool", "tool_use", "hook", "result", "error", "done"].includes(event.type)) throw new Error();
      if (event.type === "done") {
        if (!["completed", "failed"].includes(String(event.status))) throw new Error();
        terminal = true;
      }
      emit(event);
    } catch { fail("Invalid JSON-lines event from Python."); }
  });
  // Drain stderr but do not forward SDK diagnostics or secrets to the browser.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    await new Promise<void>((resolve) => {
      child.once("error", () => { fail("Unable to start Python. Install Python 3.10+ or set PYTHON_SDK_EXECUTABLE."); resolve(); });
      child.once("close", () => { if (!terminal && !signal.aborted) fail("Python exited before its final result."); resolve(); });
    });
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); lines.close(); }
}
