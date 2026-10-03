/**
 * CONCEPT 36 — the "remote runner": a tiny stand-in for a container or a VM that runs Claude Code for the host.
 *
 *   node server/concepts/36-runner.mjs <boxRoot> <token> <claudeBinary>
 *
 * It listens on 127.0.0.1 (a random port, printed as "listening <port>") and runs ONE Claude Code process per TCP
 * connection. The host's spawnClaudeCodeProcess (36-spawn.ts) connects, sends the SpawnOptions, then relays stdin;
 * the runner relays the child's stdout, stderr and exit code back. Both directions use the same small frames:
 *
 *   [1 byte type][4 bytes length, big-endian][payload]
 *   host → runner:  H header (JSON: token, args, cwd, env) · I stdin bytes · E end of stdin · K kill (the signal name)
 *   runner → host:  O stdout bytes · R stderr bytes · X exit (JSON: code, signal) · L a log line of the runner
 *
 * What makes it "another machine": it ignores the host's command (it has its own Claude Code), runs in its own folder
 * (boxRoot/work instead of the host's cwd), with its own CLAUDE_CONFIG_DIR (boxRoot/config), and it does not take the
 * host's environment: only the few variables listed in PASS, plus what Windows itself needs to start a process.
 * The token keeps other local programs from using it. No shell is involved: the arguments go to spawn() as a list.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const [boxRoot, token, claude] = process.argv.slice(2);
if (!boxRoot || !token || !claude) {
  console.error("usage: node 36-runner.mjs <boxRoot> <token> <claudeBinary>");
  process.exit(2);
}
const WORK = path.join(boxRoot, "work");
const CONFIG = path.join(boxRoot, "config");
mkdirSync(WORK, { recursive: true });
mkdirSync(CONFIG, { recursive: true });

// From the host: the key and what the SDK itself sets. Everything else the host had stays on the host.
const PASS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION"];
// From the box itself: what a Windows process needs to start (on Linux: PATH and HOME would be enough).
const OWN = ["PATH", "Path", "SystemRoot", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];

const frame = (type, payload = Buffer.alloc(0)) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

/** Splits a byte stream into frames. */
function reader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) return;
      onFrame(buf.toString("latin1", 0, 1), buf.subarray(5, 5 + len));
      buf = buf.subarray(5 + len);
    }
  };
}

const server = net.createServer((sock) => {
  let child = null;
  const log = (line) => sock.writable && sock.write(frame("L", line));
  sock.on(
    "data",
    reader((type, payload) => {
      if (type === "H" && !child) {
        let h;
        try {
          h = JSON.parse(payload.toString("utf8"));
        } catch {
          return sock.destroy();
        }
        if (h.token !== token || !Array.isArray(h.args) || h.args.some((a) => typeof a !== "string")) {
          log("refused: bad token or arguments");
          return sock.end(frame("X", JSON.stringify({ code: 126, signal: null })));
        }
        const env = {};
        for (const k of PASS) if (typeof h.env?.[k] === "string") env[k] = h.env[k];
        for (const k of OWN) if (process.env[k] !== undefined) env[k] = process.env[k];
        env.CLAUDE_CONFIG_DIR = CONFIG;
        const hostKeys = Object.keys(h.env ?? {}).length;
        log(`host cwd ${h.cwd} → box cwd ${WORK}`);
        log(`env: ${PASS.filter((k) => env[k]).length} of the host's ${hostKeys} variables kept (${PASS.filter((k) => env[k]).join(", ")}), CLAUDE_CONFIG_DIR = box config`);
        log(`spawn ${path.basename(claude)} with ${h.args.length} arguments`);
        child = spawn(claude, h.args, { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", (d) => sock.writable && sock.write(frame("O", d)));
        child.stderr.on("data", (d) => sock.writable && sock.write(frame("R", d)));
        child.stdin.on("error", () => {}); // the child may exit before the host stops writing
        child.on("error", (err) => {
          log(`spawn failed: ${err.message}`);
          sock.end(frame("X", JSON.stringify({ code: 127, signal: null })));
        });
        child.on("exit", (code, signal) => {
          log(`exit ${code ?? signal}`);
          sock.end(frame("X", JSON.stringify({ code, signal })));
        });
      } else if (type === "I") child?.stdin.write(payload);
      else if (type === "E") child?.stdin.end();
      else if (type === "K") {
        log(`kill ${payload.toString("latin1")}`);
        child?.kill(payload.toString("latin1") || "SIGTERM");
      }
    }),
  );
  // The host went away (its server stopped, the network broke): do not leave Claude Code running.
  sock.on("close", () => child && child.exitCode === null && child.kill("SIGKILL"));
  sock.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => console.log(`listening ${server.address().port}`));
// Started by the lab's server: stop when it stops (its stdin closes).
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
