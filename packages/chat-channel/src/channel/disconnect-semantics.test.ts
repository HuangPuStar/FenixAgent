// packages/chat-channel/src/channel/disconnect-semantics.test.ts
// C6 新增：两类断链语义测试（PRD 8.2 / issue C6 验收）。
//
// 断链语义一（前端 WebSocket / relay 断开）：仅释放连接级资源；Agent 会话存活时
// 重连后同步当前实时 Y.Doc（openChat 返回内存 Doc，snapshot 含既有时间线；
// acpSessionId 从 Session Doc session.sessionId 恢复，同一 ACP session 跳过全量回放）。
// 断链语义二（Instance ACP session 断链 / 实例回收）：relay_closed 删除该 rcsSessionId 的
// Chat Doc、Session Doc、relay handle、广播订阅与热缓存；新连接创建全新投影，绝不加载旧 Y.Doc。

import { describe, expect, test } from "bun:test";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createGateway, createWs, decodeSnapshot, decodeUpdateFrames, textFrames } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import type { GatewayDependencies } from "./gateway";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionChannel } from "./session-channel";

/**
 * 真实 DocManager + 真实 SessionChannel 的 Gateway 装配（协议层测试 seam）。
 * ensureRunning 可注入（默认恒返回 instance-1），用于模拟实例切换 / 后继 spawn。
 */
function createRealStack(options: { ensureRunning?: GatewayDependencies["ensureRunning"] } = {}) {
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
    ...(options.ensureRunning ? { ensureRunning: options.ensureRunning } : {}),
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
    // 存活标签仍收到同 rcsSessionId 的广播（隔离不丢失；SP-A4 后为二进制帧）
    docManager.getChatYdoc("rcs-1")?.getMap("root").set("projectionVersion", 5);
    await Promise.resolve();
    expect(decodeUpdateFrames(ws2).some((frame) => frame.docName === "chat:rcs-1")).toBe(true);

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

    // 全部客户端被关闭并收到断链错误帧（消息流中还有连接时的 yjs:update 二进制快照帧，按文本帧定位）
    for (const ws of [ws1, ws2]) {
      const errorFrame = textFrames(ws)
        .map((message) => JSON.parse(message))
        .find((m) => m.type === "error");
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

// SP-C2：实例确认停止后的实例级回收。relay 引用计数归零（前端断开）不产生
// relay_closed，实例名下全部内存 Doc 只能由宿主在停止完成点
// （stopInstanceViaController → reclaimInstanceRealtimeResources）统一关闭；
// 仅断开前端（实例可能存活）时 Doc 必须保留（断链语义一）。
describe("实例停止回收（SP-C2）：确认停止后关闭实例名下全部内存 Doc", () => {
  // 前端断开 → Doc 保留；实例停止回收 → 该实例（gateway 创建 relay 时自动登记）
  // 名下两个会话的 Doc 全部关闭、openedDocCount 归零；回收后新连接创建全新投影。
  test("instance stop reclaims all session docs after frontend disconnects", async () => {
    const { docManager, gateway, relayEvents } = createRealStack();
    const ws1 = createWs();
    const ws2 = createWs();
    // 同一实例（ensureRunning fake 恒返回 instance-1）的两个 RCS 会话
    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-2");

    // 仅前端断开（实例可能存活）：Doc 必须保留（C6 断链语义一，重连同步实时 Doc）
    gateway.handleClose("ws-1");
    gateway.handleClose("ws-2");
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getChatYdoc("rcs-2")).toBeDefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 2, session: 2 });

    // 实例确认停止（idle reclaim / 死实例清理共用 stopInstanceViaController 完成点）
    await relayEvents.reclaimInstanceRealtimeResources("instance-1");
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getChatYdoc("rcs-2")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-2")).toBeUndefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 0, session: 0 });

    // 回收后新连接（新实例 spawn）：全新投影，且重新登记归属（下次停止可再次回收）
    const ws3 = createWs();
    await gateway.handleOpen(ws3, "ws-3", "user-1", "agent-1", "rcs-1");
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 1, session: 1 });
    await relayEvents.reclaimInstanceRealtimeResources("instance-1");
    expect(docManager.openedDocCount()).toEqual({ chat: 0, session: 0 });
    gateway.handleClose("ws-3");
  });

  // 后继实例接管竞态（回归，SP-C2）：stopInstanceViaController 进行中（旧实例已
  // 移出编排域活跃表、facade.stopInstance 尚在途）客户端 1011 自动重连，ensureRunning
  // 因旧实例不可见而 spawn 新实例并重绑同一 rcsSessionId、重开同名 Doc；随后旧实例
  // 停止完成触发回收——新实例的实时 Doc 必须存活且事件继续投影（否则连接保持打开
  // 但 processNormalizedEvent 静默丢事件，前端冻结且无错误帧）。
  test("old instance reclaim during takeover does not destroy the successor instance live doc", async () => {
    let currentInstanceId = "instance-old";
    const { docManager, gateway, relayEvents } = createRealStack({
      ensureRunning: async () => ({ instance: { id: currentInstanceId } }),
    });
    const ws1 = createWs();
    await gateway.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    // 旧实例投影的实时内容
    docManager.processNormalizedEvent("rcs-1", {
      type: "session_updated",
      update: { sessionId: "ses-old", status: "ready" },
      content: null,
    });
    gateway.handleClose("ws-1");
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();

    // 停止窗口内客户端重连：ensureRunning spawn 新实例（instanceId 必然不同），
    // 新 relay 创建时重绑同一 rcsSessionId 并复用内存实时 Doc
    currentInstanceId = "instance-new";
    const ws2 = createWs();
    await gateway.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");

    // 旧实例停止完成（stopInstanceViaController 末尾的 reclaimYjsDocs(old)）
    await relayEvents.reclaimInstanceRealtimeResources("instance-old");

    // 新实例的实时 Doc 存活，事件继续投影（实时流未被静默丢弃）
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();
    docManager.processNormalizedEvent("rcs-1", {
      type: "session_updated",
      update: { sessionId: "ses-new", status: "ready" },
      content: null,
    });
    const session = docManager.getSessionYdoc("rcs-1")?.getMap("root").get("session") as
      | { get: (key: string) => unknown }
      | undefined;
    expect(session?.get("sessionId")).toBe("ses-new");
    gateway.handleClose("ws-2");
  });
});
