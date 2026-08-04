import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDeterministicRcsSessionId, DocManager } from "@fenix/acp-server";
import { CoreRuntimeError, type CoreRuntimeFacade, type RuntimeInstanceSnapshot } from "@fenix/core";
import { type AgentController, AgentNodeUnavailableError, LaunchSpecBuildError } from "@fenix/orchestration";
import * as Y from "yjs";
import { AppError } from "../errors";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";
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

  // 兼容形态：直接抛 AppError MACHINE_OFFLINE（历史/外部调用方形态）仍走 4500 终态，
  // 错误详情（message 含敏感诊断）只进服务端日志，客户端帧恒为脱敏文案。
  test("reports AppError MACHINE_OFFLINE connection failures with a safe client error", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new AppError("machine secret diagnostic", "MACHINE_OFFLINE", 503);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
  });

  // 真实形态一：ensureNode 抛 AgentNodeUnavailableError（节点未注册/已回收/未 connected），
  // 等价机器不可达 → 4500 终态；message 中的 machineId 与状态详情不得泄漏给客户端。
  test("closes 4500 and masks details when ensureNode throws AgentNodeUnavailableError", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new AgentNodeUnavailableError("Agent node for machine mach_x is unavailable");
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    // 客户端帧不得出现 machineId 与原始诊断文案（machine_unavailable 为合法脱敏错误码，不在此列）
    expect(ws.messages.join("")).not.toContain("mach_x");
  });

  // 真实形态二：core launch 竞态窗口抛 CoreRuntimeError NODE_OFFLINE（ensureNode 放行后
  // 机器断连，core 节点已被置 offline）→ 同样 4500 终态且不泄漏 nodeId。
  test("closes 4500 when core launch fails with NODE_OFFLINE in the disconnect race window", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new CoreRuntimeError("NODE_OFFLINE", "Core node is offline: mach_x");
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    expect(ws.messages.join("")).not.toContain("mach_x");
  });

  // 负例：瞬时/未知的 spawn 失败（INSTANCE_NOT_VISIBLE 防御分支、普通 Error）必须仍走
  // 1011 通用分支，钉住判定边界，防止错误分类面过度扩大把非永久失败变成终态。
  test("keeps 1011 generic branch for non-permanent spawn failures", async () => {
    for (const thrown of [
      new AppError("Instance 'i-1' spawned but missing from runtime registry", "INSTANCE_NOT_VISIBLE", 500),
      new Error("boom"),
    ]) {
      const registry = new ConnectionRegistry();
      const broadcaster = new YjsBroadcaster(registry);
      const relayEvents = createRelayEvents(registry, broadcaster, []);
      const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
        ensureRunning: async () => {
          throw thrown;
        },
      });
      const ws = createWs();

      await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

      expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
        type: "error",
        payload: { message: "Agent connection error" },
      });
      expect(ws.closed).toEqual([[1011, "spawn failed"]]);
    }
  });

  // autoStart 关闭是配置态，重连不会改变配置：必须 close 4502 进入终态停止自动重连，
  // 错误帧携带 auto_start_disabled 诊断码，message 保持脱敏（实例编号只进服务端日志）。
  test("closes 4502 with auto_start_disabled when ensureRunning throws AUTO_START_DISABLED", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new AppError("实例 2 未运行且 autoStart 已禁用", "AUTO_START_DISABLED", 409);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "auto_start_disabled", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏实例编号与原始诊断文案
    expect(ws.messages.join("")).not.toContain("autoStart");
    expect(ws.messages.join("")).not.toContain("2");
  });

  // maxSessions 上限是配置态，重连不会释放实例：同样 close 4502 终态并携带诊断码。
  test("closes 4502 with max_sessions_reached when ensureRunning throws MAX_SESSIONS_REACHED", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new AppError("已达到最大实例数 3", "MAX_SESSIONS_REACHED", 409);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "max_sessions_reached", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
  });

  // launch spec 构建条件是配置态（如 RCS_DISABLE_LOCAL_EXECUTION 且无远程机器），
  // 每次 spawn 必然失败：编排域 LaunchSpecBuildError 同样坍缩为 4502 终态。
  test("closes 4502 with launch_spec_build_failed on LaunchSpecBuildError", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = new LaunchSpecBuildError("Cannot spawn instance: environment 'env-1' has no machineId configured");
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "launch_spec_build_failed", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏 envId 与原始诊断文案
    expect(ws.messages.join("")).not.toContain("env-1");
    expect(ws.messages.join("")).not.toContain("machineId");
  });

  // 坏 sessionId（历史 session_* 书签、ACP ses_* 混入、实例回收后编号失效）应降级为默认实例继续连接，
  // 连接建立后由 ACP 层重建会话；不得以 4004 拒绝连接（4004 不在客户端终态码集合，会触发相同 URL 无限重连）。
  test("degrades to the default instance when the sessionId cannot be resolved", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const seen: Array<number | undefined> = [];
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      resolveInstanceNumberFromSession: async () => {
        throw new Error("Invalid instance session id");
      },
      ensureRunning: async (_userId, _agentId, _mode, instanceNumber) => {
        seen.push(instanceNumber);
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1", "ses_inst_env_9");

    expect(ws.closed).toEqual([]);
    expect(seen).toEqual([undefined]);
    expect(registry.getClient("ws-1")).toBeDefined();
  });

  // 环境不存在是不可恢复的引用失效：必须保持 4004 终态关闭（配合客户端 NO_RECONNECT_CODES 停止自动重连），
  // 钉住该行为防止回归为无限重连。
  test("keeps closing 4004 when the environment no longer exists", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents, {
      getEnvironment: async () => undefined,
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(ws.closed).toEqual([[4004, "env not found"]]);
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
    expect(closeCalls).toBe(1);

    lifecycle.handleClose("ws-2");
    expect(registry.getShared("instance-1", "user-b", "rcs_YWdlbnQtMQ.dXNlci1i")).toBeUndefined();
    expect(closeCalls).toBe(2);
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
    };
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
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
    const lifecycle = createLifecycle(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
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
    const lifecycle = createLifecycle(
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
    const opening = lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    await sessionStarted.promise;

    lifecycle.handleClose("ws-1");
    sessionPending.resolve({ ydoc: new Y.Doc() });
    await opening;

    expect(registered).toContain("chat:rcs-1");
    expect(registered).not.toContain("session:rcs-1");
  });

  // relay 已释放（destroyed=true）后，relay-event-handler 收到 session/new result 不得补注册
  // session: 监听器：relay 已销毁，注册只会留下无注销点的僵尸条目（B-P2.3 竞态窗口）。
  test("does not register the session: listener from session/new after the relay was destroyed", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const registered: string[] = [];
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
      registerYjsDocListener: (_ydoc, docName) => {
        registered.push(docName);
      },
      reportError: () => {},
    });
    const shared = { ...createSharedRelay({ state: "open", send() {}, close() {} }), destroyed: true };

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses_new", configOptions: [] },
    } as unknown as RelayMessage);

    expect(registered).toEqual([]);
  });
});

