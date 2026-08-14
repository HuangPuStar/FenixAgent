import type { DocManager } from "@fenix/acp-server";
import {
  extractModelStateFromConfigOptions,
  extractModeStateFromConfigOptions,
  translateSimpleAction,
} from "@fenix/acp-server";
import { touchInstanceActivity } from "../../../services/acp-idle-monitor";
import { extractAcpEvent, extractJsonRpc } from "../relay-handler";
import type { ConnectionRegistry } from "./connection-registry";
import type { RelayMessage, SharedRelay } from "./types";
import type { YjsBroadcaster } from "./yjs-broadcaster";

export interface RelayEventHandlerDependencies {
  registry: ConnectionRegistry;
  broadcaster: YjsBroadcaster;
  docManager: DocManager;
  registerYjsDocListener: (ydoc: import("yjs").Doc, docName: string) => void;
  reportError: (message: string, error: unknown) => void;
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
    touchInstanceActivity(shared.instanceId, raw);

    const rpcCheck = extractJsonRpc(raw);

    if (rpcCheck?.method === "session/update") {
      const msgSessionId = (rpcCheck.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (msgSessionId) {
        const activeSessionId = registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
        if (activeSessionId && activeSessionId !== msgSessionId) return;
      }
    }

    if (msgType === "relay_closed") {
      this.dependencies.docManager.setChatConnectionStatus(shared.rcsSessionId, {
        status: "disconnected",
        since: Date.now(),
      });
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
      return;
    }

    if (msgType === "error") {
      this.dependencies.reportError("[YJS-FE] agent error", { messageType: msgType, instanceId: shared.instanceId });
      this.sendSafeErrorToRcsSession(shared, "agent_error", "Agent request failed");
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", { messageType: msgType, instanceId: shared.instanceId });
      this.sendSafeErrorToRcsSession(shared, "session_error", "Agent session request failed");
      return;
    }

    try {
      // 回放窗口内（会话同步请求已转发、响应未到）来自 agent 的 user_message_chunk
      // 是 session/load 历史回放：数据重建，不是新 turn。聚合层必须抑制其 loading
      // 设置，否则切换会话后 loading 残留、刷新恢复时覆盖 doc 中真实进行中的 loading。
      // 用户消息由服务端 writePromptText 直接写入（不走 relay 入口），不受此抑制。
      const event = extractAcpEvent(raw, msgType);
      const suppressLoading = shared.replayInProgress === true && event.type === "user_message_chunk";
      this.dependencies.docManager.processACP(
        shared.rcsSessionId,
        event,
        suppressLoading ? { suppressLoading } : undefined,
      );
    } catch (err) {
      // 聚合失败不阻塞 relay 消息流转，但上报供排查
      this.dependencies.reportError("[YJS-FE] processACP failed, ACP event skipped:", err);
    }

    const sessionRpc = extractJsonRpc(raw);
    if (sessionRpc?.method === "session/update" && (sessionRpc.params as Record<string, unknown> | undefined)?.update) {
      const update = (sessionRpc.params as Record<string, unknown>).update as Record<string, unknown>;
      if (update.sessionUpdate === "available_commands_update") {
        const commands = update.availableCommands as Array<{ name: string; description?: string }> | undefined;
        if (commands && commands.length > 0)
          this.dependencies.docManager.setChatAvailableCommands(shared.rcsSessionId, commands);
      } else if (update.sessionUpdate === "session_info_update") {
        // 标题投影：agent 生成会话标题后通过 session_info_update 通知推送（如
        // opencode 首条消息后自动命名）。acp-link 的 session_list 会过滤空标题/
        // "New session" 前缀的会话，10s 轮询永远无法带回未命名会话；此通知是
        // 唯一实时标题更新通道，忽略时侧边栏始终显示"新会话"兜底文案。
        // 仅投影非空标题（空串/null 视为未生成，保持现有值），sessionId 已在
        // 上方与 registry 活跃会话做过 binding 校验。
        const msgSessionId = (sessionRpc.params as Record<string, unknown>).sessionId as string | undefined;
        const title = update.title;
        if (msgSessionId && typeof title === "string" && title.trim().length > 0) {
          this.dependencies.docManager.updateSessionSummary(shared.rcsSessionId, msgSessionId, { title });
        }
      }
    }

    let usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null = null;
    if (sessionRpc && "result" in sessionRpc) {
      usage = (sessionRpc.result as Record<string, unknown>)?.usage as typeof usage;
    }
    if (!usage) {
      const payload = raw.payload as Record<string, unknown> | undefined;
      if (payload?.type === "prompt_complete")
        usage = (payload.payload as Record<string, unknown>)?.usage as typeof usage;
    }
    if (!usage && msgType === "prompt_complete")
      usage = (raw.payload as Record<string, unknown>)?.usage as typeof usage;
    if (usage) this.dependencies.docManager.setChatTokenUsage(shared.rcsSessionId, usage);

    // JSON-RPC error 响应（带 id、无 method 且无法规范化）：Agent 子进程意外退出时
    // acp-link 只重置 connection/sessionId 并回 status {connected:false}，不报错、
    // 不关 relay；prompt 请求以 -32000 "No active session" / -32603 "Prompt failed"
    // 拒绝。静默丢弃会让 turn 永久卡住、前端 loading 永不消失（仅刷新可恢复）。
    // 若该 id 是 send_prompt 出口登记过的在途 prompt，收敛为 error 事件
    // （chatMeta status=error + loading 清空）；错误内容脱敏，只记录 code。
    const rpcError = rpcCheck?.error as Record<string, unknown> | undefined;
    if (rpcError && rpcCheck?.id !== undefined && rpcCheck.id !== null && !rpcCheck.method) {
      const rpcId = rpcCheck.id as number | string;
      if (shared.pendingPromptIds?.has(rpcId) === true) {
        shared.pendingPromptIds?.delete(rpcId);
        this.dependencies.reportError("[YJS-FE] prompt rejected by agent", {
          instanceId: shared.instanceId,
          code: rpcError.code,
        });
        this.dependencies.docManager.processACP(shared.rcsSessionId, { type: "error" });
        return;
      }
    }

    if (msgType === "status") {
      const payload = raw.payload as Record<string, unknown> | undefined;
      // Agent 断连（acp-link connection.closed → {connected:false}，子进程死亡不
      // 报错不关 relay）：活动 turn 必须收敛，否则前端 loading 永久卡死。收敛为
      // error 事件（chatMeta status=error + loading 清空），晚到增量由聚合层丢弃。
      if (payload?.connected === false) {
        this.dependencies.docManager.processACP(shared.rcsSessionId, { type: "error" });
      }
      const capabilities = payload?.capabilities as Record<string, unknown> | undefined;
      if (capabilities) this.dependencies.docManager.setChatCapabilities(shared.rcsSessionId, capabilities);
      const agentInfo = payload?.agentInfo as Record<string, unknown> | undefined;
      if (agentInfo) {
        const model = agentInfo.model as { id?: string; name?: string } | undefined;
        this.dependencies.docManager.setChatAgentInfo(shared.rcsSessionId, {
          id: shared.agentId,
          name: (agentInfo.name as string) || shared.agentId,
          model: model ? { id: model.id || "", name: model.name || "" } : undefined,
        });
      }
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

    try {
      let listPayload: Record<string, unknown> | null = null;
      if (msgType === "session_list") listPayload = raw.payload as Record<string, unknown> | null;
      else if (msgType === "session_data") {
        const inner = raw.payload as Record<string, unknown> | undefined;
        if (inner?.type === "session_list") listPayload = inner.payload as Record<string, unknown> | null;
      }
      if (listPayload) {
        const sessions = listPayload.sessions as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(sessions) && this.syncSessions(shared, sessions)) {
          const chatDoc = this.dependencies.docManager.getChat(shared.rcsSessionId);
          const activeSessionId = chatDoc?.ydoc.getMap("chatMeta").get("activeSessionId") as string | undefined;
          if (!activeSessionId) {
            const latestSessionId = [...sessions].sort((a, b) => {
              const aTime = a.updatedAt ? new Date(a.updatedAt as string).getTime() : 0;
              const bTime = b.updatedAt ? new Date(b.updatedAt as string).getTime() : 0;
              return bTime - aTime;
            })[0]?.sessionId as string | undefined;
            if (latestSessionId)
              this.dependencies.docManager.setChatActiveSession(shared.rcsSessionId, latestSessionId);
          }
          return;
        }
      }

      const rpc = extractJsonRpc(raw);
      if (!rpc || !("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;
      const newSessionId = result.sessionId;
      // 会话同步响应身份校验：JSON-RPC 响应帧只有 id 无 method，无法区分响应来源；
      // 仅放行请求出口登记过的在途 create/load/resume 请求。rename/delete 等其他
      // 携带 sessionId 的响应未经登记必须拒绝——否则 registry 活跃会话被 clobber、
      // 绑定校验丢弃当前会话全部增量、误开回放窗口、错误投影 title/status。
      // 消费后删除登记，避免 id 空间残留。
      const rpcId = rpc.id as number | string | null | undefined;
      const syncRequested = rpcId !== undefined && rpcId !== null && shared.pendingSessionSyncIds?.has(rpcId) === true;
      if (syncRequested) {
        shared.pendingSessionSyncIds?.delete(rpcId);
        // 回放窗口随最后一个在途会话同步请求的消费而结束（多标签页并发请求时，
        // 全部响应到达才复位，避免提前结束抑制窗口）。
        if (shared.pendingSessionSyncIds && shared.pendingSessionSyncIds.size === 0) {
          shared.replayInProgress = false;
        }
      }
      if (typeof newSessionId === "string" && newSessionId.length > 0 && syncRequested) {
        const configOptions = result.configOptions as Array<Record<string, unknown>> | undefined;
        const models = (result.models ?? extractModelStateFromConfigOptions(configOptions)) as
          | NonNullable<ReturnType<typeof extractModelStateFromConfigOptions>>
          | null
          | undefined;
        const modes = (result.modes ?? extractModeStateFromConfigOptions(configOptions)) as
          | NonNullable<ReturnType<typeof extractModeStateFromConfigOptions>>
          | null
          | undefined;
        if (models) this.dependencies.docManager.setChatModelState(shared.rcsSessionId, models);
        if (modes) this.dependencies.docManager.setChatModeState(shared.rcsSessionId, modes);
        const sessionDoc = await this.dependencies.docManager.openSession(
          shared.userId,
          shared.agentId,
          shared.rcsSessionId,
        );
        this.dependencies.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        const currentSessionId = registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
        const isNewSession = currentSessionId !== newSessionId;
        registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
          entry.acpSessionId = newSessionId;
        });
        if (isNewSession) {
          const now = Date.now();
          this.dependencies.docManager.registerSession(shared.rcsSessionId, {
            sessionId: newSessionId,
            // title 投影：session/new、load 响应携带 agent 侧标题；空串视为缺省
            // （与 acp-link list 过滤语义一致），不得用空标题覆盖已有值；缺省时
            // 保持空串（前端兜底显示"新会话"，由后续 session_list 轮询以权威列表覆盖）
            title: typeof result.title === "string" && result.title.trim().length > 0 ? result.title : "",
            preview: "",
            status: "active",
            lastMsgTs: now,
            updatedAt: new Date(now).toISOString(),
          });
        }
        this.dependencies.docManager.setChatActiveSession(shared.rcsSessionId, newSessionId);
        // 会话就绪广播：仅当 Session Doc 未被回放污染（status 仍为 idle）时发送。
        // 回放窗口抑制（replayInProgress）已保证回放的 user_message_chunk 不设置
        // loading、不把 status 置为 loading——切换会话时回放后保持 idle 发 ready；
        // 刷新恢复时 doc 中真实进行中的 loading 保留（status 非 idle）则不广播，
        // 前端凭快照中的 loading 继续显示 cancel 按钮，agent 后续输出不受影响。
        if (sessionDoc.ydoc.getMap("meta").get("status") === "idle") {
          this.dependencies.docManager.processACP(shared.rcsSessionId, {
            type: "session_update",
            payload: { sessionUpdate: "ready" },
          });
        }
        try {
          this.dependencies.broadcaster.broadcastSnapshot(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        } catch (err) {
          this.dependencies.reportError("[YJS-FE] Failed to push session init state:", err);
        }
        return;
      }
      const sessions = result.sessions as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(sessions)) this.syncSessions(shared, sessions);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] session sync failed:", err);
    }
  }

  private sendSafeErrorToRcsSession(shared: SharedRelay, code: string, message: string): void {
    this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
      this.dependencies.broadcaster.sendToYjsWs(entry.ws, { type: "error", payload: { code, message } });
    });
  }

  private syncSessions(shared: SharedRelay, sessions: Array<Record<string, unknown>>): boolean {
    const validSessions = sessions.filter(
      (session): session is Record<string, unknown> & { sessionId: string } =>
        typeof session.sessionId === "string" && session.sessionId.length > 0,
    );
    if (validSessions.length !== sessions.length) {
      this.dependencies.reportError("[YJS-FE] session list rejected: invalid session summary", {
        rcsSessionId: shared.rcsSessionId,
      });
      return false;
    }

    const summaries = validSessions.map((s) => {
      const timestamp = s.updatedAt ? new Date(s.updatedAt as string).getTime() : 0;
      return {
        sessionId: s.sessionId,
        title: (s.title as string) || "",
        preview: "",
        status: "active" as const,
        lastMsgTs: timestamp > 0 ? timestamp : Date.now(),
        updatedAt: (s.updatedAt as string) || new Date().toISOString(),
      };
    });
    this.dependencies.docManager.syncChatSessions(shared.rcsSessionId, summaries);
    const activeSessionId = this.dependencies.registry.findActiveSessionIdByRcsSession(shared.rcsSessionId);
    // 空列表保护：agent 重启后列表尚未恢复、或全部条目被 acp-link"空标题"过滤时，
    // 瞬时空响应不得清空会话绑定（否则 send_prompt 失去 sessionId 精确路由，串会话）；
    // 真实删除由非空响应自愈（被删会话不在 incoming 中）
    if (
      activeSessionId &&
      summaries.length > 0 &&
      !summaries.some((summary) => summary.sessionId === activeSessionId)
    ) {
      this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
        entry.acpSessionId = null;
        entry.sessionLoaded = false;
      });
    }
    return true;
  }
}
