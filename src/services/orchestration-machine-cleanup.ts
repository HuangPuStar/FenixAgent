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

import { log, error as logError } from "@fenix/logger";
import { getOrchestrationController } from "./orchestration-bootstrap";

const _deps = {
  getOrchestrationController,
  // SP-C2：幽灵实例确认移除后回收其内存 Y.Doc。默认经 transport/relay 惰性导入
  // （避免与 chat-channel-bootstrap 的模块循环，同 orchestration-instance /
  // acp-idle-monitor 的既有模式）；测试注入 spy 验证接线，不依赖真实控制器装配。
  reclaimYjsDocs: (instanceId: string) =>
    import("../transport/relay").then(({ reclaimInstanceYjsDocs }) => reclaimInstanceYjsDocs(instanceId)),
};
const _defaultDeps = { ..._deps };

/** 测试用：覆盖内部依赖，避免 mock.module。 */
export function setOrchestrationMachineCleanupDeps(overrides: Partial<typeof _deps>): void {
  Object.assign(_deps, overrides);
}

/** 测试用：恢复默认依赖。 */
export function resetOrchestrationMachineCleanupDeps(): void {
  Object.assign(_deps, _defaultDeps);
}

/**
 * 同步清理指定机器在编排域活跃表中的全部实例（停止帧 + 移出活跃表 + 归还节点引用），
 * 并对每个被移除实例触发实例级实时资源回收（SP-C2）。
 *
 * 调用方：core-bootstrap.unregisterRemoteNode（断连）与 registerRemoteNode 重连分支
 * （重连），两者都在删除 core 实例后调用；本函数只清理编排域内存状态，不触碰
 * core runtime（core 实例的删除由调用方完成）。
 *
 * 回收接线原因（SP-C2 funnel 收敛）：本路径不经过 stopInstanceViaController（core
 * 实例与 supplement 已被调用方同步删除，idle monitor 按 runtime.listInstances()
 * 迭代也永远看不到这些实例），若不在此回收，RelayEventHandler.instanceSessions
 * 登记与该实例名下保留的实时 Doc（断链语义一的保留窗口：relay 已释放、无
 * relay_closed 可达）将永久泄漏——后续 openChat 按同 rcsSessionId 命中内存旧 Doc，
 * 还会把上一代 Agent 会话的陈旧投影交给新实例。fire-and-forget：失败仅记日志，
 * 不阻断机器清理；回收幂等（Doc 已销毁时 no-op），且受单活归属保护（会话已被
 * 后继实例接管时跳过，见 relay-event-handler）。
 *
 * 多租户说明：controller 活跃表是编排域全局内存表（machine 为共享资源），
 * 按 machineId 匹配不涉及用户维度，无跨租户风险。
 *
 * @param machineId 目标机器 ID
 * @returns 实际清理的实例数
 */
export function cleanupOrchestrationInstancesForMachine(machineId: string): number {
  const removedInstanceIds = _deps.getOrchestrationController().stopInstancesByMachineId(machineId);
  if (removedInstanceIds.length > 0) {
    // machineId 属内部机器标识（非用户输入），日志记录不违反脱敏约束
    log(
      `[orchestration-machine-cleanup] Removed ${removedInstanceIds.length} ghost instance(s) for machine ${machineId}`,
    );
  }
  for (const instanceId of removedInstanceIds) {
    void _deps
      .reclaimYjsDocs(instanceId)
      .catch((err) =>
        logError(`[orchestration-machine-cleanup] yjs doc reclaim failed for instance ${instanceId}`, err),
      );
  }
  return removedInstanceIds.length;
}
