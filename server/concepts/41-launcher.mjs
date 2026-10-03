// Concept 41 helper: stands in for claude.exe, so the lab can count how many Claude Code processes each way starts.
//
// Both SDKs run a pathToClaudeCodeExecutable that ends in .mjs with node. This script writes one line to
// C41_SPAWN_LOG, then starts the real binary (C41_REAL_CLI) with the same args and the same stdin/stdout,
// so the SDK talks to Claude Code exactly as without it.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const real = process.env.C41_REAL_CLI;
const log = process.env.C41_SPAWN_LOG;
const args = process.argv.slice(2);
if (!real) {
  console.error("41-launcher: C41_REAL_CLI is not set");
  process.exit(1);
}

if (log) appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, resume: args.some((a) => a.startsWith("--resume")) }) + "\n");

const child = spawn(real, args, { stdio: "inherit", windowsHide: true });
child.on("error", (err) => {
  console.error(`41-launcher: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => child.kill(s));
