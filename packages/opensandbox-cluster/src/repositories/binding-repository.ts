import { count, eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type NewSandboxBinding, sandboxBinding } from "../db/schema";

export class BindingRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findBySandboxId(sandboxId: string) {
    return this.db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, sandboxId)).get();
  }

  countByPool(poolId: string) {
    return (
      this.db.select({ count: count() }).from(sandboxBinding).where(eq(sandboxBinding.poolId, poolId)).get()?.count ?? 0
    );
  }

  countByServer(serverId: string) {
    return (
      this.db.select({ count: count() }).from(sandboxBinding).where(eq(sandboxBinding.serverId, serverId)).get()
        ?.count ?? 0
    );
  }

  insert(value: NewSandboxBinding) {
    return this.db.insert(sandboxBinding).values(value).returning().get();
  }

  deleteBySandboxId(sandboxId: string) {
    return this.db.delete(sandboxBinding).where(eq(sandboxBinding.sandboxId, sandboxId)).returning().get();
  }
}
