import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "../../client/emitter.js";

// EventEmitter 类型安全事件系统测试
describe("EventEmitter", () => {
  let emitter: EventEmitter<{ greet: string; count: number; void: undefined }>;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  // 测试基本 on + emit
  test("on + emit — receives payload", () => {
    const received: string[] = [];
    emitter.on("greet", (name) => received.push(name));
    emitter.emit("greet", "world");
    expect(received).toEqual(["world"]);
  });

  // 测试 void 事件
  test("void event — no payload", () => {
    let called = false;
    emitter.on("void", () => {
      called = true;
    });
    emitter.emit("void");
    expect(called).toBe(true);
  });

  // 测试多个监听器
  test("multiple listeners — all receive event", () => {
    const results: number[] = [];
    emitter.on("count", (n) => results.push(n * 2));
    emitter.on("count", (n) => results.push(n * 3));
    emitter.emit("count", 5);
    expect(results).toEqual([10, 15]);
  });

  // 测试 off 移除监听器
  test("off — removes specific listener", () => {
    const results: number[] = [];
    const handler = (n: number) => results.push(n);
    emitter.on("count", handler);
    emitter.on("count", (n) => results.push(n * 10));
    emitter.off("count", handler);
    emitter.emit("count", 1);
    expect(results).toEqual([10]);
  });

  // 测试 removeAllListeners(event)
  test("removeAllListeners(event) — removes listeners for specific event", () => {
    const results: string[] = [];
    emitter.on("greet", (name) => results.push(name));
    emitter.on("greet", (name) => results.push(`${name}!`));
    emitter.removeAllListeners("greet");
    emitter.emit("greet", "hello");
    expect(results).toEqual([]);
  });

  // 测试 removeAllListeners() 不带参数
  test("removeAllListeners() — removes all listeners", () => {
    let greetCalled = false;
    let countCalled = false;
    emitter.on("greet", () => {
      greetCalled = true;
    });
    emitter.on("count", () => {
      countCalled = true;
    });
    emitter.removeAllListeners();
    emitter.emit("greet", "hello");
    emitter.emit("count", 1);
    expect(greetCalled).toBe(false);
    expect(countCalled).toBe(false);
  });
});
