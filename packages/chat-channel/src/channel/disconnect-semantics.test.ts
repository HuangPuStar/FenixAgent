// packages/chat-channel/src/channel/disconnect-semantics.test.ts
// C6 新增：两类断链语义测试（PRD 8.2 / issue C6 验收）。
//
// 断链语义一（前端 WebSocket / relay 断开）：仅释放连接级资源；Agent 会话存活时
// 重连后同步当前实时 Y.Doc（openChat 返回内存 Doc，snapshot 含既有时间线；
// acpSessionId 从 Session Doc session.sessionId 恢复，同一 ACP session 跳过全量回放）。
// 断链语义二（Instance ACP session 断链 / 实例回收）：relay_closed 删除该 rcsSessionId 的
// Chat Doc、Session Doc、relay handle、广播订阅与热缓存；新连接创建全新投影，绝不加载旧 Y.Doc。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createGateway, createWs, type MockWs } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionChannel } from "./session-channel";

/** 真实 DocManager + 真实 SessionChannel 的 Gateway 装配（协议层测试 seam） */
function createRealStack() {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const docManager = new DocManager();
  const sessionChannel = new SessionChannel({
    docManager,
    prepareClearSessionSnapshot: async () => {},
    syncSessionId: () => {},
    reportError: () => {},
  });
  let listener: ((message: RelayMessage) => Promise<void>) | undefined;
  let connectCalls = 0;
  const relayEvents = new RelayEventHandler({
    registry,
    broadcaster,
    docManager,
    registerYjsDocListener: broadcaster.registerYjsDocListener.bind(broadcaster),
    reportError: () => {},
    touchInstanceActivity: () => {},
    terminateLocalDeadInstance: () => {},
  });
  const gateway = createGateway(registry, broadcaster, relayEvents, {
    docManager,
    sessionChannel,
    connectAgentRelay: async () => {
      connectCalls += 1;
      return {
        state: "open",
        send() {},
        close() {},
        onMessage(callback: (message: RelayMessage) => Promise<void>) {
          listener = callback;
          return () => {};
        },
      } as never;
    },
  });
  return {
    registry,
    broadcaster,
    docManager,
    gateway,
    relayEvents,
    getListener: () => listener,
    getConnectCalls: () => connectCalls,
  };
}

/** 从连接的 WS 消息中取出指定 docName 的 snapshot 并解码 */
function decodeSnapshot(ws: MockWs, docName: string): Y.Doc {
  const frame = ws.messages
    .map((message) => JSON.parse(message) as { docName?: string; data?: string })
    .find((message) => message.docName === docName);
  expect(frame?.data).toBeDefined();
  const restored = new Y.Doc();
  Y.applyUpdate(restored, Buffer.from(frame?.data ?? "", "base64"));
  return restored;
}

