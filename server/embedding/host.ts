import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { commandSchema, snapshotSchema, type Command, type Snapshot, type HostEvent } from "./protocol.js";

export type Runner = (command: Command, snapshot: Snapshot, abort: AbortController, delta: (text: string) => void) => Promise<{ replacement?: string; costUsd: number }>;
type EventPayload = HostEvent extends infer E ? E extends HostEvent ? Omit<E, "seq" | "runId"> : never : never;
export const guidedRunner: Runner = async (command, snapshot, abort, delta) => {
  for (const text of ["The host captured the selected editor buffer.\n", "No file or shell tools are available.\n", command.action === "rewrite" ? "Review the proposed comment before applying it.\n" : "This selection is sent as data for explanation; the buffer stays under editor control.\n"]) {
    await delay(250, undefined, { signal: abort.signal }); delta(text);
  }
  return { costUsd: 0, ...(command.action === "rewrite" ? { replacement: `// Reviewed in Lesson 69.\n${snapshot.text.slice(snapshot.start, snapshot.end)}` } : {}) };
};

/** One instance per window/panel. UI messages never choose cwd, credentials or executable paths. */
export class EmbeddingHost {
  private active?: AbortController;
  private disposed = false;
  constructor(private readonly liveRunner: Runner, private readonly deadlineMs = 60_000) {}
  cancel() { this.active?.abort(); }
  dispose() { this.disposed = true; this.cancel(); }
  async start(raw: unknown, captured: Snapshot, trusted: boolean, emit: (event: HostEvent) => void) {
    if (this.disposed) throw new Error("Panel is closed.");
    if (!trusted) throw new Error("Trust the workspace before starting an agent.");
    if (this.active) throw new Error("A run is already active in this panel.");
    const command = commandSchema.parse(raw), snapshot = snapshotSchema.parse(captured);
    const abort = new AbortController(); this.active = abort;
    const runId = randomUUID(); let seq = 0, finished = false, outputLength = 0;
    const send = (event: EventPayload) => { if (!finished) emit({ ...event, runId, seq: ++seq }); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.deadlineMs);
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error("Run cancelled."));
      abort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    let costUsd = 0;
    try {
      send({ type: "started", mode: command.mode });
      const result = await Promise.race([cancelled, (command.mode === "guided" ? guidedRunner : this.liveRunner)(command, snapshot, abort, (text) => {
        if (abort.signal.aborted || finished) return;
        outputLength += text.length;
        if (outputLength > 30_000) { abort.abort(); return; }
        send({ type: "delta", text });
      })]);
      if (abort.signal.aborted) throw new Error("Run cancelled.");
      costUsd = result.costUsd;
      if (command.action === "rewrite") {
        if (typeof result.replacement !== "string" || result.replacement.length > 24_000) throw new Error("Agent returned an invalid replacement.");
        send({ type: "proposal", proposal: { snapshot, replacement: result.replacement } });
      }
      send({ type: "done", status: "completed", costUsd });
    } catch (error) {
      const status = timedOut ? "failed" : abort.signal.aborted ? "cancelled" : "failed";
      if (status === "failed") send({ type: "error", message: timedOut ? "Host deadline exceeded." : "Agent failed. Check host authentication and retry." });
      send({ type: "done", status, costUsd });
    } finally {
      finished = true; clearTimeout(timer); abort.signal.removeEventListener("abort", rejectAbort);
      if (this.active === abort) this.active = undefined;
    }
  }
}
