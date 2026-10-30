import type { ImChannelEventDeliveryVia, ImChannelEventStatus, ImChatType } from "@fenix/resource-channel/db";
import { imChannelEvent } from "@fenix/resource-channel/db";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/**
 * 入站事件记录的持久化访问层。
 *
 * `insertIfAbsent` 是去重的唯一入口：唯一键冲突必须由数据库原子拦截（多实例与重启后重投都靠它），
 * 不能先查后插。正文用 `takeText` 读一次即清，避免暴露窗口超过一次 `resources/read`。
 *
 * 状态迁移与保留策略都只提供单条 SQL 原语，何时触发（20 秒 ACK、24 小时清正文、7/30 天删行）
 * 属于服务层与清理任务。
 */

export type ImChannelEventRow = typeof imChannelEvent.$inferSelect;

/** `im://inbox` 的稳定分页游标：同一毫秒内的多条事件用主键决出先后，避免翻页丢行或重复。 */
export interface ImChannelEventCursor {
  readonly receivedAt: Date;
  readonly id: string;
}

export interface ImChannelEventInsertInput {
  channelId: string;
  /** LangBot 事件体的 `uuid`，与 channelId 组成去重键。 */
  eventUuid: string;
  eventType: string;
  chatType: ImChatType;
  chatId: string;
  /** 原文快照；读取后由 `takeText` 置空。 */
  text?: string | null;
  senderId?: string | null;
  agentConfigId?: string | null;
  status: ImChannelEventStatus;
  deliveryVia?: ImChannelEventDeliveryVia | null;
}

export interface ImChannelEventRepository {
  findById(input: { eventId: string }): Promise<ImChannelEventRow | undefined>;
  /** 去重写入：返回新行；`(channel_id, event_uuid)` 已存在时返回 undefined。 */
  insertIfAbsent(input: ImChannelEventInsertInput): Promise<ImChannelEventRow | undefined>;
  /** 订阅流注册后补发：按入站顺序取仍是 `received` 的事件。 */
  findUndeliveredByChat(input: {
    channelId: string;
    chatType: ImChatType;
    chatId: string;
    limit?: number;
  }): Promise<ImChannelEventRow[]>;
  /**
   * 取该聊天近期事件，最新在前。
   *
   * `im_reply` 的 `mention_user_id` 必须来自这里：只允许 @ 近期出现过的人，避免 Agent 用任意 ID 打扰
   * 会话外成员；省略时也由这里回退到最近一条事件的发送者。
   */
  findRecentByChat(input: {
    channelId: string;
    chatType: ImChatType;
    chatId: string;
    since: Date;
    limit: number;
  }): Promise<ImChannelEventRow[]>;
  /**
   * `im://inbox` 的待读分页：只取 `received` / `delivered`，按 `received_at` 升序。
   *
   * 游标必须带主键：同一毫秒内的多条事件只按时间排序会漏行或重复。调用方多取一条判断是否还有下一页，
   * 仓储不自己决定 `nextCursor`。
   */
  findPendingPage(input: {
    channelId: string;
    chatType: ImChatType;
    chatId: string;
    after?: ImChannelEventCursor;
    limit: number;
  }): Promise<ImChannelEventRow[]>;
  /** 待处理事件数：`im_context` 的 `pendingCount`，与分页使用同一状态集合。 */
  countPendingByChat(input: { channelId: string; chatType: ImChatType; chatId: string }): Promise<number>;
  /** 原子读出正文并置空，返回取走的正文；已被读过或没有正文时返回 undefined。 */
  takeText(input: { eventId: string; readAt: Date }): Promise<string | undefined>;
  markDelivered(input: { eventId: string; deliveryVia: ImChannelEventDeliveryVia; at: Date }): Promise<void>;
  markFailed(input: { eventId: string; lastError: string; at: Date }): Promise<void>;
  markSkipped(input: { eventId: string; at: Date }): Promise<void>;
  /** 一次投递尝试失败但保留 `received` 等重试：尝试次数 +1 并记录摘要。 */
  recordAttempt(input: { eventId: string; lastError: string | null }): Promise<void>;
  markAckSent(input: { eventId: string; at: Date }): Promise<void>;
  /** 启动清理：把上一个进程遗留的 `received` / `delivered` 标记为失败，不重放。 */
  markUnfinishedAsFailed(input: { reason: string; at: Date }): Promise<number>;
  /** 24 小时未读正文的过期清除：只清正文，保留事件行。 */
  clearTextsBefore(input: { before: Date }): Promise<number>;
  /** 按状态整行删除到期元数据；返回删除行数。 */
  deleteTerminalBefore(input: { statuses: readonly ImChannelEventStatus[]; before: Date }): Promise<number>;
}

