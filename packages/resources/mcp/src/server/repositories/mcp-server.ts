import { randomUUID } from "node:crypto";
import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourcePage,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { mcpServer, mcpTool } from "@server/db/schema";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { MCP_SERVER_RESOURCE_TYPE, mcpServerResource } from "../access/mcp-server-resource";
import { getMcpDatabase } from "../db";

/**
 * MCP Server 的持久化访问层。
 *
 * 受控读取（列表 / 详情 / 按名 / 按 resource key）一律经 {@link AuthorizedResourceQuery} 端口：
 * 本包只交出主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。仓储因此
 * 不持有任何组织、角色或 `visibility` 判断，也不解释 `ResourceQueryConstraint` 的内部结构。
 *
 * 写路径（INSERT / UPDATE / DELETE）与 `mcp_tool` 缓存不属于授权范围，直接经 `getMcpDatabase()`
 * 执行；它们的权限校验发生在 Facade（`authorize` 之后才调用 Domain Service）。
 *
 * DB 句柄在每个用到的方法内取（`../db` 的 `getMcpDatabase()`）而不是模块加载期持有：句柄来自宿主
 * 的基础设施初始化，模块加载早于它就取不到。
 */

export type McpServerRow = typeof mcpServer.$inferSelect;
export type McpToolRow = typeof mcpTool.$inferSelect;
export type ScopedMcpServerRow = ScopedRow<McpServerRow>;

/**
 * 本包对授权查询端口的存储类型实例化。
 *
 * 端口声明在 `platform-sdk` 上、用 `unknown` 槽位保持与存储无关；这里收窄为具体 Drizzle 类型，
 * 使本包的查询构造获得完整类型校验，同时不产生「资源包 → 具体授权实现」的编译依赖。
 */
export interface McpServerQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: McpServerRow;
}

