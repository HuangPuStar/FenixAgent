import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  decodeYjsSyncFrame,
  MAX_YJS_FRAGMENT_PAYLOAD_BYTES,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
} from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { createYjsWsClient } from "../transport/ws";
import { type LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient } from "./connection-test-helpers";
import type { WsConnection } from "./connection-types";
import { noteInitialSyncDelivery, type PendingInitialSync, synchronizeInitialDocs } from "./gateway-sync";

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
afterEach(() => {
  if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  else Reflect.deleteProperty(globalThis, "WebSocket");
});

/** 使用真实浏览器协议客户端接收服务端帧，覆盖字节传输与同步完成之间的顺序。 */
async function restoreHistory(size: number) {
  const key = "rcs-fragments";
  const generation = "generation-fragments";
  const source = new Y.Doc();
  const session = new Y.Doc();
  const restored = new Y.Doc();
  const text = "中".repeat(Math.ceil(size / 3));
  source.getText("history").insert(0, text);
  const frames: Uint8Array[] = [];
  const pending = new Map<string, PendingInitialSync>();
  const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
  let socket: BrowserSocket;
  const server: WsConnection = {
    readyState: 1,
    send: (data) => {
      if (data instanceof Uint8Array) frames.push(data);
      queueMicrotask(() => socket.onmessage?.({ data } as MessageEvent));
    },
    close: () => {},
  };
  class BrowserSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      socket = this;
    }
    send(data: ArrayBuffer | string) {
      if (typeof data === "string") {
        if (JSON.parse(data).type === "yjs:fragment-support") broadcaster.enableFragmentSupport(server);
        return;
      }
      const frame = decodeYjsSyncFrame(new Uint8Array(data));
      if (frame?.type !== "state-vector") return;
      const doc = frame.docName.startsWith("chat:") ? source : session;
      noteInitialSyncDelivery(
        pending,
        "ws-fragments",
        frame.docName,
        frame.generation,
        broadcaster.sendDiff(server, doc, frame.docName, generation, frame.stateVector),
      );
    }
    close() {
      this.readyState = 3;
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BrowserSocket });
  let applied = 0;
  let completeText: string | undefined;
  const client = createYjsWsClient({
    url: "ws://example.test/fragments",
    onYjsUpdate: (name, update) => {
      if (name !== `chat:${key}`) return;
      Y.applyUpdate(restored, update);
      applied += 1;
    },
    onSyncComplete: () => {
      completeText = restored.getText("history").toString();
    },
  });
  client.connect();
  try {
    const result = await synchronizeInitialDocs(
      pending,
      broadcaster,
      server,
      "ws-fragments",
      key,
      { ydoc: source, generation },
      { ydoc: session, generation },
    );
    await Promise.resolve();
    expect(result.ok).toBe(true);
    expect(completeText).toBe(text);
    expect(applied).toBe(1);
    expect(frames.length).toBeGreaterThan(2);
    expect(frames.every((frame) => frame.byteLength <= MAX_YJS_FRAGMENT_PAYLOAD_BYTES + 2048)).toBe(true);
  } finally {
    client.disconnect();
    source.destroy();
    session.destroy();
    restored.destroy();
  }
}

// 历史超过单片限制仍须恢复原文，且只能在完整应用后报告同步完成。
test("超过 8 MiB 的中文历史通过 2 MiB 分片恢复", () => restoreHistory(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024 * 1024));

// 线上约 13 MiB 的载荷应以 2 MiB 分片完成首次冷启动同步。
test("约 13 MiB 的历史无需本地缓存也能完成同步", () => restoreHistory(13_587_258));

