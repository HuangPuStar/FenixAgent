import type { DocManager } from "@fenix/acp-server";
import { createDeterministicRcsSessionId, translateSimpleAction } from "@fenix/acp-server";
import { AppError } from "../../../errors";
import type { WsConnection } from "../../ws-types";
import type { ConnectionRegistry } from "./connection-registry";
import type { RelayEventHandler } from "./relay-event-handler";
import { InvalidSessionIdError, type SessionTransition } from "./session-transition";
import type { ClientConnection, SharedRelay } from "./types";
import type { YjsBroadcaster } from "./yjs-broadcaster";

const KEEPALIVE_INTERVAL = 30_000;
/** 客户端 keepalive 超时：超过此阈值视为页面隐藏，停发服务端心跳 */
const CLIENT_KEEPALIVE_TIMEOUT = KEEPALIVE_INTERVAL * 2;
/** session/list 轮询间隔（毫秒），用于同步 agent 侧 session 变更到 Chat Doc */
const SESSION_LIST_POLL_INTERVAL = 10_000;
/** 兜底 JSON-RPC id 计数器，当 SharedRelay 不可用时使用 */
let entryRelayNextId = 0;

export type ForwardYjsActionDependencies = {
  workspacePath: string | null;
  send: (message: Record<string, unknown>) => Promise<void> | void;
  getNextRpcId: () => number;
  transition: Pick<SessionTransition, "beforeForward" | "afterForward">;
  sendError: (data: unknown) => void;
  reportError: (message: string, error: unknown) => void;
};

export async function forwardYjsAction(
  entry: Parameters<SessionTransition["beforeForward"]>[0],
  action: Record<string, unknown>,
  dependencies: ForwardYjsActionDependencies,
): Promise<void> {
  try {
    const shouldForward = await dependencies.transition.beforeForward(entry, action);
    if (!shouldForward) return;
  } catch (err) {
    if (err instanceof InvalidSessionIdError) {
      dependencies.reportError("[YJS-FE] load_session rejected: invalid sessionId", err.sessionId);
      dependencies.sendError({
        type: "error",
        payload: { code: "INVALID_SESSION_ID", message: "load_session requires a valid sessionId" },
      });
      return;
    }
    dependencies.reportError(
      `[YJS-FE] failed to prepare action before relay forward: action=${String(action.action)} rcsSessionId=${entry.rcsSessionId}`,
      err instanceof Error ? err.name : typeof err,
    );
    dependencies.sendError({ type: "error", payload: { message: "Agent connection error" } });
    return;
  }

  const rpc = translateSimpleAction(action, dependencies.workspacePath, dependencies.getNextRpcId());
  try {
    await dependencies.send(rpc);
  } catch (err) {
    dependencies.reportError("[YJS-FE] relay handle send error:", err);
    dependencies.sendError({ type: "error", payload: { message: "Agent connection error" } });
    return;
  }

  dependencies.transition.afterForward(entry, action);
}

export async function flushPendingYjsActions(
  entry: Parameters<SessionTransition["beforeForward"]>[0],
  pending: string[],
  dependencies: ForwardYjsActionDependencies,
): Promise<void> {
  for (const message of pending) {
    try {
      const action = JSON.parse(message) as Record<string, unknown>;
      if (!action.action || action.action === "list_sessions") continue;
      await forwardYjsAction(entry, action, dependencies);
    } catch (err) {
      dependencies.reportError("[YJS-FE] flush message failed:", err);
    }
  }
}

export interface WsLifecycleDependencies {
  registry: ConnectionRegistry;
  broadcaster: YjsBroadcaster;
  relayEvents: RelayEventHandler;
  transition: SessionTransition;
  getEnvironment: (
    agentId: string,
  ) => Promise<{ organizationId?: string | null; machineName?: string | null; userId?: string | null } | undefined>;
  authorizeEnvironment: (
    userId: string,
    environment: { organizationId?: string | null; machineName?: string | null; userId?: string | null },
  ) => boolean;
  resolveWorkspacePath: (orgId: string, userId: string, agentId: string) => string;
  ensureRunning: (
    userId: string,
    agentId: string,
    mode: "interactive",
    instanceNumber?: number,
  ) => Promise<{ instance: { id: string } }>;
  connectAgentRelay: (instanceId: string, rcsSessionId: string) => Promise<SharedRelay["handle"]>;
  docManager: DocManager;
  markRelayAttached: (instanceId: string) => void;
  markRelayDetached: (instanceId: string) => void;
  reportLog: (message: string) => void;
  reportError: (message: string, error: unknown) => void;
  maxClients: () => number;
  /** 从 DB session 解析出对应的 instance 编号，用于多实例场景下的精准连接 */
  resolveInstanceNumberFromSession: (sessionId: string) => Promise<number>;
}

