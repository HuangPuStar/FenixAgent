/**
 * 操作账本的领域服务：幂等声明、领取与终态的**唯一**流转入口（§8.2）。
 *
 * 这张表是「一次用户动作最多产生一次远端写入」的真相来源。上层的两条写路径（`issue.create` 与
 * `project.provision`）都必须经 {@link TicketOperationService.begin} 进入，由它给出四种裁决之一：
 * 重放既有成功、既有失败、他人正在执行、由本次执行。裁定顺序本身就是规则（同键不同哈希 409 优先于
 * 一切；已成功优先于正在执行），写在这里而不是各调用点，是刻意的——两处各写一份顺序，就会有一处把
 * 「重放成功」判成「并发执行」并返回 202。
 *
 * 为什么 `begin` 自带锁与事务：声明（INSERT ... ON CONFLICT DO NOTHING）与「读回既有行 FOR UPDATE」
 * 只有在同一个事务里才有意义；`markDispatching` 的条件更新也要与读回的裁决连续，否则两个并发请求会
 * 各自读到 `pending` 并各自尝试领取。锁只覆盖这一段本地读改写，**绝不**跨外部调用持有（见
 * `advisory-lock.ts` 文件头的偏离说明）。
 *
 * 终态写入（succeed/fail/uncertain）是薄封装：`step` 的取值是运维定位「卡在哪一步」的依据，集中在这里
 * 才能保证同一操作类型在所有路径上写同一组步骤名。
 */

import { ValidationError } from "@fenix/platform-sdk";
import { IdempotencyConflictError } from "../errors";
import { ticketsProjectLockKey, withTicketLock } from "../repositories/advisory-lock";
import type { TicketOperationRepository, TicketOperationRow } from "../repositories/ticket-operations";
import { IDEMPOTENCY_KEY_PATTERN } from "./ticket-limits";

/** 操作类型（`ticket_operations.kind`）；T02 只有这两条写路径，T03 起新增值必须同批扩视图枚举。 */
export type TicketOperationKind = "issue.create" | "project.provision";

/**
 * `step` 的取值域（§8.6 冻结给 T03 复用）。
 *
 * 步骤名是运维判断「这条操作卡在哪一段」的唯一线索：`dispatching` 表示已领取但未见终态（进程崩溃或
 * 在途），其余是各自的终态落点。新增取值必须同批更新 T03 的恢复分支，否则恢复流程会把新步骤当成
 * 「状态未知」而反复回源。
 */
export const TICKET_OPERATION_STEP = {
  /** 已领取、尚未产生终态。 */
  dispatching: "dispatching",
  /** 项目开通成功（项目行与默认切换已在同一事务内落库）。 */
  projectReady: "project_ready",
  /** 工单创建成功并写完索引。 */
  indexWritten: "index_written",
  /** 上游明确拒绝（4xx/409/503 已定论）。 */
  upstreamFailed: "upstream_failed",
  /** 建仓库响应回读的 owner 与请求不一致（决策 D1）。 */
  ownerMismatch: "owner_mismatch",
} as const;

/** `begin` 的输入；`intent` 是待发送内容的原文，成功/明确失败后由仓储改写为摘要。 */
export interface TicketOperationBeginInput {
  readonly organizationId: string;
  readonly actorId: string;
  readonly kind: TicketOperationKind;
  /** 开通项目在成功前没有项目行，因此可空。 */
  readonly projectId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** 身份头的 `message_id`；建工单时生成并随操作行同批落库，崩溃重试不会换 id。 */
  readonly messageId: string | null;
  /** 内容版本（T03 的乐观锁）；T02 恒为 null。 */
  readonly expectedVersion: string | null;
  readonly intent: Record<string, unknown>;
  /** 领取时写入的步骤名（例如 `dispatching` / `project_ready`）。 */
  readonly step: string;
}

/**
 * `begin` 的裁决。
 *
 * `acquired` 携带**落库的** `messageId` 而不是调用方刚生成的那个：同键的既有 `pending` 行保留着上一
 * 执行者写入的 id，用新 id 发请求会让游走在远端正文里的身份头与本端账本对不上，T03 按 `message_id`
 * 回源就会查不到这条操作。
 */
