import { ticketIndex } from "@fenix/resource-tickets/db";
import { and, eq, ilike, type SQL, sql } from "drizzle-orm";
import { getTicketsDatabase } from "../db";

/**
 * 工单查询索引的持久化访问层（列表只读这张表，详情回源 Forgejo）。
 *
 * 两条游标语义写死在这里，调用方不需要（也不得）另写一套：
 * - 顺序是**工单号数值降序**（最新在前）。列是 `varchar`，按字典序排会把 `10` 排在 `9` 前面，因此排序与
 *   游标上界都用 `::bigint`；取值面由路由 schema（`^[1-9]\d*$`）与 Forgejo 的数字编号共同保证是纯数字。
 * - 游标是**排他上界**：`issue_number < cursor`，翻页因此不会重复上一页的最后一条。
 *
 * `q` 只匹配 `title`（不承诺评论全文检索），并把 LIKE 元字符转义掉：不加转义时用户输入的 `%` 会变成
 * 「任意串」，`_` 会变成「任意单字符」，同一关键词在不同位置给出不同结果集。
 */

export type TicketIndexRow = typeof ticketIndex.$inferSelect;

export interface TicketIndexQuery {
  readonly projectId: string;
  readonly cursor?: string; // 上一页末条的 issueNumber（排他上界）
  readonly limit: number; // 1..100，默认 30
  readonly q?: string; // title 模糊匹配（不承诺评论全文检索）
  readonly state?: "open" | "closed" | "all";
  readonly assigneeId?: string;
  readonly labelId?: string; // label_ids @> [labelId]
}

export interface TicketIndexRepository {
  upsertIssue(input: {
    projectId: string;
    issueNumber: string;
    title: string;
    state: "open" | "closed";
    authorId: string | null;
    authorName: string | null;
    assigneeId: string | null;
    labelIds: readonly string[];
    contentVersion: string;
    providerUpdatedAt: Date | null;
    syncStatus?: "ready" | "stale";
  }): Promise<TicketIndexRow>;
  listPage(input: TicketIndexQuery): Promise<TicketIndexRow[]>;
  findByIssueNumber(input: { projectId: string; issueNumber: string }): Promise<TicketIndexRow | undefined>;
  countByProject(projectId: string): Promise<number>;
}

/** LIKE 元字符转义；Postgres 的默认转义符是反斜杠，替换出来的模式串随参数绑定，不参与 SQL 拼接。 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createTicketIndexRepository(): TicketIndexRepository {
  return {
    /**
     * 写入或刷新索引行。
     *
     * 冲突目标是 `(project_id, issue_number)`：同一条工单的重复同步是刷新而不是新增。`sync_status` 与
     * `synced_at` 每次都推进——行级状态表达的是「这一行的内容对得上远端的最新确认」，漏掉它会让列表
     * 把陈旧内容当成已同步（决策 D6）。
     */
    async upsertIssue(input) {
      const db = getTicketsDatabase();
      const now = new Date();
      const refreshed = {
        title: input.title,
        state: input.state,
        authorId: input.authorId,
        authorName: input.authorName,
        assigneeId: input.assigneeId,
        labelIds: [...input.labelIds],
        contentVersion: input.contentVersion,
        providerUpdatedAt: input.providerUpdatedAt,
        syncStatus: input.syncStatus ?? "ready",
        syncedAt: now,
      };
      const [row] = await db
        .insert(ticketIndex)
        .values({ projectId: input.projectId, issueNumber: input.issueNumber, ...refreshed })
        .onConflictDoUpdate({
          target: [ticketIndex.projectId, ticketIndex.issueNumber],
          // 冲突时只刷内容列，不回写定位列（定位列就是冲突目标，写回它们只会制造一次无意义的行更新）。
          set: refreshed,
        })
        .returning();
      if (row === undefined) throw new Error("ticket_index 写入未返回行");
      return row;
    },

    async listPage(input) {
      const conditions: SQL[] = [eq(ticketIndex.projectId, input.projectId)];
      // `all`/缺省都表示不过滤状态：三态里的「全部」不是第四个状态值，不能落到 `state = 'all'`。
      if (input.state !== undefined && input.state !== "all") conditions.push(eq(ticketIndex.state, input.state));
      if (input.cursor !== undefined) {
        conditions.push(sql`${ticketIndex.issueNumber}::bigint < ${input.cursor}::bigint`);
      }
      if (input.q !== undefined) conditions.push(ilike(ticketIndex.title, `%${escapeLikePattern(input.q)}%`));
      if (input.assigneeId !== undefined) conditions.push(eq(ticketIndex.assigneeId, input.assigneeId));
      if (input.labelId !== undefined) {
        conditions.push(sql`${ticketIndex.labelIds} @> ${JSON.stringify([input.labelId])}::jsonb`);
      }
      return getTicketsDatabase()
        .select()
        .from(ticketIndex)
        .where(and(...conditions))
        .orderBy(sql`${ticketIndex.issueNumber}::bigint desc`)
        .limit(input.limit);
    },

    async findByIssueNumber(input) {
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketIndex)
        .where(and(eq(ticketIndex.projectId, input.projectId), eq(ticketIndex.issueNumber, input.issueNumber)))
        .limit(1);
      return rows[0];
    },

    async countByProject(projectId) {
      const rows = await getTicketsDatabase()
        .select({ total: sql<number>`count(*)::int` })
        .from(ticketIndex)
        .where(eq(ticketIndex.projectId, projectId));
      return rows[0]?.total ?? 0;
    },
  };
}
