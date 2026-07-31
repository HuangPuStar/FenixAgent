import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createYjsWsClient } from "../transport/ws";

type ScheduledTimer = {
  callback: () => void;
  cleared: boolean;
  delay: number | undefined;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client_disconnect" } as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeFromServer(code = 1006, reason = "connection_lost"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  send(_data: string): void {}
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
let timers: ScheduledTimer[];

function installFakes(): void {
  FakeWebSocket.instances = [];
  timers = [];

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      const timer = { callback, cleared: false, delay };
      timers.push(timer);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: ScheduledTimer) => {
      timer.cleared = true;
    },
  });
}

function restoreGlobal(
  name: "WebSocket" | "setTimeout" | "clearTimeout",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function runNextTimer(): void {
  const timer = timers.shift();
  if (!timer) throw new Error("预期存在重连定时器");
  if (!timer.cleared) timer.callback();
}

function createClient(onConnectionState?: (state: "connecting" | "connected" | "disconnected") => void) {
  return createYjsWsClient({
    url: "ws://example.test/acp/yjs/agent_1",
    onYjsUpdate: () => {},
    onConnectionState,
  });
}

describe("createYjsWsClient", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    restoreGlobal("WebSocket", originalWebSocket);
    restoreGlobal("setTimeout", originalSetTimeout);
    restoreGlobal("clearTimeout", originalClearTimeout);
  });

  // 网络持续中断时，客户端应按指数退避逐步延长重连等待时间，避免持续冲击服务端。
  test("连续断线使用递增的重连延迟", () => {
    const client = createClient();
    client.connect();

    FakeWebSocket.instances[0]?.closeFromServer();
    expect(timers[0]?.delay).toBe(1000);

    runNextTimer();
    FakeWebSocket.instances[1]?.closeFromServer();
    expect(timers[0]?.delay).toBe(2000);

    runNextTimer();
    FakeWebSocket.instances[2]?.closeFromServer();
    expect(timers[0]?.delay).toBe(4000);
  });

  // 连接曾成功恢复后，下一次断线应从最短退避时间重新开始。
  test("连接成功后重置重连延迟", () => {
    const client = createClient();
    client.connect();

    FakeWebSocket.instances[0]?.closeFromServer();
    runNextTimer();
    FakeWebSocket.instances[1]?.open();
    FakeWebSocket.instances[1]?.closeFromServer();

    expect(timers[0]?.delay).toBe(1000);
  });

  // 面板或调用方销毁客户端后，已排队的重连不得再创建新的连接。
  test("disconnect 取消已排队的重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer();

    const timer = timers[0];
    client.disconnect();

    expect(timer?.cleared).toBe(true);
    runNextTimer();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 主动断开会同步触发 close 回调时，只能显式通知一次断开且不得排队重连。
  test("disconnect 的同步 close 不重复通知或重连", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    FakeWebSocket.instances[0]?.open();

    client.disconnect();

    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(timers).toHaveLength(0);
  });

  // 已销毁客户端收到迟到 close 时，不得重复断开通知或排队重连。
  test("disconnect 后的迟到 close 不重复通知或重连", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();

    client.disconnect();
    socket?.closeFromServer();

    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(timers).toHaveLength(0);
  });

  // 旧连接迟到关闭时，不能覆盖新连接状态或为旧连接额外排队重连。
  test("旧 socket 的迟到 close 不影响新 socket", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket?.closeFromServer();
    runNextTimer();
    const newSocket = FakeWebSocket.instances[1];
    newSocket?.open();

    oldSocket?.closeFromServer();

    expect(states).toEqual(["connecting", "disconnected", "connecting", "connected"]);
    expect(timers).toHaveLength(0);
  });

  // 服务端以 idle reclaim 关闭时，客户端必须停止自动重连，等待上层生命周期重新建连。
  test("4001 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4001, "idle_reclaim");

    expect(timers).toHaveLength(0);
  });

  // 远程机器不可用时，继续建连无法恢复服务，客户端必须停止自动重连。
  test("4500 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4500, "machine offline");

    expect(timers).toHaveLength(0);
  });

  // 服务端因客户端 keepalive 超时关闭时，客户端必须终止且不得排队自动重连。
  test("4501 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4501, "client keepalive timeout");

    expect(timers).toHaveLength(0);
  });
});
