// packages/chat-channel/src/persist/redis.ts
// Redis 快照持久化 provider 与 Pub/Sub 增量分发（chat:{id} / session:{id} 共用）。
//
// 丢失语义（SP-A1）：快照持久化是 trailing 节流的尽力而为写入——距上次成功 CAS
// ≥ RCS_YJS_SNAPSHOT_INTERVAL_MS（默认 2s）或静默期（RCS_YJS_SNAPSHOT_IDLE_MS，
// 默认 500ms 无新 update）才执行一次全量 CAS 合并；destroy()（closeChat/closeSession
// 的统一收口）强制 flush 未落盘快照。节流窗口内进程崩溃会丢失窗口内更新，但快照本就
// 不是权威——权威是 Agent 侧 ACP session 历史，可经 load_session 回放重建（见
// docs/design/2026-08-04-yjs-chat-streaming-prd.md「兼容与演进」）。Pub/Sub 增量路径
// 不节流，实时性不受影响。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { mergeYjsSnapshotWithCas, type RedisSnapshotConnection } from "./snapshot-cas";
import { defaultSnapshotMetricsLog, getSnapshotEnvConfig, reportSnapshotCasMetric } from "./snapshot-config";
import { framePublishUpdate, isSamePublisherId, PUBLISHER_ID, parseFramedPublish } from "./snapshot-framing";

export type { RedisSnapshotConnection, RedisSnapshotTransaction } from "./snapshot-cas";
// CAS 写入工具经本模块再导出，保持 persist/index.ts 与既有调用方的导入路径不变。
export {
  mergeYjsSnapshotWithCas,
  persistYjsClearedSnapshotWithCas,
  persistYjsSnapshotWithCas,
} from "./snapshot-cas";

const REDIS_KEY_PREFIX = "yjs:";
const REDIS_CHANNEL_PREFIX = "yjs:channel:";
const ACTIVE_GENERATION_PREFIX = "yjs:active-generation:";

export async function getOrCreateActiveGeneration(redis: Redis | Cluster, rcsSessionId: string): Promise<string> {
  const key = `${ACTIVE_GENERATION_PREFIX}${rcsSessionId}`;
  const proposed = `gen_${crypto.randomUUID()}`;
  const r = redis as Redis;
  await r.set(key, proposed, "NX");
  return (await r.get(key)) ?? proposed;
}

/** 仅当前 active generation 可发布后继，防止并发 replacement 后到者覆盖胜者。 */
export async function publishActiveGeneration(
  redis: Redis | Cluster,
  rcsSessionId: string,
  expected: string,
  next: string,
): Promise<boolean> {
  const key = `${ACTIVE_GENERATION_PREFIX}${rcsSessionId}`;
  const result = await (redis as Redis).eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 else return 0 end",
    1,
    key,
    expected,
    next,
  );
  return Number(result) === 1;
}

/** createRedisProvider 的可选配置（宿主 DI / 测试注入通道）。 */
export interface RedisProviderOptions {
  /** 投影世代；提供时快照 key 与 Pub/Sub channel 均隔离，旧 provider 无法污染新投影。 */
  generation?: string;
  /** trailing 节流窗口：距上次成功 CAS 的最小间隔（毫秒） */
  snapshotIntervalMs?: number;
  /** 静默期：持续无新 update 该时长后提前 flush（毫秒） */
  snapshotIdleMs?: number;
  /** 快照滑动 TTL（秒），每次成功 CAS 续期 */
  snapshotTtlSeconds?: number;
  /**
   * 发布者标识（16 字节）。生产留空使用模块级进程 UUID（同进程消息自环过滤，
   * 一个进程内同一 channel 只有一个 provider）；仅供测试在单进程内模拟双进程
   * 互发收敛场景时注入不同值。
   */
  publisherId?: Uint8Array;
  /** SP-0 打点接收器（仅尺寸/耗时/标识）；不传时生产走 console.log、测试静默 */
  log?: (msg: string) => void;
}

