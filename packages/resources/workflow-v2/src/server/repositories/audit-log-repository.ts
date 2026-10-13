import { workflowV2AuditLog } from "@fenix/resource-workflow-v2/db";
import { and, eq, inArray } from "drizzle-orm";
import { getWorkflowV2Database } from "./database";

/**
 * `workflow_v2_audit_log` 的持久化访问层：只追加，不更新、不删除。
 *
 * 审计表是控制面与透传面共用的流水（2B 的注册补偿、3C 的审计接入都写这里），因此仓储只暴露一个
 * 追加原语，由调用方决定 `action` / `result` 的口径。写入内容一律不含凭据与上游响应原文（设计 §5.3）。
 */

/** 一条审计流水；`upstreamWorkflowId` / `requestId` 可空（非请求上下文、非 workflow 级动作）。 */
export interface AuditLogAppend {
  readonly organizationId: string;
  readonly actorUserId: string;
  /** 动作名，如 `workflow.create.compensation`。 */
  readonly action: string;
  readonly upstreamWorkflowId: string | null;
  readonly requestId: string | null;
  /** 归一化结果，如 `pending_cleanup`。 */
  readonly result: string;
  readonly errorCode: string | null;
}

/** 追加一条审计流水；失败即抛错（由调用方决定是否降级为日志）。 */
export async function appendAuditLog(entry: AuditLogAppend): Promise<void> {
  await getWorkflowV2Database().insert(workflowV2AuditLog).values(entry);
}

/**
 * 创建补偿的动作名（`action` 列取值）。
 *
 * 定义在仓储层而不是服务层：它是「哪些审计行构成待清理队列」这一**存储层判据**的一部分，对账任务与
 * 注册表补偿写入两侧都按它取数；放在任何一侧的服务里都会让另一侧反向依赖。展示用的动作名清单在
 * `services/audit-trail.ts` 的 `WORKFLOW_AUDIT_ACTIONS`，那里从这里取值，不另抄一份字面量。
 */
export const CREATE_COMPENSATION_ACTION = "workflow.create.compensation";

/** 待清理态：本地登记失败、上游对象可能仍是孤儿，等对账任务删除。 */
export const PENDING_CLEANUP_RESULT = "pending_cleanup";

/** 已清理态：对账任务确认上游对象已删除后追加的终结标记（审计表只追加，故用新行而不是改旧行）。 */
export const CLEANED_RESULT = "cleaned";

/** 一条创建补偿标记（对账任务的收敛判据之一）。 */
export interface CompensationMarkerRow {
  readonly organizationId: string;
  readonly upstreamWorkflowId: string;
  /** 归一化结果：`pending_cleanup`（待清理）或 `cleaned`（已清理，收敛完成）。 */
  readonly result: string;
}

/**
 * 按上游 workflow 身份批量读创建补偿标记，按 `upstream_workflow_id` 有序。
 *
 * 为什么按身份批量读而不是按时间扫全表：调用方（对账任务）已经在上游列表里拿到了「本地注册表不认识、
 * 但上游确实存在」的候选对象，只有这些对象才需要回答「它是不是一次失败创建留下的待清理对象」。身份批量
 * 查走 `idx_workflow_v2_audit_log_action_workflow`；按时间扫只追加的审计表则要 Seq Scan（4A）。
 *
 * 空入参直接返回空结果：`IN ()` 在 SQL 里是语法错误，交给驱动去报会掩盖调用方的逻辑问题。
 */
export async function findCompensationMarkers(
  upstreamWorkflowIds: readonly string[],
): Promise<CompensationMarkerRow[]> {
  if (upstreamWorkflowIds.length === 0) return [];
  const rows = await getWorkflowV2Database()
    .select({
      organizationId: workflowV2AuditLog.organizationId,
      upstreamWorkflowId: workflowV2AuditLog.upstreamWorkflowId,
      result: workflowV2AuditLog.result,
    })
    .from(workflowV2AuditLog)
    .where(
      and(
        eq(workflowV2AuditLog.action, CREATE_COMPENSATION_ACTION),
        inArray(workflowV2AuditLog.upstreamWorkflowId, [...upstreamWorkflowIds]),
      ),
    )
    .orderBy(workflowV2AuditLog.upstreamWorkflowId);
  // `upstream_workflow_id` 可空，谓词已把它收窄成非空；这里再过滤一次是为了让返回类型对调用方非空。
  return rows.flatMap((row) =>
    row.upstreamWorkflowId === null ? [] : [{ ...row, upstreamWorkflowId: row.upstreamWorkflowId }],
  );
}
