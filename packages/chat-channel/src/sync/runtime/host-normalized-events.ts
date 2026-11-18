import type { SyncHostNormalizedEvent } from "./host-session";
import { normalizeAcpSessionUpdate, type SyncIngressEvent } from "./ingress";

const SEMANTIC_CONTENT_SLOT = "semantic";
const SEMANTIC_CONTENT_TYPE = "application/json";
/** 无权威内容源的程序化入口共用现有 ACP 正规化规则。 */
export function mapHostNormalizedEvents(event: SyncHostNormalizedEvent): readonly SyncIngressEvent[] {
  const turnId = typeof event.turnId === "string" && event.turnId.length > 0 ? event.turnId : null;
  if (turnId === null) return [];
  const update = event.update;
  switch (event.type) {
    case "message_delta":
      return normalizeAcpSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: event.content ?? update.content,
        turnId,
      });
    case "reasoning_delta":
      return normalizeAcpSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: event.content ?? update.content,
        turnId,
      });
    case "tool_call_started":
      // 内部 started 与标准 ACP tool_call 同义：ingress 据此在文本 cursor 处写有序边界标记。
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_started", turnId });
    case "tool_call_updated":
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_update", turnId });
    // 私有结果/错误帧的终态由帧类型表达；不能退化成 tool_call_update，否则无 status 时永远 running。
    case "tool_call_completed":
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_result", turnId });
    case "tool_call_failed":
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_error", turnId });
    case "permission_requested":
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "permission_request", turnId });
    case "permission_resolved":
      return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "permission_response", turnId });
    case "turn_failed":
      return [
        semanticEvent(turnId, "error", {
          entityId: `${turnId}:error`,
          metadata: { status: "failed" },
        }),
      ];
    case "turn_cancelled":
    case "turn_interrupted":
      return [
        semanticEvent(turnId, "cancel", {
          entityId: `${turnId}:cancel`,
          metadata: { status: "cancelled" },
        }),
      ];
    // turn_completed 的正常终结需要存储侧 finalDescriptor（入口缺口①），当前不伪造 final。
    // user_message 由后端单写，Agent 回显不得再次写入。
    default:
      return [];
  }
}

/** 与 ingress 的 semanticEvent 同形：这里只构造 error/cancel 两种轮次屏障。 */
function semanticEvent(turnId: string, kind: "error" | "cancel", payload: Record<string, unknown>): SyncIngressEvent {
  return {
    kind: "semantic",
    turnId,
    entryId: `${turnId}:assistant`,
    contentSlot: SEMANTIC_CONTENT_SLOT,
    contentType: SEMANTIC_CONTENT_TYPE,
    semantic: { kind, payload },
  };
}
