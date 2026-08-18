// packages/chat-channel/src/protocol/acp-channel.ts
// ACPChannel：入站消息规范化边界。
//
// 职责（文档 6.2）：把 acp-link 私有帧（agent_message_chunk / agent_thought_chunk /
// prompt_complete 等）与 JSON-RPC session/update 通知翻译为统一的规范化事件
// （session/update 语义：增量、内容块、终态），聚合层只消费规范化事件。
//
// 双格式兼容：原始 { type, payload } 与包裹 { type, payload: { jsonrpc: "2.0", ... } }。

import type { NormalizedEvent, NormalizedEventType } from "../schema";

/** 从消息中提取 JSON-RPC 对象（兼容原始和包裹两种格式） */
export function extractJsonRpc(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.jsonrpc === "2.0") return msg;
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

/**
 * 从 EngineRelay 消息中提取 ACP 事件类型和载荷（兼容层内部翻译）。
 * 兼容两种消息格式：
 * 1. 原始引擎格式: { type: "agent_message_chunk", payload: { type: "text", text: "..." } }
 * 2. JSON-RPC session/update: { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "...", content: {...} } } }
 *    （含包裹格式: { type: "session_data", payload: { jsonrpc: "2.0", ... } }）
 */
export function extractAcpEvent(
  rawMessage: unknown,
  msgType: string | undefined,
): { type: string; payload?: Record<string, unknown> } {
  const message = rawMessage as Record<string, unknown>;
  // 1. 尝试 JSON-RPC session/update 通知提取
  const rpc = extractJsonRpc(message);
  if (rpc && rpc.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate) {
      return {
        type: update.sessionUpdate as string,
        payload: update as Record<string, unknown>,
      };
    }
  }

  // 1.5. JSON-RPC 响应中的 prompt 结果：
  // session-manager 的 JSON-RPC 路径可能将 prompt 结果包装为
  //   createSuccessResponse(id, result) → { jsonrpc: "2.0", result: { stopReason: ... } }
  // 当 session_data payload 是此类 JSON-RPC 响应时，提取为 prompt_complete。
  if (rpc && "result" in rpc) {
    const result = rpc.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && "stopReason" in result) {
      return {
        type: "prompt_complete",
        payload: result,
      };
    }
  }

  // 2. session_data 包裹格式：{ type: "session_data", payload: { type: "prompt_complete", payload: ... } }
  // session-manager 将 prompt_complete 等非 JSON-RPC 事件通过
  //   emit(sessionId, "session_data", { type: "prompt_complete", payload: result })
  // 发送。需要提取内部嵌套 type，否则聚合层收到 type="session_data" 无法匹配任何 handler。
  const innerPayload = message.payload as Record<string, unknown> | undefined;
  if (msgType === "session_data" && innerPayload?.type && typeof innerPayload.type === "string") {
    return {
      type: innerPayload.type as string,
      payload: (innerPayload.payload as Record<string, unknown>) ?? innerPayload,
    };
  }

  // 3. 回退：原始 EngineRelayMessage 格式 { type, payload }
  return {
    type: msgType || "unknown",
    payload: innerPayload ?? message,
  };
}

/** 私有帧类型 → 规范化事件类型映射（终态判定依赖 payload 内容，见 normalize 内分支） */
const PRIVATE_FRAME_TO_NORMALIZED: Record<string, NormalizedEventType> = {
  agent_message_chunk: "message_delta",
  agent_thought_chunk: "reasoning_delta",
  user_message_chunk: "user_message",
  prompt_complete: "turn_completed",
  agent_message_complete: "turn_completed",
  session_error: "turn_failed",
  tool_call_result: "tool_call_completed",
  tool_call_error: "tool_call_failed",
  permission_request: "permission_requested",
  permission_response: "permission_resolved",
  // AskUserQuestion 交互问题（acp-link claude-adapter 拦截工具后发送私有帧，
  // payload 携带 sessionId/questionId/toolId/toolName/questions[]/description）
  interactive_question: "question_requested",
  session_update: "session_updated",
  plan: "plan",
  available_commands_update: "session_updated",
};

/** 提取规范化事件类型（sessionUpdate 值 → 规范化类型；tool_call 系列在 normalize 中细分） */
function mapSessionUpdateType(sessionUpdate: string): NormalizedEventType | null {
  switch (sessionUpdate) {
    case "agent_message_chunk":
      return "message_delta";
    case "agent_thought_chunk":
      return "reasoning_delta";
    case "user_message_chunk":
      return "user_message";
    case "tool_call":
    case "tool_call_update":
      // 可能是开始（running）也可能直接携带终态（completed/error），
      // 在 normalize 中按 payload.status 细分
      return "tool_call_started";
    case "permission_request":
      return "permission_requested";
    case "permission_response":
      return "permission_resolved";
    case "session_info_update":
      return "session_updated";
    case "plan":
      return "plan";
    case "available_commands_update":
      // 命令列表为会话级元数据（与 modelState/modeState 同级），随 session_updated
      // 投影到 Session Doc session map，前端 slash 命令菜单的数据源（YJS 重构恢复）
      return "session_updated";
    default:
      return null;
  }
}

