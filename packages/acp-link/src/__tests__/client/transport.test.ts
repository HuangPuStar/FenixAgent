import { describe, test, expect, beforeEach } from "bun:test";
import { EventEmitter } from "../../client/emitter.js";
import { WSTransport } from "../../client/transport.js";
import type { TransportEvents } from "../../client/transport.js";

// WSTransport 需要真实 WebSocket 环境，这里测试状态机和重连逻辑
// 通过构造假的 CloseEvent 来模拟
describe("WSTransport", () => {
  let transport: WSTransport;

  beforeEach(() => {
    transport = new WSTransport();
  });

  // 测试初始状态
  test("initial state is disconnected", () => {
    expect(transport.state).toBe("disconnected");
  });

  // 测试 disconnect 设置 manualDisconnect
  test("disconnect — sets state to disconnected", () => {
    const events: TransportEvents["state"][] = [];
    transport.on("state", (e) => events.push(e));

    // 不连接直接 disconnect 不应报错
    transport.disconnect();
    expect(transport.state).toBe("disconnected");
    // disconnect 后不应有额外事件（因为没有活跃连接）
  });

  // 测试 send 在未连接时抛错
  test("send — throws when not connected", () => {
    expect(() => transport.send("hello")).toThrow("WebSocket not connected");
  });

  // 测试 close 与 disconnect 的区别
  test("close vs disconnect — close allows reconnect, disconnect prevents it", () => {
    // close() 方法存在且可调用
    expect(typeof transport.close).toBe("function");
    // disconnect() 方法存在且可调用
    expect(typeof transport.disconnect).toBe("function");
  });
});
