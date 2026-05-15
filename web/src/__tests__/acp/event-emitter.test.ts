import { describe, test, expect, beforeEach } from "bun:test";
import { EventEmitter } from "../../acp/emitter";

// EventEmitter 单元测试
describe("EventEmitter", () => {
  let emitter: EventEmitter<{ tick: void; data: number; msg: string }>;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  // 测试 on + emit 基础功能
  test("on + emit — void event", () => {
    let called = false;
    emitter.on("tick", () => { called = true; });
    emitter.emit("tick");
    expect(called).toBe(true);
  });

  // 测试 payload 事件
  test("on + emit — payload event", () => {
    let received = 0;
    emitter.on("data", (n) => { received = n; });
    emitter.emit("data", 42);
    expect(received).toBe(42);
  });

  // 测试多个监听者
  test("multiple listeners for same event", () => {
    const results: number[] = [];
    emitter.on("data", (n) => results.push(n));
    emitter.on("data", (n) => results.push(n * 10));
    emitter.emit("data", 5);
    expect(results).toEqual([5, 50]);
  });

  // 测试 off 移除监听者
  test("off removes specific listener", () => {
    let calls = 0;
    const handler = () => { calls++; };
    emitter.on("tick", handler);
    emitter.emit("tick");
    emitter.off("tick", handler);
    emitter.emit("tick");
    expect(calls).toBe(1);
  });

  // 测试 removeAllListeners 移除特定事件
  test("removeAllListeners — specific event", () => {
    let calls = 0;
    emitter.on("tick", () => { calls++; });
    emitter.on("data", () => { calls++; });
    emitter.removeAllListeners("tick");
    emitter.emit("tick");
    emitter.emit("data", 1);
    expect(calls).toBe(1);
  });

  // 测试 removeAllListeners 移除所有事件
  test("removeAllListeners — all events", () => {
    let calls = 0;
    emitter.on("tick", () => { calls++; });
    emitter.on("data", () => { calls++; });
    emitter.removeAllListeners();
    emitter.emit("tick");
    emitter.emit("data", 1);
    expect(calls).toBe(0);
  });

  // 测试 off 不存在的 handler 不报错
  test("off non-existent handler does not throw", () => {
    expect(() => emitter.off("tick", () => {})).not.toThrow();
  });
});
