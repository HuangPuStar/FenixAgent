// packages/chat-channel/src/channel/session-channel.ts
// SessionChannel：连接绑定至会话频道，路由 Action 至 CommandCoordinator。
//
// 职责（文档 2.3）：
// - 将前端 Action（旧 {action, ...} 形态 + commandId）归一化为服务端 Command；
// - 承载会话守卫语义（迁移自原 yjs-frontend/session-transition.ts，语义原样保留）：
//   load_session 需合法 sessionId、Agent status 到达前不发 list_sessions、
//   cwd 由服务端根据已认证 environment 注入（浏览器不可覆盖）；
// - 执行命令的业务效果（Doc 清理 / 用户消息写入 / relay 转发 / 取消终态标记），
//   并通过注入的 sinks 把 Ack / Error 发送给发起连接。
//
// 本类不直接 import 任何宿主服务；宿主能力（Redis 快照、多标签页同步、relay 发送）
// 全部经依赖注入，保证包内可用 fake 依赖独立测试（Q12）。

import { translateSimpleAction } from "../protocol/translator";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_QUESTION_TIMEOUT_MS,
  type NormalizedEvent,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
} from "../schema";
import { bumpProjectionVersion, getSessionInfo } from "../state/chat-writer";
import type { DocManager } from "../state/doc-manager";
import { applyPermissionExpiration, applyPermissionResolution } from "../state/permission";
import { expireQuestion, respondQuestion } from "../state/question";
import type { ProjectionDocs, ProjectionReplacement, RegisterProjectionRollback } from "../types";
import { CommandCoordinator } from "./command-coordinator";
import {
  type RpcOwnerInput,
  type RpcReservation,
  SESSION_TRANSITION_BYTE_LIMIT,
  SESSION_TRANSITION_EVENT_LIMIT,
  type SessionSyncRequestLifecycle,
} from "./connection-types";
import { type ActionSinks, type Command, CommandExecutionError, type CommandOutcome } from "./types";

/** 取消超时兜底（毫秒）：cancel 后 Agent 未确认（进程挂起/断连）时 turn 收敛为 interrupted */
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

/** 撤销仍在途的请求登记；返回 true 表示本次调用实际消费了该请求所有权。 */
export type PendingRequestRollback = () => Promise<boolean> | boolean;

/** 连接在会话频道上的绑定上下文（多标签页共享同一 rcsSessionId 的频道状态） */
export interface SessionConnection {
  userId: string;
  agentId: string;
  instanceId: string;
  rcsSessionId: string;
  acpSessionId: string | null;
  /** Agent status 是否已到达（确认 ACP 初始化完成，list_sessions 守卫） */
  agentStatusReceived: boolean;
  /** 是否已执行过至少一次 load_session（区分重连首次加载 vs 后续正常切换） */
  sessionLoaded: boolean;
  workspacePath: string | null;
  /** 发送 RPC 到 relay（测试中为记录型 fake） */
  sendToRelay: (message: Record<string, unknown>) => Promise<void> | void;
  /**
   * 在同一同步操作中分配 JSON-RPC id 并登记不可变 owner。失败必须抛错，调用方
   * 随后不会发送请求；返回的 reservation 只可结算自身 owner。
   */
  reserveRpc: (owner: RpcOwnerInput) => RpcReservation;
}

