import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compare source contents rather than filesystem notifications. On this Windows
// setup, Node watch mode also reports generated files outside --watch-path.
export function sourceFingerprint(root) {
  const hash = createHash("sha256");
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) hash.update(path.relative(root, file)).update("\0").update(readFileSync(file)).update("\0");
    }
  }
  for (const directory of ["server", "mcp-servers"]) scan(path.join(root, directory));
  return hash.digest("hex");
}

export function watchSources(root, onChange, intervalMs = 1000) {
  let previous = sourceFingerprint(root);
  const timer = setInterval(() => {
    // An editor can temporarily remove a file while saving; check again next tick.
    let next;
    try { next = sourceFingerprint(root); } catch { return; }
    if (next !== previous) { previous = next; onChange(); }
  }, intervalMs);
  return () => clearInterval(timer);
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = { ...process.env };
  delete env.WATCH_REPORT_DEPENDENCIES;
  let child, restarting = false, pending = false, stopping = false;
  const launch = () => {
    child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "server/index.ts"], { cwd: root, env, stdio: "inherit" });
    child.on("error", (error) => console.error("Unable to start lesson server:", error.message));
    child.on("exit", (code) => { if (!restarting && !stopping) console.log(`Lesson server exited (${code}). Waiting for a source edit.`); });
  };
  async function restart() {
    pending = true;
    if (restarting || stopping) return;
    restarting = true;
    try {
      while (pending && !stopping) {
        pending = false;
        console.log("Server source changed. Restarting lesson server.");
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
        if (!stopping) launch();
      }
    } finally { restarting = false; }
  }
  const stopWatching = watchSources(root, () => { void restart(); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    stopping = true;
    stopWatching();
    child?.kill();
  });
  launch();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
