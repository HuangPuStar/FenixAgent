import { extractJsonRpc } from "@fenix/chat-channel";
import type { OpenAIChatCompletionResponse } from "../schemas/openai-chat.schema";
import { classifyAgentTurnEvent, iterateWithSignal } from "./agent-turn-events";

/** Raw or wrapped relay event accepted at the protocol boundary. */
export interface RelayEvent {
  type: string;
  payload?: unknown;
}

function publicText(event: RelayEvent): string {
  const rpc = extractJsonRpc(event);
  if (rpc?.method !== "session/update") return "";
  const update = (rpc.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: unknown } } })
    ?.update;
  return update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string"
    ? update.content.text
    : "";
}
function finishReason(event: RelayEvent): "stop" | "length" | null {
  const terminal = classifyAgentTurnEvent(event);
  if (!terminal) return null;
  if (terminal.outcome !== "succeeded") throw new Error("Agent turn did not complete successfully");
  if (terminal.stopReason === "end_turn" || terminal.stopReason === "refusal") return "stop";
  if (terminal.stopReason === "max_tokens" || terminal.stopReason === "max_turn_requests") return "length";
  throw new Error("Unrecognized Agent completion");
}
/** Map a confirmed completed turn to native OpenAI JSON. */
export function mapToNonStreamingResponse(events: RelayEvent[], agentId: string): OpenAIChatCompletionResponse {
  let reason: "stop" | "length" | null = null;
  const content: string[] = [];
  for (const event of events) {
    content.push(publicText(event));
    const next = finishReason(event);
    if (next) {
      reason = next;
      break;
    }
  }
  if (!reason) throw new Error("Agent stream ended without confirmed completion");
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: agentId,
    choices: [{ index: 0, message: { role: "assistant", content: content.join("") }, finish_reason: reason }],
  };
}
/** Emit native SSE deltas with one identity, assistant role, and confirmed terminal. */
export async function* mapToSSEChunks(
  events: AsyncIterable<RelayEvent>,
  agentId: string,
  signal?: AbortSignal,
  onStopReason?: (reason: string) => void,
): AsyncGenerator<string, void, undefined> {
  const identity = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: agentId,
  };
  const chunk = (delta: Record<string, string>, reason: "stop" | "length" | null = null) =>
    `data: ${JSON.stringify({ ...identity, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  yield chunk({ role: "assistant" });
  for await (const event of iterateWithSignal(events, signal)) {
    const reason = finishReason(event);
    if (reason) {
      onStopReason?.(reason);
      yield chunk({}, reason);
      yield "data: [DONE]\n\n";
      return;
    }
    const text = publicText(event);
    if (text) yield chunk({ content: text });
  }
  throw new Error("Agent stream ended without confirmed completion");
}
/** Safe native error builder for errors after streaming begins. */
export function buildOpenAIError(status: number, message: string, type: string, code = "INTERNAL_ERROR") {
  return { status, body: { error: { message, type, param: null, code } } };
}
