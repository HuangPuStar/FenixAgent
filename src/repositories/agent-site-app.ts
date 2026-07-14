import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agentSiteApp } from "../db/schema";

export type AgentSiteAppRow = typeof agentSiteApp.$inferSelect;
export type AgentSiteAppInsert = typeof agentSiteApp.$inferInsert;

export type Visibility = "private" | "org" | "authenticated" | "public";

export interface CreateAppParams {
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description?: string;
  platformToken: string;
  platformTokenId: string;
  visibility?: Visibility;
  /** App 类型，默认 pocketbase。custom 类型支持 deploy 接口 */
  appType?: "pocketbase" | "custom";
  /** 创建此 site 的 agent_config id（用于开发/业务智能体分权） */
  createdByAgentConfigId?: string | null;
}

class AgentSiteAppRepo {
  async create(params: CreateAppParams): Promise<AgentSiteAppRow> {
    const [row] = await db
      .insert(agentSiteApp)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        remoteAppId: params.remoteAppId,
        name: params.name,
        description: params.description ?? null,
        platformToken: params.platformToken,
        platformTokenId: params.platformTokenId,
        visibility: params.visibility ?? "private",
        appType: params.appType ?? "pocketbase",
        createdByAgentConfigId: params.createdByAgentConfigId ?? null,
      })
      .returning();
    return row;
  }

  async listByOrg(organizationId: string): Promise<AgentSiteAppRow[]> {
    return db
      .select()
      .from(agentSiteApp)
      .where(eq(agentSiteApp.organizationId, organizationId))
      .orderBy(agentSiteApp.createdAt);
  }

  /**
   * 按 id 批量查询，并过滤组织。
   * 用于 agent ↔ site 绑定关系展开：从绑定表拿 siteAppId 后，由此方法补详情。
   * 组织过滤放在这里是为了防御性兜底——绑定表本身只校验了 agentConfigId
   * 所属组织，siteApp 的组织一致性在这里二次确认。
   */
  async listByIds(ids: string[], organizationId: string): Promise<AgentSiteAppRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(agentSiteApp)
      .where(and(inArray(agentSiteApp.id, ids), eq(agentSiteApp.organizationId, organizationId)));
  }

  async getById(id: string): Promise<AgentSiteAppRow | undefined> {
    const rows = await db.select().from(agentSiteApp).where(eq(agentSiteApp.id, id)).limit(1);
    return rows[0];
  }

  async getByRemoteAppId(remoteAppId: string): Promise<AgentSiteAppRow | undefined> {
    const rows = await db.select().from(agentSiteApp).where(eq(agentSiteApp.remoteAppId, remoteAppId)).limit(1);
    return rows[0];
  }

  async update(
    id: string,
    data: Partial<
      Pick<
        AgentSiteAppRow,
        | "name"
        | "description"
        | "visibility"
        | "platformToken"
        | "platformTokenId"
        | "entryFile"
        | "activeSlot"
        | "deployedAt"
      >
    >,
  ): Promise<AgentSiteAppRow | undefined> {
    const [row] = await db
      .update(agentSiteApp)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentSiteApp.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(agentSiteApp).where(eq(agentSiteApp.id, id));
    return (result as unknown as { count: number }).count > 0;
  }
}

export const agentSiteAppRepo = new AgentSiteAppRepo();
