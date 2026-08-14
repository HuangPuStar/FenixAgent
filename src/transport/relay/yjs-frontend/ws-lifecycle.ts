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
  /**
   * 登记在途会话同步请求（create/load/resume）的 rpcId：响应到达时 relay 的
   * 会话同步 result 分支按 id 校验（JSON-RPC 响应无 method 字段，rename/delete
   * 等其他携带 sessionId 的响应不得劫持该分支）。可选注入，宿主由 forward 提供。
   */
  registerSessionSyncRpcId?: (rpcId: number | string) => void;
  /**
   * 登记在途 prompt 请求（send_prompt）的 rpcId：Agent 子进程死亡时 acp-link 以
   * JSON-RPC error 响应拒绝 prompt，relay 按 id 匹配该登记并收敛 error 事件
   * （防止 loading 永久卡死）。可选注入，宿主由 forward 提供。
   */
  registerPendingPromptId?: (rpcId: number | string) => void;
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

  // send_prompt 出站显式绑定目标 session（服务端权威，浏览器传入值不可信，与 cwd 注入同理）：
  // prompt 不带 sessionId 时 acp-dispatcher fallback 连接级当前会话——多会话共享同一
  // relay 时该值可能已被其他会话的 load/create 改写，prompt 会落到错误会话并被接受，
  // 当前 turn 永远收不到响应（loading 卡死根因）。以服务端绑定的 acpSessionId 为权威目标。
  let outbound = action;
  if (action.action === "send_prompt") {
    outbound = { ...action, sessionId: entry.acpSessionId ?? undefined };
  }
  const rpc = translateSimpleAction(outbound, dependencies.workspacePath, dependencies.getNextRpcId());
  // 会话同步请求登记（create/load/resume）：响应帧只有 id 无 method，relay 的会话
  // 同步 result 分支仅放行登记过的请求；rename/delete 等其他携带 sessionId 的响应
  // 不得劫持该分支（否则 registry 活跃会话被 clobber、绑定校验丢弃当前会话增量）。
  if (action.action === "create_session" || action.action === "load_session" || action.action === "resume_session") {
    dependencies.registerSessionSyncRpcId?.(rpc.id as number | string);
  }
  // prompt 请求登记：Agent 子进程死亡时 acp-link 回 JSON-RPC error（-32000/-32603），
  // relay 按 id 匹配登记收敛 error 事件，否则前端 loading 永久卡死（R1：发送后
  // 完全无输出、仅刷新恢复）。
  if (action.action === "send_prompt") {
    dependencies.registerPendingPromptId?.(rpc.id as number | string);
  }
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
  /**
   * 从 DB session 解析出对应的 instance 编号，用于多实例场景下的精准连接。
   * 返回 undefined 表示会话不匹配任何实例编号（单实例普通会话），调用方降级到默认实例。
   */
  resolveInstanceNumberFromSession: (sessionId: string) => Promise<number | undefined>;
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
      acquired = await registry.acquireRelay(instanceId, userId, resolvedRcsSessionId, async () => {
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
      this.releaseRelay(instanceId, userId, resolvedRcsSessionId);
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
        if (!registry.hasStatusReceivedByRcsSession(shared.rcsSessionId)) {
          // 门禁卡死可观测性：status 未就绪时轮询被跳过且不产生异常，必须显式
          // 计数告警，否则"轮询是否在跑"不可观测。连续 3 次（30s）告警一次，
          // 之后每 30 次（5min）再报一次防刷屏；成功发送时清零。
          shared.sessionListSkipCount = (shared.sessionListSkipCount ?? 0) + 1;
          if (shared.sessionListSkipCount === 3 || shared.sessionListSkipCount % 30 === 0) {
            this.dependencies.reportLog(
              `[YJS-FE] session list poll skipped ${shared.sessionListSkipCount} times (agent status not received): rcsSessionId=${shared.rcsSessionId}`,
            );
          }
          return;
        }
        shared.sessionListSkipCount = 0;
        try {
          shared.handle.send(
            translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, ++shared.nextRpcId) as never,
          );
        } catch (err) {
          // 轮询失败不中断连接，但必须暴露（静默失败会导致 sessions 列表长期缺失更新）
          this.reportError(`[YJS-FE] session list poll failed: rcsSessionId=${shared.rcsSessionId}`, err);
        }
      }, SESSION_LIST_POLL_INTERVAL);
    }

    if (ws.readyState !== 1 || !registry.canPromotePending(wsId, maxClients)) {
      registry.discardPending(wsId);
      this.releaseRelay(instanceId, userId, resolvedRcsSessionId);
      if (ws.readyState === 1) {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "too_many_connections", message: `Max ${maxClients} connections reached` },
        });
        ws.close(1013, "too many connections");
      }
      return;
    }

    const openedAt = Date.now();
    const keepalive = setInterval(() => {
      const entry = registry.getClient(wsId);
      if (entry?.ws.readyState !== 1) {
        clearInterval(keepalive);
        return;
      }
      // 客户端超时未发送 keep_alive → 关闭连接并由 handleClose 统一释放资源
      if (Date.now() - entry.lastClientKeepalive >= CLIENT_KEEPALIVE_TIMEOUT) {
        clearInterval(keepalive);
        entry.ws.close(4501, "client keepalive timeout");
        return;
      }
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
      openTime: openedAt,
      pendingMessages: [],
      relayReady: false,
      agentStatusReceived: false,
      lastClientKeepalive: openedAt,
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
    this.releaseRelay(entry.instanceId, entry.userId, entry.rcsSessionId);
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

  private releaseRelay(instanceId: string, userId: string, rcsSessionId: string): void {
    const released = this.dependencies.registry.release(instanceId, userId, rcsSessionId);
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
    // 在途会话同步请求与 prompt 登记随 relay 释放一并清空，避免残留条目无界增长
    shared.pendingSessionSyncIds?.clear();
    shared.pendingPromptIds?.clear();
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
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId, entry.rcsSessionId);
    await forwardYjsAction(entry, action, {
      workspacePath: entry.workspacePath,
      send: (message) => entry.relayHandle.send(message as never),
      getNextRpcId: () => (shared ? ++shared.nextRpcId : ++entryRelayNextId),
      transition: this.dependencies.transition,
      sendError: (error) => this.dependencies.broadcaster.sendToYjsWs(ws, error),
      reportError: this.dependencies.reportError,
      // 会话同步请求登记到共享 relay：relay-event-handler 的会话同步 result 分支
      // 按 id 校验响应来源（rename/delete 等响应不得劫持），relay 释放时统一清空
      registerSessionSyncRpcId: (rpcId) => {
        if (!shared) return;
        if (!shared.pendingSessionSyncIds) shared.pendingSessionSyncIds = new Set();
        shared.pendingSessionSyncIds.add(rpcId);
      },
      // prompt 请求登记：relay-event-handler 按 id 匹配 JSON-RPC error 响应收敛
      // error 事件（Agent 子进程死亡场景防 loading 永久卡死），relay 释放时统一清空
      registerPendingPromptId: (rpcId) => {
        if (!shared) return;
        if (!shared.pendingPromptIds) shared.pendingPromptIds = new Set();
        shared.pendingPromptIds.add(rpcId);
      },
    });
  }

  private async flushPending(entry: ClientConnection, pending: string[], ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId, entry.rcsSessionId);
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
