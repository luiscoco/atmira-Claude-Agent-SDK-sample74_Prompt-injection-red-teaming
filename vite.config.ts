import net from "node:net";
import { createLogger, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` starts Vite and the server together, and the server needs a few seconds to load all the concepts.
// Until it listens on :3074, every /api call fails with ECONNREFUSED and Vite prints a red stack trace per call.
// Print one short line instead (at most every 10 s). The browser gets a 502 as before, and other errors are unchanged.
const logger = createLogger();
const logError = logger.error;
let lastRefused = 0;
logger.error = (msg, options) => {
  if (msg.includes("http proxy error") && (options?.error as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED") {
    if (Date.now() - lastRefused > 10_000) logger.warn("The server on :3074 is not answering yet (still starting, or stopped: see the [server] lines).", { timestamp: true });
    lastRefused = Date.now();
    return;
  }
  logError(msg, options);
};

// Better still: do not fail at all. While the server is starting (or `node --watch` is restarting it after an edit),
// HOLD each /api request until :3074 accepts connections, then let the proxy forward it. The browser sees a slower
// first answer instead of a 502, so DevTools shows no "Failed to load resource" errors. After 30 s we give up and
// let the proxy answer 502 as before (the server really is down: see the [server] lines).
const API_PORT = 3074;
let apiUpAt = 0; // when :3074 last accepted a connection
const apiAccepts = () =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(API_PORT, "localhost");
    s.setTimeout(1000);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
async function waitForApi(maxMs = 30_000) {
  if (Date.now() - apiUpAt < 2000) return; // checked a moment ago: don't add a TCP probe to every call
  for (const t0 = Date.now(); Date.now() - t0 < maxMs; await new Promise((r) => setTimeout(r, 300)))
    if (await apiAccepts()) { apiUpAt = Date.now(); return; }
}
const waitForApiPlugin: Plugin = {
  name: "wait-for-api",
  // Middlewares added here run BEFORE Vite's own ones, the /api proxy included.
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (!req.url?.startsWith("/api")) return next();
      waitForApi().then(() => next(), next);
    });
  },
};

// The React app runs on :5173 (or the next free port) and forwards /api calls to sample74's Node server on :3074,
// because the Agent SDK must run in Node (it spawns a Claude Code process).
export default defineConfig({
  plugins: [react(), waitForApiPlugin],
  customLogger: logger,
  server: {
    port: 5173,
    // Preserve the browser-facing Host so lesson 65's same-origin decision check
    // matches the Origin header. Vite's string shorthand sets changeOrigin: true.
    proxy: { "/api": { target: `http://localhost:${API_PORT}`, changeOrigin: false, ws: true } },
    // The labs' working folders are rewritten by the server and by Claude Code while an agent runs. Concept 25's
    // fake CLAUDE_CONFIG_DIR (compact-lab/config) locks its backup files, and watching them crashed Vite with EBUSY.
    watch: { ignored: ["**/*-lab/**", "**/sandbox/**"] },
  },
});







