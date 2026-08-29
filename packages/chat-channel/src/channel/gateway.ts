// Gateway：YJS 前端 WebSocket 连接生命周期控制面。
import { translateSimpleAction } from "../protocol/translator";
import { decodeYjsSyncFrame } from "../protocol/update-frame";
import type { DocManager } from "../state";
import { createDeterministicRcsSessionId } from "../util/id";
import { flushPendingYjsActions, forwardYjsAction } from "./action-forward";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import {
  abortPendingRpc,
  attachRelayRpcState,
  type ClientConnection,
  getRelayRpcState,
  markPendingRpcSent,
  PROMPT_TIMEOUT_MS,
  type RpcOwnerInput,
  releaseRelayRpcState,
  reserveRelayRpc,
  SESSION_SYNC_TIMEOUT_MS,
  type SharedRelay,
  setPendingRpcTimer,
  type WsConnection,
} from "./connection-types";
import { type PendingInitialSync, synchronizeInitialDocs } from "./gateway-sync";
import type { RelayEventHandler } from "./relay-event-handler";
import type { SessionChannel, SessionConnection } from "./session-channel";

const KEEPALIVE_INTERVAL = 30_000;
/** session/list 轮询间隔（毫秒），用于同步 agent 侧 session 变更（仅保留心跳语义） */
const SESSION_LIST_POLL_INTERVAL = 10_000;
/** 已认证 environment 的最小形状（route 鉴权后注入） */
export interface GatewayEnvironment {
  organizationId?: string | null;
  machineName?: string | null;
  userId?: string | null;
}
export interface GatewayDependencies {
  registry: ConnectionRegistry;
  broadcaster: YjsBroadcaster;
  relayEvents: RelayEventHandler;
  sessionChannel: SessionChannel;
  getEnvironment: (agentId: string) => Promise<GatewayEnvironment | undefined>;
  /** 纵深防御授权：组织环境由 route 的 authContext 决定访问权，个人环境校验 owner */
  authorizeEnvironment: (userId: string, environment: GatewayEnvironment) => boolean;
  resolveWorkspacePath: (orgId: string, userId: string, agentId: string) => string;
  ensureRunning: (
    userId: string,
    agentId: string,
    mode: "interactive",
    instanceNumber?: number,
  ) => Promise<{ instance: { id: string } }>;
  connectAgentRelay: (instanceId: string, rcsSessionId: string) => Promise<ClientConnection["relayHandle"]>;
  docManager: DocManager;
  markRelayAttached: (instanceId: string) => void;
  markRelayDetached: (instanceId: string) => void;
  reportLog: (message: string) => void;
  reportError: (message: string, error: unknown) => void;
  maxClients: () => number;
  /** 从会话标识解析 instance 编号（多实例场景精准连接）；无法解析返回 null，按默认实例降级 */
  resolveInstanceNumberFromSession: (sessionId: string) => Promise<number | null>;
  /** 机器离线判定（宿主注入）：true → close 4500 终态（客户端停止自动重连，展示手动重试 UI） */
  isMachineOffline: (err: unknown) => boolean;
  /** 确定性永久失败分类（宿主注入）：返回诊断码 → close 4502 终态；null → 1011 可重连分支 */
  classifyPermanentSpawnFailure: (err: unknown) => string | null;
}
/** 管理 YJS 前端 WebSocket 的 open/message/close 生命周期。 */
export class Gateway {
  private readonly pendingInitialSync = new Map<string, PendingInitialSync>();
  constructor(private readonly dependencies: GatewayDependencies) {}
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
    let environment: Awaited<ReturnType<GatewayDependencies["getEnvironment"]>>;
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
    const resolvedInstanceNumber = sessionId
      ? await this.dependencies.resolveInstanceNumberFromSession(sessionId).catch((err) => {
          this.reportError("[YJS-FE] Failed to resolve session instance:", err);
          return null;
        })
      : null;
    let instanceId: string;
    try {
      instanceId = (
        await this.dependencies.ensureRunning(userId, agentId, "interactive", resolvedInstanceNumber ?? undefined)
      ).instance.id;
    } catch (err) {
      registry.discardPending(wsId);
      this.dependencies.reportError("[YJS-FE] Failed to start agent instance:", err);
      if (this.dependencies.isMachineOffline(err)) {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "machine_unavailable", message: "Agent connection error" },
        });
        ws.close(4500, "machine offline");
        return;
      }
      const permanentCode = this.dependencies.classifyPermanentSpawnFailure(err);
      if (permanentCode) {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: permanentCode, message: "Agent connection error" },
        });
        ws.close(4502, "spawn rejected");
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
          replayWindowUntil: null,
        };
        attachRelayRpcState(shared);
        const fullHandle = handle as ClientConnection["relayHandle"] & {
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
      this.dependencies.relayEvents.bindInstanceSession(instanceId, resolvedRcsSessionId);
      try {
        // 时间线 Doc 在首个客户端连接时打开并广播（Agent 元信息经 status 消息投影到 Session Doc）
        const chatDoc = await this.dependencies.docManager.openChat(shared.rcsSessionId);
        broadcaster.registerYjsDocListener(chatDoc.ydoc, `chat:${shared.rcsSessionId}`);
      } catch (err) {
        this.dependencies.reportError("[YJS-FE] Failed to init chat doc:", err);
      }
      // 启动 session/list 定时轮询，同步 agent 侧 session 变更
      shared.sessionListTimer = setInterval(() => {
        if (shared.destroyed) return;
        if (!registry.hasStatusReceivedByRcsSession(shared.rcsSessionId)) {
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
          const request = this.reserveRpc(shared, { kind: "session-list" });
          shared.handle.send(
            translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, request.id) as never,
          );
          markPendingRpcSent(request);
        } catch (err) {
          // 轮询失败不中断连接，但必须暴露（静默失败会导致 sessions map 长期缺失更新）
          this.dependencies.reportError(`[YJS-FE] session list poll failed: rcsSessionId=${shared.rcsSessionId}`, err);
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
      // 服务端心跳仅用于维持代理层连接；客户端暂停 keep_alive（如页面冻结）不再主动关闭。
      broadcaster.sendToYjsWs(entry.ws, { type: "keep_alive" });
    }, KEEPALIVE_INTERVAL);
    const entry: ClientConnection = {
      ws,
      userId,
      agentId,
      relayHandle: shared.handle,
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
    };
    registry.addClient(wsId, entry);
    let chatDoc: Awaited<ReturnType<DocManager["openChat"]>>;
    let sessionDoc: Awaited<ReturnType<DocManager["openSession"]>>;
    try {
      [chatDoc, sessionDoc] = await Promise.all([
        this.dependencies.docManager.openChat(shared.rcsSessionId),
        this.dependencies.docManager.openSession(userId, agentId, shared.rcsSessionId),
      ]);
      if (chatDoc.generation !== sessionDoc.generation) {
        throw new Error("chat/session projection generation mismatch");
      }
      if (!shared.destroyed) {
        broadcaster.registerYjsDocListener(chatDoc.ydoc, `chat:${shared.rcsSessionId}`, chatDoc.generation);
        broadcaster.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`, sessionDoc.generation);
      }
      const sessionInfo = sessionDoc.ydoc.getMap("root").get("session") as
        | { get: (key: string) => unknown }
        | undefined;
      const activeSessionId = sessionInfo?.get("sessionId");
      if (typeof activeSessionId === "string" && activeSessionId.length > 0) entry.acpSessionId = activeSessionId;
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to initialize Yjs docs:", err);
      ws.close(1011, "yjs initialization failed");
      return;
    }
    await synchronizeInitialDocs(
      this.pendingInitialSync,
      broadcaster,
      ws,
      wsId,
      shared.rcsSessionId,
      chatDoc,
      sessionDoc,
    );
    // connect 成功是 relayReady 的提交点；此前文本 action 始终留在有界 pending queue。
    try {
      await shared.handle.send({ type: "connect" } as never);
    } catch (err) {
      this.reportError("[YJS-FE] relay connect handshake failed:", err);
      broadcaster.sendToYjsWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay handshake failed");
      return;
    }
    entry.relayReady = true;
    const pending = registry.consumePending(wsId);
    if (pending?.length) await this.flushPending(entry, pending, ws);
  }
  async handleMessage(ws: WsConnection, wsId: string, data: string | Uint8Array): Promise<void> {
    const entry = this.dependencies.registry.getClient(wsId);
    if (typeof data !== "string") {
      const frame = decodeYjsSyncFrame(data);
      if (!entry || frame?.type !== "state-vector") return;
      const prefix = frame.docName.split(":", 1)[0];
      const expectedName = `${prefix}:${entry.rcsSessionId}`;
      if (frame.docName !== expectedName) return;
      const doc =
        prefix === "chat"
          ? this.dependencies.docManager.getChat(entry.rcsSessionId)
          : this.dependencies.docManager.getSession(entry.rcsSessionId);
      if (!doc || doc.generation !== frame.generation) return;
      this.dependencies.broadcaster.sendDiff(ws, doc.ydoc, frame.docName, frame.generation, frame.stateVector);
      const pendingSync = this.pendingInitialSync.get(wsId);
      if (pendingSync?.expected.has(frame.docName)) {
        pendingSync.received.add(frame.docName);
        if (pendingSync.received.size === pendingSync.expected.size) pendingSync.resolve();
      }
      return;
    }
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
    if (parsed.type === "keep_alive") return;
    if (parsed.action) await this.forward(entry, parsed, ws);
  }
  /** graceful shutdown：先请求关闭 WS，再按快照中的 wsId 强制走正常引用释放并等待候选回滚。 */
  async closeAll(code = 1001, reason = "server_shutdown"): Promise<void> {
    const wsIds: string[] = [];
    this.dependencies.registry.forEachClientEntry((wsId) => wsIds.push(wsId));
    this.dependencies.registry.requestCloseAllClients(code, reason);
    const cleanups = wsIds.map((wsId) => this.handleClose(wsId)).filter((cleanup) => cleanup !== undefined);
    await Promise.allSettled(cleanups);
  }

  handleClose(wsId: string): Promise<void> | undefined {
    this.pendingInitialSync.get(wsId)?.resolve();
    const { registry } = this.dependencies;
    registry.discardPending(wsId);
    const entry = registry.removeClient(wsId);
    if (!entry) return;
    clearInterval(entry.keepalive);
    const cleanup = this.releaseRelay(entry.instanceId, entry.userId, entry.rcsSessionId);
    const duration = Math.round((Date.now() - entry.openTime) / 1000);
    this.dependencies.reportLog(`[YJS-FE] Disconnected: wsId=${wsId} agentId=${entry.agentId} duration=${duration}s`);
    return cleanup;
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
  private releaseRelay(instanceId: string, userId: string, rcsSessionId: string): Promise<void> | undefined {
    const released = this.dependencies.registry.release(instanceId, userId, rcsSessionId);
    if (!released) return;
    const cleanup = this.closeReleasedRelay(released);
    if (released.idleMonitorAttached) this.dependencies.markRelayDetached(instanceId);
    return cleanup;
  }
  private closeReleasedRelay(shared: SharedRelay | undefined): Promise<void> | undefined {
    if (!shared) return;
    shared.destroyed = true;
    const release = releaseRelayRpcState(shared);
    // 在任何 await 前 owner 已被剥夺、epoch 已在最后一个包装释放时推进；graceful
    // shutdown 会等待该 Promise，普通断链调用方可忽略返回值而保持既有同步入口。
    shared.teardownPromise = release.cleanup.catch((err) => {
      this.dependencies.reportError(
        `[YJS-FE] pending request teardown failed: rcsSessionId=${shared.rcsSessionId}`,
        err,
      );
    });
    this.dependencies.sessionChannel.disposeRcsSession(shared.rcsSessionId);
    if (shared.sessionListTimer) {
      clearInterval(shared.sessionListTimer);
      shared.sessionListTimer = undefined;
    }
    // 回放窗口定时器一并清理（同泄漏语义），窗口判定缓存随之重置
    if (shared.replayWindowTimer) {
      clearTimeout(shared.replayWindowTimer);
      shared.replayWindowTimer = null;
    }
    shared.replayWindowOwner = null;
    shared.replaySkipSynthesis = undefined;
    try {
      this.dependencies.broadcaster.unregisterYjsDocListener(`chat:${shared.rcsSessionId}`);
      // session: 监听器由 handleOpen 与 relay-event-handler 按 docName 注册，
      // 必须与 chat: 一起在 relay 释放时注销；否则 registeredDocs 条目与 Y.Doc 上的
      // update 闭包互相强引用、永不回收，长期运行内存增长（审计 B-P2.3）。
      this.dependencies.broadcaster.unregisterYjsDocListener(`session:${shared.rcsSessionId}`);
    } catch {
      /* ignore */
    }
    try {
      shared.unsubscribe?.();
    } catch {
      /* ignore */
    }
    if (release.shouldCloseHandle) {
      try {
        shared.handle.close(1000, "all yjs frontend clients disconnected");
      } catch {
        /* ignore */
      }
    }
    return shared.teardownPromise;
  }
  private async forward(entry: ClientConnection, action: Record<string, unknown>, ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId, entry.rcsSessionId);
    await forwardYjsAction(this.toSessionConnection(entry, shared), action, {
      sessionChannel: this.dependencies.sessionChannel,
      sendAck: (ack) => this.dependencies.broadcaster.sendToYjsWs(ws, ack),
      sendError: (error) => this.dependencies.broadcaster.sendToYjsWs(ws, error),
      reportError: this.dependencies.reportError,
    });
  }
  private async flushPending(entry: ClientConnection, pending: string[], ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId, entry.rcsSessionId);
    await flushPendingYjsActions(this.toSessionConnection(entry, shared), pending, {
      sessionChannel: this.dependencies.sessionChannel,
      sendAck: (ack) => this.dependencies.broadcaster.sendToYjsWs(ws, ack),
      sendError: (error) => this.dependencies.broadcaster.sendToYjsWs(ws, error),
      reportError: this.dependencies.reportError,
    });
  }
  /** ClientConnection → SessionConnection；请求 owner 通过共享 relay 原子预留。 */
  private toSessionConnection(entry: ClientConnection, shared: SharedRelay | undefined): SessionConnection {
    return {
      userId: entry.userId,
      agentId: entry.agentId,
      instanceId: entry.instanceId,
      rcsSessionId: entry.rcsSessionId,
      acpSessionId: entry.acpSessionId,
      agentStatusReceived: entry.agentStatusReceived,
      sessionLoaded: entry.sessionLoaded,
      workspacePath: entry.workspacePath,
      sendToRelay: (message) => entry.relayHandle.send(message as never),
      reserveRpc: (owner) => {
        if (!shared) throw new Error("Shared relay is not available");
        const request = this.reserveRpc(shared, owner);
        return {
          id: request.id,
          markSent: () => markPendingRpcSent(request),
          abort: () => abortPendingRpc(request),
        };
      },
    };
  }

  /** 原子预留后按 owner 类型安装请求专属 timeout。 */
  private reserveRpc(shared: SharedRelay, owner: RpcOwnerInput) {
    const request = reserveRelayRpc(shared, owner);
    if (owner.kind === "prompt") {
      const schedule = () => {
        const state = getRelayRpcState(shared);
        if (state.pendingRpcRequests.get(request.id) !== request) return;
        const elapsed = Date.now() - (shared.lastInboundAt ?? 0);
        const delay = Math.max(PROMPT_TIMEOUT_MS - elapsed, 1);
        setPendingRpcTimer(
          request,
          setTimeout(() => {
            if (getRelayRpcState(shared).pendingRpcRequests.get(request.id) !== request) return;
            if (Date.now() - (shared.lastInboundAt ?? 0) < PROMPT_TIMEOUT_MS) {
              schedule();
              return;
            }
            this.dependencies.relayEvents.convergeStuckPrompt(shared, request);
          }, delay),
        );
      };
      schedule();
    } else if (owner.kind === "session-sync") {
      setPendingRpcTimer(
        request,
        setTimeout(() => {
          if (getRelayRpcState(shared).pendingRpcRequests.get(request.id) !== request) return;
          this.dependencies.relayEvents.abortSessionSync(shared, request, "timeout");
        }, SESSION_SYNC_TIMEOUT_MS),
      );
    }
    return request;
  }
}
