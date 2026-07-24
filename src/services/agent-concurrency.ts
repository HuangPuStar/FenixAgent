import type { CoreRuntimeFacade, RuntimeInstanceStatus } from "@fenix/core";
import { config } from "../config";
import { AppError } from "../errors";
import type { InstanceSpawnSource, InstanceSupplement } from "../types/store";
import { getCoreRuntime } from "./core-bootstrap";
import { globalInstanceRegistry, type InstanceRegistry } from "./instance-registry";

const _deps = {
  getRuntime: getCoreRuntime,
  registry: globalInstanceRegistry,
};
const _defaultDeps = { ..._deps };

/** 测试用：覆盖并发统计依赖。 */
export function setAgentConcurrencyDeps(overrides: Partial<typeof _deps>): void {
  Object.assign(_deps, overrides);
}

/** 测试用：恢复并发统计默认依赖。 */
export function resetAgentConcurrencyDeps(): void {
  Object.assign(_deps, _defaultDeps);
}

/** 判断 runtime 实例是否仍属于活跃并发。 */
export function isActiveRuntimeStatus(status: RuntimeInstanceStatus): boolean {
  return status !== "stopped" && status !== "stopping" && status !== "error";
}

/** 统计 runtime 中全部活跃实例数。 */
export function getActiveAgentCount(runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime()): number {
  return runtime.listInstances().filter((snapshot) => isActiveRuntimeStatus(snapshot.status)).length;
}

/**
 * 统计活跃的定时任务实例数。
 *
 * 口径：
 * - 必须先是 runtime 活跃实例
 * - 必须存在 supplement
 * - 只有 spawnSource === "scheduled" 才计入
 * - 缺少 spawnSource 时仅记录告警，不计入 scheduled 并发
 */
export function getActiveScheduledAgentCount(
  runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime(),
  registry: Pick<InstanceRegistry, "get"> = _deps.registry,
): number {
  let count = 0;
  for (const snapshot of runtime.listInstances()) {
    if (!isActiveRuntimeStatus(snapshot.status)) continue;
    const supplement = registry.get(snapshot.instanceId) as InstanceSupplement | undefined;
    if (!supplement) continue;
    if (supplement.spawnSource === "scheduled") count += 1;
  }
  return count;
}

/** 在实例启动前校验当前来源对应的并发额度。 */
export function assertAgentConcurrencyAvailable(
  source: InstanceSpawnSource,
  runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime(),
  registry: Pick<InstanceRegistry, "get"> = _deps.registry,
): void {
  const totalLimit = config.agentMaxConcurrency;
  if (totalLimit && getActiveAgentCount(runtime) >= totalLimit) {
    throw new AppError("已达到 Agent 总并发上限", "AGENT_CONCURRENCY_LIMIT_REACHED", 429);
  }

  const scheduledLimit = config.scheduledAgentMaxConcurrency;
  if (source === "scheduled" && scheduledLimit && getActiveScheduledAgentCount(runtime, registry) >= scheduledLimit) {
    throw new AppError("已达到定时任务 Agent 并发上限", "SCHEDULED_AGENT_CONCURRENCY_LIMIT_REACHED", 429);
  }
}
