export { sendToAgentWs } from "../acp-ws-handler";
export { closeInstanceRelay, extractAcpEvent, extractJsonRpc, sendToInstanceRelay } from "./relay-handler";

// C7：前端 YJS WS 连接注册表迁入包内后由 Chat 域桥接层持有（yjs-frontend 目录已删除），
// 实例回收 / graceful shutdown 通过控制器单例关闭连接。
import { getChatChannelController } from "../../services/chat-channel-bootstrap";

/** 关闭指定实例的所有前端 yjs WS 连接（替代原 relay ConnectionManager 遍历） */
export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  getChatChannelController().registry.closeClientsByInstance(instanceId, 4001, "instance_idle_reclaimed");
}

/** 关闭所有前端 yjs WS 连接（graceful shutdown） */
export function closeAllRelayConnections(): void {
  getChatChannelController().registry.closeAll(1001, "server_shutdown");
}

/** 精确关闭指定实例的前端 yjs WS；machine 生命周期调用方须在删除 runtime 实例前捕获实例 ID。 */
export function closeClientsForMachineInstances(instanceIds: readonly string[], reason: string): void {
  for (const instanceId of instanceIds) {
    getChatChannelController().registry.closeClientsByInstance(instanceId, 4500, reason);
  }
}
