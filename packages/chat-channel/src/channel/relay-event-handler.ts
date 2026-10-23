import { agentRuntimeError } from "./relay-errors";
import type { RelayEventHandlerDependencies } from "./relay-event-dependencies";

export type { RelayEventHandlerDependencies } from "./relay-event-dependencies";

import { extractJsonRpc, normalizeAcpMessage, translateSimpleAction } from "../protocol";
import { PERI_AGENT_EVENT_DONE_METHOD, type PublicError, SESSION_BOUND_NOTIFICATION_METHODS } from "../schema";
import { resetUserInputQueue, setUserInputQueueEnabled } from "../state/user-input-queue";
import type { RelayMessage, SharedRelay } from "./connection-types";
import { RelayProjection } from "./relay-projection";
import { RelayRpcResponse } from "./relay-rpc-response";
// packages/chat-channel/src/channel/relay-event-handler.ts
// RelayEventHandler：共享 relay 唯一的入站消息消费者。
//
// 迁移自 src/transport/relay/yjs-frontend/relay-event-handler.ts，语义原样保留；
// 宿主能力（空闲活动标记、本地死实例清理）收敛为依赖注入（C6）：
// - acp-link 私有帧在此边界翻译为规范化事件（session/update 语义）后投递聚合层；
// - relay_closed（Instance ACP session 断链）触发两类清理：宿主侧实例级回收
//   （terminateLocalDeadInstance 注入）与本节点实时资源删除（Chat Doc / Session Doc /
//   广播订阅），保证新实例创建全新投影、绝不加载旧 Y.Doc（C6 断链语义）；
// - 实例确认停止后的全量实时资源回收（SP-C2）：bindInstanceSession 登记
//   instanceId → rcsSessionId 单活归属（gateway 创建 relay 时注入；后继实例
//   重绑同一会话即刻剥夺旧实例归属，防止旧实例停止回收销毁接管实例正在写入
//   的实时 Doc），宿主在 stopInstanceViaController 完成处调用
//   reclaimInstanceRealtimeResources 统一关闭该实例名下全部内存 Doc，补齐
//   relay 已释放（无 relay_closed 可达）的回收路径（idle reclaim / 死实例
//   清理 / 机器幽灵清理）。

import { failPendingSessionMutations } from "./session-mutation";
import { failPendingUserInputRequests } from "./user-input-pending";
import { ensureUserInputQueueSnapshot } from "./user-input-queue-action";
import { readUserInputQueueCapability } from "./user-input-queue-wire";

/** 共享 relay 唯一的入站消息消费者。 */
export class RelayEventHandler {
  /**
   * instanceId → 该实例当前归属的 rcsSessionId 集合（SP-C2）。
   * 由 gateway 在 relay 创建时经 bindInstanceSession 登记；登记必须跨越 relay
   * 引用计数归零存活——relay 释放（closeReleasedRelay）不产生 relay_closed，
   * 实例停止回收时是唯一的 instanceId → rcsSessionId 映射来源。
   *
   * 单活归属：同一 rcsSessionId 任一时间只属于一个实例（实时 Doc 按
   * rcsSessionId 键控，物理上无法按实例共享）。旧实例停止窗口内
   * （stopInstanceViaController 已移出编排域活跃表、facade.stopInstance 尚在途）
   * 客户端自动重连会 spawn 新实例并重绑同一 rcsSessionId——bindInstanceSession
   * 此刻剥夺旧实例归属，旧实例停止完成后的回收随之跳过该会话，避免销毁新实例
   * 正在写入的实时 Doc。
   *
   * 绑定条目的最终删除依赖前提：所有实例移除路径都汇聚到回收 funnel——
   * stopInstanceViaController 完成点（idle/activity reclaim、手动停止、
   * agent-chat-service dispose、terminateLocalDeadInstance、stopAllInstances）
   * 与远程机器幽灵清理（orchestration-machine-cleanup → reclaimInstanceYjsDocs）。
   * 新增实例移除路径时必须同步接入，否则 instanceSessions 条目与该实例名下
   * 保留的实时 Doc 将永久泄漏。
   */
  private readonly instanceSessions = new Map<string, Set<string>>();

  private readonly projection: RelayProjection;
  private readonly responses: RelayRpcResponse;
  constructor(private readonly dependencies: RelayEventHandlerDependencies) {
    this.projection = new RelayProjection(dependencies);
    this.responses = new RelayRpcResponse(dependencies, this.projection);
  }

