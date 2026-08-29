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

import type * as Y from "yjs";
import { extractJsonRpc, normalizeAcpMessage, translateSimpleAction } from "../protocol";
import {
  type NormalizedEvent,
  type NormalizedEventType,
  SESSION_BOUND_NOTIFICATION_METHODS,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
} from "../schema";
import type { DocManager } from "../state";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import {
  beginRpcResponse,
  claimPendingRpcAbort,
  claimRelayRpcTeardown,
  cleanupAbortedRpc,
  getActiveSessionTransition,
  isPendingRpcCurrent,
  markPendingRpcSent,
  type PendingRpc,
  REPLAY_WINDOW_MS,
  type RelayMessage,
  reserveRelayRpc,
  type SharedRelay,
  settlePendingRpc,
} from "./connection-types";

/** 需要活动 turn 才能投影的增量类事件（无头回放流的开头需要合成回放 turn） */
const REPLAY_NEEDS_TURN: ReadonlySet<NormalizedEventType> = new Set([
  "reasoning_delta",
  "message_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "tool_call_failed",
  "permission_requested",
  // AskUserQuestion 可能是 Agent 恢复后的首个业务帧；没有可写 turn 时必须与
  // permission 一样先补建回放 turn，否则聚合层会拒绝投影，前端不会显示提问面板。
  "question_requested",
]);

