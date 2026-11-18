import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../capacity/profile";
import { createHostProjectionIngress } from "./host-projection-ingress";

// 检查点只能在真实写入完成后推进；重复检查点不得再次写入。
test("源检查点等待全部提交且重复提交幂等", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const ingress = createHostProjectionIngress({
    capacity: DEFAULT_SYNC_CAPACITY,
    accept: async () => {
      count++;
      await gate;
    },
  });
  let completed = false;
  const input = {
    sourceCheckpoint: "g:1",
    records: [{ value: { test: 1 }, meta: { kind: "history_object" as const, entryId: "e" } }],
  };
  const pending = ingress.accept(input).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await pending;
  expect(completed).toBe(true);
  expect(await ingress.accept(input)).toEqual({ sourceCheckpoint: "g:1" });
  expect(count).toBe(1);
});

// 未提交事件不能被写者切换或下一次尝试跳过。
test("提交失败不确认检查点且允许重新提交", async () => {
  let count = 0;
  const ingress = createHostProjectionIngress({
    capacity: DEFAULT_SYNC_CAPACITY,
    accept: async () => {
      if (++count === 1) throw new Error("store unavailable");
    },
  });
  const input = {
    sourceCheckpoint: "g:1",
    records: [{ value: { test: 1 }, meta: { kind: "history_object" as const, entryId: "e" } }],
  };
  await expect(ingress.accept(input)).rejects.toThrow("store unavailable");
  expect(await ingress.accept(input)).toEqual({ sourceCheckpoint: "g:1" });
  expect(count).toBe(2);
});
