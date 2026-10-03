import { z } from "zod";

export const members = ["lead", "researcher", "reviewer"] as const;
const member = z.enum(members);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("claim"), actor: member, task: z.enum(["research", "review"]) }).strict(),
  z.object({ type: z.literal("complete"), actor: member, task: z.enum(["research", "review"]), evidence: z.string().trim().max(500) }).strict(),
  z.object({ type: z.literal("send"), actor: member, to: member, id: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal("deliver"), actor: member }).strict(),
  z.object({ type: z.literal("ack"), actor: member, id: z.string().max(40) }).strict(),
  z.object({ type: z.literal("shutdown"), actor: member, to: member }).strict(),
  z.object({ type: z.literal("cleanup"), actor: member }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export type Task = { id: "research" | "review"; title: string; dependsOn: string[]; status: "pending" | "in-progress" | "completed"; owner?: string; evidence?: string };
export type Envelope = { id: string; from: string; to: string; text: string; status: "queued" | "delivered" | "acknowledged" };
export type TeamState = { members: Record<string, "idle" | "busy" | "stopped">; tasks: Task[]; messages: Envelope[]; cleaned: boolean };
export type Receipt = { step: number; type: string; ok: boolean; detail: string };
export function initialState(): TeamState {
  return { members: { lead: "idle", researcher: "idle", reviewer: "idle" }, tasks: [
    { id: "research", title: "Find the total: 12 + 18 + 7", dependsOn: [], status: "pending" },
    { id: "review", title: "Verify the research evidence", dependsOn: ["research"], status: "pending" },
  ], messages: [], cleaned: false };
}

// An application-owned teaching protocol, NOT Claude Code's internal mailbox format.
// Each request replays validated commands from a fresh state. No global team or model API.
export function replay(commands: Command[]) {
  const state = initialState();
  const receipts: Receipt[] = [];
  commands.forEach((command, index) => {
    const record = (ok: boolean, detail: string) => receipts.push({ step: index + 1, type: command.type, ok, detail });
    if (state.cleaned) return record(false, "Team was cleaned up. Reset to start another exercise.");
    if (state.members[command.actor] === "stopped") return record(false, "Stopped agents cannot act.");
    if (command.type === "claim" || command.type === "complete") {
      const task = state.tasks.find((task) => task.id === command.task)!;
      if (command.type === "claim") {
        if (task.status !== "pending") return record(false, `Task already ${task.status}; owner: ${task.owner}.`);
        if (task.dependsOn.some((id) => state.tasks.find((task) => task.id === id)?.status !== "completed")) return record(false, "Dependency incomplete: finish research first.");
        if (state.members[command.actor] === "busy") return record(false, "Agent already owns unfinished work.");
        task.owner = command.actor; task.status = "in-progress"; state.members[command.actor] = "busy";
        return record(true, `${command.actor} claimed ${task.id}. A later competing claim is rejected.`);
      }
      if (task.status !== "in-progress" || task.owner !== command.actor) return record(false, "Only the active task owner can complete it.");
      const evidence = command.evidence;
      if (task.id === "research" ? evidence !== "12 + 18 + 7 = 37" : evidence !== "verified: 37") return record(false, `Evidence gate failed. Expected ${task.id === "research" ? "12 + 18 + 7 = 37" : "verified: 37"}.`);
      task.status = "completed"; task.evidence = evidence; state.members[command.actor] = "idle";
      return record(true, `${task.id} completed with checked evidence. Idle means this turn finished; the agent remains addressable.`);
    }
    if (command.type === "send") {
      const previous = state.messages.find((message) => message.id === command.id);
      if (previous) {
        const identical = previous.from === command.actor && previous.to === command.to && previous.text === command.text;
        return record(identical, identical ? "Duplicate retry: original envelope retained; no second delivery." : "Message ID conflict: use a new ID for different content.");
      }
      if (state.members[command.to] === "stopped") return record(false, "Recipient stopped. Reset or choose an active recipient.");
      state.messages.push({ id: command.id, from: command.actor, to: command.to, text: command.text, status: "queued" });
      return record(true, "Queued in recipient mailbox. Sending is not delivery, acknowledgment or task completion.");
    }
    if (command.type === "deliver") {
      const pending = state.messages.filter((message) => message.to === command.actor && message.status === "queued");
      pending.forEach((message) => { message.status = "delivered"; });
      return record(true, `Delivered ${pending.length} message(s) to ${command.actor}. Recipient has not acknowledged them yet.`);
    }
    if (command.type === "ack") {
      const message = state.messages.find((message) => message.to === command.actor && message.id === command.id && message.status === "delivered");
      if (!message) return record(false, "No delivered message with that ID for this recipient.");
      message.status = "acknowledged";
      return record(true, "Recipient acknowledged receipt. Task evidence still needs its own completion gate.");
    }
    if (command.type === "shutdown") {
      if (command.actor !== "lead" || command.to === "lead") return record(false, "In this exercise only the lead can request a worker shutdown.");
      if (state.members[command.to] === "busy") return record(false, "Worker rejects shutdown: finish the claimed task first.");
      if (state.messages.some((message) => message.to === command.to && message.status !== "acknowledged")) return record(false, "Worker rejects shutdown: acknowledge pending messages first.");
      state.members[command.to] = "stopped";
      return record(true, `${command.to} accepted shutdown. No further turns or messages for this worker.`);
    }
    if (command.actor !== "lead" || members.slice(1).some((name) => state.members[name] !== "stopped")) return record(false, "Cleanup needs the lead and both workers stopped.");
    if (state.tasks.some((task) => task.status !== "completed") || state.messages.some((message) => message.status !== "acknowledged")) return record(false, "Complete all tasks and acknowledge all messages before cleanup.");
    state.cleaned = true;
    return record(true, "Exercise closed. Evidence is retained here for review; reset clears browser history.");
  });
  return { state, receipts, simulated: true as const, modelApiCalls: 0 };
}

export const walkthrough: Command[] = [
  { type: "claim", actor: "reviewer", task: "review" },
  { type: "claim", actor: "researcher", task: "research" },
  { type: "claim", actor: "reviewer", task: "research" },
  { type: "shutdown", actor: "lead", to: "researcher" },
  { type: "send", actor: "researcher", to: "reviewer", id: "finding-1", text: "12 + 18 + 7 = 37; please verify." },
  { type: "send", actor: "researcher", to: "reviewer", id: "finding-1", text: "12 + 18 + 7 = 37; please verify." },
  { type: "ack", actor: "reviewer", id: "finding-1" },
  { type: "deliver", actor: "reviewer" },
  { type: "ack", actor: "reviewer", id: "finding-1" },
  { type: "complete", actor: "researcher", task: "research", evidence: "30" },
  { type: "complete", actor: "researcher", task: "research", evidence: "12 + 18 + 7 = 37" },
  { type: "claim", actor: "reviewer", task: "review" },
  { type: "complete", actor: "reviewer", task: "review", evidence: "verified: 37" },
  { type: "shutdown", actor: "lead", to: "researcher" },
  { type: "shutdown", actor: "lead", to: "reviewer" },
  { type: "cleanup", actor: "lead" },
];
