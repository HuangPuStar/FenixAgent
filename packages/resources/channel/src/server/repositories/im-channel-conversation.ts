import type { ImChatType } from "@fenix/resource-channel/db";
import { imChannelConversation } from "@fenix/resource-channel/db";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/**
 * IM 聊天长会话映射的持久化访问层。
 *
 * `findByChat` 支持 `forUpdate`：多实例下「按唯一键查不到就插入」必须由行锁或唯一键冲突收口，
 * 行锁是仓储提供的事务原语，选择哪种由服务层决定。`insertIfAbsent` 同理，冲突时返回 undefined，
 * 由调用方回读那一行，而不是在仓储里静默改成 upsert。
 */

export type ImChannelConversationRow = typeof imChannelConversation.$inferSelect;

export interface ImChannelConversationInsertInput {
  /**
   * 调用方预生成的会话 id。
   *
   * 首次创建时必须显式给出：`rcsSessionId` 由 `(agentConfigId, ownerUserId, conversationId)` 确定性推导，
   * 而列是 NOT NULL，先插入再回读会让第一次写入带上无法复算的键。
   */
  id?: string;
  channelId: string;
  chatType: ImChatType;
  chatId: string;
  agentConfigId: string;
  /** 必须由确定性函数生成（agentConfigId + 所有者 + conversationId），不得用随机值或时间戳。 */
  rcsSessionId: string;
  acpSessionId?: string | null;
}

export interface ImChannelConversationRepository {
  findById(input: { conversationId: string }): Promise<ImChannelConversationRow | undefined>;
  findByChat(input: {
    channelId: string;
    chatType: ImChatType;
    chatId: string;
    /** 在事务内以 `SELECT ... FOR UPDATE` 读取，用于并发创建与换 Agent 的读改写。 */
    forUpdate?: boolean;
  }): Promise<ImChannelConversationRow | undefined>;
  /** 只读分页：控制面会话列表按组织下的通道集合取回最近创建的行。 */
  findManyByChannels(input: {
    channelIds: readonly string[];
    limit: number;
    offset: number;
  }): Promise<ImChannelConversationRow[]>;
  /** 控制面派生的全量读取：按通道取全部会话映射，不分页（数量受真实聊天数约束）。 */
  findAllByChannels(input: { channelIds: readonly string[] }): Promise<ImChannelConversationRow[]>;
  countByChannels(input: { channelIds: readonly string[] }): Promise<number>;
  insert(input: ImChannelConversationInsertInput): Promise<ImChannelConversationRow>;
  insertIfAbsent(input: ImChannelConversationInsertInput): Promise<ImChannelConversationRow | undefined>;
  /**
   * 路由改绑 Agent 后重置会话映射。
   *
   * `rcs_session_id` 是 NOT NULL 的确定性键，换 Agent 时直接替换成新键而不是置空；ACP session 属于
   * 创建它的 Agent，不能跨 Agent 恢复，因此一并清空；`last_reply_at` 同理属于旧会话。
   */
  resetForAgent(input: {
    conversationId: string;
    agentConfigId: string;
    rcsSessionId: string;
  }): Promise<ImChannelConversationRow | undefined>;
  updateAcpSession(input: {
    conversationId: string;
    acpSessionId: string;
  }): Promise<ImChannelConversationRow | undefined>;
  touchLastEventAt(input: { conversationId: string; at: Date }): Promise<void>;
  touchLastReplyAt(input: { conversationId: string; at: Date }): Promise<void>;
  /** 删除通道下的全部会话映射；删除 Bot 前清理平台侧关联（规格 §4.2），返回删除行数。 */
  deleteByChannel(input: { channelId: string }): Promise<number>;
}

