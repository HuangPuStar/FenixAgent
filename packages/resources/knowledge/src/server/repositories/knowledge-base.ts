import { agentKnowledgeBinding, knowledgeBase, knowledgeResource } from "@fenix/resource-knowledge/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getKnowledgeDatabase } from "../db";

/** KnowledgeBase 行类型 */
export type KnowledgeBaseRow = typeof knowledgeBase.$inferSelect;
export type KnowledgeBaseInsert = typeof knowledgeBase.$inferInsert;

/** KnowledgeResource 行类型 */
export type KnowledgeResourceRow = typeof knowledgeResource.$inferSelect;
export type KnowledgeResourceInsert = typeof knowledgeResource.$inferInsert;

/** AgentKnowledgeBinding 行类型 */
export type AgentKnowledgeBindingRow = typeof agentKnowledgeBinding.$inferSelect;
export type AgentKnowledgeBindingInsert = typeof agentKnowledgeBinding.$inferInsert;

/** KnowledgeBase 仓储接口 */
export interface IKnowledgeBaseRepo {
  getById(knowledgeBaseId: string): Promise<KnowledgeBaseRow | null>;
  getByUserAndId(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseRow | null>;
  listByUserId(userId: string): Promise<KnowledgeBaseRow[]>;
  findByUserAndSlug(userId: string, slug: string): Promise<KnowledgeBaseRow | null>;
  listByOrganizationId(organizationId: string): Promise<KnowledgeBaseRow[]>;
  getByOrgAndId(organizationId: string, knowledgeBaseId: string): Promise<KnowledgeBaseRow | null>;
  findByOrgAndSlug(organizationId: string, slug: string, userId?: string): Promise<KnowledgeBaseRow | null>;
  create(data: KnowledgeBaseInsert): Promise<KnowledgeBaseRow>;
  update(knowledgeBaseId: string, data: Partial<KnowledgeBaseInsert>): Promise<void>;
  delete(knowledgeBaseId: string): Promise<boolean>;
  countBindings(knowledgeBaseId: string): Promise<number>;
  /** 列出所有知识库 */
  listGlobal(): Promise<KnowledgeBaseRow[]>;
}

/** KnowledgeResource 仓储接口 */
export interface IKnowledgeResourceRepo {
  getById(resourceId: string): Promise<KnowledgeResourceRow | null>;
  getByRemoteId(knowledgeBaseId: string, remoteId: string): Promise<KnowledgeResourceRow | null>;
  /** 按知识库 + 文件名查找资源，用于上传幂等检查 */
  getBySourceName(knowledgeBaseId: string, sourceName: string): Promise<KnowledgeResourceRow | null>;
  listByKnowledgeBase(knowledgeBaseId: string, limit?: number): Promise<KnowledgeResourceRow[]>;
  countByKnowledgeBase(knowledgeBaseId: string): Promise<number>;
  getStatusSummary(knowledgeBaseId: string): Promise<{
    readyCount: number;
    activeCount: number;
    errorCount: number;
    totalCount: number;
  }>;
  create(data: KnowledgeResourceInsert): Promise<KnowledgeResourceRow>;
  update(resourceId: string, data: Partial<KnowledgeResourceInsert>): Promise<void>;
  updateByRemoteIds(remoteIds: string[], data: Partial<KnowledgeResourceInsert>): Promise<void>;
  delete(resourceId: string): Promise<boolean>;
  deleteByKnowledgeBase(knowledgeBaseId: string): Promise<void>;
  findByRemoteIds(remoteIds: string[]): Promise<KnowledgeResourceRow[]>;
}

/** AgentKnowledgeBinding 仓储接口 */
export interface IAgentKnowledgeBindingRepo {
  listByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
  listEnabledByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
  listByKnowledgeBaseId(knowledgeBaseId: string): Promise<AgentKnowledgeBindingRow[]>;
  countByKnowledgeBaseId(knowledgeBaseId: string): Promise<number>;
  countByKnowledgeBaseIds(knowledgeBaseIds: string[]): Promise<Record<string, number>>;
  create(data: AgentKnowledgeBindingInsert): Promise<AgentKnowledgeBindingRow>;
  createMany(dataList: AgentKnowledgeBindingInsert[]): Promise<void>;
  deleteByAgentConfigId(agentConfigId: string): Promise<void>;
  deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void>;
  listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string): Promise<
    Array<
      AgentKnowledgeBindingRow & {
        kbId: string;
        kbName: string;
        kbRemoteId: string | null;
        kbRemoteAccountId: string | null;
        kbRemoteUserId: string | null;
        kbUserId: string;
        kbOrganizationId: string | null;
        kbEmbeddingModel: string | null;
      }
    >
  >;
  getResourceWithKnowledgeBase(resourceId: string): Promise<{
    resource: KnowledgeResourceRow;
    kbUserId: string;
    kbOrganizationId: string | null;
    kbRemoteId: string | null;
    kbRemoteAccountId: string | null;
    kbRemoteUserId: string | null;
  } | null>;
}

