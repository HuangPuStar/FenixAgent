// packages/chat-channel/src/channel/gateway.ts
// Gateway：YJS 前端 WebSocket 连接生命周期控制面。
//
// 迁移自 src/transport/relay/yjs-frontend/ws-lifecycle.ts，语义原样保留（Q13：
// YJS sync 握手时序、断线重连、64 KB 背压、YJS_MAX_CLIENTS 配额、rpcId 管理
// 一律不重写；与 19 号文档 10 节的差异记为二期优化项）：
// - handleOpen：认证/授权 → ensureRunning → 共享 relay 获取（并发去重）→
//   Chat Doc / Session Doc 初始快照（relayReady = true 之前）→ connect 握手 →
//   缓冲消息 flush；
// - handleMessage：relayReady 前缓冲；ping/keep_alive 心跳；action 转
//   SessionChannel（commandId 幂等 + 两阶段 Ack）；
// - handleClose：仅释放连接级资源（客户端条目、keepalive 定时器、relay 引用计数），
//   实例 ACP session 存活时重连后由 handleOpen 同步当前实时 Y.Doc（C6 断链语义一）。
//
// 宿主能力全部经依赖注入（环境解析、workspace、ensureRunning、relay 连接、空闲监控、
// spawn 错误分类），包内可用 fake 依赖独立测试（Q12）。

import { translateSimpleAction } from "../protocol/translator";
import type { DocManager } from "../state";
import { createDeterministicRcsSessionId } from "../util/id";
import { flushPendingYjsActions, forwardYjsAction } from "./action-forward";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import { type ClientConnection, REPLAY_WINDOW_MS, type SharedRelay, type WsConnection } from "./connection-types";
import type { RelayEventHandler } from "./relay-event-handler";
import type { SessionChannel, SessionConnection } from "./session-channel";

const KEEPALIVE_INTERVAL = 30_000;
/** 客户端 keepalive 超时：超过此阈值视为页面隐藏，停发服务端心跳并 close 4501（终态，客户端不再自动重连） */
const CLIENT_KEEPALIVE_TIMEOUT = KEEPALIVE_INTERVAL * 2;
/** session/list 轮询间隔（毫秒），用于同步 agent 侧 session 变更（仅保留心跳语义） */
const SESSION_LIST_POLL_INTERVAL = 10_000;
/** 兜底 JSON-RPC id 计数器，当 SharedRelay 不可用时使用 */
let entryRelayNextId = 0;

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
  /** 从 DB session 解析出对应的 instance 编号，用于多实例场景下的精准连接 */
  resolveInstanceNumberFromSession: (sessionId: string) => Promise<number>;
  /** 机器离线判定（宿主注入）：true → close 4500 终态（客户端停止自动重连，展示手动重试 UI） */
  isMachineOffline: (err: unknown) => boolean;
  /** 确定性永久失败分类（宿主注入）：返回诊断码 → close 4502 终态；null → 1011 可重连分支 */
  classifyPermanentSpawnFailure: (err: unknown) => string | null;
}

/** 管理 YJS 前端 WebSocket 的 open/message/close 生命周期。 */
export class Gateway {
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

    // 多实例隔离：从 URL sessionId 解析对应的 instance 编号，确保连到正确的 instance
    let resolvedInstanceNumber: number | undefined;
    if (sessionId) {
      try {
        resolvedInstanceNumber = await this.dependencies.resolveInstanceNumberFromSession(sessionId);
      } catch (err) {
        // 坏 sessionId（历史 session_* 书签、ACP ses_* 混入、实例回收后编号失效）视为可恢复：
        // 忽略该参数按默认路径继续连接，连接建立后由 ACP 层 list_sessions/create_session 重建会话；
        // 不得以 4004 拒绝——4004 不在客户端终态码集合，会触发相同 URL 的无限重连。
        // 4004 仅保留给 env not found（重试相同 URL 永远失败）等不可恢复场景。
        // 错误详情已脱敏（不含 sessionId），只进服务端日志。
        this.reportError("[YJS-FE] Failed to resolve session instance:", err);
      }
    }

