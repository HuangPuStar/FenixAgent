import type { ClusterDatabase } from "../db/client";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";
import { TunnelConnectionRepository } from "../repositories/tunnel-connection-repository";
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
  transport_mode?: "direct" | "tunnel";
  route_host?: string;
}

export class ServerService {
  private readonly pools: PoolRepository;
  private readonly servers: ServerRepository;
  private readonly bindings: BindingRepository;
  private readonly tunnelConnections: TunnelConnectionRepository;

  constructor(
    db: ClusterDatabase,
    private readonly secretBox: SecretBox,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.pools = new PoolRepository(db);
    this.servers = new ServerRepository(db);
    this.bindings = new BindingRepository(db);
    this.tunnelConnections = new TunnelConnectionRepository(db);
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
      Pick<ServerMutation, "id" | "pool_id" | "name" | "workspace_root" | "api_key" | "max_sandboxes">
    > & {
      base_url?: string;
      transport_mode?: "direct" | "tunnel";
      route_host?: string;
      status?: string;
    },
  ) {
    if (!this.pools.findById(input.pool_id)) throw new Error("pool not found");
    const now = Date.now();
    const transportMode = input.transport_mode ?? "direct";
    if (transportMode === "direct" && !input.base_url) throw new Error("base_url is required for direct transport");
    const row = this.servers.insert({
      id: input.id,
      poolId: input.pool_id,
      name: input.name,
      transportMode,
      // Keep the legacy NOT NULL column compatible with tunnel rows.
      baseUrl: input.base_url ?? "",
      routeHost: input.route_host ?? null,
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
    if (!current) return;
    if (input.pool_id && input.pool_id !== current.poolId && this.bindings.countByServer(id) > 0) {
      throw new ConflictError("server with bindings cannot move pools");
    }
    if (input.pool_id && !this.pools.findById(input.pool_id)) throw new Error("pool not found");
    if (input.max_sandboxes !== undefined && input.max_sandboxes < this.bindings.countByServer(id)) {
      throw new ConflictError("max_sandboxes cannot be below current bindings");
    }
    if (input.transport_mode === "tunnel" && current.transportMode === "direct") {
      throw new ConflictError("use the tunnel endpoint to switch a direct server");
    }
    if (input.transport_mode === "direct" && !(input.base_url ?? current.baseUrl)) {
      throw new Error("base_url is required for direct transport");
    }
    const row = this.servers.update(id, {
      ...(input.pool_id ? { poolId: input.pool_id } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.base_url !== undefined ? { baseUrl: input.base_url } : {}),
      ...(input.transport_mode ? { transportMode: input.transport_mode } : {}),
      ...(input.workspace_root ? { workspaceRoot: normalizeWorkspaceRoot(input.workspace_root) } : {}),
      ...(input.api_key ? { apiKeyCiphertext: this.secretBox.encryptApiKey(input.api_key) } : {}),
      ...(input.max_sandboxes !== undefined ? { maxSandboxes: input.max_sandboxes } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: Date.now(),
    });
    return row ? this.publicRow(row) : undefined;
  }

  /** Reject tunnel migration while a direct Server is still reachable. */
  async ensureOfflineForTunnel(id: string): Promise<void> {
    const current = this.servers.findById(id);
    if (!current) throw new Error("server not found");
    if (current.transportMode !== "direct" || !current.baseUrl) return;
    try {
      await this.fetchImpl(new URL("/health", current.baseUrl), { signal: AbortSignal.timeout(3000) });
      throw new ConflictError("server must be offline before switching to tunnel");
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      // Network failure or timeout is the expected offline state.
    }
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
    if (!row) return;
    // Tunnel 的健康探测由 ServerConnectionMonitor 通过 FRP 路由定时执行，不能把保留的
    // baseUrl 当作 Direct 地址再次拼接 /health；管理端手动检查只返回当前连接结论。
    if (row.transportMode === "tunnel") return this.findById(id);
    try {
      if (!row.baseUrl) return this.findById(id);
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
    const tunnelHealth = row.transportMode === "tunnel" ? this.tunnelConnections.findByServerId(row.id) : undefined;
    return {
      ...publicRow,
      ...(row.transportMode === "tunnel"
        ? {
            healthStatus: tunnelHealth?.healthStatus ?? "unknown",
            lastHealthAt: tunnelHealth?.lastHealthAt ?? null,
            lastError: tunnelHealth?.lastError ?? null,
          }
        : {}),
      currentSandboxes: this.bindings.countByServer(row.id),
    };
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
