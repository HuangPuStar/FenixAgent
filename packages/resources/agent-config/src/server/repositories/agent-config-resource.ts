import { agentConfig } from "@fenix/agent-config/db";
import {
  deleteEnvironmentsByAgentConfig,
  listEnvironmentIdsByAgentConfig,
} from "@fenix/agent-runtime/server/environment";
import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourcePage,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { AGENT_CONFIG_RESOURCE_TYPE, agentConfigResource } from "../access/agent-config-resource";
import { type AgentConfigDatabase, getAgentConfigDatabase } from "../db";

/**
 * AgentConfig **资源行**的持久化访问层。
 *
 * 与同目录的 `agent-config.ts`（按 ID 批量取展示名一类的旁路只读查询）职责不同：这里只处理资源主表
 * 本身的受控读写，是 `route → Facade → Domain Service → Repository` 里的最内层。
 *
 * 受控读取（列表 / 详情 / 按名 / 按资源键）一律经 {@link AuthorizedResourceQuery} 端口：本包只交出
 * 主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。仓储因此不持有任何组织、
 * 角色或 `visibility` 判断，也不解释 `ResourceQueryConstraint` 的内部结构。
 *
 * 写路径（INSERT / UPDATE / DELETE）不属于授权范围，直接经平台 DB 句柄执行（`getAgentConfigDatabase()`，
 * 请求期读取，不在模块加载期缓存）；权限校验发生在 Facade。
 */

export type AgentConfigRow = typeof agentConfig.$inferSelect;
export type ScopedAgentConfigRow = ScopedRow<AgentConfigRow>;

/**
 * 本包对授权查询端口的存储类型实例化。
 *
 * 端口声明在 `platform-sdk` 上、用 `unknown` 槽位保持与存储无关；这里收窄为具体 Drizzle 类型，
 * 使本包的查询构造获得完整类型校验，同时不产生「资源包 → 具体授权实现」的编译依赖。
 */
export interface AgentConfigQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: AgentConfigRow;
}