    let instanceId: string;
    try {
      instanceId = (await this.dependencies.ensureRunning(userId, agentId, "interactive", resolvedInstanceNumber))
        .instance.id;
    } catch (err) {
      registry.discardPending(wsId);
      this.dependencies.reportError("[YJS-FE] Failed to start agent instance:", err);
      // 机器离线（MACHINE_OFFLINE / AGENT_NODE_UNAVAILABLE / NODE_OFFLINE / NODE_NOT_FOUND）
      // 进入终态：close 4500 使客户端停止自动重连并展示 machine_unavailable 手动重试 UI。
      // 判定逻辑由宿主注入（isMachineOffline）；其余 spawn 失败仍走 1011 通用分支。
      if (this.dependencies.isMachineOffline(err)) {
        broadcaster.sendToYjsWs(ws, {
          type: "error",
          payload: { code: "machine_unavailable", message: "Agent connection error" },
        });
        ws.close(4500, "machine offline");
        return;
      }
      // 配置性永久失败（autoStart 关闭 / maxSessions 上限 / launch spec 构建失败）→ 4502 终态：
      // 重连不改变失败条件，须停止自动重连；具体原因由 payload.code 提供给客户端展示，
      // message 保持脱敏通用文案，不泄漏 envId/machineId/实例编号。
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
          nextRpcId: 0,
          replayWindowUntil: null,
        };
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
        if (!registry.hasStatusReceivedByRcsSession(shared.rcsSessionId)) return;
        try {
          shared.handle.send(
            translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, ++shared.nextRpcId) as never,
          );
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
      // 客户端超时未发送 keep_alive → 关闭连接并由 handleClose 统一释放资源。
      // 4501 在客户端 NO_RECONNECT_CODES 中：页面隐藏导致的超时链接不在后台自动重连，
      // 回到可见时由 UI 触发一次手动重连（C6 可见性恢复语义）。
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

    try {
      const chatDoc = await this.dependencies.docManager.openChat(shared.rcsSessionId);
      broadcaster.sendSnapshot(ws, chatDoc.ydoc, `chat:${shared.rcsSessionId}`);
      // 恢复当前 ACP session：权威值在 Session Doc session.sessionId（binding 反查）
      const sessionYdoc = this.dependencies.docManager.getSessionYdoc(shared.rcsSessionId);
      const sessionInfo = sessionYdoc?.getMap("root").get("session") as { get: (key: string) => unknown } | undefined;
      const sessionId = sessionInfo?.get("sessionId");
      if (typeof sessionId === "string" && sessionId.length > 0) entry.acpSessionId = sessionId;
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to push chat init state:", err);
    }
    try {
      const sessionDoc = await this.dependencies.docManager.openSession(userId, agentId, shared.rcsSessionId);
      // openSession 挂起期间连接可能已被 handleClose 释放（refCount 归零 → closeReleasedRelay
      // 已置 destroyed 并注销）；此刻再注册会产生无注销点的僵尸监听器，守卫必须在 await 之后判断。
      if (!shared.destroyed) {
        broadcaster.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
      }
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

  /**
   * 释放一个 relay 引用；引用计数归零（最后一个前端客户端断开）时执行最终释放：
   * 注销广播监听、释放频道状态（去重表/队列）、关闭 relay handle。
   * 注意：此路径不销毁 Chat Doc / Session Doc——Agent 会话可能仍存活，
   * 重连后 handleOpen 通过 openChat/openSession 同步当前实时 Y.Doc（C6 断链语义一）。
   * Doc 销毁只发生在 relay_closed（实例断链/回收）路径（relay-event-handler）。
   */
  private releaseRelay(instanceId: string, userId: string, rcsSessionId: string): void {
    const released = this.dependencies.registry.release(instanceId, userId, rcsSessionId);
    if (!released) return;
    this.closeReleasedRelay(released);
    if (released.idleMonitorAttached) this.dependencies.markRelayDetached(instanceId);
  }

  private closeReleasedRelay(shared: SharedRelay | undefined): void {
    if (!shared) return;
    shared.destroyed = true;
    // commandId 去重表与频道状态随实例生命周期释放（同一 rcsSessionId 的最后连接关闭）
    this.dependencies.sessionChannel.disposeRcsSession(shared.rcsSessionId);
    if (shared.sessionListTimer) {
      clearInterval(shared.sessionListTimer);
      shared.sessionListTimer = undefined;
    }
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
    try {
      shared.handle.close(1000, "all yjs frontend clients disconnected");
    } catch {
      /* ignore */
    }
  }

  private async forward(entry: ClientConnection, action: Record<string, unknown>, ws: WsConnection): Promise<void> {
    const shared = this.dependencies.registry.getShared(entry.instanceId, entry.userId, entry.rcsSessionId);
    // load/resume 会话会触发 Agent 历史回放，且回放流可能先于 JSON-RPC result 到达
    // （agent 在 loadSession resolve 前推送历史增量）；转发 RPC 前开启回放窗口，
    // 使 relay-event-handler 能投影无头回放增量（JSON-RPC result 分支兜底重置窗口）。
    if (shared && (action.action === "load_session" || action.action === "resume_session")) {
      shared.replayWindowUntil = Date.now() + REPLAY_WINDOW_MS;
    }
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

  /** ClientConnection → 包内 SessionConnection 适配（rpcId 与 relay 发送来自连接/共享 relay） */
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
      lastClientKeepalive: entry.lastClientKeepalive,
      sendToRelay: (message) => entry.relayHandle.send(message as never),
      getNextRpcId: () => (shared ? ++shared.nextRpcId : ++entryRelayNextId),
    };
  }
}
