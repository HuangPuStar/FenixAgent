import { describe, expect, test } from "bun:test";
import { PortAllocator } from "../process/port-allocator";

describe("PortAllocator", () => {
  // 顺序分配端口
  test("allocates ports sequentially within the default range", async () => {
    const allocator = new PortAllocator(8888, 8890, {
      probePort: async () => true,
    });

    expect(await allocator.allocate()).toBe(8888);
    expect(await allocator.allocate()).toBe(8889);
  });

  // 端口探测失败跳过
  test("skips ports that fail probing and reuses released ports", async () => {
    const allocator = new PortAllocator(8888, 8890, {
      probePort: async (port) => port !== 8888,
    });

    const first = await allocator.allocate();
    expect(first).toBe(8889);

    allocator.release(first);
    const second = await allocator.allocate();
    expect(second).toBe(8889);
  });
});
