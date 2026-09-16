import { getBoundCoreRuntimePort } from "@fenix/agent-runtime/server";

/**
 * 释放指定 Machine 的远端运行时路由。
 *
 * Sandbox 只拥有 Machine 资源，不应了解 Core runtime 的宿主实现；Machine 通过
 * agent-runtime 的宿主端口完成实际注销，从而保持 Sandbox → Machine 的单向依赖。
 */
export function releaseMachineRuntime(machineId: string): void {
  getBoundCoreRuntimePort().unregisterRemoteNode(machineId);
}
