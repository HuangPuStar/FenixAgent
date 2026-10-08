/**
 * 审计接入（3C）：把控制面的关键动作写进 `workflow_v2_audit_log`（只追加，不更新、不删除）。
 *
 * 为什么要有这一层而不是各路由直接调 `appendAuditLog`：
 * 1. **审计失败不得改变主流程结果**（设计 §5.3 / 任务口径）。审计表在同一个库里，但它的可用性不应与业务
 *    成功率绑定——写失败时降级为 error 日志并让请求照常返回。若把 `appendAuditLog` 直接摆在 handler 里，
 *    一次审计表写入异常就会把「已成功的创建」变成 500，客户端重试还会再建一个上游对象；
 * 2. `requestId` 从请求上下文（`requestAls`）自动取，路由不必手工穿参，避免有的分支传、有的分支忘传。
 *
 * 落库内容的口径（设计 §5.3）：只有身份与结果字段——**不含凭据、上游响应原文、堆栈、请求体**；`errorCode`
 * 记我方错误码，上游业务码只进日志（见 `upstream-health.logger` 与各调用点的 `upstreamCode` 字段）。
 */

import { createLogger, requestAls } from "@fenix/logger";
import { appendAuditLog, CREATE_COMPENSATION_ACTION } from "../repositories/audit-log-repository";

const logger = createLogger("wf2-audit");

/**
 * 控制面动作名（`action` 列）。
 *
 * 命名沿用 2B 已落地的 `workflow.create.compensation` 口径：`workflow.<动作>`（对象在前、动作在后），
 * 对账与排障按前缀捞取时不需要另一张对照表。动作名的字面量取在仓储层的常量（那里是「哪些审计行构成待
 * 清理队列」的存储层判据），本表只做展示与集中引用，不另抄一份。
 */
export const WORKFLOW_AUDIT_ACTIONS = {
  /** 创建：上游 `create` 完成后写本地注册表的结果。 */
  create: "workflow.create",
  /** 重命名/改元数据：上游 `update_meta` + 本地镜像更新的结果。 */
  updateMeta: "workflow.update_meta",
  /** 删除请求与本地决策（含 `strategy_rejected` 与 `pending_delete`）。 */
  delete: "workflow.delete",
  /** 删除的上游结果（本地软删之后的那一步，失败时由对账任务重试）。 */
  deleteUpstream: "workflow.delete.upstream",
  /** 创建补偿标记（本地登记失败）与对账收敛结果（`pending_cleanup` → `cleaned`）。 */
  createCompensation: CREATE_COMPENSATION_ACTION,
  /** 对账补写孤儿归属行（上游存在、本地注册表缺失的历史对象）。 */
  reconcileBackfill: "workflow.reconcile.backfill",
  /** 发布版本（成功/被上游拒绝/传输失败）。 */
  publish: "workflow.publish",
} as const;

/** 一条控制面审计流水；`result` 是归一化结果（`ok` / `failed` / `strategy_rejected` / `pending_delete` …）。 */
export interface WorkflowAuditEntry {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly upstreamWorkflowId: string | null;
  readonly result: string;
  /** 我方错误码；成功与非错误结果传 null（或省略）。 */
  readonly errorCode?: string | null;
}

/**
 * 绑定「谁、对哪个对象、做了什么」的审计写入器：handler 里只剩 `await audit("ok")` 一行。
 *
 * 存在的理由不只是省行数——把一个动作的身份字段（组织、主体、动作名、目标 workflow）在处理器入口一次性
 * 绑定，避免同一条动作的多个出口分支里有的传 `upstreamWorkflowId`、有的漏传（漏传的流水无法按对象检索）。
 */
export function createWorkflowAuditWriter(
  entry: Omit<WorkflowAuditEntry, "result" | "errorCode">,
): (result: string, errorCode?: string | null) => Promise<void> {
  return (result, errorCode = null) => recordAuditTrail({ ...entry, result, errorCode });
}

/**
 * 写一条审计流水；**永不抛错**。
 *
 * 失败降级的理由见文件头：审计是旁路事实，不是业务前置条件。降级日志里带 `action` / `result` / 失败原因，
 * 运维可据此补偿；数据库整体不可用期间审计会缺口，这是被显式接受的取舍（对账任务按注册表与上游反向扫描，
 * 不依赖审计表本身）。
 */
export async function recordAuditTrail(entry: WorkflowAuditEntry): Promise<void> {
  try {
    await appendAuditLog({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      upstreamWorkflowId: entry.upstreamWorkflowId,
      // 请求上下文由宿主中间件写入 ALS；无请求上下文的调用（对账、运维脚本）落 null。
      requestId: requestAls.getStore()?.requestId ?? null,
      result: entry.result,
      errorCode: entry.errorCode ?? null,
    });
  } catch (error) {
    logger.error("审计写入失败，已降级为日志（不改变主流程结果）", {
      action: entry.action,
      result: entry.result,
      errorCode: entry.errorCode ?? null,
      organizationId: entry.organizationId,
      // 只记错误信息，不带请求体与上游原文。
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
