import { translateSimpleAction } from "../protocol/translator";
import { normalizeQuestionAnswers, type QuestionAnswer } from "../schema";
import { bumpProjectionVersion } from "../state/chat-writer";
import { applyPermissionResolution } from "../state/permission";
import { respondQuestion } from "../state/question";
import { CommandCoordinator } from "./command-coordinator";
import { normalizeSessionCommand } from "./session-command";
import type { SessionChannelDependencies, SessionConnection } from "./session-connection";
import { SessionExpirations } from "./session-expirations";
import { deleteSessionAction, renameSessionAction } from "./session-mutation-action";
import { SessionRestoration } from "./session-restoration";
import {
  type ActionSinks,
  type Command,
  CommandExecutionError,
  type CommandOutcome,
  isUserInputQueueAction,
} from "./types";
import { executeUserInputQueueAction, validateUserInputQueueAction } from "./user-input-queue-action";

export type { SessionChannelDependencies, SessionConnection } from "./session-connection";

interface SessionBinding {
  sessionId: string | null;
  loaded: boolean;
  generation: number;
  loading: boolean;
  confirmed: boolean;
  runtimeIdentity?: string;
  continuity?: object;
}

export class SessionChannel {
  private readonly coordinator: CommandCoordinator;
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly contexts = new WeakMap<
    Command,
    {
      connection: SessionConnection;
      origin: SessionConnection;
      binding: SessionBinding;
      generation: number;
      loading: boolean;
    }
  >();
  private readonly expirations: SessionExpirations;
  private readonly restoration: SessionRestoration;

  constructor(private readonly dependencies: SessionChannelDependencies) {
    this.restoration = new SessionRestoration(dependencies);
    this.expirations = new SessionExpirations(dependencies);
    this.coordinator = new CommandCoordinator({
      executeCommand: async (command, signal) => {
        try {
          return await this.executeCommand(command, signal);
        } finally {
          if (["create_session", "load_session", "resume_session"].includes(command.type)) {
            const context = this.contexts.get(command);
            if (context) context.binding.loading = false;
          }
        }
      },
      validateAction: (command) => this.validateAction(command),
      getProjectionVersion: (rcsSessionId) => this.getProjectionVersion(rcsSessionId),
      maxPendingPerSession: dependencies.maxPendingPerSession,
      reportError: dependencies.reportError,
      reportLog: dependencies.reportLog,
    });
    // 权限请求投影成功 → 安排超时迁移（控制面持有定时器；聚合层保持纯投影无 I/O）。
    // 单槽位装配：DocManager 为单例，同一实例只应有一个控制面绑定。
    dependencies.docManager.setPermissionRequestedHandler((rcsSessionId, permission) => {
      this.expirations.armPermissionExpiry(rcsSessionId, permission.permissionId, permission.expiresAt);
    });
    // AskUserQuestion 问题投影成功 → 安排 120s 超时迁移（与权限定时器同模式：
    // acp-link 侧 120s 自动 resolve 空答案，投影必须同步失效否则前端弹窗悬挂）。
    dependencies.docManager.setQuestionRequestedHandler((rcsSessionId, question) => {
      this.expirations.armQuestionExpiry(rcsSessionId, question.questionId, question.expiresAt);
    });
  }

  /** 当前客户端命令代次；重连不得用新代次改写未知旧命令 ID。 */
  getCommandEpoch(): string {
    return this.coordinator.getCommandEpoch();
  }

  /** 历史回收前轮换代次，连接层必须广播或关闭未收到新代次的连接。 */
  onCommandEpochChanged(listener: (epoch: string) => void): () => void {
    return this.coordinator.onCommandEpochChanged(listener);
  }

  /** 可信内部动作入口，网络动作必须使用 handleClientAction。 */
  handleAction(connection: SessionConnection, rawAction: Record<string, unknown>, sinks: ActionSinks): Promise<void> {
    return this.submitAction(connection, rawAction, sinks, false);
  }

  /** 已认证客户端的严格 full commandId 入口，实时与缓冲重放共用此入口。 */
  handleClientAction(
    connection: SessionConnection,
    rawAction: Record<string, unknown>,
    sinks: ActionSinks,
  ): Promise<void> {
    return this.submitAction(connection, rawAction, sinks, true);
  }

