import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WSTransport } from "../client/transport.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static shouldThrow = false;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    if (FakeWebSocket.shouldThrow) {
      throw new Error("connection failed");
    }
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }

  closed(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

describe("WSTransport round 38", () => {
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  let scheduled: (() => void)[];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.shouldThrow = false;
    scheduled = [];
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (timer: number) => {
        scheduled[timer - 1] = () => {};
      },
    });
  });

  afterEach(() => {
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
    if (clearTimeoutDescriptor) Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
  });

  // 连接建立后应更新状态、转发原始消息，并允许发送数据。
  test("连接、消息转发与发送走当前已打开的 socket", () => {
    const transport = new WSTransport();
    const states: string[] = [];
    const messages: string[] = [];
    transport.on("state", ({ state }) => states.push(state));
    transport.on("message", (message) => messages.push(message));

    transport.connect("ws://relay.test/session");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message('{"type":"ready"}');
    transport.send("ping");

    expect(transport.state).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
    expect(messages).toEqual(['{"type":"ready"}']);
    expect(socket.sent).toEqual(["ping"]);
  });

  // 新连接替换旧连接后，旧连接的所有异步回调都必须被隔离。
  test("旧连接的打开、消息和关闭回调不会影响新连接", () => {
    const transport = new WSTransport();
    const messages: string[] = [];
    transport.on("message", (message) => messages.push(message));

    transport.connect("ws://relay.test/first");
    const first = FakeWebSocket.instances[0];
    transport.connect("ws://relay.test/second");
    const second = FakeWebSocket.instances[1];
    first.open();
    first.message("stale");
    first.closed(1000);
    second.open();
    second.message("current");

    expect(first.closeCalls).toBe(1);
    expect(transport.state).toBe("connected");
    expect(messages).toEqual(["current"]);
  });

  // socket error 仅由 close 决定状态，错误事件本身不能提前改变连接状态。
  test("错误事件不会改变当前连接状态", () => {
    const transport = new WSTransport();
    const states: string[] = [];
    transport.on("state", ({ state }) => states.push(state));

    transport.connect("ws://relay.test/error");
    FakeWebSocket.instances[0].error();

    expect(transport.state).toBe("connecting");
    expect(states).toEqual(["connecting"]);
  });

  // 正常关闭应透传 CloseEvent 并停止自动重连。
  test("正常关闭转为 disconnected 并保留关闭原因", () => {
    const transport = new WSTransport();
    const states: { state: string; detail?: CloseEvent }[] = [];
    transport.on("state", (event) => states.push(event));

    transport.connect("ws://relay.test/normal-close");
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].closed(1000);

    expect(transport.state).toBe("disconnected");
    expect(states[2].detail?.code).toBe(1000);
    expect(scheduled).toHaveLength(0);
  });

  // machine_unavailable 应直接进入错误状态，不应安排重连。
  test("4500 关闭进入 error 且不重连", () => {
    const transport = new WSTransport();
    const reconnecting: number[] = [];
    transport.on("reconnecting", ({ attempt }) => reconnecting.push(attempt));

    transport.connect("ws://relay.test/unavailable");
    FakeWebSocket.instances[0].closed(4500);

    expect(transport.state).toBe("error");
    expect(reconnecting).toEqual([]);
    expect(scheduled).toHaveLength(0);
  });

  // 异常关闭应通知重连，并在计时器执行时使用原 URL 创建新连接。
  test("异常关闭安排重连并复用原连接地址", () => {
    const transport = new WSTransport();
    const reconnecting: { attempt: number; maxAttempts: number }[] = [];
    transport.on("reconnecting", (event) => reconnecting.push(event));

    transport.connect("ws://relay.test/retry");
    FakeWebSocket.instances[0].closed(1006);
    scheduled[0]();

    expect(reconnecting).toEqual([{ attempt: 1, maxAttempts: 5 }]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("ws://relay.test/retry");
    expect(transport.state).toBe("connecting");
  });

  // 手动断开必须取消尚未执行的自动重连计时器。
  test("手动断开取消已安排的重连", () => {
    const transport = new WSTransport();

    transport.connect("ws://relay.test/cancel-retry");
    FakeWebSocket.instances[0].closed(1006);
    transport.disconnect();
    scheduled[0]();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 构造 WebSocket 失败时应报告 error 和 reconnectFailed。
  test("创建连接抛错时报告失败", () => {
    const transport = new WSTransport();
    let failed = 0;
    transport.on("reconnectFailed", () => failed++);
    FakeWebSocket.shouldThrow = true;

    transport.connect("ws://relay.test/fail");

    expect(transport.state).toBe("error");
    expect(failed).toBe(1);
  });
});
