import { model, provider } from "@fenix/model-management/db";
import { and, asc, count, eq, inArray, type SQL } from "drizzle-orm";
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
 * Model **子表**的持久化访问层。
 *
 * Model 不注册独立资源、不建 owner / `visibility`，也没有自己的授权谓词（决策 D6 + Q1）：它的可见性
 * 与可写性**完全继承 Provider**。因此本仓储不接收 `ResourceQueryConstraint`，所有读写都以"父 Provider
 * 已经过授权"为前提，只按 `provider_id` 定位子行。
 *
 * 这条约定由调用点保证：Model 读写一律经 `ProviderFacade`（先对 Provider 授权，再操作子表）。
 * 仓储自身不做任何授权判断——授权已经在 Facade 完成，重复判断只会造成两套真相。
 */

export type ModelRow = typeof model.$inferSelect;

/**
 * Model 子行的次序键：创建时间升序 + `id` 升序。
 *
 * `id` 是必要的次序键：同一次批量写入的多行可能共享 `createdAt`，只按时间排序会让"第一个模型"在两次
 * 查询之间漂移。
 */
export const MODEL_LIST_ORDER: readonly SQL[] = [asc(model.createdAt), asc(model.id)];

/**
 * `model` 表的 jsonb 列形状。
 *
 * 这些列是自由形状的配置投影（由前端与消费方约定），仓储只做类型标注不做运行时校验：迁移前同样
 * 不校验，加上校验会让既有配置在保存时突然失败。定义紧挨着使用它们的列声明，避免再出现一个跨层
 * 共享的"类型杂物间"。
 */
export type ModelModalities = { input?: ("text" | "image")[]; output?: ("text" | "image")[] } | string[];

/** 模型限制配置（上下文长度、输出上限、速率限制）。 */
export interface ModelLimitConfig {
  context?: number;
  output?: number;
  rpm?: number;
  [key: string]: unknown;
}

/** 模型计费配置。 */
export interface ModelCostConfig {
  input?: number;
  output?: number;
}

/** 模型 Provider 专属参数。 */
export type ModelOptions = Record<string, unknown>;

/**
 * 可写列集合。
 *
 * `provider_id` / `organization_id` / `model_id` 不在这里：前两者是归属列（随 Provider 确定，
 * 写路径不得改写），`model_id` 是子表内的业务主键（`(provider_id, model_id)` 唯一索引的冲突目标）。
 *
 * 空值语义：`undefined` 表示"不修改这一列"，`null` 表示"置空"。迁移前 upsert 与 update 对
 * `null` 的处理不一致（upsert 静默跳过），这里统一为后者的语义。
 */
export interface ModelWriteData {
  readonly displayName?: string | null;
  readonly modalities?: ModelModalities | null;
  readonly limitConfig?: ModelLimitConfig | null;
  readonly cost?: ModelCostConfig | null;
  readonly options?: ModelOptions | null;
}

export interface ModelRepository {
  /** 枚举某 Provider 下的全部模型（详情视图与 `/api` 分页都在内存里切分，与迁移前一致）。 */
  listByProviderId(input: { providerId: string }): Promise<ModelRow[]>;
  /** 批量模型计数，供 Provider 列表展示；不存在的 Provider 不出现在结果里。 */
  countByProviderIds(input: { providerIds: readonly string[] }): Promise<ReadonlyMap<string, number>>;
  findById(input: { providerId: string; id: string }): Promise<ModelRow | undefined>;
  findByModelId(input: { providerId: string; modelId: string }): Promise<ModelRow | undefined>;
  /**
   * 无授权读取单行（launch spec 构建按 `agent_config.model_id` 取模型行）。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用。
   * 用户请求路径一律经 `findById` / `findByModelId`（后两者还要求先给出 `providerId`）。
   */
  findRowUnscoped(input: { id: string }): Promise<ModelRow | undefined>;
  /**
   * 无授权取某 Provider 下按 {@link MODEL_LIST_ORDER} 排第一的模型。
   *
   * "第一个模型"这条规则与它的排序由本包持有：调用方（如 launch spec 构建）只表达"要一个可用的"，
   * 不重复声明排序键，避免两侧排序分叉。
   */
  findFirstByProviderUnscoped(input: { providerId: string }): Promise<ModelRow | undefined>;
  /** 幂等创建；`(provider_id, model_id)` 唯一索引冲突时更新可写列。 */
  upsert(input: {
    providerId: string;
    organizationId: string;
    modelId: string;
    data: ModelWriteData;
  }): Promise<string | undefined>;
  updateById(input: { organizationId: string; providerId: string; id: string; data: ModelWriteData }): Promise<boolean>;
  updateByModelId(input: {
    organizationId: string;
    providerId: string;
    modelId: string;
    data: ModelWriteData;
  }): Promise<boolean>;
  removeById(input: { organizationId: string; providerId: string; id: string }): Promise<boolean>;
  removeByModelId(input: { organizationId: string; providerId: string; modelId: string }): Promise<boolean>;
}

