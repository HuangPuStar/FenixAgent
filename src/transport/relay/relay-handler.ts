import { log } from "@fenix/logger";
import { findMachineConnectionById, sendToWs } from "../acp-ws-handler";

// ── JSON-RPC 兼容提取 ──
// EngineRelay 消息可能是 raw { type, payload } 或 JSON-RPC { jsonrpc: "2.0", ... } 两种格式。
// session/update 通知中的实际 ACP 事件在 params.update 内。

/** 从消息中提取 JSON-RPC 对象（兼容原始和包裹两种格式） */
export function extractJsonRpc(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.jsonrpc === "2.0") return msg;
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

/**
 * 从 EngineRelay 消息中提取 ACP 事件类型和载荷。
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
  // 发送。需要提取内部嵌套 type，否则 applyACPEvent 收到 type="session_data" 无法匹配任何 handler。
  // 注意：msgType 为 "session_data" 但 payload 为 JSON-RPC 对象的情况已在步骤 1 处理并返回。
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

// ── 兼容层：保留机器侧 relay 函数 ──
// 这些函数被 hermes-client.ts 使用，用于向远程机器发送消息。

export { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment } from "../../services/instance";

/** 关闭指定 machine 的 relay */
export function closeInstanceRelay(instanceId: string): void {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return;
  log("Relay → remote session_end", { instanceId });
  sendToWs(entry.ws, { type: "session_end", session_id: `auto_${instanceId}` });
}

/** 向指定 machine 的 relay 发送数据 */
export function sendToInstanceRelay(instanceId: string, data: string): boolean {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return false;
  try {
    const parsed = JSON.parse(data);
    log("Relay → remote session_data", {
      instanceId,
      payloadType: parsed.type,
      payload: JSON.stringify(parsed).slice(0, 300),
    });
    sendToWs(entry.ws, {
      type: "session_data",
      session_id: `auto_${instanceId}`,
      payload: parsed,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Yjs 迁移说明 ──
// 以下功能已从 RelayConnectionManager 迁移到 yjs-frontend ConnectionRegistry：
// - closeRelayConnectionsForIdleReclaim → yjsFrontend.closeClientsByInstance
// - closeAllRelayConnections → yjsFrontend.closeAllClients
// - handleMachineDisconnected / handleMachineReconnect → yjsFrontend.closeClientsByMachine
