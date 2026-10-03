import { Router } from "express";
import { readFileSync } from "node:fs";
import { inputSchema, runPython } from "../python-sdk/bridge.js";

export function createPythonRouter(runner = runPython) {
  const router = Router(); let active = 0;
  router.post("/run", async (req, res) => {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Choose a valid mode, exercise and prompt of 1–2000 characters." }); return; }
    if (active >= 4) { res.status(429).json({ message: "All four Python lesson slots are busy." }); return; }
    active++;
    const controller = new AbortController();
    const close = () => controller.abort(); res.on("close", close);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const emit = (event: Parameters<Parameters<typeof runPython>[2]>[0]) => {
      if (!res.destroyed) res.write(`event: python\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try { await runner(parsed.data, controller.signal, emit); }
    catch { emit({ type: "error", text: "Python bridge failed." }); emit({ type: "done", status: "failed" }); }
    finally { active--; res.off("close", close); res.end(); }
  });
  router.get("/code", (_req, res) => res.json({
    "lesson.py": readFileSync(new URL("../../python-sdk/lesson.py", import.meta.url), "utf8"),
    "requirements.txt": readFileSync(new URL("../../python-sdk/requirements.txt", import.meta.url), "utf8"),
    "bridge.ts": readFileSync(new URL("../python-sdk/bridge.ts", import.meta.url), "utf8"),
  }));
  return router;
}
export const concept70 = createPythonRouter();
