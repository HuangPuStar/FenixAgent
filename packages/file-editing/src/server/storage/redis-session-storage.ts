import { randomUUID } from "node:crypto";
import { EditingError } from "../../../contracts";
import {
  commitReservationMs,
  contentDigest,
  type EditingPolicy,
  type EditingSessionRecord,
  editingPolicy,
  isWritable,
  recoverAbandonedCommit,
  sessionFileKey,
} from "../session-state";
import type { EditingLease, EditingSessionStorage } from "../session-storage";
import { ASSERT_LEASE, CREATE_SESSION, PUT_SESSION, RELEASE_LEASE, RENEW_LEASE, REVOKE_SESSION } from "./redis-scripts";

/** Existing Redis connection surface; this adapter neither creates nor closes the connection. */
export interface EditingRedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
/** Host-facing alias for the injected existing Redis client port. */
export type EditingRedis = EditingRedisPort;
/** Redis key namespace and construction-time policy; no deployment knobs are added. */
export interface RedisEditingStorageOptions {
  prefix?: string;
  policy?: Partial<EditingPolicy>;
  now?: () => number;
}

class RedisEditingSessionStorage implements EditingSessionStorage {
  private readonly prefix: string;
  private readonly policy: EditingPolicy;
  private readonly now: () => number;
  private disposed = false;
  constructor(
    private readonly redis: EditingRedisPort,
    options: RedisEditingStorageOptions,
  ) {
    // Global quota and tenant claims must share a hash slot when the injected connection is a Cluster.
    this.prefix = `${options.prefix ?? "fenix:file-editing:v1"}:{file-editing}`;
    this.policy = editingPolicy(options.policy);
    this.now = options.now ?? Date.now;
  }
  private index(id: string): string {
    return `${this.prefix}:index:${id}`;
  }
  private keys(record: EditingSessionRecord): string[] {
    const scoped = [record.scope.organizationId, record.scope.userId, record.scope.environmentId]
      .map(encodeURIComponent)
      .join(":");
    const user = contentDigest(
      new TextEncoder().encode(JSON.stringify([record.scope.organizationId, record.scope.userId])),
    );
    return [
      `${this.prefix}:session:${scoped}:${record.id}`,
      this.index(record.id),
      `${this.prefix}:file:${scoped}:${sessionFileKey(record)}`,
      `${this.prefix}:sessions`,
      `${this.prefix}:user:${user}`,
    ];
  }
  private ttl(record: EditingSessionRecord): number {
    return Math.max(1, Math.ceil(record.hardExpiresAt + this.policy.receiptTtlMs - this.now()));
  }
  async create(record: EditingSessionRecord): Promise<void> {
    this.available();
    const claimedId = await this.redis.get(this.keys(record)[2] ?? "");
    const claimed = claimedId ? await this.get(claimedId) : undefined;
    if (claimed?.commitOwner && claimed.commitExpiresAt && claimed.commitExpiresAt <= this.now()) {
      if (await this.redis.get(`${this.keys(claimed)[0]}:lease`))
        throw new EditingError("busy", "Office file commit is still active");
      await this.withLease(claimed.id, async () => {});
    }
    const admitted = Number(
      await this.redis.eval(
        CREATE_SESSION,
        5,
        ...this.keys(record),
        JSON.stringify(record),
        record.id,
        this.ttl(record),
        record.expiresAt,
        this.now(),
        this.policy.maxSessions,
        this.policy.maxUserSessions,
      ),
    );
    if (admitted !== 1)
      throw new EditingError(
        "busy",
        admitted === -1 ? "File already has an editing session" : "Editing session limit reached",
      );
  }
  async get(id: string): Promise<EditingSessionRecord | undefined> {
    this.available();
    const key = await this.redis.get(this.index(id));
    if (!key) return;
    const raw = await this.redis.get(key);
    if (!raw) return;
    const record = JSON.parse(raw) as EditingSessionRecord;
    if (
      record.id !== id ||
      !record.scope ||
      typeof record.scope.organizationId !== "string" ||
      typeof record.scope.userId !== "string" ||
      typeof record.scope.environmentId !== "string" ||
      this.keys(record)[0] !== key
    )
      throw new EditingError("unavailable", "Invalid Office session storage record");
    // Redis Lua cjson round-trips an empty JSON array as an empty object.
    for (const field of ["completed", "requests"] as const) {
      const value: unknown = record[field];
      if (Array.isArray(value)) continue;
      if (!value || typeof value !== "object" || Object.keys(value).length !== 0)
        throw new EditingError("unavailable", "Invalid Office session storage list");
      record[field] = [];
    }
    return record;
  }
  async put(record: EditingSessionRecord, lease: EditingLease): Promise<void> {
    this.available();
    if (record.commitOwner === lease.owner) record.commitExpiresAt = this.now() + commitReservationMs(this.policy);
    const reservationExpiresAt = record.commitOwner
      ? Math.max(record.expiresAt, record.commitExpiresAt ?? record.expiresAt)
      : record.expiresAt;
    const result = Number(
      await this.redis.eval(
        PUT_SESSION,
        6,
        ...this.keys(record),
        lease.key,
        JSON.stringify(record),
        record.id,
        this.ttl(record),
        reservationExpiresAt,
        this.now(),
        record.commitOwner || isWritable(record, this.now()) ? 1 : 0,
        "",
        lease.owner,
      ),
    );
    if (result !== 1)
      throw new EditingError(result === -3 ? "expired" : "busy", "Office session write lease or file claim was lost");
  }
  async revoke(id: string): Promise<boolean> {
    const record = await this.get(id);
    if (!record) return false;
    const [key, , claim, global, user] = this.keys(record);
    return Number(await this.redis.eval(REVOKE_SESSION, 4, key ?? "", claim ?? "", global ?? "", user ?? "", id)) === 2;
  }
  async withLease<T>(id: string, action: (lease: EditingLease) => Promise<T>): Promise<T> {
    this.available();
    const record = await this.get(id);
    const key = record ? `${this.keys(record)[0]}:lease` : `${this.prefix}:missing-lease:${encodeURIComponent(id)}`;
    const owner = randomUUID();
    const leaseMs = Math.max(this.policy.timeoutMs * 3, 1000);
    const deadline = this.now() + this.policy.timeoutMs;
    const started = Date.now();
    while ((await this.redis.set(key, owner, "PX", leaseMs, "NX")) !== "OK") {
      this.available();
      if (this.now() >= deadline || Date.now() - started >= this.policy.timeoutMs)
        throw new EditingError("busy", "Office session is busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    let lost: unknown;
    let held = true;
    const timer = setInterval(
      () => {
        const [recordKey, , claim, global, user] = record ? this.keys(record) : [];
        void this.redis
          .eval(
            RENEW_LEASE,
            5,
            key,
            recordKey ?? `${key}:record`,
            claim ?? `${key}:claim`,
            global ?? `${key}:global`,
            user ?? `${key}:user`,
            owner,
            leaseMs,
            this.now(),
            commitReservationMs(this.policy),
          )
          .then(
            (result) => {
              if (Number(result) !== 1) lost = new EditingError("busy", "Session lease was lost");
            },
            (error: unknown) => {
              lost = error;
            },
          );
      },
      Math.floor(leaseMs / 3),
    );
    timer.unref();
    const lease: EditingLease = {
      key,
      owner,
      assertHeld: async () => {
        this.available();
        if (!held || lost || Number(await this.redis.eval(ASSERT_LEASE, 1, key, owner)) !== 1)
          throw new EditingError("busy", "Session lease was lost");
      },
    };
    try {
      const latest = await this.get(id);
      if (latest && recoverAbandonedCommit(latest, owner, this.now())) await this.put(latest, lease);
      return await action(lease);
    } finally {
      held = false;
      clearInterval(timer);
      await this.redis.eval(RELEASE_LEASE, 1, key, owner);
    }
  }
  private available(): void {
    if (this.disposed) throw new EditingError("unavailable", "Editing session storage stopped");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Use the host's shared Redis connection for cross-replica quotas, claims and save leases. */
export function createRedisEditingSessionStorage(
  redis: EditingRedisPort,
  options: RedisEditingStorageOptions = {},
): EditingSessionStorage {
  return new RedisEditingSessionStorage(redis, options);
}