  private async submitAction(
    connection: SessionConnection,
    rawAction: Record<string, unknown>,
    sinks: ActionSinks,
    client: boolean,
  ): Promise<void> {
    const command = normalizeSessionCommand(connection, rawAction);
    let binding = this.bindings.get(connection.rcsSessionId);
    if (
      binding &&
      (binding.runtimeIdentity !== connection.runtimeIdentity ||
        binding.continuity !== connection.getSessionContinuity?.())
    ) {
      this.disposeRcsSession(connection.rcsSessionId);
      binding = undefined;
    }
    if (!binding) {
      binding = {
        sessionId: connection.acpSessionId,
        loaded: connection.sessionLoaded,
        generation: 0,
        runtimeIdentity: connection.runtimeIdentity,
        continuity: connection.getSessionContinuity?.(),
        loading: false,
        confirmed: connection.sessionLoaded && connection.acpSessionId !== null,
      };
      this.bindings.set(connection.rcsSessionId, binding);
    }
    this.contexts.set(command, {
      connection: { ...connection },
      origin: connection,
      binding,
      generation: binding.generation,
      loading: binding.loading,
    });
    if (client) await this.coordinator.submitClientCommand(command, sinks);
    else await this.coordinator.submit(command, sinks);
  }

  /** 释放 rcsSessionId 的频道状态（去重表 / 队列 / 连接绑定 / 取消定时器 / 权限定时器），随实例生命周期调用 */
  disposeRcsSession(rcsSessionId: string): void {
    this.expirations.dispose(rcsSessionId);
    this.bindings.delete(rcsSessionId);
    this.coordinator.disposeRcsSession(rcsSessionId);
  }

  /** Agent 断开时废弃确认并中止旧代次命令，页面刷新不走此路径。 */
  invalidateRuntimeSession(rcsSessionId: string): void {
    this.restoration.forget(rcsSessionId);
    this.disposeRcsSession(rcsSessionId);
  }

  // ── CommandCoordinator 注入 ──

