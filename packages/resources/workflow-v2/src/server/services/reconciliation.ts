/**
 * 对账任务（4A）：补偿状态机的收敛入口。
 *
 * 存在的理由（设计 §3.4「一致性策略」）：删除是双方动作——本地软删先行（`sync_state = 'pending_delete'`），
 * 上游删除可能失败；创建是「先上游后本地」——上游建成而本地写库失败会留下无归属对象。这两种中间态都不会
 * 自愈，必须由周期任务收敛，否则「本地已不可见的上游对象」会一直留在上游，而「上游存在、本地不认识的对象」
 * 永远回不到控制台。
 *
 * 本文件只做编排与生命周期，两段收敛各在：
 * - {@link reconcilePendingDelete}（`reconciliation-pending-delete.ts`）：待删行重试与预算；
 * - {@link reconcileOrphans}（`reconciliation-orphans.ts`）：孤儿补写与创建补偿收敛。
 *
 * 可观测性：每轮结束时写一条结构化汇总日志（计数 + 失败原因分类），并把同一份快照留在进程内
 * （{@link getReconciliationStatus}）。**不新增 `/web/*` 接口**：对账是后台收敛，不是控制台动作。
 * 日志只含上游标识、状态码与固定原因标签——凭据、会话值、票据与上游响应体一律不入日志。
 *
 * 生命周期：{@link startReconciliationScheduler} 在模块装配时启动一个 `unref` 定时器（周期取
 * `reconcileIntervalSeconds`，`0` 即禁用），模块清理时 {@link stopReconciliationScheduler} 停表并中止
 * 在途的一轮；{@link runReconciliationOnce} **单飞**——重入的调用共享同一轮，不会出现两轮同时打上游。
 *
 * 多副本部署：每个副本各跑各的。候选筛选与写回都按（组织 + 上游身份）幂等，重复执行只多几次上游调用，
 * 不会写出第二行（「先查后写」+ `upstream_workflow_id` 唯一索引共同保证）；进程内的重试账与告警去重表因此
 * 只服务本副本。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { type OrphanStats, reconcileOrphans } from "./reconciliation-orphans";
import {
  type PendingDeleteStats,
  reconcilePendingDelete,
  resetPendingDeleteState,
} from "./reconciliation-pending-delete";
import {
  type ReconciliationFailureReason,
  type ReconciliationRunContext,
  readPorts,
  resetReconciliationPorts,
  tallyFailure,
  tallyToRecord,
} from "./reconciliation-ports";

const logger = createLogger("wf2-reconciliation");

/** 一轮对账的结果快照：同时用于结构化日志与进程内状态（{@link getReconciliationStatus}）。 */
export interface ReconciliationReport {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly pendingDelete: PendingDeleteStats;
  readonly orphan: OrphanStats;
  /** 本轮是否不完整（上游不可用、本地读写异常、达到扫描上限）。 */
  readonly degraded: boolean;
  /** 失败原因分类计数；空对象表示本轮无失败。 */
  readonly failureReasons: Readonly<Partial<Record<ReconciliationFailureReason, number>>>;
}

/** 进程内可观测快照（无 `/web/*` 接口，只服务日志与排障）。 */
export interface ReconciliationStatus {
  /** 定时器是否在跑（周期为 `0` 或装配期读不到配置时为 false）。 */
  readonly scheduled: boolean;
  readonly intervalSeconds: number | null;
  /** 是否有正在执行的一轮。 */
  readonly running: boolean;
  readonly lastRunAt: string | null;
  readonly lastReport: ReconciliationReport | null;
  /** 连续「有失败」的轮数（全清归零）。 */
  readonly consecutiveFailures: number;
}

let activeRun: Promise<ReconciliationReport> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerIntervalSeconds: number | null = null;
let schedulerController: AbortController | null = null;
let lastRunAtMs: number | null = null;
let lastReport: ReconciliationReport | null = null;
let consecutiveFailures = 0;

