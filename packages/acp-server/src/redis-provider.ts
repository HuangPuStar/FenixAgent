// packages/acp-server/src/redis-provider.ts

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";

const REDIS_KEY_PREFIX = "yjs:";
const REDIS_CHANNEL_PREFIX = "yjs:channel:";
const SNAPSHOT_PERSIST_RETRIES = 5;

type RedisSnapshotTransaction = {
  set(key: string, value: Buffer): RedisSnapshotTransaction;
  exec(): Promise<unknown | null>;
};

type RedisSnapshotConnection = {
  watch(key: string): Promise<unknown>;
  unwatch(): Promise<unknown>;
  getBuffer(key: string): Promise<Buffer | null>;
  multi(): RedisSnapshotTransaction;
  disconnect(): void;
};

function mergeSnapshotUpdates(existingRaw: Buffer | null, localFull: Uint8Array): Uint8Array {
  if (!existingRaw) return localFull;

  try {
    return Y.mergeUpdates([new Uint8Array(existingRaw), localFull]);
  } catch {
    // 兼容此前错误写入的 base64 快照；新写入始终为原始二进制。
    return Y.mergeUpdates([new Uint8Array(Buffer.from(existingRaw.toString(), "base64")), localFull]);
  }
}

/**
 * 使用专用连接将本地完整 Yjs 状态与 Redis 中的状态原子合并。
 * WATCH 必须只存在于此连接，不能污染全局命令连接或 Pub/Sub subscriber。
 */
export async function mergeYjsSnapshotWithCas(
  persistence: RedisSnapshotConnection,
  redisKey: string,
  localFull: Uint8Array,
): Promise<boolean> {
  for (let attempt = 0; attempt < SNAPSHOT_PERSIST_RETRIES; attempt += 1) {
    let watched = false;
    try {
      await persistence.watch(redisKey);
      watched = true;
      const existingRaw = await persistence.getBuffer(redisKey);
      const merged = mergeSnapshotUpdates(existingRaw, localFull);
      const result = await persistence.multi().set(redisKey, Buffer.from(merged)).exec();
      watched = false; // EXEC 会自动 UNWATCH。
      if (result !== null) return true;
    } finally {
      if (watched) await persistence.unwatch().catch(() => {});
    }
  }

  return false;
}

/** 为临时调用方创建隔离连接，避免其 WATCH 状态影响主 Redis 连接。 */
export async function persistYjsSnapshotWithCas(
  redis: Redis | Cluster,
  redisKey: string,
  localFull: Uint8Array,
): Promise<boolean> {
  const persistence = redis.duplicate() as unknown as RedisSnapshotConnection;
  try {
    return await mergeYjsSnapshotWithCas(persistence, redisKey, localFull);
  } finally {
    try {
      persistence.disconnect();
    } catch {}
  }
}

/**
 * 原子地持久化一个清空后的会话快照。
 *
 * 与普通合并 CAS 不同，冲突重试时会重新读取 Redis 当前状态并再次清空，
 * 因此清空者未见的并发内容不会被 Yjs 合并重新带回。
 */
export async function persistYjsClearedSnapshotWithCas(
  redis: Redis | Cluster,
  redisKey: string,
  localBaseline: Uint8Array,
  clear: (ydoc: Y.Doc) => void,
): Promise<boolean> {
  const persistence = redis.duplicate() as unknown as RedisSnapshotConnection;
  try {
    for (let attempt = 0; attempt < SNAPSHOT_PERSIST_RETRIES; attempt += 1) {
      let watched = false;
      const clearedDoc = new Y.Doc();
      try {
        await persistence.watch(redisKey);
        watched = true;
        const existingRaw = await persistence.getBuffer(redisKey);
        if (existingRaw) {
          try {
            Y.applyUpdate(clearedDoc, new Uint8Array(existingRaw));
          } catch {
            // 兼容此前错误写入的 base64 快照；新写入始终为原始二进制。
            Y.applyUpdate(clearedDoc, new Uint8Array(Buffer.from(existingRaw.toString(), "base64")));
          }
        }
        Y.applyUpdate(clearedDoc, localBaseline);
        clear(clearedDoc);

        const result = await persistence
          .multi()
          .set(redisKey, Buffer.from(Y.encodeStateAsUpdate(clearedDoc)))
          .exec();
        watched = false; // EXEC 会自动 UNWATCH。
        if (result !== null) return true;
      } finally {
        clearedDoc.destroy();
        if (watched) await persistence.unwatch().catch(() => {});
      }
    }

    return false;
  } finally {
    try {
      persistence.disconnect();
    } catch {}
  }
}