/** 管理 YJS 前端 WebSocket 的 open/message/close 生命周期。 */
export class WsLifecycle {
  constructor(private readonly dependencies: WsLifecycleDependencies) {}

  async handleOpen(
    ws: WsConnection,
    wsId: string,
    userId: string,
    agentId: string,
    rcsSessionId: string | null,
    sessionId?: string,
  ): Promise<void> {
    const { registry, broadcaster } = this.dependencies;
    const maxClients = this.dependencies.maxClients();
    if (!registry.tryCreatePending(wsId, maxClients)) {
      broadcaster.sendToYjsWs(ws, {
        type: "error",
        payload: { code: "too_many_connections", message: `Max ${maxClients} connections reached` },
      });
      ws.close(1013, "too many connections");
      return;
    }

    let environment: Awaited<ReturnType<WsLifecycleDependencies["getEnvironment"]>>;
    try {
      environment = await this.dependencies.getEnvironment(agentId);
    } catch {
      this.rejectOpen(ws, wsId, 1011, "environment lookup failed", "Agent connection error");
      this.reportError("[YJS-FE] Failed to load environment", { agentId });
      return;
    }
    if (!environment) {
      this.rejectOpen(ws, wsId, 4004, "env not found", "Environment not found");
      return;
    }
    if (!this.dependencies.authorizeEnvironment(userId, environment)) {
      this.rejectOpen(ws, wsId, 4003, "unauthorized", "Environment not found");
      return;
    }

    const orgId = environment.organizationId ?? userId;
    const workspacePath = this.dependencies.resolveWorkspacePath(orgId, userId, agentId);

    // 多实例隔离：从 URL sessionId 解析对应的 instance 编号，确保连到正确的 instance
    let resolvedInstanceNumber: number | undefined;
    if (sessionId) {
      try {
        resolvedInstanceNumber = await this.dependencies.resolveInstanceNumberFromSession(sessionId);
      } catch (err) {
        this.rejectOpen(ws, wsId, 4004, "session not found", "Session not found");
        this.reportError("[YJS-FE] Failed to resolve session instance:", err);
        return;
      }
    }

    let instanceId: string;
    try {
      instanceId = (await this.dependencies.ensureRunning(userId, agentId, "interactive", resolvedInstanceNumber))
        .instance.id;
    } catch (err) {
      registry.discardPending(wsId);
      this.dependencies.reportError("[YJS-FE] Failed to start agent instance:", err);
      if (err instanceof AppError && err.code === "IDLE_KILL_COOLDOWN") {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "idle_kill_cooldown", message: `实例处于空闲回收冷却期，${err.message}` },
        });
        ws.close(4001, "idle_kill_cooldown");
        return;
      }
      if (err instanceof AppError && err.code === "MACHINE_OFFLINE") {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "machine_unavailable", message: "Agent connection error" },
        });
        ws.close(4500, "machine offline");
        return;
      }
      broadcaster.sendToYjsWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "spawn failed");
      return;
    }

    if (ws.readyState !== 1) {
      registry.discardPending(wsId);
      return;
    }

    const resolvedRcsSessionId = rcsSessionId ?? createDeterministicRcsSessionId(agentId, userId);
    let acquired: { shared: SharedRelay; created: boolean };
    try {
      acquired = await registry.acquireRelay(instanceId, userId, async () => {
        const handle = await this.dependencies.connectAgentRelay(instanceId, resolvedRcsSessionId);
        const shared: SharedRelay = {
          handle,
          unsubscribe: null,
          refCount: 0,
          userId,
          agentId,
          instanceId,
          rcsSessionId: resolvedRcsSessionId,
          workspacePath,
          nextRpcId: 0,
        };
        const fullHandle = handle as SharedRelay["handle"] & {
          onMessage?: (callback: ReturnType<RelayEventHandler["createMessageHandler"]>) => () => void;
        };
        try {
          if (fullHandle.onMessage)
            shared.unsubscribe = fullHandle.onMessage(this.dependencies.relayEvents.createMessageHandler(shared));
        } catch (err) {
          try {
            handle.close(1000, "relay listener setup failed");
          } catch {
            /* ignore */
          }
          throw err;
        }
        return shared;
      });
    } catch (err) {
      registry.discardPending(wsId);
      this.dependencies.reportError("[YJS-FE] Failed to connect agent relay:", err);
      broadcaster.sendToYjsWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay failed");
      return;
    }

    const { shared } = acquired;
    if (ws.readyState !== 1 || !registry.canPromotePending(wsId, maxClients)) {
      registry.discardPending(wsId);
      this.releaseRelay(instanceId, userId);
      return;
    }

    if (acquired.created) {
      this.dependencies.markRelayAttached(instanceId);
      shared.idleMonitorAttached = true;
      try {
        const chatDoc = await this.dependencies.docManager.openChat(shared.rcsSessionId);
        broadcaster.registerYjsDocListener(chatDoc.ydoc, `chat:${shared.rcsSessionId}`);
        await this.dependencies.docManager.setChatAgentInfo(shared.rcsSessionId, {
          id: agentId,
          name: environment.machineName ?? agentId,
        });
      } catch (err) {
        this.dependencies.reportError("[YJS-FE] Failed to init chat doc:", err);
      }
      // 启动 session/list 定时轮询，同步 agent 侧 session 变更
      shared.sessionListTimer = setInterval(() => {
        if (shared.destroyed) return;
        if (!registry.hasStatusReceivedByUser(shared.agentId, shared.instanceId, shared.userId)) return;
        try {
          shared.handle.send(
            translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, ++shared.nextRpcId) as never,
          );
        } catch {
          /* 轮询失败静默忽略，下个周期重试 */
        }
      }, SESSION_LIST_POLL_INTERVAL);
    }

    if (ws.readyState !== 1 || !registry.canPromotePending(wsId, maxClients)) {
      registry.discardPending(wsId);
      this.releaseRelay(instanceId, userId);
      if (ws.readyState === 1) {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "too_many_connections", message: `Max ${maxClients} connections reached` },
        });
        ws.close(1013, "too many connections");
      }
      return;
    }

    const keepalive = setInterval(() => {
      const entry = registry.getClient(wsId);
      if (entry?.ws.readyState !== 1) {
        clearInterval(keepalive);
        return;
      }
      // 客户端超时未发送 keep_alive → 页面隐藏，跳过服务端心跳
      if (Date.now() - entry.lastClientKeepalive > CLIENT_KEEPALIVE_TIMEOUT) return;
      broadcaster.sendToYjsWs(entry.ws, { type: "keep_alive" });
    }, KEEPALIVE_INTERVAL);
    const entry: ClientConnection = {
      ws,
      userId,
      agentId,
      relayHandle: shared.handle,
      relayUnsub: null,
      keepalive,
      instanceId,
      rcsSessionId: shared.rcsSessionId,
      acpSessionId: null,
      sessionLoaded: false,
      workspacePath: shared.workspacePath,
      openTime: Date.now(),
      pendingMessages: [],
      relayReady: false,
      agentStatusReceived: false,
      lastClientKeepalive: 0,
    };
    registry.addClient(wsId, entry);

    this.dependencies.docManager.setChatConnectionStatus(shared.rcsSessionId, {
      status: "connected",
      since: Date.now(),
    });
    try {
      const chatDoc = await this.dependencies.docManager.openChat(shared.rcsSessionId);
      broadcaster.sendSnapshot(ws, chatDoc.ydoc, `chat:${shared.rcsSessionId}`);
      const activeSessionId = chatDoc.ydoc.getMap("chatMeta").get("activeSessionId") as string | undefined;
      if (activeSessionId) entry.acpSessionId = activeSessionId;
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to push chat init state:", err);
    }
    try {
      const sessionDoc = await this.dependencies.docManager.openSession(userId, agentId, shared.rcsSessionId);
      broadcaster.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
      broadcaster.sendSnapshot(ws, sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to push session init state:", err);
    }

    entry.relayReady = true;

    // 远端 AcpDispatcher 仅在收到 connect 后回传 status。此时 client 已登记且初始快照已发送，
    // 同步回包也能解除 session/list 的状态门禁。
    try {
      await shared.handle.send({ type: "connect" } as never);
    } catch (err) {
      this.reportError("[YJS-FE] relay connect handshake failed:", err);
      broadcaster.sendToYjsWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay handshake failed");
      return;
    }

    const pending = registry.consumePending(wsId);
    if (pending?.length) await this.flushPending(entry, pending, ws);
  }

  async handleMessage(ws: WsConnection, wsId: string, data: string): Promise<void> {
    const entry = this.dependencies.registry.getClient(wsId);
    if (!entry?.relayReady) {
      this.dependencies.registry.bufferPending(wsId, data);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.type === "ping") {
      this.dependencies.broadcaster.sendToYjsWs(ws, { type: "pong" });
      return;
    }
    if (parsed.type === "keep_alive") {
      const entry = this.dependencies.registry.getClient(wsId);
      if (entry) entry.lastClientKeepalive = Date.now();
      return;
    }
    if (parsed.action) await this.forward(entry, parsed, ws);
  }

  handleClose(wsId: string): void {
    const { registry } = this.dependencies;
    registry.discardPending(wsId);
    const entry = registry.removeClient(wsId);
    if (!entry) return;
    clearInterval(entry.keepalive);
    this.releaseRelay(entry.instanceId, entry.userId);
    const duration = Math.round((Date.now() - entry.openTime) / 1000);
    this.dependencies.reportLog(`[YJS-FE] Disconnected: wsId=${wsId} agentId=${entry.agentId} duration=${duration}s`);
  }

  private reportError(message: string, error: unknown): void {
    try {
      this.dependencies.reportError(message, error);
    } catch {
      /* ignore */
    }
  }

  private rejectOpen(ws: WsConnection, wsId: string, closeCode: number, closeReason: string, message: string): void {
    this.dependencies.registry.discardPending(wsId);
    try {
      this.dependencies.broadcaster.sendToYjsWs(ws, { type: "error", payload: { message } });
    } catch {
      /* ignore */
    }
    try {
      ws.close(closeCode, closeReason);
    } catch {
      /* ignore */
    }
  }

  private releaseRelay(instanceId: string, userId: string): void {
    const released = this.dependencies.registry.release(instanceId, userId);
    if (!released) return;
    this.closeReleasedRelay(released);
    if (released.idleMonitorAttached) this.dependencies.markRelayDetached(instanceId);
  }

  private closeReleasedRelay(shared: SharedRelay | undefined): void {
    if (!shared) return;
    shared.destroyed = true;
    if (shared.sessionListTimer) {
      clearInterval(shared.sessionListTimer);
      shared.sessionListTimer = undefined;
    }
    try {
      this.dependencies.broadcaster.unregisterYjsDocListener(`chat:${shared.rcsSessionId}`);
    } catch {
      /* ignore */
    }
    try {
      shared.unsubscribe?.();
    } catch {
      /* ignore */
    }
    try {
      shared.handle.close(1000, "all yjs frontend clients disconnected");
    } catch {
      /* ignore */
    }
  }

  private async forward(entry: ClientConnection, action: Record<string, unknown>, ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId);
    await forwardYjsAction(entry, action, {
      workspacePath: entry.workspacePath,
      send: (message) => entry.relayHandle.send(message as never),
      getNextRpcId: () => (shared ? ++shared.nextRpcId : ++entryRelayNextId),
      transition: this.dependencies.transition,
      sendError: (error) => this.dependencies.broadcaster.sendToYjsWs(ws, error),
      reportError: this.dependencies.reportError,
    });
  }

  private async flushPending(entry: ClientConnection, pending: string[], ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId);
    await flushPendingYjsActions(entry, pending, {
      workspacePath: entry.workspacePath,
      send: (message) => entry.relayHandle.send(message as never),
      getNextRpcId: () => (shared ? ++shared.nextRpcId : ++entryRelayNextId),
      transition: this.dependencies.transition,
      sendError: (error) => this.dependencies.broadcaster.sendToYjsWs(ws, error),
      reportError: this.dependencies.reportError,
    });
  }
}
