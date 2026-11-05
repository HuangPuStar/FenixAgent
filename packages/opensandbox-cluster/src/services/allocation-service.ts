import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { opensandboxServer, opensandboxTunnelConnection, sandboxBinding, sandboxPool } from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import type { ClusterConfig } from "../types";
import { decimalSum, dimensions, sumResources } from "./resource-accounting";
import { allocated, capacity, LifecycleError } from "./resource-allocation";
import type { SandboxLifecycleService } from "./sandbox-lifecycle-service";
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
    private readonly config?: ClusterConfig,
    private readonly lifecycle?: SandboxLifecycleService,
  ) {
    this.bindings = new BindingRepository(db);
    this.lock = new SchedulerLock(sqlite);
  }

  /** Read node budgets and retained nonterminal reservations. */
  serverResources(id: string) {
    const server = this.db.select().from(opensandboxServer).where(eq(opensandboxServer.id, id)).get();
    if (!server) throw new LifecycleError("NOT_FOUND", 404, "server not found");
    const budget = capacity(server),
      used = allocated(this.db, id);
    return {
      server_id: id,
      capacity: budget,
      allocated: used,
      pending: sumResources(
        this.db
          .select()
          .from(sandboxBinding)
          .where(eq(sandboxBinding.serverId, id))
          .all()
          .filter(
            (row) => row.allocationMode === "resources" && ["creating", "uncertain", "releasing"].includes(row.state),
          )
          .map((row) => ({ cpu: row.cpu!, memoryMb: row.memoryMb!, diskGb: row.diskGb!, gpuCount: row.gpuCount! })),
      ),
      remaining: Object.fromEntries(
        dimensions.map((k) => [k, budget[k] === null ? null : decimalSum([budget[k], -used[k]])]),
      ),
    };
  }
  /** Aggregate per-node views without using pool totals for admission. */
  poolResources(poolId: string) {
    if (!this.db.select().from(sandboxPool).where(eq(sandboxPool.id, poolId)).get())
      throw new LifecycleError("NOT_FOUND", 404, "pool not found");
    return {
      pool_id: poolId,
      servers: this.db
        .select()
        .from(opensandboxServer)
        .where(eq(opensandboxServer.poolId, poolId))
        .all()
        .map((server) => this.serverResources(server.id)),
    };
  }
  allocate(poolId: string, sandboxId: string) {
    return this.lock.run(() => {
      const existing = this.bindings.findBySandboxId(sandboxId);
      if (existing) {
        if (existing.poolId !== poolId) throw new AllocationError("sandbox is already allocated in another pool");
        return this.response(existing.sandboxId, existing.poolId, existing.serverId);
      }

      const pool = this.db.select().from(sandboxPool).where(eq(sandboxPool.id, poolId)).get();
      if (!pool) throw new Error("pool not found");
      if (pool.schedulingMode !== "count") throw new AllocationError("resource pools require v2 managed create");
      const connections = new Map(
        this.db
          .select()
          .from(opensandboxTunnelConnection)
          .all()
          .map((connection) => [connection.serverId, connection]),
      );
      const now = Date.now();
      const servers = this.db
        .select()
        .from(opensandboxServer)
        .where(eq(opensandboxServer.poolId, poolId))
        .all()
        .filter((server) => {
          if (server.status !== "active") return false;
          if (server.transportMode === "direct") return server.healthStatus === "healthy";
          const connection = connections.get(server.id);
          return (
            connection?.status === "connected" &&
            connection.healthStatus === "healthy" &&
            connection.lastSeenAt >= now - (this.config?.frpConnectionStaleMs ?? 40000)
          );
        })
        .map((server) => ({ server, current: this.bindings.countByServer(server.id) }))
        .filter(({ server, current }) => current < (server.maxSandboxes ?? 0))
        .sort(
          (left, right) =>
            left.current / (left.server.maxSandboxes ?? 1) - right.current / (right.server.maxSandboxes ?? 1),
        );

      const selected = servers[0]?.server;
      if (!selected) throw new AllocationError("pool has no available OpenSandbox Server");
      const binding = this.bindings.insert({ sandboxId, poolId, serverId: selected.id, createdAt: Date.now() });
      return this.response(binding.sandboxId, binding.poolId, binding.serverId);
    });
  }

  binding(sandboxId: string) {
    return this.bindings.findBySandboxId(sandboxId);
  }

  find(sandboxId: string) {
    const binding = this.bindings.findBySandboxId(sandboxId);
    return binding
      ? {
          ...this.response(binding.sandboxId, binding.poolId, binding.serverId),
          allocation_mode: binding.allocationMode,
          provider_sandbox_id: binding.providerSandboxId,
          state: binding.state,
          expires_at: binding.expiresAt,
        }
      : undefined;
  }

  release(sandboxId: string) {
    const binding = this.binding(sandboxId);
    if (binding?.allocationMode === "resources") {
      if (!this.lifecycle) throw new Error("lifecycle unavailable");
      return this.lifecycle.release(sandboxId);
    }
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
