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
import { clearPendingPromptTimeout, REPLAY_WINDOW_MS, type RelayMessage, type SharedRelay } from "./connection-types";

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

/** 保活类消息类型（与 acp-idle-monitor 的 isIgnoredActivityMessageType 规则一致），不计入业务帧 */
function isKeepaliveMsgType(type: string | undefined): boolean {
  return type === "keep_alive" || type === "heartbeat" || type === "ping" || type === "pong";
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
    const rpcCheck = extractJsonRpc(raw);

    // 每次从 Agent 收到消息时更新活跃时间，防止实例在活跃对话中被空闲回收
    // touchInstanceActivity 内部已过滤 keep_alive/ heartbeat/ping/pong 等保活消息
    this.dependencies.touchInstanceActivity(shared.instanceId, raw);

    // 刷新"最后业务入站帧"时间戳：prompt 超时收敛（gateway 定时器）依赖它判断
    // agent 是否仍在活跃输出。**仅 agent 输出/事件类帧刷新**：session/update 通知
    // 与私有帧（流式输出/工具/权限）代表 agent 活跃；JSON-RPC 响应帧（result/error）
    // 不刷新——否则 10s 一次的 list_sessions 轮询响应会持续刷新时间戳，卡死的
    // prompt（agent 全程静默）永远等不到超时收敛（判定被无限重排，loading 永久）。
    // prompt 自身的 result/error 由 pendingPromptIds 消费分支收敛，不依赖此时间戳。
    const isRpcResponse =
      rpcCheck != null && rpcCheck.id !== undefined && ("result" in rpcCheck || "error" in rpcCheck);
    if (!isKeepaliveMsgType(msgType) && !isRpcResponse) {
      shared.lastInboundAt = Date.now();
    }

    // binding 校验：ACP 帧携带的 sessionId 必须与当前实例绑定的 ACP session 一致，
    // 不一致（过期会话/串流）直接丢弃，不得写入 Y.Doc
    if (rpcCheck?.method === "session/update") {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (msgSessionId) {
        const activeSessionId = registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
        if (activeSessionId && activeSessionId !== msgSessionId) return;
      }
    }

    if (msgType === "relay_closed") {
      return this.handleRelayClosed(shared);
    }

    if (msgType === "error") {
      this.dependencies.reportError("[YJS-FE] agent error", {
        messageType: msgType,
        instanceId: shared.instanceId,
      });
      this.sendSafeErrorToRcsSession(shared, "agent_error", "Agent request failed");
      this.dispatch(shared, {
        type: "turn_failed",
        update: { error: "Agent request failed" },
        content: null,
      });
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", {
        messageType: msgType,
        instanceId: shared.instanceId,
      });
      this.sendSafeErrorToRcsSession(shared, "session_error", "Agent session request failed");
      this.dispatch(shared, {
        type: "turn_failed",
        update: { error: "Agent session request failed" },
        content: null,
      });
      return;
    }

    // 第二级：JSON-RPC 响应帧（id + result/error 且无 method）。通知帧
    // （method 存在，如 session/update）与无 id 帧不落入此处：
    // - 通知帧语义是事件，交给第三级规范化投递；
    // - 无 id 的 result 帧原语义为"无副作用"（登记消费与会话同步都按 id 寻址），
    //   保持不处理（否则会被 normalize 误投递为 prompt_complete）。
    if (rpcCheck && !rpcCheck.method && ("result" in rpcCheck || (rpcCheck.error && rpcCheck.id != null))) {
      return this.handleJsonRpcResponse(shared, raw, msgType, rpcCheck);
    }

    if (msgType === "status") {
      return this.handleStatus(shared, raw);
    }

    // 第三级：规范化事件帧（acp-link 私有帧 / session/update 通知），在此边界
    // 翻译为 session/update 语义投递聚合层。JSON-RPC 响应帧已被第二级拦截
    // （prompt 结果由 handleJsonRpcResponse 投递），此处不再处理 result/error 帧。
    let normalized = normalizeAcpMessage(raw, msgType);
    if (normalized) {
      // 终态归属回传：JSON-RPC prompt 响应帧（result 带 stopReason / error）本身
      // 不携带 turnId，聚合层按 active turn 归位会误伤——连续 prompt 时旧 turn 的
      // 迟到终态会提前终结新 turn（新 turn 增量全被丢弃、答案永不出现）。按
      // pendingPromptTurns 登记把 turnId 附加到事件上，聚合层据此校验归属；
      // 非 prompt 响应帧（list_sessions 等）无登记，保持无 turnId 原语义。
      const promptTurnId =
        rpcCheck?.id !== undefined && rpcCheck.id !== null
          ? shared.pendingPromptTurns?.get(rpcCheck.id as number | string)
          : undefined;
      if (promptTurnId) {
        normalized = { ...normalized, turnId: promptTurnId };
      }
      this.dispatchReplayAware(shared, normalized);
    }
  }

  /**
   * 本地 relay 意外关闭（进程崩溃/被杀）：实例级清理 + turn 收敛 + Doc 销毁
   * （C6 断链语义二）。与 gateway 的引用计数释放（断链语义一：保留 Doc 供重连）
   * 是两条不同 teardown 路径：relay_closed 意味着 Agent 会话已死，必须销毁热缓存，
   * 新实例/新连接将创建全新实时投影，绝不加载旧 Y.Doc。
   */
  private async handleRelayClosed(shared: SharedRelay): Promise<void> {
    const { registry } = this.dependencies;
    // 本地实例的 relay 意外关闭（进程崩溃/被杀）：触发实例级清理，避免死实例
    // 持续占并发额度并被 ensureRunning 无限复用（C-P2.4）。远程实例由
    // terminateLocalDeadInstance 内部的 nodeId 校验排除；主动关闭路径
    // （dispose/stop/idle 回收）的监听器先于 handle close 注销，不会误触发。
    void this.dependencies.terminateLocalDeadInstance(shared.instanceId);
    // 连接丢失迁移边（文档 8.1）：活动 turn 收敛为 interrupted 终态，
    // 晚到增量由聚合层丢弃，UI 不会出现"已断连还在输出"
    this.dispatch(shared, {
      type: "turn_interrupted",
      update: {},
      content: null,
    });
    registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      try {
        this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
          type: "error",
          payload: {
            code: "agent_connection_lost",
            message: "Agent connection lost",
          },
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
  }

  /**
   * Agent status 帧处理（第二级分派）：断连收敛（connected:false → interrupted）、
   * capabilities 就绪判定与 agentStatusReceived 标记、首次就绪触发 list_sessions。
   */
  private async handleStatus(shared: SharedRelay, raw: Record<string, unknown>): Promise<void> {
    const { registry } = this.dependencies;
    const payload = raw.payload as Record<string, unknown> | undefined;
    // Agent 断连（acp-link connection.closed → {connected:false}，子进程死亡不
    // 报错不关 relay）：活动 turn 必须收敛为 interrupted（同 relay_closed 语义），
    // 否则 turn 永久卡 accepting/running、前端 loading 永不消失；晚到增量由
    // 聚合层丢弃。agent_status 投影仍正常执行（capabilities 为空 → initializing）。
    if (payload?.connected === false) {
      this.dispatch(shared, {
        type: "turn_interrupted",
        update: {},
        content: null,
      });
    }
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
  }

  /**
   * JSON-RPC 响应帧处理（第二级分派）：prompt 结果（error 拒绝登记 / result 完成
   * 投递）与会话同步 result（create/load/resume）消费。
   */
  private async handleJsonRpcResponse(
    shared: SharedRelay,
    raw: Record<string, unknown>,
    msgType: string | undefined,
    rpcCheck: Record<string, unknown>,
  ): Promise<void> {
    const { registry } = this.dependencies;
    const rpcId = rpcCheck.id as number | string | null | undefined;

    // error 响应（带 id、无 method 且无法规范化）：Agent 子进程意外退出时
    // acp-link 只重置 connection/sessionId 并回 status {connected:false}，不报错、
    // 不关 relay；prompt 请求以 -32000 "No active session" / -32603 "Prompt failed"
    // 拒绝。静默丢弃会让 turn 永久卡 accepting、前端 loading 永不消失（仅刷新可恢复）。
    // 若该 id 是 send_prompt 出口登记过的在途 prompt，收敛 turn_failed；错误内容
    // 脱敏，只记录 code，不泄露 acp-link 原始错误。未登记的 error 响应无副作用。
    if (rpcCheck.error) {
      const rpcError = rpcCheck.error as Record<string, unknown> | undefined;
      if (rpcId !== undefined && rpcId !== null && shared.pendingPromptIds?.has(rpcId) === true) {
        shared.pendingPromptIds?.delete(rpcId);
        clearPendingPromptTimeout(shared, rpcId);
        // 回传 turnId：聚合层按归属终结对应 turn（stale turn 的迟到终态不误伤新 turn）
        const turnId = shared.pendingPromptTurns?.get(rpcId);
        shared.pendingPromptTurns?.delete(rpcId);
        this.dependencies.reportError("[YJS-FE] prompt rejected by agent", {
          instanceId: shared.instanceId,
          code: rpcError?.code,
        });
        this.dispatch(shared, {
          type: "turn_failed",
          update: { error: "Agent request failed" },
          content: null,
          turnId,
        });
      }
      return;
    }

    // result 响应：先补 prompt 完成投递（原规范化事件投递路径承担：result 带
    // stopReason 的 prompt 响应 → turn_completed，此投递是结果型响应下 turn 完成的
    // 唯一事件来源），再消费登记与会话同步——保持原帧处理顺序（投递先于消费）。
    let normalized = normalizeAcpMessage(raw, msgType);
    if (normalized) {
      // 终态归属回传：见 handleMessage 第三级注释（JSON-RPC prompt 响应无 turnId，
      // 按 pendingPromptTurns 登记附加，聚合层据此校验归属）
      const promptTurnId = rpcId !== undefined && rpcId !== null ? shared.pendingPromptTurns?.get(rpcId) : undefined;
      if (promptTurnId) {
        normalized = { ...normalized, turnId: promptTurnId };
      }
      this.dispatchReplayAware(shared, normalized);
    }

    try {
      const rpc = rpcCheck;
      if (!("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;
      const newSessionId = result.sessionId;
      // 会话同步响应身份校验：JSON-RPC 响应帧只有 id 无 method，无法区分响应来源；
      // 仅放行请求出口登记过的在途 create/load/resume 请求。rename/delete 等其他
      // 携带 sessionId 的响应未经登记必须拒绝——否则 registry 活跃会话被 clobber、
      // 绑定校验丢弃当前会话全部增量（重命名非当前会话即冻结当前输出流）、误开
      // 10s 回放窗口、错误投影 title/status。消费后删除登记，避免 id 空间残留。
      // prompt 成功响应消费：result 到达说明请求已被 agent 正常处理（即时 ack 或
      // 完成时返回），不再需要超时收敛；同时修复成功路径 pendingPromptIds 残留
      // （此前只有 error 路径消费，成功结果会永久占用登记）。
      if (rpcId !== undefined && rpcId !== null && shared.pendingPromptIds?.has(rpcId) === true) {
        shared.pendingPromptIds.delete(rpcId);
        shared.pendingPromptTurns?.delete(rpcId);
        clearPendingPromptTimeout(shared, rpcId);
      }
      const syncRequested = rpcId !== undefined && rpcId !== null && shared.pendingSessionSyncIds?.has(rpcId) === true;
      if (syncRequested) shared.pendingSessionSyncIds?.delete(rpcId);
      if (typeof newSessionId === "string" && newSessionId.length > 0 && syncRequested) {
        // load/resume 成功后开启回放窗口：Agent 即将回放历史增量（无持久化快照时
        // 历史恢复的唯一来源），窗口内由 dispatchReplayAware 补全 turn 上下文投影时间线；
        // 窗口到期定时器收敛回放 turn 终态（回放流无终态信号，见 openReplayWindow）
        this.openReplayWindow(shared);
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
        this.dispatch(shared, {
          type: "session_updated",
          update: {
            sessionId: newSessionId,
            status: "ready",
            // title 投影：session/new、load 响应携带 agent 侧标题；空串视为缺省
            // （与 acp-link list 过滤语义一致），不得用空标题覆盖已有值；缺省时
            // 保持现有值（清空后为 null，前端兜底显示"新会话"——由后续
            // session_list 轮询以权威列表覆盖）
            ...(typeof result.title === "string" && result.title.trim().length > 0 ? { title: result.title } : {}),
            ...(result.models && typeof result.models === "object" ? { modelState: result.models } : {}),
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
   * 开启回放窗口（load/resume 转发前与 JSON-RPC result 确认时各调用一次，幂等重置）：
   * 记录截止时间戳，并注册到期定时器——回放流无终态信号（unstable_resumeSession
   * 只回放 chunk 帧），到期时把窗口内合成/分配的回放 turn 收敛为 completed，
   * 否则回放 turn 永久卡 running、前端一直显示输出中。期间用户发出新消息时
   * 聚合层按 turnId 归属拒绝该终态（见 aggregator.applyTurnTerminal），不误伤新 turn。
   */
  openReplayWindow(shared: SharedRelay): void {
    shared.replayWindowUntil = Date.now() + REPLAY_WINDOW_MS;
    // 窗口开启瞬间判定一次 Chat Doc 是否已有时间线内容（重连跳过回放语义）并缓存：
    // 合成投影本身会写 Chat Doc，若窗口内实时检查，回放自己写入的第一条会把后续
    // 回放帧全部误判为"已有内容"挡住——多轮历史回放只投影第一条（后续全丢）。
    shared.replaySkipSynthesis = this.dependencies.docManager.hasTimelineContent(shared.rcsSessionId);
    if (shared.replayWindowTimer) clearTimeout(shared.replayWindowTimer);
    shared.replayWindowTimer = setTimeout(() => {
      this.convergeReplayWindow(shared);
    }, REPLAY_WINDOW_MS);
  }

  /**
   * 回放窗口到期收敛（openReplayWindow 的定时器到点回调，独立成方法供测试直调）：
   * 关闭窗口并把窗口内合成/分配的回放 turn 收敛为 completed——回放流无终态信号
   * （unstable_resumeSession 只回放 chunk 帧），不收敛则回放 turn 永久卡 running、
   * 前端一直显示输出中。用户已发出新消息时聚合层按 turnId 归属拒绝该终态
   * （aggregator.applyTurnTerminal 的 stale turn 校验），不误伤新 turn。
   * 幂等：窗口未开启或无回放 turn 时 no-op。
   */
  convergeReplayWindow(shared: SharedRelay): void {
    shared.replayWindowUntil = null;
    shared.replaySkipSynthesis = undefined;
    const replayTurnId = shared.replayTurnId;
    shared.replayTurnId = null;
    if (replayTurnId) {
      this.dispatch(shared, {
        type: "turn_completed",
        update: {},
        content: null,
        turnId: replayTurnId,
      });
    }
  }

  /**
   * 回放窗口内的事件投递：Agent 历史回放（load/resume 后）在聚合层 turn 状态机下
   * 没有可写的 turn 上下文，直接投递会被全部拒绝（前端时间线为空）。窗口内且 Chat Doc
   * 无时间线内容时（无持久化快照 / 会话切换已清空）为两类回放形态补全 turn 上下文，
   * 窗口外或 doc 已有内容（重连跳过回放语义，避免重复）保持原语义由聚合层拒绝：
   * - user_message 无 turnId（全量回放开头，或回放内后续消息）→ 一律分配回放 turnId
   *   （含已有活动回放 turn 的场景：不分配会被聚合层以 missing turnId 拒绝而丢失）；
   * - 增量类事件无活动 turn 可写（中断 turn 的无头回放）→ 先合成空文本回放 turn。
   * 实时流 agent 回显（聚合层已有可写 turn，如 registerUserMessage 创建的 turn）不干预，
   * 仍由聚合层拒绝，避免用户消息双写。
   */
  private dispatchReplayAware(shared: SharedRelay, event: NormalizedEvent): void {
    const inReplayWindow = shared.replayWindowUntil !== null && Date.now() < shared.replayWindowUntil;
    // 窗口内跳过合成的判定在窗口开启瞬间固定（shared.replaySkipSynthesis，见
    // openReplayWindow）：重连场景 doc 已有时间线内容时跳过回放投影（聚合层拒绝，
    // 否则多客户端收到重复历史，session-channel prepareLoadSession 路径 1 的 P1 注释）；
    // 空 doc 时允许合成。手动开启窗口（测试直设 replayWindowUntil）时首次事件
    // 缓存判定，窗口内保持一致。
    if (inReplayWindow) {
      if (shared.replaySkipSynthesis === undefined) {
        shared.replaySkipSynthesis = this.dependencies.docManager.hasTimelineContent(shared.rcsSessionId);
      }
      if (!shared.replaySkipSynthesis) {
        const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
        if (event.type === "user_message" && !event.turnId) {
          // 回放内所有无 turnId 的 user_message 都分配回放 turnId：开头无活动 turn、
          // 后续消息有活动回放 turn（聚合层 applyUserMessage 会终结旧回放 turn）
          // 两种情况缺一不可，否则回放历史中的后续用户消息直接丢失
          event = { ...event, turnId: createReplayTurnId() };
          shared.replayTurnId = event.turnId;
        } else if (REPLAY_NEEDS_TURN.has(event.type) && !isTurnWritable(active.turnStatus)) {
          // 无头回放：增量无 user_message 开头（中断 turn 的回放），先合成空文本回放 turn
          const replayTurnId = createReplayTurnId();
          shared.replayTurnId = replayTurnId;
          this.dispatch(shared, {
            type: "user_message",
            update: {},
            content: null,
            acpSessionId: event.acpSessionId,
            turnId: replayTurnId,
          });
        }
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

  /**
   * 收敛卡死的在途 prompt（gateway 超时定时器到点且 agent 全程静默时调用）。
   * 消费登记并清除定时器后收敛 turn_failed——与 error 拒绝路径相同的终态语义，
   * 使前端 loading 不会永久卡死。错误内容脱敏（通用文案），只记录实例上下文。
   */
  convergeStuckPrompt(shared: SharedRelay, rpcId: number | string): void {
    if (!shared.pendingPromptIds?.has(rpcId)) return;
    shared.pendingPromptIds.delete(rpcId);
    clearPendingPromptTimeout(shared, rpcId);
    // 回传 turnId：聚合层按归属终结对应 turn（stale turn 的迟到终态不误伤新 turn）
    const turnId = shared.pendingPromptTurns?.get(rpcId);
    shared.pendingPromptTurns?.delete(rpcId);
    this.dependencies.reportError("[YJS-FE] prompt timed out (no agent response)", {
      instanceId: shared.instanceId,
    });
    this.dispatch(shared, {
      type: "turn_failed",
      update: { error: "Agent request failed" },
      content: null,
      turnId,
    });
  }

  private sendSafeErrorToRcsSession(shared: SharedRelay, code: string, message: string): void {
    this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
        type: "error",
        payload: { code, message },
      });
    });
  }
}
