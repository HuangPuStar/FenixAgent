import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourcePage,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { provider } from "@server/db/schema";
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { PROVIDER_RESOURCE_TYPE, providerResource } from "../access/provider-resource";
import { getModelManagementDatabase } from "../db";

/**
 * 取本模块的 DB 句柄。
 *
 * 包一层而不是 `import { db } from "@server/db"`：句柄只能在宿主完成基础设施初始化之后读取，而这些仓储
 * 是进程级单例，构造期可能早于 `initializeApplicationInfrastructure()`。名字与 Drizzle 惯例一致，调用点
 * 读起来与直接使用 `db` 相同。
 */
function database() {
  return getModelManagementDatabase();
}

/**
 * Provider **资源行**的持久化访问层。
 *
 * 与 `config/provider.ts`（迁移前的过程式读写入口）职责不同：这里只处理资源主表本身的受控读写，
 * 是 `route → Facade → Domain Service → Repository` 里的最内层。
 *
 * 受控读取（列表 / 详情 / 按名 / 按资源键）一律经 {@link AuthorizedResourceQuery} 端口：本包只交出
 * 主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。仓储因此不持有任何组织、
 * 角色或 `visibility` 判断，也不解释 `ResourceQueryConstraint` 的内部结构。
 *
 * 写路径（INSERT / UPDATE / DELETE）不属于授权范围，直接经 `db` 执行；权限校验发生在 Facade。
 */

export type ProviderRow = typeof provider.$inferSelect;
export type ScopedProviderRow = ScopedRow<ProviderRow>;

/**
 * 本包对授权查询端口的存储类型实例化。
 *
 * 端口声明在 `platform-sdk` 上、用 `unknown` 槽位保持与存储无关；这里收窄为具体 Drizzle 类型，
 * 使本包的查询构造获得完整类型校验，同时不产生「资源包 → 具体授权实现」的编译依赖。
 */
export interface ProviderQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: ProviderRow;
}

/**
 * 可写列集合。
 *
 * 归属列（`organization_id` / `user_id` / `visibility`）与 `name` 不在这里：归属列在创建期写入、
 * `name` 是同组织唯一索引的冲突目标，之后的任何写路径都不得改写，否则一次配置保存就会让资源在
 * 组织之间漂移、静默改变公开受众，或与另一个 Provider 撞唯一键。
 */
export interface ProviderWriteData {
  readonly displayName?: string | null;
  readonly kind?: "direct" | "gateway";
  readonly gatewayType?: string | null;
  readonly protocol?: "openai" | "anthropic";
  readonly baseUrl?: string | null;
  readonly apiKey?: string | null;
  readonly extraOptions?: Record<string, unknown> | null;
}

