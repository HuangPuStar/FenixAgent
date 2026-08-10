import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type NewSandboxPool, sandboxPool } from "../db/schema";

export class PoolRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findById(id: string) {
    return this.db.select().from(sandboxPool).where(eq(sandboxPool.id, id)).get();
  }

  list() {
    return this.db.select().from(sandboxPool).all();
  }

  insert(value: NewSandboxPool) {
    return this.db.insert(sandboxPool).values(value).returning().get();
  }

  update(id: string, value: Partial<NewSandboxPool>) {
    return this.db.update(sandboxPool).set(value).where(eq(sandboxPool.id, id)).returning().get();
  }

  delete(id: string) {
    return this.db.delete(sandboxPool).where(eq(sandboxPool.id, id)).returning().get();
  }
}
