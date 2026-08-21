import { afterEach, describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import type { RelaySocket } from "../relay/relay-handle";
import { createRelayHandle } from "../relay/relay-handle";

interface FakeRelaySocket extends RelaySocket {
  readonly sent: string[];
  disconnect(): void;
  fail(): void;
}

function createFakeSocket(): FakeRelaySocket {
  const socket: FakeRelaySocket = {
    readyState: 0,
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
    disconnect() {
      this.readyState = 3;
      this.onclose?.();
    },
    fail() {
      this.onerror?.();
    },
  };
  return socket;
}

const openHandles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    handle.close();
  }
});

function createFixture(
  keepAliveIntervalMs = 20_000,
  setInterval?: (callback: () => void) => ReturnType<typeof setInterval>,
) {
  const socket = createFakeSocket();
  const handle = createRelayHandle(
    { instanceId: "lifecycle-test", port: 8123, token: "token-test" },
    {
      createWebSocket: () => socket,
      keepAliveIntervalMs,
      setInterval: setInterval ? (callback) => setInterval(callback) : undefined,
      clearInterval: () => {},
    },
  );
  openHandles.push(handle);
  return { handle, socket };
}

describe("CCB relay handle 生命周期补充", () => {
  // 已经完成 ready 后重复收到 open 仍应发送握手，但不能再次结算 ready。
  test("ready 完成后重复 open 只发送新的 connect 握手", async () => {
    const { handle, socket } = createFixture();
    socket.readyState = 1;
    socket.onopen?.();
    await handle.ready;

    socket.onopen?.();

    expect(socket.sent).toEqual(['{"type":"connect"}', '{"type":"connect"}']);
  });

  // websocket 在首次 open 前断开时，ready 必须拒绝并报告断连事件。
  test("open 前远端关闭会拒绝 ready", async () => {
    const { handle, socket } = createFixture();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));

    socket.disconnect();

    await expect(handle.ready).rejects.toThrow("Relay closed before websocket open");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
  });

  // websocket 在首次 open 前报错时，ready 必须拒绝并保留错误诊断码。
  test("open 前 socket 错误会拒绝 ready", async () => {
    const { handle, socket } = createFixture();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));

    socket.fail();

    await expect(handle.ready).rejects.toThrow("Relay websocket errored before open");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
  });

  // open relay 应按依赖注入的周期发送传输层 ping，且测试结束时由 afterEach 清理定时器。
  test("保持连接定时发送 ping", async () => {
    let keepalive: (() => void) | undefined;
    const { handle, socket } = createFixture(1, (callback) => {
      keepalive = callback;
      return 0 as ReturnType<typeof setInterval>;
    });
    socket.readyState = 1;
    socket.onopen?.();
    await handle.ready;

    keepalive?.();

    expect(socket.sent.some((data) => data === '{"type":"ping"}')).toBeTrue();
  });
});

export {};
