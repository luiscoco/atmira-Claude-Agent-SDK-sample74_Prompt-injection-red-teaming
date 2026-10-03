import { z } from "zod";

export const snapshotSchema = z.object({
  uri: z.string().min(1).max(2000), version: z.number().int().nonnegative(),
  text: z.string().min(1).max(24_000), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
}).strict().refine((s) => s.start < s.end && s.end <= s.text.length, "Select a nonempty range in the document.");
export const commandSchema = z.object({
  type: z.literal("start"), action: z.enum(["explain", "rewrite"]), mode: z.enum(["guided", "live"]),
}).strict();
export type Command = z.infer<typeof commandSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Proposal = { snapshot: Snapshot; replacement: string };
export type HostEvent = { runId: string; seq: number } & (
  | { type: "started"; mode: Command["mode"] }
  | { type: "delta"; text: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; message: string }
  | { type: "done"; status: "completed" | "cancelled" | "failed"; costUsd: number }
);

/** Both adapters recheck the entire captured buffer, including unsaved edits. */
export function applyProposal(current: Snapshot, proposal: Proposal): string {
  const captured = snapshotSchema.parse(proposal.snapshot);
  if (current.uri !== captured.uri || current.version !== captured.version || current.text !== captured.text)
    throw new Error("Document changed. Discard this proposal and run again.");
  if (proposal.replacement.length > 24_000) throw new Error("Replacement is too large.");
  return current.text.slice(0, captured.start) + proposal.replacement + current.text.slice(captured.end);
}
