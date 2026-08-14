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
import { bumpProjectionVersion, getSessionInfo } from "../state/chat-writer";
import type { DocManager } from "../state/doc-manager";
import { applyPermissionExpiration, applyPermissionResolution } from "../state/permission";
import { CommandCoordinator } from "./command-coordinator";
import {
  type ActionAck,
  type ActionError,
  type ActionSinks,
  type Command,
  CommandExecutionError,
  type CommandOutcome,
} from "./types";

/** 取消超时兜底（毫秒）：cancel 后 Agent 未确认（进程挂起/断连）时 turn 收敛为 interrupted */
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

/** 权限请求超时兜底（毫秒）：与聚合层缺失 expiresAt 时的默认值一致 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

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
  lastClientKeepalive: number;
  /** 发送 RPC 到 relay（测试中为记录型 fake） */
  sendToRelay: (message: Record<string, unknown>) => Promise<void> | void;
  /** JSON-RPC id 递增计数器，保证同一 instance 下生成唯一 id */
  getNextRpcId: () => number;
  /**
   * 登记在途会话同步请求（create/load/resume）的 rpcId：响应到达时 relay 的
   * 会话同步 result 分支按 id 校验（JSON-RPC 响应无 method 字段，rename/delete
   * 等其他携带 sessionId 的响应不得劫持该分支）。可选注入，宿主由 gateway 提供。
   */
  registerSessionSyncRpcId?: (rpcId: number | string) => void;
  /**
   * 登记在途 prompt 请求（send_prompt）的 rpcId：Agent 子进程死亡时 acp-link 以
   * JSON-RPC error 响应拒绝 prompt，relay 按 id 匹配该登记并收敛 turn_failed
   * （防止 loading 永久卡死）。可选注入，宿主由 gateway 提供。
   */
  registerPendingPromptId?: (rpcId: number | string) => void;
}

