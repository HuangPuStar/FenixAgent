import type { ClusterDatabase } from "../db/client";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";

export class PoolService {
  private readonly pools: PoolRepository;
  private readonly servers: ServerRepository;
  private readonly bindings: BindingRepository;

  constructor(db: ClusterDatabase) {
    this.pools = new PoolRepository(db);
    this.servers = new ServerRepository(db);
    this.bindings = new BindingRepository(db);
  }

  list() {
    return this.pools.list().map((pool) => this.withCapacity(pool));
  }

  findById(id: string) {
    const pool = this.pools.findById(id);
    return pool ? this.withCapacity(pool) : undefined;
  }

  create(input: {
    id: string;
    name: string;
    status?: string;
    scheduling_mode?: string;
    default_lease_seconds?: number;
    max_lease_seconds?: number;
  }) {
    this.validate(input);
    const now = Date.now();
    return this.pools.insert({
      schedulingMode: input.scheduling_mode ?? "count",
      defaultLeaseSeconds: input.default_lease_seconds,
      maxLeaseSeconds: input.max_lease_seconds,
      id: input.id,
      name: input.name,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  update(
    id: string,
    input: {
      name?: string;
      status?: string;
      scheduling_mode?: string;
      default_lease_seconds?: number;
      max_lease_seconds?: number;
    },
  ) {
    const current = this.pools.findById(id);
    if (!current) return;
    if (
      input.scheduling_mode &&
      input.scheduling_mode !== current.schedulingMode &&
      (this.bindings.countByPool(id) > 0 || this.servers.listByPool(id).length > 0)
    )
      throw new ConflictError("remove pool servers and active bindings before changing scheduling_mode");
    this.validate({
      scheduling_mode: input.scheduling_mode ?? current.schedulingMode,
      default_lease_seconds: input.default_lease_seconds ?? current.defaultLeaseSeconds ?? undefined,
      max_lease_seconds: input.max_lease_seconds ?? current.maxLeaseSeconds ?? undefined,
    });
    return this.pools.update(id, {
      name: input.name,
      status: input.status,
      schedulingMode: input.scheduling_mode,
      defaultLeaseSeconds: input.default_lease_seconds,
      maxLeaseSeconds: input.max_lease_seconds,
      updatedAt: Date.now(),
    });
  }

  delete(id: string) {
    if (this.servers.listByPool(id).length > 0 || this.bindings.hasPoolReferences(id)) {
      throw new ConflictError("pool has servers or active sandbox bindings");
    }
    return this.pools.delete(id);
  }

  private validate(input: { scheduling_mode?: string; default_lease_seconds?: number; max_lease_seconds?: number }) {
    if (input.scheduling_mode && !["count", "resources"].includes(input.scheduling_mode))
      throw new Error("invalid scheduling_mode");
    if (
      input.scheduling_mode === "resources" &&
      (!Number.isInteger(input.default_lease_seconds) ||
        (input.default_lease_seconds ?? 0) < 60 ||
        !Number.isInteger(input.max_lease_seconds) ||
        (input.max_lease_seconds ?? 0) < (input.default_lease_seconds ?? 0))
    )
      throw new Error("invalid lease configuration");
  }

  private withCapacity(pool: ReturnType<PoolRepository["findById"]>) {
    if (!pool) return pool;
    const servers = this.servers.listByPool(pool.id);
    const current = this.bindings.countByPool(pool.id);
    const capacity = servers.reduce((sum, server) => sum + (server.maxSandboxes ?? 0), 0);
    const available = servers
      .filter((server) => server.status === "active" && server.healthStatus === "healthy")
      .reduce(
        (sum, server) => sum + Math.max(0, (server.maxSandboxes ?? 0) - this.bindings.countByServer(server.id)),
        0,
      );
    return { ...pool, currentSandboxes: current, capacitySandboxes: capacity, availableSandboxes: available };
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";
}
