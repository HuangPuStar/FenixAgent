import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAllCache, closeCache, getCache, getCacheBackend, getRedisConnection } from "../services/cache";

beforeEach(async () => {
  await closeCache();
  await clearAllCache();
});

afterEach(async () => {
  await clearAllCache();
  await closeCache();
});

describe("round29 缓存隔离与资源释放", () => {
  // 不同租户命名空间必须保存彼此独立的状态。
  test.each(Array.from({ length: 24 }, (_, index) => index))("隔离命名空间保存状态 %i", async (index) => {
    const first = getCache(`round29-tenant-${index}-first`);
    const second = getCache(`round29-tenant-${index}-second`);

    await first.set("workflow-status", `running-${index}`);
    await second.set("workflow-status", `finished-${index}`);

    expect(String(await first.get("workflow-status"))).toBe(`running-${index}`);
    expect(String(await second.get("workflow-status"))).toBe(`finished-${index}`);
  });

  // 同一工作流状态更新必须以最后一次写入为准。
  test.each(Array.from({ length: 12 }, (_, index) => index))("状态更新覆盖旧值 %i", async (index) => {
    const cache = getCache(`round29-state-${index}`);

    await cache.set("status", "pending");
    await cache.set("status", "running");
    await cache.set("status", "completed");

    expect(String(await cache.get("status"))).toBe("completed");
  });

  // 删除过期任务不能影响同一租户中的其他任务状态。
  test.each(Array.from({ length: 12 }, (_, index) => index))("删除仅释放目标任务 %i", async (index) => {
    const cache = getCache(`round29-delete-${index}`);

    await cache.set("expired-task", { id: `expired-${index}`, status: "failed" });
    await cache.set("active-task", { id: `active-${index}`, status: "running" });
    expect(await cache.delete("expired-task")).toBe(true);

    expect(await cache.get("expired-task")).toBeUndefined();
    expect(JSON.stringify(await cache.get("active-task"))).toBe(
      JSON.stringify({ id: `active-${index}`, status: "running" }),
    );
  });

  // 重复删除已释放资源必须安全，避免清理路径掩盖原始异常。
  test.each(Array.from({ length: 6 }, (_, index) => index))("重复释放资源安全 %i", async (index) => {
    const cache = getCache(`round29-idempotent-release-${index}`);

    await cache.set("connection", `connection-${index}`);
    await cache.delete("connection");

    await expect(cache.delete("connection")).resolves.toBe(false);
    expect(await cache.get("connection")).toBeUndefined();
  });

  // 同一租户应复用缓存实例，以保持会话内共享状态。
  test.each(Array.from({ length: 6 }, (_, index) => index))("同命名空间复用实例 %i", (index) => {
    expect(getCache(`round29-reuse-${index}`)).toBe(getCache(`round29-reuse-${index}`));
  });

  // 清理后必须释放所有命名空间，并让下一次访问获得干净状态。
  test.each(Array.from({ length: 6 }, (_, index) => index))("全量清理释放命名空间 %i", async (index) => {
    const namespace = `round29-cleanup-${index}`;
    const previous = getCache(namespace);
    await previous.set("leased-resource", `resource-${index}`);

    await clearAllCache();
    const next = getCache(namespace);

    expect(next).not.toBe(previous);
    expect(await next.get("leased-resource")).toBeUndefined();
  });

  // 未配置 Redis 时必须使用内存后端，且不创建外部连接。
  test("未配置 Redis 时使用内存并保持连接为空", () => {
    getCache("round29-memory-backend");

    expect(getCacheBackend()).toBe("memory");
    expect(getRedisConnection()).toBeNull();
  });

  // 关闭空后端必须幂等，确保异常恢复路径可重复执行。
  test("重复关闭空缓存安全", async () => {
    await closeCache();
    await expect(closeCache()).resolves.toBeUndefined();
    expect(getRedisConnection()).toBeNull();
  });
});
