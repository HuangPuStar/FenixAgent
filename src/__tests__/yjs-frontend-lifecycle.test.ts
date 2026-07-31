import { describe, expect, test } from "bun:test";
import { createDeterministicRcsSessionId, DocManager } from "@fenix/acp-server";
import * as Y from "yjs";
import { AppError } from "../errors";
import { ConnectionRegistry } from "../transport/relay/yjs-frontend/connection-registry";
import { RelayEventHandler } from "../transport/relay/yjs-frontend/relay-event-handler";
import type { ClientConnection, RelayMessage, SharedRelay } from "../transport/relay/yjs-frontend/types";
import { WsLifecycle, type WsLifecycleDependencies } from "../transport/relay/yjs-frontend/ws-lifecycle";
import { YjsBroadcaster } from "../transport/relay/yjs-frontend/yjs-broadcaster";
import type { WsConnection } from "../transport/ws-types";

function createWs(): WsConnection & { messages: string[]; closed: Array<[number | undefined, string | undefined]> } {
  return {
    readyState: 1,
    messages: [],
    closed: [],
    send(message) {
      this.messages.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
    },
  };
}

function createSharedRelay(handle: SharedRelay["handle"]): SharedRelay {
  return {
    handle,
    unsubscribe: null,
    refCount: 1,
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    workspacePath: "/workspace",
    nextRpcId: 0,
  };
}

function createRelayEvents(
  registry: ConnectionRegistry,
  broadcaster: YjsBroadcaster,
  processed: string[],
  reportError: (message: string, error: unknown) => void = () => {},
): RelayEventHandler {
  const mockDocManager = {
    processACP: (_sessionId: string, event: unknown) => processed.push((event as { type: string }).type),
    setChatConnectionStatus: () => {},
    setChatAvailableCommands: () => {},
    setChatTokenUsage: () => {},
    setChatCapabilities: () => {},
    setChatAgentInfo: () => {},
    setChatModelState: () => {},
    setChatModeState: () => {},
    registerSession: () => {},
    syncChatSessions: () => {},
    setChatActiveSession: () => {},
    getChat: () => undefined,
    openSession: async () => ({ ydoc: new Y.Doc() }),
  } as unknown as DocManager;

  return new RelayEventHandler({
    docManager: mockDocManager,
    registry,
    broadcaster,
    registerYjsDocListener: () => {},
    reportError,
  });
}

