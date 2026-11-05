import { and, count, eq, notInArray } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type NewSandboxBinding, sandboxBinding } from "../db/schema";

export class BindingRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findBySandboxId(sandboxId: string) {
    return this.db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, sandboxId)).get();
  }
  /** Retained terminal bindings still protect their referenced server from deletion. */
  hasServerReferences(serverId: string): boolean {
    return (
      this.db
        .select({ id: sandboxBinding.sandboxId })
        .from(sandboxBinding)
        .where(eq(sandboxBinding.serverId, serverId))
        .limit(1)
        .get() !== undefined
    );
  }
  /** Historical references protect pool deletion independently of live capacity accounting. */
  hasPoolReferences(poolId: string): boolean {
    return (
      this.db
        .select({ id: sandboxBinding.sandboxId })
        .from(sandboxBinding)
        .where(eq(sandboxBinding.poolId, poolId))
        .limit(1)
        .get() !== undefined
    );
  }

  countByPool(poolId: string) {
    return (
      this.db
        .select({ count: count() })
        .from(sandboxBinding)
        .where(
          and(eq(sandboxBinding.poolId, poolId), notInArray(sandboxBinding.state, ["released", "expired", "failed"])),
        )
        .get()?.count ?? 0
    );
  }

  countByServer(serverId: string) {
    return (
      this.db
        .select({ count: count() })
        .from(sandboxBinding)
        .where(
          and(
            eq(sandboxBinding.serverId, serverId),
            notInArray(sandboxBinding.state, ["released", "expired", "failed"]),
          ),
        )
        .get()?.count ?? 0
    );
  }

  insert(value: NewSandboxBinding) {
    return this.db.insert(sandboxBinding).values(value).returning().get();
  }

  deleteBySandboxId(sandboxId: string) {
    return this.db.delete(sandboxBinding).where(eq(sandboxBinding.sandboxId, sandboxId)).returning().get();
  }
}
