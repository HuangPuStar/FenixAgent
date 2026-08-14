import { afterEach, describe, expect, test } from "bun:test";
import { createDeterministicRcsSessionId, DocManager } from "@fenix/acp-server";
import * as Y from "yjs";
import { AppError } from "../errors";
import { ConnectionRegistry } from "../transport/relay/yjs-frontend/connection-registry";
import { RelayEventHandler } from "../transport/relay/yjs-frontend/relay-event-handler";
import type { ClientConnection, RelayMessage, SharedRelay } from "../transport/relay/yjs-frontend/types";
import { WsLifecycle, type WsLifecycleDependencies } from "../transport/relay/yjs-frontend/ws-lifecycle";
import { YjsBroadcaster } from "../transport/relay/yjs-frontend/yjs-broadcaster";
import type { WsConnection } from "../transport/ws-types";

type ScheduledInterval = {
  callback: () => void;
  cleared: boolean;
  delay: number | undefined;
};

const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
const originalClearInterval = Object.getOwnPropertyDescriptor(globalThis, "clearInterval");
const originalDateNow = Object.getOwnPropertyDescriptor(Date, "now");
let intervals: ScheduledInterval[] = [];

function installIntervalFakes(now: () => number): void {
  intervals = [];
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      const interval = { callback, cleared: false, delay };
      intervals.push(interval);
      return interval;
    },
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    value: (interval: ScheduledInterval) => {
      interval.cleared = true;
    },
  });
  Object.defineProperty(Date, "now", { configurable: true, value: now });
}

