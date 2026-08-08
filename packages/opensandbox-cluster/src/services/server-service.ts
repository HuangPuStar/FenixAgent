import type { ClusterDatabase } from "../db/client";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";
import type { SecretBox } from "../security/secret-box";
import { ConflictError } from "./pool-service";

export interface ServerMutation {
  id?: string;
  pool_id?: string;
  name?: string;
  base_url?: string;
  workspace_root?: string;
  api_key?: string;
  max_sandboxes?: number;
  status?: string;
}

export class ServerService {
  private readonly pools: PoolRepository;
  private readonly servers: ServerRepository;
  private readonly bindings: BindingRepository;

  constructor(
    private readonly db: ClusterDatabase,
    private readonly secretBox: SecretBox,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.pools = new PoolRepository(db);
    this.servers = new ServerRepository(db);
    this.bindings = new BindingRepository(db);
  }

  list(poolId?: string) {
    const rows = poolId ? this.servers.listByPool(poolId) : this.servers.listAll();
    return rows.map((row) => this.publicRow(row));
  }

  findById(id: string) {
    const row = this.servers.findById(id);
    return row ? this.publicRow(row) : undefined;
  }

  create(
    input: Required<
      Pick<ServerMutation, "id" | "pool_id" | "name" | "base_url" | "workspace_root" | "api_key" | "max_sandboxes">
    > & {
      status?: string;
    },
  ) {
    if (!this.pools.findById(input.pool_id)) throw new Error("pool not found");
    const now = Date.now();
    const row = this.servers.insert({
      id: input.id,
      poolId: input.pool_id,
      name: input.name,
      baseUrl: input.base_url,
      workspaceRoot: normalizeWorkspaceRoot(input.workspace_root),
      apiKeyCiphertext: this.secretBox.encryptApiKey(input.api_key),
      maxSandboxes: input.max_sandboxes,
      status: input.status ?? "active",
      healthStatus: "unknown",
      createdAt: now,
      updatedAt: now,
    });
    return this.publicRow(row);
  }

  update(id: string, input: ServerMutation) {
    const current = this.servers.findById(id);
    if (!current) return undefined;
    if (input.pool_id && input.pool_id !== current.poolId && this.bindings.countByServer(id) > 0) {
      throw new ConflictError("server with bindings cannot move pools");
    }
    if (input.pool_id && !this.pools.findById(input.pool_id)) throw new Error("pool not found");
    if (input.max_sandboxes !== undefined && input.max_sandboxes < this.bindings.countByServer(id)) {
      throw new ConflictError("max_sandboxes cannot be below current bindings");
    }
    const row = this.servers.update(id, {
      ...(input.pool_id ? { poolId: input.pool_id } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.base_url ? { baseUrl: input.base_url } : {}),
      ...(input.workspace_root ? { workspaceRoot: normalizeWorkspaceRoot(input.workspace_root) } : {}),
      ...(input.api_key ? { apiKeyCiphertext: this.secretBox.encryptApiKey(input.api_key) } : {}),
      ...(input.max_sandboxes !== undefined ? { maxSandboxes: input.max_sandboxes } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: Date.now(),
    });
    return row ? this.publicRow(row) : undefined;
  }

  delete(id: string) {
    if (this.bindings.countByServer(id) > 0) throw new ConflictError("server has active sandbox bindings");
    return this.servers.delete(id);
  }

  getCredentials(id: string) {
    const row = this.servers.findById(id);
    return row ? { ...row, apiKey: this.secretBox.decryptApiKey(row.apiKeyCiphertext) } : undefined;
  }

  async healthCheck(id: string) {
    const row = this.servers.findById(id);
    if (!row) return undefined;
    try {
      const response = await this.fetchImpl(new URL("/health", row.baseUrl), { signal: AbortSignal.timeout(3000) });
      const healthy = response.ok;
      this.servers.update(id, {
        healthStatus: healthy ? "healthy" : "unhealthy",
        lastHealthAt: Date.now(),
        lastError: healthy ? null : `HTTP ${response.status}`,
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.servers.update(id, {
        healthStatus: "unhealthy",
        lastHealthAt: Date.now(),
        lastError: error instanceof Error ? error.message : "health check failed",
        updatedAt: Date.now(),
      });
    }
    return this.findById(id);
  }

  private publicRow(row: NonNullable<ReturnType<ServerRepository["findById"]>>) {
    const { apiKeyCiphertext: _apiKeyCiphertext, ...publicRow } = row;
    return { ...publicRow, currentSandboxes: this.bindings.countByServer(row.id) };
  }
}

function normalizeWorkspaceRoot(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("workspace_root must be an absolute path");
  }
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new Error("workspace_root must not be the filesystem root or contain path traversal");
  }
  return normalized;
}