// C-P2.4：交互式 Chat 中 relay_closed（进程崩溃）必须触发本地实例级死亡清理，
// 否则死实例状态恒 running、被 ensureRunning 无限复用且持续占并发额度；
// 远程实例由 terminateLocalDeadInstance 的 nodeId 校验排除
describe("RelayEventHandler relay death cleanup", () => {
  /** 记录 controller.stopInstance 调用（清理触发的证据）。 */
  const controllerStopCalls: string[] = [];

  const fakeFacade = {
    getInstance: () =>
      ({
        instanceId: "instance-1",
        engineType: "opencode",
        nodeId: "local-default",
        status: "running",
        launchSpec: {},
        relayConnected: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as unknown as RuntimeInstanceSnapshot,
    stopInstance: async () => {},
  } as unknown as CoreRuntimeFacade;

  const fakeController = {
    listInstances: () => [{ instanceId: "instance-1" }],
    stopInstance: async (instanceId: string) => {
      controllerStopCalls.push(instanceId);
    },
  } as unknown as AgentController;

  beforeEach(() => {
    controllerStopCalls.length = 0;
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({ getOrchestrationController: () => fakeController });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  // 交互式 Chat 中 relay 意外关闭：本地实例死亡信号，须触发实例级清理；
  // 客户端 ws 关闭（1011）与清理互不阻塞
  test("交互式 Chat 中 relay_closed → 本地实例触发 terminateLocalDeadInstance", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    // terminateLocalDeadInstance 为 fire-and-forget，等其微任务链完成
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controllerStopCalls).toEqual(["instance-1"]);
  });

  // 远程实例的 relay_closed 由 E-P0.1 机器级断连清理覆盖，
  // 本地死亡钩子必须静默跳过，避免与机器级清理双重 stop
  test("远程实例 relay_closed → 不触发清理", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    // 覆盖 fakeFacade.getInstance 返回远程快照（nodeId 校验回归）
    stubCoreBootstrap({
      getCoreRuntime: () =>
        ({
          getInstance: () =>
            ({
              instanceId: "instance-1",
              engineType: "opencode",
              nodeId: "mach_remote",
              status: "running",
              launchSpec: {},
              relayConnected: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            }) as unknown as RuntimeInstanceSnapshot,
          stopInstance: async () => {},
        }) as unknown as CoreRuntimeFacade,
    });

    await handler.createMessageHandler(createSharedRelay({ state: "open", send() {}, close() {} }))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controllerStopCalls).toEqual([]);
  });
});
