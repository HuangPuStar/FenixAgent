// packages/chat-channel/src/channel/gateway-shared-relay.test.ts
// Gateway 共享 relay / 握手时序测试（C6 迁移自 src/__tests__/yjs-frontend-lifecycle.test.ts）：
// connect 握手、同步 status 回包、并发打开共享一次 relay 获取、连接配额拒绝、
// relayReady 前缓冲、多标签页/多用户引用计数、监听器注销与竞态守卫。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createDeterministicRcsSessionId } from "../util/id";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createGateway, createRelayEvents, createWs, deferred, textFrames } from "./connection-test-helpers";
import type { ClientConnection, RelayMessage } from "./connection-types";

describe("Gateway shared relay", () => {
  // 新建共享 relay 时必须先执行 ACP connect 握手，远端 dispatcher 才会回传 status 并允许后续 session/list。
  test("sends connect once before exposing a newly created shared relay", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const sent: unknown[] = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send(message: unknown) {
            sent.push(message);
          },
          close() {},
        }) as never,
    });

    await lifecycle.handleOpen(createWs(), "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });

    expect(sent).toEqual([{ type: "connect" }]);
    lifecycle.handleClose("ws-1");
  });

  // connect 的同步就绪 status 回包（带 capabilities）必须在 client 登记后处理，
  // 否则 forEachByRcsSession 找不到客户端、agentStatusReceived 不被标记，
  // list_sessions 会永久被状态门禁拦截。
  test("registers the client before a synchronous connect status reply", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let listener: ((message: RelayMessage) => Promise<void>) | undefined;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          onMessage(callback: (message: RelayMessage) => Promise<void>) {
            listener = callback;
            return () => {};
          },
          send(message: { type?: string }) {
            if (message.type === "connect") {
              void listener?.({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } });
            }
          },
          close() {},
        }) as never,
    });

    await lifecycle.handleOpen(createWs(), "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });

    expect(registry.hasStatusReceived("agent-1", "instance-1")).toBe(true);
    lifecycle.handleClose("ws-1");
  });

  // 服务端会话标识必须完整编码所有输入，忽略客户端 query 值，且按用户进行确定性隔离。
  test("creates deterministic collision-resistant RCS session ids independent of client query values", () => {
    const agentId = "agent-shared-prefix";
    const firstUserId = "user-12345678-alpha";
    const secondUserId = "user-12345678-bravo";

    expect(createDeterministicRcsSessionId(agentId, firstUserId)).toBe(
      "rcs_YWdlbnQtc2hhcmVkLXByZWZpeA.dXNlci0xMjM0NTY3OC1hbHBoYQ",
    );
    expect(createDeterministicRcsSessionId(agentId, firstUserId)).toBe(
      createDeterministicRcsSessionId(agentId, firstUserId),
    );
    expect(createDeterministicRcsSessionId(agentId, firstUserId)).not.toBe(
      createDeterministicRcsSessionId(agentId, secondUserId),
    );
  });

  // 并发打开同一实例只能建立一个 relay 和一个监听器，引用应由两个客户端共同持有；
  // 全部关闭后监听器注销、relay 关闭、空闲监控成对注销。
  test("shares one in-flight relay acquisition between simultaneous opens", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const connection = deferred<ClientConnection["relayHandle"]>();
    const connectionStarted = deferred<void>();
    let connectCalls = 0;
    let onMessageCalls = 0;
    let unsubscribeCalls = 0;
    let closeCalls = 0;
    let attachCalls = 0;
    let detachCalls = 0;
    const handle = {
      state: "open" as const,
      send() {},
      close() {
        closeCalls += 1;
      },
      onMessage() {
        onMessageCalls += 1;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    };
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () => {
        connectCalls += 1;
        connectionStarted.resolve();
        return connection.promise;
      },
      markRelayAttached: () => {
        attachCalls += 1;
      },
      markRelayDetached: () => {
        detachCalls += 1;
      },
    });
    const ws1 = createWs();
    const ws2 = createWs();
    const open1 = lifecycle.handleOpen(ws1, "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    await connectionStarted.promise;
    const open2 = lifecycle.handleOpen(ws2, "ws-2", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    connection.resolve(handle as never);
    await Promise.all([open1, open2]);

    expect(connectCalls).toBe(1);
    expect(onMessageCalls).toBe(1);
    expect(attachCalls).toBe(1);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(2);
    lifecycle.handleClose("ws-1");
    expect(unsubscribeCalls).toBe(0);
    expect(closeCalls).toBe(0);
    lifecycle.handleClose("ws-2");
    expect(unsubscribeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(detachCalls).toBe(1);
  });

  // 满容量时必须在任何 instance/relay 获取之前拒绝新连接，不能产生额外引用或 handle。
  test("rejects at capacity before acquiring another relay reference", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let ensureCalls = 0;
    let connectCalls = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        ensureCalls += 1;
        return { instance: { id: "instance-1" } };
      },
      connectAgentRelay: async () => {
        connectCalls += 1;
        return { state: "open", send() {}, close() {} } as never;
      },
      maxClients: () => 1,
    });
    const ws1 = createWs();
    const ws2 = createWs();

    await lifecycle.handleOpen(ws1, "ws-1", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });
    await lifecycle.handleOpen(ws2, "ws-2", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });

    expect(ensureCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(1);
    expect(JSON.parse(textFrames(ws2)[0] ?? "{}")).toMatchObject({
      type: "error",
      payload: {
        type: "SYNC_RELAY.CAPACITY_EXCEEDED",
        id: expect.stringMatching(/^err_[0-9a-f]{32}$/),
        message: "The synchronization service cannot accept more connections.",
      },
    });
    lifecycle.handleClose("ws-1");
  });

  // snapshot 发送期间的 action 必须缓冲，relayReady 后才按既有 forward 路径发送。
  test("buffers actions received while initial snapshots are pending", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const snapshotStarted = deferred<void>();
    const snapshot = deferred<{ ydoc: Y.Doc }>();
    const sent: unknown[] = [];
    let openChatCalls = 0;
    const lifecycle = createGateway(
      registry,
      broadcaster,
      relayEvents,
      {
        connectAgentRelay: async () =>
          ({
            state: "open",
            send(message: unknown) {
              sent.push(message);
            },
            close() {},
          }) as never,
      },
      {
        openChat: async () => {
          openChatCalls += 1;
          if (openChatCalls === 2) {
            snapshotStarted.resolve();
            return snapshot.promise;
          }
          return { ydoc: new Y.Doc() };
        },
      },
    );
    const ws = createWs();
    const opening = lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    await snapshotStarted.promise;

    await lifecycle.handleMessage(ws, "ws-1", JSON.stringify({ action: "cancel" }));
    expect(sent).toEqual([]);
    snapshot.resolve({ ydoc: new Y.Doc() });
    await opening;

    expect(sent).toContainEqual(expect.objectContaining({ method: "session/cancel" }));
    lifecycle.handleClose("ws-1");
  });

  // 同一 instance 下不同 user 各自获得不同的 SharedRelay（不同的 rcsSessionId）。
  test("assigns distinct SharedRelays with different rcsSessionIds to different users on the same instance", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let connectCalls = 0;
    const openedRcsSessionIds: string[] = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async (_instanceId, rcsSessionId) => {
        connectCalls += 1;
        openedRcsSessionIds.push(rcsSessionId);
        return { state: "open", send() {}, close() {} } as never;
      },
    });
    const ws1 = createWs();
    const ws2 = createWs();

    await lifecycle.handleOpen(ws1, "ws-1", "user-a", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-user-a",
    });
    await lifecycle.handleOpen(ws2, "ws-2", "user-b", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-user-b",
    });

    expect(connectCalls).toBe(2);
    expect(openedRcsSessionIds).toHaveLength(2);
    expect(openedRcsSessionIds[0]).not.toBe(openedRcsSessionIds[1]);

    const relayA = registry.getShared("instance-1", "user-a", openedRcsSessionIds[0]!);
    const relayB = registry.getShared("instance-1", "user-b", openedRcsSessionIds[1]!);
    expect(relayA).toBeDefined();
    expect(relayB).toBeDefined();
    expect(relayA).not.toBe(relayB);
    expect(relayA!.rcsSessionId).toBe(openedRcsSessionIds[0]);
    expect(relayB!.rcsSessionId).toBe(openedRcsSessionIds[1]);

    lifecycle.handleClose("ws-1");
    lifecycle.handleClose("ws-2");
  });

  // 不同 user 各自独立的 refCount，关闭自己的连接只减少自己的引用计数。
  test("maintains independent refCounts per user so closing one user's connection does not release another user's relay", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let closeCalls = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send() {},
          close() {
            closeCalls += 1;
          },
        }) as never,
    });
    const ws1 = createWs();
    const ws2 = createWs();

    await lifecycle.handleOpen(ws1, "ws-1", "user-a", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-user-a",
    });
    await lifecycle.handleOpen(ws2, "ws-2", "user-b", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-user-b",
    });

    const relayA = registry.getShared("instance-1", "user-a", "rcs_YWdlbnQtMQ.dXNlci1h");
    const relayB = registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i");
    expect(relayA).toBeDefined();
    expect(relayB).toBeDefined();

    lifecycle.handleClose("ws-1");
    expect(registry.getShared("instance-1", "user-a", "rcs_YWdlbnQtMQ.dXNlci1h")).toBeUndefined();
    expect(registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i")).toBeDefined();
    expect(closeCalls).toBe(1);

    lifecycle.handleClose("ws-2");
    expect(registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i")).toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  // 最后一个客户端断开后，session: 与 chat: 的 broadcaster 监听器必须同时注销，
  // 否则 registeredDocs 条目与 Y.Doc 的 update 闭包互相强引用、长期运行内存增长（B-P2.3）。
  test("unregisters both session: and chat: broadcaster listeners when the relay is released", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const unregistered: string[] = [];
    const origUnregister = broadcaster.unregisterYjsDocListener.bind(broadcaster);
    broadcaster.unregisterYjsDocListener = (docName) => {
      unregistered.push(docName);
      origUnregister(docName);
    };
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });
    lifecycle.handleClose("ws-1");

    expect(unregistered).toContain("chat:rcs-1");
    expect(unregistered).toContain("session:rcs-1");
  });

  // openSession 挂起期间连接被断开（relay 已释放并置 destroyed）时，恢复后不得补注册
  // session: 监听器，避免产生无注销点的僵尸条目（B-P2.3 竞态窗口）。
  test("does not register the session: listener after the relay was released while openSession was pending", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const registered: string[] = [];
    const origRegister = broadcaster.registerYjsDocListener.bind(broadcaster);
    broadcaster.registerYjsDocListener = (ydoc, docName) => {
      registered.push(docName);
      origRegister(ydoc, docName);
    };
    // 等待 handleOpen 真正挂起在 openSession（此时 entry 已 addClient、refCount 已持有），
    // 才能命中「释放后补注册」的竞态窗口；过早断开会被 handleOpen 中更早的容量检查拦截。
    const sessionStarted = deferred<void>();
    const sessionPending = deferred<{ ydoc: Y.Doc }>();
    const lifecycle = createGateway(
      registry,
      broadcaster,
      relayEvents,
      {},
      {
        openSession: () => {
          sessionStarted.resolve();
          return sessionPending.promise;
        },
      },
    );
    const ws = createWs();
    const opening = lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    await sessionStarted.promise;

    lifecycle.handleClose("ws-1");
    sessionPending.resolve({ ydoc: new Y.Doc() });
    await opening;

    expect(registered).toContain("chat:rcs-1");
    expect(registered).not.toContain("session:rcs-1");
  });

  // 多标签页（同一 rcsSessionId 两个连接）：一个断开只释放自己的引用，
  // relay / Doc / 广播保持存活，另一个连接不受影响（引用计数语义）。
  test("keeps the shared relay alive while another tab of the same session is connected", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let closeCalls = 0;
    let unsubCalls = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send() {},
          close() {
            closeCalls += 1;
          },
          onMessage() {
            return () => {
              unsubCalls += 1;
            };
          },
        }) as never,
    });
    const ws1 = createWs();
    const ws2 = createWs();

    await lifecycle.handleOpen(ws1, "ws-1", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });
    await lifecycle.handleOpen(ws2, "ws-2", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(2);

    lifecycle.handleClose("ws-1");
    expect(closeCalls).toBe(0);
    expect(unsubCalls).toBe(0);
    expect(registry.getClient("ws-2")).toBeDefined();

    lifecycle.handleClose("ws-2");
    expect(closeCalls).toBe(1);
    expect(unsubCalls).toBe(1);
  });
});
