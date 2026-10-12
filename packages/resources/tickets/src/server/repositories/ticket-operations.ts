import { ticketOperations } from "@fenix/resource-tickets/db";
import { and, eq, sql } from "drizzle-orm";
import { getTicketsDatabase } from "../db";

/**
 * 工单操作账本的持久化访问层。
 *
 * 这张表是幂等的唯一真相（§8.2 状态机）：`claim` 用唯一索引 `(organization_id, actor_id, idempotency_key)`
 * 声明操作，`markDispatching` 用条件更新把「谁在真正执行」收敛成一次，终态由 mark* 写入。仓储只做这些
 * 原语，**不**解释裁决顺序（同键不同哈希 → 409、`dispatching` → 202 等判定在服务层），也不接触
 * `message_id` 之外的外部世界。
 *
 * `claim` 的 `FOR UPDATE` 只在事务里才有意义：调用方必须先经 `runInTransaction` + `withTicketLock` 进入
 * 事务（§8.2 步骤 1），否则读回的既有行拿不到锁，两个并发同键请求会各自读到 pending 并各自尝试领取。
 *
 * 行类型在本层声明并出口，服务层据此读写账本而不 import 表对象。
 */

export type TicketOperationRow = typeof ticketOperations.$inferSelect;

export interface TicketOperationRepository {
  /** 幂等声明：唯一索引冲突时读回既有行；同一事务内完成（见 §8.2 步骤 1）。 */
  claim(input: {
    organizationId: string;
    actorId: string;
    kind: "issue.create" | "project.provision";
    projectId: string | null;
    idempotencyKey: string;
    requestHash: string;
    messageId: string | null;
    expectedVersion: string | null;
    intent: Record<string, unknown>;
  }): Promise<{ readonly outcome: "created" | "existing"; readonly row: TicketOperationRow }>;
  /** 条件更新：只有 pending → dispatching 才返回 true（并发同键只有一个执行者）。 */
  markDispatching(input: { operationId: string; step: string }): Promise<boolean>;
  markSucceeded(input: {
    operationId: string;
    step: string;
    targetId: string | null;
    result: Record<string, unknown>;
    intentSummary: Record<string, unknown>;
  }): Promise<void>;
  markFailed(input: { operationId: string; step: string; result: Record<string, unknown> }): Promise<void>;
  markUncertain(input: { operationId: string; step: string }): Promise<void>;
  findForActor(input: {
    organizationId: string;
    actorId: string;
    operationId: string;
  }): Promise<TicketOperationRow | undefined>;
  findByMessageId(messageId: string): Promise<TicketOperationRow | undefined>; // T03 恢复用，T02 先落地
}

export function createTicketOperationRepository(): TicketOperationRepository {
  return {
    async claim(input) {
      const db = getTicketsDatabase();
      const [created] = await db
        .insert(ticketOperations)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.actorId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          messageId: input.messageId,
          expectedVersion: input.expectedVersion,
          intent: input.intent,
        })
        // DO NOTHING 而不是 DO UPDATE：已有操作是**既有事实**，不能被新请求的 intent/哈希覆盖，
        // 裁决（同哈希重放、异哈希 409）在服务层按读回的行做。
        .onConflictDoNothing({
          target: [ticketOperations.organizationId, ticketOperations.actorId, ticketOperations.idempotencyKey],
        })
        .returning();
      if (created !== undefined) return { outcome: "created", row: created };

      // 冲突分支：锁住既有行再读，让同一幂等键的并发请求在事务内排队裁决。
      const [existing] = await db
        .select()
        .from(ticketOperations)
        .where(
          and(
            eq(ticketOperations.organizationId, input.organizationId),
            eq(ticketOperations.actorId, input.actorId),
            eq(ticketOperations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
        .for("update");
      if (existing === undefined) {
        // 唯一索引刚拒绝插入却读不到行，只可能是并发删除：账本没有删除路径，此处按不变量违反处理。
        throw new Error("ticket_operations 冲突后未读回既有行");
      }
      return { outcome: "existing", row: existing };
    },

    async markDispatching(input) {
      const rows = await getTicketsDatabase()
        .update(ticketOperations)
        .set({ status: "dispatching", step: input.step, updatedAt: new Date() })
        // status='pending' 是并发的唯一裁决点：另一执行者已领取时这里更新零行，调用方据此返回 202，
        // 绝不重复执行外部写。
        .where(and(eq(ticketOperations.id, input.operationId), eq(ticketOperations.status, "pending")))
        .returning({ id: ticketOperations.id });
      return rows.length > 0;
    },

    /**
     * 成功终态。
     *
     * `intent` 被改写成调用方给出的摘要而不是保留原文：待发送正文（工单标题与正文）在成功那一刻即从
     * 库里消失，T03 的恢复核对只需要 `message_id` + 远端回源，不需要本地明文。
     */
    async markSucceeded(input) {
      await getTicketsDatabase()
        .update(ticketOperations)
        .set({
          status: "succeeded",
          step: input.step,
          targetId: input.targetId,
          result: input.result,
          intent: input.intentSummary,
          updatedAt: new Date(),
        })
        .where(eq(ticketOperations.id, input.operationId));
    },

    /**
     * 明确失败终态（4xx/5xx 已定论，绝不由本模块重试）。
     *
     * §8.2 要求「成功与明确失败时立即改写 intent 为摘要」，而 §4.2 的 markFailed 签名不带 `intentSummary`
     * （正文哈希只有服务层能算）；因此这里在 UPDATE 内按库内 intent 自行派生摘要——只留标题长度，正文
     * 原文随同一条语句消失。失败路径是终态，摘要的字段严格少于成功路径不影响任何消费方。
     */
    async markFailed(input) {
      await getTicketsDatabase()
        .update(ticketOperations)
        .set({
          status: "failed",
          step: input.step,
          result: input.result,
          intent: sql`jsonb_build_object('titleLength', coalesce(length(${ticketOperations.intent} ->> 'title'), 0))`,
          updatedAt: new Date(),
        })
        .where(eq(ticketOperations.id, input.operationId));
    },

    /**
     * 结果未定终态：保留 intent 原文供 T03 用 `message_id` 回源核对（核对需要原始请求内容），
     * 7 天内由 T03 的清理任务收口。
     */
    async markUncertain(input) {
      await getTicketsDatabase()
        .update(ticketOperations)
        .set({ status: "uncertain", step: input.step, updatedAt: new Date() })
        .where(eq(ticketOperations.id, input.operationId));
    },

    async findForActor(input) {
      // 三个条件缺一不可（裁决 D5：仅操作的 actor 本人可查）：少一个就会让别的成员或别的组织读到账本。
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketOperations)
        .where(
          and(
            eq(ticketOperations.organizationId, input.organizationId),
            eq(ticketOperations.actorId, input.actorId),
            eq(ticketOperations.id, input.operationId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async findByMessageId(messageId) {
      // 恢复流程手上只有身份头里的 message_id，因此这里不带组织条件；该列没有唯一索引，但取值是
      // `msg_<uuid>`（创建期生成），实际唯一，`limit 1` 不会在重复值上产生歧义。
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketOperations)
        .where(eq(ticketOperations.messageId, messageId))
        .limit(1);
      return rows[0];
    },
  };
}
