import { afterAll, describe, expect, test } from "bun:test";

// 延迟导入：确保在 process.env 设置后再加载 factory 模块
// 注意：factory.ts 的模块级 _store 单例在首次 import 时初始化，
// 测试通过 closeTransportStore() 在 test 间重置状态。
async function resetAndImport() {
  const { closeTransportStore, getTransportStore, getRedisClient } = await import("../../transport/store/factory");
  await closeTransportStore();
  return { closeTransportStore, getTransportStore, getRedisClient };
}

describe("TransportStore Factory", () => {
  const originalEnv = { ...process.env };

  afterAll(async () => {
    const { closeTransportStore } = await import("../../transport/store/factory");
    await closeTransportStore();
    process.env = { ...originalEnv };
  });

  // 无 RCS_REDIS_URL 时创建 MemoryStore
  test("无 RCS_REDIS_URL 时 getTransportStore 返回 MemoryStore 实例", async () => {
    delete process.env.RCS_REDIS_URL;
    const { getTransportStore } = await resetAndImport();
    const store = getTransportStore();
    expect(store.constructor.name).toBe("MemoryStore");
  });

  // getTransportStore 单例 — 多次调用返回同一实例
  test("getTransportStore 多次调用返回同一实例", async () => {
    delete process.env.RCS_REDIS_URL;
    const { getTransportStore } = await resetAndImport();
    const s1 = getTransportStore();
    const s2 = getTransportStore();
    expect(s1).toBe(s2);
  });

  // MemoryStore 模式下 connectTransportStore 不报错
  test("MemoryStore 模式下 connectTransportStore 不报错", async () => {
    delete process.env.RCS_REDIS_URL;
    const { connectTransportStore } = await import("../../transport/store/factory");
    await connectTransportStore();
    // 不应抛出异常
  });

  // MemoryStore 模式下 getRedisClient 返回 undefined
  test("MemoryStore 模式下 getRedisClient 返回 undefined", async () => {
    delete process.env.RCS_REDIS_URL;
    const { getRedisClient } = await resetAndImport();
    expect(getRedisClient()).toBeUndefined();
  });

  // closeTransportStore 重置单例
  test("closeTransportStore 后 getTransportStore 创建新实例", async () => {
    delete process.env.RCS_REDIS_URL;
    const { closeTransportStore, getTransportStore } = await resetAndImport();
    const s1 = getTransportStore();
    await closeTransportStore();
    const s2 = getTransportStore();
    expect(s1).not.toBe(s2);
  });

  // closeTransportStore 可安全多次调用
  test("closeTransportStore 可安全多次调用", async () => {
    delete process.env.RCS_REDIS_URL;
    const { closeTransportStore, getTransportStore } = await resetAndImport();
    getTransportStore();
    await closeTransportStore();
    await closeTransportStore();
    // 不应抛出异常
  });

  // 有 RCS_REDIS_URL 时创建 RedisStore（不依赖真实连接，仅验证类型）
  test("有 RCS_REDIS_URL 时 getTransportStore 创建 RedisStore（验证类型切换）", async () => {
    process.env.RCS_REDIS_URL = "redis://localhost:6379";
    // RedisStore 构造时默认 lazyConnect: true，不会真正连接 Redis，
    // 此处仅验证 factory 分支选择正确（构造函数名为 RedisStore）
    const { getTransportStore, closeTransportStore } = await resetAndImport();
    const store = getTransportStore();
    expect(store.constructor.name).toBe("RedisStore");
    await closeTransportStore();
  });
});
