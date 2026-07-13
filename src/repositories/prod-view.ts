import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { type ProdViewRow, prodView } from "../db/schema";

/** ProdView 数据访问层接口 — 封装 ProdView 表的 CRUD 操作 */
export interface IProdViewRepository {
  /** 创建 ProdView 记录 */
  create(params: {
    organizationId: string;
    name: string;
    description?: string;
    agentId: string;
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

/** PostgreSQL 实现：通过 Drizzle ORM 操作 prodView 表 */
class PgProdViewRepository implements IProdViewRepository {
  async create(params: {
    organizationId: string;
    name: string;
    description?: string;
    agentId: string;
    createdBy: string;
  }) {
    const [row] = await db
      .insert(prodView)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        description: params.description ?? null,
        agentId: params.agentId,
        createdBy: params.createdBy,
      })
      .returning();
    return row;
  }

  async getById(orgId: string, id: string) {
    const rows = await db
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
    return db
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
    const [row] = await db
      .update(prodView)
      .set(setData)
      .where(and(eq(prodView.organizationId, orgId), eq(prodView.id, id)))
      .returning();
    return row ?? undefined;
  }

  async delete(orgId: string, id: string) {
    const result = await db.delete(prodView).where(and(eq(prodView.organizationId, orgId), eq(prodView.id, id)));
    return (result as unknown as { count: number }).count > 0;
  }
}

export const prodViewRepo: IProdViewRepository = new PgProdViewRepository();
