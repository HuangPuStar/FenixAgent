/**
 * 单次回源核对：把「远端可能已写入、本端未收尾」的操作补成终态（backend contract §8，冻结给 T04）。
 *
 * 三条不可动摇的口径：
 * 1. **只读远端**：核对绝不调用任何写方法（可见的远端面只有 `list`/`get`，见 {@link RecoveryRemote}）；
 *    远端确实没落库时也只写账本（`not_applied`），让用户换键重提。
 * 2. **有界**：扫描最多 `RECOVERY_SCAN_MAX_PAGES` 页、窗口从 `intent.since` 起；找不到就保持原状态，
 *    「暂时没有」不得认定失败（§9.6）。超过 15 分钟仍未找到 → `needs_review` 交人工（§8.3）。
 * 3. **并发安全**：远端读在事务外，落终态在事务内先对该行 `SELECT ... FOR UPDATE` 并复查状态，因此两个
 *    并发核对最多一个生效（另一个读到的已是终态，直接返回）。
 *
 * 判定口径（逐 kind 的回源方式与匹配判据）在 `ticket-recovery-inspect.ts` 及其三个域文件里；本文件只管
 * 状态机与事务。判定不引入定时器：核对时比较 `now - created_at`，T04 的周期扫描只需要按 5/15/30/60 秒
 * 调用本服务。
 */

import type { GitService } from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { OperationNotFoundError, TicketWriteNotAppliedError, toOperationFailureResult } from "../errors";
import type { TicketIndexRepository } from "../repositories/ticket-index";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import type { TicketOperationRepository, TicketOperationRow } from "../repositories/ticket-operations";
import type { TicketProjectRepository } from "../repositories/ticket-projects";
import { RECOVERY_NEEDS_REVIEW_AFTER_MS } from "./ticket-limits";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import { createTicketRecoveryInspector } from "./ticket-recovery-inspect";

/** 恢复核对的结果（§8.2 冻结给 T04）；三种结论都携带核对后的账本行，供 `GET /ticket-operations/:id` 直接投影。 */
export type TicketRecoveryOutcome =
  | { readonly kind: "settled"; readonly operation: TicketOperationRow }
  | { readonly kind: "unchanged"; readonly operation: TicketOperationRow }
  | { readonly kind: "needs_review"; readonly operation: TicketOperationRow };

export interface TicketRecoveryService {
  /**
   * 单次核对：只在 `dispatching` / `uncertain` 时执行；**不做任何远端写入**，只回源读取。
   * 并发安全：读远端在事务外，落终态在同一事务内先对该行 `SELECT ... FOR UPDATE` 并复查状态。
   */
  reconcile(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly operationId: string;
  }): Promise<TicketRecoveryOutcome>;
}

export interface TicketRecoveryServiceDeps {
  readonly git: GitService;
  /** 解析 `projectId → 绑定`；核对不做授权判定（可见性已由 `findForActor` 与他本人的操作行绑定）。 */
  readonly projects: TicketProjectRepository;
  readonly operations: TicketOperationRepository;
  readonly index: TicketIndexRepository;
  readonly messages: TicketMessageRepository;
  /** 补齐归属行时的作者显示名；缺失只影响展示快照，不影响归属判定。 */
  readonly identity: IdentityDirectory;
}

/** 需要核对的状态：`dispatching` 是崩溃/在途残留，`uncertain` 是结果未定；`needs_review` 等人处理。 */
const RECONCILABLE_STATUSES: ReadonlySet<string> = new Set(["dispatching", "uncertain"]);

export function createTicketRecoveryService(deps: TicketRecoveryServiceDeps): TicketRecoveryService {
  const inspector = createTicketRecoveryInspector({
    git: deps.git,
    projects: deps.projects,
    index: deps.index,
    messages: deps.messages,
    identity: deps.identity,
  });

  return {
    async reconcile(input) {
      const row = await deps.operations.findForActor(input);
      if (row === undefined) throw new OperationNotFoundError();
      if (!RECONCILABLE_STATUSES.has(row.status)) return outcomeFor(row);

      const verdict = await inspector.inspect(row);
      return await runInTransaction(async () => {
        const current = await deps.operations.findByIdForUpdate({ operationId: row.id });
        if (current === undefined) throw new OperationNotFoundError();
        // 复查状态：并发的另一次核对可能已经把这一行落成终态，此时不得再写第二次结论。
        if (!RECONCILABLE_STATUSES.has(current.status)) return outcomeFor(current);

        if (verdict.kind === "applied") {
          await verdict.apply?.();
          await deps.operations.markSucceeded({
            operationId: current.id,
            step: verdict.step,
            targetId: verdict.targetId,
            result: verdict.result,
            intentSummary: verdict.intentSummary,
          });
        } else if (verdict.kind === "not_applied") {
          // 远端确定没落库：写 `failed` + `WRITE_NOT_APPLIED` 投影，同键重放时还原成「可安全重提」。
          await deps.operations.markFailed({
            operationId: current.id,
            step: TICKET_OPERATION_STEP.notApplied,
            result: toOperationFailureResult(new TicketWriteNotAppliedError()),
          });
        } else if (verdict.kind === "ambiguous" || overWindow(current)) {
          await deps.operations.markUncertain({
            operationId: current.id,
            step: TICKET_OPERATION_STEP.needsReview,
            status: "needs_review",
          });
        }

        const after = await deps.operations.findByIdForUpdate({ operationId: current.id });
        if (after === undefined) throw new OperationNotFoundError();
        return outcomeFor(after);
      });
    },
  };
}

/** 账本行 → 核对结论；终态行（含 `needs_review`）在多次核对之间保持一致。 */
function outcomeFor(row: TicketOperationRow): TicketRecoveryOutcome {
  if (row.status === "succeeded" || row.status === "failed") return { kind: "settled", operation: row };
  if (row.status === "needs_review") return { kind: "needs_review", operation: row };
  return { kind: "unchanged", operation: row };
}

/** 超窗口（15 分钟）仍未找到 → `needs_review`；判定不引入定时器（§8.3）。 */
function overWindow(row: TicketOperationRow): boolean {
  return Date.now() - row.createdAt.getTime() > RECOVERY_NEEDS_REVIEW_AFTER_MS;
}
