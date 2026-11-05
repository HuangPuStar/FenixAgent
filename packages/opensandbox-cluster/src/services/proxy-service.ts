import { createLogger } from "@fenix/logger";
import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import type { ClusterConfig } from "../types";
import type { AllocationService } from "./allocation-service";
import { nativeCreateError } from "./native-create-error";
import { nativeResources } from "./native-resources";
import { LifecycleError } from "./resource-allocation";
import { isSandboxCreateRequest, SandboxVolumeRewriteError } from "./sandbox-volume-rewriter";
import type { ServerService } from "./server-service";
import type { ServerTarget } from "./server-target-resolver";
import { ServerTargetError, ServerTargetResolver } from "./server-target-resolver";

const logger = createLogger("cluster.proxy");

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "PROXY_ERROR",
    options?: ErrorOptions,
  ) {
    super(message, options);
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

  /** Conditional console creates roll back only when the node has definitely rejected creation. */
  async proxy(request: Request, path: string, serverId?: string, sandboxId?: string): Promise<Response> {
    const conditional =
      sandboxId && request.headers.get("if-none-match") === "*" && isSandboxCreateRequest(request.method, path);
    const original = conditional ? this.allocations.binding(sandboxId) : undefined;
    if (!conditional || original?.allocationMode !== "count") return this.forward(request, path, serverId, sandboxId);
    try {
      const etag: unknown = JSON.parse(request.headers.get("if-match") ?? "null");
      if (typeof etag !== "string") throw new ProxyError(400, "If-Match is required for conditional create");
      this.allocations.beginCountCreate(original.sandboxId, etag);
    } catch (error) {
      if (error instanceof LifecycleError) throw new ProxyError(error.status, error.message, error.code);
      if (error instanceof SyntaxError) throw new ProxyError(400, "invalid If-Match");
      throw error;
    }
    try {
      const response = await this.forward(request, path, serverId, sandboxId);
      if (!response.ok) {
        const failure = await nativeCreateError(response.clone(), [
          this.servers.getCredentials(original.serverId)!.apiKey,
        ]);
        this.allocations.finishCountCreate(original, failure.rejected);
        if (failure.rejected) response.headers.set("X-Cluster-Create-Rejected", "true");
      } else if (!this.allocations.binding(original.sandboxId)?.providerSandboxId) {
        this.allocations.finishCountCreate(original, false);
      }
      return response;
    } catch (error) {
      const rejected = error instanceof ProxyError && ![502, 504].includes(error.status);
      this.allocations.finishCountCreate(original, rejected);
      if (rejected)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          {
            status: error.status,
            headers: { "X-Cluster-Create-Rejected": "true" },
          },
        );
      throw error;
    }
  }

  private async forward(request: Request, path: string, serverId?: string, sandboxId?: string): Promise<Response> {
    let resolvedServerId = serverId;
    if (sandboxId) {
      const allocation = this.allocations.find(sandboxId);
      if (!allocation) throw new ProxyError(404, "sandbox allocation not found");
      resolvedServerId = allocation.server_id;
    }
    if (!resolvedServerId) throw new ProxyError(404, "proxy target not found");
    const credentials = this.servers.getCredentials(resolvedServerId);
    const managed = sandboxId ? this.allocations.binding(sandboxId) : undefined;
    if (managed?.allocationMode === "resources") {
      if (
        !/^\/?v1\/sandboxes\//.test(path) ||
        /[\\]|%2f|%5c/i.test(path) ||
        Array.from(path).some((character) => character.charCodeAt(0) < 32)
      )
        throw new ProxyError(403, "invalid managed proxy path");
      if (managed.state === "released") throw new ProxyError(410, "allocation released", "ALLOCATION_RELEASED");
      if (managed.state === "failed") throw new ProxyError(409, "create failed", "CREATE_FAILED");
      if (managed.state === "expired" || (managed.expiresAt ?? Infinity) <= Date.now())
        throw new ProxyError(410, "lease expired", "LEASE_EXPIRED");
      if (managed.state !== "active") throw new ProxyError(409, "allocation is not active");
      const normalized = new URL(path, "http://cluster").pathname;
      const prefix = `/v1/sandboxes/${encodeURIComponent(managed.providerSandboxId ?? "")}`;
      if (!managed.providerSandboxId || !(normalized === prefix || normalized.startsWith(`${prefix}/`)))
        throw new ProxyError(403, "managed sandbox target mismatch");
      const suffix = normalized.slice(prefix.length);
      const read = ["GET", "HEAD"].includes(request.method);
      if (
        !read &&
        !(suffix.startsWith("/proxy/") || (request.method === "POST" && ["/pause", "/resume"].includes(suffix)))
      )
        throw new ProxyError(403, "managed lifecycle mutation forbidden");
    } else if (credentials?.schedulingMode === "resources") {
      throw new ProxyError(403, "resource nodes require a sandbox binding");
    }
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
    const createSnapshot =
      managed?.allocationMode === "count" && isSandboxCreateRequest(request.method, path) ? request.clone() : undefined;
    try {
      const response = await this.client.request(
        target.baseUrl,
        credentials.apiKey,
        request,
        path,
        credentials.workspaceRoot,
        target.hostHeader,
      );
      if (managed?.allocationMode === "count" && response.ok && isSandboxCreateRequest(request.method, path)) {
        try {
          const result: unknown = await response.clone().json();
          if (result && typeof result === "object" && "id" in result && typeof result.id === "string")
            this.allocations.rememberProviderId(managed, result.id, nativeResources(await createSnapshot?.json()));
        } catch (error) {
          // Observing an ID must not turn an already successful native create into a caller-visible failure.
          logger.error("count sandbox ID observation failed", {
            sandboxId,
            serverId: resolvedServerId,
            errorKind: error instanceof Error ? error.name : "UnknownError",
            error,
          });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof SandboxVolumeRewriteError) throw new ProxyError(400, error.message);
      throw new ProxyError(
        error instanceof DOMException && error.name === "TimeoutError" ? 504 : 502,
        "OpenSandbox Server request failed",
        "PROXY_ERROR",
        { cause: error },
      );
    }
  }
}
