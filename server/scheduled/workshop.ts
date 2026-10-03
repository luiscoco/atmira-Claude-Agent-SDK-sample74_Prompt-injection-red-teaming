import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type Job = { id: string; key: string; source: "schedule" | "event"; payload: string; state: "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled"; attempts: number; availableAt: number; result?: string; error?: string };
export type Runner = (job: Readonly<Job>, abort: AbortController) => Promise<string>;
export class QueueError extends Error { constructor(public status: number, message: string) { super(message); } }
export const signEvent = (secret: string, timestamp: string, raw: Buffer) => createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex");
export function verifyEvent(secret: string, timestamp: string, signature: string, raw: Buffer, now: number) {
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) throw new QueueError(401, "Invalid or expired webhook signature.");
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signEvent(secret, timestamp, raw), "hex"))) throw new QueueError(401, "Invalid or expired webhook signature.");
}

// One-process teaching queue. Claims happen synchronously, before invoking a runner.
export class ScheduledWorkshop {
  private jobs: Job[] = [];
  private schedule?: { id: string; everyMs: number; nextAt: number; enabled: boolean };
  private active?: { id: string; abort: AbortController };
  private offset = 0;
  constructor(private clock: () => number = Date.now, private deadlineMs = 60_000) {}
  now() { return this.clock() + this.offset; }
  snapshot() { return structuredClone({ now: this.now(), schedule: this.schedule ?? null, jobs: this.jobs, active: this.active?.id ?? null, limits: { jobs: 100, attempts: 3, concurrency: 1 } }); }
  enqueue(key: string, source: Job["source"], payload: string) {
    const previous = this.jobs.find((j) => j.key === key);
    if (previous) return { duplicate: true, job: structuredClone(previous) };
    if (this.jobs.length >= 100) throw new QueueError(429, "Queue history limit reached. Restart the teaching server to reset.");
    const job: Job = { id: randomUUID(), key, source, payload, state: "queued", attempts: 0, availableAt: this.now() };
    this.jobs.push(job); return { duplicate: false, job: structuredClone(job) };
  }
  configure(everySeconds: number) {
    if (!Number.isInteger(everySeconds) || everySeconds < 5 || everySeconds > 3600) throw new QueueError(400, "Interval must be 5–3600 seconds.");
    this.schedule = { id: randomUUID(), everyMs: everySeconds * 1000, nextAt: this.now() + everySeconds * 1000, enabled: true };
  }
  pause() { if (this.schedule) this.schedule.enabled = false; }
  tick() {
    const s = this.schedule, now = this.now();
    if (!s?.enabled || now < s.nextAt) return { enqueued: false, skipped: 0 };
    // Coalesce missed intervals into one occurrence; avoid a catch-up storm.
    const skipped = Math.floor((now - s.nextAt) / s.everyMs);
    this.enqueue(`schedule:${s.id}:${s.nextAt}`, "schedule", "Summarize the scheduled operations health check.");
    s.nextAt += (skipped + 1) * s.everyMs;
    return { enqueued: true, skipped };
  }
  advance(seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new QueueError(400, "Advance must be 1–3600 seconds.");
    this.offset += seconds * 1000; return this.tick();
  }
  cancel(id: string) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new QueueError(404, "Unknown job.");
    if (["succeeded", "dead", "cancelled"].includes(job.state)) throw new QueueError(409, "Job is already terminal.");
    job.state = "cancelled"; if (this.active?.id === id) this.active.abort.abort();
  }
  private isCancelled(job: Job) { return job.state === "cancelled"; }
  async work(runner: Runner) {
    if (this.active) throw new QueueError(409, "Worker already busy.");
    const job = this.jobs.find((j) => ["queued", "retry"].includes(j.state) && j.availableAt <= this.now());
    if (!job) return { worked: false };
    const abort = new AbortController(); this.active = { id: job.id, abort };
    job.state = "running"; job.attempts++; delete job.error;
    const timer = setTimeout(() => abort.abort(), this.deadlineMs);
    // The deadline releases the teaching worker even if an injected runner ignores abort.
    let stop!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error("Run cancelled or deadline exceeded.")); abort.signal.addEventListener("abort", stop, { once: true }); });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (abort.signal.aborted) throw new Error("Cancelled before execution.");
        return runner(structuredClone(job), abort);
      }), interrupted]);
      if (!this.isCancelled(job)) { job.result = result; job.state = "succeeded"; }
    } catch {
      if (!this.isCancelled(job)) {
        job.error = "Execution failed or timed out.";
        job.state = job.attempts >= 3 ? "dead" : "retry";
        job.availableAt = this.now() + 1000 * 2 ** (job.attempts - 1);
      }
    } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", stop); this.active = undefined; }
    return { worked: true, job: structuredClone(job) };
  }
}
export const guidedRunner: Runner = async (job) => `Guided ${job.source} job completed: ${job.payload}`;
