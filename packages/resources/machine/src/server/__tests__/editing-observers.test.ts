import { expect, test } from "bun:test";
import { createMachineEditingObservers } from "../editing/editing-observers";

// 同一已授权环境共享观察器，最后一个引用退出后释放，启动中的旧实例不能复活。
test("scoped observers share references and close after last release", async () => {
  let opened = 0;
  let closed = 0;
  const manager = createMachineEditingObservers({
    root: async () => "/workspace/verified",
    publish() {},
    observe() {
      opened++;
      return {
        ready: Promise.resolve(),
        async close() {
          closed++;
        },
      };
    },
  });
  const scope = { organizationId: "o", userId: "u", environmentId: "e" };
  const first = manager.retain(scope);
  const second = manager.retain(scope);
  await Bun.sleep(0);
  expect(opened).toBe(1);
  first();
  expect(closed).toBe(0);
  second();
  await Bun.sleep(0);
  expect(closed).toBe(1);
  const releasePending = manager.retain(scope);
  releasePending();
  await Bun.sleep(0);
  expect(opened).toBe(1);
  await manager.dispose();
});

// 目录扫描未就绪时退出，关闭动作仍只执行一次，避免句柄重复释放。
test("release during initial scan closes the observer once", async () => {
  let ready!: () => void;
  const scanned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let closed = 0;
  const manager = createMachineEditingObservers({
    root: async () => "/workspace/verified",
    publish() {},
    observe() {
      return {
        ready: scanned,
        async close() {
          closed++;
          ready();
        },
      };
    },
  });
  const release = manager.retain({ organizationId: "o", userId: "u", environmentId: "e" });
  await Bun.sleep(0);
  release();
  await manager.dispose();
  expect(closed).toBe(1);
});
