import { createLogger } from "@fenix/logger";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import { type SandboxBinding, sandboxBinding } from "../db/schema";
import type { ClusterConfig } from "../types";
import type { AllocationService } from "./allocation-service";
import type { ServerService } from "./server-service";
import { ServerTargetResolver } from "./server-target-resolver";

/** Native metadata connects a conditional count POST to its already committed allocation. */
export const COUNT_ATTEMPT_METADATA_KEY = "opensandbox.cluster.attempt_id";
const logger = createLogger("cluster.count-recovery");

/** Recovers count associations without taking ownership of the legacy native lifecycle. */
export class CountRecoveryService {
  private readonly inFlight = new Map<string, Set<Promise<void>>>();
  private readonly client: OpenSandboxHttpClient;
  private readonly resolver: ServerTargetResolver;

  constructor(
    private readonly db: ClusterDatabase,
    config: ClusterConfig,
    private readonly servers: ServerService,
    private readonly allocations: AllocationService,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OpenSandboxHttpClient(config.proxyConnectTimeoutMs, config.proxyResponseTimeoutMs, fetchImpl);
    this.resolver = new ServerTargetResolver(db, config);
  }

  /** Fence discovery and conditional claims until accepted native POSTs have settled. */
  begin(row: SandboxBinding): () => void {
    const attemptId = row.attemptId!;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const operations = this.inFlight.get(attemptId) ?? new Set<Promise<void>>();
    operations.add(pending);
    this.inFlight.set(attemptId, operations);
    return () => {
      operations.delete(pending);
      if (operations.size === 0 && this.inFlight.get(attemptId) === operations) this.inFlight.delete(attemptId);
      complete();
    };
  }

  /** Management creates must not overtake an already accepted legacy native POST. */
  hasInFlight(attemptId: string | null): boolean {
    return attemptId !== null && this.inFlight.has(attemptId);
  }

  /** Keep the durable store open until accepted count creates have finished. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].flatMap((operations) => [...operations]));
  }

  /** Bound discovery work and retain unresolved reservations instead of repeating native creation. */
  async reconcileDue(): Promise<void> {
    const rows = this.db
      .select()
      .from(sandboxBinding)
      .where(
        and(
          eq(sandboxBinding.allocationMode, "count"),
          inArray(sandboxBinding.state, ["creating", "uncertain"]),
          isNull(sandboxBinding.providerSandboxId),
          isNotNull(sandboxBinding.attemptId),
          sql`coalesce(${sandboxBinding.nextRetryAt}, 0) <= ${Date.now()}`,
        ),
      )
      .orderBy(asc(sandboxBinding.nextRetryAt), asc(sandboxBinding.sandboxId))
      .limit(100)
      .all();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          if (row && !this.inFlight.has(row.attemptId!)) await this.reconcile(row);
        }
      }),
    );
  }

  private async reconcile(row: SandboxBinding): Promise<void> {
    try {
      const server = this.servers.getCredentials(row.serverId);
      if (!server) throw new Error("count recovery server unavailable");
      const target = this.resolver.resolve(row.serverId);
      const query = new URLSearchParams({
        metadata: new URLSearchParams({ [COUNT_ATTEMPT_METADATA_KEY]: row.attemptId! }).toString(),
        page: "1",
        pageSize: "200",
      });
      const path = `/v1/sandboxes?${query}`;
      const response = await this.client.request(
        target.baseUrl,
        server.apiKey,
        new Request(`http://cluster${path}`),
        path,
        server.workspaceRoot,
        target.hostHeader,
      );
      if (!response.ok) throw new Error(`native count lookup HTTP ${response.status}`);
      const result: unknown = await response.json();
      const providerId = this.uniqueProviderId(result, row.attemptId!);
      if (!providerId) {
        this.retry(row, "native count association unresolved");
        return;
      }
      if (!this.inFlight.has(row.attemptId!)) this.allocations.rememberProviderId(row, providerId);
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : "UnknownError";
      logger.error("count association recovery failed", {
        sandboxId: row.sandboxId,
        serverId: row.serverId,
        attemptId: row.attemptId,
        errorKind,
      });
      try {
        this.retry(row, `native count association recovery failed (${errorKind})`);
      } catch (retryError) {
        logger.error("count recovery retry scheduling failed", {
          sandboxId: row.sandboxId,
          attemptId: row.attemptId,
          errorKind: retryError instanceof Error ? retryError.name : "UnknownError",
        });
      }
    }
  }

  private uniqueProviderId(result: unknown, attemptId: string): string | undefined {
    if (
      !result ||
      typeof result !== "object" ||
      !("items" in result) ||
      !Array.isArray(result.items) ||
      result.items.length !== 1 ||
      !("pagination" in result)
    )
      return;
    const pagination = result.pagination;
    if (
      !pagination ||
      typeof pagination !== "object" ||
      !("totalItems" in pagination) ||
      pagination.totalItems !== 1 ||
      !("hasNextPage" in pagination) ||
      pagination.hasNextPage !== false
    )
      return;
    const item: unknown = result.items[0];
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id ||
      !("metadata" in item) ||
      !item.metadata ||
      typeof item.metadata !== "object" ||
      !(COUNT_ATTEMPT_METADATA_KEY in item.metadata) ||
      item.metadata[COUNT_ATTEMPT_METADATA_KEY] !== attemptId
    )
      return;
    return item.id;
  }

  private retry(row: SandboxBinding, lastError: string): void {
    const retryCount = row.retryCount + 1;
    this.db
      .update(sandboxBinding)
      .set({
        retryCount,
        lastError,
        updatedAt: Date.now(),
        nextRetryAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(retryCount - 1, 6)),
      })
      .where(
        and(
          eq(sandboxBinding.sandboxId, row.sandboxId),
          eq(sandboxBinding.attemptId, row.attemptId!),
          eq(sandboxBinding.allocationMode, "count"),
          isNull(sandboxBinding.providerSandboxId),
          inArray(sandboxBinding.state, ["creating", "uncertain"]),
        ),
      )
      .run();
  }
}
