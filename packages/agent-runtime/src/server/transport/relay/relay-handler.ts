import { log } from "@fenix/logger";
import { findMachineConnectionById, sendToWs } from "../acp-ws-handler";

// C2 迁移说明：extractJsonRpc/extractAcpEvent 的实现在 `@fenix/chat-channel` 协议层
// （protocol/acp-channel.ts，私有帧规范化边界）。1.4 W6a 删除了此处的 re-export：
// 它只是历史转出口（原注释声称的「hermes 等调用方」并不存在，hermes 只用
// `sendToInstanceRelay`），消费方一律直接从 chat-channel 取。

// ── 兼容层：保留机器侧 relay 函数 ──
// 这些函数被 hermes-client.ts 使用，用于向远程机器发送消息。

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
// 以下功能已从 RelayConnectionManager 迁移到 @fenix/chat-channel 的
// ConnectionRegistry（channel/connection-registry.ts）：
// - closeRelayConnectionsForIdleReclaim → ConnectionRegistry.closeClientsByInstance
// - closeAllRelayConnections → ConnectionRegistry.closeAll
// - handleMachineDisconnected / handleMachineReconnect → ConnectionRegistry.removeClient / closeClientsByInstance
