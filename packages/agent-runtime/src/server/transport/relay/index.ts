export { sendToAgentWs } from "../acp-ws-handler";
export { closeClientsForMachineInstances } from "./client-close";
export * from "./lifecycle-port";
export { closeInstanceRelay, extractAcpEvent, extractJsonRpc, sendToInstanceRelay } from "./relay-handler";

import {
  closeAllRelayConnections as closeAllRelayLifecycleConnections,
  closeRelayConnectionsForIdleReclaim as closeRelayLifecycleForIdle,
  closeRelayConnectionsForStoppedInstance as closeRelayLifecycleForStopped,
  reclaimInstanceYjsDocs as reclaimRelayLifecycleYjsDocs,
} from "./lifecycle-port";

/** 关闭指定实例的所有前端 yjs WS 连接（替代原 relay ConnectionManager 遍历） */
export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  closeRelayLifecycleForIdle(instanceId);
}

/**
 * 实例确认停止后关闭其全部前端 YJS WebSocket client。
 *
 * Y.Doc 回收不会自行断开浏览器连接；若保留 client，shared relay 及其 listener 会继续
 * 存活，Observer 会显示孤儿 chat-relay。必须在 runtime/controller 已停止后调用，
 * 以免活跃实例的实时流被错误中断。
 */
export function closeRelayConnectionsForStoppedInstance(instanceId: string): void {
  closeRelayLifecycleForStopped(instanceId);
}

/**
 * 实例确认停止后回收其名下全部内存 Y.Doc（Chat / Session Doc 与广播订阅，SP-C2）。
 * 与 closeRelayConnectionsForIdleReclaim 同一控制器装配 seam，供实例停止完成点
 * （orchestration-instance 的 stopInstanceViaController）调用；调用方必须保证实例
 * 已确认停止——前端断开但实例可能存活时禁止回收（C6 断链语义一，重连依赖内存实时 Doc）。
 */
export async function reclaimInstanceYjsDocs(instanceId: string): Promise<void> {
  await reclaimRelayLifecycleYjsDocs(instanceId);
}

/** 关闭所有前端 yjs WS 连接（graceful shutdown） */
export function closeAllRelayConnections(): void {
  closeAllRelayLifecycleConnections();
}
