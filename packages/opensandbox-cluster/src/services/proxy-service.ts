import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import { AllocationService } from "./allocation-service";
import { SandboxVolumeRewriteError } from "./sandbox-volume-rewriter";
import { ServerService } from "./server-service";

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ProxyService {
  private readonly client: OpenSandboxHttpClient;

  constructor(
    private readonly servers: ServerService,
    private readonly allocations: AllocationService,
    connectTimeoutMs: number,
    responseTimeoutMs: number,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OpenSandboxHttpClient(connectTimeoutMs, responseTimeoutMs, fetchImpl);
  }

  async proxy(request: Request, path: string, serverId?: string, sandboxId?: string): Promise<Response> {
    let resolvedServerId = serverId;
    if (sandboxId) {
      const allocation = this.allocations.find(sandboxId);
      if (!allocation) throw new ProxyError(404, "sandbox allocation not found");
      resolvedServerId = allocation.server_id;
    }
    if (!resolvedServerId) throw new ProxyError(404, "proxy target not found");
    const credentials = this.servers.getCredentials(resolvedServerId);
    if (!credentials) throw new ProxyError(404, "OpenSandbox Server not found");
    if (credentials.status === "disabled" || credentials.healthStatus === "unhealthy") {
      throw new ProxyError(503, "OpenSandbox Server is unavailable");
    }
    try {
      return await this.client.request(
        credentials.baseUrl,
        credentials.apiKey,
        request,
        path,
        sandboxId,
        credentials.workspaceRoot,
      );
    } catch (error) {
      if (error instanceof SandboxVolumeRewriteError) throw new ProxyError(400, error.message);
      throw new ProxyError(
        error instanceof DOMException && error.name === "TimeoutError" ? 504 : 502,
        "OpenSandbox Server request failed",
      );
    }
  }
}
