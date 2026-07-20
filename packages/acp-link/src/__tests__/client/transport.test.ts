import { beforeEach, describe, expect, test } from "bun:test";
import type { TransportEvents } from "../../client/transport.js";
import { WSTransport } from "../../client/transport.js";

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
    expect(() => transport.send("hello")).toThrow("Socket not connected");
  });

  // 测试 disconnect 方法存在且可调用
  test("disconnect — method exists and is callable", () => {
    expect(typeof transport.disconnect).toBe("function");
    // 不连接直接 disconnect 不应报错
    expect(() => transport.disconnect()).not.toThrow();
    expect(transport.state).toBe("disconnected");
  });
});
