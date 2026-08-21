import { describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createRelayHandle, type RelaySocket } from "../relay/relay-handle";

class MemoryRelaySocket implements RelaySocket {
  readyState = 1;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }

  receive(data: string | Buffer): void {
    this.onmessage?.({ data });
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "memory disconnect" });
  }

  fail(): void {
    this.readyState = 3;
    this.onerror?.(new Error("memory socket error"));
  }
}

function createMemoryRelay(socket = new MemoryRelaySocket(), keepAliveIntervalMs = 60_000) {
  const handle = createRelayHandle(
    { instanceId: "coverage-relay", port: 9732, token: "memory-token" },
    { createWebSocket: () => socket, keepAliveIntervalMs },
  );
  return { handle, socket };
}

describe("relay-handle 覆盖真实生命周期分支", () => {
  // Buffer 业务帧在首个订阅取消后，应由下一位订阅者重新接收回放。
  test("最后一个订阅取消后重新缓冲并回放 Buffer 帧", () => {
    const { handle, socket } = createMemoryRelay();
    try {
      const first: EngineRelayMessage[] = [];
      const unsubscribe = handle.onMessage((message) => first.push(message));
      unsubscribe();

      socket.receive(Buffer.from('{"type":"event","payload":{"source":"buffer"}}'));

      const replayed: EngineRelayMessage[] = [];
      handle.onMessage((message) => replayed.push(message));
      expect(first).toEqual([]);
      expect(replayed).toEqual([{ type: "event", payload: { source: "buffer" } }]);
    } finally {
      handle.close();
    }
  });

  // 未完成 ready 的连接报错时，订阅者必须收到关闭事件且 ready 被拒绝。
  test("打开前错误会关闭 relay 并拒绝 ready", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryRelay(socket);
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));

    socket.fail();

    await expect(handle.ready).rejects.toThrow("Relay websocket errored before open");
    expect(handle.state).toBe("closed");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
    expect(() => handle.send({ type: "request" })).toThrow("Relay is closed");
  });

  // 打开前断开应清空缓存、通知订阅者并拒绝 ready。
  test("打开前关闭会通知订阅者并拒绝 ready", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryRelay(socket);
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));

    socket.disconnect();

    await expect(handle.ready).rejects.toThrow("Relay closed before websocket open");
    expect(handle.state).toBe("closed");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
  });

  // 本地 ping 与入站 pong 都是控制帧，既不发往 socket 也不投递给业务订阅。
  test("ping 和 pong 控制帧不会泄漏到业务流", () => {
    const { handle, socket } = createMemoryRelay();
    try {
      const received: EngineRelayMessage[] = [];
      handle.onMessage((message) => received.push(message));

      handle.send({ type: "ping" });
      socket.receive('{"type":"pong"}');

      expect(socket.sent).toEqual([]);
      expect(received).toEqual([]);
    } finally {
      handle.close();
    }
  });

  // 显式关闭应转交 code/reason，停止 keepalive，并拒绝后续发送。
  test("发送关闭会传递关闭参数并禁止后续发送", () => {
    const { handle, socket } = createMemoryRelay(new MemoryRelaySocket(), 60_000);
    try {
      handle.close(1000, "finished");

      expect(socket.closeCalls).toEqual([{ code: 1000, reason: "finished" }]);
      expect(socket.sent).toEqual([]);
      expect(handle.state).toBe("closed");
      expect(() => handle.send({ type: "request", payload: { id: "after-close" } })).toThrow("Relay is closed");
      handle.close(1001, "ignored");
      expect(socket.closeCalls).toHaveLength(1);
    } finally {
      handle.close();
    }
  });
});
