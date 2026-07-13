import { log, error as logError } from "@fenix/logger";
import Redis, { type Cluster } from "ioredis";
import type { TransportStore } from "./types";

export interface RedisStoreOptions {
  url: string;
  keyPrefix?: string;
  /** 是否使用 Redis Cluster 模式。默认为 false（标准 Redis / Sentinel 自动识别） */
  cluster?: boolean;
}

/**
 * 多节点 Redis 实现。使用两个独立连接：主连接用于 set/get/del/publish，sub 连接用于 subscribe。
 *
 * 支持三种 Redis 模式：
 * - 标准 Redis：`redis://` / `rediss://` URL
 * - Sentinel：`redis+sentinel://` URL（ioredis 自动识别）
 * - Cluster：`cluster: true` 时使用 ioredis `new Redis.Cluster()`
 */
export class RedisStore implements TransportStore {
  private redis: Redis | Cluster;
  private sub: Redis | Cluster;
  private prefix: string;
  private pubSubCleanups = new Set<() => void>();
  private _connected = false;

  constructor(options: RedisStoreOptions) {
    this.prefix = options.keyPrefix ?? "rcs:";

    const retryStrategy = (times: number) => Math.min(times * 200, 5000);

    if (options.cluster) {
      // ioredis Cluster：自动发现所有节点，使用集群级别重试策略
      this.redis = new Redis.Cluster([options.url], {
        clusterRetryStrategy: retryStrategy,
      });
      // Redis Cluster 内置 pub/sub，sub 复用同一连接
      this.sub = this.redis;
    } else {
      this.redis = new Redis(options.url, {
        lazyConnect: true,
        retryStrategy,
      });

      this.sub = new Redis(options.url, {
        lazyConnect: true,
        retryStrategy,
      });
    }
  }

  /**
   * 显式建立 Redis 连接。
   * 构造时默认 lazyConnect: true，不自动连接；必须在工厂创建后调用此方法建立连接。
   * Cluster 模式下自动连接，无需显式调用（但调用也安全）。
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.redis instanceof Redis) {
      await this.redis.connect();
    }
    // sub 与 redis 可能是同一实例（cluster 模式），避免重复连接
    if (this.sub !== this.redis && this.sub instanceof Redis) {
      await this.sub.connect();
    }
    this._connected = true;
    log("RedisStore connected");
  }

  /**
   * 返回主 Redis 客户端实例，供 socket.io Redis Adapter 等组件复用。
   * 外部不应 close/disconnect 此实例。
   * 仅在非 Cluster 模式下可用；Cluster 模式返回 undefined。
   */
  getPubClient(): Redis | undefined {
    if (this.redis instanceof Redis) return this.redis;
  }

  // ── relay socket ──

  async setRelaySocket(instanceId: string, socketId: string): Promise<void> {
    await this.redis.set(`${this.prefix}relay:${instanceId}`, socketId);
  }

  async getRelaySocket(instanceId: string): Promise<string | null> {
    return await this.redis.get(`${this.prefix}relay:${instanceId}`);
  }

  async delRelaySocket(instanceId: string): Promise<void> {
    await this.redis.del(`${this.prefix}relay:${instanceId}`);
  }

  // ── machine socket ──

  async setMachineSocket(machineId: string, socketId: string): Promise<void> {
    await this.redis.set(`${this.prefix}machine:${machineId}`, socketId);
  }

  async getMachineSocket(machineId: string): Promise<string | null> {
    return await this.redis.get(`${this.prefix}machine:${machineId}`);
  }

  async delMachineSocket(machineId: string): Promise<void> {
    await this.redis.del(`${this.prefix}machine:${machineId}`);
  }

  // ── pub/sub ──

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(`${this.prefix}events:${channel}`, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    const redisChannel = `${this.prefix}events:${channel}`;

    const onMessage = (_ch: string, message: string) => {
      handler(message);
    };

    await this.sub.subscribe(redisChannel);
    this.sub.on("message", onMessage);

    const cleanup = async () => {
      this.sub.off("message", onMessage);
      await this.sub.unsubscribe(redisChannel).catch((err: unknown) => {
        logError("[RedisStore] unsubscribe failed for channel", redisChannel, err);
      });
      this.pubSubCleanups.delete(cleanup);
    };
    this.pubSubCleanups.add(cleanup);
    return cleanup;
  }

  // ── health ──

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  // ── cleanup ──

  async close(): Promise<void> {
    // 先清理所有 pub/sub 订阅（fire-and-forget，每个 cleanup 自带错误处理）
    for (const c of this.pubSubCleanups) {
      c();
    }

    await this.redis.quit().catch((err: unknown) => {
      logError("RedisStore close: redis.quit failed", err);
    });
    await this.sub.quit().catch((err: unknown) => {
      logError("RedisStore close: sub.quit failed", err);
    });
  }
}