export interface SessionChannelDependencies {
  docManager: DocManager;
  /** 新 ACP session 创建前刷新当前实例的 workspace 配置与 Skills。 */
  refreshInstanceEnvironment?: (connection: SessionConnection) => Promise<void>;
  /** 仅供滚动升级期间兼容旧装配；projection replacement 不再调用。 */
  prepareClearSessionSnapshot?: (connection: SessionConnection) => Promise<void>;
  /** 原子重绑 broadcaster 并广播 next；实现必须在副作用前登记 previous 的恢复。 */
  replaceProjection: (
    next: ProjectionDocs,
    previous: ProjectionDocs | null,
    registerRollback: RegisterProjectionRollback,
  ) => void;
  /** 会话切换后同步同一 RCS 会话所有客户端的 ACP binding，并在写入前登记精确恢复。 */
  syncSessionId: (
    connection: SessionConnection,
    newSessionId: string | null,
    sessionLoaded: boolean,
    registerRollback?: RegisterProjectionRollback,
  ) => void;
  reportError: (message: string, error: unknown) => void;
  /** 公开错误安全事件 sink；不得记录原始异常或 Action payload。 */
  reportLog?: (message: string) => void;
  /** 每 rcsSessionId 有界队列上限（透传给 CommandCoordinator） */
  maxPendingPerSession?: number;
  /** 取消超时（毫秒）：cancel 后 Agent 未确认时 turn 收敛为 interrupted，默认 10s */
  cancelTimeoutMs?: number;
  /** 权限请求超时（毫秒）：超过 expiresAt 未响应时迁移 pending → expired，默认 5min */
  permissionTimeoutMs?: number;
}

