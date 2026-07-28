import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { ConnectionRegistry } from "../transport/relay/yjs-frontend/connection-registry";
import type { ClientConnection } from "../transport/relay/yjs-frontend/types";
import { YjsBroadcaster } from "../transport/relay/yjs-frontend/yjs-broadcaster";
import type { WsConnection } from "../transport/ws-types";

type MockWs = WsConnection & {
  bufferedAmount?: number;
  messages: string[];
};

function createWs(bufferedAmount = 0): MockWs {
  return {
    bufferedAmount,
    messages: [],
    readyState: 1,
    send(data) {
      this.messages.push(data);
    },
    close() {},
  };
}

function addClient(registry: ConnectionRegistry, wsId: string, ws: MockWs, rcsSessionId: string): void {
  registry.addClient(wsId, {
    ws,
    rcsSessionId,
  } as unknown as ClientConnection);
}

function parseMessage(ws: MockWs, index = 0): { type: string; docName: string; data: string } {
  return JSON.parse(ws.messages[index]) as { type: string; docName: string; data: string };
}

describe("YjsBroadcaster", () => {
  // Chat Doc 增量只能发送给同一 RCS session 的连接，不能串到其他会话。
  test("isolates updates by RCS session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const targetWs = createWs();
    const otherWs = createWs();
    addClient(registry, "target", targetWs, "rcs-target");
    addClient(registry, "other", otherWs, "rcs-other");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-target");

    doc.getMap("chat").set("message", "only target");
    await Promise.resolve();

    expect(targetWs.messages).toHaveLength(1);
    expect(otherWs.messages).toHaveLength(0);
  });

  // 缓冲区超过 64KB 的慢连接必须跳过发送，等待其重连后获取 snapshot。
  test("skips sends when bufferedAmount exceeds 64KB", () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs(64 * 1024 + 1);

    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });

    expect(ws.messages).toHaveLength(0);
  });

  // 初始 snapshot 必须使用与增量一致的 yjs:update envelope。
  test("sends snapshots in the yjs update envelope", () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const doc = new Y.Doc();
    doc.getMap("chat").set("title", "snapshot");

    broadcaster.sendSnapshot(ws, doc, "chat:rcs-1");

    const message = parseMessage(ws);
    expect(message.type).toBe("yjs:update");
    expect(message.docName).toBe("chat:rcs-1");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(message.data, "base64"));
    expect(restored.getMap("chat").get("title")).toBe("snapshot");
  });

  // 同一 tick 内同一 Doc 的两次更新必须合并为一帧，且解码后状态等价。
  test("merges same-tick updates for one document", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("first", "one");
    doc.getMap("chat").set("second", "two");
    await Promise.resolve();

    expect(ws.messages).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(parseMessage(ws).data, "base64"));
    expect(restored.getMap("chat").toJSON()).toEqual(doc.getMap("chat").toJSON());
  });

  // unregister 后旧 Doc 的更新不能继续广播 yjs:update。
  test("stops broadcasting updates from an unregistered document", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    broadcaster.unregisterYjsDocListener("chat:rcs-1");
    doc.getMap("chat").set("message", "stale update");
    await Promise.resolve();

    expect(ws.messages).toHaveLength(0);
  });

  // 同一 RCS session 下 chat 与 session 属于不同 Doc，不能被合并为同一帧。
  test("keeps chat and session updates as separate frames", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const chatDoc = new Y.Doc();
    const sessionDoc = new Y.Doc();
    broadcaster.registerYjsDocListener(chatDoc, "chat:rcs-1");
    broadcaster.registerYjsDocListener(sessionDoc, "session:rcs-1");

    chatDoc.getMap("chat").set("title", "chat");
    sessionDoc.getMap("session").set("message", "session");
    await Promise.resolve();

    expect(ws.messages).toHaveLength(2);
    expect(ws.messages.map((message) => parseMessage({ ...ws, messages: [message] }).docName).sort()).toEqual([
      "chat:rcs-1",
      "session:rcs-1",
    ]);
  });
});
