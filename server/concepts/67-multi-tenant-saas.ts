import { Router } from "express";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AppError, authenticate, demoAccounts, SaaS, type Runner } from "../saas/architecture.js";
import { liveSaaSRunner } from "../saas/agent.js";

export function createSaaSRouter(service = new SaaS(), runner: Runner = liveSaaSRunner) {
  const router = Router();
  router.get("/facts", (_req, res) => res.json({ accounts: demoAccounts, storage: "In-memory teaching fixture; restart resets data and quotas." }));
  router.get("/code", (_req, res) => res.json(Object.fromEntries([
    ["architecture.ts", "../saas/architecture.ts"], ["agent.ts", "../saas/agent.ts"],
    ["67-multi-tenant-saas.ts", "./67-multi-tenant-saas.ts"], ["Concept67MultiTenantSaas.tsx", "../../src/concepts/Concept67MultiTenantSaas.tsx"],
  ].map(([name, file]) => [name, readFileSync(new URL(file, import.meta.url), "utf8")]))));
  router.use((req, res, next) => {
    try { res.locals.principal = authenticate(req.headers.authorization); next(); }
    catch (error) { next(error); }
  });
  router.get("/workspace", (_req, res) => res.json(service.snapshot(res.locals.principal)));
  // A completed lesson probe is HTTP 200 even when authorization denies access.
  // Real resource endpoints below retain their 404 semantics.
  router.post("/access-check", (req, res) => {
    const body = z.object({ kind: z.enum(["project", "session"]), id: z.string().trim().min(1).max(200) }).strict().safeParse(req.body);
    if (!body.success) throw new AppError(400, "Expected project/session kind and an object ID (1–200 characters).");
    try {
      const p = res.locals.principal;
      const resource = body.data.kind === "project"
        ? service.project(p, body.data.id)
        : (() => { const s = service.session(p, body.data.id); return { id: s.id }; })();
      res.json({ allowed: true, status: 200, resource });
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
      res.json({ allowed: false, status: 404, message: error.message });
    }
  });
  router.get("/projects/:id", (req, res) => res.json(service.project(res.locals.principal, String(req.params.id))));
  router.post("/sessions", (req, res) => {
    if (!z.object({}).strict().safeParse(req.body).success) throw new AppError(400, "Expected an empty object; tenant selection is server-owned.");
    res.status(201).json(service.createSession(res.locals.principal));
  });
  router.get("/sessions/:id", (req, res) => {
    const s = service.session(res.locals.principal, String(req.params.id));
    res.json({ id: s.id, messages: s.messages });
  });
  const runHandler = (lessonResult: boolean): import("express").RequestHandler => async (req, res) => {
    const body = z.object({ requestId: z.uuid(), prompt: z.string().trim().min(1).max(2000), mode: z.enum(["guided", "live"]) }).strict().safeParse(req.body);
    if (!body.success) throw new AppError(400, "Expected requestId UUID, prompt (1–2000 characters) and guided/live mode only.");
    const abort = new AbortController();
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", cancel);
    try {
      const result = await service.run(res.locals.principal, String(req.params.id), body.data.requestId, body.data.prompt, body.data.mode, runner, abort);
      res.json(lessonResult ? { accepted: true, status: 200, ...result } : result);
    } catch (error) {
      // Expected lesson admission denials are results, not failed transports.
      // Direct API callers still receive the original HTTP error status.
      if (!lessonResult || !(error instanceof AppError) || ![403, 404, 409, 429].includes(error.status)) throw error;
      res.json({ accepted: false, status: error.status, message: error.message });
    }
    finally { res.off("close", cancel); }
  };
  router.post("/sessions/:id/run", runHandler(false));
  router.post("/sessions/:id/execute", runHandler(true));
  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
    res.status(error instanceof AppError ? error.status : 502).json({ message: error instanceof AppError ? error.message : "Agent execution failed. Refresh workspace usage before starting a new request." });
  });
  return router;
}
export const concept67 = createSaaSRouter();