export function createRedisProvider(
  redis: Redis | Cluster,
  docName: string,
  ydoc: Y.Doc,
  options?: RedisProviderOptions,
): { destroy(): Promise<void> } {
  const envConfig = getSnapshotEnvConfig();
  const snapshotIntervalMs = options?.snapshotIntervalMs ?? envConfig.intervalMs;
  const snapshotIdleMs = options?.snapshotIdleMs ?? envConfig.idleMs;
  const snapshotTtlSeconds = options?.snapshotTtlSeconds ?? envConfig.ttlSeconds;
  const metricsLog = options?.log ?? defaultSnapshotMetricsLog;

  const persistenceName = options?.generation ? `${docName}:${options.generation}` : docName;
  const redisKey = `${REDIS_KEY_PREFIX}${persistenceName}`;
  const channel = `${REDIS_CHANNEL_PREFIX}${persistenceName}`;
  const rcsSessionId = docName.slice(docName.indexOf(":") + 1);
  const activeGenerationKey = `${ACTIVE_GENERATION_PREFIX}${rcsSessionId}`;
  const generation = options?.generation;

  // ioredis Cluster supports pub/sub at runtime but TypeScript types differ;
  // cast to Redis for method access (same pattern as KeyvRedis in cache.ts).
  const r = redis as Redis;

  const remoteUpdateOrigin = Symbol("redis-provider-remote-update");
  // 生产使用模块级进程 UUID（同进程自环过滤）；测试可注入不同值模拟双进程互发。
  const publisherId = options?.publisherId ?? PUBLISHER_ID;
  const pendingLocalUpdates: Uint8Array[] = [];
  let readyForLocalUpdates = false;
  let localSnapshotPending = false;
  let flushScheduled = false;
  let persistInFlight = false;
  let destroyed = false;
  let subscriber: Redis | null = null;
  let persistence: RedisSnapshotConnection | null = null;
  // 节流状态：lastPersistSuccessAt = 0 表示尚无成功写入，首次调度立即 flush（microtask）。
  let lastPersistSuccessAt = 0;
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightCas: Promise<boolean> | null = null;

  const reportSubscriberFailure = (stage: "duplicate" | "listen" | "subscribe" | "load" | "error" | "persist") => {
    console.warn(`[redis-provider] Redis ${stage} failed; local sync remains enabled`);
  };

  const publishUpdate = (update: Uint8Array) => {
    try {
      const framed = framePublishUpdate(update, publisherId);
      if (generation) {
        r.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PUBLISH', KEYS[2], ARGV[2]) else return 0 end",
          2,
          activeGenerationKey,
          channel,
          generation,
          framed,
        ).catch(() => {});
      } else {
        r.publish(channel, framed).catch(() => {});
      }
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

  const clearSnapshotTimers = () => {
    if (intervalTimer !== null) {
      clearTimeout(intervalTimer);
      intervalTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /** 打点辅助：以 CAS 起始时刻换算耗时，仅含尺寸/耗时/标识。 */
  const reportCasOutcome = (bytes: number, encodeMs: number, casStartedAt: number, persisted: boolean) => {
    reportSnapshotCasMetric(metricsLog, docName, bytes, encodeMs, Date.now() - casStartedAt, persisted);
  };

  const startFlush = () => {
    clearSnapshotTimers();
    if (destroyed || !readyForLocalUpdates || persistInFlight || !localSnapshotPending) return;

    const activePersistence = persistence;
    if (!activePersistence) {
      reportSubscriberFailure("persist");
      return;
    }

    persistInFlight = true;
    localSnapshotPending = false;
    const encodeStartedAt = Date.now();
    let localFull: Uint8Array;
    try {
      localFull = Y.encodeStateAsUpdate(ydoc);
    } catch {
      persistInFlight = false;
      if (!destroyed) reportSubscriberFailure("persist");
      if (localSnapshotPending && !destroyed) scheduleSnapshotFlush();
      return;
    }
    const encodeMs = Date.now() - encodeStartedAt;
    const casStartedAt = Date.now();

    inFlightCas = mergeYjsSnapshotWithCas(
      activePersistence,
      redisKey,
      localFull,
      snapshotTtlSeconds,
      generation ? { key: activeGenerationKey, generation } : undefined,
    );
    const cas = inFlightCas;
    void cas
      .then(
        (persisted) => {
          if (persisted) lastPersistSuccessAt = Date.now();
          else if (!destroyed) reportSubscriberFailure("persist");
          reportCasOutcome(localFull.length, encodeMs, casStartedAt, persisted);
        },
        () => {
          if (!destroyed) reportSubscriberFailure("persist");
          reportCasOutcome(localFull.length, encodeMs, casStartedAt, false);
        },
      )
      .finally(() => {
        if (inFlightCas === cas) inFlightCas = null;
        persistInFlight = false;
        if (localSnapshotPending && !destroyed) scheduleSnapshotFlush();
      });
  };

  /**
   * SP-A1 trailing 节流：距上次成功写入 ≥ interval 时经 microtask 立即执行
   * （保留同一事件循环内变更合并为一次 CAS 的既有语义）；窗口内则安排
   * 「interval 绝对到期」与「静默期」两个定时器，先到者触发一次合并 flush。
   */
  const scheduleSnapshotFlush = () => {
    if (destroyed || !readyForLocalUpdates || persistInFlight || !localSnapshotPending) return;

    const now = Date.now();
    if (lastPersistSuccessAt === 0 || now - lastPersistSuccessAt >= snapshotIntervalMs) {
      clearSnapshotTimers();
      if (flushScheduled) return;

      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        startFlush();
      });
      return;
    }

    if (intervalTimer === null) {
      const delay = Math.max(lastPersistSuccessAt + snapshotIntervalMs - now, 0);
      intervalTimer = setTimeout(() => {
        intervalTimer = null;
        startFlush();
      }, delay);
    }
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      startFlush();
    }, snapshotIdleMs);
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
      const payload = new Uint8Array(message);
      const framed = parseFramedPublish(payload);
      if (framed) {
        if (isSamePublisherId(framed.publisherId, publisherId)) return; // SP-A6 自环过滤
        Y.applyUpdate(ydoc, framed.update, remoteUpdateOrigin);
        return;
      }
      // 无发布者头的旧格式（滚动部署窗口）：按原始 update 全量 apply，无损兼容。
      Y.applyUpdate(ydoc, payload, remoteUpdateOrigin);
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
      if (generation && (await r.get(activeGenerationKey)) !== generation) return;
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

  /** destroy 收口的强制 flush：等待在途 CAS 后同步 encode + await CAS，关闭节流窗口的丢失语义。 */
  const forceFlushForDestroy = async () => {
    if (inFlightCas) {
      try {
        await inFlightCas;
      } catch {}
    }
    if (!localSnapshotPending || persistInFlight || !persistence) return;

    localSnapshotPending = false;
    try {
      const encodeStartedAt = Date.now();
      const localFull = Y.encodeStateAsUpdate(ydoc);
      const encodeMs = Date.now() - encodeStartedAt;
      const casStartedAt = Date.now();
      const persisted = await mergeYjsSnapshotWithCas(
        persistence,
        redisKey,
        localFull,
        snapshotTtlSeconds,
        generation ? { key: activeGenerationKey, generation } : undefined,
      );
      if (persisted) lastPersistSuccessAt = Date.now();
      else reportSubscriberFailure("persist");
      reportCasOutcome(localFull.length, encodeMs, casStartedAt, persisted);
    } catch {
      reportSubscriberFailure("persist");
    }
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
      clearSnapshotTimers();
      await forceFlushForDestroy();
      cleanupPersistence();
    },
  };
}
