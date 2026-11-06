import { and, eq, isNull, or } from "drizzle-orm";
import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import { sandboxBinding } from "../db/schema";
import { redactLogValue } from "../logging/redact";
import type { ClusterConfig } from "../types";
import { COUNT_ATTEMPT_METADATA_KEY } from "./count-recovery-service";
import { nativeResources } from "./native-resources";
import { LifecycleError } from "./resource-allocation";
import type { ServerService } from "./server-service";
import { ServerTargetError, ServerTargetResolver } from "./server-target-resolver";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LifecycleError("INVALID_NODE_RESPONSE", 502, "node returned an invalid sandbox response");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads live node inventory without persisting it or taking ownership of unbound sandboxes. */
export class NodeReconciliationService {
  private readonly client: OpenSandboxHttpClient;
  private readonly resolver: ServerTargetResolver;
  private readonly secrets: string[];

  constructor(
    private readonly db: ClusterDatabase,
    config: ClusterConfig,
    private readonly servers: ServerService,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OpenSandboxHttpClient(config.proxyConnectTimeoutMs, config.proxyResponseTimeoutMs, fetchImpl);
    this.resolver = new ServerTargetResolver(db, config);
    this.secrets = [config.clusterServiceApiKey, config.frpToken];
  }

  /** Pagination follows the node's inventory; a page may contain no unbound candidates. */
  async list(serverId: string, page = 1, pageSize = 50) {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const response = await this.remote(serverId, "GET", `/v1/sandboxes?${query}`);
    this.requireSuccess(response);
    const data = object(await response.json());
    const pagination = object(data.pagination);
    if (!Array.isArray(data.items) || typeof pagination.hasNextPage !== "boolean")
      throw new LifecycleError("INVALID_NODE_RESPONSE", 502, "node returned an invalid sandbox list");
    const items = data.items
      .map((item) => this.view(item, serverId))
      .filter((item) => !this.isBound(item.provider_sandbox_id, item.attempt_id));
    return { items, page, pageSize, hasNextPage: pagination.hasNextPage };
  }

  /** Recheck native identity and current bindings immediately before an explicit administrator deletion. */
  async remove(serverId: string, nativeId: string): Promise<void> {
    const path = `/v1/sandboxes/${encodeURIComponent(nativeId)}`;
    const response = await this.remote(serverId, "GET", path);
    if (response.status === 404) return;
    this.requireSuccess(response);
    const item = this.view(await response.json(), serverId);
    if (item.provider_sandbox_id !== nativeId)
      throw new LifecycleError("INVALID_NODE_RESPONSE", 502, "node sandbox identity mismatch");
    if (this.isBound(nativeId, item.attempt_id))
      throw new LifecycleError(
        "SANDBOX_BOUND",
        409,
        "sandbox now has a binding; refresh reconciliation before deleting",
      );
    const deleted = await this.remote(serverId, "DELETE", path);
    if (deleted.status !== 404) this.requireSuccess(deleted);
    const check = await this.remote(serverId, "GET", path);
    if (check.status !== 404)
      throw new LifecycleError(
        "DESTRUCTION_UNCONFIRMED",
        502,
        "node has not confirmed sandbox destruction; refresh and retry",
      );
  }

  private isBound(nativeId: string, attemptId: string | null): boolean {
    // Provider IDs are globally unique; consider other registrations of the same physical node as well.
    return (
      this.db
        .select({ id: sandboxBinding.sandboxId })
        .from(sandboxBinding)
        .where(
          or(
            eq(sandboxBinding.providerSandboxId, nativeId),
            attemptId
              ? and(isNull(sandboxBinding.providerSandboxId), eq(sandboxBinding.attemptId, attemptId))
              : undefined,
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  private view(value: unknown, serverId: string) {
    const item = object(value);
    if (typeof item.id !== "string" || !item.id)
      throw new LifecycleError("INVALID_NODE_RESPONSE", 502, "node sandbox ID is missing");
    const rawMetadata =
      item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? Object.fromEntries(
            Object.entries(item.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {};
    const secrets = [...this.secrets, this.servers.getCredentials(serverId)?.apiKey ?? ""];
    const metadata = Object.fromEntries(
      Object.entries(object(redactLogValue(rawMetadata, secrets))).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const image = item.image && typeof item.image === "object" ? optionalString(object(item.image).uri) : null;
    return {
      provider_sandbox_id: item.id,
      created_at: optionalString(item.createdAt),
      expires_at: optionalString(item.expiresAt),
      state: item.status && typeof item.status === "object" ? optionalString(object(item.status).state) : null,
      image: typeof image === "string" ? String(redactLogValue(image, secrets)) : null,
      entrypoint: Array.isArray(item.entrypoint)
        ? item.entrypoint
            .filter((part): part is string => typeof part === "string")
            .map((part) => String(redactLogValue(part, secrets)))
        : [],
      metadata,
      attempt_id: rawMetadata[COUNT_ATTEMPT_METADATA_KEY] ?? null,
      resources: nativeResources(item) ?? null,
    };
  }

  private requireSuccess(response: Response): void {
    if (!response.ok)
      throw new LifecycleError("NODE_REQUEST_FAILED", 502, `node reconciliation HTTP ${response.status}`);
  }

  private async remote(serverId: string, method: string, path: string): Promise<Response> {
    const server = this.servers.getCredentials(serverId);
    if (!server) throw new LifecycleError("NOT_FOUND", 404, "server not found");
    try {
      const target = this.resolver.resolve(serverId);
      return await this.client.request(
        target.baseUrl,
        server.apiKey,
        new Request(`http://cluster${path}`, { method }),
        path,
        server.workspaceRoot,
        target.hostHeader,
      );
    } catch (error) {
      if (error instanceof ServerTargetError) throw new LifecycleError(error.code, 503, error.message);
      throw new Error("node reconciliation request failed", { cause: error });
    }
  }
}
