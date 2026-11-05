import type { Allocation, SandboxInput } from "./types";

/** HTTP failure retaining status for lifecycle checks such as confirmed native absence. */
export class ClusterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly createRejected = false,
  ) {
    super(message);
  }
}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Cluster uses raw JSON and 204 responses, so this standalone client owns their adaptation. */
export class ClusterClient {
  constructor(
    private readonly key: () => string,
    private readonly unauthorized: () => void,
    private readonly fetchImpl: Fetcher = (input, init) => fetch(input, init),
  ) {}

  /** Send credentials only in the header, handle timeouts and preserve service errors. */
  async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      text?: boolean;
      ifMatch?: string;
      requireNew?: boolean;
    } = {},
  ): Promise<T> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(130000)])
      : AbortSignal.timeout(130000);
    const response = await this.fetchImpl(path, {
      method: options.method ?? "GET",
      signal,
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${this.key()}`,
        ...(options.ifMatch === undefined ? {} : { "If-Match": JSON.stringify(options.ifMatch) }),
        ...(options.requireNew ? { "If-None-Match": "*" } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 401) this.unauthorized();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const error = (await response.json()) as {
          error?: { message?: string };
          detail?: { message?: string };
          message?: string;
        };
        message = error.error?.message ?? error.detail?.message ?? error.message ?? message;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      throw new ClusterApiError(message, response.status, response.headers.get("X-Cluster-Create-Rejected") === "true");
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (options.text ? text : text.trim() ? JSON.parse(text) : undefined) as T;
  }

  /** Count create reserves first; any unknown native result leaves the reservation for inspection. */
  async createSandbox(poolId: string, mode: string, input: SandboxInput) {
    if (mode === "resources")
      return this.request(`/api/v2/pools/${encodeURIComponent(poolId)}/sandboxes`, { method: "POST", body: input });
    const binding = await this.request<{ proxy_url: string; allocation_etag: string }>(
      `/api/v1/pools/${encodeURIComponent(poolId)}/sandboxes/${encodeURIComponent(input.sandbox_id)}/allocate`,
      { method: "POST", requireNew: true },
    ).catch((error: unknown) => {
      if (error instanceof ClusterApiError && error.status >= 400 && error.status < 500)
        throw new ClusterApiError(error.message, error.status, true);
      throw error;
    });
    return this.request(`${binding.proxy_url}/v1/sandboxes`, {
      method: "POST",
      requireNew: true,
      ifMatch: binding.allocation_etag,
      body: {
        ...input.sandbox,
        resourceLimits: {
          cpu: `${input.resources.cpu * 1000}m`,
          memory: `${input.resources.memoryMb}Mi`,
          disk: `${input.resources.diskGb}Gi`,
          gpu: String(input.resources.gpuCount),
        },
        env: input.resources.environment,
        volumes: input.resources.volumes?.map((v) => ({
          name: v.name,
          host: { path: v.source },
          mountPath: v.target,
          readOnly: v.readOnly ?? false,
        })),
      },
    });
  }

  /** Destroy remotely and confirm 404 before returning a count allocation's capacity. */
  async deleteSandbox(
    item: Pick<Allocation, "sandbox_id" | "provider_sandbox_id" | "allocation_mode" | "proxy_url" | "allocation_etag">,
  ) {
    if (item.allocation_mode === "resources")
      return this.request(`/api/v2/sandboxes/${encodeURIComponent(item.sandbox_id)}`, { method: "DELETE" });
    if (!item.provider_sandbox_id) throw new Error("请先关联真实沙盒 ID");
    const path = `${item.proxy_url}/v1/sandboxes/${encodeURIComponent(item.provider_sandbox_id)}`;
    try {
      await this.request(path, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ClusterApiError) || error.status !== 404) throw error;
    }
    try {
      await this.request(path);
    } catch (error) {
      if (error instanceof ClusterApiError && error.status === 404)
        return this.request(`/api/v1/sandboxes/${encodeURIComponent(item.sandbox_id)}/allocation`, {
          method: "DELETE",
          ifMatch: item.allocation_etag,
        });
      throw error;
    }
    throw new Error("节点尚未确认沙盒销毁，绑定已保留，请稍后重试");
  }
}
