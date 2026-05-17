import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentKnowledgeBinding,
  knowledgeBase,
  knowledgeResource,
} from "../db/schema";

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
  listByTeamId(teamId: string): Promise<KnowledgeBaseRow[]>;
  getByTeamAndId(teamId: string, knowledgeBaseId: string): Promise<KnowledgeBaseRow | null>;
  findByTeamAndSlug(teamId: string, slug: string): Promise<KnowledgeBaseRow | null>;
  create(data: KnowledgeBaseInsert): Promise<KnowledgeBaseRow>;
  update(knowledgeBaseId: string, data: Partial<KnowledgeBaseInsert>): Promise<void>;
  delete(knowledgeBaseId: string): Promise<boolean>;
  countBindings(knowledgeBaseId: string): Promise<number>;
}

/** KnowledgeResource 仓储接口 */
export interface IKnowledgeResourceRepo {
  getById(resourceId: string): Promise<KnowledgeResourceRow | null>;
  getByRemoteId(knowledgeBaseId: string, remoteId: string): Promise<KnowledgeResourceRow | null>;
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
  listByAgentName(agentName: string): Promise<AgentKnowledgeBindingRow[]>;
  listEnabledByAgentName(agentName: string): Promise<AgentKnowledgeBindingRow[]>;
  listByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
  listEnabledByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
  listByKnowledgeBaseId(knowledgeBaseId: string): Promise<AgentKnowledgeBindingRow[]>;
  countByKnowledgeBaseId(knowledgeBaseId: string): Promise<number>;
  countByKnowledgeBaseIds(knowledgeBaseIds: string[]): Promise<Record<string, number>>;
  create(data: AgentKnowledgeBindingInsert): Promise<AgentKnowledgeBindingRow>;
  createMany(dataList: AgentKnowledgeBindingInsert[]): Promise<void>;
  deleteByAgentName(agentName: string): Promise<void>;
  deleteByAgentConfigId(agentConfigId: string): Promise<void>;
  deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void>;
  listJoinedWithKnowledgeBase(agentName: string): Promise<Array<AgentKnowledgeBindingRow & {
    kbId: string;
    kbRemoteId: string | null;
    kbRemoteAccountId: string | null;
    kbRemoteUserId: string | null;
    kbUserId: string;
  }>>;
  listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string): Promise<Array<AgentKnowledgeBindingRow & {
    kbId: string;
    kbRemoteId: string | null;
    kbRemoteAccountId: string | null;
    kbRemoteUserId: string | null;
    kbUserId: string;
  }>>;
  getResourceWithKnowledgeBase(resourceId: string): Promise<{
    resource: KnowledgeResourceRow;
    kbUserId: string;
    kbRemoteAccountId: string | null;
    kbRemoteUserId: string | null;
  } | null>;
}

class PgKnowledgeBaseRepo implements IKnowledgeBaseRepo {
  async getById(knowledgeBaseId: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.id, knowledgeBaseId)).limit(1);
    return rows[0] ?? null;
  }

  async getByUserAndId(userId: string, knowledgeBaseId: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.userId, userId)));
    return rows[0] ?? null;
  }

  async listByUserId(userId: string) {
    return db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.userId, userId))
      .orderBy(desc(knowledgeBase.updatedAt));
  }

  async findByUserAndSlug(userId: string, slug: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(and(eq(knowledgeBase.userId, userId), eq(knowledgeBase.slug, slug)));
    return rows[0] ?? null;
  }

  async listByTeamId(teamId: string) {
    return db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.teamId, teamId))
      .orderBy(desc(knowledgeBase.updatedAt));
  }

  async getByTeamAndId(teamId: string, knowledgeBaseId: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), eq(knowledgeBase.teamId, teamId)));
    return rows[0] ?? null;
  }

  async findByTeamAndSlug(teamId: string, slug: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(and(eq(knowledgeBase.teamId, teamId), eq(knowledgeBase.slug, slug)));
    return rows[0] ?? null;
  }

  async create(data: KnowledgeBaseInsert) {
    const [row] = await db.insert(knowledgeBase).values(data).returning();
    return row;
  }

  async update(knowledgeBaseId: string, data: Partial<KnowledgeBaseInsert>) {
    await db.update(knowledgeBase).set(data).where(eq(knowledgeBase.id, knowledgeBaseId));
  }

  async delete(knowledgeBaseId: string): Promise<boolean> {
    const result = await db.delete(knowledgeBase)
      .where(eq(knowledgeBase.id, knowledgeBaseId))
      .returning({ id: knowledgeBase.id });
    return result.length > 0;
  }

  async countBindings(knowledgeBaseId: string) {
    const [row] = await db.select({ count: count() }).from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }
}