export function createRedisProvider(
  redis: Redis | Cluster,
  docName: string,
  ydoc: Y.Doc,
): { destroy(): Promise<void> } {
  const redisKey = `${REDIS_KEY_PREFIX}${docName}`;
  const channel = `${REDIS_CHANNEL_PREFIX}${docName}`;

  // ioredis Cluster supports pub/sub at runtime but TypeScript types differ;
  // cast to Redis for method access (same pattern as KeyvRedis in cache.ts).
  const r = redis as Redis;

  const remoteUpdateOrigin = Symbol("redis-provider-remote-update");
  const pendingLocalUpdates: Uint8Array[] = [];
  let readyForLocalUpdates = false;
  let localSnapshotPending = false;
  let flushScheduled = false;
  let persistInFlight = false;
  let destroyed = false;
  let subscriber: Redis | null = null;
  let persistence: RedisSnapshotConnection | null = null;

  const reportSubscriberFailure = (stage: "duplicate" | "listen" | "subscribe" | "load" | "error" | "persist") => {
    console.warn(`[redis-provider] Redis ${stage} failed; local sync remains enabled`);
  };

  const publishUpdate = (update: Uint8Array) => {
    try {
      r.publish(channel, Buffer.from(update)).catch(() => {});
    } catch {
      // 后台发布失败不影响文档更新，且不记录文档内容。
    }
  };

  const enableLocalUpdates = () => {
    if (destroyed || readyForLocalUpdates) return;

    readyForLocalUpdates = true;
    for (const update of pendingLocalUpdates.splice(0)) publishUpdate(update);
    if (localSnapshotPending) scheduleSnapshotFlush();
  };

  const scheduleSnapshotFlush = () => {
    if (flushScheduled) return;

    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (destroyed || !readyForLocalUpdates) return;
      if (persistInFlight) {
        scheduleSnapshotFlush();
        return;
      }

      const activePersistence = persistence;
      if (!activePersistence) {
        reportSubscriberFailure("persist");
        return;
      }

      persistInFlight = true;
      localSnapshotPending = false;
      let localFull: Uint8Array;
      try {
        localFull = Y.encodeStateAsUpdate(ydoc);
      } catch {
        persistInFlight = false;
        if (!destroyed) reportSubscriberFailure("persist");
        return;
      }

      void mergeYjsSnapshotWithCas(activePersistence, redisKey, localFull)
        .then(
          (persisted) => {
            if (!persisted && !destroyed) reportSubscriberFailure("persist");
          },
          () => {
            if (!destroyed) reportSubscriberFailure("persist");
          },
        )
        .finally(() => {
          persistInFlight = false;
          if (localSnapshotPending && !destroyed) scheduleSnapshotFlush();
        });
    });
  };

  // 本地变更 → 合并写 Redis 全量快照 + publish 增量。
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (destroyed || origin === remoteUpdateOrigin) return;

    if (!readyForLocalUpdates) {
      pendingLocalUpdates.push(new Uint8Array(update));
      localSnapshotPending = true;
      return;
    }

    publishUpdate(update);
    localSnapshotPending = true;
    scheduleSnapshotFlush();
  };
  ydoc.on("update", onUpdate);

  // 专用 subscriber 接收远端变更，主连接始终只执行命令。
  const onMessage = (receivedChannel: Buffer | string, message: Buffer) => {
    if (destroyed) return;

    const receivedChannelName = Buffer.isBuffer(receivedChannel) ? receivedChannel.toString() : receivedChannel;
    if (receivedChannelName !== channel) return;

    try {
      Y.applyUpdate(ydoc, new Uint8Array(message), remoteUpdateOrigin);
    } catch {
      // 忽略无效的 update
    }
  };

  const onSubscriberError = () => {
    if (!destroyed) reportSubscriberFailure("error");
  };

  const cleanupSubscriber = () => {
    const activeSubscriber = subscriber;
    if (!activeSubscriber) return;

    subscriber = null;
    try {
      activeSubscriber.off("messageBuffer", onMessage);
    } catch {}
    try {
      activeSubscriber.off("error", onSubscriberError);
    } catch {}
    try {
      activeSubscriber.disconnect();
    } catch {}
  };

  const loadInitialSnapshot = async () => {
    try {
      const buf = await r.getBuffer(redisKey);
      if (destroyed) return;

      if (buf) {
        try {
          Y.applyUpdate(ydoc, new Uint8Array(buf), remoteUpdateOrigin);
        } catch {
          // 兼容此前错误写入的 base64 快照；新写入始终为原始二进制。
          Y.applyUpdate(ydoc, new Uint8Array(Buffer.from(buf.toString(), "base64")), remoteUpdateOrigin);
        }
      }
    } catch {
      if (!destroyed) reportSubscriberFailure("load");
    } finally {
      enableLocalUpdates();
    }
  };

  const cleanupPersistence = () => {
    const activePersistence = persistence;
    if (!activePersistence) return;

    persistence = null;
    try {
      activePersistence.disconnect();
    } catch {}
  };

  try {
    persistence = r.duplicate() as unknown as RedisSnapshotConnection;
  } catch {
    reportSubscriberFailure("duplicate");
    enableLocalUpdates();
    return {
      async destroy() {
        destroyed = true;
        ydoc.off("update", onUpdate);
      },
    };
  }

  try {
    subscriber = r.duplicate();
  } catch {
    cleanupPersistence();
    reportSubscriberFailure("duplicate");
    enableLocalUpdates();
    return {
      async destroy() {
        destroyed = true;
        ydoc.off("update", onUpdate);
      },
    };
  }

  try {
    subscriber.on("messageBuffer", onMessage);
    subscriber.on("error", onSubscriberError);
  } catch {
    cleanupSubscriber();
    reportSubscriberFailure("listen");
    enableLocalUpdates();
    return {
      async destroy() {
        destroyed = true;
        ydoc.off("update", onUpdate);
        cleanupPersistence();
      },
    };
  }

  try {
    void subscriber.subscribe(channel).then(
      () => {
        if (destroyed) return;
        void loadInitialSnapshot();
      },
      () => {
        if (destroyed) return;

        cleanupSubscriber();
        reportSubscriberFailure("subscribe");
        enableLocalUpdates();
      },
    );
  } catch {
    cleanupSubscriber();
    reportSubscriberFailure("subscribe");
    enableLocalUpdates();
  }

  return {
    async destroy() {
      destroyed = true;
      ydoc.off("update", onUpdate);
      cleanupSubscriber();
      cleanupPersistence();
    },
  };
}
