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

/** machine 断连后关闭关联的前端 yjs WS 连接 */
export function handleMachineDisconnected(_machineId: string): void {
  // TODO: 实现通过 machineId 查找并关闭前端 yjs 连接
  // 目前 yjs-frontend ConnectionRegistry 不追踪 machineId，暂时关闭所有连接
  registry.closeAll(4500, "machine unavailable");
}

/** machine 重连后关闭关联的旧前端 yjs WS 连接 */
export function handleMachineReconnect(_machineId: string): void {
  // TODO: 实现通过 machineId 查找并关闭前端 yjs 连接
  registry.closeAll(4500, "machine reconnected");
}
