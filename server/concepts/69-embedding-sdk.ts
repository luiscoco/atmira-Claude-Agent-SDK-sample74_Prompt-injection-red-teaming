import express, { Router } from "express";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { commandSchema, snapshotSchema } from "../embedding/protocol.js";
import { EmbeddingHost, type Runner } from "../embedding/host.js";
import { createLiveRunner } from "../embedding/agent.js";

export function createEmbeddingRouter(runner: Runner = createLiveRunner(fileURLToPath(new URL("../../embedding-lab/", import.meta.url)))) {
  const router = Router(); let active = 0;
  const bodySchema = z.object({ command: commandSchema, snapshot: snapshotSchema, trusted: z.boolean() }).strict();
  router.post("/run", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid command or editor selection." }); return; }
    if (!parsed.data.trusted) { res.status(403).json({ message: "Trust the demo workspace first." }); return; }
    if (active >= 4) { res.status(429).json({ message: "All four demo run slots are busy." }); return; }
    const host = new EmbeddingHost(runner); active++;
    // Browser adapter only: the extension uses postMessage and captures trust/buffer in its host.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const closed = () => host.dispose(); res.on("close", closed);
    try { await host.start(parsed.data.command, parsed.data.snapshot, true, (event) => { if (!res.destroyed) res.write(`event: host\ndata: ${JSON.stringify(event)}\n\n`); }); }
    finally { active--; host.dispose(); res.off("close", closed); res.end(); }
  });
  router.get("/code", (_req, res) => res.json(Object.fromEntries([
    ["host.ts", "../embedding/host.ts"], ["protocol.ts", "../embedding/protocol.ts"], ["agent.ts", "../embedding/agent.ts"],
    ["extension.cjs", "../../ide-extension/extension.cjs"], ["webview.js", "../../ide-extension/webview.js"],
  ].map(([name, file]) => [name, readFileSync(new URL(file, import.meta.url), "utf8")]))));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (!res.headersSent) res.status(500).json({ message: "Embedding host failed." }); else res.end(); });
  return router;
}
export const concept69 = createEmbeddingRouter();
