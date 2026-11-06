import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { opensandboxServer, opensandboxTunnelConnection, sandboxBinding, sandboxPool } from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import type { ClusterConfig } from "../types";
import type { NativeResources } from "./native-resources";
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
  allocate(poolId: string, sandboxId: string, requireNew = false) {
    return this.lock.run(() => {
      const existing = this.bindings.findBySandboxId(sandboxId);
      if (existing) {
        if (requireNew) throw new LifecycleError("ALLOCATION_EXISTS", 409, "sandbox allocation already exists");
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
      const binding = this.bindings.insert({
        sandboxId,
        poolId,
        serverId: selected.id,
        attemptId: crypto.randomUUID(),
        createdAt: Date.now(),
      });
      return requireNew
        ? this.find(binding.sandboxId)!
        : this.response(binding.sandboxId, binding.poolId, binding.serverId);
    });
  }

  binding(sandboxId: string) {
    return this.bindings.findBySandboxId(sandboxId);
  }

  /** Claim a management create once; legacy proxy calls keep their existing contract. */
  beginCountCreate(id: string, expectedEtag: string) {
    return this.lock.run(() => {
      const current = this.binding(id);
      if (
        current?.allocationMode !== "count" ||
        current.state !== "active" ||
        !current.attemptId ||
        current.providerSandboxId ||
        this.etag(current) !== expectedEtag
      )
        throw new LifecycleError("ALLOCATION_CHANGED", 409, "allocation changed or creation already attempted");
      this.db
        .update(sandboxBinding)
        .set({ state: "creating", updatedAt: Date.now() })
        .where(eq(sandboxBinding.sandboxId, id))
        .run();
      return current;
    });
  }

  /** A rejected create can return its slot; an unknown result must retain it. */
  finishCountCreate(original: typeof sandboxBinding.$inferSelect, rejected: boolean) {
    this.lock.run(() => {
      const current = this.binding(original.sandboxId);
      if (!current || current.attemptId !== original.attemptId || current.providerSandboxId) return;
      if (rejected) this.bindings.deleteBySandboxId(current.sandboxId);
      else
        this.db
          .update(sandboxBinding)
          .set({ state: "uncertain", updatedAt: Date.now() })
          .where(eq(sandboxBinding.sandboxId, current.sandboxId))
          .run();
    });
  }

  /** Observe count-mode creates without changing the caller's lifecycle contract. */
  rememberProviderId(original: typeof sandboxBinding.$inferSelect, providerId: string, resources?: NativeResources) {
    this.lock.run(() => {
      this.db
        .update(sandboxBinding)
        .set({
          ...resources,
          providerSandboxId: providerId,
          state: "active",
          retryCount: 0,
          nextRetryAt: null,
          lastError: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(sandboxBinding.sandboxId, original.sandboxId),
            eq(sandboxBinding.serverId, original.serverId),
            eq(sandboxBinding.createdAt, original.createdAt),
            eq(sandboxBinding.allocationMode, "count"),
            inArray(sandboxBinding.state, ["active", "creating", "uncertain"]),
            original.attemptId ? eq(sandboxBinding.attemptId, original.attemptId) : isNull(sandboxBinding.attemptId),
            isNull(sandboxBinding.providerSandboxId),
          ),
        )
        .run();
    });
  }

  find(sandboxId: string) {
    const binding = this.bindings.findBySandboxId(sandboxId);
    return binding
      ? {
          ...this.response(binding.sandboxId, binding.poolId, binding.serverId),
          allocation_mode: binding.allocationMode,
          allocation_etag: this.etag(binding),
          provider_sandbox_id: binding.providerSandboxId,
          state: binding.state,
          expires_at: binding.expiresAt,
        }
      : undefined;
  }

  release(sandboxId: string, expectedEtag?: string) {
    if (expectedEtag !== undefined) {
      return this.lock.run(() => {
        const current = this.bindings.findBySandboxId(sandboxId);
        if (current?.allocationMode !== "count" || this.etag(current) !== expectedEtag)
          throw new LifecycleError("ALLOCATION_CHANGED", 409, "allocation changed; refresh before releasing");
        return this.bindings.deleteBySandboxId(sandboxId);
      });
    }
    const binding = this.binding(sandboxId);
    if (binding?.allocationMode === "resources") {
      if (!this.lifecycle) throw new Error("lifecycle unavailable");
      return this.lifecycle.release(sandboxId);
    }
    return this.lock.run(() => this.bindings.deleteBySandboxId(sandboxId));
  }

  private etag(binding: typeof sandboxBinding.$inferSelect) {
    return Buffer.from(JSON.stringify([binding.createdAt, binding.attemptId, binding.providerSandboxId])).toString(
      "base64url",
    );
  }

  private response(sandboxId: string, poolId: string, serverId: string) {
    return {
      sandbox_id: sandboxId,
      pool_id: poolId,
      server_id: serverId,
      proxy_url: `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy`,
    };
  }
}
