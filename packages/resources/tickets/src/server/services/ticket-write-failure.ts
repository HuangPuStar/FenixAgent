/**
 * 远端写入失败的统一收敛（T03 的三条写路径共用）。
 *
 * 三条写路径（工单修改、评论、标签）的失败分支完全同形：非 Git 异常原样上抛并保持 `dispatching`（交恢复
 * 核对）、`WRITE_UNCERTAIN` 落 `uncertain` 并返回 202、上游确定拒绝落 `failed` 并抛出映射后的错误。复制
 * 三份的代价不是重复代码，而是三份对「哪些失败算确定」的判定迟早不同——某一份漏掉 `WRITE_UNCERTAIN`
 * 的排除，就会把一次可能已生效的写入报成失败并鼓励用户重提。
 *
 * 与 T02 `ticket-service.ts` 的 `handleCreateFailure` 判定顺序一致，差别只有一处：对外错误的映射由调用点
 * 经 `toError` 注入。同一个 Git 码在不同路径上语义不同（`comments.edit` 的 `NOT_FOUND` 是「评论已被删除」，
 * `labels.create` 的 `CONFLICT` 是「同名标签已存在」），映射表必须留在调用点。
 */

import { error as logError } from "@fenix/logger";
import type { AppError } from "@fenix/platform-sdk";
import { toOperationFailureResult } from "../errors";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { TICKET_OPERATION_STEP, type TicketOperationService } from "./ticket-operation-service";

export interface TicketWriteFailureInput {
  readonly operations: TicketOperationService;
  readonly operationId: string;
  readonly error: unknown;
  /** 确定失败的对外映射；调用点按自己的语义给出（同一个 Git 码在不同路径上含义不同）。 */
  readonly toError: (failure: Extract<GitFailureKind, { kind: "definite" }>) => AppError;
}

/**
 * 收敛一次远端写失败。
 *
 * 正常返回（不抛）只表示一种情形：结果未定，`uncertain` 已落账，调用方据此返回 202。另外两种都以抛错
 * 结束——非 Git 异常原样上抛（保持 `dispatching` 交恢复核对，绝不把偶发故障固化成幂等键的永久失败），
 * 上游确定拒绝写完 `failed` 终态后抛出映射错误（同键重放由账本还原同一个错误）。
 *
 * 未定态的 `step` 固定回落到 `dispatching`：此刻远端可能已写入也可能没有，写一个具体步骤名会让核对与
 * 排障误以为「该步已确认完成」。
 */
export async function settleTicketWriteFailure(input: TicketWriteFailureInput): Promise<void> {
  const failure = classifyGitFailure(input.error);
  if (failure === undefined) throw input.error;
  if (failure.kind === "uncertain") {
    await input.operations.markUncertain({
      operationId: input.operationId,
      step: TICKET_OPERATION_STEP.dispatching,
    });
    return;
  }
  const mapped = input.toError(failure);
  await input.operations.fail({
    operationId: input.operationId,
    step: TICKET_OPERATION_STEP.upstreamFailed,
    result: toOperationFailureResult(mapped),
  });
  throw mapped;
}

/** 「远端已写入、本地收尾未完成」时对外返回的形状（202 的 `uncertain` 分支，§6.2 条件 3）。 */
export interface TicketWriteUncertain {
  readonly kind: "uncertain";
  readonly operationId: string;
}

/**
 * 远端写入**已成功**、本地终态未提交时的统一收敛（§6.2 条件 3）。
 *
 * 三条写路径（工单修改 / 评论 / 标签）在这里的行为必须一致：响应说成功是说谎（本地没记完），说失败也是
 * 说谎（远端已落库），因此只能返回 202 并把诊断上下文交给日志；账本保持 `dispatching`、`step` 停在远端
 * 那一步，由恢复核对按 `intent` 回源补齐。日志只带账本坐标与远端对象号，不带请求正文（§12.6）。
 */
export function localWriteFailed(input: {
  readonly operationId: string;
  readonly projectId: string;
  /** 远端对象坐标：工单号 / 评论 ID / 标签 ID / 附件编号。 */
  readonly targetId: string;
  readonly targetKind: "issue" | "comment" | "label" | "attachment";
  readonly error: unknown;
}): TicketWriteUncertain {
  logError("远端已写入，本地终态写入失败：转 202 待恢复核对", {
    operationId: input.operationId,
    projectId: input.projectId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    error: input.error,
  });
  return { kind: "uncertain", operationId: input.operationId };
}
