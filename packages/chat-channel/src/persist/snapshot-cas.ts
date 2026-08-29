// packages/chat-channel/src/persist/snapshot-cas.ts
// Yjs 快照的 Redis CAS 原子合并写入（WATCH/MULTI/EXEC）。
//
// WATCH 必须只存在于专用 duplicate 连接，不能污染全局命令连接或 Pub/Sub subscriber。
// 写入附带滑动 TTL（SP-C1）：活跃会话每次成功 CAS 续期，失活数据自然过期回收。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { buildRedisProviderKeys } from "./redis-keys";
import { getSnapshotEnvConfig } from "./snapshot-config";

const SNAPSHOT_PERSIST_RETRIES = 5;

export type RedisSnapshotTransaction = {
  set(key: string, value: Buffer, expiryMode?: "EX", seconds?: number): RedisSnapshotTransaction;
  exec(): Promise<unknown | null>;
};

export type RedisSnapshotConnection = {
  watch(...keys: string[]): Promise<unknown>;
  unwatch(): Promise<unknown>;
  get(key: string): Promise<string | null>;
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
 * 冲突（EXEC 返回 null）时重试并重新读取远端状态；重试耗尽返回 false。
 */
export async function mergeYjsSnapshotWithCas(
  persistence: RedisSnapshotConnection,
  redisKey: string,
  localFull: Uint8Array,
  ttlSeconds: number = getSnapshotEnvConfig().ttlSeconds,
  fence?: { key: string; generation: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < SNAPSHOT_PERSIST_RETRIES; attempt += 1) {
    let watched = false;
    try {
      await persistence.watch(...(fence ? [redisKey, fence.key] : [redisKey]));
      watched = true;
      if (fence && (await persistence.get(fence.key)) !== fence.generation) return false;
      const existingRaw = await persistence.getBuffer(redisKey);
      const merged = mergeSnapshotUpdates(existingRaw, localFull);
      const result = await persistence.multi().set(redisKey, Buffer.from(merged), "EX", ttlSeconds).exec();
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
  ttlSeconds?: number,
): Promise<boolean> {
  const persistence = redis.duplicate() as unknown as RedisSnapshotConnection;
  try {
    return await mergeYjsSnapshotWithCas(persistence, redisKey, localFull, ttlSeconds);
  } finally {
    try {
      persistence.disconnect();
    } catch {}
  }
}

export interface ClearedSessionSnapshotTarget {
  /** 未编码的 RCS session ID；键构造器会把它转换为受控 hash tag。 */
  rcsSessionId: string;
  /** 调用方当前持有的投影世代；只有它仍 active 时才允许提交。 */
  generation: string;
}

/**
 * 原子地持久化一个清空后的 Session Doc 快照。
 *
 * 与普通合并 CAS 不同，冲突重试时会重新读取 Redis 当前状态并再次清空，
 * 因此清空者未见的并发内容不会被 Yjs 合并重新带回。snapshot 与 generation
 * fence 由同一个受控 hash tag 派生并一起 WATCH，旧世代写入不会越过投影换代。
 */
export async function persistYjsClearedSnapshotWithCas(
  redis: Redis | Cluster,
  target: ClearedSessionSnapshotTarget,
  localBaseline: Uint8Array,
  clear: (ydoc: Y.Doc) => void,
  ttlSeconds?: number,
): Promise<boolean> {
  if (target.generation.length === 0) throw new Error("projection generation must not be empty");
  const { snapshotKey, activeGenerationKey } = buildRedisProviderKeys(
    `session:${target.rcsSessionId}`,
    target.generation,
  );
  const persistence = redis.duplicate() as unknown as RedisSnapshotConnection;
  try {
    for (let attempt = 0; attempt < SNAPSHOT_PERSIST_RETRIES; attempt += 1) {
      let watched = false;
      const clearedDoc = new Y.Doc();
      try {
        await persistence.watch(snapshotKey, activeGenerationKey);
        watched = true;
        if ((await persistence.get(activeGenerationKey)) !== target.generation) return false;

        const existingRaw = await persistence.getBuffer(snapshotKey);
        if (existingRaw) {
          try {
            Y.applyUpdate(clearedDoc, new Uint8Array(existingRaw));
          } catch {
            // 兼容此前在受控键中错误写入的 base64 快照；新写入始终为原始二进制。
            Y.applyUpdate(clearedDoc, new Uint8Array(Buffer.from(existingRaw.toString(), "base64")));
          }
        }
        Y.applyUpdate(clearedDoc, localBaseline);
        clear(clearedDoc);

        const result = await persistence
          .multi()
          .set(
            snapshotKey,
            Buffer.from(Y.encodeStateAsUpdate(clearedDoc)),
            "EX",
            ttlSeconds ?? getSnapshotEnvConfig().ttlSeconds,
          )
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
