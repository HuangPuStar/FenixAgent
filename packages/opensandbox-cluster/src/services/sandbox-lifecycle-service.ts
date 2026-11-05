import type { Database } from "bun:sqlite";
import { createLogger } from "@fenix/logger";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { OpenSandboxHttpClient } from "../clients/opensandbox-http-client";
import type { ClusterDatabase } from "../db/client";
import { type SandboxBinding, sandboxBinding } from "../db/schema";
import { redactLogValue } from "../logging/redact";
import type { ClusterConfig } from "../types";
import { nativeCreateError } from "./native-create-error";
import type { Resources } from "./resource-accounting";
import { LifecycleError, reserve, terminalStates } from "./resource-allocation";
import { rewriteSandboxCreateBody } from "./sandbox-volume-rewriter";
import { SchedulerLock } from "./scheduler-lock";
import type { ServerService } from "./server-service";
import { ServerTargetResolver } from "./server-target-resolver";

const logger = createLogger("cluster.lifecycle");
/** A workspace-relative host mount supplied by the platform. */
export interface ManagedVolume {
  name: string;
  source: string;
  target: string;
  readOnly?: boolean;
}
/** Caller-owned resources are separate from native sandbox runtime options. */
export interface ManagedCreate {
  sandbox_id: string;
  lease_seconds?: number;
  resources: Resources & { environment?: Record<string, string>; volumes?: ManagedVolume[] };
  sandbox: { image: unknown; entrypoint?: string[]; metadata?: Record<string, string> };
}
/** Canonical hash is stable across object key ordering and excludes resolved defaults. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** Owns durable reservations and native OpenSandbox lifecycle coordination. */
export class SandboxLifecycleService {
  private readonly inFlight = new Set<string>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly lock: SchedulerLock;
  private readonly client: OpenSandboxHttpClient;
  private readonly resolver: ServerTargetResolver;
  constructor(
    private readonly db: ClusterDatabase,
    sqlite: Database,
    private readonly config: ClusterConfig,
    private readonly servers: ServerService,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.lock = new SchedulerLock(sqlite);
    this.client = new OpenSandboxHttpClient(config.proxyConnectTimeoutMs, config.proxyResponseTimeoutMs, fetchImpl);
    this.resolver = new ServerTargetResolver(db, config);
  }
  /** Read managed allocation details, including retained terminal records. */
  find(id: string) {
    const row = this.row(id);
    return row ? this.dto(row) : undefined;
  }
  /** Reserve once; unknown POST results never cause an automatic second POST. */
  create(poolId: string, input: ManagedCreate) {
    const operation = this.createOnce(poolId, input);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  /** Drain accepted creates before closing the durable store. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.operations]);
  }
  private async createOnce(poolId: string, input: ManagedCreate) {
    if (
      !input ||
      typeof input.sandbox_id !== "string" ||
      !input.sandbox_id ||
      !input.resources ||
      !input.sandbox?.image
    )
      throw new LifecycleError("INVALID_REQUEST", 400, "invalid sandbox request");
    const allowed = ["image", "entrypoint", "metadata"];
    if (Object.keys(input.sandbox).some((k) => !allowed.includes(k)))
      throw new LifecycleError("INVALID_REQUEST", 400, "unsupported sandbox option");
    const volumes = input.resources.volumes?.map((item) => {
      if (
        !item ||
        typeof item.name !== "string" ||
        typeof item.source !== "string" ||
        !item.source ||
        typeof item.target !== "string" ||
        !item.target.startsWith("/")
      )
        throw new LifecycleError("INVALID_REQUEST", 400, "invalid workspace volume");
      return { name: item.name, host: { path: item.source }, mountPath: item.target, readOnly: item.readOnly ?? false };
    });
    // Validate traversal before reserving; the actual node root is applied by the existing HTTP client.
    rewriteSandboxCreateBody({ volumes }, "/validation-workspace");
    const hash = new Bun.CryptoHasher("sha256").update(canonical({ ...input, lease_seconds: undefined })).digest("hex");
    let fresh = false;
    const row = this.lock.run(() => {
      fresh = !this.row(input.sandbox_id);
      return reserve(this.db, this.config, poolId, input.sandbox_id, input.resources, hash, input.lease_seconds);
    });
    this.assertLive(row);
    if (!fresh) return this.dto(row);
    this.inFlight.add(row.sandboxId);
    try {
      const body = {
        ...input.sandbox,
        resourceLimits: {
          cpu: `${input.resources.cpu * 1000}m`,
          memory: `${input.resources.memoryMb}Mi`,
          disk: `${input.resources.diskGb}Gi`,
          gpu: String(input.resources.gpuCount),
        },
        env: input.resources.environment,
        volumes,
        timeout: row.leaseSeconds,
        metadata: { ...input.sandbox.metadata, "fenix.cluster.attempt_id": row.attemptId! },
      };
      const response = await this.remote(row, "POST", "/v1/sandboxes", body);
      if (!response.ok) {
        const failure = await nativeCreateError(response, [this.servers.getCredentials(row.serverId)!.apiKey]);
        logger.error("native sandbox creation failed", {
          sandboxId: row.sandboxId,
          serverId: row.serverId,
          attemptId: row.attemptId,
          status: response.status,
          message: failure.message,
          rejected: failure.rejected,
        });
        if (failure.rejected) {
          this.deleteAttempt(row);
          throw new LifecycleError("CREATE_FAILED", 502, failure.message);
        }
        this.patch(row, { state: "uncertain", lastError: `create HTTP ${response.status}` });
      } else {
        const result = (await response.json()) as { id?: string };
        if (!result.id) throw new Error("missing native sandbox id");
        this.patch(row, { providerSandboxId: result.id, state: "active", lastError: null });
      }
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "CREATE_FAILED") throw error;
      this.logFailure(row, "create", error);
      this.patch(row, { state: "uncertain", lastError: `native create result unknown (${this.errorKind(error)})` });
    } finally {
      this.inFlight.delete(row.sandboxId);
    }
    if (row.expiresAt! <= Date.now() && !this.row(row.sandboxId)?.releaseReason)
      await this.release(row.sandboxId, "expiry");
    else if (this.row(row.sandboxId)?.releaseReason) await this.reconcile(row.sandboxId);
    const result = this.find(row.sandboxId);
    if (!result) throw new LifecycleError("ALLOCATION_RELEASED", 410, "allocation deleted");
    return result;
  }
  /** Persist release intent before contacting the node. */
  async release(id: string, reason = "manual") {
    const row = this.row(id);
    if (!row) throw new LifecycleError("NOT_FOUND", 404, "allocation not found");
    if (row.allocationMode !== "resources")
      throw new LifecycleError("INVALID_REQUEST", 400, "managed allocation required");
    if (terminalStates.includes(row.state)) return this.dto(row);
    this.patch(row, { state: "releasing", releaseReason: reason, nextRetryAt: Date.now() });
    await this.reconcile(id);
    return this.find(id) ?? this.dto({ ...row, state: "released" });
  }
  /** Explicit deletion removes history only after the node's destruction is confirmed. */
  async remove(id: string) {
    const original = this.row(id);
    if (!original) throw new LifecycleError("NOT_FOUND", 404, "allocation not found");
    const result = await this.release(id, "delete");
    if (!terminalStates.includes(result.state)) return result;
    this.deleteAttempt(original);
    return;
  }
  /** Reconcile known IDs or metadata-correlated resources; absence cannot prove an unknown POST failed. */
  async reconcile(id: string) {
    let row = this.row(id);
    if (!row || terminalStates.includes(row.state)) return;
    if (row.expiresAt! <= Date.now()) {
      this.patch(row, { state: "releasing", releaseReason: row.releaseReason ?? "expiry" });
      row = this.row(id)!;
    }
    try {
      if (!row.providerSandboxId) {
        const query = new URLSearchParams({
          metadata: new URLSearchParams({ "fenix.cluster.attempt_id": row.attemptId! }).toString(),
          page: "1",
          pageSize: "200",
        });
        const res = await this.remote(row, "GET", "/v1/sandboxes?" + query);
        if (!res.ok) throw new Error(`native sandbox lookup HTTP ${res.status}`);
        const result = (await res.json()) as {
          items: { id: string }[];
          pagination?: { hasNextPage?: boolean; totalItems?: number };
        };
        // One native POST creates one main sandbox. Multiple matches cannot safely establish ownership.
        if (
          result.items.length === 1 &&
          !result.pagination?.hasNextPage &&
          (result.pagination?.totalItems ?? 1) === 1
        ) {
          this.patch(row, { providerSandboxId: result.items[0]!.id, state: "active" });
          row = this.row(id)!;
        } else {
          if (
            row.releaseReason &&
            !this.inFlight.has(id) &&
            result.items.length === 0 &&
            !result.pagination?.hasNextPage &&
            (result.pagination?.totalItems ?? 0) === 0 &&
            /^create HTTP \d{3}(?:;|$)/.test(row.lastError ?? "")
          ) {
            this.patch(row, {
              state: row.releaseReason === "expiry" ? "expired" : "released",
              nextRetryAt: null,
              lastError: null,
            });
            if (this.row(id)?.releaseReason === "delete") this.deleteAttempt(row);
            return;
          }
          this.patch(row, { state: row.releaseReason ? "releasing" : "uncertain", nextRetryAt: Date.now() + 5000 });
          return;
        }
      }
      if (row.releaseReason) {
        if (this.inFlight.has(id)) {
          this.patch(row, { nextRetryAt: Date.now() + 5000 });
          return;
        }
        const res = await this.remote(row, "DELETE", `/v1/sandboxes/${encodeURIComponent(row.providerSandboxId!)}`);
        if (!res.ok && res.status !== 404) throw new Error(`native sandbox delete HTTP ${res.status}`);
        const check = await this.remote(row, "GET", `/v1/sandboxes/${encodeURIComponent(row.providerSandboxId!)}`);
        if (check.status !== 404) throw new Error(`native sandbox destruction unconfirmed (HTTP ${check.status})`);
        this.patch(row, {
          state: row.releaseReason === "expiry" ? "expired" : "released",
          nextRetryAt: null,
          lastError: null,
        });
        if (this.row(id)?.releaseReason === "delete") this.deleteAttempt(row);
      } else this.patch(row, { state: "active", retryCount: 0, nextRetryAt: null, lastError: null });
    } catch (error) {
      this.logFailure(row, "reconcile", error);
      const retries = row.retryCount + 1;
      this.patch(row, {
        retryCount: retries,
        nextRetryAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(retries - 1, 6) * (0.8 + Math.random() * 0.4)),
        lastError: `${/^create HTTP \d{3}(?:;|$)/.test(row.lastError ?? "") ? `${row.lastError!.split(";")[0]}; ` : ""}native lifecycle reconciliation failed (${this.errorKind(error)})`,
      });
      if (retries === 10)
        logger.error("cluster reconciliation repeatedly failed", {
          sandboxId: id,
          serverId: row.serverId,
          attemptId: row.attemptId,
          retries,
        });
    }
  }
  /** Process bounded oldest due work, including expiration ahead of retry backoff. */
  async reconcileDue() {
    const now = Date.now();
    const rows = this.db
      .select()
      .from(sandboxBinding)
      .where(
        and(
          eq(sandboxBinding.allocationMode, "resources"),
          inArray(sandboxBinding.state, ["creating", "active", "uncertain", "releasing"]),
          or(
            and(inArray(sandboxBinding.state, ["creating", "active", "uncertain"]), lte(sandboxBinding.expiresAt, now)),
            and(
              inArray(sandboxBinding.state, ["creating", "uncertain", "releasing"]),
              sql`coalesce(${sandboxBinding.nextRetryAt}, 0) <= ${now}`,
            ),
          ),
        ),
      )
      .orderBy(sql`case when ${sandboxBinding.expiresAt} <= ${now} then 0 else 1 end`, asc(sandboxBinding.nextRetryAt))
      .limit(100)
      .all();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          if (row) await this.reconcile(row.sandboxId);
        }
      }),
    );
  }
  private row(id: string) {
    return this.db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, id)).get();
  }
  private deleteAttempt(original: SandboxBinding) {
    this.lock.run(() =>
      this.db
        .delete(sandboxBinding)
        .where(and(eq(sandboxBinding.sandboxId, original.sandboxId), eq(sandboxBinding.attemptId, original.attemptId!)))
        .run(),
    );
  }
  private errorKind(error: unknown): string {
    return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "UnknownError";
  }
  private logFailure(row: SandboxBinding, operation: string, error: unknown): void {
    logger.error("cluster native lifecycle failure", {
      sandboxId: row.sandboxId,
      serverId: row.serverId,
      attemptId: row.attemptId,
      state: row.state,
      retryCount: row.retryCount,
      operation,
      errorKind: this.errorKind(error),
      error: redactLogValue(error, [
        this.config.clusterServiceApiKey,
        this.config.frpToken,
        new TextDecoder().decode(this.config.serverApiKeyEncryptionKey),
      ]),
    });
  }
  private patch(original: SandboxBinding, change: Partial<SandboxBinding>) {
    this.lock.run(() => {
      const current = this.row(original.sandboxId);
      if (!current || current.attemptId !== original.attemptId || terminalStates.includes(current.state)) return;
      const reason =
        current.releaseReason === "delete" || change.releaseReason === "delete" ? "delete" : current.releaseReason;
      if (current.releaseReason && !terminalStates.includes(change.state ?? "")) {
        change = { ...change, state: "releasing", releaseReason: reason };
      }
      if (current.releaseReason) {
        change.releaseReason = reason;
        if (change.state === "failed") change.state = reason === "expiry" ? "expired" : "released";
      }
      this.db
        .update(sandboxBinding)
        .set({ ...change, updatedAt: Date.now() })
        .where(eq(sandboxBinding.sandboxId, current.sandboxId))
        .run();
    });
  }
  private async remote(row: SandboxBinding, method: string, path: string, body?: unknown) {
    const server = this.servers.getCredentials(row.serverId)!;
    const target = this.resolver.resolve(row.serverId);
    return this.client.request(
      target.baseUrl,
      server.apiKey,
      new Request("http://cluster" + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      path,
      server.workspaceRoot,
      target.hostHeader,
    );
  }
  private assertLive(row: SandboxBinding) {
    if (row.state === "expired") throw new LifecycleError("LEASE_EXPIRED", 410, "lease expired");
    if (row.state === "released") throw new LifecycleError("ALLOCATION_RELEASED", 410, "allocation released");
    if (row.state === "failed") throw new LifecycleError("CREATE_FAILED", 409, "create failed");
  }
  private dto(row: SandboxBinding) {
    return {
      sandbox_id: row.sandboxId,
      pool_id: row.poolId,
      server_id: row.serverId,
      allocation_mode: row.allocationMode,
      state: row.state,
      resources: { cpu: row.cpu, memoryMb: row.memoryMb, diskGb: row.diskGb, gpuCount: row.gpuCount },
      expires_at: row.expiresAt,
      provider_sandbox_id: row.providerSandboxId,
      proxy_url: `/api/v1/sandboxes/${encodeURIComponent(row.sandboxId)}/proxy`,
    };
  }
}
/** Runs bounded reconciliation and drains before its database is closed. */
export class ReconciliationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  constructor(private readonly lifecycle: SandboxLifecycleService) {}
  start() {
    const tick = () => {
      if (!this.pending)
        this.pending = this.lifecycle
          .reconcileDue()
          .catch((error: unknown) => {
            logger.error("sandbox reconciliation batch failed", error);
          })
          .finally(() => {
            this.pending = undefined;
          });
    };
    tick();
    this.timer = setInterval(tick, 5000);
  }
  async stop() {
    clearInterval(this.timer);
    await this.pending;
    await this.lifecycle.drain();
  }
}
