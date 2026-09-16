import { expect, test } from "bun:test";
import { waitForMachineConnection } from "../services/machine-connection-waiter";

// 已存在的沙盒应先立即查询 Machine 状态，在线时不进入轮询等待。
test("resolves immediately when the machine is already online", async () => {
  let reads = 0;
  await expect(
    waitForMachineConnection("mach_test", 30_000, async () => {
      reads += 1;
      return true;
    }),
  ).resolves.toBeUndefined();
  expect(reads).toBe(1);
});

// Machine 尚未在线时，轮询间隔应按 1s、2s、3s 递增。
test("uses increasing polling intervals after the initial status check", async () => {
  let reads = 0;
  const delays: number[] = [];
  await expect(
    waitForMachineConnection(
      "mach_test",
      30_000,
      async () => {
        reads += 1;
        return reads === 4;
      },
      async (delayMs) => {
        delays.push(delayMs);
      },
    ),
  ).resolves.toBeUndefined();
  expect(reads).toBe(4);
  expect(delays).toEqual([1000, 2000, 3000]);
});

// Machine 没有进入 online 时必须超时，不能无限占用创建请求。
test("rejects when the machine stays offline", async () => {
  await expect(waitForMachineConnection("mach_test", 1, async () => false)).rejects.toThrow("mach_test");
});
