import { getAdminKey } from "../lib/admin-key";
import { request, unwrap } from "./request";

export interface SandboxResources {
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuCount: number;
  environment: Record<string, string>;
  volumes: Array<{ name: string; source?: string; target: string; readOnly?: boolean }>;
}

export interface SandboxPool {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  name: string;
  providerKey: string;
  image: string;
  defaultResources: SandboxResources;
  extra: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxInstance {
  id: string;
  machineId: string;
  providerKey: string;
  sandboxPoolId: string;
  userId: string;
  externalSandboxId: string | null;
  status: string;
  resolvedConfig: Record<string, unknown>;
  resourceOverrides: SandboxResourcePatch | null;
  providerPayload: unknown;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string };
  machine: { id: string; name: string; status: string; lastHeartbeatAt: string | null };
}

export interface SandboxResourcePatch {
  cpu?: number | null;
  memoryMb?: number | null;
  diskGb?: number | null;
  gpuCount?: number | null;
}

export interface SandboxInstanceList {
  items: SandboxInstance[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClusterPool {
  id: string;
  name: string;
  status: string;
  currentSandboxes?: number;
  capacitySandboxes?: number;
  availableSandboxes?: number;
}

export interface ClusterServer {
  id: string;
  poolId: string;
  name: string;
  baseUrl: string;
  workspaceRoot: string;
  maxSandboxes: number;
  status: string;
  transportMode: "direct" | "tunnel";
  routeHost: string | null;
  healthStatus: string;
  lastHealthAt: number | null;
  lastError: string | null;
  currentSandboxes: number;
}

export interface RemoteSandbox {
  id: string;
  image?: string | { uri?: string };
  status: {
    state: string;
    reason?: string | null;
    message?: string | null;
    lastTransitionAt?: string | null;
  };
  createdAt: string;
  [key: string]: unknown;
}

export interface RemoteSandboxList {
  items: RemoteSandbox[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number; hasNextPage: boolean };
}

export interface SandboxCommandBody {
  command: string;
  cwd?: string;
  background?: boolean;
  timeout?: number;
}

export type SandboxRebuildRequest = {
  sandboxPoolId: string;
  instanceIds?: string[];
  userIds?: string[];
  dryRun?: boolean;
};

export function buildSandboxResourcePatch(
  input: Partial<Record<keyof SandboxResourcePatch, string>>,
): SandboxResourcePatch {
  const patch: SandboxResourcePatch = {};
  for (const key of ["cpu", "memoryMb", "diskGb", "gpuCount"] as const) {
    const rawValue = input[key];
    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      const value = Number(rawValue);
      if (Number.isFinite(value) && value > (key === "gpuCount" ? -1 : 0)) patch[key] = value;
    } else if (typeof rawValue === "string" && rawValue.trim() === "") {
      patch[key] = null;
    }
  }
  return patch;
}

export function buildSandboxRebuildRequest(input: {
  poolId: string;
  scope: "pool" | "instance" | "user";
  instanceId?: string;
  userId?: string;
}): SandboxRebuildRequest {
  if (input.scope === "instance") return { sandboxPoolId: input.poolId, instanceIds: [input.instanceId!] };
  if (input.scope === "user") return { sandboxPoolId: input.poolId, userIds: [input.userId!] };
  return { sandboxPoolId: input.poolId };
}

const adminOptions = () => ({ bearerToken: getAdminKey() ?? undefined });

export const systemSandboxApi = {
  listPools: () => unwrap(request<SandboxPool[]>("/api/system/sandbox-pools", adminOptions())),
  createPool: (body: Omit<SandboxPool, "createdAt" | "updatedAt" | "organizationName">) =>
    unwrap(request<SandboxPool>("/api/system/sandbox-pools", { ...adminOptions(), method: "POST", body })),
  updatePool: (id: string, body: Omit<SandboxPool, "id" | "createdAt" | "updatedAt" | "organizationName">) =>
    unwrap(
      request<SandboxPool>("/api/system/sandbox-pools/:poolId", {
        ...adminOptions(),
        method: "PUT",
        params: { poolId: id },
        body,
      }),
    ),
  getPool: (id: string) =>
    unwrap(request<SandboxPool>("/api/system/sandbox-pools/:poolId", { ...adminOptions(), params: { poolId: id } })),
  deletePool: (id: string) =>
    unwrap(
      request<void>("/api/system/sandbox-pools/:poolId", {
        ...adminOptions(),
        method: "DELETE",
        params: { poolId: id },
      }),
    ),
  listInstances: (poolId?: string) =>
    unwrap(
      request<SandboxInstanceList>("/api/system/sandbox-instances", {
        ...adminOptions(),
        query: poolId ? { sandbox_pool_id: poolId, page: 1, page_size: 200 } : { page: 1, page_size: 200 },
      }),
    ),
  getInstance: (id: string) =>
    unwrap(
      request<SandboxInstance>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        params: { instanceId: id },
      }),
    ),
  updateInstance: (id: string, resourceOverrides: SandboxResourcePatch) =>
    unwrap(
      request<SandboxInstance>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        method: "PUT",
        params: { instanceId: id },
        body: { resourceOverrides },
      }),
    ),
  deleteInstance: (id: string) =>
    unwrap(
      request<void>("/api/system/sandbox-instances/:instanceId", {
        ...adminOptions(),
        method: "DELETE",
        params: { instanceId: id },
      }),
    ),
  rebuild: (body: SandboxRebuildRequest) =>
    unwrap(request<unknown>("/api/system/sandbox-instances/rebuild", { ...adminOptions(), method: "POST", body })),
  cluster: {
    listPools: () => unwrap(request<ClusterPool[]>("/api/system/sandbox-cluster/pools", adminOptions())),
    createPool: (body: { id: string; name: string; status?: string }) =>
      unwrap(request<ClusterPool>("/api/system/sandbox-cluster/pools", { ...adminOptions(), method: "POST", body })),
    updatePool: (id: string, body: { name?: string; status?: string }) =>
      unwrap(
        request<ClusterPool>("/api/system/sandbox-cluster/pools/:poolId", {
          ...adminOptions(),
          method: "PUT",
          params: { poolId: id },
          body,
        }),
      ),
    deletePool: (id: string) =>
      unwrap(
        request<void>("/api/system/sandbox-cluster/pools/:poolId", {
          ...adminOptions(),
          method: "DELETE",
          params: { poolId: id },
        }),
      ),
    listServers: (poolId?: string) =>
      unwrap(
        request<ClusterServer[]>("/api/system/sandbox-cluster/servers", {
          ...adminOptions(),
          query: poolId ? { pool_id: poolId } : undefined,
        }),
      ),
    createServer: (body: Record<string, unknown>) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers", { ...adminOptions(), method: "POST", body }),
      ),
    updateServer: (id: string, body: Record<string, unknown>) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers/:serverId", {
          ...adminOptions(),
          method: "PUT",
          params: { serverId: id },
          body,
        }),
      ),
    deleteServer: (id: string) =>
      unwrap(
        request<void>("/api/system/sandbox-cluster/servers/:serverId", {
          ...adminOptions(),
          method: "DELETE",
          params: { serverId: id },
        }),
      ),
    healthCheck: (id: string) =>
      unwrap(
        request<ClusterServer>("/api/system/sandbox-cluster/servers/:serverId/health-check", {
          ...adminOptions(),
          method: "POST",
          params: { serverId: id },
        }),
      ),
    prepareTunnel: (id: string) =>
      unwrap(
        request<unknown>("/api/system/sandbox-cluster/servers/:serverId/tunnel", {
          ...adminOptions(),
          method: "PUT",
          params: { serverId: id },
        }),
      ),
    downloadTunnelConfig: async (id: string) => {
      const response = await fetch(`/api/system/sandbox-cluster/servers/${encodeURIComponent(id)}/tunnel/frpc.toml`, {
        headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` },
      });
      if (!response.ok) throw new Error("下载 tunnel 配置失败");
      return response.text();
    },
  },
  server: {
    listSandboxes: (
      serverId: string,
      query: { state?: string; metadata?: string; page?: number; page_size?: number } = {},
    ) =>
      unwrap(
        request<RemoteSandboxList>("/api/system/sandbox-server/servers/:serverId/sandboxes", {
          ...adminOptions(),
          params: { serverId },
          query: { page: 1, page_size: 200, ...query },
        }),
      ),
    getSandbox: (serverId: string, sandboxId: string) =>
      unwrap(
        request<RemoteSandbox>("/api/system/sandbox-server/servers/:serverId/sandboxes/:sandboxId", {
          ...adminOptions(),
          params: { serverId, sandboxId },
        }),
      ),
    getDiagnostics: async (serverId: string, sandboxId: string) => {
      const response = await fetch(
        `/api/system/sandbox-server/servers/${encodeURIComponent(serverId)}/sandboxes/${encodeURIComponent(sandboxId)}/diagnostics`,
        { headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, "获取诊断概览失败"));
      return response.text();
    },
    executeCommand: async (serverId: string, sandboxId: string, body: SandboxCommandBody, signal: AbortSignal) => {
      const response = await fetch(
        `/api/system/sandbox-server/servers/${encodeURIComponent(serverId)}/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getAdminKey() ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok) throw new Error(await readResponseError(response, "执行命令失败"));
      return response;
    },
  },
};

async function readResponseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const error = (payload as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message;
      }
    }
  } catch {
    // 非 JSON 错误直接回退到原始文本。
  }
  return text.trim() || fallback;
}
