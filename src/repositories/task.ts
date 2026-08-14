import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { taskExecutionLog } from "../db/schema";

/** TaskExecutionLog 行类型 */
export type TaskExecutionLogRow = typeof taskExecutionLog.$inferSelect;
export type TaskExecutionLogInsert = typeof taskExecutionLog.$inferInsert;

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

export const taskExecutionLogRepo = new PgTaskExecutionLogRepo();
