import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, WebSocket } from "ws";
import { commandSchema, type Frame, type StartCommand } from "./protocol.js";

export type Runner = (command: StartCommand, abort: AbortController, emit: (type: "delta" | "result", data: Frame["data"]) => void) => Promise<void>;
export const guidedRunner: Runner = async ({ prompt }, abort, emit) => {
  const text = `Guided response to: ${prompt}\n\nA WebSocket carries commands from the browser and incremental output from the host over one connection. Cancel can arrive while output is streaming. Reconnecting creates a fresh connection; it does not resume this run.`;
  for (const chunk of text.match(/.{1,12}/gs) ?? []) {
    await delay(80, undefined, { signal: abort.signal });
    emit("delta", { text: chunk });
  }
  emit("result", { text, costUsd: 0 });
};

/** Each socket owns its run. Disconnect cancels; no implicit replay or model retry. */
export function attachRealtime(server: Server, liveRunner: Runner, heartbeatMs = 15000) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  let activeRuns = 0;
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? "", "http://localhost").pathname; } catch { socket.destroy(); return; }
    if (pathname !== "/api/c66/socket") { socket.destroy(); return; }
    let validOrigin = false;
    try {
      const origin = new URL(request.headers.origin ?? "");
      validOrigin = ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host;
    } catch { /* Browser origin is required, including for local tests. */ }
    if (!validOrigin || wss.clients.size >= 20) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (ws) => {
    let seq = 0;
    let run: { id: string; abort: AbortController } | undefined;
    const used = new Set<string>();
    let alive = true;
    let windowStart = Date.now(), commands = 0;
    const send = (type: Frame["type"], runId: string | null, data: Frame["data"] = {}) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256 * 1024) { run?.abort.abort(); ws.terminate(); return; }
      ws.send(JSON.stringify({ type, runId, seq: ++seq, data } satisfies Frame));
    };
    ws.on("error", () => run?.abort.abort());
    ws.on("close", () => run?.abort.abort());
    ws.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { run?.abort.abort(); ws.terminate(); return; }
      alive = false; ws.ping();
    }, heartbeatMs);
    ws.once("close", () => clearInterval(heartbeat));
    send("ready", null);
    ws.on("message", (raw, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - windowStart > 1000) { windowStart = Date.now(); commands = 0; }
      if (++commands > 20) { ws.close(1008, "Command rate exceeded"); run?.abort.abort(); return; }
      let body: unknown;
      try { if (binary) throw new Error(); body = JSON.parse(raw.toString()); }
      catch { send("error", null, { message: "Expected a JSON text command." }); return; }
      const parsed = commandSchema.safeParse(body);
      if (!parsed.success) { send("error", null, { message: "Invalid command: use start or cancel with a UUID runId; prompt is 1–2000 characters." }); return; }
      const command = parsed.data;
      if (command.type === "cancel") {
        if (run?.id === command.runId) run.abort.abort();
        else send("error", null, { message: "No matching active run to cancel." });
        return;
      }
      if (run || used.has(command.runId) || used.size >= 100 || activeRuns >= 4) {
        send("error", command.runId, { message: "Run rejected: busy, duplicate ID, connection limit or host capacity. Wait or reconnect with a fresh ID.", status: "failed" }); return;
      }
      used.add(command.runId);
      const current = { id: command.runId, abort: new AbortController() };
      run = current; activeRuns++;
      send("started", current.id);
      const deadline = setTimeout(() => current.abort.abort(new Error("Run deadline exceeded")), 60000);
      void (async () => {
        let status: "completed" | "cancelled" | "failed" = "completed";
        try {
          await (command.mode === "guided" ? guidedRunner : liveRunner)(command, current.abort, (type, data) => {
            if (!current.abort.signal.aborted) send(type, current.id, data);
          });
          if (current.abort.signal.aborted) status = "cancelled";
        } catch (error) {
          status = current.abort.signal.aborted ? "cancelled" : "failed";
          if (status === "failed") send("error", current.id, { message: error instanceof Error ? error.message : String(error) });
        } finally {
          clearTimeout(deadline); activeRuns--; run = undefined;
          send("done", current.id, { status });
        }
      })();
    });
  });
  const dispose = () => {
    server.off("upgrade", upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.once("close", dispose);
  return { wss, dispose };
}