describe("断链语义一：前端断开仅释放连接级资源，重连同步当前实时 Y.Doc", () => {
  // 最后一个前端客户端断开只释放连接级资源（relay handle、广播订阅、频道状态），
  // Chat / Session Doc 热缓存必须保留；重连后 snapshot 包含断开前的全部内容。
  test("frontend disconnect keeps the Y.Docs alive and a reconnect syncs the live projection", async () => {
    const { registry, docManager, gateway } = createRealStack();
    const ws1 = createWs();

    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    // 预写时间线内容（旧投影产物）
    const chatDoc = docManager.getChatYdoc("rcs-1");
    expect(chatDoc).toBeDefined();
    chatDoc?.getMap("root").set("projectionVersion", 3);

    // 前端断开：仅释放连接级资源
    gateway.handleClose("ws-1");
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBeUndefined();
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();

    // 重连：openChat 返回同一内存 Doc，snapshot 包含断开前的内容
    const ws2 = createWs();
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");
    expect(decodeSnapshot(ws2, "chat:rcs-1").getMap("root").get("projectionVersion")).toBe(3);
    gateway.handleClose("ws-2");
  });

  // 重连时从 Session Doc session.sessionId 恢复 entry.acpSessionId（binding 反查），
  // 使同一 ACP session 的 load_session 跳过 Agent 全量回放。
  test("reconnect restores the ACP session id from the Session Doc binding", async () => {
    const { docManager, gateway, registry } = createRealStack();
    const ws1 = createWs();

    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    // 模拟 ACP 会话已建立：session_updated 投影写入 Session Doc session.sessionId
    docManager.processNormalizedEvent("rcs-1", {
      type: "session_updated",
      update: { sessionId: "ses-active", status: "ready" },
      content: null,
    });
    gateway.handleClose("ws-1");

    const ws2 = createWs();
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");

    expect(registry.getClient("ws-2")?.acpSessionId).toBe("ses-active");
    gateway.handleClose("ws-2");
  });

  // 多标签页：一个标签断开不影响其他标签——relay 与 Doc 保持存活，另一标签仍收到广播。
  test("closing one tab keeps relay and docs alive for the remaining tab", async () => {
    const { registry, docManager, gateway } = createRealStack();
    const ws1 = createWs();
    const ws2 = createWs();

    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(2);

    gateway.handleClose("ws-1");

    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(1);
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    // 存活标签仍收到同 rcsSessionId 的广播（隔离不丢失）
    docManager.getChatYdoc("rcs-1")?.getMap("root").set("projectionVersion", 5);
    await Promise.resolve();
    expect(ws2.messages.some((message) => JSON.parse(message).docName === "chat:rcs-1")).toBe(true);

    gateway.handleClose("ws-2");
  });
});

describe("断链语义二：relay_closed 删除全部实时资源，新实例绝不加载旧 Y.Doc", () => {
  // relay_closed 全链路（gateway + relay-event-handler + docManager）：
  // 同一 rcsSessionId 的所有客户端收到 agent_connection_lost 并关闭 1011，
  // relay handle 与热缓存销毁；随后新连接创建全新 Doc（旧 projectionVersion 不残留）。
  test("instance relay loss tears down all realtime resources and a new connection starts fresh", async () => {
    const { registry, docManager, gateway, getListener, getConnectCalls } = createRealStack();
    const ws1 = createWs();
    const ws2 = createWs();

    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");
    docManager.getChatYdoc("rcs-1")?.getMap("root").set("projectionVersion", 9);

    // 实例 ACP session 断链（relay 异常关闭）
    const listener = getListener();
    expect(listener).toBeDefined();
    await listener?.({ type: "relay_closed" } as RelayMessage);

    // 全部客户端被关闭并收到断链错误帧（消息流中还有连接时的 yjs:update 快照帧，按 type 定位）
    for (const ws of [ws1, ws2]) {
      const errorFrame = ws.messages.map((message) => JSON.parse(message)).find((m) => m.type === "error");
      expect(errorFrame).toMatchObject({
        type: "error",
        payload: { code: "agent_connection_lost" },
      });
      expect(ws.closed).toEqual([[1011, "relay handle closed"]]);
    }
    // 浏览器断开后由 route 层触发 handleClose：relay 引用计数归零 → 连接级资源全部释放
    gateway.handleClose("ws-1");
    gateway.handleClose("ws-2");
    // relay handle 与热缓存全部删除
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBeUndefined();
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();

    // 新实例新连接：全新实时投影，绝不加载旧 Y.Doc
    // （projectionVersion 为 createChatDoc 初始值 1，旧实例写入的 9 不残留）
    const ws3 = createWs();
    await gateway.handleOpen(ws3, "ws-3", "user-1", "agent-1", "rcs-1");
    expect(getConnectCalls()).toBe(2);
    expect(decodeSnapshot(ws3, "chat:rcs-1").getMap("root").get("projectionVersion")).toBe(1);
    gateway.handleClose("ws-3");
  });
});
