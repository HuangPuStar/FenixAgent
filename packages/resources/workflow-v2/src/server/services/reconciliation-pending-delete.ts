/**
 * 对账任务（4A）的第一段：`pending_delete` 重试。
 *
 * `sync_state = 'pending_delete'` 表示「本地已不可见、上游对象可能仍在」——这条中间态只能由本段收敛：
 * 调上游删除、上游确认后终结本地行（硬删）并写审计（`workflow.delete.upstream` / `reconciled`）。
 *
 * 预算是**双闸**，任一超限即停止重试并告警（不是无限重试）：
 * - **次数上限**（{@link PENDING_DELETE_MAX_ATTEMPTS}）：进程内计数，重启即重置；
 * - **年龄上限**（{@link PENDING_DELETE_MAX_AGE_MS}）：按 `deleted_at` 算，持久生效——重启后仍能拦住
 *   「已经失败一整天」的行。
 *
 * 退避在两次重试之间拉开间隔（30s 起、逐次翻倍、封顶 30 分钟），因此单行在 24 小时内最多被打 5 次，
 * 不足以把一次确定性失败（对象已被手工删除、权限被回收）变成持续的上游配额消耗。
 */

import { createLogger } from "@fenix/logger";
import { WORKFLOW_AUDIT_ACTIONS } from "./audit-trail";
import {
  classifyRejectedResponse,
  classifyThrownFailure,
  isCancelled,
  isDeleteAccepted,
  RECONCILIATION_ACTOR_USER_ID,
  type ReconciliationRunContext,
  readPorts,
  readUpstreamCode,
  tallyFailure,
} from "./reconciliation-ports";

const logger = createLogger("wf2-reconciliation");

/** 每轮处理待删行的上限：一轮的量决定了对上游的突发压力，超出的行在下一轮继续。 */
export const PENDING_DELETE_BATCH_SIZE = 50;

/** 单行的重试次数上限（进程内计数，重启后重置）。 */
export const PENDING_DELETE_MAX_ATTEMPTS = 5;

/**
 * 单行的重试年龄上限（按 `deleted_at` 算，持久生效）。
 *
 * 取 24 小时：删除是清理动作，一天还删不掉说明是确定性失败，继续重试只是持续消耗上游配额；此时应当由人
 * 介入（日志告警给出组织与对象身份）。
 */
export const PENDING_DELETE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 退避基数与上限：30s 起、逐次翻倍、封顶 30 分钟。 */
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_MAX_MS = 30 * 60_000;

/** 待删行一轮的计数。 */
export interface PendingDeleteStats {
  readonly scanned: number;
  readonly purged: number;
  readonly failed: number;
  /** 超过次数或年龄上限、本轮起不再重试（已告警）。 */
  readonly exhausted: number;
  /** 退避窗口内本轮跳过（不是失败）。 */
  readonly deferred: number;
}

/** 单行的重试账：次数与下次可重试时刻（进程内；持久化的预算只有年龄）。 */
interface AttemptState {
  attempts: number;
  nextRetryAtMs: number;
}

const attemptState = new Map<string, AttemptState>();
/** 已告警过的「超限」行（按行 ID）：避免每轮重复刷同一条告警。 */
const exhaustedNotified = new Set<string>();

/** 测试用：清空重试账与告警去重表。 */
export function resetPendingDeleteState(): void {
  attemptState.clear();
  exhaustedNotified.clear();
}

/** 退避：30s × 2^(attempts-1)，封顶 30 分钟。 */
function backoffMs(attempts: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_BACKOFF_MAX_MS);
}

/** 单行重试结算：记下次可重试时刻，返回失败分类（由调用方累加计数与日志）。 */
function scheduleRetry(rowId: string, attempts: number, nowMs: number): void {
  attemptState.set(rowId, { attempts, nextRetryAtMs: nowMs + backoffMs(attempts) });
}