/** callback assistant 可消费的 turn 终态。 */
const CALLBACK_TERMINAL_TYPES: ReadonlySet<NormalizedEventType> = new Set([
  "turn_completed",
  "turn_cancelled",
  "turn_failed",
  "turn_interrupted",
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
  registerYjsDocListener: (ydoc: Y.Doc, docName: string, generation?: string) => void;
  reportError: (message: string, error: unknown) => void;
  /** 每次从 Agent 收到消息时更新实例活跃时间（宿主注入，内部过滤保活消息） */
  touchInstanceActivity: (instanceId: string, raw: Record<string, unknown>) => void;
  /** 本地死实例回收（宿主注入：内部校验 nodeId；远程实例由机器级清理覆盖——该路径同样触发实时 Doc 回收） */
  terminateLocalDeadInstance: (instanceId: string) => void;
  /** 安全诊断日志：只记录低基数 method/type，不得记录 payload 或会话标识。 */
  log?: (message: string) => void;
}

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
    // prompt 自身的 result/error 由唯一 pending RPC owner 分支收敛，不依赖此时间戳。
    const isRpcResponse =
      rpcCheck != null && rpcCheck.id !== undefined && ("result" in rpcCheck || "error" in rpcCheck);
    if (!isKeepaliveMsgType(msgType) && !isRpcResponse) {
      shared.lastInboundAt = Date.now();
    }

    // binding 校验：session-bound ACP 通知（session/update、peri/agent_event、
    // peri/unstable_event）携带的 sessionId 必须与当前实例绑定的 ACP session 一致，
    // 不一致（过期会话/串流）直接丢弃，不得写入 Y.Doc——扩展自原 session/update
    // 单方法检查，防止旧 session 的 Peri 事件写入当前 rcsSessionId。
    if (typeof rpcCheck?.method === "string" && SESSION_BOUND_NOTIFICATION_METHODS.has(rpcCheck.method)) {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId;
      if (typeof msgSessionId !== "string" || msgSessionId.length === 0) {
        this.dependencies.reportError("[YJS-FE] session-bound notification missing sessionId", {
          method: rpcCheck.method,
          instanceId: shared.instanceId,
        });
        return;
      }

      const transition = getActiveSessionTransition(shared);
      if (transition?.owner.kind === "session-sync") {
        const normalized = normalizeAcpMessage(raw, msgType);
        if (normalized) {
          const queued = transition.owner.lifecycle.queueEvent(normalized);
          if (queued === "queued" || queued === "ignored") return;
          this.dependencies.reportError("[YJS-FE] session transition event buffer overflow", {
            method: rpcCheck.method,
            instanceId: shared.instanceId,
          });
          this.abortSessionSync(shared, transition, "buffer_overflow");
          return;
        }
      }
      const activeSessionId = registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
      if (activeSessionId && activeSessionId !== msgSessionId) {
        this.dependencies.reportError("[YJS-FE] peri task session mismatch", {
          method: rpcCheck.method,
          instanceId: shared.instanceId,
        });
        return;
      }
    }

    if (msgType === "relay_closed") {
      return this.handleRelayClosed(shared);
    }

    // 所有无 method 的 JSON-RPC result/error 都在请求所有权边界拦截。无 id 帧直接丢弃，
    // 不得进入 normalizer 后按响应到达时的 active turn 猜测归属。
    if (rpcCheck && !rpcCheck.method && ("result" in rpcCheck || "error" in rpcCheck)) {
      return this.handleJsonRpcResponse(shared, raw, msgType, rpcCheck);
    }

    if (msgType === "error") {
      this.dependencies.reportError("[YJS-FE] agent error", {
        messageType: msgType,
        instanceId: shared.instanceId,
      });
      this.sendSafeErrorToRcsSession(shared, "agent_error", "Agent request failed");
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", {
        messageType: msgType,
        instanceId: shared.instanceId,
      });
      this.sendSafeErrorToRcsSession(shared, "session_error", "Agent session request failed");
      return;
    }

    // 第二级 JSON-RPC 响应已在通用 error 帧之前拦截，避免无 id error 下沉 normalizer。
    if (msgType === "status") {
      return this.handleStatus(shared, raw);
    }

    // 第三级：规范化事件帧（acp-link 私有帧 / session/update 通知），在此边界
    // 翻译为 session/update 语义投递聚合层。JSON-RPC 响应帧已被第二级拦截
    // （prompt 结果由 handleJsonRpcResponse 投递），此处不再处理 result/error 帧。
    const normalized = normalizeAcpMessage(raw, msgType);
    const periMethod = rpcCheck?.method;
    if (periMethod === "peri/agent_event" || periMethod === "peri/unstable_event") {
      this.dependencies.log?.(
        `[YJS-FE] Peri notification normalized: method=${periMethod} result=${normalized?.type ?? "ignored"}`,
      );
    }
    if (normalized) {
      // 非 response 的通知只携带自身显式 turnId；禁止从响应到达时的 active turn 推断归属。
      this.dispatchReplayAware(shared, normalized);
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
    const teardown = claimRelayRpcTeardown(shared, "relay_closed");
    if (!teardown.primary) {
      await teardown.cleanup;
      return;
    }

    // teardown claim 已在任何 await 前冻结物理 handle 上的全部 owner。回放窗口属于
    // request 的精确包装，不能统一按最先收到 relay_closed 的包装关闭。
    for (const request of teardown.requests) {
      if (request.owner.kind === "session-sync") this.closeReplayWindow(request.relay, request);
    }
    await teardown.cleanup;

    const { registry } = this.dependencies;
    const isCurrentRelay = (relay: SharedRelay) => {
      const registered = registry.getShared(relay.instanceId, relay.userId, relay.rcsSessionId);
      return registered === undefined || registered === relay;
    };
    const currentRelays = teardown.relays.filter(isCurrentRelay);
    if (currentRelays.length === 0) return;

    // 同一物理 handle 可被多个 RCS session 包装。请求按其精确包装投递，并以
    // rcsSessionId + turnId 去重，确保一个 turn 只收敛一次且不会写入另一会话。
    const interruptedTurns = new Map<string, { relay: SharedRelay; turnId: string }>();
    for (const request of teardown.requests) {
      if (!isCurrentRelay(request.relay)) continue;
      if ((request.owner.kind === "prompt" || request.owner.kind === "cancel") && request.owner.turnId) {
        interruptedTurns.set(`${request.relay.rcsSessionId}\u0000${request.owner.turnId}`, {
          relay: request.relay,
          turnId: request.owner.turnId,
        });
      }
    }
    for (const { relay, turnId } of interruptedTurns.values()) {
      this.dispatch(relay, {
        type: "turn_interrupted",
        update: {},
        content: null,
        turnId,
      });
    }

    // 本地实例的 relay 意外关闭（进程崩溃/被杀）：触发实例级清理，避免死实例
    // 持续占并发额度。多个包装可能属于同一实例，宿主清理只触发一次。
    for (const instanceId of new Set(currentRelays.map((relay) => relay.instanceId))) {
      void this.dependencies.terminateLocalDeadInstance(instanceId);
    }

    const relaysBySession = new Map<string, SharedRelay>();
    for (const relay of currentRelays) {
      if (isCurrentRelay(relay)) relaysBySession.set(relay.rcsSessionId, relay);
    }
    for (const relay of relaysBySession.values()) {
      registry.forEachByRcsSession(relay.rcsSessionId, (entry) => {
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

      // 精确 wrapper identity 与实例归属共同构成 projection incarnation fence：
      // await 窗口内若后继 relay 接管，立即失去销毁当前 Doc 的资格。
      const eligibleForDispose = () => {
        if (!isCurrentRelay(relay)) return false;
        const owner = this.findSessionOwner(relay.rcsSessionId);
        return owner === undefined || owner === relay.instanceId;
      };
      if (eligibleForDispose()) {
        await this.disposeRealtimeResources(relay.rcsSessionId, eligibleForDispose);
      }
    }
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
      this.dispatchReplayAware(shared, {
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
          const request = reserveRelayRpc(shared, { kind: "session-list" });
          await shared.handle.send(
            translateSimpleAction({ action: "list_sessions" }, shared.workspacePath, request.id) as never,
          );
          markPendingRpcSent(request);
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
    const rpcId = rpcCheck.id as number | string | null | undefined;
    if (rpcId === undefined || rpcId === null) return;

    const owner = beginRpcResponse(shared, rpcId);
    if (!owner) return;
    const processing = this.processOwnedResponse(shared, raw, msgType, rpcCheck, owner);
    owner.responsePromise = processing;
    try {
      await processing;
    } finally {
      if (owner.responsePromise === processing) owner.responsePromise = null;
      settlePendingRpc(owner);
    }
  }

  private async processOwnedResponse(
    shared: SharedRelay,
    raw: Record<string, unknown>,
    msgType: string | undefined,
    rpcCheck: Record<string, unknown>,
    owner: PendingRpc,
  ): Promise<void> {
    if (rpcCheck.error) {
      if (owner.owner.kind === "prompt") {
        const rpcError = rpcCheck.error as Record<string, unknown> | undefined;
        this.dependencies.reportError("[YJS-FE] prompt rejected by agent", {
          instanceId: shared.instanceId,
          code: rpcError?.code,
        });
        if (owner.owner.turnId) {
          this.dispatchReplayAware(shared, {
            type: "turn_failed",
            update: { error: "Agent request failed" },
            content: null,
            turnId: owner.owner.turnId,
          });
        }
      }
      if (owner.owner.kind === "session-sync") await this.rollbackSessionSync(shared, owner);
      return;
    }

    if (!("result" in rpcCheck)) {
      if (owner.owner.kind === "session-sync") await this.rollbackSessionSync(shared, owner);
      return;
    }
    const result = rpcCheck.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") {
      if (owner.owner.kind === "session-sync") await this.rollbackSessionSync(shared, owner);
      return;
    }

    if (owner.owner.kind === "prompt") {
      if (!("stopReason" in result) || !owner.owner.turnId) return;
      const normalized = normalizeAcpMessage(raw, msgType);
      if (normalized) this.dispatchReplayAware(shared, { ...normalized, turnId: owner.owner.turnId });
      return;
    }

    if (owner.owner.kind === "cancel") {
      if (result.cancelled === true && owner.owner.turnId) {
        const normalized = normalizeAcpMessage(raw, msgType);
        if (normalized) this.dispatchReplayAware(shared, { ...normalized, turnId: owner.owner.turnId });
      }
      return;
    }

    if (owner.owner.kind === "session-list") {
      if (Array.isArray(result.sessions)) {
        const normalized = normalizeAcpMessage(raw, msgType);
        if (normalized) this.dispatchReplayAware(shared, normalized);
      }
      return;
    }

    if (owner.owner.kind !== "session-sync") return;
    const newSessionId = result.sessionId;
    if (typeof newSessionId !== "string" || newSessionId.length === 0) {
      await this.rollbackSessionSync(shared, owner);
      return;
    }
    try {
      if (!(await owner.owner.lifecycle.commit(result, () => isPendingRpcCurrent(owner)))) {
        await this.rollbackSessionSync(shared, owner);
        return;
      }
      if (!isPendingRpcCurrent(owner)) return;
      if (owner.owner.lifecycle.replay) this.openReplayWindow(shared, owner);
      const sessionDoc = this.dependencies.docManager.getSession(shared.rcsSessionId);
      if (!sessionDoc || !isPendingRpcCurrent(owner)) return;
      this.dependencies.registerYjsDocListener(
        sessionDoc.ydoc,
        `session:${shared.rcsSessionId}`,
        sessionDoc.generation,
      );
      this.dispatch(shared, {
        type: "session_updated",
        update: {
          sessionId: newSessionId,
          status: "ready",
          ...(typeof result.title === "string" && result.title.trim().length > 0 ? { title: result.title } : {}),
          ...(result.models && typeof result.models === "object" ? { modelState: result.models } : {}),
          ...(result.modes && typeof result.modes === "object" ? { modeState: result.modes } : {}),
        },
        content: null,
      });
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] session sync failed:", err);
      await this.rollbackSessionSync(shared, owner);
    }
  }

  private async rollbackSessionSync(shared: SharedRelay, request: PendingRpc): Promise<void> {
    this.closeReplayWindow(shared, request);
    if (request.owner.kind !== "session-sync") return;
    try {
      await request.owner.lifecycle.rollback();
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] session sync rollback failed:", err);
    }
  }

  /** timeout/缓冲溢出路径先同步剥夺 owner，再异步销毁候选。 */
  abortSessionSync(shared: SharedRelay, request: PendingRpc, _reason: "timeout" | "buffer_overflow"): void {
    if (request.owner.kind !== "session-sync" || !claimPendingRpcAbort(request)) return;
    this.closeReplayWindow(shared, request);
    void cleanupAbortedRpc(request).catch((err) => {
      this.dependencies.reportError("[YJS-FE] session sync rollback failed:", err);
    });
  }

  /**
   * 开启回放窗口（load/resume 转发前与 JSON-RPC result 确认时各调用一次，幂等重置）：
   * 记录截止时间戳，并注册到期定时器——回放流无终态信号（unstable_resumeSession
   * 只回放 chunk 帧），到期时把窗口内合成/分配的回放 turn 收敛为 completed，
   * 否则回放 turn 永久卡 running、前端一直显示输出中。期间用户发出新消息时
   * 聚合层按 turnId 归属拒绝该终态（见 aggregator.applyTurnTerminal），不误伤新 turn。
   */
  openReplayWindow(shared: SharedRelay, owner?: PendingRpc): void {
    if (owner) shared.replayWindowOwner = owner;
    shared.replayWindowUntil = Date.now() + REPLAY_WINDOW_MS;
    // 窗口开启瞬间判定一次 Chat Doc 是否已有时间线内容（重连跳过回放语义）并缓存：
    // 合成投影本身会写 Chat Doc，若窗口内实时检查，回放自己写入的第一条会把后续
    // 回放帧全部误判为"已有内容"挡住——多轮历史回放只投影第一条（后续全丢）。
    shared.replaySkipSynthesis = this.dependencies.docManager.hasTimelineContent(shared.rcsSessionId);
    if (shared.replayWindowTimer) clearTimeout(shared.replayWindowTimer);
    shared.replayWindowTimer = setTimeout(() => {
      if (owner && shared.replayWindowOwner !== owner) return;
      this.convergeReplayWindow(shared);
    }, REPLAY_WINDOW_MS);
  }

  /** 仅拥有当前 replay window 的 session-sync 请求可在失败路径关闭窗口。 */
  closeReplayWindow(shared: SharedRelay, owner: PendingRpc): boolean {
    if (shared.replayWindowOwner !== owner) return false;
    if (shared.replayWindowTimer) clearTimeout(shared.replayWindowTimer);
    shared.replayWindowTimer = null;
    shared.replayWindowOwner = null;
    shared.replayWindowUntil = null;
    shared.replaySkipSynthesis = undefined;
    shared.replayTurnId = null;
    return true;
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
    shared.replayWindowOwner = null;
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
    const currentCallback = shared.callbackAssistant;
    if (!inReplayWindow && event.type === "user_message" && !event.turnId) {
      // 新 callback 用户消息是明确的时间线边界；先收敛尚未结束的上一条，避免
      // 替换路由指针后留下永久 streaming/pending 的孤儿 assistant entry。
      if (currentCallback) {
        this.dispatchCallbackTerminal(shared, currentCallback, {
          type: "turn_completed",
          update: {},
          content: null,
        });
      }
      const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
      const callbackAssistant = {
        entryId: `callback_${crypto.randomUUID()}`,
        ownerTurnId: isTurnWritable(active.turnStatus) ? active.turnId : null,
      };
      shared.callbackAssistant = callbackAssistant;
      event = { ...event, callbackEntryId: callbackAssistant.entryId };
    } else if (CALLBACK_TERMINAL_TYPES.has(event.type) && event.turnId) {
      // 带 turnId 的 prompt 终态仍归属于主 turn；若当前 callback 在该 turn 内创建，
      // 再以同一终态收敛它。所有权不匹配时保持新 callback，避免旧终态迟到误清理。
      this.dispatch(shared, event);
      const callback = shared.callbackAssistant;
      if (callback?.ownerTurnId === event.turnId) {
        this.dispatchCallbackTerminal(shared, callback, event);
      }
      return;
    } else if (
      shared.callbackAssistant &&
      (event.type === "message_delta" || event.type === "reasoning_delta") &&
      !event.turnId
    ) {
      const callback = shared.callbackAssistant;
      const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
      // callback 创建后若活动 turn 已切换（包括从 idle 进入新 turn），后续无头增量
      // 应归入新活动 turn；先完成旧 callback，不能继续把新回答写回旧时间线位置。
      if (callback.ownerTurnId !== active.turnId || (callback.ownerTurnId && !isTurnWritable(active.turnStatus))) {
        this.dispatchCallbackTerminal(shared, callback, {
          type: "turn_completed",
          update: {},
          content: null,
        });
      } else {
        event = { ...event, callbackEntryId: callback.entryId };
      }
    } else if (shared.callbackAssistant && CALLBACK_TERMINAL_TYPES.has(event.type) && !event.turnId) {
      const callback = shared.callbackAssistant;
      const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
      if (callback.ownerTurnId && callback.ownerTurnId === active.turnId) {
        // 只有 callback 创建时冻结的 turn 仍是当前活动 turn，才能把无 turnId 的私有
        // 终态安全归位。独立 callback 或 owner 已变化时没有可信关联，必须忽略；后继
        // callback 边界或当前 relay 的全局断连会负责显式收敛。
        event = { ...event, turnId: callback.ownerTurnId };
        this.dispatch(shared, event);
        this.dispatchCallbackTerminal(shared, callback, event);
      }
      return;
    }
    this.dispatch(shared, event);
  }

  /** 向 callback assistant 投递终态，并仅在仍指向同一 entry 时释放路由状态。 */
  private dispatchCallbackTerminal(
    shared: SharedRelay,
    callback: { entryId: string; ownerTurnId: string | null },
    event: NormalizedEvent,
  ): void {
    this.dispatch(shared, { ...event, callbackEntryId: callback.entryId });
    if (shared.callbackAssistant?.entryId === callback.entryId) {
      shared.callbackAssistant = null;
    }
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
  convergeStuckPrompt(shared: SharedRelay, request: PendingRpc): void {
    if (request.owner.kind !== "prompt" || !claimPendingRpcAbort(request)) return;
    const turnId = request.owner.turnId;
    this.dependencies.reportError("[YJS-FE] prompt timed out (no agent response)", {
      instanceId: shared.instanceId,
    });
    // 空 prompt 的 null 所有权只消费请求，不得回退到响应时的 active turn。
    if (!turnId) return;
    this.dispatchReplayAware(shared, {
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