class PgKnowledgeBaseRepo implements IKnowledgeBaseRepo {
  async getById(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, knowledgeBaseId)).limit(1);
    return rows[0] ?? null;
  }

  async getByUserAndId(userId: string, knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select()
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.userId, userId)));
    return rows[0] ?? null;
  }

  async listByUserId(userId: string) {
    const db = getKnowledgeDatabase();
    return db
      .select()
      .from(knowledgeBase)
      .where(eq(knowledgeBase.userId, userId))
      .orderBy(desc(knowledgeBase.updatedAt));
  }

  async findByUserAndSlug(userId: string, slug: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select()
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.userId, userId), eq(knowledgeBase.slug, slug)));
    return rows[0] ?? null;
  }

  async listByOrganizationId(organizationId: string) {
    const db = getKnowledgeDatabase();
    return db
      .select()
      .from(knowledgeBase)
      .where(eq(knowledgeBase.organizationId, organizationId))
      .orderBy(desc(knowledgeBase.updatedAt));
  }

  async getByOrgAndId(organizationId: string, knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select()
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.organizationId, organizationId)));
    return rows[0] ?? null;
  }

  async findByOrgAndSlug(organizationId: string, slug: string, userId?: string) {
    const db = getKnowledgeDatabase();
    const conditions = [eq(knowledgeBase.organizationId, organizationId), eq(knowledgeBase.slug, slug)];
    if (userId) conditions.push(eq(knowledgeBase.userId, userId));
    const rows = await db
      .select()
      .from(knowledgeBase)
      .where(and(...conditions));
    return rows[0] ?? null;
  }

  async create(data: KnowledgeBaseInsert) {
    const db = getKnowledgeDatabase();
    const [row] = await db.insert(knowledgeBase).values(data).returning();
    return row;
  }

  async update(knowledgeBaseId: string, data: Partial<KnowledgeBaseInsert>) {
    const db = getKnowledgeDatabase();
    await db.update(knowledgeBase).set(data).where(eq(knowledgeBase.id, knowledgeBaseId));
  }

  async delete(knowledgeBaseId: string): Promise<boolean> {
    const db = getKnowledgeDatabase();
    const result = await db
      .delete(knowledgeBase)
      .where(eq(knowledgeBase.id, knowledgeBaseId))
      .returning({ id: knowledgeBase.id });
    return result.length > 0;
  }

  async countBindings(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const [row] = await db
      .select({ count: count() })
      .from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }

  async listGlobal() {
    const db = getKnowledgeDatabase();
    return db.select().from(knowledgeBase).orderBy(desc(knowledgeBase.updatedAt));
  }
}

class PgKnowledgeResourceRepo implements IKnowledgeResourceRepo {
  async getById(resourceId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db.select().from(knowledgeResource).where(eq(knowledgeResource.id, resourceId)).limit(1);
    return rows[0] ?? null;
  }

