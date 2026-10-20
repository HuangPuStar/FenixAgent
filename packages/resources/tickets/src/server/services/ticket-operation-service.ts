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
import type { TICKET_OPERATION_KINDS } from "../../schemas/ticket-operation.schema";
import { IdempotencyConflictError, TicketChangeInFlightError } from "../errors";
import { ticketsProjectLockKey, withTicketLock } from "../repositories/advisory-lock";
import type { TicketOperationRepository, TicketOperationRow } from "../repositories/ticket-operations";
import { IDEMPOTENCY_KEY_PATTERN } from "./ticket-limits";

/**
 * 操作类型（`ticket_operations.kind`）；取值域在协议 schema 里定义，本层只派生类型。
 *
 * 派生而不是另写一份联合：新增一种操作时协议枚举、响应校验与视图收敛必须同批更新，把定义放在协议侧
 * 让「忘了改」在编译期就暴露（`z.enum` 与 `requireKnown` 都吃同一份列表）。
 */
export type TicketOperationKind = (typeof TICKET_OPERATION_KINDS)[number];

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
  /** 远端工单内容已写入，本地索引与归属未刷（部分成功，T03）。 */
  issueUpdated: "issue_updated",
  /** 远端标签集合已写入，本地索引未刷（部分成功，T03）。 */
  labelsUpdated: "labels_updated",
  /** 远端评论已创建，本地归属未写（部分成功，T03）。 */
  commentCreated: "comment_created",
  /** 远端评论已改写，本地归属未刷（部分成功，T03）。 */
  commentUpdated: "comment_updated",
  /** 远端标签已写，本地无后续写（成功终态，T03）。 */
  upstreamApplied: "upstream_applied",
  /** 评论归属已写（成功终态，对应工单侧的 `index_written`，T03）。 */
  ownershipWritten: "ownership_written",
  /** 附件已上传（成功终态；附件没有本地行，走到这里即终局，T05）。 */
  attachmentUploaded: "attachment_uploaded",
  /** 恢复核对发现多个匹配或超窗口，等待运维（方案 §9.6，T03）。 */
  needsReview: "needs_review",
  /** 恢复核对确认远端未落库，可安全重提（T03）。 */
  notApplied: "not_applied",
} as const;

/**
 * 会改写同一工单对象、彼此必须互斥的操作（§9.7「未确认的同工单变更阻止后续修改」）。
 *
 * `issue.create` 刻意不在组内：创建没有「同一对象的既有变更」可言，把它拉进来会让同一工单上的两次
 * 独立创建互相阻塞（那是纯粹的功能倒退）。评论创建同理（两个成员同时评论不是冲突）。
 */
export const ISSUE_CHANGE_KINDS: readonly TicketOperationKind[] = ["issue.update", "issue.labels"];

/** 会改写同一条评论的操作：只与该评论的另一条在途修改互斥。 */
export const COMMENT_CHANGE_KINDS: readonly TicketOperationKind[] = ["comment.update"];

/**
 * 需要（且允许）触发一次恢复核对的状态：`dispatching` 是崩溃 / 在途残留，`uncertain` 是结果未定；
 * `needs_review` 等人处理，终态保持原样。
 *
 * 定义在这里而不是各调用点：`/web` 面的 `getOperation` 与管理面的同类入口必须对「哪些状态要回源核对」
 * 给出同一个答复，两处各写一份集合就会分叉成「一个面自动收尾、另一个面一直显示待确认」。
 */
