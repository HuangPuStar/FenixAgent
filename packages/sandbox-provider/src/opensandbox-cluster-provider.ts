import { ClusterHttpClient, type FetchImpl } from "./http-client";
import type {
  ClusterAllocationResponse,
  OpenSandboxClusterProviderConfig,
  OpenSandboxResponse,
} from "./opensandbox-cluster-types";
import { type SandboxProvider, SandboxProviderError } from "./provider";
import type { SandboxCreateInput, SandboxRef } from "./types";

function stateOf(response: OpenSandboxResponse): string {
  if (typeof response.status === "string") return response.status.toLowerCase();
  if (response.status && typeof response.status === "object") {
    const state = (response.status as { state?: unknown }).state;
    if (typeof state === "string") return state.toLowerCase();
  }
  return "";
}

function mapStatus(response: OpenSandboxResponse): SandboxRef["status"] {
  switch (stateOf(response)) {
    case "running":
    case "ready":
      return "ready";
    case "paused":
    case "stopped":
    case "suspended":
      return "stopped";
    case "failed":
    case "error":
    case "terminated":
      return "error";
    default:
      return "creating";
  }
}

function memoryLimit(memoryMb: number): string {
  return `${memoryMb}Mi`;
}

function createBody(input: SandboxCreateInput): Record<string, unknown> {
  const volumes = input.resources.volumes.map((volume) => {
    if (!volume.source) {
      throw new SandboxProviderError(
        `sandbox volume '${volume.name}' requires a host source path`,
        "INVALID_REQUEST",
        false,
      );
    }
    return {
      name: volume.name,
      host: { path: volume.source },
      mountPath: volume.target,
      ...(volume.readOnly === undefined ? {} : { readOnly: volume.readOnly }),
    };
  });

  const entrypoint = input.providerExtra?.entrypoint;
  if (entrypoint !== undefined) {
    if (!Array.isArray(entrypoint) || entrypoint.length === 0 || entrypoint.some((item) => typeof item !== "string")) {
      throw new SandboxProviderError(
        "OpenSandbox entrypoint must be a non-empty string array",
        "INVALID_REQUEST",
        false,
      );
    }
  }

  return {
    image: { uri: input.template.value },
    timeout: null,
    resourceLimits: {
      cpu: `${input.resources.cpu * 1000}m`,
      memory: memoryLimit(input.resources.memoryMb),
      disk: `${input.resources.diskGb}Gi`,
      gpu: String(input.resources.gpuCount),
    },
    env: input.resources.environment,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(volumes.length > 0 ? { volumes } : {}),
  };
}

/** 通过 OpenSandbox Cluster 完成节点分配并代理 OpenSandbox 生命周期请求。 */
export class OpenSandboxClusterProvider implements SandboxProvider {
  private readonly client: ClusterHttpClient;

  constructor(
    private readonly config: OpenSandboxClusterProviderConfig,
    fetchImpl?: FetchImpl,
  ) {
    this.client = new ClusterHttpClient(fetchImpl);
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    const allocation = await this.allocate(input.poolId, input.sandboxId);
    const response = await this.client.json<OpenSandboxResponse>(
      this.config.baseUrl,
      this.config.apiKey,
      `${allocation.proxy_url}/v1/sandboxes`,
      this.config.createTimeoutMs,
      { method: "POST", body: JSON.stringify(createBody(input)) },
    );
    return this.toRef(response);
  }

  async get(providerSandboxId: string, businessSandboxId: string): Promise<SandboxRef | null> {
    try {
      const response = await this.client.json<OpenSandboxResponse>(
        this.config.baseUrl,
        this.config.apiKey,
        this.lifecyclePath(businessSandboxId, providerSandboxId),
        this.config.requestTimeoutMs,
      );
      return this.toRef(response);
    } catch (error) {
      if (this.statusOf(error) === 404) return null;
      throw error;
    }
  }

  async resume(providerSandboxId: string, businessSandboxId: string): Promise<SandboxRef> {
    const response = await this.client.json<OpenSandboxResponse>(
      this.config.baseUrl,
      this.config.apiKey,
      `${this.lifecyclePath(businessSandboxId, providerSandboxId)}/resume`,
      this.config.resumeTimeoutMs,
      { method: "POST" },
    );
    return this.toRef(response);
  }

  async destroy(providerSandboxId: string, businessSandboxId: string): Promise<void> {
    try {
      await this.client.json<void>(
        this.config.baseUrl,
        this.config.apiKey,
        this.lifecyclePath(businessSandboxId, providerSandboxId),
        this.config.destroyTimeoutMs,
        { method: "DELETE" },
      );
    } catch (error) {
      if (this.statusOf(error) !== 404) throw error;
    }
    await this.client.json<void>(
      this.config.baseUrl,
      this.config.apiKey,
      `/api/v1/sandboxes/${encodeURIComponent(businessSandboxId)}/allocation`,
      this.config.destroyTimeoutMs,
      { method: "DELETE" },
    );
  }

  private async allocate(poolId: string, sandboxId: string): Promise<ClusterAllocationResponse> {
    const allocation = await this.client.json<ClusterAllocationResponse>(
      this.config.baseUrl,
      this.config.apiKey,
      `/api/v1/pools/${encodeURIComponent(poolId)}/sandboxes/${encodeURIComponent(sandboxId)}/allocate`,
      this.config.requestTimeoutMs,
      { method: "POST" },
    );
    if (!allocation.proxy_url) {
      throw new SandboxProviderError("Cluster allocation did not return proxy_url", "REMOTE_ERROR", false);
    }
    return allocation;
  }

  private lifecyclePath(businessSandboxId: string, providerSandboxId: string): string {
    return `/api/v1/sandboxes/${encodeURIComponent(businessSandboxId)}/proxy/v1/sandboxes/${encodeURIComponent(providerSandboxId)}`;
  }

  private toRef(response: OpenSandboxResponse): SandboxRef {
    if (!response.id) throw new SandboxProviderError("OpenSandbox response did not contain id", "REMOTE_ERROR", false);
    return { sandboxId: response.id, status: mapStatus(response), payload: response };
  }

  private statusOf(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return;
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
}
