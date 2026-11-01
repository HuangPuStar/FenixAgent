import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import KeyvRedis from "@keyv/redis";
import { clearAllCache, closeCache, getCache, getCacheBackend, getRedisConnection } from "../services/cache";

const originalEnv = {
  RCS_REDIS_URL: process.env.RCS_REDIS_URL,
  RCS_REDIS_CLUSTER: process.env.RCS_REDIS_CLUSTER,
  RCS_REDIS_PASSWORD: process.env.RCS_REDIS_PASSWORD,
};

beforeEach(async () => {
  await closeCache();
  process.env.RCS_REDIS_URL = process.env.TEST_CACHE_REDIS_URL ?? "redis://127.0.0.1:1";
  delete process.env.RCS_REDIS_CLUSTER;
  delete process.env.RCS_REDIS_PASSWORD;
});

afterEach(async () => {
  await closeCache();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Redis 缓存适配", () => {
  // 缓存使用 node-redis 协议，原有 ioredis 能力仍提供给实时通道。
  test("Keyv 使用官方客户端并按命名空间复用适配器", () => {
    const first = getCache("redis-contract-first");
    const second = getCache("redis-contract-second");
    const store = first.store;
    expect(store).toBeInstanceOf(KeyvRedis);
    if (!(store instanceof KeyvRedis) || !(second.store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    expect(store.client.isOpen).toBe(false);
    expect(first).toBe(getCache("redis-contract-first"));
    expect(store.client).not.toBe(second.store.client);
    expect(store.client).not.toBe(getRedisConnection());
    expect(getCacheBackend()).toBe("redis");
  });

  // 集群模式也必须使用适配器支持的客户端，不能把 ioredis Cluster 强转传入。
  test("集群配置使用兼容的集群客户端", () => {
    process.env.RCS_REDIS_CLUSTER = "127.0.0.1:7000,127.0.0.1:7001";
    const store = getCache("redis-cluster-contract").store;
    expect(store).toBeInstanceOf(KeyvRedis);
    if (!(store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    expect(store.isCluster()).toBe(true);
    expect(store.client.isOpen).toBe(false);
    expect(getCacheBackend()).toBe("redis-cluster");
  });

  // Cluster 的 isOpen 早于拓扑就绪，并发请求必须等待同一次连接初始化。
  test("集群首次并发访问等待连接完成并保留连接异常", async () => {
    process.env.RCS_REDIS_CLUSTER = "127.0.0.1:7000";
    const first = getCache("redis-cluster-init-a").store;
    const second = getCache("redis-cluster-init-a").store;
    if (!(first instanceof KeyvRedis) || !(second instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    const client = first.client;
    const error = new Error("fixture cluster connection failed");
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = spyOn(client, "connect").mockImplementation(async () => {
      Object.defineProperty(client, "isOpen", { configurable: true, value: true });
      await pending;
      throw error;
    });
    try {
      const one = first.getClient();
      const two = second.getClient();
      const outcomes = Promise.allSettled([one, two]);
      let secondFinished = false;
      void two.then(
        () => {
          secondFinished = true;
        },
        () => {
          secondFinished = true;
        },
      );
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      expect(connect).toHaveBeenCalledTimes(1);
      release();
      for (const outcome of await outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason.cause).toBe(error);
      }
    } finally {
      release();
      Reflect.deleteProperty(client, "isOpen");
      connect.mockRestore();
    }
  });

  // 官方适配器必须替换超时客户端，避免旧连接的迟到结果污染下一轮初始化。
  test("初始化超时后重试使用新客户端", async () => {
    process.env.RCS_REDIS_URL = "redis://127.0.0.1:1";
    const store = getCache("redis-timeout-retry").store;
    if (!(store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.connectionTimeout = 20;
    const original = store.client;
    const connect = spyOn(original, "connect").mockImplementation(async () => {
      await pending;
      throw new Error("fixture late connection failure");
    });
    try {
      await expect(store.getClient()).rejects.toThrow();
      expect(store.client).not.toBe(original);
      await expect(store.getClient()).rejects.toThrow();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      release();
      connect.mockRestore();
    }
  }, 10_000);

  // 连接拒绝必须结束本轮操作，不能在无限重连中挂住组织解析。
  test("Redis 不可达时读写拒绝且可关闭", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const url = `redis://127.0.0.1:${listener.port}`;
    listener.stop(true);
    process.env.RCS_REDIS_URL = url;
    const cache = getCache("redis-unreachable");
    await expect(cache.set("organization", "org-b")).rejects.toThrow();
    await expect(cache.get("organization")).rejects.toThrow();
    await closeCache();
    expect(getRedisConnection()).toBeNull();
  });

  // 服务端建立 TCP 后不响应握手时，关闭仍须释放连接并拒绝所有等待者。
  test("关闭缓存释放连接中的并发操作", async () => {
    let accepted = () => {};
    const connected = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          accepted();
        },
        data() {},
      },
    });
    process.env.RCS_REDIS_URL = `redis://127.0.0.1:${listener.port}`;
    const cache = getCache("redis-pending-close");
    if (!(cache.store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    cache.store.connectionTimeout = 30;
    const outcomes = Promise.allSettled([cache.set("organization", "org-b"), cache.get("organization")]);
    try {
      await connected;
      await closeCache();
      expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(getRedisConnection()).toBeNull();
    } finally {
      listener.stop(true);
    }
  });

  // 集群发现节点不回应握手时，连接必须超时并释放临时 socket。
  test("集群握手无响应时有界失败并释放发现连接", async () => {
    let sockets = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          sockets += 1;
        },
        close() {
          sockets -= 1;
        },
        data() {},
      },
    });
    process.env.RCS_REDIS_CLUSTER = `127.0.0.1:${listener.port}`;
    try {
      const cache = getCache("redis-cluster-timeout");
      if (!(cache.store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
      await expect(cache.set("organization", "org-b")).rejects.toThrow();
      await Bun.sleep(100);
      expect(sockets).toBe(0);
    } finally {
      listener.stop(true);
    }
  }, 10_000);

  // 写入失败必须保留原始异常，不能返回成功让组织上下文悄悄丢失。
  test("缓存写入错误向调用方传播", async () => {
    const cache = getCache("redis-error-contract");
    expect(cache.store).toBeInstanceOf(KeyvRedis);
    if (!(cache.store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    expect(cache.store.throwOnErrors).toBe(true);
    const error = new Error("fixture cache write failed");
    const write = spyOn(cache.store, "set").mockRejectedValue(error);
    try {
      await expect(cache.set("organization", "org-b")).rejects.toBe(error);
    } finally {
      write.mockRestore();
    }
  });

  // Redis 在操作之外断线时应留下诊断，不能让后台事件抛出未捕获异常。
  test("后台连接错误不终止进程", () => {
    const store = getCache("redis-background-error").store;
    if (!(store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    expect(() => store.client.emit("error", new Error("fixture connection lost"))).not.toThrow();
  });

  // 任一 Redis 关闭失败都不能阻断宿主后续关闭阶段。
  test.each(["runtime", "adapter"] as const)("%s 关闭失败后仍可继续关闭其他宿主资源", async (source) => {
    const store = getCache("redis-shutdown-failure").store;
    const redis = getRedisConnection();
    if (!(store instanceof KeyvRedis) || !redis) throw new Error("非 Redis 存储");
    const error = new Error(`fixture ${source} shutdown failed`);
    const cleanup =
      source === "runtime"
        ? spyOn(redis, "quit").mockRejectedValue(error)
        : spyOn(store, "disconnect").mockRejectedValue(error);
    try {
      await expect(closeCache()).resolves.toBeUndefined();
      expect(getRedisConnection()).toBeNull();
      expect(getCacheBackend()).toBe("memory");
    } finally {
      cleanup.mockRestore();
      await store.disconnect(true);
      redis.disconnect();
    }
  });

  // 清空并重建命名空间时必须关闭旧连接，避免重复测试逐轮积累客户端。
  test.skipIf(!process.env.TEST_CACHE_REDIS_URL)("真实 Redis 全量清理释放旧连接并支持重建", async () => {
    const namespace = `cache-clear-regression-${crypto.randomUUID()}`;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const first = getCache(`${namespace}-a`);
      const second = getCache(`${namespace}-b`);
      await Promise.all([first.set("organization", "org-a"), second.set("organization", "org-b")]);
      const stores = [first.store, second.store];
      await clearAllCache();
      for (const store of stores) {
        if (!(store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
        expect(store.client.isOpen).toBe(false);
      }
      const reopened = getCache(`${namespace}-a`);
      expect(reopened).not.toBe(first);
      expect(await reopened.get("organization")).toBeUndefined();
    }
  });

  // 真实 Redis 验证首次写入、并发复用、租户隔离、TTL 与关闭后重建，不依赖模拟客户端。
  test.skipIf(!process.env.TEST_CACHE_REDIS_URL)("真实 Redis 完成缓存生命周期", async () => {
    const namespace = `cache-regression-${crypto.randomUUID()}`;
    const first = getCache(`${namespace}-a`, 1000);
    const second = getCache(`${namespace}-b`, 1000);
    await Promise.all([first.set("organization", { id: "org-a" }), second.set("organization", { id: "org-b" })]);
    expect(await first.get<{ id: string }>("organization")).toEqual({ id: "org-a" });
    expect(await second.get<{ id: string }>("organization")).toEqual({ id: "org-b" });
    await first.set("expiring", "value", 20);
    await Bun.sleep(40);
    expect(await first.get("expiring")).toBeUndefined();
    await first.clear();
    expect(await second.get<{ id: string }>("organization")).toEqual({ id: "org-b" });
    const store = second.store;
    if (!(store instanceof KeyvRedis)) throw new Error("非 Redis 存储");
    await closeCache();
    expect(store.client.isOpen).toBe(false);
    expect(getRedisConnection()).toBeNull();
    const reopened = getCache(`${namespace}-b`);
    expect(await reopened.get<{ id: string }>("organization")).toEqual({ id: "org-b" });
    await reopened.clear();
  });
});
