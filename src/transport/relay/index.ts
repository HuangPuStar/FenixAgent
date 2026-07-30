export { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment } from "../../services/instance";
export { sendToAgentWs } from "../acp-ws-handler";
export { closeInstanceRelay, extractAcpEvent, extractJsonRpc, sendToInstanceRelay } from "./relay-handler";

// yjs-frontend 迁移函数 — 管理前端 yjs WS 连接生命周期
import { registry } from "./yjs-frontend";

/** 关闭指定实例的所有前端 yjs WS 连接（替代原 relay ConnectionManager 遍历） */
export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  registry.closeClientsByInstance(instanceId, 1000, "instance_idle_reclaimed");
}

/** 关闭所有前端 yjs WS 连接（graceful shutdown） */
export function closeAllRelayConnections(): void {
  registry.closeAll(1001, "server_shutdown");
}

/** 精确关闭指定实例的前端 yjs WS；machine 生命周期调用方须在删除 runtime 实例前捕获实例 ID。 */
export function closeClientsForMachineInstances(instanceIds: readonly string[], reason: string): void {
  for (const instanceId of instanceIds) {
    registry.closeClientsByInstance(instanceId, 4500, reason);
  }
}
