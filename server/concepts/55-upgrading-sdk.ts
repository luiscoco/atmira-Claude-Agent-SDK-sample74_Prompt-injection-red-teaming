import { readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { baseline, inventory, limits, runWorkshop, scenarios, transition } from "../upgrading/workshop.js";

export const concept55 = Router();
concept55.get("/facts", async (_req, res, next) => {
  try { res.json({ inventory: await inventory(), scenarios, baseline, limits, modelApiCalls: 0 }); }
  catch (error) { next(error); }
});
concept55.get("/code", (_req, res) => res.json({
  "workshop.ts": readFileSync(new URL("../upgrading/workshop.ts", import.meta.url), "utf8"),
  "upgrading.test.ts": readFileSync(new URL("../upgrading/upgrading.test.ts", import.meta.url), "utf8"),
}));
concept55.post("/run", (req, res) => {
  const parsed = z.object({ scenario: z.enum(scenarios) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  res.json(runWorkshop(parsed.data.scenario));
});
concept55.post("/transition", (req, res) => {
  const parsed = z.object({ scenario: z.enum(scenarios), state: z.enum(["baseline", "canary", "promoted", "rolled-back"]), action: z.enum(["canary", "promote", "rollback"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
  const { scenario, state, action } = parsed.data;
  try { res.json({ state: transition(state, action, runWorkshop(scenario).eligible), simulated: true }); }
  catch (error) { res.status(409).json({ message: (error as Error).message }); }
});
