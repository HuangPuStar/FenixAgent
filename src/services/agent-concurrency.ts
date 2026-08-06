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
  // 顺带清空 in-flight 预留：预留是模块级内存状态，恢复默认须一并还原（A-P2.1）
  pendingReservations.clear();
}

/**
 * 一次 spawn 的并发额度预留（A-P2.1）。
 *
 * 通过 beginSpawnReservation 登记、releaseSpawnReservation 释放。token 用于
 * release 时按引用精确配对，避免并发释放错配（Set 按对象引用删除本就安全，
 * token 仅为诊断与未来分布式演进保留可追踪标识）。
 */
export interface SpawnReservation {
  readonly token: number;
  readonly userId: string;
  readonly source: InstanceSpawnSource;
}

/** 预留 token 自增序列：保证每个预留引用唯一。 */
let reservationTokenSeq = 0;

/**
 * 已通过并发检查、实例尚未在 core 快照 / supplement 可见的 in-flight 预留。
 *
 * 设计原因（A-P2.1）：检查（assertAgentConcurrencyAvailable）与 supplement 注册
 * 之间隔着 controller.spawnInstance、LaunchSpec 构建、core launch 等多个 await，
 * 期间新实例在用户级/定时级统计中完全不可见，N 个并发 spawn 可全部通过检查造成
 * 超发。begin/release 均为同步函数（Bun 单线程 event loop 下 Set 操作原子），
 * 检查与登记合并到同一同步段即消除该窗口。
 *
 * 已知残余：进程崩溃时集合随内存消失，与 supplement / core 快照行为一致，
 * 无持久化残留；若未来引入多进程部署，本内存预留需升级为分布式预留（Redis）。
 */
const pendingReservations = new Set<SpawnReservation>();

/** 测试用：读取当前 in-flight 预留集合（只读视图）。 */
export function getPendingSpawnReservations(): ReadonlySet<SpawnReservation> {
  return pendingReservations;
}

/**
 * 并发检查 + in-flight 预留（同步，无 await 间隙）。
 *
 * 检查通过后立即登记预留；检查失败时抛错且不登记（无残留）。
 * 调用方必须用 try/finally 保证 releaseSpawnReservation，失败路径同样释放，
 * 否则额度被永久占用。
 */
export function beginSpawnReservation(userId: string, source: InstanceSpawnSource): SpawnReservation {
  assertAgentConcurrencyAvailable(userId, source);
  const reservation: SpawnReservation = { token: ++reservationTokenSeq, userId, source };
  pendingReservations.add(reservation);
  return reservation;
}

/** 释放 in-flight 预留：按引用幂等（重复释放无效果），不与并发预留错配。 */
export function releaseSpawnReservation(reservation: SpawnReservation): void {
  pendingReservations.delete(reservation);
}

/** 判断 runtime 实例是否仍属于活跃并发。 */
export function isActiveRuntimeStatus(status: RuntimeInstanceStatus): boolean {
  return status !== "stopped" && status !== "stopping" && status !== "error";
}

/** 统计 runtime 中全部活跃实例数（含 in-flight 预留，A-P2.1）。 */
export function getActiveAgentCount(runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime()): number {
  return (
    runtime.listInstances().filter((snapshot) => isActiveRuntimeStatus(snapshot.status)).length +
    pendingReservations.size
  );
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
  // in-flight 预留：实例尚未在 core 快照 / supplement 可见，按来源计入对应桶（A-P2.1）
  for (const reservation of pendingReservations) {
    if (reservation.source === "scheduled") count += 1;
  }
  return count;
}

/** 统计指定用户的活跃实例数。 */
export function getActiveUserAgentCount(
  userId: string,
  runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime(),
  registry: Pick<InstanceRegistry, "get"> = _deps.registry,
): number {
  let count = 0;
  for (const snapshot of runtime.listInstances()) {
    if (!isActiveRuntimeStatus(snapshot.status)) continue;
    const supplement = registry.get(snapshot.instanceId) as InstanceSupplement | undefined;
    if (!supplement) continue;
    if (supplement.userId === userId) count += 1;
  }
  // in-flight 预留：实例尚未在 core 快照 / supplement 可见，按 userId 计入（A-P2.1）。
  // 不会与正式统计重复：release 与 registerSupplement 完成处于同一同步段，
  // 外部观察者（事件循环边界）永远看不到"正式计数 + pending"并存。
  for (const reservation of pendingReservations) {
    if (reservation.userId === userId) count += 1;
  }
  return count;
}

/**
 * 在实例启动前校验当前来源对应的并发额度。
 *
 * 注意：本函数只读统计、不登记任何 in-flight 状态，单独调用无法消除
 * "检查 → 实例可见" 窗口内的并发不可见（A-P2.1）。spawn 流程必须使用
 * beginSpawnReservation / releaseSpawnReservation 配对，检查与登记在同一
 * 同步段完成；本函数即 beginSpawnReservation 的前置检查步骤，禁止绕过
 * reservation 单独调用。
 */
export function assertAgentConcurrencyAvailable(
  userId: string,
  source: InstanceSpawnSource,
  runtime: Pick<CoreRuntimeFacade, "listInstances"> = _deps.getRuntime(),
  registry: Pick<InstanceRegistry, "get"> = _deps.registry,
): void {
  const totalLimit = config.agentMaxConcurrency;
  if (totalLimit && getActiveAgentCount(runtime) >= totalLimit) {
    throw new AppError("已达到 Agent 总并发上限", "AGENT_CONCURRENCY_LIMIT_REACHED", 429);
  }

  const userLimit = config.userAgentMaxConcurrency;
  if (userLimit && getActiveUserAgentCount(userId, runtime, registry) >= userLimit) {
    throw new AppError("已达到当前用户 Agent 并发上限", "USER_AGENT_CONCURRENCY_LIMIT_REACHED", 429);
  }

  const scheduledLimit = config.scheduledAgentMaxConcurrency;
  if (source === "scheduled" && scheduledLimit && getActiveScheduledAgentCount(runtime, registry) >= scheduledLimit) {
    throw new AppError("已达到定时任务 Agent 并发上限", "SCHEDULED_AGENT_CONCURRENCY_LIMIT_REACHED", 429);
  }
}