class PgKnowledgeResourceRepo implements IKnowledgeResourceRepo {
  async getById(resourceId: string) {
    const rows = await db.select().from(knowledgeResource)
      .where(eq(knowledgeResource.id, resourceId)).limit(1);
    return rows[0] ?? null;
  }

  async getByRemoteId(knowledgeBaseId: string, remoteId: string) {
    const rows = await db.select().from(knowledgeResource)
      .where(and(
        eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId),
        eq(knowledgeResource.remoteId, remoteId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByKnowledgeBase(knowledgeBaseId: string, limit?: number) {
    return db.select().from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId))
      .orderBy(desc(knowledgeResource.updatedAt))
      .limit(limit ?? 100);
  }

  async countByKnowledgeBase(knowledgeBaseId: string) {
    const [row] = await db.select({ count: count() }).from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }

  async getStatusSummary(knowledgeBaseId: string) {
    const [summary] = await db.select({
      readyCount: sql<number>`sum(case when ${knowledgeResource.status} = 'ready' then 1 else 0 end)`,
      activeCount: sql<number>`sum(case when ${knowledgeResource.status} in ('pending', 'processing') then 1 else 0 end)`,
      errorCount: sql<number>`sum(case when ${knowledgeResource.status} = 'error' then 1 else 0 end)`,
      totalCount: count(),
    }).from(knowledgeResource).where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
    return {
      readyCount: summary?.readyCount ?? 0,
      activeCount: summary?.activeCount ?? 0,
      errorCount: summary?.errorCount ?? 0,
      totalCount: summary?.totalCount ?? 0,
    };
  }

  async create(data: KnowledgeResourceInsert) {
    const [row] = await db.insert(knowledgeResource).values(data).returning();
    return row;
  }

  async update(resourceId: string, data: Partial<KnowledgeResourceInsert>) {
    await db.update(knowledgeResource).set(data).where(eq(knowledgeResource.id, resourceId));
  }

  async updateByRemoteIds(remoteIds: string[], data: Partial<KnowledgeResourceInsert>) {
    if (remoteIds.length === 0) return;
    await db.update(knowledgeResource).set(data)
      .where(inArray(knowledgeResource.remoteId, remoteIds));
  }

  async delete(resourceId: string): Promise<boolean> {
    const result = await db.delete(knowledgeResource)
      .where(eq(knowledgeResource.id, resourceId))
      .returning({ id: knowledgeResource.id });
    return result.length > 0;
  }

  async deleteByKnowledgeBase(knowledgeBaseId: string) {
    await db.delete(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, knowledgeBaseId));
  }

  async findByRemoteIds(remoteIds: string[]) {
    if (remoteIds.length === 0) return [];
    return db.select().from(knowledgeResource)
      .where(inArray(knowledgeResource.remoteId, remoteIds));
  }
}

