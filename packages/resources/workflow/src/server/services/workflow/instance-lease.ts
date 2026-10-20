/**
 * Workflow 对持久实例的进程内使用计数。
 *
 * Transport 解析实例后、await ensure 之前同步 acquire，覆盖启动、relay、会话握手及执行；
 * connect 失败归还，成功后转交 Adapter 在 execute settle 或 dispose 时归还。
 * 创建者 run 的 cleanup 在计数非零时跳过停止，避免切断其他 run 正在确保或使用的 runtime。
 * 多进程部署的计数不共享；它只保护同进程的 Workflow cleanup，不阻止用户显式停止。
 */

/** 实例租约表：instanceId → 当前持有租约的 workflow run 数 */
const leases = new Map<string, number>();

/** 解析实例后、await ensure 前同步占用一份租约，保护连接准备窗口。 */
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