function createLifecycle(
  registry: ConnectionRegistry,
  broadcaster: YjsBroadcaster,
  relayEvents: RelayEventHandler,
  overrides: Partial<WsLifecycleDependencies> = {},
  docManagerOverrides: Record<string, unknown> = {},
): WsLifecycle {
  const mockDocManager = {
    openChat: async () => ({ ydoc: new Y.Doc() }),
    openSession: async () => ({ ydoc: new Y.Doc() }),
    setChatAgentInfo: () => {},
    setChatConnectionStatus: () => {},
    ...docManagerOverrides,
  } as unknown as DocManager;

  return new WsLifecycle({
    docManager: mockDocManager,
    registry,
    broadcaster,
    relayEvents,
    transition: { beforeForward: async () => true, afterForward: () => {} } as never,
    getEnvironment: async () => ({ organizationId: "org-1", machineName: "Agent" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => ({ instance: { id: "instance-1" } }),
    connectAgentRelay: async () => ({ state: "open", send() {}, close() {} }) as never,
    markRelayAttached: () => {},
    markRelayDetached: () => {},
    reportLog: () => {},
    reportError: () => {},
    maxClients: () => 10,
    resolveInstanceNumberFromSession: async () => 0,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("YJS frontend internal handlers", () => {
  // 过期 ACP session 的 update 必须在共享 relay 消费边界丢弃，不能进入 processACP。
  test("relay event handler filters stale session updates", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const ws = createWs();
    registry.addClient("ws-1", {
      ws,
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "active-session",
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "stale-session", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    expect(processed).toEqual([]);
  });

  // MACHINE_OFFLINE 必须使用已导入的 AppError 分支，并且不得把内部错误详情回传给客户端。
  test("reports AppError connection failures with a safe client error", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw new AppError("machine secret diagnostic", "MACHINE_OFFLINE", 503);
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toHaveLength(1);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
  });

  // 新建共享 relay 时必须先执行 ACP connect 握手，远端 dispatcher 才会回传 status 并允许后续 session/list。
  test("sends connect once before exposing a newly created shared relay", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const sent: unknown[] = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send(message: unknown) {
            sent.push(message);
          },
          close() {},
        }) as never,
    });

    await lifecycle.handleOpen(createWs(), "ws-1", "user-1", "agent-1", "rcs-1");

    expect(sent).toEqual([{ type: "connect" }]);
    lifecycle.handleClose("ws-1");
  });

  // connect 的同步 status 回包必须在 client 登记后处理，否则 list_sessions 会永久被状态门禁拦截。
  test("registers the client before a synchronous connect status reply", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let listener: ((message: RelayMessage) => Promise<void>) | undefined;
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          onMessage(callback: (message: RelayMessage) => Promise<void>) {
            listener = callback;
            return () => {};
          },
          send(message: { type?: string }) {
            if (message.type === "connect") {
              void listener?.({ type: "status", payload: { connected: true } });
            }
          },
          close() {},
        }) as never,
    });

    await lifecycle.handleOpen(createWs(), "ws-1", "user-1", "agent-1", "rcs-1");

    expect(registry.hasStatusReceived("agent-1", "instance-1")).toBe(true);
    lifecycle.handleClose("ws-1");
  });

  // 并发打开同一实例只能建立一个 relay 和一个监听器，引用应由两个客户端共同持有。
  test("shares one in-flight relay acquisition between simultaneous opens", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const connection = deferred<SharedRelay["handle"]>();
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
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
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
    const open1 = lifecycle.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    await connectionStarted.promise;
    const open2 = lifecycle.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");
    connection.resolve(handle as never);
    await Promise.all([open1, open2]);

    expect(connectCalls).toBe(1);
    expect(onMessageCalls).toBe(1);
    expect(attachCalls).toBe(1);
    expect(registry.getShared("instance-1", "user-1")?.refCount).toBe(2);
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
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
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

    await lifecycle.handleOpen(ws1, "ws-1", "user-1", "agent-1", "rcs-1");
    await lifecycle.handleOpen(ws2, "ws-2", "user-1", "agent-1", "rcs-1");

    expect(ensureCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(registry.getShared("instance-1", "user-1")?.refCount).toBe(1);
    expect(JSON.parse(ws2.messages[0] ?? "{}")).toMatchObject({ payload: { code: "too_many_connections" } });
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
    const lifecycle = createLifecycle(
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
    const opening = lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    await snapshotStarted.promise;

    await lifecycle.handleMessage(ws, "ws-1", JSON.stringify({ action: "cancel" }));
    expect(sent).toEqual([]);
    snapshot.resolve({ ydoc: new Y.Doc() });
    await opening;

    expect(sent).toContainEqual(expect.objectContaining({ method: "session/cancel" }));
    lifecycle.handleClose("ws-1");
  });

  // 环境查询拒绝时必须安全释放 pending 容量、记录固定元数据并关闭连接。
  test("rejects environment lookup failures without leaking pending capacity", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const reports: Array<[string, unknown]> = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      getEnvironment: async () => {
        throw new Error("environment secret");
      },
      reportError: (message, error) => reports.push([message, error]),
      maxClients: () => 1,
    });
    const firstWs = createWs();
    const secondWs = createWs();

    await lifecycle.handleOpen(firstWs, "ws-1", "user-1", "agent-1", null);
    await lifecycle.handleOpen(secondWs, "ws-2", "user-1", "agent-1", null);

    expect(JSON.parse(firstWs.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { message: "Agent connection error" },
    });
    expect(firstWs.closed).toEqual([[1011, "environment lookup failed"]]);
    expect(secondWs.closed).toEqual([[1011, "environment lookup failed"]]);
    expect(reports).toEqual([
      ["[YJS-FE] Failed to load environment", { agentId: "agent-1" }],
      ["[YJS-FE] Failed to load environment", { agentId: "agent-1" }],
    ]);
  });

  // 组织环境的成员资格由路由 authContext 验证；lifecycle 注入的纵深 authorizer 不能按个人 owner 拒绝它。
  test("allows an organization environment owned by another user through the injected authorizer", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let ensureCalls = 0;
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      getEnvironment: async () => ({ organizationId: "org-1", userId: "other-user" }),
      authorizeEnvironment: (userId, environment) =>
        environment.organizationId !== null && environment.organizationId !== undefined
          ? true
          : !environment.userId || environment.userId === userId,
      ensureRunning: async () => {
        ensureCalls += 1;
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", null);

    expect(ensureCalls).toBe(1);
    lifecycle.handleClose("ws-1");
  });

  // 个人环境的所有者不同时，lifecycle 的纵深校验必须在启动实例和连接 relay 前拒绝。
  test("rejects a personal environment owned by another user before starting an agent", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let ensureCalls = 0;
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      getEnvironment: async () => ({ userId: "other-user" }),
      authorizeEnvironment: (userId, environment) =>
        environment.organizationId !== null && environment.organizationId !== undefined
          ? true
          : !environment.userId || environment.userId === userId,
      ensureRunning: async () => {
        ensureCalls += 1;
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", null);

    expect(ensureCalls).toBe(0);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { message: "Environment not found" },
    });
    expect(ws.closed).toEqual([[4003, "unauthorized"]]);
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

  // agent 原始错误仍需透传给客户端，但 reportError 不能含有 agent payload 中的敏感信息。
  test.each(["error", "session_error"])("does not report raw %s payloads", async (messageType) => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], (message, error) => reports.push([message, error]));
    const ws = createWs();
    registry.addClient("ws-1", {
      ws,
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);
    const raw = { type: messageType, payload: { secret: "agent-secret" }, error: "agent-secret" };

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))(
      raw as RelayMessage,
    );

    expect(reports).toEqual([
      [
        messageType === "error" ? "[YJS-FE] agent error" : "[YJS-FE] session error",
        { messageType, instanceId: "instance-1" },
      ],
    ]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual(raw);
  });

  // status 自动 list_sessions 的 Promise 拒绝必须被等待、捕获并以安全上下文记录。
  test("captures rejected automatic list_sessions sends", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], (message, error) => reports.push([message, error]));
    const ws = createWs();
    registry.addClient("ws-1", {
      ws,
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: false,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    });

    await handler.createMessageHandler(
      createSharedRelay({
        state: "open",
        send: async () => {
          throw new Error("send rejected");
        },
        close() {},
      }),
    )({ type: "status", payload: { rpcPayload: "do-not-log" } } as unknown as RelayMessage);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toBe("[YJS-FE] auto list_sessions send failed: instanceId=instance-1");
  });

  // 同一 instance 下不同 user 各自获得不同的 SharedRelay（不同的 rcsSessionId）。
  test("assigns distinct SharedRelays with different rcsSessionIds to different users on the same instance", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let connectCalls = 0;
    const openedRcsSessionIds: string[] = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      connectAgentRelay: async (_instanceId, rcsSessionId) => {
        connectCalls += 1;
        openedRcsSessionIds.push(rcsSessionId);
        return { state: "open", send() {}, close() {} } as never;
      },
    });
    const ws1 = createWs();
    const ws2 = createWs();

    await lifecycle.handleOpen(ws1, "ws-1", "user-a", "agent-1", null);
    await lifecycle.handleOpen(ws2, "ws-2", "user-b", "agent-1", null);

    expect(connectCalls).toBe(2);
    expect(openedRcsSessionIds).toHaveLength(2);
    expect(openedRcsSessionIds[0]).not.toBe(openedRcsSessionIds[1]);

    const relayA = registry.getShared("instance-1", "user-a");
    const relayB = registry.getShared("instance-1", "user-b");
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
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
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

    await lifecycle.handleOpen(ws1, "ws-1", "user-a", "agent-1", null);
    await lifecycle.handleOpen(ws2, "ws-2", "user-b", "agent-1", null);

    const relayA = registry.getShared("instance-1", "user-a");
    const relayB = registry.getShared("instance-1", "user-b");
    expect(relayA).toBeDefined();
    expect(relayB).toBeDefined();

    lifecycle.handleClose("ws-1");
    expect(registry.getShared("instance-1", "user-a")).toBeUndefined();
    expect(registry.getShared("instance-1", "user-b")).toBeDefined();
    expect(closeCalls).toBe(1);

    lifecycle.handleClose("ws-2");
    expect(registry.getShared("instance-1", "user-b")).toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  // relay event handler 广播仍发送给同 instance 的所有用户（error/session_error 等消息按 instance 维度广播保持不变）。
  test("broadcasts relay error messages to all users of the same instance", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const mockDocManager = {
      processACP: () => {},
      setChatConnectionStatus: () => {},
      setChatAvailableCommands: () => {},
      setChatTokenUsage: () => {},
      setChatCapabilities: () => {},
      setChatAgentInfo: () => {},
      setChatModelState: () => {},
      setChatModeState: () => {},
      registerSession: () => {},
      syncChatSessions: () => {},
      setChatActiveSession: () => {},
      getChat: () => undefined,
      openSession: async () => ({ ydoc: new Y.Doc() }),
    } as unknown as DocManager;
    const handler = new RelayEventHandler({
      docManager: mockDocManager,
      registry,
      broadcaster,
      registerYjsDocListener: () => {},
      reportError: () => {},
    });
    const ws1 = createWs();
    const ws2 = createWs();
    registry.addClient("ws-1", {
      ws: ws1,
      userId: "user-a",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);
    registry.addClient("ws-2", {
      ws: ws2,
      userId: "user-b",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-b",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);

    const relay: SharedRelay = {
      handle: {
        state: "open",
        send: async () => {},
        close() {},
      },
      unsubscribe: null,
      refCount: 1,
      userId: "user-a",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      workspacePath: "/workspace",
      nextRpcId: 0,
    };
    await handler.createMessageHandler(relay)({
      type: "error",
      payload: { message: "test-error" },
    } as unknown as RelayMessage);

    expect(ws1.messages.length).toBeGreaterThanOrEqual(1);
    expect(ws2.messages.length).toBeGreaterThanOrEqual(1);
    expect(ws1.messages).toEqual(ws2.messages);
  });

  // 两个用户连接同一实例后，user-a 的 session/new 结果不覆写 user-b 的 acpSessionId。
  test("session/new from user-a does not overwrite user-b's acpSessionId", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const mockDocManager2 = {
      processACP: () => {},
      setChatConnectionStatus: () => {},
      setChatAvailableCommands: () => {},
      setChatTokenUsage: () => {},
      setChatCapabilities: () => {},
      setChatAgentInfo: () => {},
      setChatModelState: () => {},
      setChatModeState: () => {},
      registerSession: () => {},
      syncChatSessions: () => {},
      setChatActiveSession: () => {},
      getChat: () => undefined,
      openSession: async () => ({ ydoc: new Y.Doc() }),
    } as unknown as DocManager;
    const handler = new RelayEventHandler({
      docManager: mockDocManager2,
      registry,
      broadcaster,
      registerYjsDocListener: () => {},
      reportError: () => {},
    });
    const wsA = createWs();
    const wsB = createWs();
    registry.addClient("ws-a", {
      ws: wsA,
      userId: "user-a",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);
    registry.addClient("ws-b", {
      ws: wsB,
      userId: "user-b",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-b",
      acpSessionId: "ses-user-b",
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);

    const relay: SharedRelay = {
      handle: { state: "open", send: async () => {}, close() {} },
      unsubscribe: null,
      refCount: 1,
      userId: "user-a",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      workspacePath: "/workspace",
      nextRpcId: 0,
    };
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      method: "session/new",
      result: { sessionId: "ses-user-a-new" },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-a")?.acpSessionId).toBe("ses-user-a-new");
    expect(registry.getClient("ws-b")?.acpSessionId).toBe("ses-user-b");
  });

  // user-a 的 session/update 不被 user-b 的 active session 过滤掉。
  test("session/update from shared relay of user-a is not filtered by user-b's active session id", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const wsA = createWs();
    registry.addClient("ws-a", {
      ws: wsA,
      userId: "user-a",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);
    registry.addClient("ws-b", {
      ws: createWs(),
      userId: "user-b",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-b",
      acpSessionId: "ses-user-b-active",
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);

    const relay: SharedRelay = {
      handle: { state: "open", send: async () => {}, close() {} },
      unsubscribe: null,
      refCount: 1,
      userId: "user-a",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      workspacePath: "/workspace",
      nextRpcId: 0,
    };

    // user-a 的 update 带 user-a 没有 acpSessionId（null），即使 user-b 有 active session 也不应被过滤。
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-user-a-new", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    expect(processed).toEqual(["agent_message_chunk"]);
  });
});
