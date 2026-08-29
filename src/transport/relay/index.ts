export { sendToAgentWs } from "../acp-ws-handler";
export { closeInstanceRelay, extractAcpEvent, extractJsonRpc, sendToInstanceRelay } from "./relay-handler";

// C7：前端 YJS WS 连接注册表迁入包内后由 Chat 域桥接层持有（yjs-frontend 目录已删除），
// 实例回收 / graceful shutdown 通过控制器单例关闭连接。
import { getChatChannelController } from "../../services/chat-channel-bootstrap";

/** 关闭指定实例的所有前端 yjs WS 连接（替代原 relay ConnectionManager 遍历） */
export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  getChatChannelController().registry.closeClientsByInstance(instanceId, 4001, "instance_idle_reclaimed");
}

/**
 * 实例确认停止后关闭其全部前端 YJS WebSocket client。
 *
 * Y.Doc 回收不会自行断开浏览器连接；若保留 client，shared relay 及其 listener 会继续
 * 存活，Observer 会显示孤儿 chat-relay。必须在 runtime/controller 已停止后调用，
 * 以免活跃实例的实时流被错误中断。
 */
export function closeRelayConnectionsForStoppedInstance(instanceId: string): void {
  getChatChannelController().registry.closeClientsByInstance(instanceId, 4002, "instance_stopped");
}

/**
 * 实例确认停止后回收其名下全部内存 Y.Doc（Chat / Session Doc 与广播订阅，SP-C2）。
 * 与 closeRelayConnectionsForIdleReclaim 同一控制器装配 seam，供实例停止完成点
 * （orchestration-instance 的 stopInstanceViaController）调用；调用方必须保证实例
 * 已确认停止——前端断开但实例可能存活时禁止回收（C6 断链语义一，重连依赖内存实时 Doc）。
 */
export async function reclaimInstanceYjsDocs(instanceId: string): Promise<void> {
  await getChatChannelController().relayEvents.reclaimInstanceRealtimeResources(instanceId);
}

/** 关闭所有前端 yjs WS 连接，并等待候选投影回滚完成（graceful shutdown）。 */
export async function closeAllRelayConnections(): Promise<void> {
  await getChatChannelController().gateway.closeAll(1001, "server_shutdown");
}

/** 精确关闭指定实例的前端 yjs WS；machine 生命周期调用方须在删除 runtime 实例前捕获实例 ID。 */
export function closeClientsForMachineInstances(instanceIds: readonly string[], reason: string): void {
  for (const instanceId of instanceIds) {
    getChatChannelController().registry.closeClientsByInstance(instanceId, 4500, reason);
  }
}