/** 受控读取的公共输入；`access` 缺失仅限系统管理 Facade 等已完成权限校验的调用路径。 */
export interface McpReadInput {
  readonly access: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface McpServerRepository {
  listReadable(input: McpReadInput): Promise<ResourcePage<ScopedMcpServerRow>>;
  findReadableById(input: {
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedMcpServerRow | undefined>;
  findReadableByKey(input: {
    organizationId: string;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedMcpServerRow | undefined>;
  findReadableByName(input: {
    name: string;
    access: ResourceQueryConstraint;
    organizationId?: string;
  }): Promise<ScopedMcpServerRow | undefined>;
  insert(input: {
    name: string;
    type: string;
    config: unknown;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  /** 系统托管资源（如 Hindsight）的幂等写入：同组织同名更新配置，绝不改归属列与 `visibility`。 */
  upsertByOrgAndName(input: {
    name: string;
    type: string;
    config: unknown;
    organizationId: string;
    ownerUserId: string;
  }): Promise<string | undefined>;
  updateById(input: { resourceId: string; patch: { type?: string; config: unknown } }): Promise<boolean>;
  setEnabledById(input: { resourceId: string; enabled: boolean }): Promise<boolean>;
  deleteById(input: { resourceId: string }): Promise<boolean>;
  /** 删除服务器与其缓存的 tools（同一事务）：`mcp_tool` 没有独立生命周期，不能留下孤儿行。 */
  deleteWithTools(input: { resourceId: string; organizationId: string; serverName: string }): Promise<boolean>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （launch spec 构建要按绑定表给出的 ID 取回 MCP 配置）。用户请求路径一律经 `findReadable*`。
   */
  findByIdUnscoped(input: { resourceId: string }): Promise<McpServerRow | undefined>;
  /**
   * 无授权按 ID 批量读取（launch spec 构建）。
   *
   * 与 {@link findByIdUnscoped} 同一授权前提，差别只在形状与查询次数：调用方持有的是绑定表给出的
   * ID 集合。**不过滤 `enabled` 与 `visibility`**：禁用项由调用方按既有语义记日志并跳过，读层擅自
   * 过滤会让"配置了但被禁用"与"配置丢失"两种情况无法区分。
   */
  listByIdsUnscoped(input: { resourceIds: readonly string[] }): Promise<readonly McpServerRow[]>;
  countTools(input: { organizationId: string; serverName: string }): Promise<number>;
  listTools(input: { organizationId: string; serverName: string }): Promise<McpToolRow[]>;
  replaceTools(input: {
    organizationId: string;
    serverName: string;
    tools: readonly { name: string; description?: string; inputSchema?: unknown }[];
  }): Promise<void>;
  deleteTools(input: { organizationId: string; serverName: string }): Promise<void>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = mcpServerResource.storage;

export function createMcpServerRepository(query: AuthorizedResourceQuery<McpServerQueryStorage>): McpServerRepository {
  /** 组装端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: McpReadInput) {
    return {
      resourceType: MCP_SERVER_RESOURCE_TYPE,
      table: storage.table,
      columns: storage.columns,
      access: input.access,
      ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
    };
  }

  return {
    async listReadable(input) {
      const page = await query.list({
        ...target(input),
        ...(input.order === undefined ? {} : { businessOrder: input.order }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
      // 计数与列表共用同一份授权条件与业务条件：分页/计数不得建立在不同的可见集合上。
      const total = await query.count(target(input));
      return { items: page.items, total };
    },

    async findReadableById(input) {
      return query.findById({
        resourceType: MCP_SERVER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
      });
    },

    async findReadableByKey(input) {
      return query.findById({
        resourceType: MCP_SERVER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
        businessWhere: [eq(mcpServer.organizationId, input.organizationId)],
      });
    },

    async findReadableByName(input) {
      const page = await query.list({
        resourceType: MCP_SERVER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        businessWhere:
          input.organizationId === undefined
            ? [eq(mcpServer.name, input.name)]
            : [eq(mcpServer.name, input.name), eq(mcpServer.organizationId, input.organizationId)],
        limit: 1,
      });
      return page.items[0];
    },

    async insert(input) {
      const rows = await getMcpDatabase()
        .insert(mcpServer)
        .values({
          name: input.name,
          type: input.type,
          config: input.config,
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          visibility: input.visibility,
          enabled: true,
          updatedAt: new Date(),
        })
        // 同组织同名唯一（`idx_mcp_server_org_name`）：冲突返回空集，由上层映射为 409，
        // 不做 upsert——那会让"创建"在并发下静默改掉既有配置。
        .onConflictDoNothing()
        .returning({ id: mcpServer.id });
      return rows[0]?.id;
    },

    async upsertByOrgAndName(input) {
      const rows = await getMcpDatabase()
        .insert(mcpServer)
        .values({
          name: input.name,
          type: input.type,
          config: input.config,
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          enabled: true,
          updatedAt: new Date(),
        })
        // 冲突只更新连接配置：归属列（组织、owner）与 visibility 是创建期属性，系统路径也不得改写，
        // 否则重复配置会让资源在组织之间漂移或静默改变公开受众。
        .onConflictDoUpdate({
          target: [mcpServer.organizationId, mcpServer.name],
          set: { type: input.type, config: input.config, updatedAt: new Date() },
        })
        .returning({ id: mcpServer.id });
      return rows[0]?.id;
    },

    async findByIdUnscoped(input) {
      const rows = await getMcpDatabase().select().from(mcpServer).where(eq(mcpServer.id, input.resourceId)).limit(1);
      return rows[0];
    },

    async listByIdsUnscoped(input) {
      // 空集合直接返回：`inArray` 配空数组只会产生恒假条件，语义在 SQL 里表达不必要。
      if (input.resourceIds.length === 0) return [];
      return getMcpDatabase()
        .select()
        .from(mcpServer)
        .where(inArray(mcpServer.id, [...input.resourceIds]));
    },

    async updateById(input) {
      const patch: Partial<typeof mcpServer.$inferInsert> = {
        config: input.patch.config,
        updatedAt: new Date(),
      };
      if (input.patch.type !== undefined) patch.type = input.patch.type;
      const rows = await getMcpDatabase()
        .update(mcpServer)
        .set(patch)
        .where(eq(mcpServer.id, input.resourceId))
        .returning({ id: mcpServer.id });
      return rows.length > 0;
    },

    async setEnabledById(input) {
      const rows = await getMcpDatabase()
        .update(mcpServer)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(mcpServer.id, input.resourceId))
        .returning({ id: mcpServer.id });
      return rows.length > 0;
    },

    async deleteById(input) {
      const rows = await getMcpDatabase()
        .delete(mcpServer)
        .where(eq(mcpServer.id, input.resourceId))
        .returning({ id: mcpServer.id });
      return rows.length > 0;
    },

    async deleteWithTools(input) {
      return getMcpDatabase().transaction(async (tx) => {
        const rows = await tx
          .delete(mcpServer)
          .where(eq(mcpServer.id, input.resourceId))
          .returning({ id: mcpServer.id });
        await tx
          .delete(mcpTool)
          .where(and(eq(mcpTool.organizationId, input.organizationId), eq(mcpTool.serverName, input.serverName)));
        return rows.length > 0;
      });
    },

    async countTools(input) {
      const [row] = await getMcpDatabase()
        .select({ count: sql<number>`count(*)` })
        .from(mcpTool)
        .where(and(eq(mcpTool.organizationId, input.organizationId), eq(mcpTool.serverName, input.serverName)));
      return Number(row?.count ?? 0);
    },

    async listTools(input) {
      return getMcpDatabase()
        .select()
        .from(mcpTool)
        .where(and(eq(mcpTool.organizationId, input.organizationId), eq(mcpTool.serverName, input.serverName)));
    },

    async replaceTools(input) {
      await getMcpDatabase().transaction(async (tx) => {
        await tx
          .delete(mcpTool)
          .where(and(eq(mcpTool.organizationId, input.organizationId), eq(mcpTool.serverName, input.serverName)));
        if (input.tools.length === 0) return;
        const inspectedAt = new Date();
        await tx.insert(mcpTool).values(
          input.tools.map((tool) => ({
            id: randomUUID(),
            organizationId: input.organizationId,
            serverName: input.serverName,
            toolName: tool.name,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema ?? null,
            inspectedAt,
          })),
        );
      });
    },

    async deleteTools(input) {
      await getMcpDatabase()
        .delete(mcpTool)
        .where(and(eq(mcpTool.organizationId, input.organizationId), eq(mcpTool.serverName, input.serverName)));
    },
  };
}
