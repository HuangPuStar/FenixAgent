import { createSandboxClusterClient, type SandboxClusterFetch } from "./sandbox-cluster-client";

export { SandboxClusterAdminError, SandboxClusterUnavailableError } from "./sandbox-cluster-client";

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** 管理 Cluster Pool、Server 记录及其基础设施操作。 */
export function createSandboxClusterAdminService(fetchImpl: SandboxClusterFetch = fetch) {
  const client = createSandboxClusterClient(fetchImpl);
  const request = <T>(path: string, init?: RequestInit) => client.json<T>(path, init);

  return {
    listPools: () => request<unknown[]>("/api/v1/pools"),
    createPool: (body: unknown) => request<unknown>("/api/v1/pools", { method: "POST", body: JSON.stringify(body) }),
    getPool: (id: string) => request<unknown>(`/api/v1/pools/${encodeId(id)}`),
    updatePool: (id: string, body: unknown) =>
      request<unknown>(`/api/v1/pools/${encodeId(id)}`, { method: "PUT", body: JSON.stringify(body) }),
    deletePool: (id: string) => request<unknown>(`/api/v1/pools/${encodeId(id)}`, { method: "DELETE" }),
    listServers: (poolId?: string) =>
      request<unknown[]>(`/api/v1/servers${poolId ? `?pool_id=${encodeURIComponent(poolId)}` : ""}`),
    createServer: (body: unknown) =>
      request<unknown>("/api/v1/servers", { method: "POST", body: JSON.stringify(body) }),
    getServer: (id: string) => request<unknown>(`/api/v1/servers/${encodeId(id)}`),
    updateServer: (id: string, body: unknown) =>
      request<unknown>(`/api/v1/servers/${encodeId(id)}`, { method: "PUT", body: JSON.stringify(body) }),
    deleteServer: (id: string) => request<unknown>(`/api/v1/servers/${encodeId(id)}`, { method: "DELETE" }),
    healthCheck: (id: string) => request<unknown>(`/api/v1/servers/${encodeId(id)}/health-check`, { method: "POST" }),
    prepareTunnel: (id: string) => request<unknown>(`/api/v1/servers/${encodeId(id)}/tunnel`, { method: "PUT" }),
    downloadTunnelConfig: (id: string) => client.jsonText(`/api/v1/servers/${encodeId(id)}/tunnel/frpc.toml`),
  };
}

export const sandboxClusterAdminService = createSandboxClusterAdminService();