export function createImChannelEventRepository(): ImChannelEventRepository {
  return {
    async findById(input) {
      const db = getChannelDatabase();
      const rows = await db.select().from(imChannelEvent).where(eq(imChannelEvent.id, input.eventId)).limit(1);
      return rows[0];
    },

    async insertIfAbsent(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .insert(imChannelEvent)
        .values({
          channelId: input.channelId,
          eventUuid: input.eventUuid,
          eventType: input.eventType,
          chatType: input.chatType,
          chatId: input.chatId,
          text: input.text ?? null,
          senderId: input.senderId ?? null,
          agentConfigId: input.agentConfigId ?? null,
          status: input.status,
          deliveryVia: input.deliveryVia ?? null,
        })
        .onConflictDoNothing({
          target: [imChannelEvent.channelId, imChannelEvent.eventUuid],
        })
        .returning();
      return row;
    },

    async findUndeliveredByChat(input) {
      const db = getChannelDatabase();
      const query = db
        .select()
        .from(imChannelEvent)
        .where(
          and(
            eq(imChannelEvent.channelId, input.channelId),
            eq(imChannelEvent.chatType, input.chatType),
            eq(imChannelEvent.chatId, input.chatId),
            eq(imChannelEvent.status, "received"),
          ),
        )
        .orderBy(asc(imChannelEvent.receivedAt));
      return input.limit === undefined ? query : query.limit(input.limit);
    },

    async findRecentByChat(input) {
      const db = getChannelDatabase();
      return db
        .select()
        .from(imChannelEvent)
        .where(
          and(
            eq(imChannelEvent.channelId, input.channelId),
            eq(imChannelEvent.chatType, input.chatType),
            eq(imChannelEvent.chatId, input.chatId),
            gte(imChannelEvent.receivedAt, input.since),
          ),
        )
        .orderBy(desc(imChannelEvent.receivedAt))
        .limit(input.limit);
    },

    async findPendingPage(input) {
      const db = getChannelDatabase();
      const after = input.after;
      return db
        .select()
        .from(imChannelEvent)
        .where(
          and(
            eq(imChannelEvent.channelId, input.channelId),
            eq(imChannelEvent.chatType, input.chatType),
            eq(imChannelEvent.chatId, input.chatId),
            inArray(imChannelEvent.status, ["received", "delivered"]),
            after
              ? or(
                  gt(imChannelEvent.receivedAt, after.receivedAt),
                  and(eq(imChannelEvent.receivedAt, after.receivedAt), gt(imChannelEvent.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(imChannelEvent.receivedAt), asc(imChannelEvent.id))
        .limit(input.limit);
    },

    async countPendingByChat(input) {
      const db = getChannelDatabase();
      const rows = await db
        .select({ value: count() })
        .from(imChannelEvent)
        .where(
          and(
            eq(imChannelEvent.channelId, input.channelId),
            eq(imChannelEvent.chatType, input.chatType),
            eq(imChannelEvent.chatId, input.chatId),
            inArray(imChannelEvent.status, ["received", "delivered"]),
          ),
        );
      return Number(rows[0]?.value ?? 0);
    },

    async takeText(input) {
      const db = getChannelDatabase();
      // UPDATE ... RETURNING 只能拿到新值（已被置空的 text），因此先用 CTE 锁定并取出旧正文，
      // 再在同一条语句里清空。拆成 select + update 两条语句会让并发读各拿到一份正文。
      const taken = db.$with("taken_text").as(
        db
          .select({ id: imChannelEvent.id, text: imChannelEvent.text })
          .from(imChannelEvent)
          .where(and(eq(imChannelEvent.id, input.eventId), isNotNull(imChannelEvent.text)))
          .for("update"),
      );
      const rows = await db
        .with(taken)
        .update(imChannelEvent)
        .set({ text: null, readAt: input.readAt })
        .from(taken)
        .where(eq(imChannelEvent.id, taken.id))
        .returning({ text: taken.text });
      return rows[0]?.text ?? undefined;
    },

    async markDelivered(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelEvent)
        .set({ status: "delivered", deliveryVia: input.deliveryVia, processedAt: input.at })
        .where(eq(imChannelEvent.id, input.eventId));
    },

    async markFailed(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelEvent)
        .set({ status: "failed", lastError: input.lastError, processedAt: input.at })
        .where(eq(imChannelEvent.id, input.eventId));
    },

    async markSkipped(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelEvent)
        .set({ status: "skipped", processedAt: input.at })
        .where(eq(imChannelEvent.id, input.eventId));
    },

    async recordAttempt(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelEvent)
        .set({ attempts: sql`${imChannelEvent.attempts} + 1`, lastError: input.lastError })
        .where(eq(imChannelEvent.id, input.eventId));
    },

    async markAckSent(input) {
      const db = getChannelDatabase();
      await db.update(imChannelEvent).set({ ackSentAt: input.at }).where(eq(imChannelEvent.id, input.eventId));
    },

    async markUnfinishedAsFailed(input) {
      const db = getChannelDatabase();
      const rows = await db
        .update(imChannelEvent)
        .set({ status: "failed", lastError: input.reason, processedAt: input.at })
        .where(inArray(imChannelEvent.status, ["received", "delivered"]))
        .returning({ id: imChannelEvent.id });
      return rows.length;
    },

    async clearTextsBefore(input) {
      const db = getChannelDatabase();
      const rows = await db
        .update(imChannelEvent)
        .set({ text: null })
        .where(and(isNotNull(imChannelEvent.text), lt(imChannelEvent.receivedAt, input.before)))
        .returning({ id: imChannelEvent.id });
      return rows.length;
    },

    async deleteTerminalBefore(input) {
      // 空集合会产生恒假条件，语义上没有要删的东西，直接跳过这次往返。
      if (input.statuses.length === 0) return 0;
      const db = getChannelDatabase();
      const rows = await db
        .delete(imChannelEvent)
        .where(and(inArray(imChannelEvent.status, input.statuses), lt(imChannelEvent.receivedAt, input.before)))
        .returning({ id: imChannelEvent.id });
      return rows.length;
    },
  };
}
