import { describe, expect, test } from "bun:test";
import type { RelaySocket } from "../relay/relay-handle";
import { createRelayHandle } from "../relay/relay-handle";

interface FakeRelaySocket extends RelaySocket {
  sent: string[];
}

function createFakeSocket(): FakeRelaySocket {
  return {
    readyState: 1,
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "closed" });
    },
  };
}

describe("relay-handle", () => {
  // relay 过滤噪音消息
  test("filters keep_alive, pong and keep_alive errors while forwarding business messages", () => {
    const socket = createFakeSocket();
    const handle = createRelayHandle(
      {
        instanceId: "inst_relay",
        port: 8888,
        token: "f".repeat(64),
      },
      {
        createWebSocket: () => socket as any,
        keepAliveIntervalMs: 60_000,
      },
    );

    const received: string[] = [];
    handle.onMessage((message) => {
      received.push(message.type);
    });

    socket.onmessage?.({ data: JSON.stringify({ type: "keep_alive" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "error", payload: { message: "keep_alive timeout" } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "assistant", payload: { text: "hello" } }) });

    expect(received).toEqual(["assistant"]);
  });

  // relay 会等待 websocket 真正 ready
  test("exposes a ready promise that resolves on websocket open", async () => {
    const socket = createFakeSocket();
    socket.readyState = 0;

    const handle = createRelayHandle(
      {
        instanceId: "inst_ready",
        port: 8889,
        token: "e".repeat(64),
      },
      {
        createWebSocket: () => socket as any,
      },
    );

    let resolved = false;
    handle.ready.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    socket.readyState = 1;
    socket.onopen?.();
    await handle.ready;
    expect(resolved).toBe(true);
  });
});