/** 受控读取的公共输入；`access` 必须是 Facade 产出的不透明条件。 */
export interface AgentConfigReadInput {
  readonly access: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * 可写列集合。
 *
 * 归属列（`organization_id` / `user_id` / `visibility`）不在这里：它们在创建期写入，之后的任何写
 * 路径都不得改写，否则一次配置保存就会让资源在组织之间漂移或静默改变公开受众。
 */
export interface AgentConfigWriteData {
  readonly model?: string | null;
  readonly modelId?: string | null;
  readonly prompt?: string | null;
  readonly description?: string | null;
  readonly extra?: Record<string, unknown> | null;
  readonly agentNode?: unknown;
}

export interface AgentConfigRepository {
  listReadable(input: AgentConfigReadInput): Promise<ResourcePage<ScopedAgentConfigRow>>;
  findReadableById(input: {
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedAgentConfigRow | undefined>;
  findReadableByKey(input: {
    organizationId: string;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedAgentConfigRow | undefined>;
  findReadableByName(input: {
    name: string;
    access: ResourceQueryConstraint;
    organizationId?: string;
  }): Promise<ScopedAgentConfigRow | undefined>;
  /**
   * 幂等创建；同组织同名由唯一索引收敛。
   *
   * 冲突时只更新可写列，**不改归属列**：创建动作已经过授权（owner/admin），重复提交不该让资源
   * 换主，也不该把公开受众重置回默认值。
   */
  create(input: {
    name: string;
    data: AgentConfigWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  updateById(input: { resourceId: string; data: AgentConfigWriteData }): Promise<boolean>;
  /**
   * 删除资源行与绑定其上的 Environment（同一事务）。
   *
   * 绑定 agent 的 runtime environment 在 agent 删除后没有独立业务价值，留在库里会继续出现在
   * `/web/environments` 列表中；两步必须在同一事务里，避免删一半留下无主环境。
   */
  removeWithEnvironments(input: { resourceId: string; organizationId: string }): Promise<boolean>;
  /** 枚举绑定在该 Agent 上的 Environment（删除前停止实例、重启前定位实例都要用）。 */
  listBoundEnvironmentIds(input: { resourceId: string; organizationId: string }): Promise<readonly string[]>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （LaunchSpec 构建、Observer 展示、acp-ws 归属解析）。用户请求路径一律经 `findReadable*`。
   */
  findByIdUnscoped(input: { resourceId: string }): Promise<AgentConfigRow | undefined>;
  /**
   * 无授权按名称读取**指定组织内**的单行。
   *
   * 两类调用方，都不是"读资源给用户看"：
   *
   * 1. 系统编排路径：meta AgentConfig 引导的"这个组织里有没有这个 Agent"判定；
   * 2. 创建期唯一性预检（`AgentConfigFacade.existsInOrganization`，受制于
   *    `idx_agent_config_org_name` = `(organization_id, name)`）。
   *
   * 两类都刻意不经过授权：名称唯一性是主表约束而不是授权事实，用授权可见集合判定会让预检口径随
   * `memberDefaultActions` / `ownershipMode` 变宽或变窄，而 `create` 的 upsert 冲突目标不会跟着变。
   * 组织必须显式传入——名称在不同组织之间不唯一，退化成跨组织按名查找会让一个组织的创建被另一个
   * 组织的公开资源误判为冲突。
   */
  findByNameUnscoped(input: { name: string; organizationId: string }): Promise<AgentConfigRow | undefined>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = agentConfigResource.storage;

export function createAgentConfigRepository(
  query: AuthorizedResourceQuery<AgentConfigQueryStorage>,
): AgentConfigRepository {
  /** 组装端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: AgentConfigReadInput) {
    return {
      resourceType: AGENT_CONFIG_RESOURCE_TYPE,
      table: storage.table,
      columns: storage.columns,
      access: input.access,
      ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
    };
  }

  /** 可写列 → Drizzle set 片段；归属列不参与，见 {@link AgentConfigWriteData}。 */
  function writeSet(data: AgentConfigWriteData): Partial<typeof agentConfig.$inferInsert> {
    const set: Partial<typeof agentConfig.$inferInsert> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      (set as Record<string, unknown>)[key] = value;
    }
    return set;
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
        resourceType: AGENT_CONFIG_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
      });
    },

    async findReadableByKey(input) {
      return query.findById({
        resourceType: AGENT_CONFIG_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
        businessWhere: [eq(agentConfig.organizationId, input.organizationId)],
      });
    },

    async findReadableByName(input) {
      const page = await query.list({
        resourceType: AGENT_CONFIG_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        businessWhere:
          input.organizationId === undefined
            ? [eq(agentConfig.name, input.name)]
            : [eq(agentConfig.name, input.name), eq(agentConfig.organizationId, input.organizationId)],
        limit: 1,
      });
      return page.items[0];
    },

    async create(input) {
      const set = writeSet(input.data);
      const rows = await getAgentConfigDatabase()
        .insert(agentConfig)
        .values({
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          name: input.name,
          visibility: input.visibility,
          ...set,
        })
        .onConflictDoUpdate({
          target: [agentConfig.organizationId, agentConfig.name],
          // 冲突分支只更新可写列：归属列是创建期属性，重复创建不得改主或改公开受众。
          set,
        })
        .returning({ id: agentConfig.id });
      return rows[0]?.id;
    },

    async updateById(input) {
      const rows = await getAgentConfigDatabase()
        .update(agentConfig)
        .set(writeSet(input.data))
        .where(eq(agentConfig.id, input.resourceId))
        .returning({ id: agentConfig.id });
      return rows.length > 0;
    },

    async removeWithEnvironments(input) {
      // 事务句柄显式标注为本包句柄类型：agent-runtime 的删除入口按同一类型接收集合（两包的句柄类型
      // 同为 `NodePgDatabase<Record<string, never>>`，见 `../db.ts`），因此「删环境 + 删配置」仍在
      // 同一个事务里，语义与迁移前直读 environment 表时一致。`environment` 的删除实现在 owner 侧
      // （`@fenix/agent-runtime/server/environment`），本包只决定顺序与事务边界。
      return getAgentConfigDatabase().transaction(async (tx: AgentConfigDatabase) => {
        await deleteEnvironmentsByAgentConfig(tx, {
          organizationId: input.organizationId,
          agentConfigId: input.resourceId,
        });
        const rows = await tx
          .delete(agentConfig)
          .where(eq(agentConfig.id, input.resourceId))
          .returning({ id: agentConfig.id });
        return rows.length > 0;
      });
    },

    async listBoundEnvironmentIds(input) {
      return listEnvironmentIdsByAgentConfig({
        organizationId: input.organizationId,
        agentConfigId: input.resourceId,
      });
    },

    async findByIdUnscoped(input) {
      const rows = await getAgentConfigDatabase()
        .select()
        .from(agentConfig)
        .where(eq(agentConfig.id, input.resourceId))
        .limit(1);
      return rows[0];
    },

    async findByNameUnscoped(input) {
      const rows = await getAgentConfigDatabase()
        .select()
        .from(agentConfig)
        .where(and(eq(agentConfig.organizationId, input.organizationId), eq(agentConfig.name, input.name)))
        .limit(1);
      return rows[0];
    },
  };
}

/**
 * 列表排序：创建时间倒序，`id` 升序作为同刻创建的次序键。
 *
 * 保留迁移前的展示顺序（最新创建的在前）以免产品行为变化；补一个唯一列做次序键，让分页与
 * "同一批数据的两次查询"有确定结果，不依赖数据库的物理返回顺序。
 */
export const AGENT_CONFIG_LIST_ORDER: readonly SQL[] = [desc(agentConfig.createdAt), asc(agentConfig.id)];
