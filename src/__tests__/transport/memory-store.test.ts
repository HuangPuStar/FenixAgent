import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "../../transport/store/memory-store";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ── Relay Socket 映射 ──

  // 设置并获取 relay socket
  test("setRelaySocket 后 getRelaySocket 返回正确值", async () => {
    await store.setRelaySocket("inst-1", "socket-001");
    const result = await store.getRelaySocket("inst-1");
    expect(result).toBe("socket-001");
  });

  // 不存在的 instance 返回 null
  test("getRelaySocket 不存在的 instance 返回 null", async () => {
    const result = await store.getRelaySocket("nonexistent");
    expect(result).toBeNull();
  });

  // 覆盖设置 relay socket
  test("setRelaySocket 覆盖已有映射", async () => {
    await store.setRelaySocket("inst-1", "socket-001");
    await store.setRelaySocket("inst-1", "socket-002");
    expect(await store.getRelaySocket("inst-1")).toBe("socket-002");
  });

  // 删除 relay socket
  test("delRelaySocket 后 getRelaySocket 返回 null", async () => {
    await store.setRelaySocket("inst-1", "socket-001");
    await store.delRelaySocket("inst-1");
    expect(await store.getRelaySocket("inst-1")).toBeNull();
  });

  // 删除不存在的 instance 不报错
  test("delRelaySocket 不存在的 instance 不报错", async () => {
    await store.delRelaySocket("nonexistent");
    // 不应抛出异常
  });

  // ── Machine Socket 映射 ──

  // 设置并获取 machine socket
  test("setMachineSocket 后 getMachineSocket 返回正确值", async () => {
    await store.setMachineSocket("mach-1", "socket-101");
    const result = await store.getMachineSocket("mach-1");
    expect(result).toBe("socket-101");
  });

  // 不存在的 machine 返回 null
  test("getMachineSocket 不存在的 machine 返回 null", async () => {
    const result = await store.getMachineSocket("nonexistent");
    expect(result).toBeNull();
  });

  // 删除 machine socket
  test("delMachineSocket 后 getMachineSocket 返回 null", async () => {
    await store.setMachineSocket("mach-1", "socket-101");
    await store.delMachineSocket("mach-1");
    expect(await store.getMachineSocket("mach-1")).toBeNull();
  });

  // relay 和 machine 命名空间隔离
  test("relay 和 machine 映射彼此隔离", async () => {
    await store.setRelaySocket("inst-1", "r-socket");
    await store.setMachineSocket("inst-1", "m-socket");
    expect(await store.getRelaySocket("inst-1")).toBe("r-socket");
    expect(await store.getMachineSocket("inst-1")).toBe("m-socket");
    await store.delRelaySocket("inst-1");
    expect(await store.getRelaySocket("inst-1")).toBeNull();
    expect(await store.getMachineSocket("inst-1")).toBe("m-socket");
  });

  // ── Pub/Sub ──

  // 发布消息给已订阅的 handler
  test("publish 发送消息给已订阅的 handler", async () => {
    const received: string[] = [];
    await store.subscribe("chan-1", (msg) => received.push(msg));
    await store.publish("chan-1", "hello");
    expect(received).toEqual(["hello"]);
  });

  // 无订阅者时 publish 不报错
  test("publish 无订阅者时不报错", async () => {
    await store.publish("no-subscribers", "ping");
    // 不应抛出异常
  });

  // 多个订阅者全部收到消息
  test("publish 发送给同一 channel 的所有订阅者", async () => {
    const r1: string[] = [];
    const r2: string[] = [];
    await store.subscribe("c", (msg) => r1.push(msg));
    await store.subscribe("c", (msg) => r2.push(msg));
    await store.publish("c", "broadcast");
    expect(r1).toEqual(["broadcast"]);
    expect(r2).toEqual(["broadcast"]);
  });

  // 取消订阅后不再收到消息
  test("取消订阅后 handler 不再收到消息", async () => {
    const received: string[] = [];
    const unsub = await store.subscribe("c", (msg) => received.push(msg));
    unsub();
    await store.publish("c", "ghost");
    expect(received).toHaveLength(0);
  });

  // 不同 channel 消息隔离
  test("不同 channel 之间消息隔离", async () => {
    const r1: string[] = [];
    const r2: string[] = [];
    await store.subscribe("a", (msg) => r1.push(msg));
    await store.subscribe("b", (msg) => r2.push(msg));
    await store.publish("a", "for-a");
    expect(r1).toEqual(["for-a"]);
    expect(r2).toHaveLength(0);
  });

  // handler 抛异常不影响其他 handler
  test("subscribe handler 抛异常不影响其他 handler", async () => {
    const received: string[] = [];
    await store.subscribe("c", () => {
      throw new Error("boom");
    });
    await store.subscribe("c", (msg) => received.push(msg));
    await store.publish("c", "resilient");
    expect(received).toEqual(["resilient"]);
  });

  // ── 健康检查 ──

  // MemoryStore 始终返回 true
  test("healthCheck 始终返回 true", async () => {
    const healthy = await store.healthCheck();
    expect(healthy).toBe(true);
  });

  // ── 关闭 ──

  // close 清空所有映射
  test("close 清空 relay 和 machine 映射", async () => {
    await store.setRelaySocket("r", "s");
    await store.setMachineSocket("m", "s");
    await store.close();
    expect(await store.getRelaySocket("r")).toBeNull();
    expect(await store.getMachineSocket("m")).toBeNull();
  });

  // close 后 publish 为空操作
  test("close 后 publish 不报错", async () => {
    const received: string[] = [];
    await store.subscribe("c", (msg) => received.push(msg));
    await store.close();
    await store.publish("c", "after-close");
    expect(received).toHaveLength(0);
  });
});
