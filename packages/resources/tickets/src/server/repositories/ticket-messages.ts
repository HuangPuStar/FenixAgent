import { ticketMessages } from "@fenix/resource-tickets/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTicketsDatabase } from "../db";

/**
 * 工单消息归属的持久化访问层。
 *
 * `ticket_messages` 是「远端对象 ↔ AOS 作者」的唯一关联，也是身份头可信性的判定依据（不是展示缓存）：
 * 详情路径拿它核验作者，因此本层只做写入与按对象/按消息读取两件事，不参与可信性判定（判定在服务层
 * 比对 message_id 与正文摘要）。
 *
 * `insert` 不做 `ON CONFLICT`：三个唯一索引（对象、message_id、项目内对象）任一冲突都说明「同一次创建
 * 被写了两次」或「远端对象被另一条归属占用」，静默改写会伪造作者归属——这类冲突必须抛出，由调用方
 * 按终态失败处理（§8.3 步骤 7 失败也不得二次创建）。
 */

export type TicketMessageRow = typeof ticketMessages.$inferSelect;

export interface TicketMessageRepository {
  insert(input: {
    projectId: string;
    objectKind: "issue" | "comment";
    providerObjectId: string;
    messageId: string;
    authorId: string;
    authorNameSnapshot: string;
    bodyHash: string;
    revision?: number;
    lastEditorId?: string | null;
  }): Promise<TicketMessageRow>;
  findObjectMessage(input: {
    projectId: string;
    objectKind: "issue" | "comment";
    providerObjectId: string;
  }): Promise<TicketMessageRow | undefined>;
  findByMessageId(input: { messageId: string }): Promise<TicketMessageRow | undefined>;
  findManyByMessageIds(input: { projectId: string; messageIds: readonly string[] }): Promise<TicketMessageRow[]>;
  /**
   * 正文改写后的归属刷新：换新 `body_hash`、`revision + 1` 并记录改写者。
   *
   * 只由「描述被改写」与「评论被编辑」两条路径调用：`revision` 表达的是**正文被改写了几次**，把标题、
   * 状态、标签或指派也算进来，`body_hash` 与 `revision` 的对应关系就失效（恢复核对与作者核验都读它
   * 们判「这条内容是否仍是我方写入的那一份」）。`author_id` 与 `author_name_snapshot` 保持不变——
   * 编辑不转移作者，方案 §7 要求保留原始作者。
   */
  updateRevision(input: { id: string; bodyHash: string; lastEditorId: string }): Promise<TicketMessageRow>;
}

export function createTicketMessageRepository(): TicketMessageRepository {
  return {
    async insert(input) {
      const [row] = await getTicketsDatabase()
        .insert(ticketMessages)
        .values({
          projectId: input.projectId,
          objectKind: input.objectKind,
          providerObjectId: input.providerObjectId,
          messageId: input.messageId,
          authorId: input.authorId,
          authorNameSnapshot: input.authorNameSnapshot,
          bodyHash: input.bodyHash,
          // 新建即初版；`revision` 只由 T03 的编辑路径递增。
          revision: input.revision ?? 1,
          lastEditorId: input.lastEditorId ?? null,
        })
        .returning();
      if (row === undefined) throw new Error("ticket_messages 写入未返回行");
      return row;
    },

    async findObjectMessage(input) {
      // 三列即 `ticket_messages_object_uq` 唯一索引，最多一行。
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.projectId, input.projectId),
            eq(ticketMessages.objectKind, input.objectKind),
            eq(ticketMessages.providerObjectId, input.providerObjectId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async findByMessageId(input) {
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.messageId, input.messageId))
        .limit(1);
      return rows[0];
    },

    async findManyByMessageIds(input) {
      // 空集合直接返回：`inArray` 配空数组只会产生恒假条件，语义在 SQL 里表达不必要，也省一次往返。
      if (input.messageIds.length === 0) return [];
      return getTicketsDatabase()
        .select()
        .from(ticketMessages)
        .where(
          and(eq(ticketMessages.projectId, input.projectId), inArray(ticketMessages.messageId, [...input.messageIds])),
        );
    },

    async updateRevision(input) {
      const [row] = await getTicketsDatabase()
        .update(ticketMessages)
        .set({
          bodyHash: input.bodyHash,
          // 自增在 SQL 内完成：读改写会让两个并发编辑各自基于同一旧值写回，一次改写被吞掉。
          revision: sql`${ticketMessages.revision} + 1`,
          lastEditorId: input.lastEditorId,
        })
        .where(eq(ticketMessages.id, input.id))
        .returning();
      if (row === undefined) {
        // 归属行是写入路径与终态同事务落库的产物，更新零行只可能是账本与数据不一致。
        throw new Error("ticket_messages 归属行不存在，无法刷新正文版本");
      }
      return row;
    },
  };
}
