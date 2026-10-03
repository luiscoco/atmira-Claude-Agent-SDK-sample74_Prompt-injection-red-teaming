import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const channelSchema = z.enum(["slack", "teams", "email"]);
export type Channel = z.infer<typeof channelSchema>;
export const refundSchema = z.object({ orderId: z.literal("ORD-65"), amountCents: z.number().int().min(1).max(10000), reason: z.string().trim().min(1).max(200) }).strict();
export type Refund = z.infer<typeof refundSchema>;
export type State = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "delivery_failed";
export class ApprovalError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const digest = (value: string) => createHash("sha256").update(value).digest();

/** One process-local request. Tokens authorize this exact immutable action, never a session or tool class. */
export class Approval {
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("base64url");
  readonly refund: Readonly<Refund>;
  readonly fingerprint: string;
  readonly expiresAt: number;
  state: State = "pending";
  readonly audit: { at: string; event: string }[] = [];
  readonly result: Promise<State>;
  private resolve!: (state: State) => void;
  private timer: ReturnType<typeof setTimeout>;
  private onAbort = () => this.finish("cancelled");
  constructor(raw: unknown, readonly channel: Channel, ttlMs: number, private signal: AbortSignal,
    private notify: (snapshot: ReturnType<Approval["snapshot"]>) => void = () => {}, private now = Date.now) {
    this.refund = Object.freeze(refundSchema.parse(raw));
    this.fingerprint = digest(JSON.stringify(this.refund)).toString("hex");
    this.expiresAt = now() + ttlMs;
    this.result = new Promise((resolve) => { this.resolve = resolve; });
    this.timer = setTimeout(() => this.finish("expired"), ttlMs);
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.log("requested");
    if (signal.aborted) this.finish("cancelled");
  }
  private log(event: string) { this.audit.push({ at: new Date(this.now()).toISOString(), event }); }
  finish(state: Exclude<State, "pending">) {
    if (this.state !== "pending") return;
    this.state = state; clearTimeout(this.timer); this.signal.removeEventListener("abort", this.onAbort);
    this.log(state); this.resolve(state); this.notify(this.snapshot());
  }
  inspect(token: string) {
    if (!timingSafeEqual(digest(token), digest(this.token))) throw new ApprovalError("Invalid approval credential", 403);
    if (this.state === "pending" && this.now() >= this.expiresAt) this.finish("expired");
    if (this.state !== "pending") throw new ApprovalError(`Request is ${this.state}; it cannot be used again.`);
    return this.snapshot();
  }
  decide(token: string, approve: boolean) { this.inspect(token); this.finish(approve ? "approved" : "rejected"); }
  snapshot() {
    return { id: this.id, channel: this.channel, refund: { ...this.refund }, fingerprint: this.fingerprint,
      expiresAt: this.expiresAt, state: this.state, audit: this.audit.map((entry) => ({ ...entry })) };
  }
}

/** The effect is guarded inside the tool handler, including when SDK permission rules auto-allow the tool. */
export async function guardedRefund(approval: Approval, signal: AbortSignal, ledger: Refund[]) {
  const state = await approval.result;
  if (state !== "approved" || signal.aborted) return { executed: false, state: signal.aborted ? "cancelled" : state };
  if (ledger.length) return { executed: false, state: "already_executed" };
  // No await between the final check and effect. A real payment API needs a persisted idempotency key.
  ledger.push({ ...approval.refund });
  return { executed: true, state, idempotencyKey: approval.id };
}
