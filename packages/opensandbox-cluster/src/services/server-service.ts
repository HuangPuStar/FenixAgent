import { createLogger } from "@fenix/logger";
import type { ClusterDatabase } from "../db/client";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";
import { TunnelConnectionRepository } from "../repositories/tunnel-connection-repository";
import type { SecretBox } from "../security/secret-box";
import { ConflictError } from "./pool-service";
import { resourceFits } from "./resource-accounting";
import { allocated, reservations } from "./resource-allocation";

const logger = createLogger("cluster.servers");

export interface ServerMutation {
  id?: string;
  pool_id?: string;
  name?: string;
  base_url?: string;
  workspace_root?: string;
  api_key?: string;
  max_sandboxes?: number;
  cpu_capacity?: number;
  memory_capacity_mb?: number;
  disk_capacity_gb?: number;
  gpu_capacity?: number;
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
    private readonly db: ClusterDatabase,
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
    input: ServerMutation & { id: string; pool_id: string; name: string; workspace_root: string; api_key: string },
  ) {
    if (!this.pools.findById(input.pool_id)) throw new Error("pool not found");
    const capacity = this.capacity(input, input.pool_id);
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
      ...capacity,
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
    const capacity = this.capacity(input, input.pool_id ?? current.poolId, current);
    const row = this.servers.update(id, {
      ...capacity,
      ...(input.pool_id ? { poolId: input.pool_id } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.base_url !== undefined ? { baseUrl: input.base_url } : {}),
      ...(input.transport_mode ? { transportMode: input.transport_mode } : {}),
      ...(input.workspace_root ? { workspaceRoot: normalizeWorkspaceRoot(input.workspace_root) } : {}),
      ...(input.api_key ? { apiKeyCiphertext: this.secretBox.encryptApiKey(input.api_key) } : {}),
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
    if (this.bindings.hasServerReferences(id)) throw new ConflictError("server has active sandbox bindings");
    return this.servers.delete(id);
  }

  getCredentials(id: string) {
    const row = this.servers.findById(id);
    return row
      ? {
          ...row,
          schedulingMode: this.pools.findById(row.poolId)?.schedulingMode,
          apiKey: this.secretBox.decryptApiKey(row.apiKeyCiphertext),
        }
      : undefined;
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
      if (!healthy) logger.error("direct node health check failed", { serverId: id, status: response.status });
      this.servers.update(id, {
        healthStatus: healthy ? "healthy" : "unhealthy",
        lastHealthAt: Date.now(),
        lastError: healthy ? null : `HTTP ${response.status}`,
        updatedAt: Date.now(),
      });
    } catch (error) {
      logger.error("direct node health check failed", { serverId: id, error });
      this.servers.update(id, {
        healthStatus: "unhealthy",
        lastHealthAt: Date.now(),
        lastError: error instanceof Error ? error.message : "health check failed",
        updatedAt: Date.now(),
      });
    }
    return this.findById(id);
  }

  private capacity(
    input: ServerMutation,
    poolId: string,
    current?: NonNullable<ReturnType<ServerRepository["findById"]>>,
  ) {
    const pool = this.pools.findById(poolId);
    if (!pool) throw new Error("pool not found");
    if (pool.schedulingMode === "count") {
      const max = input.max_sandboxes ?? current?.maxSandboxes;
      // 旧更新接口允许空闲节点缩容到 0；仅首次注册要求正整数。
      if (max === null || max === undefined || !Number.isInteger(max) || max < (current ? 0 : 1))
        throw new Error(`max_sandboxes must be a ${current ? "non-negative" : "positive"} integer`);
      return { maxSandboxes: max, cpuCapacity: null, memoryCapacityMb: null, diskCapacityGb: null, gpuCapacity: null };
    }
    const values = {
      cpuCapacity: input.cpu_capacity ?? current?.cpuCapacity,
      memoryCapacityMb: input.memory_capacity_mb ?? current?.memoryCapacityMb,
      diskCapacityGb: input.disk_capacity_gb ?? current?.diskCapacityGb,
      gpuCapacity: input.gpu_capacity ?? current?.gpuCapacity,
    };
    for (const [key, value] of Object.entries(values))
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < (key === "gpuCapacity" ? 0 : Number.MIN_VALUE) ||
        (key === "gpuCapacity" && !Number.isInteger(value))
      )
        throw new Error("invalid " + key);
    if (
      current &&
      !resourceFits(
        {
          cpu: values.cpuCapacity!,
          memoryMb: values.memoryCapacityMb!,
          diskGb: values.diskCapacityGb!,
          gpuCount: values.gpuCapacity!,
        },
        reservations(this.db, current.id),
      )
    )
      throw new ConflictError("capacity cannot be below current reservations");
    return { maxSandboxes: null, ...values } as {
      maxSandboxes: null;
      cpuCapacity: number;
      memoryCapacityMb: number;
      diskCapacityGb: number;
      gpuCapacity: number;
    };
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
      allocatedResources: row.maxSandboxes === null ? allocated(this.db, row.id) : null,
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