  /** Action 上下文校验：会话存在性 + load_session payload 结构（失败不发 accepted） */
  private validateAction(command: Command): void {
    // 会话存在性以 docManager 内存 Doc 为准（频道已建立 = 实例会话存活），
    // 仅注册过连接不构成会话（disposeRcsSession 后同 ID 重发必须拒绝）。
    const connection = this.contexts.get(command)?.connection;
    if (!connection || !this.dependencies.docManager.getChatYdoc(command.rcsSessionId)) {
      throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
    }
    if (command.type === "load_session" || command.type === "resume_session") {
      const sessionId = command.payload.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
        throw new CommandExecutionError("ACTION.INVALID_STATE");
      }
    }
    // steer 三类 Action：属主身份 + payload 形状在认证/配额之前失败（不发 accepted）
    if (isUserInputQueueAction(command.type)) validateUserInputQueueAction(connection, command);
  }

  /** 解析会话级 MCP；未注入或解析失败时返回 undefined（调用方降级为不注入）。 */
  private async resolveSessionMcpServers(
    connection: SessionConnection,
  ): Promise<readonly Record<string, unknown>[] | undefined> {
    const resolve = this.dependencies.sessionMcpServers;
    if (!resolve) return;
    try {
      const servers = await resolve(connection);
      return servers && servers.length > 0 ? servers : undefined;
    } catch (error) {
      this.dependencies.reportError("[SessionChannel] 会话级 MCP 解析失败，本次会话不注入", error);
      return;
    }
  }

  private getProjectionVersion(rcsSessionId: string): number | null {
    const ydoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    if (!ydoc) return null;
    const version = ydoc.getMap("root").get("projectionVersion");
    return typeof version === "number" ? version : null;
  }

  // ── 命令执行（守卫语义迁移自 session-transition.ts）──

  private async executeCommand(command: Command, signal: AbortSignal): Promise<CommandOutcome> {
    const context = this.contexts.get(command);
    if (!context || signal.aborted) throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
    const { binding } = context;
    const assertCurrent = () => {
      if (signal.aborted || this.bindings.get(command.rcsSessionId) !== binding)
        throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
    };
    const connection = { ...context.connection, acpSessionId: binding.sessionId, sessionLoaded: binding.loaded };
    if (
      ["send_prompt", "cancel", "set_session_mode", "respond_permission", "respond_question"].includes(command.type) ||
      isUserInputQueueAction(command.type)
    ) {
      if (
        context.loading ||
        (!binding.confirmed && (binding.generation > 0 || command.type === "send_prompt")) ||
        context.generation !== binding.generation
      )
        throw new CommandExecutionError("ACTION.VERSION_CONFLICT");
    }

    const { docManager } = this.dependencies;

    if (command.type === "rename_session") {
      await renameSessionAction(
        docManager,
        connection,
        command.sessionId,
        command.payload.title,
        this.dependencies.reportError,
      );
      return {};
    }

    if (command.type === "list_sessions") {
      // 守卫：Agent status 到达前不发 list_sessions（ACP 初始化未完成时列表不可信）。
      // 静默跳过而非报错：status 未到是连接建立瞬间的正常竞态，前端无需感知。
      if (!connection.agentStatusReceived) return {};
    }

    if (command.type === "load_session" || command.type === "resume_session") {
      const shouldForward = await this.restoration.prepareLoad(
        connection,
        command.payload.sessionId,
        assertCurrent,
        binding.confirmed,
      );
      if (!shouldForward) {
        binding.sessionId = connection.acpSessionId;
        binding.loaded = connection.sessionLoaded;
        binding.confirmed = true;
        context.origin.acpSessionId = connection.acpSessionId;
        context.origin.sessionLoaded = connection.sessionLoaded;
        if (connection.acpSessionId) this.dependencies.syncSessionId(connection, connection.acpSessionId);
        return {};
      }
      binding.loading = true;
      binding.confirmed = false;
      binding.generation++;
    }

    if (command.type === "create_session") {
      binding.loading = true;
      binding.confirmed = false;
      binding.generation++;
      await this.prepareCreateSession(connection, assertCurrent);
    }

    let turnId: string | undefined;
    if (command.type === "send_prompt") {
      // 浏览器所见目标可能在外层队列等待期间过期；它只作前置条件，路由仍以确认绑定为准。
      if (command.sessionId !== binding.sessionId) {
        this.dependencies.reportLog?.(`[SessionChannel] prompt target conflict: rcsSessionId=${command.rcsSessionId}`);
        throw new CommandExecutionError("ACTION.VERSION_CONFLICT");
      }
      turnId = await this.writePromptText(connection, command.payload.content);
      assertCurrent();
      // 同一 relay 可承载多个 ACP 会话，出站目标必须来自本频道已确认绑定。
      command.payload = {
        ...command.payload,
        sessionId: connection.acpSessionId ?? undefined,
      };
    }

    if (command.type === "respond_permission") {
      // 只有 CAS 成功才发权限响应，避免重复授权。
      if (!this.resolvePermissionViaCas(connection, command.payload)) return {};
    }

    if (command.type === "respond_question") {
      // 只有 CAS 成功才发问题答案，避免重复执行。
      if (!this.respondQuestionViaCas(connection, command.payload)) return {};
    }

    // steer 三类 Action 走独立执行器（sessionId / generation / commandId 全部服务端权威，
    // 自带 rpcId 与登记，故必须在通用 rpcId 分配之前返回；本路径不写 Chat Doc）
    if (isUserInputQueueAction(command.type)) {
      return executeUserInputQueueAction(
        {
          docManager,
          reportError: this.dependencies.reportError,
          timeoutMs: this.dependencies.userInputQueueTimeoutMs,
        },
        connection,
        command,
      );
    }

    // cwd 由服务端根据已认证 environment 注入（translateSimpleAction 内完成），
    // 浏览器传入的 workspace/cwd 不可信（CLAUDE.md 不变量）。
    // rpcId 单独捕获：会话同步请求需用同一 id 登记，等待响应按 id 校验
    const rpcId = connection.getNextRpcId();
    // 只在握手动作上解析会话级 MCP：其它动作不能多出一次 await（会改变命令发送时序）。
    let sessionMcpServers: readonly Record<string, unknown>[] | undefined;
    if (command.type === "create_session" || command.type === "load_session" || command.type === "resume_session") {
      sessionMcpServers = await this.resolveSessionMcpServers(connection);
    }
    const rpc = translateSimpleAction(
      toLegacyAction(command),
      connection.workspacePath,
      rpcId,
      sessionMcpServers === undefined ? {} : { mcpServers: sessionMcpServers },
    );
    if (command.type === "create_session" || command.type === "load_session" || command.type === "resume_session") {
      connection.registerSessionSyncRpcId?.(
        rpc.id as number | string,
        command.type === "create_session" ? undefined : command.sessionId,
      );
    }
    // 回执必须先登记后发送，覆盖 Agent 同步响应的窗口。
    const loadReceipt =
      command.type === "load_session" || command.type === "resume_session"
        ? connection.awaitSessionMutation?.(rpc.id as number | string)
        : undefined;
    if ((command.type === "load_session" || command.type === "resume_session") && !loadReceipt) {
      binding.loading = false;
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
    }
    const createReceipt =
      command.type === "create_session" ? connection.awaitSessionCreation?.(rpc.id as number | string) : undefined;
    const cancelReceipts = () => {
      loadReceipt?.cancel();
      createReceipt?.cancel();
    };
    signal.addEventListener("abort", cancelReceipts, { once: true });
    void Promise.all([loadReceipt?.completed, createReceipt?.completed]).finally(() =>
      signal.removeEventListener("abort", cancelReceipts),
    );
    if (command.type === "send_prompt") {
      connection.registerPendingPrompt?.(rpc.id as number | string, turnId);
    }
    if (command.type === "delete_session") {
      await deleteSessionAction(docManager, connection, command.sessionId, rpc, this.dependencies.reportError);
      return {};
    }
    try {
      assertCurrent();
      await connection.sendToRelay(rpc);
      assertCurrent();
    } catch (err) {
      // 回执登记随发送失败一起撤销：否则它会留到超时才退场，而这次创建根本没发出去。
      createReceipt?.cancel();
      loadReceipt?.cancel();
      binding.loading = false;
      this.dependencies.reportError(`[SessionChannel] relay send failed: action=${command.type}`, err);
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
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
      this.expirations.armCancelTimeout(connection.rcsSessionId);
    }

    // create_session 等 Agent 的 session/new 结果：committed Ack 必须携带真实 session id，
    // 否则调用方拿不到「本次创建出了哪个会话」的回执，只能靠共享投影变化去猜（多标签页下会猜错）。
    // 超时、断开和拒绝均报错，不得提交没有确认的会话。
    if (loadReceipt) {
      const succeeded = await loadReceipt.completed;
      assertCurrent();
      binding.loading = false;
      if (!succeeded) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
      if (loadReceipt.isCurrent?.() === false) throw new CommandExecutionError("ACTION.VERSION_CONFLICT");
      binding.sessionId = command.sessionId;
      binding.loaded = true;
      binding.confirmed = true;
      context.origin.acpSessionId = command.sessionId;
      context.origin.sessionLoaded = true;
      this.dependencies.syncSessionId(connection, command.sessionId);
      this.restoration.remember(connection, command.sessionId);
      return { sessionId: command.sessionId };
    }
    if (createReceipt) {
      const createdSessionId = await createReceipt.completed;
      assertCurrent();
      binding.loading = false;
      if (!createdSessionId) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
      if (createReceipt.isCurrent?.() === false) return { turnId, sessionId: createdSessionId };
      binding.sessionId = createdSessionId;
      binding.loaded = true;
      binding.confirmed = true;
      context.origin.acpSessionId = createdSessionId;
      context.origin.sessionLoaded = true;
      this.dependencies.syncSessionId(connection, createdSessionId);
      this.restoration.remember(connection, createdSessionId);
      return { turnId, sessionId: createdSessionId };
    }
    if (command.type === "create_session") binding.loading = false;

    return { turnId };
  }

  /** create_session：先同步运行环境，再换代 Chat/Session 投影，确保新会话冻结当前 Skills。 */
  private async prepareCreateSession(connection: SessionConnection, assertCurrent: () => void): Promise<void> {
    try {
      await this.dependencies.refreshInstanceEnvironment?.(connection);
    } catch (error) {
      this.dependencies.reportError("[SessionChannel] instance environment refresh failed", error);
      throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
    }
    assertCurrent();
    const projection = await this.dependencies.docManager.replaceProjection(connection.rcsSessionId, null);
    assertCurrent();
    this.dependencies.replaceProjection(projection);
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
    const turnId = await this.dependencies.docManager.registerUserMessage(connection.rcsSessionId, text);
    // 用户消息只由后端写入：turnId 来自 registerUserMessage 的可信绑定，Agent 回显不进入新协议入口。
    // 同步连接可能属于另一个 socket，必须经会话级入口扇出，而不是查询发起动作的连接。
    if (turnId) this.dependencies.publishUserMessage?.(connection.rcsSessionId, turnId, text);
    return turnId;
  }

  // ── 权限 CAS（C5）──

  /**
   * 控制面复用聚合层的权限 CAS，保证并发响应只投影一次且共享版本收敛规则。
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

    // 按问题顺序保留答案结构：单选 string，多选 string[]；兼容历史 optionIds / optionId。
    const rawAnswers = Array.isArray(payload.answers)
      ? payload.answers
      : Array.isArray(payload.optionIds)
        ? payload.optionIds
        : typeof payload.optionId === "string" && payload.optionId.length > 0
          ? [payload.optionId]
          : [];
    const answers: QuestionAnswer[] = normalizeQuestionAnswers(rawAnswers);
    const migrated = respondQuestion({ chat: chatDoc, session: sessionDoc }, questionId, answers);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
    return migrated;
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
