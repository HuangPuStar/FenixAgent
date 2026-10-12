import { ticketOperations } from "@fenix/resource-tickets/db";
import { and, asc, desc, eq, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
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

/** 互斥判定不看终态：这些状态都表示「本端还有一份未确认的写入」（§5.5 的阻塞状态集合）。 */
const SETTLED_STATUSES = ["succeeded", "failed"] as const;

/** 需要恢复核对的状态：`dispatching` 是崩溃/在途残留，`uncertain` 是结果未定；`needs_review` 等人处理。 */
const UNSETTLED_STATUSES = ["dispatching", "uncertain"] as const;

export interface TicketOperationRepository {
  /** 幂等声明：唯一索引冲突时读回既有行；同一事务内完成（见 §8.2 步骤 1）。 */
  claim(input: {
    organizationId: string;
    actorId: string;
    /** 列是 `varchar(32)`：取值域由 `ticket-operation-service.ts` 的 `TicketOperationKind` 收口，仓储不复制枚举。 */
    kind: string;
    projectId: string | null;
    /** 目标对象坐标（工单号 / 评论 ID）；领取时即写入，供在途互斥按对象定位（T03）。 */
    targetId?: string | null;
    idempotencyKey: string;
    requestHash: string;
    messageId: string | null;
    expectedVersion: string | null;
    intent: Record<string, unknown>;
  }): Promise<{ readonly outcome: "created" | "existing"; readonly row: TicketOperationRow }>;
  /**
   * 「同一对象上是否还有未确认的同类变更」（§5.5 的在途互斥查询）。
   *
   * 与 `claim`/`markDispatching` 必须在同一事务内调用：分两次读会让两个不同幂等键的并发请求各自读到
   * 「无在途变更」并各自领取。`kinds` 由调用方给出互斥组（工单域 / 评论域），仓储不解释分组语义。
   */
  hasInFlightTarget(input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly kinds: readonly string[];
    /** 本次声明的操作行：它自己不算「在途变更」。 */
    readonly excludeOperationId: string;
  }): Promise<boolean>;
  /**
   * 未确认变更的定位查询：与 `hasInFlightTarget` 同谓词，返回最新一条命中的操作 ID（没有则 `undefined`）。
   *
   * 详情视图的 `pendingOperationId` 用它（裁定三.15）；`excludeOperationId` 缺省表示本次没有要排除的行。
   */
  findInFlightTargetId(input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly kinds: readonly string[];
    readonly excludeOperationId?: string;
  }): Promise<string | undefined>;
  /** 条件更新：只有 pending → dispatching 才返回 true（并发同键只有一个执行者）。 */
  markDispatching(input: { operationId: string; step: string }): Promise<boolean>;
  /**
   * 追加一步的核对记录（单语句 jsonb 追加，不做读改写）。
   *
   * 落库形状：`result.steps[]` 追加一项 `{ step, at, expected }`。这批步骤**只是审计轨迹**——给运维还原
   * 一次操作走过了哪几步（`step` 名 + 落库时刻 + 当时声明的预期），全仓没有代码读它。恢复核对的事实源是
   * `step` 列、`expected_version` 与 `intent`：远端落没落由回源指纹与 `expected_version` 比对判定
   * （§8.3），不是读这里的步骤历史。`at` 由数据库取时刻，多实例并发追加也不需要应用侧时钟一致。
   */
  checkpoint(input: {
    readonly operationId: string;
    readonly step: string;
    readonly expected: Record<string, unknown>;
  }): Promise<void>;
  /**
   * 读取仍未定的操作行（`dispatching` / `uncertain`），按 `updated_at` 升序（最早触动的先核对）。
   *
   * T04 的周期扫描入口：本批只落地查询原语，逐条核对由 `TicketRecoveryService.reconcile` 执行。`updatedBefore`
   * 让刚领取的操作留出自行完成的窗口——不设它会让周期扫描与正在执行的请求抢同一行。
   */
  findUnsettled(input: { readonly updatedBefore: Date; readonly limit: number }): Promise<TicketOperationRow[]>;
  markSucceeded(input: {
    operationId: string;
    step: string;
    targetId: string | null;
    result: Record<string, unknown>;
    intentSummary: Record<string, unknown>;
  }): Promise<void>;
  markFailed(input: { operationId: string; step: string; result: Record<string, unknown> }): Promise<void>;
  /**
   * 结果未定终态。
   *
   * `status` 只在恢复核对判定「多义或超窗口」时传 `needs_review`（§8.3）：该状态同样属于未定集合
   * （阻塞同对象的后续修改，裁定二.9），但**不**参与周期核对——反复核对一条已交付人工的行只会重复产出
   * 同一个结论，解除路径是运维动作（归 T04/T07）。
   */
  markUncertain(input: { operationId: string; step: string; status?: "uncertain" | "needs_review" }): Promise<void>;
  findForActor(input: {
    organizationId: string;
    actorId: string;
    operationId: string;
  }): Promise<TicketOperationRow | undefined>;
  findByMessageId(messageId: string): Promise<TicketOperationRow | undefined>; // T03 恢复用，T02 先落地
  /**
   * 按主键加锁读一行（`SELECT ... FOR UPDATE`），供恢复核对在事务内复查状态后落终态（§8.2）。
   *
   * 必须与终态写入处于**同一事务**：恢复核对在事务外读完远端后，两个并发核对会各自带着「该行仍是
   * uncertain」的判断进入写入，没有行锁时第二个的结论会覆盖第一个（例如把「已补齐成功」改回「仍需核对」）。
   */
  findByIdForUpdate(input: { operationId: string }): Promise<TicketOperationRow | undefined>;
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
          targetId: input.targetId ?? null,
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
     * 追加一步的核对记录（单语句 jsonb 追加）。
     *
     * 用 `coalesce + ||` 在库内拼接，而不是「读出来 push 再写回」：并发/重试下读改写会丢掉另一条步骤，
     * 而审计轨迹要的正是全量追加。`expected` 以 JSON 字符串参数绑定再显式 `::jsonb`，不让驱动对对象参数
     * 自行猜测序列化方式，避免键序或类型在途中漂移。
     *
     * `step` 参数必须带显式 `::text`：`jsonb_build_object` 是可变参数函数，参数类型只由实参自身决定，
     * 裸绑定参数会让 Postgres 无法推断（42P18）并整条语句失败——这条 UPDATE 挂在「远端已成功、本地收尾
     * 之前」，失败即把成功写收敛成 `uncertain`。参数化 `::text` 而非拼接字面量，SQL 注入面不变。
     */
    async checkpoint(input) {
      await getTicketsDatabase()
        .update(ticketOperations)
        .set({
          result: sql`coalesce(${ticketOperations.result}, '{}'::jsonb) || jsonb_build_object('steps', coalesce(${ticketOperations.result} -> 'steps', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('step', ${input.step}::text, 'at', now(), 'expected', ${JSON.stringify(input.expected)}::jsonb)))`,
          updatedAt: new Date(),
        })
        .where(eq(ticketOperations.id, input.operationId));
    },

    async findUnsettled(input) {
      return getTicketsDatabase()
        .select()
        .from(ticketOperations)
        .where(
          and(
            inArray(ticketOperations.status, [...UNSETTLED_STATUSES]),
            // 上界是排他的准备形态：让「刚领取、可能马上自己完成」的行留在下一轮，不与正常执行抢同一行。
            lte(ticketOperations.updatedAt, input.updatedBefore),
          ),
        )
        .orderBy(asc(ticketOperations.updatedAt))
        .limit(input.limit);
    },

    /**
     * 在途互斥查询（§5.5）：命中即「同一对象还有未确认的变更」，调用方据此拒绝本次修改（409）。
     *
     * 谓词与合同逐字一致（`project_id + target_id + kind ∈ 组 + status ∉ 终态 + id ≠ 本次`）；终态行
     * （`succeeded`/`failed`）不进判定，`needs_review` 进——对象状态有歧义时继续写入正是方案禁止的行为。
     * 查询走 `ticket_operations_inflight_idx` 部分索引（`db/schema.ts`）。
     */
    async hasInFlightTarget(input) {
      const hit = await this.findInFlightTargetId(input);
      return hit !== undefined;
    },

    /**
     * 未确认变更的定位查询（裁定三.15）：与 {@link hasInFlightTarget} **同谓词**，只多一件事——把命中的
     * 操作 ID 取回来，供详情视图的 `pendingOperationId` 使用。
     *
     * 两者共用一次实现是刻意的：如果各写一份，详情页展示的「待确认」与写路径的拒绝条件迟早会分叉，
     * 于是出现「界面不提示、写下去却被拒」这种最难排查的形态。`excludeOperationId` 只在写路径传（本次
     * 声明行不算在途），详情路径不传。
     *
     * 多条命中时取最新创建的一条：界面上只需要一个「去核对」的入口，多条是极端时序下的残留，逐条展示
     * 反而会让用户以为要核对多次。
     */
    async findInFlightTargetId(input) {
      const conditions = [
        eq(ticketOperations.projectId, input.projectId),
        eq(ticketOperations.targetId, input.targetId),
        inArray(ticketOperations.kind, [...input.kinds]),
        notInArray(ticketOperations.status, [...SETTLED_STATUSES]),
      ];
      if (input.excludeOperationId !== undefined) {
        conditions.push(ne(ticketOperations.id, input.excludeOperationId));
      }
      const rows = await getTicketsDatabase()
        .select({ id: ticketOperations.id })
        .from(ticketOperations)
        .where(and(...conditions))
        .orderBy(desc(ticketOperations.createdAt))
        .limit(1);
      return rows[0]?.id;
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
        .set({ status: input.status ?? "uncertain", step: input.step, updatedAt: new Date() })
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

    async findByIdForUpdate(input) {
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketOperations)
        .where(eq(ticketOperations.id, input.operationId))
        .limit(1)
        .for("update");
      return rows[0];
    },
  };
}