/** 受控读取的公共输入；`access` 必须是 Facade 产出的不透明条件。 */
export interface ProviderReadInput {
  readonly access: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProviderRepository {
  listReadable(input: ProviderReadInput): Promise<ResourcePage<ScopedProviderRow>>;
  findReadableById(input: {
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedProviderRow | undefined>;
  findReadableByKey(input: {
    organizationId: string;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedProviderRow | undefined>;
  findReadableByName(input: {
    name: string;
    access: ResourceQueryConstraint;
    organizationId?: string;
  }): Promise<ScopedProviderRow | undefined>;
  /**
   * 幂等创建；同组织同名由唯一索引收敛。
   *
   * 冲突时只更新可写列，**不改归属列**：创建动作已经过授权（owner/admin），重复提交不该让资源
   * 换主，也不该把公开受众重置回默认值。
   */
  create(input: {
    name: string;
    data: ProviderWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  updateById(input: { resourceId: string; data: ProviderWriteData }): Promise<boolean>;
  /** 删除资源行；`model` 子表由外键 `ON DELETE CASCADE` 一并清理。 */
  removeById(input: { resourceId: string }): Promise<boolean>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （LaunchSpec 构建、模型网关 provider 同步）。用户请求路径一律经 `findReadable*`。
   */
  findByIdUnscoped(input: { resourceId: string }): Promise<ProviderRow | undefined>;
  /**
   * 无授权按 (组织, 资源 ID) 读取单行。
   *
   * 与 {@link findByIdUnscoped} 的区别是它额外要求归属组织一致——子表行（`model`）随父行冗余了
   * `organization_id`，launch spec 构建要用它确认"模型行引用的 Provider 确实属于同一个组织"，
   * 避免读到跨组织拼出来的脏数据。
   */
  findRowByOrganizationUnscoped(input: {
    resourceId: string;
    organizationId: string;
  }): Promise<ProviderRow | undefined>;
  /**
   * 无授权按组织列出（按 {@link PROVIDER_LIST_ORDER}）。
   *
   * 系统路径用（launch spec 的"首个可用模型"要枚举组织内 Provider），调用方只表达"这个组织的"，
   * 不重复声明排序键。
   */
  listByOrganizationUnscoped(input: { organizationId: string }): Promise<readonly ProviderRow[]>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = providerResource.storage;

export function createProviderRepository(query: AuthorizedResourceQuery<ProviderQueryStorage>): ProviderRepository {
  /** 组装端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: ProviderReadInput) {
    return {
      resourceType: PROVIDER_RESOURCE_TYPE,
      table: storage.table,
      columns: storage.columns,
      access: input.access,
      ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
    };
  }

  /** 可写列 → Drizzle set 片段；归属列与 `name` 不参与，见 {@link ProviderWriteData}。 */
  function writeSet(data: ProviderWriteData): Partial<typeof provider.$inferInsert> {
    const set: Partial<typeof provider.$inferInsert> = { updatedAt: new Date() };
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
        resourceType: PROVIDER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
      });
    },

    async findReadableByKey(input) {
      return query.findById({
        resourceType: PROVIDER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
        businessWhere: [eq(provider.organizationId, input.organizationId)],
      });
    },

    async findReadableByName(input) {
      const page = await query.list({
        resourceType: PROVIDER_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        businessWhere:
          input.organizationId === undefined
            ? [eq(provider.name, input.name)]
            : [eq(provider.name, input.name), eq(provider.organizationId, input.organizationId)],
        limit: 1,
      });
      return page.items[0];
    },

    async create(input) {
      const set = writeSet(input.data);
      const rows = await database()
        .insert(provider)
        .values({
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          name: input.name,
          visibility: input.visibility,
          ...set,
        })
        .onConflictDoUpdate({
          target: [provider.organizationId, provider.name],
          // 冲突分支只更新可写列：归属列是创建期属性，重复创建不得改主或改公开受众。
          set,
        })
        .returning({ id: provider.id });
      return rows[0]?.id;
    },

    async updateById(input) {
      const rows = await database()
        .update(provider)
        .set(writeSet(input.data))
        .where(eq(provider.id, input.resourceId))
        .returning({ id: provider.id });
      return rows.length > 0;
    },

    async removeById(input) {
      const rows = await database()
        .delete(provider)
        .where(eq(provider.id, input.resourceId))
        .returning({ id: provider.id });
      return rows.length > 0;
    },

    async findByIdUnscoped(input) {
      const rows = await database().select().from(provider).where(eq(provider.id, input.resourceId)).limit(1);
      return rows[0];
    },

    async findRowByOrganizationUnscoped(input) {
      const rows = await database()
        .select()
        .from(provider)
        .where(and(eq(provider.id, input.resourceId), eq(provider.organizationId, input.organizationId)))
        .limit(1);
      return rows[0];
    },

    async listByOrganizationUnscoped(input) {
      return database()
        .select()
        .from(provider)
        .where(eq(provider.organizationId, input.organizationId))
        .orderBy(...PROVIDER_LIST_ORDER);
    },
  };
}

/**
 * 列表排序：创建时间升序，`id` 升序作为同刻创建的次序键。
 *
 * 迁移前该列表没有 `ORDER BY`，实际观感是插入顺序；显式写出升序即保持这一观感，同时给分页与
 * "同一批数据的两次查询"一个确定结果，不依赖数据库的物理返回顺序。
 */
export const PROVIDER_LIST_ORDER: readonly SQL[] = [asc(provider.createdAt), asc(provider.id)];