  createMessageHandler(shared: SharedRelay): (message: RelayMessage) => Promise<void> {
    return async (message) => {
      try {
        await this.handleMessage(shared, message);
      } catch (err) {
        this.dependencies.reportError(`[YJS-FE] relay event processing failed: instanceId=${shared.instanceId}`, err);
      } finally {
        shared.checkRetention?.();
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

    // binding 校验：session-bound ACP 通知（session/update、peri/agent_event、
    // peri/unstable_event）携带的 sessionId 必须与当前实例绑定的 ACP session 一致，
    // 不一致（过期会话/串流）直接丢弃，不得写入 Y.Doc——扩展自原 session/update
    // 单方法检查，防止旧 session 的 Peri 事件写入当前 rcsSessionId。
    if (typeof rpcCheck?.method === "string" && SESSION_BOUND_NOTIFICATION_METHODS.has(rpcCheck.method)) {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (msgSessionId) {
        const activeSessionId =
          shared.pendingSessionTarget?.sessionId ?? registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
        if (activeSessionId && activeSessionId !== msgSessionId) {
          // 脱敏计数观测（规格 §五）：只记录 method（低基数），不记录 payload/sessionId
          this.dependencies.reportError("[YJS-FE] peri task session mismatch", {
            method: rpcCheck.method,
            instanceId: shared.instanceId,
          });
          return;
        }
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
      const publicError = agentRuntimeError("AGENT_RUNTIME.REQUEST_FAILED", "relay.agent_error", this.dependencies.log);
      this.sendSafeErrorToRcsSession(shared, publicError);
      this.projection.dispatch(shared, {
        type: "turn_failed",
        update: { publicError },
        content: null,
      });
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", {
        messageType: msgType,
        instanceId: shared.instanceId,
      });
      const publicError = agentRuntimeError(
        "AGENT_RUNTIME.SESSION_FAILED",
        "relay.session_error",
        this.dependencies.log,
      );
      this.sendSafeErrorToRcsSession(shared, publicError);
      this.projection.dispatch(shared, {
        type: "turn_failed",
        update: { publicError },
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
      return this.responses.handleJsonRpcResponse(shared, raw, msgType, rpcCheck);
    }

    if (msgType === "status") {
      return this.handleStatus(shared, raw);
    }

    // 显式完成优先于静默计时，零历史也可立即收口。
    if (rpcCheck?.method === "session/replay_complete") {
      this.convergeReplayWindow(shared);
      return;
    }

    if (rpcCheck?.method === "session/update") this.projection.scheduleReplayCompletion(shared);

    // 第三级：规范化事件帧（acp-link 私有帧 / session/update 通知），在此边界
    // 翻译为 session/update 语义投递聚合层。JSON-RPC 响应帧已被第二级拦截
    // （prompt 结果由 handleJsonRpcResponse 投递），此处不再处理 result/error 帧。
    let normalized = normalizeAcpMessage(raw, msgType);
    const periMethod = rpcCheck?.method;
    if (
      periMethod === "peri/agent_event" ||
      periMethod === "peri/unstable_event" ||
      periMethod === PERI_AGENT_EVENT_DONE_METHOD
    ) {
      this.dependencies.log?.(
        `[YJS-FE] Peri notification normalized: method=${periMethod} result=${normalized?.type ?? "ignored"}`,
      );
    }
    if (normalized) {
      if (normalized.type === "session_list") {
        try {
          if (!(await this.dependencies.docManager.refreshSessionTitles(shared.rcsSessionId))) return;
        } catch (error) {
          this.dependencies.reportError("[YJS-FE] session title metadata read failed", error);
          return;
        }
      }
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
      this.projection.dispatchReplayAware(shared, normalized);
    }
  }

  /**
   * 本地 relay 意外关闭（进程崩溃/被杀）：实例级清理 + turn 收敛 + Doc 销毁
   * （C6 断链语义二）。与 gateway 的引用计数释放（断链语义一：保留 Doc 供重连）
   * 是两条不同 teardown 路径：relay_closed 意味着 Agent 会话已死，必须销毁热缓存，
   * 新实例/新连接将创建全新实时投影，绝不加载旧 Y.Doc。实例停止回收
   * （reclaimInstanceRealtimeResources）是第三条路径：relay 已释放（无
   * relay_closed 可达）但实例随后确认停止时，按 instanceId 统一回收。
   * 例外：后继实例已接管该会话（单活归属易主）时跳过 Doc 销毁，见下方
   * eligibleForDispose 注释。
   */
  private async handleRelayClosed(shared: SharedRelay): Promise<void> {
    if (!this.isCurrentRelay(shared)) return;
    const { registry } = this.dependencies;
    if (this.isCurrentRelay(shared)) this.dependencies.invalidateRuntimeSession?.(shared.rcsSessionId);
    failPendingSessionMutations(shared);
    // 在途 steer 请求一并收敛为失败：Agent 会话已死，回执不可达，继续等待只会让前端
    // 停在"发送中"（同 failPendingSessionMutations 语义，不重试）。
    failPendingUserInputRequests(shared);
    // relay 意外关闭是 Agent Runtime 故障：同一公开错误必须先进入日志、Y.Doc 与 WS，
    // 再关闭连接；close code 仅承担连接生命周期语义。
    const publicError = agentRuntimeError(
      "AGENT_RUNTIME.DISCONNECTED",
      "relay.connection_closed",
      this.dependencies.log,
    );
    this.projection.dispatch(shared, {
      type: "turn_failed",
      update: { publicError },
      content: null,
    });
    registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      try {
        this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
          type: "error",
          payload: publicError,
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
    // 归属防误伤：后继实例已接管该会话（旧实例停止窗口内客户端重连 spawn 新实例
    // 并重绑后，本 relay 才收到迟到断链）时不销毁实时 Doc——客户端已被 1011 关闭
    // 并自动重连到后继实例，Doc 保留即可无缝续流；销毁只会静默冻结新实例的实时流。
    const eligibleForDispose = () => {
      const owner = this.findSessionOwner(shared.rcsSessionId);
      return owner === undefined || owner === shared.instanceId;
    };
    if (eligibleForDispose()) {
      await this.disposeRealtimeResources(shared.rcsSessionId, eligibleForDispose);
    }
  }

  /** 迟到旧 relay 不得作废已经由后继实例接管的会话确认。 */
  private isCurrentRelay(shared: SharedRelay): boolean {
    const current = this.dependencies.registry.getShared(shared.instanceId, shared.userId, shared.rcsSessionId);
    const owner = this.findSessionOwner(shared.rcsSessionId);
    return (
      !shared.destroyed && (!current || current === shared) && (owner === undefined || owner === shared.instanceId)
    );
  }

  // ── 实例级实时资源回收（SP-C2）──

  /**
   * 登记实例与 RCS 会话的实时资源归属（gateway 在共享 relay 创建时调用）。
   * 幂等：重复登记（重连后 relay 重建）只保留一个集合条目。
   *
   * 单活归属转移：把该 rcsSessionId 从其他实例的绑定集合中移除——后继实例接管
   * 即刻剥夺旧实例的回收权。不转移的后果：旧实例停止完成（stopInstanceViaController
   * 末尾）后的回收会按旧登记无条件销毁新实例正在写入的实时 Doc，之后
   * processNormalizedEvent 对该会话全部丢事件，前端连接保持打开但静默冻结
   * （无错误帧、无 turn 收敛）；该会话交由现持有实例停止时回收。
   */
  bindInstanceSession(instanceId: string, rcsSessionId: string): void {
    for (const [owner, sessions] of this.instanceSessions) {
      if (owner !== instanceId) sessions.delete(rcsSessionId);
    }
    let sessions = this.instanceSessions.get(instanceId);
    if (!sessions) {
      sessions = new Set();
      this.instanceSessions.set(instanceId, sessions);
    }
    sessions.add(rcsSessionId);
  }

  /** 查询 rcsSessionId 当前的归属实例；未登记（无主）时返回 undefined。 */
  private findSessionOwner(rcsSessionId: string): string | undefined {
    for (const [owner, sessions] of this.instanceSessions) {
      if (sessions.has(rcsSessionId)) return owner;
    }
    return;
  }

  /**
   * 实例确认停止后回收其名下全部内存 Doc 与广播订阅（SP-C2）。
   *
   * 调用契约：宿主只在实例停止完成点调用（stopInstanceViaController 末尾与
   * 机器幽灵清理 orchestration-machine-cleanup，覆盖 idle reclaim 4001 路径、
   * terminateLocalDeadInstance 回收与远程机器断连/重连清理）。**绝对禁止**
   * 在"前端连接断开但实例可能存活"时调用本方法回收 Doc：重连后 handleOpen 的
   * openChat 依赖内存中的实时 Doc 同步投影，且 processNormalizedEvent 对不在
   * 内存的会话直接丢事件（doc-manager 绑定规则）——提前关闭等于丢弃实时流
   * （C6 断链语义一，与 gateway.releaseRelay 的保留约束一致）。
   *
   * 归属防误伤：逐会话回收前校验单活归属——该会话已被后继实例接管（旧实例
   * 停止窗口内客户端重连 spawn 新实例并重绑）时跳过，交由现持有实例停止时
   * 回收；回收 await 窗口内发生接管同样中止（disposeRealtimeResources 的逐步
   * 资格校验）。
   *
   * 先删除登记再逐会话回收：并发触发（relay_closed 与实例停止回收竞争）时
   * 最多一方执行，disposeRealtimeResources 本身幂等（Map miss 即 no-op）。
   */
  async reclaimInstanceRealtimeResources(instanceId: string): Promise<void> {
    const sessions = this.instanceSessions.get(instanceId);
    if (!sessions) return;
    this.instanceSessions.delete(instanceId);
    for (const rcsSessionId of sessions) {
      // 自身登记已删除：仅无主（无任何实例归属）时才回收；被后继实例接管即跳过
      const eligible = () => this.findSessionOwner(rcsSessionId) === undefined;
      if (!eligible()) continue;
      await this.disposeRealtimeResources(rcsSessionId, eligible);
    }
  }

  /**
   * 注销广播监听并销毁该 rcsSessionId 的 Chat / Session Doc。
   * relay_closed（本 binding 断链）与实例停止回收（实例名下全部 binding）共用；
   * closeChat/closeSession 内部触发 provider.destroy（Redis 快照 flush）与
   * ydoc.destroy，Map 未命中时为 no-op（幂等）。
   *
   * eligible 为逐步资格校验：close 的 await 窗口（Redis flush）内后继实例可能
   * 重绑并重开同名 Doc，失去资格时立即中止——继续执行会注销后继实例刚注册的
   * 广播监听、销毁其刚重建的 Doc，令其前端连接静默冻结。
   */
  private async disposeRealtimeResources(rcsSessionId: string, eligible: () => boolean): Promise<void> {
    if (!eligible()) return;
    try {
      this.dependencies.broadcaster.unregisterYjsDocListener(`chat:${rcsSessionId}`);
      this.dependencies.broadcaster.unregisterYjsDocListener(`session:${rcsSessionId}`);
    } catch {
      /* ignore */
    }
    try {
      await this.dependencies.docManager.closeChat(rcsSessionId);
      if (!eligible()) return;
      await this.dependencies.docManager.closeSession(rcsSessionId);
    } catch (err) {
      this.dependencies.reportError(`[YJS-FE] failed to dispose realtime resources: rcsSessionId=${rcsSessionId}`, err);
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
      if (!this.isCurrentRelay(shared)) return;
      this.dependencies.invalidateRuntimeSession?.(shared.rcsSessionId);
      registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
        entry.sessionLoaded = false;
      });
      // Agent 断连（可能伴随重启）：清空补拉标记，使重连后的就绪 status 重新补拉一次
      // 队列快照（新进程的 generation 与旧投影不同，不补拉会让用户带着旧代号重试并被
      // -32602 拒绝一次）。能力位保留，等下一次就绪 status 覆盖。
      if (shared.refCount === 0) shared.releaseRetained?.();
      shared.userInputSnapshotSessionId = null;
      // 断连换代：peri 队列不跨进程持久，旧 items/generation 必须清空——否则在新快照
      // 到达前前端仍渲染旧代号的「可点」待发送项，点击必被 -32602 拒绝。enabled 同步
      // 置 false 回退旧路径，由下一次就绪 status 的能力协商重新打开。
      const sessionDoc = this.dependencies.docManager.getSessionYdoc(shared.rcsSessionId);
      if (sessionDoc) {
        resetUserInputQueue(sessionDoc);
        setUserInputQueueEnabled(sessionDoc, false);
      }
      this.projection.dispatch(shared, {
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
      // 待发送队列能力协商：peri 把 initialize 的 clientCapabilities._meta 原样回显到
      // agentCapabilities._meta（acp-link 已声明 `peri.userInputQueue`）。协商成功才补拉
      // 一次快照（读操作）并把投影 enabled 置真；未协商保持 false，读取侧回退旧路径
      // （直发 prompt，即"运行中提交 = 打断"），补拉失败也只置 enabled=false，不影响会话可用性。
      const queueCapable = readUserInputQueueCapability(capabilities);
      shared.userInputQueueCapability = queueCapable;
      if (queueCapable) {
        // 不 await：status 处理不得被队列 RPC 往返阻塞（超时上限见 DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS）
        void ensureUserInputQueueSnapshot({
          shared,
          sessionId: registry.findActiveSessionIdByRcsSession(shared.rcsSessionId) ?? null,
          docManager: this.dependencies.docManager,
          reportError: this.dependencies.reportError,
        });
      }
      this.projection.dispatch(shared, {
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
    this.projection.dispatch(shared, {
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

  /** 为目标会话的历史增量建立有限回放窗口。 */
  openReplayWindow(shared: SharedRelay, options: { resampleSkip?: boolean } = {}): void {
    this.projection.openReplayWindow(shared, options);
  }

  /** 将已到期回放收敛为终态。 */
  convergeReplayWindow(shared: SharedRelay): void {
    this.projection.convergeReplayWindow(shared);
  }

  private sendSafeErrorToRcsSession(shared: SharedRelay, error: PublicError): void {
    this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
        type: "error",
        payload: error,
      });
    });
  }
}
