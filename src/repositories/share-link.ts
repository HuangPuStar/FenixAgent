import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { shareEventSnapshot, shareLink } from "../db/schema";

/** ShareLink 仓储接口 — PostgreSQL 持久化 */
export interface IShareLinkRepo {
  create(
    organizationId: string,
    sessionId: string,
    environmentId: string,
    mode: string,
    expiresAt: Date | null,
    createdBy: string,
  ): Promise<{
    id: string;
    organizationId: string;
    sessionId: string;
    environmentId: string;
    token: string;
    mode: string;
    expiresAt: Date | null;
    createdBy: string;
    accessCount: number;
    lastAccessedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  getById(organizationId: string, id: string): Promise<typeof shareLink.$inferSelect | undefined>;
  getByToken(token: string): Promise<typeof shareLink.$inferSelect | undefined>;
  listBySession(organizationId: string, sessionId: string): Promise<(typeof shareLink.$inferSelect)[]>;
  listByOrganizationId(organizationId: string): Promise<(typeof shareLink.$inferSelect)[]>;
  delete(organizationId: string, id: string): Promise<boolean>;
  updateAccess(organizationId: string, id: string): Promise<void>;
  saveEventSnapshot(shareLinkId: string, events: unknown): Promise<void>;
  getEventSnapshot(shareLinkId: string): Promise<unknown | null>;
}

class PgShareLinkRepo implements IShareLinkRepo {
  async create(
    organizationId: string,
    sessionId: string,
    environmentId: string,
    mode: string,
    expiresAt: Date | null,
    createdBy: string,
  ) {
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const now = new Date();
    const [row] = await db
      .insert(shareLink)
      .values({
        organizationId,
        sessionId,
        environmentId,
        token,
        mode: mode as "readonly" | "writable",
        expiresAt,
        createdBy,
        accessCount: 0,
        lastAccessedAt: null,
      })
      .returning();
    return {
      id: row.id,
      organizationId,
      sessionId,
      environmentId,
      token,
      mode,
      expiresAt,
      createdBy,
      accessCount: 0,
      lastAccessedAt: null as Date | null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getById(organizationId: string, id: string) {
    const rows = await db
      .select()
      .from(shareLink)
      .where(and(eq(shareLink.organizationId, organizationId), eq(shareLink.id, id)))
      .limit(1);
    return rows[0] ?? undefined;
  }

  async getByToken(token: string) {
    const rows = await db.select().from(shareLink).where(eq(shareLink.token, token)).limit(1);
    return rows[0] ?? undefined;
  }

  async listBySession(organizationId: string, sessionId: string) {
    return db
      .select()
      .from(shareLink)
      .where(and(eq(shareLink.organizationId, organizationId), eq(shareLink.sessionId, sessionId)));
  }

  async listByOrganizationId(organizationId: string) {
    return db.select().from(shareLink).where(eq(shareLink.organizationId, organizationId));
  }

  async delete(organizationId: string, id: string): Promise<boolean> {
    const result = await db.delete(shareLink).where(and(eq(shareLink.organizationId, organizationId), eq(shareLink.id, id)));
    return (result as any).count > 0;
  }

  async updateAccess(organizationId: string, id: string): Promise<void> {
    await db
      .update(shareLink)
      .set({
        accessCount: sql`${shareLink.accessCount} + 1`,
        lastAccessedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(shareLink.organizationId, organizationId), eq(shareLink.id, id)));
  }

  async saveEventSnapshot(shareLinkId: string, events: unknown): Promise<void> {
    await db.delete(shareEventSnapshot).where(eq(shareEventSnapshot.shareLinkId, shareLinkId));
    await db.insert(shareEventSnapshot).values({ shareLinkId, events });
  }

  async getEventSnapshot(shareLinkId: string): Promise<unknown | null> {
    const rows = await db
      .select({ events: shareEventSnapshot.events })
      .from(shareEventSnapshot)
      .where(eq(shareEventSnapshot.shareLinkId, shareLinkId))
      .limit(1);
    return rows.length > 0 ? rows[0].events : null;
  }
}

export const shareLinkRepo: IShareLinkRepo = new PgShareLinkRepo();
