/**
 * 机器断连/重连时编排域幽灵实例的宿主侧清理入口（E-P0.1）。
 *
 * 背景：机器断连/重连路径（core-bootstrap.unregisterRemoteNode / registerRemoteNode
 * 重连分支）删除 core 实例与 supplement 后，若不同步清理编排域 AgentController
 * 活跃表与节点引用计数，断连期间产生的"幽灵实例"会永久计入环境并发额度
 * （maxConcurrency=1 时环境永久无法再 spawn），且引用计数残留导致节点空闲回收
 * 不触发。
 *
 * 本模块独立于 core-bootstrap 提供收敛函数，避免 core-bootstrap ↔
 * orchestration-instance 的循环依赖（orchestration-instance 直接 import
 * core-bootstrap 的 getCoreRuntime）。
 */

import { log } from "@fenix/logger";
import { getOrchestrationController } from "./orchestration-bootstrap";

/**
 * 同步清理指定机器在编排域活跃表中的全部实例（停止帧 + 移出活跃表 + 归还节点引用）。
 *
 * 调用方：core-bootstrap.unregisterRemoteNode（断连）与 registerRemoteNode 重连分支
 * （重连），两者都在删除 core 实例后调用；本函数只清理编排域内存状态，不触碰
 * core runtime（core 实例的删除由调用方完成）。
 *
 * 多租户说明：controller 活跃表是编排域全局内存表（machine 为共享资源），
 * 按 machineId 匹配不涉及用户维度，无跨租户风险。
 *
 * @param machineId 目标机器 ID
 * @returns 实际清理的实例数
 */
export function cleanupOrchestrationInstancesForMachine(machineId: string): number {
  const controller = getOrchestrationController();
  const removed = controller.stopInstancesByMachineId(machineId);
  if (removed > 0) {
    // machineId 属内部机器标识（非用户输入），日志记录不违反脱敏约束
    log(`[orchestration-machine-cleanup] Removed ${removed} ghost instance(s) for machine ${machineId}`);
  }
  return removed;
}
