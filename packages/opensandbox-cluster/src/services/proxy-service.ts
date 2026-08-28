import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import type { ClusterConfig } from "../types";
import type { AllocationService } from "./allocation-service";
import { SandboxVolumeRewriteError } from "./sandbox-volume-rewriter";
import type { ServerService } from "./server-service";
import type { ServerTarget } from "./server-target-resolver";
import { ServerTargetError, ServerTargetResolver } from "./server-target-resolver";

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
    db?: ClusterDatabase,
    config?: ClusterConfig,
    private readonly recoverTunnel?: (serverId: string) => Promise<boolean>,
  ) {
    this.client = new OpenSandboxHttpClient(connectTimeoutMs, responseTimeoutMs, fetchImpl);
    this.resolver = db && config ? new ServerTargetResolver(db, config) : undefined;
  }

  private readonly resolver?: ServerTargetResolver;

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
    if (credentials.status === "disabled") {
      throw new ProxyError(503, "OpenSandbox Server is unavailable");
    }
    let target: ServerTarget;
    try {
      if (!this.resolver && !credentials.baseUrl) throw new ProxyError(503, "OpenSandbox Server has no direct address");
      target = this.resolver?.resolve(resolvedServerId) ?? {
        baseUrl: credentials.baseUrl as string,
        transportMode: "direct" as const,
      };
    } catch (error) {
      if (error instanceof ServerTargetError && error.code === "SERVER_DISCONNECTED" && this.recoverTunnel) {
        const recovered = await this.recoverTunnel(resolvedServerId);
        if (recovered && this.resolver) {
          try {
            target = this.resolver.resolve(resolvedServerId);
          } catch (retryError) {
            if (retryError instanceof ServerTargetError) throw new ProxyError(503, retryError.message);
            throw retryError;
          }
        } else {
          throw new ProxyError(503, error.message);
        }
      } else if (error instanceof ServerTargetError) {
        throw new ProxyError(503, error.message);
      } else {
        throw error;
      }
    }
    try {
      return await this.client.request(
        target.baseUrl,
        credentials.apiKey,
        request,
        path,
        credentials.workspaceRoot,
        target.hostHeader,
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
