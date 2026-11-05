import type { ElysiaOpenAPIConfig } from "@elysiajs/openapi";

type Schema = NonNullable<NonNullable<ElysiaOpenAPIConfig["documentation"]>["components"]>["schemas"];
type Model = Exclude<NonNullable<Schema>[string], { $ref: string }>;
type Properties = NonNullable<Model["properties"]>;
const text = { type: "string" } as const;
const number = { type: "number" } as const;
const nullableNumber = { type: "number", nullable: true } as const;
const nullableText = { type: "string", nullable: true } as const;
const times = { createdAt: number, updatedAt: number };
const pool: Properties = {
  id: text,
  name: text,
  status: text,
  schedulingMode: { type: "string", enum: ["count", "resources"] },
  defaultLeaseSeconds: nullableNumber,
  maxLeaseSeconds: nullableNumber,
  ...times,
};
const poolInput: Properties = {
  id: text,
  name: text,
  status: { type: "string", enum: ["active", "disabled"] },
  scheduling_mode: { type: "string", enum: ["count", "resources"], default: "count" },
  default_lease_seconds: { type: "integer", minimum: 60 },
  max_lease_seconds: { type: "integer", minimum: 60 },
};
const { id: _poolId, ...poolUpdate } = poolInput;
const serverInput: Properties = {
  id: text,
  pool_id: text,
  name: text,
  transport_mode: { type: "string", enum: ["direct", "tunnel"], default: "direct" },
  base_url: { type: "string", description: "direct 节点的可达 HTTP 地址" },
  workspace_root: { type: "string", description: "节点挂载根目录，例如 /workspace" },
  api_key: { type: "string", writeOnly: true, description: "OpenSandbox 节点 API Key" },
  status: { type: "string", enum: ["active", "draining", "disabled"] },
  max_sandboxes: { type: "integer", description: "数量模式的沙盒数量上限" },
  cpu_capacity: { type: "number", description: "资源模式 CPU 容量，核数，支持小数" },
  memory_capacity_mb: { type: "number", description: "资源模式内存容量，MB" },
  disk_capacity_gb: { type: "number", description: "资源模式硬盘容量，GB" },
  gpu_capacity: { type: "integer", minimum: 0, description: "资源模式 GPU 数量" },
};
const { id: _serverId, transport_mode: _transport, ...serverUpdate } = serverInput;

/** Documentation-only models for manually validated v1 routes; they do not change request handling. */
export const clusterOpenApiSchemas: Schema = {
  Error: {
    type: "object",
    required: ["error"],
    properties: { error: { type: "object", required: ["code", "message"], properties: { code: text, message: text } } },
  },
  PoolInput: { type: "object", required: ["id", "name"], properties: poolInput },
  PoolUpdate: { type: "object", properties: poolUpdate },
  PoolRecord: { type: "object", properties: pool },
  Pool: {
    type: "object",
    properties: { ...pool, currentSandboxes: number, capacitySandboxes: number, availableSandboxes: number },
  },
  ServerInput: {
    type: "object",
    required: ["id", "pool_id", "name", "workspace_root", "api_key"],
    properties: serverInput,
  },
  ServerUpdate: { type: "object", properties: serverUpdate },
  Server: {
    type: "object",
    properties: {
      id: text,
      poolId: text,
      name: text,
      transportMode: text,
      baseUrl: nullableText,
      routeHost: nullableText,
      workspaceRoot: text,
      status: text,
      healthStatus: text,
      lastHealthAt: nullableNumber,
      lastError: nullableText,
      maxSandboxes: nullableNumber,
      cpuCapacity: nullableNumber,
      memoryCapacityMb: nullableNumber,
      diskCapacityGb: nullableNumber,
      gpuCapacity: nullableNumber,
      currentSandboxes: number,
      allocatedResources: {
        type: "object",
        nullable: true,
        properties: { cpu: number, memoryMb: number, diskGb: number, gpuCount: number },
      },
      ...times,
    },
  },
  Allocation: {
    type: "object",
    properties: {
      sandbox_id: text,
      pool_id: text,
      server_id: text,
      proxy_url: text,
      allocation_mode: text,
      allocation_etag: text,
      provider_sandbox_id: nullableText,
      state: text,
      expires_at: nullableNumber,
    },
  },
  Tunnel: {
    type: "object",
    properties: { serverId: text, routeHost: text, credentialStatus: text, tokenPrefix: text },
  },
};