class PgAgentKnowledgeBindingRepo implements IAgentKnowledgeBindingRepo {
  async listByAgentName(agentName: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.agentName, agentName))
      .orderBy(agentKnowledgeBinding.priority);
  }

  async listEnabledByAgentName(agentName: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(and(eq(agentKnowledgeBinding.agentName, agentName), eq(agentKnowledgeBinding.enabled, true)));
  }

  async listByAgentConfigId(agentConfigId: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId))
      .orderBy(agentKnowledgeBinding.priority);
  }

  async listEnabledByAgentConfigId(agentConfigId: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)));
  }

  async listByKnowledgeBaseId(knowledgeBaseId: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
  }

  async countByKnowledgeBaseId(knowledgeBaseId: string) {
    const [row] = await db.select({ count: count() }).from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
    return row?.count ?? 0;
  }

  async countByKnowledgeBaseIds(knowledgeBaseIds: string[]) {
    if (knowledgeBaseIds.length === 0) return {};
    const rows = await db.select().from(agentKnowledgeBinding)
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
    const [row] = await db.insert(agentKnowledgeBinding).values(data).returning();
    return row;
  }

  async createMany(dataList: AgentKnowledgeBindingInsert[]) {
    if (dataList.length === 0) return;
    await db.insert(agentKnowledgeBinding).values(dataList);
  }

  async deleteByAgentName(agentName: string) {
    await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.agentName, agentName));
  }

  async deleteByAgentConfigId(agentConfigId: string) {
    await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId));
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string) {
    await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBaseId));
  }

  async listJoinedWithKnowledgeBase(agentName: string) {
    return db.select({
      id: agentKnowledgeBinding.id,
      agentName: agentKnowledgeBinding.agentName,
      agentConfigId: agentKnowledgeBinding.agentConfigId,
      knowledgeBaseId: agentKnowledgeBinding.knowledgeBaseId,
      priority: agentKnowledgeBinding.priority,
      enabled: agentKnowledgeBinding.enabled,
      createdAt: agentKnowledgeBinding.createdAt,
      updatedAt: agentKnowledgeBinding.updatedAt,
      kbId: knowledgeBase.id,
      kbRemoteId: knowledgeBase.remoteId,
      kbRemoteAccountId: knowledgeBase.remoteAccountId,
      kbRemoteUserId: knowledgeBase.remoteUserId,
      kbUserId: knowledgeBase.userId,
    })
      .from(agentKnowledgeBinding)
      .innerJoin(knowledgeBase, eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBase.id))
      .where(and(eq(agentKnowledgeBinding.agentName, agentName), eq(agentKnowledgeBinding.enabled, true)));
  }

  async listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string) {
    return db.select({
      id: agentKnowledgeBinding.id,
      agentName: agentKnowledgeBinding.agentName,
      agentConfigId: agentKnowledgeBinding.agentConfigId,
      knowledgeBaseId: agentKnowledgeBinding.knowledgeBaseId,
      priority: agentKnowledgeBinding.priority,
      enabled: agentKnowledgeBinding.enabled,
      createdAt: agentKnowledgeBinding.createdAt,
      updatedAt: agentKnowledgeBinding.updatedAt,
      kbId: knowledgeBase.id,
      kbRemoteId: knowledgeBase.remoteId,
      kbRemoteAccountId: knowledgeBase.remoteAccountId,
      kbRemoteUserId: knowledgeBase.remoteUserId,
      kbUserId: knowledgeBase.userId,
    })
      .from(agentKnowledgeBinding)
      .innerJoin(knowledgeBase, eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBase.id))
      .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)));
  }

  async getResourceWithKnowledgeBase(resourceId: string) {
    const rows = await db.select({
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
      kbUserId: knowledgeBase.userId,
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
      kbUserId: row.kbUserId,
      kbRemoteAccountId: row.kbRemoteAccountId,
      kbRemoteUserId: row.kbRemoteUserId,
    };
  }
}

export const knowledgeBaseRepo = new PgKnowledgeBaseRepo();
export const knowledgeResourceRepo = new PgKnowledgeResourceRepo();
export const agentKnowledgeBindingRepo = new PgAgentKnowledgeBindingRepo();
