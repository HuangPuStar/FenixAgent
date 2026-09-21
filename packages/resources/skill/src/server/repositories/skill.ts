import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourcePage,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { skill } from "@fenix/resource-skill/db";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { SKILL_RESOURCE_TYPE, skillResource } from "../access/skill-resource";
import { getSkillDatabase } from "../db";

/**
 * Skill 的持久化访问层。
 *
 * 受控读取（列表 / 详情 / 按名 / 按 resource key）一律经 {@link AuthorizedResourceQuery} 端口：
 * 本包只交出主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。仓储因此不持有
 * 任何组织、角色或 `visibility` 判断，也不解释 `ResourceQueryConstraint` 的内部结构。
 *
 * 写路径（INSERT / UPDATE / DELETE）不属于授权范围，直接经 {@link getSkillDatabase} 执行；权限校验
 * 发生在 Facade。句柄在方法内取而不是模块级持有：模块加载期宿主可能尚未完成基础设施初始化。
 * SKILL.md 与归档文件由 `services/skill-fs.ts` 负责，不在仓储职责内。
 */

export type SkillRow = typeof skill.$inferSelect;
export type ScopedSkillRow = ScopedRow<SkillRow>;

/**
 * 本包对授权查询端口的存储类型实例化。
 *
 * 端口声明在 `platform-sdk` 上、用 `unknown` 槽位保持与存储无关；这里收窄为具体 Drizzle 类型，
 * 使本包的查询构造获得完整类型校验，同时不产生「资源包 → 具体授权实现」的编译依赖。
 */
export interface SkillQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: SkillRow;
}

