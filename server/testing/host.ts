import type { SDKAssistantMessage, SDKPartialAssistantMessage, SDKResultError, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// #region boundary
// This is the subset of SDK messages the host reads, not a fake implementation of the SDK's Query object.
// Real SDK messages fit this contract; fixtures must type-check against the installed SDK's field types.
export type AgentMessage =
  | { type: "assistant"; message: Pick<SDKAssistantMessage["message"], "content">; parent_tool_use_id: string | null }
  | Pick<SDKPartialAssistantMessage, "type" | "event" | "parent_tool_use_id">
  | Pick<SDKResultSuccess, "type" | "subtype" | "is_error" | "result" | "structured_output" | "total_cost_usd" | "session_id">
  | Pick<SDKResultError, "type" | "subtype" | "is_error" | "errors" | "total_cost_usd" | "session_id">;

export type QueryPort = (request: { prompt: string; signal: AbortSignal; resume?: string }) => AsyncIterable<AgentMessage>;
export const SummarySchema = z.object({ resolution: z.enum(["resolved", "escalated"]), refundCents: z.number().int().nonnegative() });
export type RunResult = { status: string; text: string; sessionId?: string; costUsd: number; summary?: z.infer<typeof SummarySchema>; error?: string };
// #endregion

// #region consumer
/** The dependency is REQUIRED: an offline test can never accidentally fall back to a real query(). */
export async function runAgent(
  queryPort: QueryPort,
  request: { prompt: string; resume?: string; signal?: AbortSignal; timeoutMs?: number },
  onDelta: (text: string) => void = () => {},
  mutation = false,
): Promise<RunResult> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", cancel, { once: true });
  if (request.signal?.aborted) cancel();
  const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Agent timeout"));
  }, request.timeoutMs);
  const result: RunResult = { status: "incomplete", text: "", costUsd: 0 };
  let streamed = false;
  try {
    controller.signal.throwIfAborted();
    for await (const message of queryPort({ prompt: request.prompt, resume: request.resume, signal: controller.signal })) {
      controller.signal.throwIfAborted();
      if (message.type === "stream_event" && message.parent_tool_use_id === null) {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          streamed = true;
          result.text += event.delta.text;
          onDelta(event.delta.text);
        }
      } else if (message.type === "assistant" && message.parent_tool_use_id === null && (!streamed || mutation)) {
        // A completed assistant message repeats streamed text. The mutation deliberately removes that guard.
        result.text += message.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      } else if (message.type === "result") {
        result.sessionId = message.session_id;
        result.costUsd = message.total_cost_usd;
        result.status = message.is_error ? (message.subtype === "success" ? "error" : message.subtype) : message.subtype;
        if (message.subtype !== "success") result.error = message.errors.join("; ");
        else if (message.is_error) result.error = message.result;
        else {
          // The terminal result is the complete authoritative answer. Do not append it to the stream.
          if (!mutation || !streamed) result.text = message.result;
          if (message.structured_output !== undefined) result.summary = SummarySchema.parse(message.structured_output);
        }
        return result;
      }
    }
    result.error = "Stream ended without a terminal result.";
  } catch (error) {
    result.status = controller.signal.aborted ? (timedOut ? "timeout" : "cancelled") : "error";
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }
  return result;
}
// #endregion
