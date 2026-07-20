import type Redis from "ioredis";
import { MemoryStore } from "./memory-store";
import { RedisStore } from "./redis-store";
import type { TransportStore } from "./types";

let _store: TransportStore | null = null;

/**
 * 获取单例 TransportStore 实例。
 *
 * 根据 RCS_REDIS_URL 环境变量自动选择 MemoryStore 或 RedisStore。
 * 注意：process.env 的值已在应用入口 validateEnv() 中完成校验，此处直接读取即可。
 * 支持三种 Redis 模式：
 * - 标准 Redis：`redis://` 或 `rediss://` URL
 * - Sentinel：`redis+sentinel://` URL，ioredis 自动识别
 * - Cluster：`redis://` URL + `RCS_REDIS_CLUSTER=true` 启用 Cluster 模式
 */
export function getTransportStore(): TransportStore {
  if (_store) return _store;
  const redisUrl = process.env.RCS_REDIS_URL;
  const isCluster = process.env.RCS_REDIS_CLUSTER === "true";
  if (redisUrl) {
    _store = new RedisStore({
      url: redisUrl,
      keyPrefix: "rcs:",
      cluster: isCluster,
    });
  } else {
    _store = new MemoryStore();
  }
  return _store;
}

/**
 * 初始化并建立 TransportStore 的连接。
 *
 * 对于 RedisStore，调用此方法会显式 connect Redis。
 * 此方法应在服务启动阶段（socket.io server 初始化之前）调用。
 */
export async function connectTransportStore(): Promise<void> {
  const store = getTransportStore();
  if (store instanceof RedisStore) {
    await store.connect();
  }
}

/**
 * 获取共享的 Redis 客户端实例。
 *
 * 当使用 RedisStore 时返回其内部 Redis 连接，供 socket.io Redis Adapter 等组件复用，
 * 避免创建双倍 Redis 连接。
 *
 * @returns Redis 客户端实例，若非 RedisStore 则返回 undefined
 */
export function getRedisClient(): Redis | undefined {
  const store = _store;
  if (store instanceof RedisStore) {
    return store.getPubClient();
  }
}

/**
 * 关闭并释放 TransportStore 单例。
 *
 * 断开 Redis 连接（如果存在）并释放所有资源。
 */
export async function closeTransportStore(): Promise<void> {
  if (_store) {
    await _store.close();
    _store = null;
  }
}
