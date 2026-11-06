import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { opensandboxServer, type SandboxBinding, sandboxBinding, sandboxPool } from "../db/schema";
import type { ClusterConfig } from "../types";
import { dimensions, type Resources, resourceFits, sumResources, validateResources } from "./resource-accounting";
import { ServerTargetResolver } from "./server-target-resolver";
/** Domain errors carry the independent Cluster HTTP contract. */
export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const terminalStates = ["released", "expired", "failed"];
/** Recover resource reservations without counting retained terminal history. */
export function allocated(db: ClusterDatabase, serverId: string): Resources {
  return sumResources(reservations(db, serverId));
}
/** Read each reservation independently so admission never rounds intermediate totals. */
export function reservations(db: ClusterDatabase, serverId: string): Resources[] {
  return db
    .select()
    .from(sandboxBinding)
    .where(eq(sandboxBinding.serverId, serverId))
    .all()
    .filter((b) => b.allocationMode === "resources" && !terminalStates.includes(b.state))
    .map((b) => ({ cpu: b.cpu!, memoryMb: b.memoryMb!, diskGb: b.diskGb!, gpuCount: b.gpuCount! }));
}
/** Return the configured budget in platform resource units. */
export function capacity(server: typeof opensandboxServer.$inferSelect): Resources {
  return {
    cpu: server.cpuCapacity!,
    memoryMb: server.memoryCapacityMb!,
    diskGb: server.diskCapacityGb!,
    gpuCount: server.gpuCapacity!,
  };
}
/** Atomically reserve on one eligible node; callers hold SchedulerLock. */
export function reserve(
  db: ClusterDatabase,
  config: ClusterConfig,
  poolId: string,
  id: string,
  resources: Resources,
  hash: string,
  lease?: number,
): SandboxBinding {
  validateResources(resources);
  const existing = db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, id)).get();
  if (existing) {
    if (
      existing.poolId !== poolId ||
      existing.requestHash !== hash ||
      (lease !== undefined && lease !== existing.leaseSeconds)
    )
      throw new LifecycleError("IDEMPOTENCY_CONFLICT", 409, "sandbox parameters differ");
    return existing;
  }
  const pool = db.select().from(sandboxPool).where(eq(sandboxPool.id, poolId)).get();
  if (!pool) throw new LifecycleError("NOT_FOUND", 404, "pool not found");
  if (pool.schedulingMode !== "resources" || pool.status !== "active")
    throw new LifecycleError("INVALID_REQUEST", 400, "active resources pool required");
  const seconds = lease ?? pool.defaultLeaseSeconds!;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > pool.maxLeaseSeconds!)
    throw new LifecycleError("INVALID_REQUEST", 400, "invalid lease_seconds");
  const resolver = new ServerTargetResolver(db, config);
  const nodes = db
    .select()
    .from(opensandboxServer)
    .where(eq(opensandboxServer.poolId, poolId))
    .all()
    .filter((s) => {
      if (s.status !== "active") return false;
      try {
        resolver.resolve(s.id);
        return true;
      } catch {
        return false;
      }
    })
    .map((server) => {
      const requests = [...reservations(db, server.id), resources];
      const total = sumResources(requests);
      const budget = capacity(server);
      return {
        server,
        total,
        budget,
        requests,
        score: Math.max(...dimensions.filter((k) => budget[k] > 0).map((k) => total[k] / budget[k])),
      };
    })
    .filter((n) => resourceFits(n.budget, n.requests))
    .sort((a, b) => a.score - b.score || a.server.id.localeCompare(b.server.id));
  const server = nodes[0]?.server;
  if (!server) throw new LifecycleError("NO_CAPACITY", 409, "no node has sufficient resources");
  const now = Date.now();
  return db
    .insert(sandboxBinding)
    .values({
      sandboxId: id,
      poolId,
      serverId: server.id,
      allocationMode: "resources",
      state: "creating",
      ...resources,
      attemptId: crypto.randomUUID(),
      requestHash: hash,
      leaseSeconds: seconds,
      expiresAt: now + seconds * 1000,
      createdAt: now,
      updatedAt: now,
      nextRetryAt: now + 5000,
    })
    .returning()
    .get();
}
