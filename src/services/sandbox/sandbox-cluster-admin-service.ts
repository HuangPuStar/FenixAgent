import { config } from "../../config";

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SandboxClusterAdminError extends Error {
  constructor(
    public readonly status: number,
    message = "Cluster request failed",
  ) {
    super(message);
    this.name = "SandboxClusterAdminError";
  }
}

export class SandboxClusterUnavailableError extends Error {
  constructor() {
    super("Sandbox Cluster service is unavailable");
    this.name = "SandboxClusterUnavailableError";
  }
}

function extractClusterErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return trimmed;
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  } catch {
    return trimmed;
  }
  return undefined;
}

export function createSandboxClusterAdminService(fetchImpl: FetchImpl = fetch) {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!config.openSandboxClusterUrl || !config.openSandboxClusterApiKey) {
      throw new SandboxClusterUnavailableError();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.sandboxProviderRequestTimeoutMs);
    try {
      const response = await fetchImpl(`${config.openSandboxClusterUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.openSandboxClusterApiKey}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new SandboxClusterAdminError(
          response.status,
          extractClusterErrorMessage(text) ?? `Cluster request failed with status ${response.status}`,
        );
      }
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } catch (error) {
      if (error instanceof SandboxClusterAdminError) throw error;
      throw new SandboxClusterAdminError(503);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listPools: () => request("/api/v1/pools"),
    createPool: (body: unknown) => request("/api/v1/pools", { method: "POST", body: JSON.stringify(body) }),
    getPool: (id: string) => request(`/api/v1/pools/${encodeURIComponent(id)}`),
    updatePool: (id: string, body: unknown) =>
      request(`/api/v1/pools/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
    deletePool: (id: string) => request(`/api/v1/pools/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listServers: (poolId?: string) =>
      request(`/api/v1/servers${poolId ? `?pool_id=${encodeURIComponent(poolId)}` : ""}`),
    createServer: (body: unknown) => request("/api/v1/servers", { method: "POST", body: JSON.stringify(body) }),
    getServer: (id: string) => request(`/api/v1/servers/${encodeURIComponent(id)}`),
    updateServer: (id: string, body: unknown) =>
      request(`/api/v1/servers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
    deleteServer: (id: string) => request(`/api/v1/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    healthCheck: (id: string) => request(`/api/v1/servers/${encodeURIComponent(id)}/health-check`, { method: "POST" }),
    prepareTunnel: (id: string) => request(`/api/v1/servers/${encodeURIComponent(id)}/tunnel`, { method: "PUT" }),
    downloadTunnelConfig: async (id: string) => {
      const result = await request(`/api/v1/servers/${encodeURIComponent(id)}/tunnel/frpc.toml`);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
}

export const sandboxClusterAdminService = createSandboxClusterAdminService();
