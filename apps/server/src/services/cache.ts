import { createLogger } from "@fenix/logger";
import KeyvRedis, { defaultReconnectStrategy, type RedisClientOptions, type RedisClusterOptions } from "@keyv/redis";
import { metrics } from "@opentelemetry/api";
import Redis, { type Cluster } from "ioredis";
import Keyv, { KeyvEvents } from "keyv";

const cacheRequests = metrics.getMeter("fenix-server").createCounter("fenix.cache.requests");

/**
 * 缓存模块 — 基于 Keyv，自动选择存储后端：
 * - 无 RCS_REDIS_URL → 进程内 Map（零依赖，开发/测试用）
 * - 有 RCS_REDIS_URL → Redis 单实例
 * - 有 RCS_REDIS_CLUSTER → Redis Cluster（优先级高于单实例）
 *
 * 所有实例按 namespace 隔离，key 前缀自动带 namespace。
 */

// ────────────────────────────────────────────
// 环境变量读取（不依赖 env.ts，因为缓存可能在 env 校验之前初始化）
// ────────────────────────────────────────────

function getEnv(key: string): string | undefined {
  return process.env[key] || (typeof Bun !== "undefined" ? Bun.env[key] : undefined);
}

// ────────────────────────────────────────────
// Redis 连接构建
// ────────────────────────────────────────────

type Backend = "memory" | "redis" | "redis-cluster";

let _backend: Backend = "memory";
/** 供实时通道等直接使用的 ioredis 连接。 */
let _redis: Redis | Cluster | null = null;
let _cacheConnect: RedisClientOptions | RedisClusterOptions | null = null;
const redisStores = new Set<KeyvRedis<unknown>>();
const log = createLogger("cache");

function buildRedisConnection(): {
  redis: Redis | Cluster;
  cacheConnect: RedisClientOptions | RedisClusterOptions;
  backend: Backend;
} | null {
  const clusterStr = getEnv("RCS_REDIS_CLUSTER");
  const redisUrl = getEnv("RCS_REDIS_URL");
  const redisPassword = getEnv("RCS_REDIS_PASSWORD");

  if (clusterStr) {
    const nodes = clusterStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [host, port] = s.split(":");
        return { host: host || "127.0.0.1", port: Number(port) || 6379 };
      });
    if (nodes.length === 0) return null;

    const cluster = new Redis.Cluster(nodes, {
      redisOptions: { password: redisPassword || undefined },
      lazyConnect: true,
    });
    const cacheConnect: RedisClusterOptions = {
      rootNodes: nodes.map(({ host, port }) => ({
        url: `redis://${host}:${port}`,
        socket: { socketTimeout: 5000 },
      })),
      defaults: {
        password: redisPassword || undefined,
        socket: { reconnectStrategy: defaultReconnectStrategy },
        disableOfflineQueue: true,
      },
    };
    return { redis: cluster, cacheConnect, backend: "redis-cluster" };
  }

  if (redisUrl) {
    const client = new Redis(redisUrl, {
      password: redisPassword || undefined,
      lazyConnect: true,
    });
    const cacheConnect: RedisClientOptions = {
      url: redisUrl,
      password: redisPassword || undefined,
      socket: { reconnectStrategy: false },
      disableOfflineQueue: true,
    };
    return { redis: client, cacheConnect, backend: "redis" };
  }

  return null;
}

// ────────────────────────────────────────────
// Keyv 实例工厂
// ────────────────────────────────────────────

const instances = new Map<string, Keyv>();

/** 当前生效的后端类型 */
export function getCacheBackend(): Backend {
  return _backend;
}

/**
 * 获取指定命名空间的缓存实例。
 * 同一命名空间复用实例，不同命名空间 key 自动隔离。
 */
export function getCache(namespace: string, defaultTtlMs?: number): Keyv {
  const existing = instances.get(namespace);
  if (existing) return existing;

  let kv: Keyv;

  if (!_redis) {
    const result = buildRedisConnection();
    if (result) {
      _redis = result.redis;
      _cacheConnect = result.cacheConnect;
      _backend = result.backend;
    }
  }

  if (_cacheConnect) {
    // 传配置而非外部客户端，让官方适配器负责并发握手、超时清理和失败后的连接替换。
    const store = new KeyvRedis(_cacheConnect, { throwOnErrors: true, connectionTimeout: 5000 });
    redisStores.add(store);
    kv = new Keyv({ store, namespace, ttl: defaultTtlMs });
    // 后台连接错误只记录；操作错误仍由 adapter 拒绝，经 Keyv 原样抛给调用方。
    // 若在 Keyv 上注册日志监听器，Keyv 6 会把操作失败改成返回空值或 false。
    store.removeAllListeners("error");
    store.on("error", (error: unknown) => {
      log.warn("Redis cache connection error", {
        namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    kv = new Keyv({ namespace, ttl: defaultTtlMs });
    _backend = "memory";
  }

  const backend = _backend;
  // Keyv 6 先 emit("error") 再 emit "stat:error"；无 error 监听器时前者直接抛出，
  // 因此错误计数必须挂在 error 事件上，并原样重抛以保持操作失败向调用方传播。
  kv.on("error", (error: unknown) => {
    cacheRequests.add(1, { cache: backend, result: "error" });
    throw error instanceof Error ? error : new Error(String(error));
  });
  // Keyv 6 的遥测事件与存储适配器解耦，命中与未命中在内存和 Redis 后端都走同一组计数。
  kv.on(KeyvEvents.STAT_HIT, () => cacheRequests.add(1, { cache: backend, result: "hit" }));
  kv.on(KeyvEvents.STAT_MISS, () => cacheRequests.add(1, { cache: backend, result: "miss" }));
  instances.set(namespace, kv);
  return kv;
}

/** 测试用：清除所有缓存实例的底层数据并释放适配器连接。 */
export async function clearAllCache(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const kv of instances.values()) {
    promises.push(kv.clear());
  }
  await Promise.all(promises);
  instances.clear();
  const stores = [...redisStores];
  redisStores.clear();
  await Promise.all(stores.map((store) => store.disconnect(true)));
}

/** 优雅关闭 Redis 连接；失败保留诊断，继续后续宿主资源清理。 */
export async function closeCache(): Promise<void> {
  instances.clear();
  const redis = _redis;
  const stores = [...redisStores];
  redisStores.clear();
  _redis = null;
  _cacheConnect = null;
  _backend = "memory";
  const results = await Promise.allSettled([redis?.quit(), ...stores.map((store) => store.disconnect(true))]);
  for (const result of results) {
    if (result.status === "rejected") {
      log.error("Redis cache shutdown failed", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/** 获取底层 Redis 连接（供 yjs provider 等直接使用） */
export function getRedisConnection(): Redis | Cluster | null {
  return _redis;
}
