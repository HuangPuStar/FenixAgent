import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourcePage,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { ticketProjects } from "@fenix/resource-tickets/db";
import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { TICKET_PROJECT_RESOURCE_TYPE, ticketProjectResource } from "../access/ticket-project-resource";
import { getTicketsDatabase } from "../db";

/**
 * 工单项目的持久化访问层。
 *
 * 受控读取（列表 / 详情）一律经 {@link AuthorizedResourceQuery} 端口：本包只交出主表、注册表里的归属列
 * 与不透明授权条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。仓储因此不持有任何组织、角色或
 * 受众判断（跨组织可见性对 `ticket_project` 就是「谓词只匹配一个组织」，本包写不出第二套谓词），也不
 * 解释 `ResourceQueryConstraint` 的内部结构。
 *
 * 写路径（`upsertByBinding` / `setDefault` / `setStatus`）与无授权读取（`*Unscoped`）不属于授权范围，
 * 直接经 `getTicketsDatabase()` 执行：调用方必须先完成授权（Facade 的 `authorizeAction`）或已持有组织级
 * advisory lock。无授权方法在命名里带 `Unscoped`，评审时一眼可见。
 *
 * 行类型在本层声明并出口（`TicketProjectRow` / `ScopedTicketProjectRow`）是刻意的：`db/schema.ts` 的存储
 * 形状只经这里向上暴露，服务层不 import 表对象，也不碰 jsonb 与时间戳的底层表示。
 */

export type TicketProjectRow = typeof ticketProjects.$inferSelect;
export type ScopedTicketProjectRow = ScopedRow<TicketProjectRow>;

/**
 * 本包对授权查询端口的存储类型实例化。
 *
 * 端口声明在 `platform-sdk` 上、用 `unknown` 槽位保持与存储无关；这里收窄为具体 Drizzle 类型，
 * 使本包的查询构造获得完整类型校验，同时不产生「资源包 → 具体授权实现」的编译依赖。
 */
export interface TicketProjectQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: TicketProjectRow;
}

