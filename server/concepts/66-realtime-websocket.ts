import { Router } from "express";
import { readFileSync } from "node:fs";
export const concept66 = Router();
concept66.get("/code", (_req, res) => res.json(Object.fromEntries([
  ["protocol.ts", "../realtime/protocol.ts"], ["socket.ts", "../realtime/socket.ts"], ["agent.ts", "../realtime/agent.ts"],
  ["Concept66RealtimeWebSocket.tsx", "../../src/concepts/Concept66RealtimeWebSocket.tsx"],
].map(([name, file]) => [name, readFileSync(new URL(file, import.meta.url), "utf8")]))));