/** 受控读取的公共输入；`access` 必须是 Facade 产出的不透明条件。 */
export interface SkillReadInput {
  readonly access: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface SkillWriteData {
  readonly description?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/**
 * 把 `metadata` 列（jsonb，读回来是 `unknown`）投影为字符串表。
 *
 * 形状不符（历史数据里存过非字符串值、或写入方塞了嵌套对象）时返回 undefined 而不是强转：调用方
 * 拿到的是"这份元数据不可用"，不会把半截数据写回文档或误判 builtin 标记。
 */
export function toSkillMetadata(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return;
    result[key] = item;
  }
  return result;
}

export interface SkillRepository {
  listReadable(input: SkillReadInput): Promise<ResourcePage<ScopedSkillRow>>;
  findReadableById(input: { resourceId: string; access: ResourceQueryConstraint }): Promise<ScopedSkillRow | undefined>;
  findReadableByKey(input: {
    organizationId: string;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<ScopedSkillRow | undefined>;
  findReadableByName(input: {
    name: string;
    access: ResourceQueryConstraint;
    organizationId?: string;
  }): Promise<ScopedSkillRow | undefined>;
  /** 按名称批量读取（导入回读）：一次查询取回全部命中行，不做逐名 N+1。 */
  listReadableByNames(input: {
    names: readonly string[];
    access: ResourceQueryConstraint;
    organizationId: string;
  }): Promise<readonly ScopedSkillRow[]>;
  /** 受控创建；同组织同名由唯一索引拦下，冲突返回 undefined（由 Facade 映射为 409）。 */
  insert(input: {
    name: string;
    data: SkillWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  /**
   * 幂等写入（system / builtin 路径）。
   *
   * 冲突只更新描述与元数据：归属列（组织、owner）与 `visibility` 是创建期属性，系统路径同样不得
   * 改写，否则重复同步会让 Skill 在组织之间漂移或静默改变公开受众。
   */
  upsertByOrgAndName(input: {
    name: string;
    data: SkillWriteData;
    organizationId: string;
    ownerUserId: string;
  }): Promise<string | undefined>;
  updateById(input: { resourceId: string; data: SkillWriteData }): Promise<boolean>;
  deleteById(input: { resourceId: string }): Promise<boolean>;
  /**
   * 按 (组织, 名称) 删除。
   *
   * 导入回滚按名称工作（写入阶段只有名称，没有 id），因此需要这条入口；名称在同一组织内唯一，
   * 落入的仍是单行。
   */
  deleteByOrgAndName(input: { organizationId: string; name: string }): Promise<boolean>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （builtin 同步、launch spec 构建）。用户请求路径一律经 `findReadable*`。
   */
  findByIdUnscoped(input: { resourceId: string }): Promise<SkillRow | undefined>;
  /**
   * 无授权按 ID 批量读取。
   *
   * 与 {@link findByIdUnscoped} 同属系统路径（launch spec 构建要一次取回全部关联 Skill），差别只在
   * 形状：调用方持有的是绑定表给出的 ID 集合，逐行读会退化成本次启动的 N+1 查询。缺失的 ID 只是不出现在
   * 结果里，由调用方比对自己对齐既有失败语义。
   */
  listByIdsUnscoped(input: { resourceIds: readonly string[] }): Promise<readonly SkillRow[]>;
  /** 无授权按组织列出（builtin 孤儿清理要枚举整个托管租户，不是某个主体的可见集合）。 */
  listByOrganizationUnscoped(input: { organizationId: string }): Promise<readonly SkillRow[]>;
  /** 无授权按 (组织, 名称) 读取（builtin 同步判断"同名用户技能是否已存在"）。 */
  findByNameUnscoped(input: { organizationId: string; name: string }): Promise<SkillRow | undefined>;
  /** 无授权更新公开受众；系统托管路径（builtin 全组织共享）使用，用户路径经 Facade 的 `setVisibility`。 */
  updateVisibilityUnscoped(input: { resourceId: string; visibility: string }): Promise<boolean>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = skillResource.storage;

export function createSkillRepository(query: AuthorizedResourceQuery<SkillQueryStorage>): SkillRepository {
  /** 组装端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: SkillReadInput) {
    return {
      resourceType: SKILL_RESOURCE_TYPE,
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
        resourceType: SKILL_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
      });
    },

    async findReadableByKey(input) {
      return query.findById({
        resourceType: SKILL_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
        businessWhere: [eq(skill.organizationId, input.organizationId)],
      });
    },

    async findReadableByName(input) {
      const page = await query.list({
        resourceType: SKILL_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        businessWhere:
          input.organizationId === undefined
            ? [eq(skill.name, input.name)]
            : [eq(skill.name, input.name), eq(skill.organizationId, input.organizationId)],
        limit: 1,
      });
      return page.items[0];
    },

    async listReadableByNames(input) {
      if (input.names.length === 0) return [];
      const page = await query.list({
        resourceType: SKILL_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        businessWhere: [inArray(skill.name, [...input.names]), eq(skill.organizationId, input.organizationId)],
      });
      return page.items;
    },

    async insert(input) {
      const rows = await getSkillDatabase()
        .insert(skill)
        .values({
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          name: input.name,
          description: input.data.description ?? null,
          metadata: input.data.metadata ?? null,
          visibility: input.visibility,
        })
        // 同组织同名唯一（`idx_skill_org_name`）：冲突返回空集，由上层映射为 409，
        // 不做 upsert——那会让"创建"在并发下静默改掉既有描述。
        .onConflictDoNothing()
        .returning({ id: skill.id });
      return rows[0]?.id;
    },

    async upsertByOrgAndName(input) {
      const rows = await getSkillDatabase()
        .insert(skill)
        .values({
          organizationId: input.organizationId,
          userId: input.ownerUserId,
          name: input.name,
          description: input.data.description ?? null,
          metadata: input.data.metadata ?? null,
        })
        .onConflictDoUpdate({
          target: [skill.organizationId, skill.name],
          set: {
            description: input.data.description ?? null,
            metadata: input.data.metadata ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: skill.id });
      return rows[0]?.id;
    },

    async updateById(input) {
      const rows = await getSkillDatabase()
        .update(skill)
        .set({
          description: input.data.description ?? null,
          metadata: input.data.metadata ?? null,
          updatedAt: new Date(),
        })
        .where(eq(skill.id, input.resourceId))
        .returning({ id: skill.id });
      return rows.length > 0;
    },

    async deleteById(input) {
      const rows = await getSkillDatabase()
        .delete(skill)
        .where(eq(skill.id, input.resourceId))
        .returning({ id: skill.id });
      return rows.length > 0;
    },

    async deleteByOrgAndName(input) {
      const rows = await getSkillDatabase()
        .delete(skill)
        .where(and(eq(skill.organizationId, input.organizationId), eq(skill.name, input.name)))
        .returning({ id: skill.id });
      return rows.length > 0;
    },

    async findByIdUnscoped(input) {
      const rows = await getSkillDatabase().select().from(skill).where(eq(skill.id, input.resourceId)).limit(1);
      return rows[0];
    },

    async listByIdsUnscoped(input) {
      // 空集合直接返回：`inArray` 配空数组会退化成常量条件，语义（"没有要读的行"）在 SQL 里表达不必要。
      if (input.resourceIds.length === 0) return [];
      return getSkillDatabase()
        .select()
        .from(skill)
        .where(inArray(skill.id, [...input.resourceIds]));
    },

    async listByOrganizationUnscoped(input) {
      return getSkillDatabase()
        .select()
        .from(skill)
        .where(eq(skill.organizationId, input.organizationId))
        .orderBy(...SKILL_LIST_ORDER);
    },

    async findByNameUnscoped(input) {
      const rows = await getSkillDatabase()
        .select()
        .from(skill)
        .where(and(eq(skill.organizationId, input.organizationId), eq(skill.name, input.name)))
        .limit(1);
      return rows[0];
    },

    async updateVisibilityUnscoped(input) {
      const rows = await getSkillDatabase()
        .update(skill)
        .set({ visibility: input.visibility, updatedAt: new Date() })
        .where(eq(skill.id, input.resourceId))
        .returning({ id: skill.id });
      return rows.length > 0;
    },
  };
}

/**
 * 列表排序：创建时间倒序，`id` 升序作为同刻创建的次序键。
 *
 * 保留迁移前的展示顺序（最新创建的在前）以免产品行为变化；补一个唯一列做次序键，让分页与
 * "同一批数据的两次查询"有确定结果，不依赖数据库的物理返回顺序。
 */
export const SKILL_LIST_ORDER: readonly SQL[] = [desc(skill.createdAt), asc(skill.id)];

/** 启动期存储迁移需要的行投影：只取定位旧目录所需的两列。 */
export interface SkillOrgAndName {
  readonly organizationId: string;
  readonly name: string;
}

/**
 * 无授权列出全部 Skill 的 (组织, 名称)。
 *
 * 刻意不挂到 {@link SkillRepository} 上：启动迁移在授权查询端口可用之前执行，也不需要任何授权谓词，
 * 塞进接口只会逼调用方先构造一个用不上的 query 实例。表结构（`skill`）与其余方法同源，故仍留在仓储
 * 模块内，保持"本包只有这一处直接拼 SQL"的边界。
 */
export async function listAllSkillOrgAndNameUnscoped(): Promise<readonly SkillOrgAndName[]> {
  return getSkillDatabase().select({ organizationId: skill.organizationId, name: skill.name }).from(skill);
}

/**
 * 按 skill id 批量取**展示标签**（`name`）；空入参返回空 Map，缺失的 id 不出现在结果里。
 *
 * 无授权的只读投影（与 {@link listAllSkillOrgAndNameUnscoped} 同属刻意的无谓词读取）：调用方持有的是绑定
 * 表给出的 ID 集合（Agent 配置的 Skill 绑定），标签只用于渲染，不做归属或可见性判断——`name` 不是敏感
 * 字段，而按 `visibility` 过滤会让「曾经绑定过但已不可见」的技能退化成裸 ID，与迁移前的行为不一致。
 *
 * 与 mcp 的 `findMcpServerLabelsByIds` 同形（`@fenix/resource-mcp/server/config`）：展示投影由 owner
 * 提供，消费方因此不必再直接读本包的表对象（§1.7 B5 的调用期收口）。
 */
export async function findSkillLabelsByIds(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getSkillDatabase()
    .select({ id: skill.id, name: skill.name })
    .from(skill)
    .where(inArray(skill.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name]));
}