export class SessionChannel {
  private readonly coordinator: CommandCoordinator;
  /** 频道级连接上下文：同一 rcsSessionId 的命令串行执行时取最新连接的绑定状态 */
  private readonly activeConnections = new Map<string, SessionConnection>();
  /** 取消超时定时器（每 rcsSessionId 至多一个：单活动 turn 保证），随实例生命周期释放 */
  private readonly cancelTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; rollback?: PendingRequestRollback }
  >();
  /** 权限过期定时器（rcsSessionId → permissionId → timer），disposeRcsSession 时全部释放 */
  private readonly permissionTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  /** AskUserQuestion 过期定时器（rcsSessionId → questionId → timer），disposeRcsSession 时全部释放 */
  private readonly questionTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(private readonly dependencies: SessionChannelDependencies) {
    this.coordinator = new CommandCoordinator({
      executeCommand: (command) => this.executeCommand(command),
      validateAction: (command) => this.validateAction(command),
      getProjectionVersion: (rcsSessionId) => this.getProjectionVersion(rcsSessionId),
      maxPendingPerSession: dependencies.maxPendingPerSession,
      reportError: dependencies.reportError,
      reportLog: dependencies.reportLog,
    });
    // 权限请求投影成功 → 安排超时迁移（控制面持有定时器；聚合层保持纯投影无 I/O）。
    // 单槽位装配：DocManager 为单例，同一实例只应有一个控制面绑定。
    dependencies.docManager.setPermissionRequestedHandler((rcsSessionId, permission) => {
      this.armPermissionExpiry(rcsSessionId, permission.permissionId, permission.expiresAt);
    });
    // AskUserQuestion 问题投影成功 → 安排 60s 超时迁移（与权限定时器同模式：
    // acp-link 侧 60s 自动 resolve 空答案，投影必须同步失效否则前端弹窗悬挂）。
    dependencies.docManager.setQuestionRequestedHandler((rcsSessionId, question) => {
      this.armQuestionExpiry(rcsSessionId, question.questionId, question.expiresAt);
    });
  }

  /**
   * 处理来自连接的一条 Action：归一化 + 幂等 + 串行化 + 两阶段 Ack。
   * sinks 绑定发起连接（多标签页下 Ack 只回给发起者）。
   */
  async handleAction(
    connection: SessionConnection,
    rawAction: Record<string, unknown>,
    sinks: ActionSinks,
  ): Promise<void> {
    this.activeConnections.set(connection.rcsSessionId, connection);
    const command = this.normalizeAction(connection, rawAction);
    await this.coordinator.submit(command, sinks);
  }

  /** 释放 rcsSessionId 的频道状态（去重表 / 队列 / 连接绑定 / 取消定时器 / 权限定时器），随实例生命周期调用 */
  disposeRcsSession(rcsSessionId: string): void {
    const pendingCancel = this.cancelTimers.get(rcsSessionId);
    if (pendingCancel) {
      clearTimeout(pendingCancel.timer);
      void pendingCancel.rollback?.();
      this.cancelTimers.delete(rcsSessionId);
    }
    const permTimers = this.permissionTimers.get(rcsSessionId);
    if (permTimers) {
      for (const t of permTimers.values()) clearTimeout(t);
      this.permissionTimers.delete(rcsSessionId);
    }
    const questionTimers = this.questionTimers.get(rcsSessionId);
    if (questionTimers) {
      for (const t of questionTimers.values()) clearTimeout(t);
      this.questionTimers.delete(rcsSessionId);
    }
    this.activeConnections.delete(rcsSessionId);
    this.coordinator.disposeRcsSession(rcsSessionId);
  }

  // ── Action 归一化 ──

  /** 旧协议 {action, ...} → 服务端 Command（信封字段由服务端按会话绑定补充） */
  private normalizeAction(connection: SessionConnection, rawAction: Record<string, unknown>): Command {
    const { action, commandId, expectedProjectionVersion, ...rest } = rawAction;
    // protocolVersion / client 在协议类型中保留定义，二期校验；从 payload 剔除避免污染业务字段
    const { protocolVersion, client, ...payload } = rest;
    void protocolVersion;
    void client;
    return {
      rcsSessionId: connection.rcsSessionId,
      commandId: typeof commandId === "string" ? commandId : "",
      type: typeof action === "string" ? action : "",
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : (connection.acpSessionId ?? ""),
      payload,
      ...(typeof expectedProjectionVersion === "number" ? { expectedProjectionVersion } : {}),
    };
  }

  // ── CommandCoordinator 注入 ──

  /** Action 上下文校验：会话存在性 + load_session payload 结构（失败不发 accepted） */
  private validateAction(command: Command): void {
    // 会话存在性以 docManager 内存 Doc 为准（频道已建立 = 实例会话存活），
    // 仅注册过连接不构成会话（disposeRcsSession 后同 ID 重发必须拒绝）。
    if (
      !this.activeConnections.has(command.rcsSessionId) ||
      !this.dependencies.docManager.getChatYdoc(command.rcsSessionId)
    ) {
      throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
    }
    if (command.type === "load_session") {
      const sessionId = command.payload.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new CommandExecutionError("ACTION.INVALID_STATE");
      }
    }
  }

  private getProjectionVersion(rcsSessionId: string): number | null {
    const ydoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    if (!ydoc) return null;
    const version = ydoc.getMap("root").get("projectionVersion");
    return typeof version === "number" ? version : null;
  }

  // ── 命令执行（守卫语义迁移自 session-transition.ts）──

  private async executeCommand(command: Command): Promise<CommandOutcome> {
    const connection = this.activeConnections.get(command.rcsSessionId);
    if (!connection) throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");

    const { docManager } = this.dependencies;

    if (command.type === "list_sessions") {
      // 守卫：Agent status 到达前不发 list_sessions（ACP 初始化未完成时列表不可信）。
      // 静默跳过而非报错：status 未到是连接建立瞬间的正常竞态，前端无需感知。
      if (!connection.agentStatusReceived) return {};
    }

    let sessionSyncLifecycle: SessionSyncRequestLifecycle | undefined;
    if (command.type === "load_session" || command.type === "resume_session") {
      sessionSyncLifecycle =
        (await this.prepareExistingSession(connection, command.payload.sessionId, command.type === "load_session")) ??
        undefined;
      if (!sessionSyncLifecycle) return {};
    }

    if (command.type === "create_session") {
      sessionSyncLifecycle = await this.prepareCreateSession(connection);
    }

    let turnId: string | undefined;
    let cancelTurnId: string | undefined;
    if (command.type === "send_prompt") {
      turnId = await this.writePromptText(connection, command.payload.content);
      // 出站显式绑定目标 session（服务端权威，浏览器传入值不可信，与 cwd 注入同理）：
      // prompt 不带 sessionId 时 acp-dispatcher fallback 连接级当前会话——多会话共享
      // 同一 relay 时该值可能已被其他会话的 load/create 改写，prompt 会落到错误会话
      // 并被接受，当前 turn 永远收不到响应（loading 卡死根因）。以服务端绑定的
      // acpSessionId（load/create 后 syncSessionId 更新）为权威目标。
      command.payload = {
        ...command.payload,
        sessionId: connection.acpSessionId ?? undefined,
      };
    } else if (command.type === "cancel") {
      // 取消目标只能来自服务端连接绑定；浏览器 payload 中的 sessionId 不可信，
      // 否则可跨会话取消同一 relay 上的其他 query。
      command.payload = {
        ...command.payload,
        sessionId: connection.acpSessionId ?? undefined,
      };
      const sessionDoc = docManager.getSessionYdoc(connection.rcsSessionId);
      const sessionInfo = sessionDoc ? getSessionInfo(sessionDoc) : null;
      const activeTurnId = sessionInfo?.get("activeTurnId");
      const activeTurnStatus = sessionInfo?.get("activeTurnStatus") as TurnStatus | null | undefined;
      if (
        typeof activeTurnId === "string" &&
        activeTurnId.length > 0 &&
        activeTurnStatus &&
        !TURN_TERMINAL_STATUSES.has(activeTurnStatus)
      ) {
        cancelTurnId = activeTurnId;
      }
    }

    if (command.type === "respond_permission") {
      // C5 权限 CAS：仅 pending → resolved 迁移一次，迁移成功才向 Agent 发送
      // permission.resolve（JSON-RPC 响应，translator 构造）。重复响应
      // （已 resolved / expired / 不存在）不发 RPC、返回幂等成功——
      // 防止重复授权导致 Agent 执行两遍。
      if (!this.resolvePermissionViaCas(connection, command.payload)) return {};
    }

    if (command.type === "respond_question") {
      // AskUserQuestion CAS：仅 pending → resolved 迁移一次，迁移成功才向 Agent 发送
      // control_response 帧（translator 构造，非 JSON-RPC）。重复响应不发帧、
      // 返回幂等成功——防止 Agent 收到两份答案重复执行。
      if (!this.respondQuestionViaCas(connection, command.payload)) return {};
    }

    // permission response 与 question control_response 都是单向控制帧：Agent 不会再回
    // 一个可匹配的 JSON-RPC response，因此不得在 canonical owner 表中登记悬挂请求。
    if (command.type === "respond_permission" || command.type === "respond_question") {
      let controlFrame: Record<string, unknown>;
      try {
        controlFrame = translateSimpleAction(toLegacyAction(command), connection.workspacePath, 0);
      } catch (err) {
        this.dependencies.reportError(`[SessionChannel] control translation failed: action=${command.type}`, err);
        throw new CommandExecutionError("ACTION.INVALID_STATE");
      }
      try {
        await connection.sendToRelay(controlFrame);
      } catch (err) {
        this.dependencies.reportError(`[SessionChannel] relay send failed: action=${command.type}`, err);
        throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
      }
      return {};
    }

    // owner 必须先冻结并原子预留，translator 或 reservation 失败时不得发送。
    let owner: RpcOwnerInput;
    if (sessionSyncLifecycle) {
      owner = { kind: "session-sync", lifecycle: sessionSyncLifecycle };
    } else if (command.type === "send_prompt") {
      owner = { kind: "prompt", turnId: turnId ?? null };
    } else if (command.type === "cancel") {
      owner = { kind: "cancel", turnId: cancelTurnId ?? null };
    } else if (command.type === "list_sessions") {
      owner = { kind: "session-list" };
    } else {
      owner = { kind: "generic", method: command.type };
    }

    let reservation: RpcReservation;
    try {
      reservation = connection.reserveRpc(owner);
    } catch (err) {
      if (sessionSyncLifecycle) await sessionSyncLifecycle.rollback();
      if (command.type === "send_prompt" && turnId) {
        docManager.processNormalizedEvent(connection.rcsSessionId, {
          type: "turn_failed",
          update: { error: "Agent request failed" },
          content: null,
          turnId,
        });
      }
      this.dependencies.reportError(`[SessionChannel] RPC reservation failed: action=${command.type}`, err);
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
    }

    let rpc: Record<string, unknown>;
    try {
      rpc = translateSimpleAction(toLegacyAction(command), connection.workspacePath, reservation.id);
    } catch (err) {
      await reservation.abort();
      this.dependencies.reportError(`[SessionChannel] RPC translation failed: action=${command.type}`, err);
      throw new CommandExecutionError("ACTION.INVALID_STATE");
    }

    try {
      await connection.sendToRelay(rpc);
      reservation.markSent();
    } catch (err) {
      const ownedByFailedSend = await reservation.abort();
      if (command.type === "send_prompt" && turnId && ownedByFailedSend) {
        docManager.processNormalizedEvent(connection.rcsSessionId, {
          type: "turn_failed",
          update: { error: "Agent request failed" },
          content: null,
          turnId,
        });
      }
      this.dependencies.reportError(`[SessionChannel] relay send failed: action=${command.type}`, err);
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
    }

    const rollbackPendingRequest: PendingRequestRollback = () => reservation.abort();

    if (command.type === "cancel") {
      // 取消流程无条件进入状态机（聚合层权威）：turn → cancelling（非终态），晚到增量自此丢弃。
      // - acpSessionId 非空：正常路径，Agent 确认（turn_cancelled）或取消超时（turn_interrupted）收敛终态；
      // - acpSessionId 为 null（session/new 的 RPC 往返尚未完成）：Agent 回 {cancelled:false}
      //   且无任何终态事件，必须 arm 取消超时兜底，否则 turn 永久卡 accepting（loading 卡死）。
      docManager.processNormalizedEvent(connection.rcsSessionId, {
        type: "turn_cancel_requested",
        update: {},
        content: null,
      });
      this.armCancelTimeout(connection.rcsSessionId, rollbackPendingRequest);
    }

    return { turnId };
  }

  /**
   * 启动取消超时兜底：Agent 长时间未确认取消（进程挂起/断连）时 turn 收敛为 interrupted，
   * 不能停留在 cancelling 中间态。回调校验 activeTurn 仍是发起取消时的 turn 且仍处
   * cancelling——用户可能已发起新 turn（旧 turn 被终结）或 Agent 已确认终态，
   * 此时不得误中断当前 turn。
   */
  private armCancelTimeout(rcsSessionId: string, rollback?: PendingRequestRollback): void {
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    const turnId = sessionDoc ? (getSessionInfo(sessionDoc).get("activeTurnId") as string | null) : null;
    if (!turnId) {
      void rollback?.();
      return;
    }

    const previous = this.cancelTimers.get(rcsSessionId);
    if (previous) {
      clearTimeout(previous.timer);
      void previous.rollback?.();
    }
    const timer = setTimeout(() => {
      this.cancelTimers.delete(rcsSessionId);
      // 超时即消费 cancel 请求所有权；迟到 ACK 随后会因无登记而被忽略。
      void rollback?.();
      const current = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
      const info = current ? getSessionInfo(current) : null;
      if (!info) return;
      if (info.get("activeTurnId") !== turnId || info.get("activeTurnStatus") !== "cancelling") return;
      this.dependencies.docManager.processNormalizedEvent(rcsSessionId, {
        type: "turn_interrupted",
        update: {},
        content: null,
        turnId,
      });
    }, this.dependencies.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS);
    this.cancelTimers.set(rcsSessionId, { timer, rollback });
  }

  /**
   * load/resume 守卫与准备：目标必须合法；load 同会话或权威本地投影可静默跳过。
   * 其余路径先激活可回滚的新 projection 与服务端 binding，确保 result 前历史更新有落点。
   */
  private async prepareExistingSession(
    connection: SessionConnection,
    sessionId: unknown,
    allowSkip: boolean,
  ): Promise<SessionSyncRequestLifecycle | null> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new CommandExecutionError("ACTION.INVALID_STATE");
    }

    if (allowSkip && connection.acpSessionId === sessionId) {
      connection.acpSessionId = sessionId;
      return null;
    }

    // Redis 或内存中已有目标会话的投影时，首次恢复只绑定会话，不再请求 Agent 全量回放。
    // 时间线非空本身不能证明它属于当前点击的目标，必须同时校验 Session Doc binding。
    const currentSessionDoc = this.dependencies.docManager.getSessionYdoc(connection.rcsSessionId);
    const currentProjectionSessionId = currentSessionDoc ? getSessionInfo(currentSessionDoc).get("sessionId") : null;
    if (
      allowSkip &&
      !connection.sessionLoaded &&
      currentProjectionSessionId === sessionId &&
      this.dependencies.docManager.hasTimelineContent(connection.rcsSessionId)
    ) {
      connection.acpSessionId = sessionId;
      connection.sessionLoaded = true;
      this.dependencies.syncSessionId(connection, sessionId, true);
      return null;
    }

    const previousSessionId = connection.acpSessionId;
    const previousLoaded = connection.sessionLoaded;
    const replacement = await this.dependencies.docManager.prepareProjectionReplacement(
      connection.rcsSessionId,
      sessionId,
    );
    return this.createSessionSyncLifecycle(connection, replacement, sessionId, previousSessionId, previousLoaded, true);
  }

  /** create_session：先同步运行环境，再激活空投影；绑定保留旧值直到 Agent 返回新 sessionId。 */
  private async prepareCreateSession(connection: SessionConnection): Promise<SessionSyncRequestLifecycle> {
    try {
      await this.dependencies.refreshInstanceEnvironment?.(connection);
    } catch (error) {
      this.dependencies.reportError("[SessionChannel] instance environment refresh failed", error);
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
    }
    const previousSessionId = connection.acpSessionId;
    const previousLoaded = connection.sessionLoaded;
    const replacement = await this.dependencies.docManager.prepareProjectionReplacement(connection.rcsSessionId, null);
    return this.createSessionSyncLifecycle(connection, replacement, null, previousSessionId, previousLoaded, false);
  }

  private createSessionSyncLifecycle(
    connection: SessionConnection,
    replacement: ProjectionReplacement,
    targetSessionId: string | null,
    previousSessionId: string | null,
    previousLoaded: boolean,
    replay: boolean,
  ): SessionSyncRequestLifecycle {
    let status: "pending" | "committing" | "committed" | "rolled_back" = "pending";
    let queuedBytes = 0;
    let overflowed = false;
    let buffering = true;
    const queuedEvents: NormalizedEvent[] = [];

    return {
      targetSessionId,
      replay,
      queueEvent(event) {
        if (!buffering || status !== "pending") return "ignored";
        // session/new 的响应返回前目标 ACP session 尚未知，任何 session-bound
        // 通知都无法安全归属；不能先暂存后猜测，否则旧会话噪声可撑爆候选队列。
        if (!targetSessionId || event.acpSessionId !== targetSessionId) return "ignored";
        let eventBytes: number;
        try {
          eventBytes = JSON.stringify(event).length;
        } catch {
          overflowed = true;
          buffering = false;
          return "overflow";
        }
        if (
          queuedEvents.length >= SESSION_TRANSITION_EVENT_LIMIT ||
          queuedBytes + eventBytes > SESSION_TRANSITION_BYTE_LIMIT
        ) {
          overflowed = true;
          buffering = false;
          return "overflow";
        }
        queuedEvents.push(event);
        queuedBytes += eventBytes;
        return "queued";
      },
      drainEvents(acceptedSessionId) {
        buffering = false;
        const events = queuedEvents.splice(0);
        queuedBytes = 0;
        return events.filter((event) => event.acpSessionId === acceptedSessionId);
      },
      commit: async (result, isCurrent) => {
        if (status !== "pending" || overflowed || !isCurrent()) return false;
        const newSessionId = result.sessionId;
        if (typeof newSessionId !== "string" || newSessionId.length === 0) return false;
        if (targetSessionId && newSessionId !== targetSessionId) return false;
        status = "committing";
        const bufferedEvents = queuedEvents.splice(0).filter((event) => event.acpSessionId === newSessionId);
        queuedBytes = 0;
        buffering = false;
        const committed = await replacement.commit(isCurrent, {
          stagedEvents: bufferedEvents,
          activate: (registerRollback) => {
            // 单连接可能尚未进入 registry；先登记本地 binding 的精确恢复，再同步同组客户端。
            registerRollback(() => {
              connection.acpSessionId = previousSessionId;
              connection.sessionLoaded = previousLoaded;
            });
            connection.acpSessionId = newSessionId;
            connection.sessionLoaded = true;
            this.dependencies.syncSessionId(connection, newSessionId, true, registerRollback);
            this.dependencies.replaceProjection(
              replacement.projection,
              replacement.previousProjection,
              registerRollback,
            );
          },
        });
        if (!committed) {
          status = "rolled_back";
          return false;
        }
        status = "committed";
        return true;
      },
      rollback: async () => {
        if (status !== "pending") return false;
        buffering = false;
        queuedEvents.length = 0;
        queuedBytes = 0;
        if (!(await replacement.rollback())) return false;
        status = "rolled_back";
        // prepare 从未改过 binding 或活动 projection，rollback 不得重写一个可能
        // 已由后继事务提交的新 binding。
        return true;
      },
    };
  }

  /** send_prompt：把用户消息写入 Chat Doc（服务端单写，前端不乐观写入）并返回 turnId */
  private async writePromptText(connection: SessionConnection, content: unknown): Promise<string | undefined> {
    const text = extractPromptText(content);
    if (!text) return;
    try {
      await this.dependencies.docManager.openSession(connection.userId, connection.agentId, connection.rcsSessionId);
    } catch (err) {
      this.dependencies.reportError("[SessionChannel] Failed to ensure session doc for user message:", err);
    }
    return this.dependencies.docManager.registerUserMessage(connection.rcsSessionId, text);
  }

  // ── 权限 CAS（C5）──

  /**
   * 解析权限响应（CAS）：仅 pending → resolved 迁移一次，成功返回 true。
   * 迁移成功后投影工具调用/turn 收敛并 bump 投影版本（控制面路径不走聚合层，
   * 与聚合层 permission_resolved 事件共用 state/permission.ts 单一实现）。
   * 失败（重复响应/已过期/不存在/无 Doc）返回 false，调用方不发 RPC。
   */
  private resolvePermissionViaCas(connection: SessionConnection, payload: Record<string, unknown>): boolean {
    const permissionId = typeof payload.requestId === "string" ? payload.requestId : "";
    if (!permissionId) return false;
    const chatDoc = this.dependencies.docManager.getChatYdoc(connection.rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(connection.rcsSessionId);
    if (!chatDoc || !sessionDoc) return false;

    const decision = typeof payload.optionId === "string" && payload.optionId.length > 0 ? payload.optionId : null;
    const migrated = applyPermissionResolution({ chat: chatDoc, session: sessionDoc }, permissionId, decision);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
    return migrated;
  }

  // ── 权限超时（C5）──

  /**
   * 为权限请求安排过期定时器（幂等：同 permissionId 已有定时器则跳过，
   * 覆盖重放 permission_requested 帧的重复通知）。定时器到期后执行
   * pending → expired CAS 迁移并收敛 turn/工具调用状态。
   */
  private armPermissionExpiry(rcsSessionId: string, permissionId: string, expiresAt: string): void {
    let timers = this.permissionTimers.get(rcsSessionId);
    if (!timers) {
      timers = new Map();
      this.permissionTimers.set(rcsSessionId, timers);
    }
    if (timers.has(permissionId)) return;

    const parsed = new Date(expiresAt).getTime();
    const timeoutMs = Number.isFinite(parsed)
      ? Math.max(0, parsed - Date.now())
      : (this.dependencies.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timers.delete(permissionId);
      this.expirePermission(rcsSessionId, permissionId);
    }, timeoutMs);
    timers.set(permissionId, timer);
  }

  /** 权限过期迁移：CAS pending → expired（重复过期无副作用），收敛由 state/permission.ts 统一处理 */
  private expirePermission(rcsSessionId: string, permissionId: string): void {
    const chatDoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    if (!chatDoc || !sessionDoc) return;
    const migrated = applyPermissionExpiration({ chat: chatDoc, session: sessionDoc }, permissionId);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
  }

  // ── AskUserQuestion CAS（与权限 C5 同模式）──

  /**
   * 应答问题（CAS）：仅 pending → resolved 迁移一次，成功返回 true。
   * 迁移成功后 bump 投影版本（控制面路径不走聚合层，与聚合层 question_resolved
   * 事件共用 state/question.ts 单一实现）。失败（重复响应/已过期/不存在/无 Doc）
   * 返回 false，调用方不发 control_response。
   */
  private respondQuestionViaCas(connection: SessionConnection, payload: Record<string, unknown>): boolean {
    const questionId = typeof payload.questionId === "string" ? payload.questionId : "";
    if (!questionId) return false;
    const chatDoc = this.dependencies.docManager.getChatYdoc(connection.rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(connection.rcsSessionId);
    if (!chatDoc || !sessionDoc) return false;

    // 多问题合并答案（optionIds 数组，按问题顺序）；兼容单值 optionId 历史形态
    const rawOptionIds = payload.optionIds;
    const optionIds = Array.isArray(rawOptionIds)
      ? (rawOptionIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
      : typeof payload.optionId === "string" && payload.optionId.length > 0
        ? [payload.optionId]
        : [];
    const migrated = respondQuestion({ chat: chatDoc, session: sessionDoc }, questionId, optionIds);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
    return migrated;
  }

  // ── AskUserQuestion 超时（60s，与 acp-link 自动空答案对齐）──

  /**
   * 为问题请求安排过期定时器（幂等：同 questionId 已有定时器则跳过，
   * 覆盖重放 question_requested 帧的重复通知）。定时器到期后执行
   * pending → expired CAS 迁移（投影失效，前端弹窗随状态过滤消失）。
   */
  private armQuestionExpiry(rcsSessionId: string, questionId: string, expiresAt: string): void {
    let timers = this.questionTimers.get(rcsSessionId);
    if (!timers) {
      timers = new Map();
      this.questionTimers.set(rcsSessionId, timers);
    }
    if (timers.has(questionId)) return;

    const parsed = new Date(expiresAt).getTime();
    // 超时固定与 acp-link 60s 自动空答案对齐（DEFAULT_QUESTION_TIMEOUT_MS），
    // 不提供配置覆盖：acp-link 侧无对应配置项，可配会破坏两侧失效时刻一致
    const timeoutMs = Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : DEFAULT_QUESTION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timers.delete(questionId);
      this.expireQuestionTimer(rcsSessionId, questionId);
    }, timeoutMs);
    timers.set(questionId, timer);
  }

  /** 问题过期迁移：CAS pending → expired（重复过期无副作用），实现见 state/question.ts */
  private expireQuestionTimer(rcsSessionId: string, questionId: string): void {
    const chatDoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    if (!chatDoc || !sessionDoc) return;
    const migrated = expireQuestion({ chat: chatDoc, session: sessionDoc }, questionId);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
  }
}

/** 服务端 Command → 旧协议 action 形状（translateSimpleAction 的输入） */
function toLegacyAction(command: Command): Record<string, unknown> {
  return { action: command.type, ...command.payload };
}

/** 从 ACP content blocks 提取纯文本（供用户消息投影） */
function extractPromptText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
