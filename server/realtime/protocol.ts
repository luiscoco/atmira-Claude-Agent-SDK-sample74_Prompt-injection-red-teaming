import { z } from "zod";

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), runId: z.string().uuid(), mode: z.enum(["guided", "live"]), prompt: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("cancel"), runId: z.string().uuid() }).strict(),
]);
export type StartCommand = Extract<z.infer<typeof commandSchema>, { type: "start" }>;
export type Frame = {
  type: "ready" | "started" | "delta" | "result" | "error" | "done";
  runId: string | null;
  seq: number;
  data: { text?: string; message?: string; status?: "completed" | "cancelled" | "failed"; costUsd?: number };
};
