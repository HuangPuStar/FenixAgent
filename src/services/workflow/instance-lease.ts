/**
 * 实例租约（C-P1.1-R）：workflow run 对运行实例的使用权计数。
 *
 * 背景：并发 run 共享实例时，短 run A spawn 实例 X，长 run B 复用 X（ensureRunning
 * 恒复用首个运行实例）；A 先结束的 cleanup 会停止 X，连坐仍在用 X 的 B——B 的
 * relay 被关，execute 以 relay_closed 失败或挂起。
 *
 * 机制：transport.connect 在 ensureRunning 选中实例后立即 acquire 一份租约（无论
 * spawned / reused），execute settle（或 connect 失败）时 release 配对归还。cleanup
 * 停止实例前检查 hasActiveInstanceLease——仍有其他 run 使用时跳过停止；最后使用者
 * 释放后实例回归 acp-idle-monitor 空闲回收，"复用实例不随单次执行销毁"语义不变。
 *
 * 为何 acquire 必须紧贴 ensureRunning 返回（同一 tick、同步调用）：
 * 租约计数是"实例被选中即在使用"的证明；若延迟到 connect 完成才 acquire，A 的
 * cleanup 可能抢在 B 完成 connect 前停止 X（async gap 竞态窗口）。acquire 后、
 * B 的 ensureRunning 快照读取前的残余极小窗口由 engine 节点重试自愈（重新 spawn）。
 *
 * 已知边界：
 * - 实例被外部强制停止（web DELETE 手动停）时若 execute 未 settle，租约条目残留；
 *   instanceId 全局唯一不复用，无冲突风险，量级为手动停止的 workflow 实例数。
 * - idle / activity 回收不会残留——回收前提 relayCount=0，即 execute 必已 settle
 *   并 release。
 * - 进程内状态：ensureRunning 的复用快照同为进程内语义，acquire 与 cleanup 在
 *   同一进程内配对，不跨进程共享（多实例部署下各进程独立计数）。
 */

/** 实例租约表：instanceId → 当前持有租约的 workflow run 数 */
const leases = new Map<string, number>();

/** 占租约：transport.connect 选中实例后立即调用（无论 spawned/reused）。
 *  同步函数，必须在 ensureRunning 返回后同一 tick 调用，避免 async gap 竞态
 *  （见文件头"为何 acquire 必须紧贴 ensureRunning 返回"）。 */
export function acquireInstanceLease(instanceId: string): void {
  leases.set(instanceId, (leases.get(instanceId) ?? 0) + 1);
}

/** 还租约：execute settle 或 connect 失败时调用。计数归零即删除条目；
 *  未知实例（已归零/外部停止）幂等忽略。 */
export function releaseInstanceLease(instanceId: string): void {
  const count = leases.get(instanceId);
  if (count === undefined) return;
  if (count <= 1) {
    leases.delete(instanceId);
  } else {
    leases.set(instanceId, count - 1);
  }
}

/** 查询实例是否仍被使用（租约计数 > 0）。cleanup 停止前守卫。 */
export function hasActiveInstanceLease(instanceId: string): boolean {
  return (leases.get(instanceId) ?? 0) > 0;
}

/** 清空全部租约（测试隔离用；生产路径不调用）。 */
export function clearInstanceLeases(): void {
  leases.clear();
}
