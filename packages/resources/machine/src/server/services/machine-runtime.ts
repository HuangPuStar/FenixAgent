import { getMachineHostPort } from "../host-port";

/**
 * 释放指定 Machine 的远端运行时路由。
 *
 * Core runtime 的单例归宿主装配，本包不自持也不反向导入 agent-runtime：实际注销经宿主绑定的
 * `MachineHostPort.unregisterCoreRuntimeNode` 完成，从而保持 Sandbox → Machine 的单向依赖。
 */
export function releaseMachineRuntime(machineId: string): void {
  getMachineHostPort().unregisterCoreRuntimeNode(machineId);
}
