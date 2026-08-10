import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { opensandboxServer, sandboxPool } from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import { SchedulerLock } from "./scheduler-lock";

export class AllocationError extends Error {
  readonly code = "NO_CAPACITY";
}

export class AllocationService {
  private readonly bindings: BindingRepository;
  private readonly lock: SchedulerLock;

  constructor(
    private readonly db: ClusterDatabase,
    sqlite: Database,
  ) {
    this.bindings = new BindingRepository(db);
    this.lock = new SchedulerLock(sqlite);
  }

  allocate(poolId: string, sandboxId: string) {
    return this.lock.run(() => {
      const existing = this.bindings.findBySandboxId(sandboxId);
      if (existing) {
        if (existing.poolId !== poolId) throw new AllocationError("sandbox is already allocated in another pool");
        return this.response(existing.sandboxId, existing.poolId, existing.serverId);
      }

      if (!this.db.select().from(sandboxPool).where(eq(sandboxPool.id, poolId)).get())
        throw new Error("pool not found");
      const servers = this.db
        .select()
        .from(opensandboxServer)
        .where(eq(opensandboxServer.poolId, poolId))
        .all()
        .filter((server) => server.status === "active" && server.healthStatus === "healthy")
        .map((server) => ({ server, current: this.bindings.countByServer(server.id) }))
        .filter(({ server, current }) => current < server.maxSandboxes)
        .sort((left, right) => left.current / left.server.maxSandboxes - right.current / right.server.maxSandboxes);

      const selected = servers[0]?.server;
      if (!selected) throw new AllocationError("pool has no available OpenSandbox Server");
      const binding = this.bindings.insert({ sandboxId, poolId, serverId: selected.id, createdAt: Date.now() });
      return this.response(binding.sandboxId, binding.poolId, binding.serverId);
    });
  }

  find(sandboxId: string) {
    const binding = this.bindings.findBySandboxId(sandboxId);
    return binding ? this.response(binding.sandboxId, binding.poolId, binding.serverId) : undefined;
  }

  release(sandboxId: string) {
    return this.bindings.deleteBySandboxId(sandboxId);
  }

  private response(sandboxId: string, poolId: string, serverId: string) {
    return {
      sandbox_id: sandboxId,
      pool_id: poolId,
      server_id: serverId,
      proxy_url: `/api/v1/sandboxes/${sandboxId}/proxy`,
    };
  }
}