  async getByRemoteId(knowledgeBaseId: string, remoteId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select()
      .from(knowledgeResource)
      .where(and(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId), eq(knowledgeResource.remoteId, remoteId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getBySourceName(knowledgeBaseId: string, sourceName: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select()
      .from(knowledgeResource)
      .where(and(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId), eq(knowledgeResource.sourceName, sourceName)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByKnowledgeBase(knowledgeBaseId: string, limit?: number) {
    const db = getKnowledgeDatabase();
    return db
      .select()
      .from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId))
      .orderBy(desc(knowledgeResource.updatedAt))
      .limit(limit ?? 100);
  }

  async countByKnowledgeBase(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const [row] = await db
      .select({ count: count() })
      .from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }

  async getStatusSummary(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const [summary] = await db
      .select({
        readyCount: sql<number>`sum(case when ${knowledgeResource.status} = 'ready' then 1 else 0 end)`,
        activeCount: sql<number>`sum(case when ${knowledgeResource.status} in ('pending', 'processing') then 1 else 0 end)`,
        errorCount: sql<number>`sum(case when ${knowledgeResource.status} = 'error' then 1 else 0 end)`,
        totalCount: count(),
      })
      .from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
    return {
      readyCount: summary?.readyCount ?? 0,
      activeCount: summary?.activeCount ?? 0,
      errorCount: summary?.errorCount ?? 0,
      totalCount: summary?.totalCount ?? 0,
    };
  }

  async create(data: KnowledgeResourceInsert) {
    const db = getKnowledgeDatabase();
    const [row] = await db.insert(knowledgeResource).values(data).returning();
    return row;
  }

  async update(resourceId: string, data: Partial<KnowledgeResourceInsert>) {
    const db = getKnowledgeDatabase();
    await db.update(knowledgeResource).set(data).where(eq(knowledgeResource.id, resourceId));
  }

  async updateByRemoteIds(remoteIds: string[], data: Partial<KnowledgeResourceInsert>) {
    const db = getKnowledgeDatabase();
    if (remoteIds.length === 0) return;
    await db.update(knowledgeResource).set(data).where(inArray(knowledgeResource.remoteId, remoteIds));
  }

  async delete(resourceId: string): Promise<boolean> {
    const db = getKnowledgeDatabase();
    const result = await db
      .delete(knowledgeResource)
      .where(eq(knowledgeResource.id, resourceId))
      .returning({ id: knowledgeResource.id });
    return result.length > 0;
  }

  async deleteByKnowledgeBase(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    await db.delete(knowledgeResource).where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
  }

  async findByRemoteIds(remoteIds: string[]) {
    const db = getKnowledgeDatabase();
    if (remoteIds.length === 0) return [];
    return db.select().from(knowledgeResource).where(inArray(knowledgeResource.remoteId, remoteIds));
  }
}

class PgAgentKnowledgeBindingRepo implements IAgentKnowledgeBindingRepo {
  async listByAgentConfigId(agentConfigId: string) {
    const db = getKnowledgeDatabase();
    return db
      .select()
      .from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId))
      .orderBy(agentKnowledgeBinding.priority);
  }

  async listEnabledByAgentConfigId(agentConfigId: string) {
    const db = getKnowledgeDatabase();
    return db
      .select()
      .from(agentKnowledgeBinding)
      .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)))
      .orderBy(agentKnowledgeBinding.priority);
  }

  async listByKnowledgeBaseId(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    return db.select().from(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
  }

  async countByKnowledgeBaseId(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    const [row] = await db
      .select({ count: count() })
      .from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }

  async countByKnowledgeBaseIds(knowledgeBaseIds: string[]) {
    const db = getKnowledgeDatabase();
    if (knowledgeBaseIds.length === 0) return {};
    const rows = await db
      .select()
      .from(agentKnowledgeBinding)
      .where(inArray(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseIds));
    const counts: Record<string, number> = {};
    for (const id of knowledgeBaseIds) {
      counts[id] = 0;
    }
    for (const row of rows) {
      counts[row.knowledgeBaseId] = (counts[row.knowledgeBaseId] ?? 0) + 1;
    }
    return counts;
  }

  async create(data: AgentKnowledgeBindingInsert) {
    const db = getKnowledgeDatabase();
    const [row] = await db.insert(agentKnowledgeBinding).values(data).returning();
    return row;
  }

  async createMany(dataList: AgentKnowledgeBindingInsert[]) {
    const db = getKnowledgeDatabase();
    if (dataList.length === 0) return;
    await db.insert(agentKnowledgeBinding).values(dataList);
  }

  async deleteByAgentConfigId(agentConfigId: string) {
    const db = getKnowledgeDatabase();
    await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId));
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string) {
    const db = getKnowledgeDatabase();
    await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
  }

  async listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string) {
    const db = getKnowledgeDatabase();
    return db
      .select({
        id: agentKnowledgeBinding.id,
        agentConfigId: agentKnowledgeBinding.agentConfigId,
        knowledgeBaseId: agentKnowledgeBinding.knowledgeBaseId,
        config: agentKnowledgeBinding.config,
        priority: agentKnowledgeBinding.priority,
        enabled: agentKnowledgeBinding.enabled,
        createdAt: agentKnowledgeBinding.createdAt,
        updatedAt: agentKnowledgeBinding.updatedAt,
        kbId: knowledgeBase.id,
        kbName: knowledgeBase.name,
        kbRemoteId: knowledgeBase.remoteId,
        kbRemoteAccountId: knowledgeBase.remoteAccountId,
        kbRemoteUserId: knowledgeBase.remoteUserId,
        kbUserId: knowledgeBase.userId,
        kbOrganizationId: knowledgeBase.organizationId,
        kbEmbeddingModel: sql<string | null>`${knowledgeBase.metadata} ->> 'embeddingModel'`,
      })
      .from(agentKnowledgeBinding)
      .innerJoin(knowledgeBase, eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBase.id))
      .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)));
  }

  async getResourceWithKnowledgeBase(resourceId: string) {
    const db = getKnowledgeDatabase();
    const rows = await db
      .select({
        id: knowledgeResource.id,
        knowledgeBaseId: knowledgeResource.knowledgeBaseId,
        sourceType: knowledgeResource.sourceType,
        sourceName: knowledgeResource.sourceName,
        sourcePath: knowledgeResource.sourcePath,
        remoteId: knowledgeResource.remoteId,
        status: knowledgeResource.status,
        lastError: knowledgeResource.lastError,
        createdAt: knowledgeResource.createdAt,
        updatedAt: knowledgeResource.updatedAt,
        kbRemoteId: knowledgeBase.remoteId,
        kbUserId: knowledgeBase.userId,
        kbOrganizationId: knowledgeBase.organizationId,
        kbRemoteAccountId: knowledgeBase.remoteAccountId,
        kbRemoteUserId: knowledgeBase.remoteUserId,
      })
      .from(knowledgeResource)
      .innerJoin(knowledgeBase, eq(knowledgeResource.knowledgeBaseId, knowledgeBase.id))
      .where(eq(knowledgeResource.id, resourceId))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      resource: {
        id: row.id,
        knowledgeBaseId: row.knowledgeBaseId,
        sourceType: row.sourceType,
        sourceName: row.sourceName,
        sourcePath: row.sourcePath,
        remoteId: row.remoteId,
        status: row.status,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      kbRemoteId: row.kbRemoteId,
      kbUserId: row.kbUserId,
      kbOrganizationId: row.kbOrganizationId,
      kbRemoteAccountId: row.kbRemoteAccountId,
      kbRemoteUserId: row.kbRemoteUserId,
    };
  }
}