// 换代快照捕获后的实时增量必须最终可见，不能在旧 Doc 上应用后随 replace 消失。
test("大 replace 发送期间的实时小更新最终追赶到新投影", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  source.getMap("data").set("history", "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024 * 1024));
  let restored = new Y.Doc();
  let first = true;
  let replaced = false;
  const receiver = new YjsFragmentReceiver(() => {});
  const socket: WsConnection = {
    readyState: 1,
    send: (data) => {
      if (typeof data === "string") return;
      const decoded = decodeYjsSyncFrame(data);
      if (!decoded || decoded.type === "state-vector" || decoded.type === "legacy-update") return;
      const frame = decoded.type === "fragment" ? receiver.accept(decoded) : decoded;
      if (frame?.type === "replace") {
        restored.destroy();
        restored = new Y.Doc();
        replaced = true;
      }
      if (frame) Y.applyUpdate(restored, frame.update);
      if (first) {
        first = false;
        queueMicrotask(() => source.getMap("data").set("late", "must survive replacement"));
      }
    },
    close: () => {},
  };
  registry.addClient("ws-replace", createClient({ ws: socket, rcsSessionId: "rcs-replace" }));
  broadcaster.registerYjsDocListener(source, "chat:rcs-replace", "generation-new");
  broadcaster.enableFragmentSupport(socket);
  try {
    broadcaster.broadcastReplacement(source, "chat:rcs-replace", "generation-new", true);
    const deadline = performance.now() + 500;
    while ((!replaced || restored.getMap("data").get("late") === undefined) && performance.now() < deadline)
      await Bun.sleep(2);
    expect(replaced).toBe(true);
    expect(restored.getMap("data").get("late")).toBe("must survive replacement");
    expect(restored.getMap("data").toJSON()).toEqual(source.getMap("data").toJSON());
  } finally {
    broadcaster.cancelConnection(socket);
    broadcaster.unregisterYjsDocListener("chat:rcs-replace");
    receiver.reset();
    source.destroy();
    restored.destroy();
  }
});

// 活跃回复持续产生增量时，初始握手仍须获得发送机会，不能无限让位给后台追赶。
test("持续实时更新期间等待在途 replace 的同步仍能完成", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const docName = "chat:rcs-priority";
  const source = new Y.Doc();
  source.getMap("data").set("history", "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024 * 1024));
  let restored = new Y.Doc();
  const receiver = new YjsFragmentReceiver(() => {});
  let streaming = true;
  let transfers = 0;
  let completed: LegacyFrameDelivery | undefined;
  const closes: number[] = [];
  const socket: WsConnection = {
    readyState: 1,
    send: (data) => {
      if (typeof data === "string") return;
      const decoded = decodeYjsSyncFrame(data);
      if (!decoded || decoded.type === "state-vector" || decoded.type === "legacy-update") return;
      const frame = decoded.type === "fragment" ? receiver.accept(decoded) : decoded;
      if (frame?.type === "replace") {
        restored.destroy();
        restored = new Y.Doc();
      }
      if (frame) Y.applyUpdate(restored, frame.update);
      if (decoded.type === "fragment" && decoded.offset === 0) {
        transfers += 1;
        if (streaming) queueMicrotask(() => source.getMap("data").set("live", transfers));
      }
    },
    close: (code) => closes.push(code ?? 1000),
  };
  registry.addClient("ws-priority", createClient({ ws: socket, rcsSessionId: "rcs-priority" }));
  broadcaster.enableFragmentSupport(socket);
  broadcaster.registerYjsDocListener(source, docName, "generation-priority");
  try {
    broadcaster.broadcastReplacement(source, docName, "generation-priority", true);
    const delivery = broadcaster.sendSnapshot(socket, source, docName, "generation-priority");
    expect(delivery.completion).toBeDefined();
    void delivery.completion?.then((result) => {
      completed = result;
    });
    const deadline = performance.now() + 1_000;
    while (!completed && performance.now() < deadline) await Bun.sleep(2);
    expect(streaming).toBe(true);
    expect(completed?.ok).toBe(true);
    expect(transfers).toBeGreaterThanOrEqual(2);
    expect(restored.getMap("data").get("live")).toBeGreaterThanOrEqual(1);
    expect(closes).toEqual([]);
  } finally {
    streaming = false;
    broadcaster.cancelConnection(socket);
    broadcaster.unregisterYjsDocListener(docName);
    receiver.reset();
    source.destroy();
    restored.destroy();
  }
});

