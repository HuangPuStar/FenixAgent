import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../db";
import type { ScheduledTaskV2Insert, ScheduledTaskV2Row } from "../db/schema";
import { scheduledTaskV2 } from "../db/schema";

export type { ScheduledTaskV2Insert, ScheduledTaskV2Row };

// ── ScheduledTaskV2 仓储 ──

export interface IScheduledTaskV2Repo {
  listByOrganization(organizationId: string): Promise<ScheduledTaskV2Row[]>;
  listByOrganizationPaged(
    organizationId: string,
    page: number,
    pageSize: number,
    opts?: { keyword?: string; type?: string; agentId?: string },
  ): Promise<{ rows: ScheduledTaskV2Row[]; total: number }>;
  getByOrgAndId(organizationId: string, taskId: string): Promise<ScheduledTaskV2Row | null>;
  getById(taskId: string): Promise<ScheduledTaskV2Row | null>;
  create(data: ScheduledTaskV2Insert): Promise<ScheduledTaskV2Row>;
  update(taskId: string, data: Partial<ScheduledTaskV2Insert>): Promise<ScheduledTaskV2Row | null>;
  deleteByOrgAndId(organizationId: string, taskId: string): Promise<boolean>;
  listEnabled(): Promise<ScheduledTaskV2Row[]>;
}

class PgScheduledTaskV2Repo implements IScheduledTaskV2Repo {
  async listByOrganization(organizationId: string) {
    return db
      .select()
      .from(scheduledTaskV2)
      .where(eq(scheduledTaskV2.organizationId, organizationId))
      .orderBy(desc(scheduledTaskV2.createdAt));
  }

  async listByOrganizationPaged(
    organizationId: string,
    page: number,
    pageSize: number,
    opts?: { keyword?: string; type?: string; agentId?: string },
  ) {
    const where = [eq(scheduledTaskV2.organizationId, organizationId)];
    if (opts?.keyword) where.push(ilike(scheduledTaskV2.name, `%${opts.keyword}%`));
    if (opts?.type) where.push(eq(scheduledTaskV2.type, opts.type));
    if (opts?.agentId) where.push(eq(scheduledTaskV2.agentId, opts.agentId));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(scheduledTaskV2)
      .where(and(...where));
    const rows = await db
      .select()
      .from(scheduledTaskV2)
      .where(and(...where))
      .orderBy(desc(scheduledTaskV2.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { rows, total };
  }

  async getByOrgAndId(organizationId: string, taskId: string) {
    const rows = await db
      .select()
      .from(scheduledTaskV2)
      .where(and(eq(scheduledTaskV2.id, taskId), eq(scheduledTaskV2.organizationId, organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getById(taskId: string) {
    const rows = await db.select().from(scheduledTaskV2).where(eq(scheduledTaskV2.id, taskId)).limit(1);
    return rows[0] ?? null;
  }

  async create(data: ScheduledTaskV2Insert) {
    const [row] = await db.insert(scheduledTaskV2).values(data).returning();
    return row;
  }

  async update(taskId: string, data: Partial<ScheduledTaskV2Insert>) {
    const rows = await db.update(scheduledTaskV2).set(data).where(eq(scheduledTaskV2.id, taskId)).returning();
    return rows[0] ?? null;
  }

  async deleteByOrgAndId(organizationId: string, taskId: string): Promise<boolean> {
    const result = await db
      .delete(scheduledTaskV2)
      .where(and(eq(scheduledTaskV2.id, taskId), eq(scheduledTaskV2.organizationId, organizationId)))
      .returning({ id: scheduledTaskV2.id });
    return result.length > 0;
  }

  async listEnabled() {
    return db.select().from(scheduledTaskV2).where(eq(scheduledTaskV2.enabled, true));
  }
}

export const scheduledTaskV2Repo = new PgScheduledTaskV2Repo();