export const knowledgeBaseRepo = new PgKnowledgeBaseRepo();
export const knowledgeResourceRepo = new PgKnowledgeResourceRepo();
export const agentKnowledgeBindingRepo = new PgAgentKnowledgeBindingRepo();

/** 知识库的展示投影：`name` 渲染标签、`slug` 作为次级标识；字段随消费方视图而定，不随表结构自动扩张。 */
export interface KnowledgeBaseSummary {
  readonly name: string;
  readonly slug: string;
}

/**
 * 按 id 集合取知识库摘要（**跨包只读**入口，消费方是 `@fenix/resource-agent-config` 的
 * `services/agent-related-resources.ts`，经 `@fenix/resource-knowledge/server/summaries` 出口）。
 *
 * 与 `@fenix/resource-mcp/server/config` 的 `findMcpServerLabelsByIds`、
 * `@fenix/resource-skill/server/config` 的 `findSkillLabelsByIds` 是同族的「关联 id 展示投影」，
 * 两处刻意的差异：
 * - **多一个 `organizationId` 条件**。skill / mcp 的投影只按 id 取、不做归属判断（那两张表有
 *   `visibility`，跨组织可见性由授权面表达）；`knowledge_base` 没有 `visibility` 列，归属就是
 *   `organization_id`，因此这里把「资源归属组织」一起下推——调用方配错组织时结果是**空 Map**
 *   （标签退化成裸 id），而不是把别的组织的知识库名渲染出来。
 * - **多返回一个 `slug`**。消费方的视图（`AgentRelatedResourceView.knowledgeBases`）要 `slug` 作为
 *   次级标识，与 `agent_site_app` 的 `remoteAppId` 同属「视图需要、标签本身不需要」的字段。
 *
 * 返回 `Map<id, Summary>`（键是 id）而不是数组：消费方按输入顺序拼标签，缺项要能退化成裸 id。
 * 空 `knowledgeBaseIds` 直接返回空 Map，不发查询——与两条同族投影一致。
 */
export async function findKnowledgeBaseSummariesByIds(input: {
  organizationId: string;
  knowledgeBaseIds: readonly string[];
}): Promise<Map<string, KnowledgeBaseSummary>> {
  if (input.knowledgeBaseIds.length === 0) return new Map();
  const rows = await getKnowledgeDatabase()
    .select({ id: knowledgeBase.id, name: knowledgeBase.name, slug: knowledgeBase.slug })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.organizationId, input.organizationId),
        inArray(knowledgeBase.id, [...input.knowledgeBaseIds]),
      ),
    );
  return new Map(rows.map((row) => [row.id, { name: row.name, slug: row.slug }]));
}