export interface TicketProjectRepository {
  /** 受控读取：只交出表、归属列与业务条件，授权谓词由平台编译进同一条 SQL。 */
  listReadable(input: {
    access: ResourceQueryConstraint;
    limit?: number;
    offset?: number;
  }): Promise<ResourcePage<ScopedTicketProjectRow>>;
  findReadableById(input: {
    access: ResourceQueryConstraint;
    projectId: string;
  }): Promise<ScopedTicketProjectRow | undefined>;
  /** 无授权读取：仅限本包服务在**已完成授权或事务内已持锁**的路径（如默认项目解析、切换）；命名带 Unscoped 便于评审一眼识别。 */
  findByIdUnscoped(projectId: string): Promise<TicketProjectRow | undefined>;
  findByBindingId(bindingId: string): Promise<TicketProjectRow | undefined>;
  listByOrganizationUnscoped(organizationId: string): Promise<TicketProjectRow[]>;
  upsertByBinding(input: {
    organizationId: string;
    bindingId: string;
    connectionId: string;
    providerRepositoryId: string;
    owner: string;
    name: string;
    createdBy: string;
  }): Promise<TicketProjectRow>;
  /** 原子切换：同一事务内先清旧默认再置新默认（部分唯一索引因此始终成立）。 */
  setDefault(input: { organizationId: string; projectId: string }): Promise<void>;
  setStatus(input: { organizationId: string; projectId: string; status: "active" | "paused" }): Promise<boolean>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = ticketProjectResource.storage;

export function createTicketProjectRepository(
  query: AuthorizedResourceQuery<TicketProjectQueryStorage>,
): TicketProjectRepository {
  /** 受控读取的公共查询目标；`access` 原样透传，仓储不解释、不重写条件。 */
  function target(access: ResourceQueryConstraint) {
    return {
      resourceType: TICKET_PROJECT_RESOURCE_TYPE,
      table: storage.table,
      columns: storage.columns,
      access,
    };
  }

  return {
    async listReadable(input) {
      const page = await query.list({
        ...target(input.access),
        // 项目列表的顺序归仓储（§4.2 未给 order 入参）：按开通时间升序稳定输出，
        // 否则 Postgres 的物理行序会在 UPDATE 后漂移，同一份数据两次读到不同顺序。
        businessOrder: [asc(ticketProjects.createdAt)],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
      // 计数与列表共用同一份授权条件：分页与总数不得建立在不同的可见集合上。
      const total = await query.count(target(input.access));
      return { items: page.items, total };
    },

    async findReadableById(input) {
      // 不额外补组织条件：可见集合完全由授权谓词决定，补条件会把「跨组织=不可见」的判定复制到本层。
      return query.findById({ ...target(input.access), resourceId: input.projectId });
    },

    async findByIdUnscoped(projectId) {
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketProjects)
        .where(eq(ticketProjects.id, projectId))
        .limit(1);
      return rows[0];
    },

    async findByBindingId(bindingId) {
      const rows = await getTicketsDatabase()
        .select()
        .from(ticketProjects)
        .where(eq(ticketProjects.repositoryRef, bindingId))
        .limit(1);
      return rows[0];
    },

    async listByOrganizationUnscoped(organizationId) {
      return getTicketsDatabase()
        .select()
        .from(ticketProjects)
        .where(eq(ticketProjects.organizationId, organizationId))
        .orderBy(asc(ticketProjects.createdAt));
    },

    /**
     * 开通同一仓库绑定时的幂等写入：唯一索引冲突即刷新坐标快照，不产生第二个项目。
     *
     * 冲突目标 `repository_ref` 唯一索引，更新集合刻意**不含** `organizationId` / `createdBy` /
     * `isDefault` / `status`：
     * - 归属不能迁移（同 `@fenix/git` 的绑定写入口径）：调用方在写之前已拒绝跨组织冲突，这里把租户列钉在
     *   原值上，封掉「检查与写入之间被另一并发写改掉归属」的窗口；
     * - 默认项目与暂停状态是运维决定：重复开通不得把 `paused` 悄悄恢复成 `active`，也不得顶掉当前默认。
     */
    async upsertByBinding(input) {
      const [row] = await getTicketsDatabase()
        .insert(ticketProjects)
        .values({
          organizationId: input.organizationId,
          repositoryRef: input.bindingId,
          connectionId: input.connectionId,
          providerRepositoryId: input.providerRepositoryId,
          owner: input.owner,
          name: input.name,
          createdBy: input.createdBy,
        })
        .onConflictDoUpdate({
          target: [ticketProjects.repositoryRef],
          set: {
            connectionId: input.connectionId,
            providerRepositoryId: input.providerRepositoryId,
            owner: input.owner,
            name: input.name,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row === undefined) throw new Error("ticket_projects 写入未返回行");
      return row;
    },

    /**
     * 置为组织默认项目。
     *
     * 两条 UPDATE 必须在同一事务内且**先清后置**：`ticket_projects_default_active_uq` 是「每组织最多
     * 一条 active default」的部分唯一索引，反过来执行会先撞索引。`runInTransaction` 是 REQUIRED 语义，
     * 装配路径已在外层开启事务时直接加入，不会另起一个（外层通常由 `withTicketLock` 开启）。
     */
    async setDefault(input) {
      await runInTransaction(async () => {
        const db = getTicketsDatabase();
        const now = new Date();
        await db
          .update(ticketProjects)
          .set({ isDefault: false, updatedAt: now })
          .where(
            and(
              eq(ticketProjects.organizationId, input.organizationId),
              eq(ticketProjects.isDefault, true),
              ne(ticketProjects.id, input.projectId),
            ),
          );
        await db
          .update(ticketProjects)
          .set({ isDefault: true, updatedAt: now })
          .where(and(eq(ticketProjects.id, input.projectId), eq(ticketProjects.organizationId, input.organizationId)));
      });
    },

    /**
     * 启停项目（`paused` 只停写，读与历史数据保留）。
     *
     * 组织条件进 WHERE 是防越权的最后一道：调用方已按受控读取确认项目归属，这里仍要求组织匹配，
     * 避免「ID 猜中 + 前置校验被绕过」时改到别的组织的项目。返回是否命中行，调用方据此区分 404。
     */
    async setStatus(input) {
      const rows = await getTicketsDatabase()
        .update(ticketProjects)
        .set({ status: input.status, updatedAt: new Date() })
        .where(and(eq(ticketProjects.id, input.projectId), eq(ticketProjects.organizationId, input.organizationId)))
        .returning({ id: ticketProjects.id });
      return rows.length > 0;
    },
  };
}
