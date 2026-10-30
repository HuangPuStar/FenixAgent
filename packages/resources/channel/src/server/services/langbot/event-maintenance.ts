import { error as logError } from "@fenix/logger";
import { getChannelConfig } from "../../config";
import { createImChannelEventRepository, type ImChannelEventRepository } from "../../repositories/im-channel-event";

/**
 * 入站事件的启动维护与正文保留（规格 §5.5 / §6.3）。
 *
 * 两件事必须分开计时：
 * 1. **重启标记**：上一个进程的 `received` / `delivered` 事件不可能再被本进程投递，启动时一次性标记
 *    `failed`（`reason=restart`），不重放。这是「重启只保证进程内」的唯一收口。
 * 2. **保留策略**：未读正文在 `received_at + IM_EVENT_TEXT_TTL_HOURS` 后置空；终态事件按状态整行删除，
 *    避免元数据无限增长。
 *
 * 所有函数都接受注入的仓储，便于用例不接触真实数据库；默认实现按调用时取平台 DB 句柄。
 */

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
/** `delivered` / `skipped` 已无消费者，只留 7 天供排障回看投递结果。 */
const TERMINAL_EVENT_RETENTION_DAYS = 7;
/** `failed` 的失败原因需要更长的排障窗口，但同样不能无限保留。 */
const FAILED_EVENT_RETENTION_DAYS = 30;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 把遗留的 `received` / `delivered` 标记为失败；返回受影响行数。 */
export async function markInterruptedImDeliveriesFailed(
  input: { events?: ImChannelEventRepository; at?: Date } = {},
): Promise<number> {
  const events = input.events ?? createImChannelEventRepository();
  return events.markUnfinishedAsFailed({ reason: "restart", at: input.at ?? new Date() });
}

/** 清空早于 `now - ttlHours` 的未读正文；只清正文，保留事件行。 */
export async function clearExpiredImEventTexts(
  input: { events?: ImChannelEventRepository; ttlHours?: number; now?: Date } = {},
): Promise<number> {
  const events = input.events ?? createImChannelEventRepository();
  const ttlHours = input.ttlHours ?? getChannelConfig().imEventTextTtlHours;
  const now = input.now ?? new Date();
  return events.clearTextsBefore({ before: new Date(now.getTime() - ttlHours * 60 * 60 * 1_000) });
}

/** 一次维护的结果；分状态计数，便于运维确认哪一类保留策略在生效。 */
export interface ImEventMaintenanceResult {
  readonly textsCleared: number;
  readonly deliveredDeleted: number;
  readonly skippedDeleted: number;
  readonly failedDeleted: number;
}

/** 执行一次维护：清正文 + 删除过期的终态事件行；定时器与运维手动触发共用。 */
export async function runImEventMaintenance(
  input: { events?: ImChannelEventRepository; ttlHours?: number; now?: Date } = {},
): Promise<ImEventMaintenanceResult> {
  const events = input.events ?? createImChannelEventRepository();
  const now = input.now ?? new Date();
  const textsCleared = await clearExpiredImEventTexts({
    events,
    now,
    ...(input.ttlHours === undefined ? {} : { ttlHours: input.ttlHours }),
  });

  const terminalBefore = new Date(now.getTime() - TERMINAL_EVENT_RETENTION_DAYS * MS_PER_DAY);
  const failedBefore = new Date(now.getTime() - FAILED_EVENT_RETENTION_DAYS * MS_PER_DAY);
  // 每个状态单独一次删除：合并成一次往返会丢失分状态计数。
  const deliveredDeleted = await events.deleteTerminalBefore({ statuses: ["delivered"], before: terminalBefore });
  const skippedDeleted = await events.deleteTerminalBefore({ statuses: ["skipped"], before: terminalBefore });
  const failedDeleted = await events.deleteTerminalBefore({ statuses: ["failed"], before: failedBefore });

  return { textsCleared, deliveredDeleted, skippedDeleted, failedDeleted };
}

/**
 * 启动周期清理（默认每小时）。
 *
 * 启动即跑一次，避免进程停机期间跨过 TTL 的正文多留一个周期。定时器 `unref`，不阻止进程退出。
 */
export function startImEventMaintenance(options: { intervalMs?: number } = {}): void {
  if (cleanupTimer) return;
  const tick = (): void => {
    void runImEventMaintenance().catch((error) => {
      logError("IM 事件维护失败", error instanceof Error ? error : undefined);
    });
  };
  tick();
  const handle: unknown = setInterval(tick, options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  (handle as { unref?: () => void }).unref?.();
  cleanupTimer = handle as ReturnType<typeof setInterval>;
}

/** 停止周期清理；进程关闭与测试复位使用。 */
export function stopImEventMaintenance(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
