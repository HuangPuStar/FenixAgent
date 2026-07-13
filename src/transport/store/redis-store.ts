import Redis from "ioredis";
import type { TransportStore } from "./types";

export interface RedisStoreOptions {
  url: string;
  keyPrefix?: string;
}

/** 多节点 Redis 实现。使用两个独立连接：主连接用于 set/get/del/publish，sub 连接用于 subscribe。 */
export class RedisStore implements TransportStore {
  private redis: Redis;
  private sub: Redis;
  private prefix: string;
  private pubSubCleanups = new Set<() => void>();

  constructor(options: RedisStoreOptions) {
    this.prefix = options.keyPrefix ?? "rcs:";

    const retryStrategy = (times: number) => Math.min(times * 200, 5000);

    this.redis = new Redis(options.url, {
      lazyConnect: true,
      retryStrategy,
    });

    this.sub = new Redis(options.url, {
      lazyConnect: true,
      retryStrategy,
    });
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
      await this.sub.unsubscribe(redisChannel).catch(() => {
        // unsubscribe 可能抛错（连接已断开），忽略
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

    await this.redis.quit().catch(() => {
      // quit 可能抛错（连接已断开），忽略
    });
    await this.sub.quit().catch(() => {
      // quit 可能抛错（连接已断开），忽略
    });
  }
}
