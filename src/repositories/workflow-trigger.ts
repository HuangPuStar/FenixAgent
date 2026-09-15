import { desc, eq } from "drizzle-orm";
import { db } from "../../apps/server/src/db";
import { workflowTrigger } from "../../apps/server/src/db/schema";

export type WorkflowTriggerRow = typeof workflowTrigger.$inferSelect;
export type WorkflowTriggerInsert = typeof workflowTrigger.$inferInsert;

export interface IWorkflowTriggerRepo {
  getByHash(publicHash: string): Promise<WorkflowTriggerRow | null>;
  getById(id: string): Promise<WorkflowTriggerRow | null>;
  create(data: WorkflowTriggerInsert): Promise<WorkflowTriggerRow>;
  delete(id: string): Promise<boolean>;
  update(id: string, data: Partial<WorkflowTriggerInsert>): Promise<void>;
  listByWorkflow(workflowId: string): Promise<WorkflowTriggerRow[]>;
  listByOrg(organizationId: string): Promise<WorkflowTriggerRow[]>;
}

class PgWorkflowTriggerRepo implements IWorkflowTriggerRepo {
  async getByHash(publicHash: string): Promise<WorkflowTriggerRow | null> {
    const [row] = await db.select().from(workflowTrigger).where(eq(workflowTrigger.publicHash, publicHash)).limit(1);
    return row ?? null;
  }

  async getById(id: string): Promise<WorkflowTriggerRow | null> {
    const [row] = await db.select().from(workflowTrigger).where(eq(workflowTrigger.id, id)).limit(1);
    return row ?? null;
  }

  async create(data: WorkflowTriggerInsert): Promise<WorkflowTriggerRow> {
    const [row] = await db.insert(workflowTrigger).values(data).returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(workflowTrigger)
      .where(eq(workflowTrigger.id, id))
      .returning({ id: workflowTrigger.id });
    return result.length > 0;
  }

  async update(id: string, data: Partial<WorkflowTriggerInsert>): Promise<void> {
    await db.update(workflowTrigger).set(data).where(eq(workflowTrigger.id, id));
  }

  async listByWorkflow(workflowId: string): Promise<WorkflowTriggerRow[]> {
    return db
      .select()
      .from(workflowTrigger)
      .where(eq(workflowTrigger.workflowId, workflowId))
      .orderBy(desc(workflowTrigger.createdAt));
  }

  async listByOrg(organizationId: string): Promise<WorkflowTriggerRow[]> {
    return db
      .select()
      .from(workflowTrigger)
      .where(eq(workflowTrigger.organizationId, organizationId))
      .orderBy(desc(workflowTrigger.createdAt));
  }
}

export const workflowTriggerRepo = new PgWorkflowTriggerRepo();
