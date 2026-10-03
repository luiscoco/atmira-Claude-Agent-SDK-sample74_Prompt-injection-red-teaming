import express, { Router } from "express";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { guidedRunner, QueueError, ScheduledWorkshop, signEvent, verifyEvent, type Runner } from "../scheduled/workshop.js";
import { liveScheduledRunner } from "../scheduled/agent.js";

const eventSchema = z.object({ eventId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), type: z.literal("incident.created"), message: z.string().trim().min(1).max(2000) }).strict();
export function createScheduledRouter(service = new ScheduledWorkshop(), runner: Runner = liveScheduledRunner, secret = randomBytes(32).toString("hex")) {
  const router = Router();
  // Mount this router BEFORE the application's JSON parser: signature verification needs exact bytes.
  router.post("/webhook", express.raw({ type: "application/json", limit: "8kb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new QueueError(400, "Expected JSON bytes.");
    verifyEvent(secret, req.get("x-event-timestamp") ?? "", req.get("x-event-signature") ?? "", req.body, Date.now());
    let body: unknown; try { body = JSON.parse(req.body.toString("utf8")); } catch { throw new QueueError(400, "Invalid JSON."); }
    const parsed = eventSchema.safeParse(body); if (!parsed.success) throw new QueueError(400, "Expected incident.created with eventId and message.");
    res.status(202).json(service.enqueue(`event:${parsed.data.eventId}`, "event", parsed.data.message));
  });
  router.use(express.json({ limit: "8kb" }));
  const parse = <T,>(schema: z.ZodType<T>, body: unknown): T => { const result = schema.safeParse(body); if (!result.success) throw new QueueError(400, "Invalid lesson request."); return result.data; };
  router.get("/state", (_req, res) => {
    // A due schedule cannot enqueue into full history, but existing work must
    // remain visible so the user can inspect, pause or run it.
    try { service.tick(); }
    catch (error) { if (!(error instanceof QueueError && error.status === 429)) throw error; }
    res.json(service.snapshot());
  });
  router.post("/schedule", (req, res) => { const b = parse(z.object({ everySeconds: z.number().int().min(5).max(3600) }).strict(), req.body); service.configure(b.everySeconds); res.json(service.snapshot()); });
  router.post("/pause", (req, res) => { parse(z.object({}).strict(), req.body); service.pause(); res.json(service.snapshot()); });
  router.post("/advance", (req, res) => { const b = parse(z.object({ seconds: z.number().int().min(1).max(3600) }).strict(), req.body); res.json(service.advance(b.seconds)); });
  // Local sender fixture returns signed bytes, never the server's secret. It is not production auth.
  router.post("/fixture", (req, res) => { const body = parse(eventSchema, req.body), raw = JSON.stringify(body), timestamp = String(Date.now()); res.json({ raw, timestamp, signature: signEvent(secret, timestamp, Buffer.from(raw)) }); });
  router.post("/work", async (req, res) => {
    const b = parse(z.object({ mode: z.enum(["guided", "fail", "live"]) }).strict(), req.body);
    res.json(await service.work(b.mode === "guided" ? guidedRunner : b.mode === "live" ? runner : async () => { throw new Error("Injected failure"); }));
  });
  router.post("/jobs/:id/cancel", (req, res) => { parse(z.object({}).strict(), req.body); service.cancel(String(req.params.id)); res.json(service.snapshot()); });
  router.get("/code", (_req, res) => res.json(Object.fromEntries([
    ["workshop.ts", "../scheduled/workshop.ts"], ["agent.ts", "../scheduled/agent.ts"], ["router.ts", "./68-scheduled-event-driven.ts"], ["Concept68ScheduledAgents.tsx", "../../src/concepts/Concept68ScheduledAgents.tsx"],
  ].map(([name, file]) => [name, readFileSync(new URL(file, import.meta.url), "utf8")]))));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof QueueError ? error.status : 400).json({ message: error instanceof QueueError ? error.message : "Invalid request." }));
  return router;
}
export const scheduledService = new ScheduledWorkshop();
export const concept68 = createScheduledRouter(scheduledService);
