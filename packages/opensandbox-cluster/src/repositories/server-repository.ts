import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type NewOpenSandboxServer, opensandboxServer } from "../db/schema";

export class ServerRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findById(id: string) {
    return this.db.select().from(opensandboxServer).where(eq(opensandboxServer.id, id)).get();
  }

  listByPool(poolId: string) {
    return this.db.select().from(opensandboxServer).where(eq(opensandboxServer.poolId, poolId)).all();
  }

  listAll() {
    return this.db.select().from(opensandboxServer).all();
  }

  insert(value: NewOpenSandboxServer) {
    return this.db.insert(opensandboxServer).values(value).returning().get();
  }

  update(id: string, value: Partial<NewOpenSandboxServer>) {
    return this.db.update(opensandboxServer).set(value).where(eq(opensandboxServer.id, id)).returning().get();
  }

  delete(id: string) {
    return this.db.delete(opensandboxServer).where(eq(opensandboxServer.id, id)).returning().get();
  }
}
