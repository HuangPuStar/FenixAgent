// packages/chat-channel/src/channel/relay-event-handler.ts
// RelayEventHandler：共享 relay 唯一的入站消息消费者。
//
// 迁移自 src/transport/relay/yjs-frontend/relay-event-handler.ts，语义原样保留；
// 宿主能力（空闲活动标记、本地死实例清理）收敛为依赖注入（C6）：
// - acp-link 私有帧在此边界翻译为规范化事件（session/update 语义）后投递聚合层；
// - relay_closed（Instance ACP session 断链）触发两类清理：宿主侧实例级回收
//   （terminateLocalDeadInstance 注入）与本节点实时资源删除（Chat Doc / Session Doc /
//   广播订阅），保证新实例创建全新投影、绝不加载旧 Y.Doc（C6 断链语义）。

import type * as Y from "yjs";
import { extractJsonRpc, normalizeAcpMessage, translateSimpleAction } from "../protocol";
import { type NormalizedEvent, type NormalizedEventType, TURN_TERMINAL_STATUSES, type TurnStatus } from "../schema";
import type { DocManager } from "../state";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import { REPLAY_WINDOW_MS, type RelayMessage, type SharedRelay } from "./connection-types";

/** 需要活动 turn 才能投影的增量类事件（无头回放流的开头需要合成回放 turn） */
const REPLAY_NEEDS_TURN: ReadonlySet<NormalizedEventType> = new Set([
  "reasoning_delta",
  "message_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "tool_call_failed",
  "permission_requested",
]);

