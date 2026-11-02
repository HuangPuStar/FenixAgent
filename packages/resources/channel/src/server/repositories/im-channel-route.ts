import type { ImChatType } from "@fenix/resource-channel/db";
import { imChannelRoute } from "@fenix/resource-channel/db";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/**
 * IM 通道路由规则的持久化访问层。
 *
 * 精确路由与通配路由拆成两个查询，不在这里拼「精确优先」的排序：优先级是匹配语义，属于服务层；
 * 仓储只负责按两列 / 三列 WHERE 取行。两条部分唯一索引保证同一优先级最多一行，因此这里不处理并列。
 */

export type ImChannelRouteRow = typeof imChannelRoute.$inferSelect;

export interface ImChannelRouteInsertInput {
  channelId: string;
  chatType: ImChatType;
  /** null 表示该 chatType 的通配路由。 */
  chatId?: string | null;
  agentConfigId: string;
  enabled?: boolean;
}

/** 可更新列的白名单：`channelId` 是路由归属，不允许通过部分更新改挂到别的通道。 */
export interface ImChannelRouteUpdatePatch {
  chatType?: ImChatType;
  chatId?: string | null;
  agentConfigId?: string;
  enabled?: boolean;
}

export interface ImChannelRouteRepository {
  findById(input: { routeId: string }): Promise<ImChannelRouteRow | undefined>;
  findExact(input: { channelId: string; chatType: ImChatType; chatId: string }): Promise<ImChannelRouteRow | undefined>;
  findWildcard(input: { channelId: string; chatType: ImChatType }): Promise<ImChannelRouteRow | undefined>;
  findManyByChannel(input: { channelId: string }): Promise<ImChannelRouteRow[]>;
  /** 列表页的 `boundRouteCount` 投影：一次聚合取回多个通道的路由数，避免按通道逐个 COUNT。 */
  countByChannels(input: { channelIds: readonly string[] }): Promise<ReadonlyMap<string, number>>;
  insert(input: ImChannelRouteInsertInput): Promise<ImChannelRouteRow>;
  updateById(input: { routeId: string; patch: ImChannelRouteUpdatePatch }): Promise<ImChannelRouteRow | undefined>;
  deleteById(input: { routeId: string }): Promise<boolean>;
  /** 删除通道下的全部路由；删除 Bot 前清理平台侧关联（规格 §4.2），返回删除行数。 */
  deleteByChannel(input: { channelId: string }): Promise<number>;
}

export function createImChannelRouteRepository(): ImChannelRouteRepository {
  return {
    async findById(input) {
      const db = getChannelDatabase();
      const rows = await db.select().from(imChannelRoute).where(eq(imChannelRoute.id, input.routeId)).limit(1);
      return rows[0];
    },

    async findExact(input) {
      const db = getChannelDatabase();
      const rows = await db
        .select()
        .from(imChannelRoute)
        .where(
          and(
            eq(imChannelRoute.channelId, input.channelId),
            eq(imChannelRoute.chatType, input.chatType),
            eq(imChannelRoute.chatId, input.chatId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async findWildcard(input) {
      const db = getChannelDatabase();
      const rows = await db
        .select()
        .from(imChannelRoute)
        .where(
          and(
            eq(imChannelRoute.channelId, input.channelId),
            eq(imChannelRoute.chatType, input.chatType),
            isNull(imChannelRoute.chatId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async findManyByChannel(input) {
      const db = getChannelDatabase();
      return db
        .select()
        .from(imChannelRoute)
        .where(eq(imChannelRoute.channelId, input.channelId))
        .orderBy(asc(imChannelRoute.createdAt));
    },

    async countByChannels(input) {
      const result = new Map<string, number>();
      if (input.channelIds.length === 0) return result;
      const db = getChannelDatabase();
      const rows = await db
        .select({ channelId: imChannelRoute.channelId, value: count() })
        .from(imChannelRoute)
        .where(inArray(imChannelRoute.channelId, [...input.channelIds]))
        .groupBy(imChannelRoute.channelId);
      for (const row of rows) result.set(row.channelId, Number(row.value));
      return result;
    },

    async insert(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .insert(imChannelRoute)
        .values({
          channelId: input.channelId,
          chatType: input.chatType,
          chatId: input.chatId ?? null,
          agentConfigId: input.agentConfigId,
          enabled: input.enabled ?? true,
        })
        .returning();
      if (row === undefined) throw new Error("im_channel_route 写入未返回行");
      return row;
    },

    async updateById(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .update(imChannelRoute)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(eq(imChannelRoute.id, input.routeId))
        .returning();
      return row;
    },

    async deleteById(input) {
      const db = getChannelDatabase();
      const rows = await db
        .delete(imChannelRoute)
        .where(eq(imChannelRoute.id, input.routeId))
        .returning({ id: imChannelRoute.id });
      return rows.length > 0;
    },

    async deleteByChannel(input) {
      const db = getChannelDatabase();
      const rows = await db
        .delete(imChannelRoute)
        .where(eq(imChannelRoute.channelId, input.channelId))
        .returning({ id: imChannelRoute.id });
      return rows.length;
    },
  };
}