export function createModelRepository(): ModelRepository {
  /** 可写列 → Drizzle set 片段；归属列与 `model_id` 不参与，见 {@link ModelWriteData}。 */
  function writeSet(data: ModelWriteData): Partial<typeof model.$inferInsert> {
    const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      (set as Record<string, unknown>)[key] = value;
    }
    return set;
  }

  /**
   * `model` 行的归属组织条件。
   *
   * 与 `provider_id` 一起使用时组织是冗余条件，保留它是刻意的：`model.organization_id` 是随 Provider
   * 冗余下来的列，带上它能让"子行与父行组织不一致"这种脏数据在写路径上直接不匹配（返回 404），
   * 而不是被静默改成另一个组织的数据。
   */
  function rowKey(input: { organizationId: string; providerId: string }) {
    return and(eq(model.organizationId, input.organizationId), eq(model.providerId, input.providerId));
  }

  return {
    async listByProviderId(input) {
      return database().select().from(model).where(eq(model.providerId, input.providerId));
    },

    async countByProviderIds(input) {
      if (input.providerIds.length === 0) return new Map();
      const rows = await database()
        .select({ providerId: model.providerId, total: count() })
        .from(model)
        .where(inArray(model.providerId, [...input.providerIds]))
        .groupBy(model.providerId);
      return new Map(rows.map((row) => [row.providerId, Number(row.total)]));
    },

    async findById(input) {
      const rows = await database()
        .select()
        .from(model)
        .where(and(eq(model.providerId, input.providerId), eq(model.id, input.id)))
        .limit(1);
      return rows[0];
    },

    async findByModelId(input) {
      const rows = await database()
        .select()
        .from(model)
        .where(and(eq(model.providerId, input.providerId), eq(model.modelId, input.modelId)))
        .limit(1);
      return rows[0];
    },

    async findRowUnscoped(input) {
      const rows = await database().select().from(model).where(eq(model.id, input.id)).limit(1);
      return rows[0];
    },

    async findFirstByProviderUnscoped(input) {
      const rows = await database()
        .select()
        .from(model)
        .where(eq(model.providerId, input.providerId))
        .orderBy(...MODEL_LIST_ORDER)
        .limit(1);
      return rows[0];
    },

    async upsert(input) {
      const set = writeSet(input.data);
      const rows = await database()
        .insert(model)
        .values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          modelId: input.modelId,
          ...set,
        })
        .onConflictDoUpdate({
          target: [model.providerId, model.modelId],
          set,
        })
        .returning({ id: model.id });
      return rows[0]?.id;
    },

    async updateById(input) {
      const rows = await database()
        .update(model)
        .set(writeSet(input.data))
        .where(and(rowKey(input), eq(model.id, input.id)))
        .returning({ id: model.id });
      return rows.length > 0;
    },

    async updateByModelId(input) {
      const rows = await database()
        .update(model)
        .set(writeSet(input.data))
        .where(and(rowKey(input), eq(model.modelId, input.modelId)))
        .returning({ id: model.id });
      return rows.length > 0;
    },

    async removeById(input) {
      const rows = await database()
        .delete(model)
        .where(and(rowKey(input), eq(model.id, input.id)))
        .returning({ id: model.id });
      return rows.length > 0;
    },

    async removeByModelId(input) {
      const rows = await database()
        .delete(model)
        .where(and(rowKey(input), eq(model.modelId, input.modelId)))
        .returning({ id: model.id });
      return rows.length > 0;
    },
  };
}

/**
 * 按 model id 批量取**展示标签**（`<Provider 展示名>/<模型展示名>`）。
 *
 * 只读、无授权判断：model 是 Provider 的子表（见本文件头部），调用方给出 model id 时 Provider 的授权
 * 已经完成，这里只负责把 id 换成名称——因此与 `findRowUnscoped` 同一授权前提，差别只在形状与列宽
 * （这条返回拼好的两段标签，那条返回整行）。
 *
 * 标签怎么拼属于本包自己的词汇：哪一段缺失时回退到 `name` / `model_id` 由本包决定，调用方只保留
 * 「取不到就退回 id」这一层视图语义。**任何一段取不到都不在 Map 里造值**（含模型行在、但其 Provider
 * 行缺失的情形）——「查不到」与「显示名就是 id」是两种不同的结果。
 *
 * Provider 行按 `(id, model.organization_id)` 匹配，与迁移前的查询条件一致：`model.organization_id`
 * 是随 Provider 冗余下来的列，带上它能让「子行与父行组织不一致」这种脏数据不匹配（调用方因而退回 id），
 * 而不是把另一个组织的 Provider 名显示出来。
 */
export async function findModelLabelsByIds(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const db = getModelManagementDatabase();
  const modelRows = await db
    .select({
      id: model.id,
      modelId: model.modelId,
      displayName: model.displayName,
      providerId: model.providerId,
      organizationId: model.organizationId,
    })
    .from(model)
    .where(inArray(model.id, [...ids]));
  if (modelRows.length === 0) return new Map();

  const providerRows = await db
    .select({
      id: provider.id,
      organizationId: provider.organizationId,
      name: provider.name,
      displayName: provider.displayName,
    })
    .from(provider)
    .where(inArray(provider.id, [...new Set(modelRows.map((row) => row.providerId))]));
  const providerById = new Map(providerRows.map((row) => [row.id, row]));

  const labels = new Map<string, string>();
  for (const row of modelRows) {
    const providerRow = providerById.get(row.providerId);
    if (!providerRow || providerRow.organizationId !== row.organizationId) continue;
    labels.set(row.id, `${providerRow.displayName ?? providerRow.name}/${row.displayName ?? row.modelId}`);
  }
  return labels;
}
