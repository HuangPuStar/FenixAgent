import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";

// Mock WebSocket constructor
let mockWs: {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

function createMockWs() {
  mockWs = {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 0, // CONNECTING
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return mockWs;
}

const originalWebSocket = globalThis.WebSocket;
let wsConstructor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createMockWs();
  wsConstructor = vi.fn(() => mockWs);
  globalThis.WebSocket = wsConstructor as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("HermesClient", () => {
  test("start() 连接成功后发送 subscribe 包含默认平台列表", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();

    mockWs.readyState = 1;
    mockWs.onopen!({} as Event);

    // Default platforms include common Hermes platforms
    const subscribeCalls = mockWs.send.mock.calls.filter((call) => JSON.parse(call[0] as string).type === "subscribe");
    expect(subscribeCalls.length).toBe(1);
    const platforms = JSON.parse(subscribeCalls[0][0]).platforms as string[];
    expect(platforms).toContain("feishu");
    expect(platforms).toContain("telegram");
  });

  test("start() 连接失败触发重连", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();

    // Simulate connection close
    mockWs.onclose!({ code: 1006, reason: "" } as CloseEvent);

    const status = client.getStatus();
    expect(status.reconnecting).toBe(true);
    expect(status.connected).toBe(false);

    // Wait for reconnect timer (2s initial delay)
    await Bun.sleep(2100);
    expect(wsConstructor).toHaveBeenCalledTimes(2);
  });

  test("stop() 优雅关闭", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({} as Event);

    await client.stop();

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"unsubscribe"'));
    expect(mockWs.close).toHaveBeenCalledWith(1000, "shutdown");

    const status = client.getStatus();
    expect(status.connected).toBe(false);
  });

  test("getStatus() 返回状态快照", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    const status1 = client.getStatus();
    const status2 = client.getStatus();
    expect(status1).toEqual(status2);
    expect(status1).not.toBe(status2);
  });

  test("send() 出站消息使用 content 字段", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({} as Event);

    client.send("feishu", "chat_123", "hello");

    const sent = JSON.parse(mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0]);
    expect(sent.type).toBe("send");
    expect(sent.platform).toBe("feishu");
    expect(sent.chat_id).toBe("chat_123");
    expect(sent.content).toBe("hello");
  });

  test("send() 连接断开时不报错", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    // Don't open the connection

    // Should not throw
    expect(() => client.send("feishu", "chat_123", "hello")).not.toThrow();
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  test("onStatusChange 注册和取消", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    const cb = vi.fn();
    const unsub = client.onStatusChange(cb);

    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({} as Event);
    expect(cb).toHaveBeenCalled();

    cb.mockClear();
    unsub();
    mockWs.onclose!({ code: 1000, reason: "" } as CloseEvent);
    expect(cb).not.toHaveBeenCalled();
  });

  test("handleMessage platform_status connected 时更新已连接平台列表", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({} as Event);

    // Initial subscribe sent on connect (contains default platforms)
    const subscribeCalls = mockWs.send.mock.calls.filter((call) => JSON.parse(call[0] as string).type === "subscribe");
    expect(subscribeCalls.length).toBe(1);

    // Simulate platform_status for feishu connected (from Hermes response to subscribe)
    mockWs.onmessage!({
      data: JSON.stringify({ type: "platform_status", platform: "feishu", state: "connected" }),
    } as MessageEvent);

    const status = client.getStatus();
    expect(status.platforms).toEqual(["feishu"]);

    // Simulate telegram connected
    mockWs.onmessage!({
      data: JSON.stringify({ type: "platform_status", platform: "telegram", state: "connected" }),
    } as MessageEvent);
    expect(client.getStatus().platforms).toEqual(["feishu", "telegram"]);

    // Simulate feishu disconnected
    mockWs.onmessage!({
      data: JSON.stringify({ type: "platform_status", platform: "feishu", state: "disconnected" }),
    } as MessageEvent);
    expect(client.getStatus().platforms).toEqual(["telegram"]);
  });

  test("handleMessage 忽略未知类型", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({});

    // Should not throw
    expect(() => {
      mockWs.onmessage!({ data: JSON.stringify({ type: "unknown_type" }) });
    }).not.toThrow();
  });

  test("pong 消息被正确处理", async () => {
    const { HermesClient } = await import("../server/services/hermes-client");

    const client = new HermesClient("ws://127.0.0.1:8642/messaging");
    client.start();
    mockWs.readyState = 1;
    mockWs.onopen!({});

    // Send a pong message — should not throw
    expect(() => {
      mockWs.onmessage!({ data: JSON.stringify({ type: "pong" }) });
    }).not.toThrow();
  });
});
