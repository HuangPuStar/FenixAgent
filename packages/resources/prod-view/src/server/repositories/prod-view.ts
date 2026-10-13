import { type ProdViewRow, prodView } from "@fenix/resource-prod-view/db";
import { and, eq } from "drizzle-orm";
import { getProdViewDatabase } from "../db";

/** ProdView 数据访问层接口 — 封装 ProdView 表的 CRUD 操作 */
export interface IProdViewRepository {
  /** 创建 ProdView 记录 */
  create(params: {
    organizationId: string;
    name: string;
    description?: string;
    agentId: string;
    modulesConfig?: Record<string, unknown>;
    createdBy: string;
  }): Promise<ProdViewRow>;
  /** 根据组织和 ID 获取单条记录 */
  getById(orgId: string, id: string): Promise<ProdViewRow | undefined>;
  /** 列出组织下的 ProdView，支持 agentId 和 enabled 过滤 */
  listByOrg(orgId: string, filters?: { agentId?: string; enabled?: boolean }): Promise<ProdViewRow[]>;
  /** 更新 ProdView 记录的部分字段 */
  update(
    orgId: string,
    id: string,
    params: {
      name?: string;
      description?: string;
      modulesConfig?: Record<string, unknown>;
      enabled?: boolean;
    },
  ): Promise<ProdViewRow | undefined>;
  /** 删除 ProdView 记录，返回是否删除成功 */
  delete(orgId: string, id: string): Promise<boolean>;
}

/**
 * PostgreSQL 实现：通过 Drizzle ORM 操作 prodView 表。
 *
 * DB 句柄在每个方法内按需取用（`getProdViewDatabase()`）而不是在构造期缓存：模块图可能在宿主
 * `initializeApplicationInfrastructure()` 之前求值，构造期取句柄会直接抛错；句柄本身是宿主单例，
 * 逐次取用没有额外成本。
 */
class PgProdViewRepository implements IProdViewRepository {
  async create(params: {
    organizationId: string;
    name: string;
    description?: string;
    agentId: string;
    modulesConfig?: Record<string, unknown>;
    createdBy: string;
  }) {
    const [row] = await getProdViewDatabase()
      .insert(prodView)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        description: params.description ?? null,
        agentId: params.agentId,
        modulesConfig: params.modulesConfig ?? {},
        createdBy: params.createdBy,
      })
      .returning();
    return row;
  }

  async getById(orgId: string, id: string) {
    const rows = await getProdViewDatabase()
      .select()
      .from(prodView)
      .where(and(eq(prodView.organizationId, orgId), eq(prodView.id, id)))
      .limit(1);
    return rows[0] ?? undefined;
  }

  async listByOrg(orgId: string, filters?: { agentId?: string; enabled?: boolean }) {
    const conditions = [eq(prodView.organizationId, orgId)];
    if (filters?.agentId) conditions.push(eq(prodView.agentId, filters.agentId));
    if (filters?.enabled !== undefined) conditions.push(eq(prodView.enabled, filters.enabled));
    return getProdViewDatabase()
      .select()
      .from(prodView)
      .where(and(...conditions))
      .orderBy(prodView.createdAt);
  }

  async update(
    orgId: string,
    id: string,
    params: {
      name?: string;
      description?: string;
      modulesConfig?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (params.name !== undefined) setData.name = params.name;
    if (params.description !== undefined) setData.description = params.description;
    if (params.modulesConfig !== undefined) setData.modulesConfig = params.modulesConfig;
    if (params.enabled !== undefined) setData.enabled = params.enabled;
    const [row] = await getProdViewDatabase()
      .update(prodView)
      .set(setData)
      .where(and(eq(prodView.organizationId, orgId), eq(prodView.id, id)))
      .returning();
    return row ?? undefined;
  }

  async delete(orgId: string, id: string) {
    const [deleted] = await getProdViewDatabase()
      .delete(prodView)
      .where(and(eq(prodView.organizationId, orgId), eq(prodView.id, id)))
      .returning({ id: prodView.id });
    return deleted !== undefined;
  }
}

export const prodViewRepo: IProdViewRepository = new PgProdViewRepository();
