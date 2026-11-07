import { afterEach, expect, test } from "bun:test";
import { createYjsWsClient } from "../transport/ws";

class Socket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static current: Socket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Socket.current = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  receive(epoch: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: "yjs:command-epoch", epoch }) } as MessageEvent);
  }
}

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
  else Reflect.deleteProperty(globalThis, "WebSocket");
});

// socket open 不授权新命令；只有当前连接的有效服务端代次可驱动首次分配和轮换。
test("command epoch is unavailable before handshake and retires with its socket", () => {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  const received: string[] = [];
  const states: string[] = [];
  const client = createYjsWsClient({
    url: "ws://test",
    onYjsUpdate() {},
    onCommandEpoch: (epoch) => received.push(epoch),
    onConnectionState: (state) => states.push(state),
  });
  try {
    expect(client.getCommandEpoch()).toBeNull();
    client.connect();
    const socket = Socket.current;
    socket.readyState = 1;
    socket.onopen?.();
    expect(client.getCommandEpoch()).toBeNull();
    expect(client.isConnected()).toBe(false);
    expect(states).toEqual(["connecting"]);
    expect(client.send({ action: "load_session" })).toBe(false);
    for (const invalid of [null, 1, "x", "-".repeat(36)]) socket.receive(invalid);
    expect(received).toEqual([]);
    expect(states).toEqual(["connecting"]);
    const first = "11111111-1111-4111-8111-111111111111";
    const next = "22222222-2222-4222-8222-222222222222";
    socket.receive(first);
    socket.receive(first);
    expect(client.getCommandEpoch()).toBe(first);
    expect(client.isConnected()).toBe(true);
    expect(states).toEqual(["connecting", "connected"]);
    socket.receive(next);
    expect(client.getCommandEpoch()).toBe(next);
    expect(received).toEqual([first, next]);
    expect(states).toEqual(["connecting", "connected"]);
    const stale = socket.onmessage;
    client.disconnect();
    stale?.({ data: JSON.stringify({ type: "yjs:command-epoch", epoch: first }) } as MessageEvent);
    expect(client.getCommandEpoch()).toBeNull();
    expect(received).toHaveLength(2);
  } finally {
    client.disconnect();
  }
});
