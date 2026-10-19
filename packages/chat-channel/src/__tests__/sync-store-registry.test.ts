// packages/chat-channel/src/__tests__/sync-store-registry.test.ts
// 同 scope 共享投影存储的生命周期：按 scope 复用、引用计数、引导只跑一次、失败不缓存。

import { describe, expect, test } from "bun:test";
import { SyncStoreRegistry } from "../sync/runtime/store-registry";
import type { ProjectionStore } from "../sync/store/types";

const SCOPE = { organizationId: "org-registry", rcsSessionId: "rcs_registry" };
const OTHER_SCOPE = { organizationId: "org-registry", rcsSessionId: "rcs_registry_2" };

/** 注册表只保存引用，不调用 store 方法；用空对象代表一个独立实例即可。 */
function fakeStore(): ProjectionStore {
  return {} as unknown as ProjectionStore;
}

describe("SyncStoreRegistry", () => {
  // 同一 scope 的连接必须拿到同一个 store 实例；不同 scope 不得串用。
  test("同 scope 复用同一 store，不同 scope 相互隔离", () => {
    const registry = new SyncStoreRegistry();
    const first = registry.acquire(SCOPE, fakeStore);
    const second = registry.acquire(SCOPE, fakeStore);
    const other = registry.acquire(OTHER_SCOPE, fakeStore);
    expect(second.store).toBe(first.store);
    expect(other.store).not.toBe(first.store);
    expect(registry.size).toBe(2);
    first.release();
    second.release();
    other.release();
    expect(registry.size).toBe(0);
  });

  // 引用计数归零才丢弃；重复 release 不得把计数减成负数。
  test("最后一个引用释放后丢弃 store，重复 release 幂等", () => {
    const registry = new SyncStoreRegistry();
    const first = registry.acquire(SCOPE, fakeStore);
    const second = registry.acquire(SCOPE, fakeStore);
    first.release();
    expect(registry.size).toBe(1);
    first.release();
    expect(registry.size).toBe(1);
    second.release();
    expect(registry.size).toBe(0);
  });

  // 并发握手共享同一个引导任务：历史导入只执行一次，后续连接直接复用结果。
  test("引导任务并发共享且只执行一次", async () => {
    const registry = new SyncStoreRegistry();
    const shared = registry.acquire(SCOPE, fakeStore);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "generation-1";
    };
    const [first, second] = await Promise.all([shared.bootstrap(task), shared.bootstrap(task)]);
    expect([first, second]).toEqual(["generation-1", "generation-1"]);
    expect(await shared.bootstrap(task)).toBe("generation-1");
    expect(runs).toBe(1);
    shared.release();
  });

  // 失败不缓存：下一次连接可以重试，失败不得被伪装成已完成的引导。
  test("引导失败不缓存，下一次调用重新执行", async () => {
    const registry = new SyncStoreRegistry();
    const shared = registry.acquire(SCOPE, fakeStore);
    let runs = 0;
    const task = async (): Promise<string> => {
      runs += 1;
      if (runs === 1) throw new Error("history unavailable");
      return "generation-retry";
    };
    await expect(shared.bootstrap(task)).rejects.toThrow("history unavailable");
    expect(await shared.bootstrap(task)).toBe("generation-retry");
    expect(runs).toBe(2);
    shared.release();
  });

  // 引用归零时引导仍在途：必须保留 store 到引导落定，避免导入成功却无人能读。
  test("引用归零但引导在途时保留 store，落定后丢弃", async () => {
    const registry = new SyncStoreRegistry();
    const shared = registry.acquire(SCOPE, fakeStore);
    let resolveTask: (value: string) => void = () => {};
    const task = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    const bootstrap = shared.bootstrap(() => task);
    shared.release();
    expect(registry.size).toBe(1);
    resolveTask("generation-late");
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.size).toBe(0);
  });
});