/** 生成回放 turnId（turn_replay_ 前缀与实时 turn 区分，便于日志排查） */
function createReplayTurnId(): string {
  return `turn_replay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取聚合层活动 turn（Session Doc root.session.activeTurnId/Status 为权威，与 chat-writer 一致） */
function readActiveTurn(
  docManager: DocManager,
  rcsSessionId: string,
): { turnId: string | null; turnStatus: TurnStatus | null } {
  const sessionYdoc = docManager.getSessionYdoc(rcsSessionId);
  if (!sessionYdoc) return { turnId: null, turnStatus: null };
  const session = sessionYdoc.getMap("root").get("session") as Y.Map<unknown> | undefined;
  if (!session) return { turnId: null, turnStatus: null };
  const turnId = session.get("activeTurnId");
  const turnStatus = session.get("activeTurnStatus");
  return {
    turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null,
    turnStatus: (turnStatus as TurnStatus | null | undefined) ?? null,
  };
}

/** 与聚合层 canWriteToTurn 一致的写入判定：turn 是否仍可接受内容增量 */
function isTurnWritable(status: TurnStatus | null): boolean {
  if (!status || status === "cancelling") return false;
  return !TURN_TERMINAL_STATUSES.has(status);
}

export interface RelayEventHandlerDependencies {
  registry: ConnectionRegistry;
  broadcaster: YjsBroadcaster;
  docManager: DocManager;
  registerYjsDocListener: (ydoc: Y.Doc, docName: string) => void;
  reportError: (message: string, error: unknown) => void;
  /** 每次从 Agent 收到消息时更新实例活跃时间（宿主注入，内部过滤保活消息） */
  touchInstanceActivity: (instanceId: string, raw: Record<string, unknown>) => void;
  /** 本地死实例回收（宿主注入：内部校验 nodeId，远程实例由机器级清理覆盖） */
  terminateLocalDeadInstance: (instanceId: string) => void;
  /**
   * 预选模型状态解析（宿主注入，可选）：agent_config.modelIds 预选列表 → 会话级
   * modelState（设计 §5.1 服务端权威）。返回 null 表示未配置预选（保持引擎自报）；
   * 非 null 时覆盖 session/new、load、resume 响应中的引擎自报 availableModels。
   */
  resolvePresetModelState?: (
    rcsSessionId: string,
    agentId: string,
  ) => Promise<{ currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null>;
  /**
   * JSON-RPC 命令回执（宿主注入，可选）：带 id 的 result/error 帧（无 method）通知
   * 发起方。当前唯一消费方是 SessionChannel 的模型切换回滚（设计 §5.3）：引擎拒绝
   * set_session_model 时按 rpcId 回滚乐观投影。
   */
  onRpcResponse?: (rpcId: number | string, ok: boolean) => void;
}

/** 共享 relay 唯一的入站消息消费者。 */
export class RelayEventHandler {
  constructor(private readonly dependencies: RelayEventHandlerDependencies) {}

  createMessageHandler(shared: SharedRelay): (message: RelayMessage) => Promise<void> {
    return async (message) => {
      try {
        await this.handleMessage(shared, message);
      } catch (err) {
        this.dependencies.reportError(`[YJS-FE] relay event processing failed: instanceId=${shared.instanceId}`, err);
      }
    };
  }

  private async handleMessage(shared: SharedRelay, message: RelayMessage): Promise<void> {
    const raw = message as unknown as Record<string, unknown>;
    const msgType = raw.type as string | undefined;
    const { registry } = this.dependencies;

    // 每次从 Agent 收到消息时更新活跃时间，防止实例在活跃对话中被空闲回收
    // touchInstanceActivity 内部已过滤 keep_alive/ heartbeat/ping/pong 等保活消息
    this.dependencies.touchInstanceActivity(shared.instanceId, raw);

    const rpcCheck = extractJsonRpc(raw);

    // binding 校验：ACP 帧携带的 sessionId 必须与当前实例绑定的 ACP session 一致，
    // 不一致（过期会话/串流）直接丢弃，不得写入 Y.Doc
    if (rpcCheck?.method === "session/update") {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (msgSessionId) {
        const activeSessionId = registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
        if (activeSessionId && activeSessionId !== msgSessionId) return;
      }
    }

    // JSON-RPC 命令回执（带 id、无 method 的 result/error 帧）：不投递到聚合层；
    // 通知发起方（当前为 SessionChannel 模型切换回滚，设计 §5.3）。引擎可能在
    // 预选注入前/后基于自身 availableModels 拒绝 set_session_model，必须让乐观
    // 投影有机会回滚，否则前端展示未生效的切换。
    // 例外：session/new、load、resume 的结果帧含 result.sessionId，走下方会话同步
    // 逻辑（开回放窗口 + 投影 modelState），不属于命令回执。
    const rpcSessionResult = rpcCheck?.result as Record<string, unknown> | undefined;
    const isSessionSyncResult =
      rpcCheck?.result !== undefined &&
      typeof rpcSessionResult?.sessionId === "string" &&
      rpcSessionResult.sessionId.length > 0;
    if (rpcCheck && rpcCheck.id !== undefined && rpcCheck.id !== null && !rpcCheck.method && !isSessionSyncResult) {
      if (this.dependencies.onRpcResponse) {
        try {
          this.dependencies.onRpcResponse(rpcCheck.id as number | string, !rpcCheck.error);
        } catch (err) {
          this.dependencies.reportError("[YJS-FE] onRpcResponse failed", err);
        }
      }
      return;
    }

    if (msgType === "relay_closed") {
      // 本地实例的 relay 意外关闭（进程崩溃/被杀）：触发实例级清理，避免死实例
      // 持续占并发额度并被 ensureRunning 无限复用（C-P2.4）。远程实例由
      // terminateLocalDeadInstance 内部的 nodeId 校验排除；主动关闭路径
      // （dispose/stop/idle 回收）的监听器先于 handle close 注销，不会误触发。
      void this.dependencies.terminateLocalDeadInstance(shared.instanceId);
      // 连接丢失迁移边（文档 8.1）：活动 turn 收敛为 interrupted 终态，
      // 晚到增量由聚合层丢弃，UI 不会出现"已断连还在输出"
      this.dispatch(shared, { type: "turn_interrupted", update: {}, content: null });
      registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
        try {
          this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
            type: "error",
            payload: { code: "agent_connection_lost", message: "Agent connection lost" },
          });
        } catch {
          /* ignore */
        }
        try {
          entry.ws.close(1011, "relay handle closed");
        } catch {
          /* ignore */
        }
      });
      // Instance ACP session 断链（C6 断链语义二）：删除该 rcsSessionId 的广播订阅与
      // Chat Doc / Session Doc 热缓存。新实例/新连接将创建全新实时投影，绝不加载旧 Y.Doc。
      // 先注销广播监听再销毁 Doc：即使客户端 close 事件延迟到达，也不会残留僵尸监听器。
      try {
        this.dependencies.broadcaster.unregisterYjsDocListener(`chat:${shared.rcsSessionId}`);
        this.dependencies.broadcaster.unregisterYjsDocListener(`session:${shared.rcsSessionId}`);
      } catch {
        /* ignore */
      }
      try {
        await this.dependencies.docManager.closeChat(shared.rcsSessionId);
        await this.dependencies.docManager.closeSession(shared.rcsSessionId);
      } catch (err) {
        this.dependencies.reportError(
          `[YJS-FE] failed to dispose realtime resources: rcsSessionId=${shared.rcsSessionId}`,
          err,
        );
      }
      return;
    }

    if (msgType === "error") {
      this.dependencies.reportError("[YJS-FE] agent error", { messageType: msgType, instanceId: shared.instanceId });
      this.sendSafeErrorToRcsSession(shared, "agent_error", "Agent request failed");
      this.dispatch(shared, { type: "turn_failed", update: { error: "Agent request failed" }, content: null });
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", { messageType: msgType, instanceId: shared.instanceId });
      this.sendSafeErrorToRcsSession(shared, "session_error", "Agent session request failed");
      this.dispatch(shared, { type: "turn_failed", update: { error: "Agent session request failed" }, content: null });
      return;
    }

    // 规范化事件投递：acp-link 私有帧在此边界翻译为 session/update 语义
    const normalized = normalizeAcpMessage(raw, msgType);
    if (normalized) {
      this.dispatchReplayAware(shared, normalized);
    }

    if (msgType === "status") {
      const payload = raw.payload as Record<string, unknown> | undefined;
      // 保留 capabilities 原始值（可能为 null/undefined）：聚合层仅在非空时投影，
      // 防止实例 start 竞态下空 capabilities 的 status 覆盖已就绪的能力（见 acp-link
      // connect 帧缓存——status 可能先于能力就绪到达，覆盖会永久清空前端能力信息）
      const capabilities = payload?.capabilities as Record<string, boolean> | null | undefined;
      // 注意：capabilities 可能是 null（acp-link 连接后立即 resend 的 status 中
      // state.agentCapabilities 尚未初始化），不能用 !== undefined 判定，必须排除 null
      const hasCapabilities = capabilities != null && Object.keys(capabilities).length > 0;
      // agent 未就绪的 status（capabilities 为空：acp-link 在 SDK 连接后立即 resend
      // status，早于 initialize 完成）不得视为就绪——标记 agentStatusReceived 会让前端
      // list_sessions 守卫放行、自动 list_sessions 也会发出，但 agent 尚未初始化会丢弃
      // 请求（无响应），前端 bootstrap 误判无会话并自动创建空会话（冷启动后页面为空的
      // 根因之一）。仅就绪 status（capabilities 非空）才标记就绪并触发列表同步；
      // 未就绪 status 只投影实例信息（capabilities 为空聚合层不覆盖），等待 agent
      // 初始化完成后的就绪 status 再同步。
      if (hasCapabilities) {
        this.dispatch(shared, {
          type: "agent_status",
          update: {
            instanceId: shared.instanceId,
            acpSessionId: registry.findActiveSessionIdByRcsSession(shared.rcsSessionId) ?? null,
            status: "ready",
            capabilities,
            lastActivityAt: new Date().toISOString(),
          },
          content: null,
        });
        const needsListSessions = !registry.hasStatusReceivedByRcsSession(shared.rcsSessionId);
        registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
          entry.agentStatusReceived = true;
        });
        if (needsListSessions) {
          try {
            await shared.handle.send(
              translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, ++shared.nextRpcId) as never,
            );
          } catch (err) {
            this.dependencies.reportError(
              `[YJS-FE] auto list_sessions send failed: instanceId=${shared.instanceId}`,
              err,
            );
          }
        }
        return;
      }
      // 未就绪 status：仅投影实例信息（status=initializing），不标记
      // agentStatusReceived、不触发 list_sessions（agent 初始化完成前列表不可信）
      this.dispatch(shared, {
        type: "agent_status",
        update: {
          instanceId: shared.instanceId,
          acpSessionId: registry.findActiveSessionIdByRcsSession(shared.rcsSessionId) ?? null,
          status: "initializing",
          capabilities,
          lastActivityAt: new Date().toISOString(),
        },
        content: null,
      });
      return;
    }

    try {
      const rpc = extractJsonRpc(raw);
      if (!rpc || !("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;
      const newSessionId = result.sessionId;
      if (typeof newSessionId === "string" && newSessionId.length > 0) {
        // load/resume 成功后开启回放窗口：Agent 即将回放历史增量（无持久化快照时
        // 历史恢复的唯一来源），窗口内由 dispatchReplayAware 补全 turn 上下文投影时间线
        shared.replayWindowUntil = Date.now() + REPLAY_WINDOW_MS;
        const sessionDoc = await this.dependencies.docManager.openSession(
          shared.userId,
          shared.agentId,
          shared.rcsSessionId,
        );
        // await 挂起期间 relay 可能已因全部客户端断开而释放（closeReleasedRelay 已置 destroyed 并注销），
        // 跳过注册避免产生无注销点的僵尸监听器；relay 已销毁时后续 session 同步也无接收者。
        if (shared.destroyed) return;
        this.dependencies.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
          entry.acpSessionId = newSessionId;
        });
        // 会话元信息（sessionId/status）经规范化事件写入 Session Doc session；
        // model/mode 来自 session/new、load 响应（acp-link 已从 configOptions 提取
        // models/modes 字段，SDK 0.28+ 无独立 models 字段），投影为会话级元数据，
        // 前端据此显示模型名与模式选择器
        let modelState: unknown = result.models && typeof result.models === "object" ? result.models : undefined;
        // 预选模型注入（设计 §5.1 服务端权威）：agent_config.modelIds 配置时覆盖引擎自报，
        // 引擎与前端天然只见预选范围；未配置（返回 null）保持引擎自报
        if (this.dependencies.resolvePresetModelState) {
          try {
            const preset = await this.dependencies.resolvePresetModelState(shared.rcsSessionId, shared.agentId);
            if (preset) modelState = preset;
          } catch (err) {
            this.dependencies.reportError(
              `[YJS-FE] resolvePresetModelState failed: rcsSessionId=${shared.rcsSessionId}`,
              err,
            );
          }
        }
        this.dispatch(shared, {
          type: "session_updated",
          update: {
            sessionId: newSessionId,
            status: "ready",
            ...(modelState !== undefined ? { modelState } : {}),
            ...(result.modes && typeof result.modes === "object" ? { modeState: result.modes } : {}),
          },
          content: null,
        });
        try {
          this.dependencies.broadcaster.broadcastSnapshot(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        } catch (err) {
          this.dependencies.reportError("[YJS-FE] Failed to push session init state:", err);
        }
        return;
      }
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] session sync failed:", err);
    }
  }

  /**
   * 回放窗口内的事件投递：Agent 历史回放（load/resume 后）在聚合层 turn 状态机下
   * 没有可写的 turn 上下文，直接投递会被全部拒绝（前端时间线为空）。窗口内且 Chat Doc
   * 无时间线内容时（无持久化快照 / 会话切换已清空）为两类回放形态补全 turn 上下文，
   * 窗口外或 doc 已有内容（重连跳过回放语义，避免重复）保持原语义由聚合层拒绝：
   * - user_message 无 turnId（全量回放开头）且无活动 turn 可写 → 分配回放 turnId；
   * - 增量类事件无活动 turn 可写（中断 turn 的无头回放）→ 先合成空文本回放 turn。
   * 实时流 agent 回显（聚合层已有可写 turn，如 registerUserMessage 创建的 turn）不干预，
   * 仍由聚合层拒绝，避免用户消息双写。
   */
  private dispatchReplayAware(shared: SharedRelay, event: NormalizedEvent): void {
    const inReplayWindow = shared.replayWindowUntil !== null && Date.now() < shared.replayWindowUntil;
    // doc 已有时间线内容时不开投影：重连场景的 load_session 回放应被跳过（聚合层拒绝），
    // 否则多客户端会收到重复历史（session-channel prepareLoadSession 路径 1 的 P1 注释）
    if (inReplayWindow && !this.dependencies.docManager.hasSessionDocContent(shared.rcsSessionId)) {
      const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
      if (event.type === "user_message" && !event.turnId && !isTurnWritable(active.turnStatus)) {
        event = { ...event, turnId: createReplayTurnId() };
      } else if (REPLAY_NEEDS_TURN.has(event.type) && !isTurnWritable(active.turnStatus)) {
        // 无头回放：增量无 user_message 开头（中断 turn 的回放），先合成空文本回放 turn
        this.dispatch(shared, {
          type: "user_message",
          update: {},
          content: null,
          acpSessionId: event.acpSessionId,
          turnId: createReplayTurnId(),
        });
      }
    }
    this.dispatch(shared, event);
  }

  /** 投递规范化事件到聚合层（binding 不存在时由 docManager 丢弃） */
  private dispatch(shared: SharedRelay, event: NormalizedEvent): void {
    try {
      this.dependencies.docManager.processNormalizedEvent(shared.rcsSessionId, event);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] processNormalizedEvent failed, event skipped:", err);
    }
  }

  private sendSafeErrorToRcsSession(shared: SharedRelay, code: string, message: string): void {
    this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      this.dependencies.broadcaster.sendToYjsWs(entry.ws, { type: "error", payload: { code, message } });
    });
  }
}