export type TicketOperationAdmission =
  | { readonly kind: "acquired"; readonly operationId: string; readonly messageId: string | null }
  | {
      readonly kind: "replayed";
      readonly operationId: string;
      readonly targetId: string | null;
      readonly result: Readonly<Record<string, unknown>>;
      readonly messageId: string | null;
    }
  | { readonly kind: "in_flight"; readonly operationId: string }
  | {
      readonly kind: "failed";
      readonly operationId: string;
      readonly result: Readonly<Record<string, unknown>> | null;
    };

export interface TicketOperationService {
  /** §8.2 步骤 1–2：声明 + 领取，在一把组织级短锁与一个事务内完成。 */
  begin(input: TicketOperationBeginInput): Promise<TicketOperationAdmission>;
  succeed(input: {
    readonly operationId: string;
    readonly step: string;
    readonly targetId: string | null;
    readonly result: Record<string, unknown>;
    readonly intentSummary: Record<string, unknown>;
  }): Promise<void>;
  /** 明确失败（4xx/409 已定论）：写终态并持久化对外错误，重放时还原同一个错误，不重试。 */
  fail(input: {
    readonly operationId: string;
    readonly step: string;
    readonly result: Record<string, unknown>;
  }): Promise<void>;
  /** 结果未定（`WRITE_UNCERTAIN`、崩溃残留）：保留 intent 原文供 T03 按 `message_id` 回源核对。 */
  markUncertain(input: { readonly operationId: string; readonly step: string }): Promise<void>;
  /** 可见性：仅操作的 actor 本人（决策 D5），查不到一律 404。 */
  findForActor(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly operationId: string;
  }): Promise<TicketOperationRow | undefined>;
}

export function createTicketOperationService(operations: TicketOperationRepository): TicketOperationService {
  return {
    async begin(input) {
      // 幂等键的格式在这里复检（§8.3 步骤 1）：路由校验挡不住直接调用本服务的路径，而键会被写进
      // `varchar(128)` 列——超长键在数据库层报错会把一次 400 变成 500。
      if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
        throw new ValidationError("Idempotency-Key 不合法：需 8–128 位字母、数字、下划线或短横线");
      }
      return withTicketLock(ticketsProjectLockKey(input.organizationId), async () => {
        const { outcome, row } = await operations.claim({
          organizationId: input.organizationId,
          actorId: input.actorId,
          kind: input.kind,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          messageId: input.messageId,
          expectedVersion: input.expectedVersion,
          intent: input.intent,
        });

        if (outcome === "existing") {
          // 顺序即优先级（§8.2）：异内容同键先判 409，再依次判成功、未定、执行中、待领取。
          if (row.requestHash !== input.requestHash) {
            throw new IdempotencyConflictError();
          }
          if (row.status === "succeeded") {
            return {
              kind: "replayed" as const,
              operationId: row.id,
              targetId: row.targetId,
              result: row.result ?? {},
              messageId: row.messageId,
            };
          }
          if (row.status === "failed") return { kind: "failed" as const, operationId: row.id, result: row.result };
          // `dispatching` / `uncertain` / `needs_review` 都表示「本端已有一份在途或未定的写入」：返回 202
          // 而不是重发请求，绝不为了「给个结果」而制造第二次远端写入。
          if (row.status !== "pending") return { kind: "in_flight" as const, operationId: row.id };
        }

        // 待领取（新建行或上一执行者尚未领取）：条件更新是并发下唯一的执行者选举点。
        const acquired = await operations.markDispatching({ operationId: row.id, step: input.step });
        if (!acquired) return { kind: "in_flight" as const, operationId: row.id };
        return { kind: "acquired" as const, operationId: row.id, messageId: row.messageId };
      });
    },

    async succeed(input) {
      await operations.markSucceeded(input);
    },

    async fail(input) {
      await operations.markFailed(input);
    },

    async markUncertain(input) {
      await operations.markUncertain(input);
    },

    async findForActor(input) {
      return operations.findForActor(input);
    },
  };
}
