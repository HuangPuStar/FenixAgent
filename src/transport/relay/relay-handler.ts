import { log } from "@fenix/logger";
import { findMachineConnectionById, sendToWs } from "../acp-ws-handler";

// ── JSON-RPC 兼容提取 ──
// C2 迁移说明：extractJsonRpc/extractAcpEvent 已迁入 @fenix/chat-channel
// （protocol/acp-channel.ts，私有帧规范化边界），此处仅保留 re-export 兼容
// 既有调用方（hermes 等）；聚合层消费路径不再直接出现私有帧类型。

export { extractAcpEvent, extractJsonRpc } from "@fenix/chat-channel";

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
// 以下功能已从 RelayConnectionManager 迁移到 yjs-frontend ConnectionRegistry：
// - closeRelayConnectionsForIdleReclaim → yjsFrontend.closeClientsByInstance
// - closeAllRelayConnections → yjsFrontend.closeAllClients
// - handleMachineDisconnected / handleMachineReconnect → yjsFrontend.closeClientsByMachine
