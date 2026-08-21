import { describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createRelayHandle, type RelaySocket } from "../relay/relay-handle";

class InMemoryRelaySocket implements RelaySocket {
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

  fail(): void {
    this.readyState = 3;
    this.onerror?.();
  }
}

function createMemoryRelay(socket = new InMemoryRelaySocket()) {
  const handle = createRelayHandle(
    { instanceId: "round71", port: 9733, token: "memory-token" },
    { createWebSocket: () => socket, keepAliveIntervalMs: 60_000 },
  );
  return { handle, socket };
}

describe("relay-handle round71 内存生命周期", () => {
  // 取消全部订阅后到达的 Buffer 帧应再次缓冲，并且只回放给重新订阅的首个监听器。
  test("取消最后一个订阅后重新缓冲 Buffer 帧", () => {
    const { handle, socket } = createMemoryRelay();
    try {
      const first: EngineRelayMessage[] = [];
      const unsubscribe = handle.onMessage((message) => first.push(message));
      unsubscribe();
      socket.receive(Buffer.from('{"type":"event","payload":{"source":"buffer"}}'));

      const replayed: EngineRelayMessage[] = [];
      handle.onMessage((message) => replayed.push(message));
      const later: EngineRelayMessage[] = [];
      handle.onMessage((message) => later.push(message));

      expect(first).toEqual([]);
      expect(replayed).toEqual([{ type: "event", payload: { source: "buffer" } }]);
      expect(later).toEqual([]);
    } finally {
      handle.close();
    }
  });

  // 已 ready 的 socket 出错时应发送错误关闭通知，但不能反向改变已完成的 ready。
  test("已打开连接报错后通知关闭并保留 ready", async () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    await expect(handle.ready).resolves.toBeUndefined();

    socket.fail();

    await expect(handle.ready).resolves.toBeUndefined();
    expect(handle.state).toBe("closed");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
    expect(() => handle.send({ type: "request" })).toThrow("Relay is closed");
  });

  // ping 是本地心跳响应，入站 pong 也是控制帧，二者均不能写入或投递业务流。
  test("ping 和 pong 不写入 socket 或业务订阅", () => {
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

  // 显式关闭必须转交关闭参数、清理 keepalive，且关闭状态下发送不会触碰 socket。
  test("关闭连接后转交参数并拒绝发送", () => {
    const { handle, socket } = createMemoryRelay();
    try {
      handle.close(1000, "finished");

      expect(socket.closeCalls).toEqual([{ code: 1000, reason: "finished" }]);
      expect(handle.state).toBe("closed");
      expect(() => handle.send({ type: "request", payload: { id: "after-close" } })).toThrow("Relay is closed");
      expect(socket.sent).toEqual([]);

      handle.close(1001, "ignored");
      expect(socket.closeCalls).toHaveLength(1);
    } finally {
      handle.close();
    }
  });
});
