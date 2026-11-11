import { afterEach, expect, test } from "bun:test";
import { YjsFragmentSender } from "../channel/fragment-delivery";
import { encodeYjsFragmentFrame, MAX_YJS_SYNC_PAYLOAD_BYTES, YJS_FRAGMENT_DATA_BYTES } from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { createYjsWsClient, type YjsWsClient } from "../transport/ws";

class Socket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static current: Socket;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closes: number[] = [];
  sent: string[] = [];
  constructor() {
    Socket.current = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closes.push(code);
    this.readyState = 3;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const names = ["WebSocket", "setTimeout", "clearTimeout"] as const;
const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let client: YjsWsClient | undefined;
afterEach(() => {
  client?.disconnect();
  client = undefined;
  for (const name of names) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  }
});

function connect() {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  const completed: unknown[] = [];
  client = createYjsWsClient({
    url: "ws://test/fragment",
    onYjsUpdate: () => {},
    onSyncComplete: (info) => completed.push(info),
  });
  client.connect();
  return { socket: Socket.current, completed };
}

function firstFragment() {
  return encodeYjsFragmentFrame({
    docName: "chat:rcs-one",
    generation: "gen-one",
    kind: "update",
    transferId: crypto.randomUUID(),
    offset: 0,
    totalBytes: 2 * MAX_YJS_SYNC_PAYLOAD_BYTES,
    chunk: new Uint8Array(YJS_FRAGMENT_DATA_BYTES),
  });
}

// 不完整或非法分片不能被后续完成控制帧掩盖，关闭前排队的帧也不能误报成功。
test("缺片及损坏的分片不能解除历史恢复门禁", () => {
  for (const corrupt of [false, true]) {
    const { socket, completed } = connect();
    const frame = firstFragment();
    socket.receive(corrupt ? frame.subarray(0, frame.length - 1) : frame);
    socket.receive(JSON.stringify({ type: "yjs:sync-complete", docs: ["chat:rcs-one"], generation: "gen-one" }));
    expect(completed).toHaveLength(0);
    expect(socket.closes).toEqual(corrupt ? [1013] : []);
    client?.disconnect();
  }
});

// 能力声明必须先于差量请求到达服务端，避免旧客户端兼容门禁误判。
test("同步握手先声明分片支持再发送 state vector", () => {
  const { socket } = connect();
  socket.receive(
    JSON.stringify({ type: "yjs:sync-request", docs: [{ docName: "chat:rcs-one", generation: "gen-one" }] }),
  );
  expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "yjs:fragment-support", version: 1 });
  expect(socket.sent).toHaveLength(2);
});

// 收发两端使用固定总时限，超时后归还预算且不再保留载荷。
test("分片超时释放发送与接收状态", async () => {
  const deadlines: Array<() => void> = [];
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay: number) => {
      if (delay === 30_000) deadlines.push(callback);
      return { callback };
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: () => {} });
  let timedOut = false;
  const receiver = new YjsFragmentReceiver(() => {
    timedOut = true;
  });
  const sender = new YjsFragmentSender(() => {});
  const socket = { readyState: 1, send: () => {}, close: () => {} };
  const result = sender.send(
    socket,
    "chat:rcs-one",
    "gen-one",
    "update",
    new Uint8Array(2 * MAX_YJS_SYNC_PAYLOAD_BYTES),
  );
  let retried = false;
  const waiting = sender.afterPending(
    socket,
    "chat:rcs-one",
    () => {
      retried = true;
      return "unexpected";
    },
    () => "expired",
  );
  receiver.accept({
    type: "fragment",
    docName: "chat:rcs-one",
    generation: "gen-one",
    kind: "update",
    transferId: crypto.randomUUID(),
    offset: 0,
    totalBytes: 2 * MAX_YJS_SYNC_PAYLOAD_BYTES,
    chunk: new Uint8Array(YJS_FRAGMENT_DATA_BYTES),
  });
  for (const expire of deadlines) expire();
  expect(await result).toBe("backpressure");
  expect(await waiting).toBe("expired");
  expect(retried).toBe(false);
  expect(sender.hasWaiter(socket, "chat:rcs-one")).toBe(false);
  expect(sender.hasPending(socket, "chat:rcs-one")).toBe(false);
  expect(receiver.hasPending("chat:rcs-one")).toBe(false);
  expect(timedOut).toBe(true);
});
