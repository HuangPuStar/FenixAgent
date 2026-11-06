import { createLogger } from "@fenix/logger";
import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import type { SandboxBinding } from "../db/schema";
import { recordRequestError } from "../logging/http-logger";
import type { ClusterConfig } from "../types";
import type { AllocationService } from "./allocation-service";
import { COUNT_ATTEMPT_METADATA_KEY, type CountRecoveryService } from "./count-recovery-service";
import { type NativeResources, nativeResources } from "./native-resources";
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
    private readonly countRecovery?: CountRecoveryService,
  ) {
    this.client = new OpenSandboxHttpClient(connectTimeoutMs, responseTimeoutMs, fetchImpl);
    this.resolver = db && config ? new ServerTargetResolver(db, config) : undefined;
  }

  private readonly resolver?: ServerTargetResolver;

  /** Failed management creates release their reservation; native leftovers are handled by reconciliation. */
  async proxy(request: Request, path: string, serverId?: string, sandboxId?: string): Promise<Response> {
    const create = sandboxId && isSandboxCreateRequest(request.method, path);
    const conditional = create && request.headers.get("if-none-match") === "*";
    const original = create ? this.allocations.binding(sandboxId) : undefined;
    if (!conditional || original?.allocationMode !== "count") {
      const complete = original?.allocationMode === "count" ? this.countRecovery?.begin(original) : undefined;
      try {
        return await this.forward(request, path, serverId, sandboxId);
      } finally {
        complete?.();
      }
    }
    if (this.countRecovery?.hasInFlight(original.attemptId))
      throw new ProxyError(409, "allocation creation is already in progress", "ALLOCATION_CHANGED");
    try {
      const etag: unknown = JSON.parse(request.headers.get("if-match") ?? "null");
      if (typeof etag !== "string") throw new ProxyError(400, "If-Match is required for conditional create");
      this.allocations.beginCountCreate(original.sandboxId, etag);
    } catch (error) {
      if (error instanceof LifecycleError) throw new ProxyError(error.status, error.message, error.code);
      if (error instanceof SyntaxError) throw new ProxyError(400, "invalid If-Match");
      throw error;
    }
    const complete = this.countRecovery?.begin(original);
    try {
      const forwarded = await this.withCountAttempt(request, original.attemptId!);
      this.assertCountBinding(original);
      const response = await this.forward(forwarded, path, serverId, sandboxId);
      if (response.ok) {
        // Native creation has committed even if every local completion write is unavailable.
        try {
          if (!this.allocations.binding(original.sandboxId)?.providerSandboxId)
            this.allocations.finishCountCreate(original, false);
        } catch (error) {
          this.logObservationFailure(sandboxId, original.serverId, error);
        }
        return response;
      }
      this.allocations.finishCountCreate(original, true);
      response.headers.set("X-Cluster-Create-Rejected", "true");
      return response;
    } catch (error) {
      recordRequestError(request, error);
      this.allocations.finishCountCreate(original, true);
      if (error instanceof ProxyError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          {
            status: error.status,
            headers: { "X-Cluster-Create-Rejected": "true" },
          },
        );
      throw error;
    } finally {
      complete?.();
    }
  }

  private async withCountAttempt(request: Request, attemptId: string): Promise<Request> {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      throw new ProxyError(400, "sandbox create body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ProxyError(400, "sandbox create body must be an object");
    const metadata = "metadata" in body ? body.metadata : undefined;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata)))
      throw new ProxyError(400, "sandbox metadata must be an object");
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request, {
      headers,
      body: JSON.stringify({ ...body, metadata: { ...metadata, [COUNT_ATTEMPT_METADATA_KEY]: attemptId } }),
    });
  }

  private async forward(request: Request, path: string, serverId?: string, sandboxId?: string): Promise<Response> {
    this.assertCountCreateAvailable(request, path, sandboxId);
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
    // Tunnel recovery can yield while a management create claims this binding.
    this.assertCountCreateAvailable(request, path, sandboxId);
    if (managed?.allocationMode === "count" && isSandboxCreateRequest(request.method, path))
      this.assertCountBinding(managed);
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
          if (result && typeof result === "object" && "id" in result && typeof result.id === "string") {
            let resources: NativeResources | undefined;
            try {
              resources = nativeResources(await createSnapshot?.json());
            } catch (error) {
              this.logObservationFailure(sandboxId, resolvedServerId, error);
            }
            try {
              this.allocations.rememberProviderId(managed, result.id, resources);
            } catch (error) {
              this.logObservationFailure(sandboxId, resolvedServerId, error);
              this.allocations.rememberProviderId(managed, result.id, resources);
            }
          }
        } catch (error) {
          // Observing an ID must not turn an already successful native create into a caller-visible failure.
          this.logObservationFailure(sandboxId, resolvedServerId, error);
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

  /** Manual unbinding can replace an allocation while body parsing or tunnel recovery is awaiting. */
  private assertCountBinding(original: SandboxBinding): void {
    const current = this.allocations.binding(original.sandboxId);
    if (
      current?.allocationMode !== "count" ||
      current.attemptId !== original.attemptId ||
      current.serverId !== original.serverId ||
      current.createdAt !== original.createdAt
    )
      throw new ProxyError(409, "allocation changed before sandbox creation", "ALLOCATION_CHANGED");
  }

  private assertCountCreateAvailable(request: Request, path: string, sandboxId?: string): void {
    if (!sandboxId || request.headers.get("if-none-match") === "*" || !isSandboxCreateRequest(request.method, path))
      return;
    const current = this.allocations.binding(sandboxId);
    if (current?.allocationMode === "count" && ["creating", "uncertain"].includes(current.state))
      throw new ProxyError(409, "allocation creation is already in progress or unresolved", "ALLOCATION_CHANGED");
  }

  private logObservationFailure(sandboxId: string | undefined, serverId: string, error: unknown): void {
    logger.error("count sandbox ID observation failed", {
      sandboxId,
      serverId,
      errorKind: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
