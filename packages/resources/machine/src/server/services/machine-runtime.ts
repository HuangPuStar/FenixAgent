import { getMachineHostPort } from "../host-port";

/** 判断当前机器的 ACP 是否已完成清场和运行节点激活；数据库 online 不足以证明可执行。 */
export async function isMachineRuntimeReady(machineId: string): Promise<boolean> {
  return getMachineHostPort().isMachineAcpReady(machineId);
}

/**
 * 释放指定 Machine 的远端运行时路由。
 *
 * Core runtime 的单例归宿主装配，本包不自持也不反向导入 agent-runtime：实际注销经宿主绑定的
 * `MachineHostPort.unregisterCoreRuntimeNode` 完成，从而保持 Sandbox → Machine 的单向依赖。
 */
export function releaseMachineRuntime(machineId: string): void {
  getMachineHostPort().unregisterCoreRuntimeNode(machineId);
}
