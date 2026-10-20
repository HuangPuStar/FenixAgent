import { normalizeAcpMessage } from "../protocol";
import type { SharedRelay } from "./connection-types";
import { agentRuntimeError, classifyPromptRejection, sanitizeUpstreamErrorMessage } from "./relay-errors";
import type { RelayEventHandlerDependencies } from "./relay-event-dependencies";
import type { RelayProjection } from "./relay-projection";
import { settleSessionCreation } from "./session-mutation";
import { ensureUserInputQueueSnapshot } from "./user-input-queue-action";
import { settleUserInputQueueResponse } from "./user-input-queue-wire";

/** 仅消费已登记的 RPC 响应，迟到会话回执不能提交新绑定。 */
export class RelayRpcResponse {
  constructor(
    private readonly dependencies: RelayEventHandlerDependencies,
    private readonly projection: RelayProjection,
  ) {}
  /**
   * JSON-RPC 响应帧处理（第二级分派）：prompt 结果（error 拒绝登记 / result 完成
   * 投递）与会话同步 result（create/load/resume）消费。
   */
  async handleJsonRpcResponse(
    shared: SharedRelay,
    raw: Record<string, unknown>,
    msgType: string | undefined,
    rpcCheck: Record<string, unknown>,
  ): Promise<void> {
    const { registry } = this.dependencies;
    const rpcId = rpcCheck.id as number | string | null | undefined;
    const generation = shared.sessionSyncGeneration;
    // steer（session/input/*）响应优先认领：响应帧只有 id，登记表按请求出口寻址，与
    // prompt / 会话同步的 id 空间互斥。命中即完全接管——队列回执（snapshot 的 result
    // 同样带 sessionId，receipt 亦含快照）不得落入会话同步分支，否则活跃会话被回绑、
    // 投影 sessionId 被改写。投影写入（成功快照 / 过期代号的换代校正）在认领点完成。
    if (
      rpcId !== undefined &&
      rpcId !== null &&
      settleUserInputQueueResponse({
        shared,
        rpcId,
        rpcCheck,
        docManager: this.dependencies.docManager,
        reportError: this.dependencies.reportError,
        log: this.dependencies.log,
      })
    ) {
      return;
    }
    if (rpcId !== undefined && rpcId !== null) {
      const target = shared.pendingSessionTarget;
      const result = rpcCheck.result;
      const validResult = !rpcCheck.error && typeof result === "object" && result !== null && !Array.isArray(result);
      const responseSessionId = validResult ? (result as Record<string, unknown>).sessionId : undefined;
      const targetMatches =
        !target ||
        target.rpcId !== rpcId ||
        !target.sessionId ||
        responseSessionId === undefined ||
        responseSessionId === target.sessionId;
      shared.pendingSessionMutations?.get(rpcId)?.(validResult && targetMatches);
      if (target?.rpcId === rpcId && (!validResult || !targetMatches)) {
        settleSessionCreation(shared, rpcId, null);
        return;
      }
      // 被 Agent 拒绝的 create_session 以空回执结算：调用方据此走「无回执」分支（不写归属），
      // 而不是把这次创建当成成功后再去猜哪个会话是新建的。
      if (rpcCheck.error) settleSessionCreation(shared, rpcId, null);
    }

    // error 响应（带 id、无 method 且无法规范化）：Agent 子进程意外退出时
    // acp-link 只重置 connection/sessionId 并回 status {connected:false}，不报错、
    // 不关 relay；prompt 请求以 -32000 "No active session" / -32603 "Prompt failed"
    // 拒绝。静默丢弃会让 turn 永久卡 accepting、前端 loading 永不消失（仅刷新可恢复）。
    // 若该 id 是 send_prompt 出口登记过的在途 prompt，收敛 turn_failed；原始错误
    // message 只经脱敏、截断后进入服务端诊断日志，不进入 PublicError 或浏览器响应。
    if (rpcCheck.error) {
      const rpcError = rpcCheck.error as Record<string, unknown> | undefined;
      if (rpcId !== undefined && rpcId !== null && shared.pendingPromptIds?.has(rpcId) === true) {
        shared.pendingPromptIds?.delete(rpcId);
        // 回传 turnId：聚合层按归属终结对应 turn（stale turn 的迟到终态不误伤新 turn）
        const turnId = shared.pendingPromptTurns?.get(rpcId);
        shared.pendingPromptTurns?.delete(rpcId);
        const diagnosticMessage = sanitizeUpstreamErrorMessage(rpcError?.message);
        this.dependencies.reportError("[YJS-FE] prompt rejected by agent", {
          instanceId: shared.instanceId,
          code: rpcError?.code,
          ...(diagnosticMessage ? { message: diagnosticMessage } : {}),
        });
        const publicError = agentRuntimeError(
          classifyPromptRejection(rpcError),
          "relay.prompt_response",
          this.dependencies.log,
        );
        // Prompt 错误属于当前 turn，只经 Y.Doc 投影到对应 assistant entry。
        // 不再发送连接级 error 帧，否则 ChatPanel 会在会话顶部重复展示同一故障。
        this.projection.dispatch(shared, {
          type: "turn_failed",
          update: { publicError },
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
      if (normalized.type === "session_list") {
        try {
          if (!(await this.dependencies.docManager.refreshSessionTitles(shared.rcsSessionId))) normalized = null;
        } catch (error) {
          this.dependencies.reportError("[YJS-FE] session title metadata read failed", error);
          normalized = null;
        }
      }
    }
    if (normalized) {
      // 终态归属回传：见 handleMessage 第三级注释（JSON-RPC prompt 响应无 turnId，
      // 按 pendingPromptTurns 登记附加，聚合层据此校验归属）
      const promptTurnId = rpcId !== undefined && rpcId !== null ? shared.pendingPromptTurns?.get(rpcId) : undefined;
      if (promptTurnId) {
        normalized = { ...normalized, turnId: promptTurnId };
      }
      this.projection.dispatchReplayAware(shared, normalized);
    }

    try {
      const rpc = rpcCheck;
      if (!("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;
      const pendingTarget = shared.pendingSessionTarget;
      const newSessionId =
        result.sessionId ?? (pendingTarget && pendingTarget.rpcId === rpcId ? pendingTarget.sessionId : undefined);
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
      }
      const syncRequested = rpcId !== undefined && rpcId !== null && shared.pendingSessionSyncIds?.has(rpcId) === true;
      if (syncRequested) shared.pendingSessionSyncIds?.delete(rpcId);
      // create_session 回执在**新鲜度校验之前**结算：会话确实被 Agent 创建出来了，即便这份
      // 响应已被后续切换取代（不提交投影），创建者仍应拿到自己那次创建的 session id——
      // 否则发起方只能等到超时并放弃归属写入，用户的「在该分组新建」被静默丢掉。
      if (syncRequested && rpcId !== undefined && rpcId !== null) {
        settleSessionCreation(
          shared,
          rpcId,
          typeof newSessionId === "string" && newSessionId.length > 0 ? newSessionId : null,
        );
      }
      // 会话同步响应的新鲜度校验（连续切换/响应乱序）：用户在响应到达前已切到别的
      // 会话时，旧响应不得提交——否则 registry 活跃会话回绑到旧 ACP session、投影
      // sessionId 被改写，当前会话的回放与流式增量随后被绑定校验全部丢弃（消息区空白）。
      // 登记仍然消费（避免 id 空间残留），只是不落任何副作用。未登记最新 id 的调用方
      // （无新鲜度信息）保持原语义放行。
      if (syncRequested && shared.latestSessionSyncRpcId !== undefined && shared.latestSessionSyncRpcId !== rpcId) {
        this.dependencies.log?.("[YJS-FE] stale session sync response ignored");
        return;
      }
      if (syncRequested) shared.latestSessionSyncRpcId = null;
      if (typeof newSessionId === "string" && newSessionId.length > 0 && syncRequested) {
        // load/resume 成功后开启回放窗口：Agent 即将回放历史增量（无持久化快照时
        // 历史恢复的唯一来源），窗口内由 dispatchReplayAware 补全 turn 上下文投影时间线；
        // 窗口到期定时器收敛回放 turn 终态（回放流无终态信号，见 openReplayWindow）
        this.projection.openReplayWindow(shared);
        const sessionDoc = await this.dependencies.docManager.openSession(
          shared.userId,
          shared.agentId,
          shared.rcsSessionId,
        );
        // await 挂起期间 relay 可能已因全部客户端断开而释放（closeReleasedRelay 已置 destroyed 并注销），
        // 跳过注册避免产生无注销点的僵尸监听器；relay 已销毁时后续 session 同步也无接收者。
        if (shared.destroyed || shared.sessionSyncGeneration !== generation) return;
        if (shared.pendingSessionTarget?.rpcId === rpcId) shared.pendingSessionTarget = undefined;
        this.dependencies.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
          entry.acpSessionId = newSessionId;
        });
        // ACP 会话绑定完成即补拉一次队列快照：status 可能早于 create/load 响应到达
        // （那时无 acpSessionId，补拉条件不成立），能力已协商时在此补上。同一 ACP
        // 会话只拉一次，换会话按新 sessionId 重新补拉（队列不跨会话）。
        void ensureUserInputQueueSnapshot({
          shared,
          sessionId: newSessionId,
          docManager: this.dependencies.docManager,
          reportError: this.dependencies.reportError,
        });
        // 会话元信息（sessionId/status）经规范化事件写入 Session Doc session；
        // model/mode 来自 session/new、load 响应（acp-link 已从 configOptions 提取
        // models/modes 字段，SDK 0.28+ 无独立 models 字段），投影为会话级元数据，
        // 前端据此显示模型名与模式选择器
        this.projection.dispatch(shared, {
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
}
