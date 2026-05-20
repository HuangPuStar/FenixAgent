import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { scheduledTask, taskExecutionLog } from "../db/schema";

/** ScheduledTask 行类型 */
export type ScheduledTaskRow = typeof scheduledTask.$inferSelect;
export type ScheduledTaskInsert = typeof scheduledTask.$inferInsert;

/** TaskExecutionLog 行类型 */
export type TaskExecutionLogRow = typeof taskExecutionLog.$inferSelect;
export type TaskExecutionLogInsert = typeof taskExecutionLog.$inferInsert;

/** ScheduledTask 仓储接口 */
export interface IScheduledTaskRepo {
  listByUser(userId: string): Promise<ScheduledTaskRow[]>;
  getById(taskId: string): Promise<ScheduledTaskRow | null>;
  getByUserAndId(userId: string, taskId: string): Promise<ScheduledTaskRow | null>;
  create(data: ScheduledTaskInsert): Promise<ScheduledTaskRow>;
  update(taskId: string, data: Partial<ScheduledTaskInsert>): Promise<ScheduledTaskRow | null>;
  delete(taskId: string): Promise<boolean>;
  deleteByUserAndId(userId: string, taskId: string): Promise<boolean>;
  listEnabled(): Promise<ScheduledTaskRow[]>;
  existsByUserAndId(userId: string, taskId: string): Promise<boolean>;
  listByOrganization(organizationId: string): Promise<ScheduledTaskRow[]>;
  getByOrgAndId(organizationId: string, taskId: string): Promise<ScheduledTaskRow | null>;
  deleteByOrgAndId(organizationId: string, taskId: string): Promise<boolean>;
  existsByOrgAndId(organizationId: string, taskId: string): Promise<boolean>;
}

/** TaskExecutionLog 仓储接口 */
export interface ITaskExecutionLogRepo {
  listByTask(taskId: string): Promise<TaskExecutionLogRow[]>;
  listByTaskPaged(
    taskId: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: TaskExecutionLogRow[]; total: number }>;
  getLatest(taskId: string): Promise<TaskExecutionLogRow | null>;
  getById(logId: string): Promise<TaskExecutionLogRow | null>;
  create(data: TaskExecutionLogInsert): Promise<TaskExecutionLogRow>;
  update(logId: string, data: Partial<TaskExecutionLogInsert>): Promise<void>;
  deleteByTask(taskId: string): Promise<void>;
}

class PgScheduledTaskRepo implements IScheduledTaskRepo {
  async listByUser(userId: string) {
    return db
      .select()
      .from(scheduledTask)
      .where(eq(scheduledTask.userId, userId))
      .orderBy(desc(scheduledTask.createdAt));
  }

  async getById(taskId: string) {
    const rows = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId)).limit(1);
    return rows[0] ?? null;
  }

  async getByUserAndId(userId: string, taskId: string) {
    const rows = await db
      .select()
      .from(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: ScheduledTaskInsert) {
    const [row] = await db.insert(scheduledTask).values(data).returning();
    return row;
  }

  async update(taskId: string, data: Partial<ScheduledTaskInsert>) {
    const rows = await db.update(scheduledTask).set(data).where(eq(scheduledTask.id, taskId)).returning();
    return rows[0] ?? null;
  }

  async delete(taskId: string): Promise<boolean> {
    const result = await db
      .delete(scheduledTask)
      .where(eq(scheduledTask.id, taskId))
      .returning({ id: scheduledTask.id });
    return result.length > 0;
  }

  async deleteByUserAndId(userId: string, taskId: string): Promise<boolean> {
    const result = await db
      .delete(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)))
      .returning({ id: scheduledTask.id });
    return result.length > 0;
  }

  async listEnabled() {
    return db.select().from(scheduledTask).where(eq(scheduledTask.enabled, true));
  }

  async existsByUserAndId(userId: string, taskId: string): Promise<boolean> {
    const rows = await db
      .select({ id: scheduledTask.id })
      .from(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
    return rows.length > 0;
  }

  async listByOrganization(organizationId: string) {
    return db
      .select()
      .from(scheduledTask)
      .where(eq(scheduledTask.organizationId, organizationId))
      .orderBy(desc(scheduledTask.createdAt));
  }

  async getByOrgAndId(organizationId: string, taskId: string) {
    const rows = await db
      .select()
      .from(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.organizationId, organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteByOrgAndId(organizationId: string, taskId: string): Promise<boolean> {
    const result = await db
      .delete(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.organizationId, organizationId)))
      .returning({ id: scheduledTask.id });
    return result.length > 0;
  }

  async existsByOrgAndId(organizationId: string, taskId: string): Promise<boolean> {
    const rows = await db
      .select({ id: scheduledTask.id })
      .from(scheduledTask)
      .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.organizationId, organizationId)));
    return rows.length > 0;
  }
}

class PgTaskExecutionLogRepo implements ITaskExecutionLogRepo {
  async listByTask(taskId: string) {
    return db
      .select()
      .from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId))
      .orderBy(desc(taskExecutionLog.createdAt));
  }

  async listByTaskPaged(taskId: string, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId));
    const rows = await db
      .select()
      .from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId))
      .orderBy(desc(taskExecutionLog.createdAt))
      .limit(pageSize)
      .offset(offset);
    return { rows, total };
  }

  async getLatest(taskId: string) {
    const rows = await db
      .select()
      .from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId))
      .orderBy(desc(taskExecutionLog.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async getById(logId: string) {
    const rows = await db.select().from(taskExecutionLog).where(eq(taskExecutionLog.id, logId)).limit(1);
    return rows[0] ?? null;
  }

  async create(data: TaskExecutionLogInsert) {
    const [row] = await db.insert(taskExecutionLog).values(data).returning();
    return row;
  }

  async update(logId: string, data: Partial<TaskExecutionLogInsert>) {
    await db.update(taskExecutionLog).set(data).where(eq(taskExecutionLog.id, logId));
  }

  async deleteByTask(taskId: string) {
    await db.delete(taskExecutionLog).where(eq(taskExecutionLog.taskId, taskId));
  }
}

export const scheduledTaskRepo = new PgScheduledTaskRepo();
export const taskExecutionLogRepo = new PgTaskExecutionLogRepo();
