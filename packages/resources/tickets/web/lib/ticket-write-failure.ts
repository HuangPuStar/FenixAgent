/**
 * 写失败的统一分类：把前端合同 §8.1 的错误矩阵实现成**一处**，三条写路径（工单字段 / 标签 / 评论）共用。
 *
 * 为什么必须共用：矩阵决定的不只是文案，还有「幂等键换不换代」「要不要把最新内容取回来」这些有状态后果。
 * 三份副本漂移的症状是同一个 409 在评论区弹 toast、在标签区只留内联提示——两处都「能用」，因此不会被
 * 当作 bug 报出来，只会让排查者每次都重新读三遍矩阵。
 *
 * **差异化的副作用由调用方以回调注入**：有草稿的动作（字段编辑、评论编辑、标签）要保留草稿并显示内联
 * 提示，无草稿的单值动作（指派、状态）才自动刷新一次。写死在这里会把两种口径揉成一种。
 */

import { ApiError } from "@fenix/web-runtime/api/request";
import { toast } from "sonner";
import {
  isIdempotencyConflictError,
  isNotFoundError,
  isOperationPendingError,
  isUnauthorizedError,
  isVersionConflictError,
} from "./ticket-errors";
import type { IdempotencyKeyHolder, TicketWriteOutcome } from "./ticket-write-outcome";

/**
 * 写路径整体不可用的 503 业务码：组织暂停（`TICKETS_PAUSED`）、上游故障（`GIT_UNAVAILABLE`）、
 * 上游限流（`GIT_RATE_LIMITED`）。三者的用户动作相同（稍后再试、原按钮重试），故共用一条文案。
 */
const WRITE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["TICKETS_PAUSED", "GIT_UNAVAILABLE", "GIT_RATE_LIMITED"]);

/** 判断失败是否属「写路径整体不可用」（与本次动作无关的服务端状态，重试可能成功）。 */
export function isTicketWriteUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && WRITE_UNAVAILABLE_CODES.has(error.code);
}

/**
 * 字典查询的最小能力：只声明本文件用到的形态，避免让纯逻辑依赖 i18next 的泛型签名
 * （i18next 的 `TFunction` 带命名空间/键类型参数，写在这里会把它绑进本包的逻辑层）。
 */
export type TicketTranslate = (key: string) => string;

/** 分类所需的外部依赖与差异化副作用；回调省略即该类失败没有额外副作用。 */
export interface TicketWriteFailureContext {
  readonly t: TicketTranslate;
  /** 幂等键持有者：`IDEMPOTENCY_CONFLICT` / 403 / 404 之后必须换代（失败重放语义）。 */
  readonly holder: IdempotencyKeyHolder;
  /** 通用失败文案键（`edit.failed` / `labels.failed` / `comment.createFailed` …）。 */
  readonly failureMessageKey: string;
  /** 只进 console 的定位标签（区分三条写路径，日志里才有可诊断的上下文）。 */
  readonly logLabel: string;
  /** 409 版本冲突：调用方决定「保留草稿并内联提示」还是「自动刷新一次」。 */
  readonly onVersionConflict?: () => void;
  /** 409 在途互斥（兜底通道）：刷新一次，让详情快照里的 `pendingOperationId` 接管界面。 */
  readonly onOperationPending?: () => void;
  /** 404：资源已不在原处（评论被删、工单被换掉），调用方重新对齐页面。 */
  readonly onNotFound?: () => void;
}

/**
 * 把一次写失败归类成 {@link TicketWriteOutcome}，并施加与该类绑定的固定副作用。
 *
 * 判别顺序即合同的优先级：在途互斥先于版本冲突（两者都是 409，但前者不该让用户去刷新重试），
 * 权限先于通用失败（403 不给重试入口）。**只有稳定业务码换字典文案**（在途互斥 / 版本冲突 / 幂等冲突 /
 * 403 / 404 / 503 这三码合一），这些分支的下一步动作是确定的；落到通用失败时取服务端信封原文——用固定
 * 文案盖住它，用户与排障都拿不到后端给出的原因。
 */
export function settleTicketWriteFailure(error: unknown, context: TicketWriteFailureContext): TicketWriteOutcome {
  const { t, holder } = context;
  if (isOperationPendingError(error)) {
    toast.warning(t("write.uncertainTitle"));
    context.onOperationPending?.();
    return "pending";
  }
  if (isVersionConflictError(error)) {
    context.onVersionConflict?.();
    return "conflict";
  }
  if (isIdempotencyConflictError(error)) {
    holder.reset();
    toast.error(t("write.idempotencyConflict"));
    return "failed";
  }
  if (isUnauthorizedError(error)) {
    holder.reset();
    toast.error(t("permission.denied"));
    return "denied";
  }
  if (isNotFoundError(error)) {
    holder.reset();
    toast.error(t("loadState.notFoundTitle"));
    context.onNotFound?.();
    return "failed";
  }
  if (isTicketWriteUnavailableError(error)) {
    toast.error(t("write.paused"));
    return "failed";
  }
  console.error(context.logLabel, error);
  toast.error(error instanceof Error && error.message ? error.message : t(context.failureMessageKey));
  return "failed";
}