function restoreProperty(target: object, name: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

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
    updateSessionSummary: () => {},
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
  afterEach(() => {
    restoreProperty(globalThis, "setInterval", originalSetInterval);
    restoreProperty(globalThis, "clearInterval", originalClearInterval);
    restoreProperty(Date, "now", originalDateNow);
  });

  // 客户端 keep_alive 会续期，页面可见期间不会因连接建立时间到期而关闭。
  test("renews the YJS WS keepalive timeout after a client keep_alive", async () => {
    let now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const keepalive = intervals.find((interval) => interval.delay === 30_000);

    now = 1_050_000;
    await lifecycle.handleMessage(ws, "ws-1", JSON.stringify({ type: "keep_alive" }));
    now = 1_100_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([]);

    now = 1_110_001;
    keepalive?.callback();

    expect(ws.closed).toEqual([[4501, "client keepalive timeout"]]);
  });

  // 新连接从客户端登记时刻开始计时：首个 30 秒周期仍保活，连续 60 秒未收到客户端 keep_alive 才关闭。
  test("closes the YJS WS only after the client keepalive timeout elapses from registration", async () => {
    let now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const keepalive = intervals.find((interval) => interval.delay === 30_000);
    expect(keepalive).toBeDefined();

    now = 1_030_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([]);
    expect(ws.messages.map((message) => JSON.parse(message))).toContainEqual({ type: "keep_alive" });

    now = 1_060_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([[4501, "client keepalive timeout"]]);
    expect(
      ws.messages.map((message) => JSON.parse(message)).filter((message) => message.type === "keep_alive"),
    ).toHaveLength(1);
  });

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
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(2);
    lifecycle.handleClose("ws-1");
    expect(unsubscribeCalls).toBe(0);
    expect(closeCalls).toBe(0);
    lifecycle.handleClose("ws-2");
    expect(unsubscribeCalls).toBe(1);
    // relay handle 不随客户端断开主动关闭（前端断连是正常事件，handle 由
    // orchestrator 跨连接复用，最终由实例回收路径关闭）
    expect(closeCalls).toBe(0);
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
    expect(registry.getShared("instance-1", "user-1", "rcs-1")?.refCount).toBe(1);
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

  // Agent 原始错误不得泄露到浏览器，且仅向当前 RCS 会话发送固定的安全错误。
  test.each([
    ["error", "agent_error", "Agent request failed"],
    ["session_error", "session_error", "Agent session request failed"],
  ])("redacts %s payloads before sending them to the current RCS session", async (messageType, code, message) => {
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
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({ type: "error", payload: { code, message } });
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

    const relayA = registry.getShared("instance-1", "user-a", "rcs_YWdlbnQtMQ.dXNlci1h");
    const relayB = registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i");
    expect(relayA).toBeDefined();
    expect(relayB).toBeDefined();

    lifecycle.handleClose("ws-1");
    expect(registry.getShared("instance-1", "user-a", "rcs_YWdlbnQtMQ.dXNlci1h")).toBeUndefined();
    expect(registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i")).toBeDefined();
    // 自己的引用归零只触发 listener 注销，不主动关闭共享的 relay handle
    expect(closeCalls).toBe(0);

    lifecycle.handleClose("ws-2");
    expect(registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i")).toBeUndefined();
    expect(closeCalls).toBe(0);
  });

  // relay 错误只发送给当前 RCS 会话，其他用户或会话不得收到 Agent 错误。
  test("sends relay error messages only to the matching RCS session", async () => {
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
    expect(ws2.messages).toHaveLength(0);
    expect(JSON.parse(ws1.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "agent_error", message: "Agent request failed" },
    });
  });

  // 同一用户的不同 RCS 会话中，session/new 只能更新当前 RCS 的 ACP session ID。
  test("session/new does not overwrite another RCS session for the same user", async () => {
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
      userId: "user-1",
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
      userId: "user-1",
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
      userId: "user-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      workspacePath: "/workspace",
      nextRpcId: 0,
      // 模拟 create_session 请求出口已登记在途 rpcId：会话同步 result 分支仅放行
      // 登记过的响应（JSON-RPC 响应帧只有 id 无 method，防 rename/delete 劫持）
      pendingSessionSyncIds: new Map([[1, "create"]]),
    };
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      result: { sessionId: "ses-user-a-new" },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-a")?.acpSessionId).toBe("ses-user-a-new");
    expect(registry.getClient("ws-b")?.acpSessionId).toBe("ses-user-b");
  });

  // 同一用户的不同 RCS 会话中，session/update 只能以当前 RCS 的 ACP session 过滤。
  test("session/update is not filtered by another RCS session for the same user", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const wsA = createWs();
    registry.addClient("ws-a", {
      ws: wsA,
      userId: "user-1",
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
      userId: "user-1",
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
      userId: "user-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-a",
      workspacePath: "/workspace",
      nextRpcId: 0,
    };

    // 当前 RCS 没有 active session，即使同用户另一个 RCS 有 active session 也不应被过滤。
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-user-a-new", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    expect(processed).toEqual(["agent_message_chunk"]);
  });

  // 同一用户的不同 RCS 会话中，status 只能解除当前 RCS 的 session/list 门禁。
  test("status does not mark another RCS session as initialized for the same user", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    const client = (rcsSessionId: string): ClientConnection => ({
      ws: createWs(),
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId,
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: false,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    });
    registry.addClient("ws-a", client("rcs-a"));
    registry.addClient("ws-b", client("rcs-b"));
    const sent: unknown[] = [];
    const relay = createSharedRelay({ state: "open", send: async (message) => void sent.push(message), close() {} });
    relay.rcsSessionId = "rcs-a";

    await handler.createMessageHandler(relay)({ type: "status", payload: { capabilities: {} } } as RelayMessage);

    expect(registry.getClient("ws-a")?.agentStatusReceived).toBe(true);
    expect(registry.getClient("ws-b")?.agentStatusReceived).toBe(false);
    expect(sent).toHaveLength(1);
  });

  // Agent 断连 status（connected:false：子进程死亡/连接关闭，acp-link 只发该帧
  // 不报错不关 relay）必须收敛活动 turn 为 error 事件（main 无 turn 状态机，
  // 收敛为 chatMeta status=error + loading 清空），否则前端 loading 永久卡死（R1）。
  test("status connected:false converges the active turn to an error event", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))({
      type: "status",
      payload: { connected: false },
    } as unknown as RelayMessage);

    expect(processed).toContain("error");
  });

  // Agent 子进程死亡后 acp-link 以 JSON-RPC error 响应拒绝 prompt（-32000 "No
  // active session"），该帧无法归一化为终态事件；relay 必须按在途 prompt 登记
  // 收敛 error 事件（main 无 turn 状态机），否则前端 loading 永不消失（R1）。
  // 错误内容脱敏（只记录 code，不泄露 acp-link 原始 message），登记消费后删除。
  test("prompt error response converges via the pending prompt registration", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, processed, (message, error) =>
      reports.push([message, error]),
    );
    const shared = createSharedRelay({ state: "open", send() {}, close() {} });
    // prompt 请求出口登记（forwardYjsAction send_prompt 分支）
    shared.pendingPromptIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "No active session" },
    } as unknown as RelayMessage);

    expect(processed).toContain("error");
    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toContain("prompt rejected");
    expect(reports[0]?.[1]).toEqual({ instanceId: "instance-1", code: -32000 });
  });

  // 未登记的 JSON-RPC error（非 send_prompt 在途请求）不得收敛 turn：
  // 错误帧只按登记匹配收敛，prompt 之外的错误不派发终态事件。
  test("unregistered error responses do not converge the turn", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "Failed to set model" },
    } as unknown as RelayMessage);

    expect(processed).not.toContain("error");
  });

  // 会话同步分支必须校验在途请求登记（JSON-RPC 响应无 method 字段）：rename 响应
  // 同样携带 sessionId/title 但未经登记，不得 clobber registry 活跃会话、不得误开
  // 回放窗口、不得投影 title——否则重命名非当前会话时活跃会话绑定被改写，绑定校验
  // 丢弃其全部 session/update 增量（输出流冻结），标题也被错误覆盖（M1）。
  test("rename result without pending session sync does not hijack the session sync branch", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const calls: string[] = [];
    const mockDocManager = {
      processACP: () => {},
      setChatConnectionStatus: () => {},
      setChatAvailableCommands: () => {},
      setChatTokenUsage: () => {},
      setChatCapabilities: () => {},
      setChatAgentInfo: () => {},
      setChatModelState: () => {},
      setChatModeState: () => {},
      registerSession: () => calls.push("registerSession"),
      syncChatSessions: () => {},
      setChatActiveSession: () => calls.push("setChatActiveSession"),
      getChat: () => undefined,
      openSession: async () => {
        calls.push("openSession");
        return { ydoc: new Y.Doc() };
      },
    } as unknown as DocManager;
    const handler = new RelayEventHandler({
      docManager: mockDocManager,
      registry,
      broadcaster,
      registerYjsDocListener: () => {},
      reportError: () => {},
    });
    registry.addClient("ws-1", {
      ws: createWs(),
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-current",
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: true,
    } satisfies ClientConnection);
    const shared = createSharedRelay({ state: "open", send() {}, close() {} });

    // rename 非当前会话 ses-other 的响应：未登记（pendingSessionSyncIds 为空）
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-other", title: "Renamed" },
    } as unknown as RelayMessage);

    // 活跃会话绑定不被 clobber、会话同步副作用不触发
    expect(registry.getClient("ws-1")?.acpSessionId).toBe("ses-current");
    expect(calls).toEqual([]);
  });

  // title 投影语义：session/new、load 响应携带 agent 侧标题；空串视为缺省（与
  // acp-link list 过滤语义一致），不得用空标题覆盖；非空标题投影到注册条目。
  test("session sync result projects title and treats empty title as missing", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const registered: Array<Record<string, unknown>> = [];
    const mockDocManager = {
      processACP: () => {},
      setChatConnectionStatus: () => {},
      setChatAvailableCommands: () => {},
      setChatTokenUsage: () => {},
      setChatCapabilities: () => {},
      setChatAgentInfo: () => {},
      setChatModelState: () => {},
      setChatModeState: () => {},
      registerSession: (_rcs: string, session: Record<string, unknown>) => registered.push(session),
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
    registry.addClient("ws-1", {
      ws: createWs(),
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
    const shared = createSharedRelay({ state: "open", send() {}, close() {} });

    // 空串标题（id=1）→ 注册为空串（视为缺省）；非空标题（id=2，新会话）→ 投影
    shared.pendingSessionSyncIds = new Map([
      [1, "load"],
      [2, "create"],
    ]);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-1", title: "  " },
    } as unknown as RelayMessage);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "ses-2", title: "My Session" },
    } as unknown as RelayMessage);

    expect(registered[0]?.title).toBe("");
    expect(registered[1]?.title).toBe("My Session");
    expect(registry.getClient("ws-1")?.acpSessionId).toBe("ses-2");
  });

  // load_session 响应 = 历史回放完成：回放的历史 user_message_chunk 会把 Session Doc
  // status 置为 loading，此时必须无条件广播 session_update "ready" 复位 loading——
  // 否则切换会话后前端 isLoading 永久残留（cancel 按钮/输入禁用无法解除）。
  // resume_session 是恢复进行中的 turn，loading 属于真实状态，不得清除。
  test("session/load result resets replay loading, session/resume keeps it", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const makeSessionDoc = () => {
      const ydoc = new Y.Doc();
      // 模拟回放结束时的状态：历史 user_message_chunk 已把 status 置为 loading
      ydoc.getMap("meta").set("status", "loading");
      return { ydoc };
    };
    const mockDocManager = {
      processACP: (_rcs: string, event: { type: string; payload?: Record<string, unknown> }) => processed.push(event),
      setChatActiveSession: () => {},
      setChatModelState: () => {},
      setChatModeState: () => {},
      registerSession: () => {},
      openSession: async () => makeSessionDoc(),
    } as unknown as DocManager;

    const handler = new RelayEventHandler({
      docManager: mockDocManager,
      registry,
      broadcaster,
      registerYjsDocListener: () => {},
      reportError: () => {},
    });

    // load_session 响应：即使 status 为 loading（回放污染）也必须复位
    // （processACP 还会收到 extractAcpEvent 提取的 unknown 事件，仅断言 session_update）
    const sharedLoad = createSharedRelay({ state: "open", send() {}, close() {} });
    sharedLoad.pendingSessionSyncIds = new Map([[1, "load"]]);
    await handler.createMessageHandler(sharedLoad)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-load" },
    } as unknown as RelayMessage);
    expect(processed.filter((event) => event.type === "session_update")).toEqual([
      { type: "session_update", payload: { sessionUpdate: "ready" } },
    ]);

    // resume_session 响应：status 为 loading 时保持原行为，不清 loading、不广播 ready
    processed.length = 0;
    const sharedResume = createSharedRelay({ state: "open", send() {}, close() {} });
    sharedResume.pendingSessionSyncIds = new Map([[2, "resume"]]);
    await handler.createMessageHandler(sharedResume)({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "ses-resume" },
    } as unknown as RelayMessage);
    expect(processed.filter((event) => event.type === "session_update")).toEqual([]);
  });

  // session_info_update 通知是唯一实时标题通道：agent 生成标题后推送（acp-link
  // 的 session_list 过滤空标题/"New session"前缀，轮询无法带回未命名会话）。
  // 非空标题必须投影到 Chat Doc sessions；空串/null 视为未生成，保持现有值。
  test("session_info_update notification projects non-empty title to session summary", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const updates: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
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
      updateSessionSummary: (_rcs: string, sessionId: string, patch: Record<string, unknown>) =>
        updates.push({ sessionId, patch }),
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
    registry.addClient("ws-1", {
      ws: createWs(),
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: { state: "open", send() {}, close() {} },
      relayUnsub: null,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-active",
      workspacePath: "/workspace",
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: true,
      lastClientKeepalive: 0,
      sessionLoaded: false,
    } satisfies ClientConnection);
    const shared = createSharedRelay({ state: "open", send() {}, close() {} });

    // 非空标题 → 投影到该会话的 summary；空串与 null → 不覆盖（保持现有值）
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-active", update: { sessionUpdate: "session_info_update", title: "重构会话列表" } },
    } as unknown as RelayMessage);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-active", update: { sessionUpdate: "session_info_update", title: "" } },
    } as unknown as RelayMessage);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-active", update: { sessionUpdate: "session_info_update", title: null } },
    } as unknown as RelayMessage);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionId).toBe("ses-active");
    expect(updates[0]?.patch).toEqual({ title: "重构会话列表" });
  });

  // 轮询门禁可观测性：status 未就绪时 session/list 轮询被跳过且不产生异常，必须
  // 显式计数告警（连续 3 次 reportLog，之后每 30 次再报防刷屏），成功发送时清零
  // ——否则"轮询是否在跑"不可观测（R3 门禁卡死场景）。
  test("session list poll reports after consecutive gate skips and clears on success", async () => {
    const now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const logs: string[] = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      reportLog: (message) => logs.push(message),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const poll = intervals.find((interval) => interval.delay === 10_000);
    expect(poll).toBeDefined();

    // status 未就绪：连续 3 次跳过 → 第 3 次告警一次
    poll?.callback();
    poll?.callback();
    poll?.callback();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("session list poll skipped 3");

    // 第 4 次跳过不重复告警（仅 3 次与每 30 次告警）
    poll?.callback();
    expect(logs).toHaveLength(1);

    // status 到达后门禁解除，成功发送清零计数
    const shared = registry.getShared("instance-1", "user-1", "rcs-1");
    await relayEvents.createMessageHandler(shared as SharedRelay)({
      type: "status",
      payload: { connected: true },
    } as unknown as RelayMessage);
    poll?.callback();
    expect(logs).toHaveLength(1);
    expect(shared?.sessionListSkipCount).toBe(0);

    lifecycle.handleClose("ws-1");
  });

  // URL 带普通会话 sessionId（单实例场景，标题非 "Instance N"）时，解析器返回
  // undefined（默认实例），连接必须成功且 ensureRunning 收到 undefined——抛错会
  // 让 WS 以 4004 拒绝，用户刷新后 send_prompt 被前端静默丢弃（服务端无感知）。
  test("allows opening when URL sessionId maps to no instance number", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const instanceNumbers: Array<number | undefined> = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      resolveInstanceNumberFromSession: async () => undefined,
      ensureRunning: async (_userId, _agentId, _mode, instanceNumber) => {
        instanceNumbers.push(instanceNumber);
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1", "session_abc");

    expect(instanceNumbers).toEqual([undefined]);
    expect(ws.closed).toEqual([]);

    lifecycle.handleClose("ws-1");
  });
});
