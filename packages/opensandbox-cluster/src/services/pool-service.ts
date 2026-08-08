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

  create(input: { id: string; name: string; status?: string }) {
    const now = Date.now();
    return this.pools.insert({
      id: input.id,
      name: input.name,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id: string, input: { name?: string; status?: string }) {
    return this.pools.update(id, { ...input, updatedAt: Date.now() });
  }

  delete(id: string) {
    if (this.servers.listByPool(id).length > 0 || this.bindings.countByPool(id) > 0) {
      throw new ConflictError("pool has servers or active sandbox bindings");
    }
    return this.pools.delete(id);
  }

  private withCapacity(pool: ReturnType<PoolRepository["findById"]>) {
    if (!pool) return pool;
    const servers = this.servers.listByPool(pool.id);
    const current = this.bindings.countByPool(pool.id);
    const capacity = servers.reduce((sum, server) => sum + server.maxSandboxes, 0);
    const available = servers
      .filter((server) => server.status === "active" && server.healthStatus === "healthy")
      .reduce((sum, server) => sum + Math.max(0, server.maxSandboxes - this.bindings.countByServer(server.id)), 0);
    return { ...pool, currentSandboxes: current, capacitySandboxes: capacity, availableSandboxes: available };
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";
}
