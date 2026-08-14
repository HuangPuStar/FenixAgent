// packages/chat-channel/src/channel/connection-test-helpers.ts
// 连接层测试共享辅助（C6 迁移自 src/__tests__/yjs-frontend-lifecycle.test.ts 的本地 helpers）。
//
// 仅用于包内测试；fake 语义与宿主装配保持一致：
// - spawn 错误分类器按错误 code 判定（宿主 offline-error.ts 的 MACHINE_OFFLINE /
//   AUTO_START_DISABLED / MAX_SESSIONS_REACHED / LAUNCH_SPEC_BUILD_FAILED 语义对齐，
//   错误类 instanceof 校验在宿主侧，C7 桥接注入）；
// - SessionChannel 桩只记录 relay 转发（缓冲/重放时序测试），守卫与 Ack 语义由
//   session-channel-action.test.ts 覆盖。

import * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import type { ClientConnection, SharedRelay, WsConnection } from "./connection-types";
import { Gateway, type GatewayDependencies } from "./gateway";
import { RelayEventHandler, type RelayEventHandlerDependencies } from "./relay-event-handler";
import type { SessionChannel } from "./session-channel";

export type MockWs = WsConnection & {
  messages: string[];
  closed: Array<[number | undefined, string | undefined]>;
  bufferedAmount?: number;
};

export function createWs(bufferedAmount = 0): MockWs {
  return {
    readyState: 1,
    messages: [],
    closed: [],
    bufferedAmount,
    send(message) {
      this.messages.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
    },
  };
}

export function createSharedRelay(overrides: Partial<SharedRelay> = {}): SharedRelay {
  return {
    handle: { state: "open", send() {}, close() {} },
    unsubscribe: null,
    refCount: 1,
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    workspacePath: "/workspace",
    nextRpcId: 0,
    replayWindowUntil: null,
    ...overrides,
  };
}

export function createClient(overrides: Partial<ClientConnection> = {}): ClientConnection {
  return {
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
    openTime: 0,
    pendingMessages: [],
    relayReady: true,
    agentStatusReceived: false,
    lastClientKeepalive: 0,
    sessionLoaded: false,
    ...overrides,
  };
}

/** 记录型 SessionChannel 桩：handleAction 直接把命令转发到连接的 sendToRelay */
export function createSessionChannelStub(): SessionChannel {
  return {
    handleAction: async (connection: { sendToRelay: (message: Record<string, unknown>) => Promise<void> | void }) => {
      await connection.sendToRelay({ jsonrpc: "2.0", id: 1, method: "session/cancel", params: {} });
    },
    disposeRcsSession: () => {},
  } as unknown as SessionChannel;
}

/** 按错误 code 判定的 spawn 错误分类器（与宿主 offline-error.ts 语义对齐） */
export function createSpawnClassifier(): {
  isMachineOffline: GatewayDependencies["isMachineOffline"];
  classifyPermanentSpawnFailure: GatewayDependencies["classifyPermanentSpawnFailure"];
} {
  const MACHINE_OFFLINE_CODES = new Set([
    "MACHINE_OFFLINE",
    "AGENT_NODE_UNAVAILABLE",
    "NODE_OFFLINE",
    "NODE_NOT_FOUND",
  ]);
  const PERMANENT_CODES: Record<string, string> = {
    AUTO_START_DISABLED: "auto_start_disabled",
    MAX_SESSIONS_REACHED: "max_sessions_reached",
    LAUNCH_SPEC_BUILD_FAILED: "launch_spec_build_failed",
  };
  const codeOf = (err: unknown): string | null =>
    err instanceof Error && typeof (err as Error & { code?: unknown }).code === "string"
      ? (err as Error & { code: string }).code
      : null;
  return {
    isMachineOffline: (err) => {
      const code = codeOf(err);
      return code !== null && MACHINE_OFFLINE_CODES.has(code);
    },
    classifyPermanentSpawnFailure: (err) => {
      const code = codeOf(err);
      return code !== null ? (PERMANENT_CODES[code] ?? null) : null;
    },
  };
}

/** 构造带 code 的错误（模拟宿主 AppError / OrchestrationError / CoreRuntimeError 的错误码形态） */
export function codedError(code: string, message = "diagnostic detail"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 真实 DocManager 的测试装配（无 Redis：内存模式），并预打开两份 Doc 建立 binding */
export async function createBoundDocs(
  rcsSessionId = "rcs-1",
): Promise<{ docManager: DocManager; chatDoc: Y.Doc; sessionDoc: Y.Doc }> {
  const docManager = new DocManager();
  const chatDoc = (await docManager.openChat(rcsSessionId)).ydoc;
  const sessionDoc = (await docManager.openSession("user-1", "agent-1", rcsSessionId)).ydoc;
  return { docManager, chatDoc, sessionDoc };
}

export type RelayEventsFactory = (
  registry: ConnectionRegistry,
  broadcaster: YjsBroadcaster,
  overrides?: Partial<RelayEventHandlerDependencies>,
) => RelayEventHandler;

/** 构造 RelayEventHandler：默认注入记录型 processNormalizedEvent（真实 DocManager 场景由调用方覆盖） */
export function createRelayEvents(
  registry: ConnectionRegistry,
  broadcaster: YjsBroadcaster,
  processed: string[],
  overrides: Partial<RelayEventHandlerDependencies> = {},
): RelayEventHandler {
  const docManager = {
    processNormalizedEvent: (_sessionId: string, event: { type: string }) => processed.push(event.type),
    openSession: async () => ({ ydoc: new Y.Doc() }),
    // 回放窗口判断需要读取聚合层活动 turn；默认 mock 无 Session Doc 时视为无活动 turn
    getSessionYdoc: () => undefined,
  } as unknown as DocManager;
  return new RelayEventHandler({
    docManager,
    registry,
    broadcaster,
    registerYjsDocListener: () => {},
    reportError: () => {},
    touchInstanceActivity: () => {},
    terminateLocalDeadInstance: () => {},
    ...overrides,
  });
}

export function createGateway(
  registry: ConnectionRegistry,
  broadcaster: YjsBroadcaster,
  relayEvents: RelayEventHandler,
  overrides: Partial<GatewayDependencies> = {},
  docManagerOverrides: Record<string, unknown> = {},
): Gateway {
  const mockDocManager = {
    openChat: async () => ({ ydoc: new Y.Doc() }),
    openSession: async () => ({ ydoc: new Y.Doc() }),
    getSessionYdoc: () => undefined,
    ...docManagerOverrides,
  } as unknown as DocManager;

  const classifier = createSpawnClassifier();
  return new Gateway({
    docManager: mockDocManager,
    registry,
    broadcaster,
    relayEvents,
    sessionChannel: createSessionChannelStub(),
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
    isMachineOffline: classifier.isMachineOffline,
    classifyPermanentSpawnFailure: classifier.classifyPermanentSpawnFailure,
    ...overrides,
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
