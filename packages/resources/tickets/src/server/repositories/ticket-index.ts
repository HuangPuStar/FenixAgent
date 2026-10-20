import { ticketIndex, ticketProjects } from "@fenix/resource-tickets/db";
import { and, desc, eq, ilike, type SQL, sql } from "drizzle-orm";
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
 *
 * **唯一的跨组织读取**是 {@link TicketIndexRepository.listPlatformPage}：它服务平台管理面（`/api/system/tickets`），
 * 需要 join 项目表补出归属组织——`ticket_index` 只有 `project_id`，组织维度在 `ticket_projects` 上。它不接受
 * 任何授权条件，调用方必须是已完成平台凭据校验的系统路径；组织内可见性（受控查询）不经过它。
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

/** 平台管理面的跨组织查询（页码语义在 Facade 已换算成 `limit` / `offset`）。 */
export interface TicketIndexPlatformQuery {
  readonly limit: number;
  readonly offset: number;
  readonly q?: string;
  readonly state?: "open" | "closed" | "all";
  readonly organizationId?: string;
  readonly projectId?: string;
}

/** 跨组织读取的一行：索引行本体 + 从项目表带出的归属坐标（视图组装需要，仓储不做展示加工）。 */
export interface TicketIndexPlatformRow {
  readonly issue: TicketIndexRow;
  readonly organizationId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectOwner: string;
}

export interface TicketIndexPlatformPage {
  readonly items: readonly TicketIndexPlatformRow[];
  /** 同一谓词下的命中总数（跨页），界面据此判断还有没有下一页。 */
  readonly total: number;
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
  /** 平台管理面的跨组织分页读取（见文件头）：不接受授权条件，调用方必须是系统路径。 */
  listPlatformPage(input: TicketIndexPlatformQuery): Promise<TicketIndexPlatformPage>;
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

    /**
     * 平台管理面的跨组织分页读取。
     *
     * 排序**不用工单号**：跨项目时工单号只在项目内有意义（两个项目各有 #1），拿它做全局序会得到随机交错
     * 的列表。这里按「最后一次同步时间降序 + 主键降序」排：前者是「最近有动静的工单在前」的近似，后者是
     * 唯一的兜底——没有它，同一 `synced_at` 的行在不同页请求之间顺序不定，翻页会重复或漏行。
     *
     * 计数与列表共用同一份谓词：分页与总数不得建立在不同的可见集合上（`total` 与分页口径漂移时，界面会
     * 出现「最后一页是空的」或「翻不到最后一页」）。
     */
    async listPlatformPage(input) {
      const conditions: SQL[] = [];
      if (input.state !== undefined && input.state !== "all") conditions.push(eq(ticketIndex.state, input.state));
      if (input.q !== undefined) conditions.push(ilike(ticketIndex.title, `%${escapeLikePattern(input.q)}%`));
      if (input.organizationId !== undefined) {
        conditions.push(eq(ticketProjects.organizationId, input.organizationId));
      }
      if (input.projectId !== undefined) conditions.push(eq(ticketIndex.projectId, input.projectId));
      const where = conditions.length === 0 ? undefined : and(...conditions);

      const db = getTicketsDatabase();
      const items = await db
        .select({
          issue: ticketIndex,
          organizationId: ticketProjects.organizationId,
          projectId: ticketProjects.id,
          projectName: ticketProjects.name,
          projectOwner: ticketProjects.owner,
        })
        .from(ticketIndex)
        // inner join：项目行被删除时索引行随外键 cascade 一起消失，不存在的项目不会留下孤儿索引行。
        .innerJoin(ticketProjects, eq(ticketProjects.id, ticketIndex.projectId))
        .where(where)
        .orderBy(desc(ticketIndex.syncedAt), desc(ticketIndex.id))
        .limit(input.limit)
        .offset(input.offset);

      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(ticketIndex)
        .innerJoin(ticketProjects, eq(ticketProjects.id, ticketIndex.projectId))
        .where(where);

      return { items, total: counted?.total ?? 0 };
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