/** 执行一轮对账；调用方保证同一时刻只有一轮（{@link runReconciliationOnce} 单飞）。 */
async function executeRun(signal: AbortSignal | undefined): Promise<ReconciliationReport> {
  const ports = readPorts();
  const startedAtMs = ports.clock();
  const context: ReconciliationRunContext = { now: startedAtMs, signal, failures: new Map() };
  const pendingDelete = { scanned: 0, purged: 0, failed: 0, exhausted: 0, deferred: 0 };
  const orphan = { organizations: 0, upstream: 0, backfilled: 0, cleaned: 0, cleanupFailed: 0, undetermined: 0 };

  let spaceId: string | null = null;
  try {
    spaceId = await ports.findPlatformSpaceId();
    pendingDelete.scanned = await reconcilePendingDelete(context, spaceId, pendingDelete);
  } catch (error) {
    tallyFailure(context.failures, "local_failure");
    logger.error("workflow-v2 对账：待删对象收敛失败（本地读写异常）", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    if (context.failures.has("circuit_open")) {
      // 熔断打开：本轮的 pending_delete 收敛已经用掉了唯一名额，孤儿扫描再打上游只会被短路（还要多花一次
      // 判定），直接跳过——上游恢复后下一轮照常。
      logger.warn("workflow-v2 对账：上游熔断打开，本轮跳过孤儿扫描");
    } else if (spaceId === null) {
      logger.warn("workflow-v2 对账：平台账号台账缺行，跳过孤儿扫描");
    } else {
      await reconcileOrphans(context, spaceId, orphan);
    }
  } catch (error) {
    tallyFailure(context.failures, "local_failure");
    logger.error("workflow-v2 对账：孤儿扫描失败（本地读写异常）", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const durationMs = ports.clock() - startedAtMs;
  const report: ReconciliationReport = {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs,
    pendingDelete,
    orphan,
    degraded: context.failures.size > 0,
    failureReasons: tallyToRecord(context.failures),
  };

  lastRunAtMs = ports.clock();
  lastReport = report;
  // 「预算用尽」只说明本轮没扫完（下一轮继续），不计入连续失败；其余降级原因都是需要盯的真失败。
  const hardFailure = [...context.failures.keys()].some((reason) => reason !== "budget_exhausted");
  const failed = hardFailure || pendingDelete.failed > 0 || pendingDelete.exhausted > 0;
  consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
  // 汇总成一条日志：洪峰下逐条日志本身会变成放大面，计数与分类在这里一次给全。
  if (failed) logger.warn("workflow-v2 对账一轮结束（有失败或超限）", { ...report });
  else logger.info("workflow-v2 对账一轮结束", { ...report });
  return report;
}

/**
 * 执行一轮对账（单飞）。
 *
 * 单飞的理由与 `upstream-session` 同源：定时器与「上一轮还没跑完」叠加时，两轮会同时扫描同一批候选并各自发起
 * 上游删除——重入不是性能问题，而是重复写与重复上游调用。重入的调用拿到同一个 Promise，因此测试与运维
 * 可以放心地并发触发而不担心放大。
 */
export function runReconciliationOnce(options: { signal?: AbortSignal } = {}): Promise<ReconciliationReport> {
  if (activeRun !== null) return activeRun;
  const run = executeRun(options.signal).finally(() => {
    if (activeRun === run) activeRun = null;
  });
  activeRun = run;
  return run;
}

/**
 * 启动周期对账；返回是否真的排上了定时器。
 *
 * 装配期语义（由 `createWorkflowV2ServerModule` 调用）：**永不抛错**——读不到模块配置（测试进程、宿主尚未
 * 投影配置）或周期为 `0` 都只记日志并返回 false；对账是后台收敛，不能因为它失败而让模块装配失败。
 * 定时器 `unref()`：不因为一个后台任务拖住进程退出。
 */
export function startReconciliationScheduler(): boolean {
  if (schedulerTimer !== null) return true;
  let intervalSeconds: number;
  try {
    intervalSeconds = getWorkflowV2Config().reconcileIntervalSeconds;
  } catch (error) {
    logger.warn("workflow-v2 对账任务未启动：模块配置不可读", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (intervalSeconds <= 0) {
    logger.info("workflow-v2 对账任务已按配置禁用", { reconcileIntervalSeconds: intervalSeconds });
    return false;
  }

  const controller = new AbortController();
  const timer = setInterval(() => {
    void runReconciliationOnce({ signal: controller.signal }).catch((error: unknown) => {
      // 一轮内的失败已在 executeRun 里分类并记日志；这里兜底的是「executeRun 自己抛了」的意外路径。
      logger.error("workflow-v2 对账一轮未预期失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalSeconds * 1000);
  timer.unref?.();
  schedulerController = controller;
  schedulerTimer = timer;
  schedulerIntervalSeconds = intervalSeconds;
  logger.info("workflow-v2 对账任务已启动", { intervalSeconds });
  return true;
}

/** 停止周期对账并中止在途的一轮；幂等，模块清理与用例复位都调用它。 */
export function stopReconciliationScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerController?.abort();
  schedulerController = null;
  schedulerIntervalSeconds = null;
}

/** 读取进程内对账状态（同步、无副作用）。 */
export function getReconciliationStatus(): ReconciliationStatus {
  return {
    scheduled: schedulerTimer !== null,
    intervalSeconds: schedulerIntervalSeconds,
    running: activeRun !== null,
    lastRunAt: lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString(),
    lastReport,
    consecutiveFailures,
  };
}

/** 测试用：停表并清空全部进程内状态（重试账、最近一轮快照、端口替身）。 */
export function resetReconciliationForTests(): void {
  stopReconciliationScheduler();
  resetPendingDeleteState();
  resetReconciliationPorts();
  activeRun = null;
  lastRunAtMs = null;
  lastReport = null;
  consecutiveFailures = 0;
}
