import KeyvRedis from "@keyv/redis";
import Redis, { type Cluster } from "ioredis";
import Keyv from "keyv";

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
/** 全局共享的 Redis 连接（单实例或集群），所有 Keyv 实例复用 */
let _redis: Redis | Cluster | null = null;

function buildRedisConnection(): { redis: Redis | Cluster; backend: Backend } | null {
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
    return { redis: cluster, backend: "redis-cluster" };
  }

  if (redisUrl) {
    const client = new Redis(redisUrl, {
      password: redisPassword || undefined,
      lazyConnect: true,
    });
    return { redis: client, backend: "redis" };
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
      _backend = result.backend;
    }
  }

  if (_redis) {
    // 每个 namespace 创建独立的 KeyvRedis 包装器（内部共享同一个 Redis 连接）
    // biome-ignore lint/suspicious/noExplicitAny: KeyvRedis accepts Redis | Cluster but type mismatch
    const store = new KeyvRedis(_redis as any);
    kv = new Keyv({ store, namespace, ttl: defaultTtlMs });
  } else {
    kv = new Keyv({ namespace, ttl: defaultTtlMs });
    _backend = "memory";
  }

  instances.set(namespace, kv);
  return kv;
}

/** 测试用：清除所有缓存实例的底层数据 */
export async function clearAllCache(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const kv of instances.values()) {
    promises.push(kv.clear());
  }
  await Promise.all(promises);
  instances.clear();
}

/** 优雅关闭：断开 Redis 连接 */
export async function closeCache(): Promise<void> {
  instances.clear();
  if (_redis) {
    await _redis.quit().catch(() => {
      // quit 可能抛错（连接已断开），忽略
    });
    _redis = null;
  }
}