/**
 * 收敛待删行；返回本轮扫描到的行数。
 *
 * `spaceId` 为 null 时**不做任何上游调用**：没有空间 ID 就调不动上游删除，本轮直接计为不完整并告警。
 */
export async function reconcilePendingDelete(
  context: ReconciliationRunContext,
  spaceId: string | null,
  stats: { purged: number; failed: number; exhausted: number; deferred: number },
): Promise<number> {
  const ports = readPorts();
  const rows = await ports.listPendingDelete(PENDING_DELETE_BATCH_SIZE);
  if (rows.length === 0) return 0;
  if (spaceId === null) {
    tallyFailure(context.failures, "local_failure");
    logger.warn("workflow-v2 对账：平台账号台账缺行，本轮无法重试待删对象", { pending: rows.length });
    return rows.length;
  }

  for (const row of rows) {
    if (isCancelled(context)) break;
    const state = attemptState.get(row.id);
    const ageMs = context.now - row.deletedAt.getTime();
    if (ageMs > PENDING_DELETE_MAX_AGE_MS || (state?.attempts ?? 0) >= PENDING_DELETE_MAX_ATTEMPTS) {
      stats.exhausted += 1;
      if (!exhaustedNotified.has(row.id)) {
        exhaustedNotified.add(row.id);
        logger.error("workflow-v2 对账：待删对象超过重试上限，停止重试并等待人工介入", {
          organizationId: row.organizationId,
          upstreamWorkflowId: row.upstreamWorkflowId,
          ageMs,
          attempts: state?.attempts ?? 0,
        });
      }
      continue;
    }
    if (state !== undefined && context.now < state.nextRetryAtMs) {
      stats.deferred += 1;
      continue;
    }

    const attempts = (state?.attempts ?? 0) + 1;
    let result: Awaited<ReturnType<typeof ports.callUpstream>>;
    try {
      result = await ports.callUpstream({
        path: "/api/workflow_api/delete",
        body: { workflow_id: row.upstreamWorkflowId, space_id: spaceId },
      });
    } catch (error) {
      const reason = classifyThrownFailure(error);
      stats.failed += 1;
      tallyFailure(context.failures, reason);
      scheduleRetry(row.id, attempts, context.now);
      logger.warn("workflow-v2 对账：上游删除调用失败，退避后重试", {
        organizationId: row.organizationId,
        upstreamWorkflowId: row.upstreamWorkflowId,
        attempts,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!isDeleteAccepted(result)) {
      const reason = classifyRejectedResponse(result);
      stats.failed += 1;
      tallyFailure(context.failures, reason);
      scheduleRetry(row.id, attempts, context.now);
      logger.warn("workflow-v2 对账：上游删除未被接受，退避后重试", {
        organizationId: row.organizationId,
        upstreamWorkflowId: row.upstreamWorkflowId,
        attempts,
        reason,
        upstreamStatus: result.status,
        upstreamCode: readUpstreamCode(result.body),
      });
      continue;
    }

    const purged = await ports.purgePendingDelete(row.organizationId, row.id);
    attemptState.delete(row.id);
    exhaustedNotified.delete(row.id);
    if (purged === 0) {
      // 行已被别的路径终结（多副本并发、或对象被重新登记）：删除目标已达成，不计失败也不重复写审计。
      logger.info("workflow-v2 对账：待删行已被其它路径终结", {
        organizationId: row.organizationId,
        upstreamWorkflowId: row.upstreamWorkflowId,
      });
      continue;
    }
    stats.purged += 1;
    await ports.appendAuditLog({
      organizationId: row.organizationId,
      actorUserId: RECONCILIATION_ACTOR_USER_ID,
      action: WORKFLOW_AUDIT_ACTIONS.deleteUpstream,
      upstreamWorkflowId: row.upstreamWorkflowId,
      requestId: null,
      result: "reconciled",
      errorCode: null,
    });
  }
  return rows.length;
}