export interface SessionChannelDependencies {
  docManager: DocManager;
  /** 会话切换（load/create）前把当前 Session Doc 快照以 CAS 方式持久化到 Redis */
  prepareClearSessionSnapshot: (connection: SessionConnection) => Promise<void>;
  /** 会话切换后同步 acpSessionId 到同一 instance+user 的所有客户端 */
  syncSessionId: (connection: SessionConnection, newSessionId: string) => void;
  reportError: (message: string, error: unknown) => void;
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
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 权限过期定时器（rcsSessionId → permissionId → timer），disposeRcsSession 时全部释放 */
  private readonly permissionTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(private readonly dependencies: SessionChannelDependencies) {
    this.coordinator = new CommandCoordinator({
      executeCommand: (command) => this.executeCommand(command),
      validateAction: (command) => this.validateAction(command),
      getProjectionVersion: (rcsSessionId) => this.getProjectionVersion(rcsSessionId),
      maxPendingPerSession: dependencies.maxPendingPerSession,
      reportError: dependencies.reportError,
    });
    // 权限请求投影成功 → 安排超时迁移（控制面持有定时器；聚合层保持纯投影无 I/O）。
    // 单槽位装配：DocManager 为单例，同一实例只应有一个控制面绑定。
    dependencies.docManager.setPermissionRequestedHandler((rcsSessionId, permission) => {
      this.armPermissionExpiry(rcsSessionId, permission.permissionId, permission.expiresAt);
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
    const timer = this.cancelTimers.get(rcsSessionId);
    if (timer) {
      clearTimeout(timer);
      this.cancelTimers.delete(rcsSessionId);
    }
    const permTimers = this.permissionTimers.get(rcsSessionId);
    if (permTimers) {
      for (const t of permTimers.values()) clearTimeout(t);
      this.permissionTimers.delete(rcsSessionId);
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
      throw new CommandExecutionError("SESSION_NOT_FOUND", "Session not found", false);
    }
    if (command.type === "load_session") {
      const sessionId = command.payload.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new CommandExecutionError("INVALID_STATE", "load_session requires a valid sessionId", false);
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
    if (!connection) throw new CommandExecutionError("SESSION_NOT_FOUND", "Session not found", false);

    const { docManager } = this.dependencies;

    if (command.type === "list_sessions") {
      // 守卫：Agent status 到达前不发 list_sessions（ACP 初始化未完成时列表不可信）。
      // 静默跳过而非报错：status 未到是连接建立瞬间的正常竞态，前端无需感知。
      if (!connection.agentStatusReceived) return {};
    }

    if (command.type === "load_session") {
      const shouldForward = await this.prepareLoadSession(connection, command.payload.sessionId);
      if (!shouldForward) return {};
    }

    if (command.type === "create_session") {
      await this.prepareCreateSession(connection);
    }

    let turnId: string | undefined;
    if (command.type === "send_prompt") {
      turnId = await this.writePromptText(connection, command.payload.content);
      // 出站显式绑定目标 session（服务端权威，浏览器传入值不可信，与 cwd 注入同理）：
      // prompt 不带 sessionId 时 acp-dispatcher fallback 连接级当前会话——多会话共享
      // 同一 relay 时该值可能已被其他会话的 load/create 改写，prompt 会落到错误会话
      // 并被接受，当前 turn 永远收不到响应（loading 卡死根因）。以服务端绑定的
      // acpSessionId（load/create 后 syncSessionId 更新）为权威目标。
      command.payload = { ...command.payload, sessionId: connection.acpSessionId || undefined };
    }

    if (command.type === "respond_permission") {
      // C5 权限 CAS：仅 pending → resolved 迁移一次，迁移成功才向 Agent 发送
      // permission.resolve（JSON-RPC 响应，translator 构造）。重复响应
      // （已 resolved / expired / 不存在）不发 RPC、返回幂等成功——
      // 防止重复授权导致 Agent 执行两遍。
      if (!this.resolvePermissionViaCas(connection, command.payload)) return {};
    }

    // cwd 由服务端根据已认证 environment 注入（translateSimpleAction 内完成），
    // 浏览器传入的 workspace/cwd 不可信（CLAUDE.md 不变量）。
    // rpcId 单独捕获：会话同步请求需用同一 id 登记，等待响应按 id 校验
    const rpcId = connection.getNextRpcId();
    const rpc = translateSimpleAction(toLegacyAction(command), connection.workspacePath, rpcId);
    // 会话同步请求登记（create/load/resume）：响应帧只有 id 无 method，relay 的
    // 会话同步 result 分支仅放行登记过的请求；rename/delete 等其他携带 sessionId
    // 的响应不得劫持该分支（否则 registry 活跃会话被 clobber、绑定校验丢弃当前
    // 会话增量、误开回放窗口——rename 非当前会话即触发，review M1 加固）。
    if (command.type === "create_session" || command.type === "load_session" || command.type === "resume_session") {
      connection.registerSessionSyncRpcId?.(rpc.id as number | string);
    }
    // prompt 请求登记：Agent 子进程死亡时 acp-link 回 JSON-RPC error（-32000/
    // -32603），relay 按 id 匹配登记收敛 turn_failed，否则 turn 永久卡 accepting、
    // 前端 loading 永不消失（R1：发送后完全无输出、仅刷新恢复）。
    if (command.type === "send_prompt") {
      connection.registerPendingPromptId?.(rpc.id as number | string);
    }
    try {
      await connection.sendToRelay(rpc);
    } catch (err) {
      this.dependencies.reportError(`[SessionChannel] relay send failed: action=${command.type}`, err);
      throw new CommandExecutionError("AGENT_UNAVAILABLE", "Agent connection error", true);
    }

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
      this.armCancelTimeout(connection.rcsSessionId);
    }

    return { turnId };
  }

  /**
   * 启动取消超时兜底：Agent 长时间未确认取消（进程挂起/断连）时 turn 收敛为 interrupted，
   * 不能停留在 cancelling 中间态。回调校验 activeTurn 仍是发起取消时的 turn 且仍处
   * cancelling——用户可能已发起新 turn（旧 turn 被终结）或 Agent 已确认终态，
   * 此时不得误中断当前 turn。
   */
  private armCancelTimeout(rcsSessionId: string): void {
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    const turnId = sessionDoc ? (getSessionInfo(sessionDoc).get("activeTurnId") as string | null) : null;
    if (!turnId) return;

    const timer = setTimeout(() => {
      this.cancelTimers.delete(rcsSessionId);
      const current = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
      const info = current ? getSessionInfo(current) : null;
      if (!info) return;
      if (info.get("activeTurnId") !== turnId || info.get("activeTurnStatus") !== "cancelling") return;
      this.dependencies.docManager.processNormalizedEvent(rcsSessionId, {
        type: "turn_interrupted",
        update: {},
        content: null,
      });
    }, this.dependencies.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS);
    this.cancelTimers.set(rcsSessionId, timer);
  }

  /** load_session 守卫：非法 sessionId 拒绝；同会话重复加载静默跳过（不重复 RPC） */
  private async prepareLoadSession(connection: SessionConnection, sessionId: unknown): Promise<boolean> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new CommandExecutionError("INVALID_STATE", "load_session requires a valid sessionId", false);
    }

    if (connection.acpSessionId === sessionId) {
      connection.acpSessionId = sessionId;
      return false;
    }

    // 防御：首次 load_session 且 Chat Doc 已有时间线内容时，
    // 说明是重连场景下 acpSessionId 恢复失败，不应清空已有消息。
    if (!connection.sessionLoaded && this.dependencies.docManager.hasSessionDocContent(connection.rcsSessionId)) {
      connection.acpSessionId = sessionId;
      connection.sessionLoaded = true;
      this.dependencies.syncSessionId(connection, sessionId);
      // P1: 此处 return true 会向 agent 发送 session/load RPC，可能触发全量回放。
      // 如果 Chat Doc 已有内容（来自之前的回放），其他客户端会收到重复消息。
      // 若未来观察到多客户端重复消息，改为 return false 即可（快照已在内存中）。
      return true;
    }

    await this.dependencies.prepareClearSessionSnapshot(connection);
    this.dependencies.docManager.clearChatDocContent(connection.rcsSessionId);
    this.dependencies.docManager.clearSessionDocContent(connection.rcsSessionId);
    connection.acpSessionId = sessionId;
    connection.sessionLoaded = true;
    this.dependencies.syncSessionId(connection, sessionId);
    return true;
  }

  /** create_session：同批清空 Chat Doc 与 Session Doc，确保新会话投影不残留旧内容 */
  private async prepareCreateSession(connection: SessionConnection): Promise<void> {
    await this.dependencies.docManager.openSession(connection.userId, connection.agentId, connection.rcsSessionId);
    await this.dependencies.prepareClearSessionSnapshot(connection);
    this.dependencies.docManager.clearChatDocContent(connection.rcsSessionId);
    this.dependencies.docManager.clearSessionDocContent(connection.rcsSessionId);
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

// 类型引用（导出面统一在 index）
export type { ActionAck, ActionError };