// 完成证明到达时可有同代后台追赶，须等其应用再回调，不能误判失败并关闭连接。
test("初始双大文档同步期间的后台追赶不会关闭连接或丢失完成证明", async () => {
  const key = "rcs-background";
  const generation = "generation-background";
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const pending = new Map<string, PendingInitialSync>();
  const chat = new Y.Doc();
  const session = new Y.Doc();
  const restoredChat = new Y.Doc();
  const restoredSession = new Y.Doc();
  const chatSize = MAX_YJS_SYNC_PAYLOAD_BYTES + 1024 * 1024;
  const sessionSize = MAX_YJS_SYNC_PAYLOAD_BYTES + 3 * 1024 * 1024;
  chat.getText("history").insert(0, "x".repeat(chatSize));
  session.getText("history").insert(0, "x".repeat(sessionSize));
  let socket!: BrowserSocket;
  let chatTransfers = 0;
  let chatApplied = 0;
  let proofDuringCatchup = false;
  let completed = false;
  let completeIncludesLive = false;
  const closes: number[] = [];
  const server: WsConnection = {
    readyState: 1,
    send: (data) => {
      queueMicrotask(() => socket.onmessage?.({ data } as MessageEvent));
      if (typeof data === "string") {
        if (JSON.parse(data).type === "yjs:sync-complete") proofDuringCatchup = chatTransfers > 1 && chatApplied === 1;
        return;
      }
      const frame = decodeYjsSyncFrame(data);
      if (frame?.type === "fragment" && frame.docName === `chat:${key}` && frame.offset === 0) {
        chatTransfers += 1;
        if (chatTransfers === 1) queueMicrotask(() => chat.getMap("data").set("live", true));
      }
    },
    close: (code) => closes.push(code ?? 1000),
  };
  class BrowserSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() {
      socket = this;
    }
    send(data: ArrayBuffer | string) {
      if (typeof data === "string") {
        if (JSON.parse(data).type === "yjs:fragment-support") broadcaster.enableFragmentSupport(server);
        return;
      }
      const frame = decodeYjsSyncFrame(new Uint8Array(data));
      if (frame?.type !== "state-vector") return;
      const doc = frame.docName === `chat:${key}` ? chat : session;
      noteInitialSyncDelivery(
        pending,
        "ws-background",
        frame.docName,
        frame.generation,
        broadcaster.sendDiff(server, doc, frame.docName, generation, frame.stateVector),
      );
    }
    close(code?: number) {
      this.readyState = 3;
      closes.push(code ?? 1000);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BrowserSocket });
  registry.addClient("ws-background", createClient({ ws: server, rcsSessionId: key }));
  broadcaster.registerYjsDocListener(chat, `chat:${key}`, generation);
  broadcaster.registerYjsDocListener(session, `session:${key}`, generation);
  const client = createYjsWsClient({
    url: "ws://example.test/background",
    onYjsUpdate: (name, update) => {
      if (name === `chat:${key}`) {
        Y.applyUpdate(restoredChat, update);
        chatApplied += 1;
      } else Y.applyUpdate(restoredSession, update);
    },
    onSyncComplete: () => {
      completed = true;
      completeIncludesLive = restoredChat.getMap("data").get("live") === true;
    },
  });
  client.connect();
  try {
    const result = await synchronizeInitialDocs(
      pending,
      broadcaster,
      server,
      "ws-background",
      key,
      { ydoc: chat, generation },
      { ydoc: session, generation },
    );
    const deadline = performance.now() + 1_000;
    while (!completed && closes.length === 0 && performance.now() < deadline) await Bun.sleep(2);
    expect(result.ok).toBe(true);
    expect(proofDuringCatchup).toBe(true);
    expect(completed).toBe(true);
    expect(completeIncludesLive).toBe(true);
    expect(restoredChat.getText("history").length).toBe(chatSize);
    expect(restoredSession.getText("history").length).toBe(sessionSize);
    expect(closes).toEqual([]);
  } finally {
    client.disconnect();
    broadcaster.cancelConnection(server);
    broadcaster.unregisterYjsDocListener(`chat:${key}`);
    broadcaster.unregisterYjsDocListener(`session:${key}`);
    for (const doc of [chat, session, restoredChat, restoredSession]) doc.destroy();
  }
});
