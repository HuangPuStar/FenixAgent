import { eq } from "drizzle-orm";
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
    data: Partial<Pick<AgentSiteAppRow, "name" | "description" | "visibility" | "platformToken" | "platformTokenId">>,
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