export function createImChannelConversationRepository(): ImChannelConversationRepository {
  return {
    async findById(input) {
      const db = getChannelDatabase();
      const rows = await db
        .select()
        .from(imChannelConversation)
        .where(eq(imChannelConversation.id, input.conversationId))
        .limit(1);
      return rows[0];
    },

    async findByChat(input) {
      const db = getChannelDatabase();
      const query = db
        .select()
        .from(imChannelConversation)
        .where(
          and(
            eq(imChannelConversation.channelId, input.channelId),
            eq(imChannelConversation.chatType, input.chatType),
            eq(imChannelConversation.chatId, input.chatId),
          ),
        )
        .limit(1);
      const rows = input.forUpdate === true ? await query.for("update") : await query;
      return rows[0];
    },

    async findManyByChannels(input) {
      if (input.channelIds.length === 0) return [];
      const db = getChannelDatabase();
      return db
        .select()
        .from(imChannelConversation)
        .where(inArray(imChannelConversation.channelId, [...input.channelIds]))
        .orderBy(desc(imChannelConversation.createdAt), desc(imChannelConversation.id))
        .limit(input.limit)
        .offset(input.offset);
    },

    async findAllByChannels(input) {
      if (input.channelIds.length === 0) return [];
      const db = getChannelDatabase();
      return db
        .select()
        .from(imChannelConversation)
        .where(inArray(imChannelConversation.channelId, [...input.channelIds]))
        .orderBy(desc(imChannelConversation.createdAt), desc(imChannelConversation.id));
    },

    async countByChannels(input) {
      if (input.channelIds.length === 0) return 0;
      const db = getChannelDatabase();
      const [row] = await db
        .select({ value: count() })
        .from(imChannelConversation)
        .where(inArray(imChannelConversation.channelId, [...input.channelIds]));
      return Number(row?.value ?? 0);
    },

    async insert(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .insert(imChannelConversation)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          channelId: input.channelId,
          chatType: input.chatType,
          chatId: input.chatId,
          agentConfigId: input.agentConfigId,
          rcsSessionId: input.rcsSessionId,
          acpSessionId: input.acpSessionId ?? null,
        })
        .returning();
      if (row === undefined) throw new Error("im_channel_conversation 写入未返回行");
      return row;
    },

    async insertIfAbsent(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .insert(imChannelConversation)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          channelId: input.channelId,
          chatType: input.chatType,
          chatId: input.chatId,
          agentConfigId: input.agentConfigId,
          rcsSessionId: input.rcsSessionId,
          acpSessionId: input.acpSessionId ?? null,
        })
        .onConflictDoNothing({
          target: [imChannelConversation.channelId, imChannelConversation.chatType, imChannelConversation.chatId],
        })
        .returning();
      return row;
    },

    async resetForAgent(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .update(imChannelConversation)
        .set({
          agentConfigId: input.agentConfigId,
          rcsSessionId: input.rcsSessionId,
          acpSessionId: null,
          lastReplyAt: null,
          updatedAt: new Date(),
        })
        .where(eq(imChannelConversation.id, input.conversationId))
        .returning();
      return row;
    },

    async updateAcpSession(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .update(imChannelConversation)
        .set({ acpSessionId: input.acpSessionId, updatedAt: new Date() })
        .where(eq(imChannelConversation.id, input.conversationId))
        .returning();
      return row;
    },

    async touchLastEventAt(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelConversation)
        .set({ lastEventAt: input.at, updatedAt: input.at })
        .where(eq(imChannelConversation.id, input.conversationId));
    },

    async touchLastReplyAt(input) {
      const db = getChannelDatabase();
      await db
        .update(imChannelConversation)
        .set({ lastReplyAt: input.at, updatedAt: input.at })
        .where(eq(imChannelConversation.id, input.conversationId));
    },

    async deleteByChannel(input) {
      const db = getChannelDatabase();
      const rows = await db
        .delete(imChannelConversation)
        .where(eq(imChannelConversation.channelId, input.channelId))
        .returning({ id: imChannelConversation.id });
      return rows.length;
    },
  };
}
