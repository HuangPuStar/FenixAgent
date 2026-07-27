// packages/acp-server/src/redis-provider.ts

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";

const REDIS_KEY_PREFIX = "yjs:";
const REDIS_CHANNEL_PREFIX = "yjs:channel:";

export function createRedisProvider(
  redis: Redis | Cluster,
  docName: string,
  ydoc: Y.Doc,
): { destroy(): Promise<void> } {
  const redisKey = `${REDIS_KEY_PREFIX}${docName}`;
  const channel = `${REDIS_CHANNEL_PREFIX}${docName}`;

  // ioredis Cluster supports pub/sub at runtime but TypeScript types differ;
  // cast to Redis for method access (same pattern as KeyvRedis in cache.ts).
  // biome-ignore lint/suspicious/noExplicitAny: Cluster pub/sub methods match Redis at runtime
  const r = redis as any;

  let pendingLoad = true;

  // 1. 从 Redis 恢复已有状态
  r.getBuffer(redisKey)
    .then((buf: Buffer | null) => {
      if (buf) {
        Y.applyUpdate(ydoc, new Uint8Array(buf));
      }
      // 加载完成（无论是否有数据），立即允许本地变更写入 Redis
      pendingLoad = false;
    })
    .catch(() => {
      // 加载失败也释放 pendingLoad，避免永远阻塞
      pendingLoad = false;
    });

  // 2. 本地变更 → 写 Redis + publish
  const onUpdate = (update: Uint8Array, _origin: unknown) => {
    if (pendingLoad) {
      // 还在等远程加载，忽略本地 update
      return;
    }
    r.set(redisKey, Buffer.from(update)).catch(() => {});
    r.publish(channel, Buffer.from(update)).catch(() => {});
  };
  ydoc.on("update", onUpdate);

  // 3. 订阅远端变更 → apply 到本地 ydoc
  r.subscribe(channel).catch(() => {});
  const onMessage = (_redisChannel: string, message: string) => {
    try {
      pendingLoad = false;
      Y.applyUpdate(ydoc, new Uint8Array(message as unknown as ArrayBuffer));
    } catch {
      // 忽略无效的 update
    }
  };
  r.on("message", onMessage);

  // 标记加载状态：在 Redis 数据恢复完成前，忽略本地产生的 update 事件避免覆盖远程数据
  // 加载完成后由 getBuffer 回调设置为 false

  return {
    async destroy() {
      ydoc.off("update", onUpdate);
      r.off("message", onMessage);
      try {
        await r.unsubscribe(channel);
      } catch {
        // ignore
      }
    },
  };
}