/** 判断 tool_call 帧是否已携带终态（非流式 agent 可能直接发送完整结果）。
 * 标准 ACP（agent-client-protocol）工具失败序列化为 "failed"（ToolCallStatus::Failed），
 * 与私有帧的 "error" 一并收敛为 tool_call_failed，避免标准失败被误判为 started。 */
function resolveToolCallType(payload: Record<string, unknown> | undefined): NormalizedEventType {
  const status = (payload?.status as string | undefined) ?? "running";
  if (status === "completed" || status === "complete" || status === "done") return "tool_call_completed";
  if (status === "error" || status === "failed") return "tool_call_failed";
  return "tool_call_started";
}

/** 从消息中提取 ACP sessionId（session/update 通知的 params.sessionId） */
function extractSessionId(message: Record<string, unknown>): string | null {
  const rpc = extractJsonRpc(message);
  if (rpc?.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const sessionId = params?.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  const direct = message.session_id ?? message.sessionId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

/** 提取内容块：优先 update.content；原始格式下 payload 自身就是内容块（{ type: "text", text }） */
function extractContent(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const nested = payload.content;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  if (typeof payload.text === "string" && (payload.type === "text" || payload.type === "image")) {
    return payload;
  }
  return null;
}

/**
 * ACPChannel 入站规范化：把任意 relay 入站消息翻译为规范化事件。
 * - 返回 null 表示消息不属于聚合层可消费的事件（保活帧、未知类型、已删除字段），
 *   调用方应直接忽略，不进入聚合层。
 * - 规范化事件保留双格式兼容（原始 + 包裹 JSON-RPC）。
 */
export function normalizeAcpMessage(rawMessage: unknown, msgType?: string): NormalizedEvent | null {
  const message = rawMessage as Record<string, unknown>;
  const acpSessionId = extractSessionId(message);

  // 1. JSON-RPC session/update 通知：事件类型与载荷都来自 params.update
  const rpc = extractJsonRpc(message);
  if (rpc?.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const sessionUpdate = update?.sessionUpdate as string | undefined;
    if (sessionUpdate) {
      const baseType = mapSessionUpdateType(sessionUpdate);
      if (!baseType) return null;
      // tool_call / tool_call_update 按携带的 status 细分终态
      const type =
        sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update" ? resolveToolCallType(update) : baseType;
      return {
        type,
        update: update ?? {},
        content: (update?.content as Record<string, unknown>) ?? null,
        acpSessionId,
      };
    }
    return null;
  }

  // 2. JSON-RPC 响应中的 prompt 结果（含 stopReason → turn 终态）与 cancel 确认
  if (rpc && "result" in rpc) {
    const result = rpc.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && "stopReason" in result) {
      return {
        // cancel 后 Agent 回 prompt_complete { stopReason: "cancelled" } → turn_cancelled 终态
        type: result.stopReason === "cancelled" ? "turn_cancelled" : "turn_completed",
        update: result,
        content: null,
        acpSessionId,
      };
    }
    // acp-link server 的 session/cancel 响应 { cancelled: true } 是取消确认的另一种形态，
    // 与 prompt_complete { stopReason: "cancelled" } 收敛到同一终态事件
    if (result && typeof result === "object" && result.cancelled === true) {
      return { type: "turn_cancelled", update: result, content: null, acpSessionId };
    }
    // session/list 响应：shared-proc 与实例路径都以 JSON-RPC success 形态到达
    // （extractJsonRpc 兼容包裹 session_data 与裸 jsonrpc 两种），聚合层投影到
    // Session Doc sessions 映射（10s 轮询全量同步，幂等）
    if (result && typeof result === "object" && Array.isArray(result.sessions)) {
      return { type: "session_list", update: result, content: null, acpSessionId };
    }
    return null;
  }

  // 3. 私有帧 / session_data 包裹 → extractAcpEvent 提取后翻译
  const event = extractAcpEvent(rawMessage, msgType);
  if (event.type === "unknown" || event.type === "session_data") return null;

  // 保活/控制帧不进入聚合层
  if (
    event.type === "keep_alive" ||
    event.type === "heartbeat" ||
    event.type === "ping" ||
    event.type === "pong" ||
    event.type === "status"
  ) {
    return null;
  }

  const payload = event.payload ?? {};
  const normalizedType = PRIVATE_FRAME_TO_NORMALIZED[event.type];
  if (normalizedType) {
    return {
      // cancel 确认帧（prompt_complete / agent_message_complete 携带 stopReason: "cancelled"）
      // → turn_cancelled 终态，与 JSON-RPC 响应路径收敛一致
      type:
        normalizedType === "turn_completed" && payload.stopReason === "cancelled" ? "turn_cancelled" : normalizedType,
      update: payload,
      content: extractContent(payload),
      acpSessionId,
    };
  }

  // tool_call 系列按 payload.status 细分终态
  if (event.type === "tool_call" || event.type === "tool_call_update") {
    return {
      type: resolveToolCallType(payload),
      update: payload,
      content: extractContent(payload),
      acpSessionId,
    };
  }

  return null;
}
