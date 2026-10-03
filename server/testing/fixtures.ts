import type { AgentMessage, QueryPort } from "./host.js";

// #region fixtures
const delta = (text: string, parent: string | null = null): AgentMessage => ({
  type: "stream_event", parent_tool_use_id: parent,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});
const assistant = (text: string): AgentMessage => ({
  type: "assistant", parent_tool_use_id: null,
  message: { content: [{ type: "text", text, citations: null }] },
});
const success = (structured_output?: unknown, is_error = false): AgentMessage => ({
  type: "result", subtype: "success", is_error, result: is_error ? "Synthetic API failure" : "Refund approved.",
  total_cost_usd: 0, session_id: "offline-session-51", ...(structured_output === undefined ? {} : { structured_output }),
});

export const transcripts = {
  success: [delta("Refund "), delta("approved."), assistant("Refund approved."), success({ resolution: "resolved", refundCents: 1800 })],
  complete: [assistant("Refund approved."), success()],
  subagent: [delta("Private policy notes", "policy-tool-1"), delta("Refund "), delta("approved."), success()],
  budget: [{ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["Budget exceeded"], total_cost_usd: 0, session_id: "offline-session-51" }],
  apiError: [success(undefined, true)],
  invalid: [success({ resolution: "invented", refundCents: -1 })],
  truncated: [delta("Partial answer")],
} satisfies Record<string, AgentMessage[]>;
export type Scenario = keyof typeof transcripts | "throw" | "wait";

/** A fresh async iterator per call. No sockets, SDK runtime, credentials or subprocesses. */
export function fakeQuery(scenario: Scenario, seen?: Array<{ prompt: string; resume?: string }>): QueryPort {
  return async function* (request) {
    seen?.push({ prompt: request.prompt, resume: request.resume });
    request.signal.throwIfAborted();
    if (scenario === "throw") throw new Error("Synthetic transport failure");
    if (scenario === "wait") {
      await new Promise<never>((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return;
    }
    for (const message of transcripts[scenario]) {
      request.signal.throwIfAborted();
      yield structuredClone(message);
    }
  };
}
// #endregion