export const RECONCILABLE_OPERATION_STATUSES: ReadonlySet<string> = new Set(["dispatching", "uncertain"]);

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
  /**
   * 目标对象坐标：工单域与评论创建传工单号、评论修改传评论 ID，**领取时**写入（T02 只在成功终态写）。
   * 在途互斥要靠它在领取前就认出「同一对象」，因此不能在成功后再补。
   */
  readonly targetId?: string | null;
  /**
   * 互斥范围（advisory lock 键）：缺省是组织级项目锁（T02 口径）；工单域写路径传
   * `ticketsIssueLockKey(projectId, issueNumber)`，让同一工单的「声明 + 在途检查 + 领取」串行。
   */
  readonly lockKey?: string;
  /** 在途互斥组：命中同组且同 `targetId` 的非终态操作时抛 `TicketChangeInFlightError`（§5.5）。 */
  readonly guardKinds?: readonly TicketOperationKind[];
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
  /**
   * 追加一步的核对记录（§6.1）。远端每完成一步就写下可机器核对的预期，恢复核对（§8）据此认领
   * 「远端已写、本地未写」的部分成功，并在失败重放时还原出同一个错误。
   */
  checkpoint(input: {
    readonly operationId: string;
    readonly step: string;
    readonly expected: Readonly<Record<string, unknown>>;
  }): Promise<void>;
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
  markUncertain(input: {
    readonly operationId: string;
    readonly step: string;
    /** 恢复核对判定「多义或超窗口」时传 `needs_review`（§8.3），缺省是 `uncertain`。 */
    readonly status?: "uncertain" | "needs_review";
  }): Promise<void>;
  /** 可见性：仅操作的 actor 本人（决策 D5），查不到一律 404。 */
  findForActor(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly operationId: string;
  }): Promise<TicketOperationRow | undefined>;
  /**
   * 平台管理面的账本读取（`/api/system/ticket-operations/:operationId`）：按 ID 直读，**不看发起人与组织**。
   *
   * 与 {@link findForActor} 的可见性口径刻意不同：那个方法回答「这个主体能不能看这条操作」，本方法服务的
   * 调用方不是用户——判据是系统路由守卫（凭据即判据），而它要复核的操作可能由组织成员在 `/web` 面发起
   * （详情视图的 `pendingOperationId` 就是这种情况）。两条方法并存而不是加一个开关参数：可见性分支留在
   * 参数里，评审时看不出「哪条路径没有范围收敛」。
   */
  findByIdUnscoped(input: { readonly operationId: string }): Promise<TicketOperationRow | undefined>;
  /**
   * 未确认变更的定位（裁定三.15）：同一对象上最新一条非终态修改操作的 ID，没有则 `undefined`。
   *
   * 与 `begin` 的在途互斥**同谓词**，详情视图的 `pendingOperationId` 只能从这里取：两处各写一份查询，
   * 界面提示与写路径的拒绝条件就会分叉。
   */
  findInFlightTarget(input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly kinds: readonly TicketOperationKind[];
  }): Promise<string | undefined>;
}

export function createTicketOperationService(operations: TicketOperationRepository): TicketOperationService {
  return {
    async begin(input) {
      // 幂等键的格式在这里复检（§8.3 步骤 1）：路由校验挡不住直接调用本服务的路径，而键会被写进
      // `varchar(128)` 列——超长键在数据库层报错会把一次 400 变成 500。
      if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
        throw new ValidationError("Idempotency-Key 不合法：需 8–128 位字母、数字、下划线或短横线");
      }
      return withTicketLock(input.lockKey ?? ticketsProjectLockKey(input.organizationId), async () => {
        const targetId = input.targetId ?? null;
        const guardKinds = input.guardKinds ?? [];
        // 声明「要互斥」却给不出坐标是调用方的编程错误：静默跳过会让这次写入失去互斥保护（§5.5 的唯一防线），
        // 因此在这里直接失败，而不是悄悄放行。
        if (guardKinds.length > 0 && (input.projectId === null || targetId === null)) {
          throw new Error("在途互斥需要 projectId 与 targetId：缺少目标对象坐标的写路径不得声明 guardKinds");
        }

        const { outcome, row } = await operations.claim({
          organizationId: input.organizationId,
          actorId: input.actorId,
          kind: input.kind,
          projectId: input.projectId,
          targetId,
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

        // 【T03】在途互斥（§5.1 第 4 步）：同一对象上还有未确认的变更时拒绝本次修改（§9.7）。必须与
        // claim/markDispatching 同一事务，否则两个不同幂等键的并发请求会各自读到「无在途变更」并各自领取。
        // 只在「裁决通过、准备领取」这条分支上执行：同键重试在上一段就拿到 replayed/in_flight，不会被自己挡住。
        if (guardKinds.length > 0 && input.projectId !== null && targetId !== null) {
          const blocked = await operations.hasInFlightTarget({
            projectId: input.projectId,
            targetId,
            kinds: guardKinds,
            excludeOperationId: row.id,
          });
          if (blocked) throw new TicketChangeInFlightError();
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

    async checkpoint(input) {
      await operations.checkpoint(input);
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

    async findByIdUnscoped(input) {
      return operations.findByIdUnscoped(input);
    },

    async findInFlightTarget(input) {
      return operations.findInFlightTargetId(input);
    },
  };
}
