import type { DocManager } from "@fenix/acp-server";
import {
  extractModelStateFromConfigOptions,
  extractModeStateFromConfigOptions,
  translateSimpleAction,
} from "@fenix/acp-server";
import { touchInstanceActivity } from "../../../services/acp-idle-monitor";
import { terminateLocalDeadInstance } from "../../../services/orchestration-instance";
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
      // 本地实例的 relay 意外关闭（进程崩溃/被杀）：触发实例级清理，避免死实例
      // 持续占并发额度并被 ensureRunning 无限复用（C-P2.4）。远程实例由
      // terminateLocalDeadInstance 内部的 nodeId 校验排除；主动关闭路径
      // （dispose/stop/idle 回收）的监听器先于 handle close 注销，不会误触发。
      void terminateLocalDeadInstance(shared.instanceId);
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
      this.dependencies.docManager.processACP(shared.rcsSessionId, extractAcpEvent(raw, msgType));
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

    if (msgType === "status") {
      const payload = raw.payload as Record<string, unknown> | undefined;
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
      if (typeof newSessionId === "string" && newSessionId.length > 0) {
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
        // await 挂起期间 relay 可能已因全部客户端断开而释放（closeReleasedRelay 已置 destroyed 并注销），
        // 跳过注册避免产生无注销点的僵尸监听器；relay 已销毁时后续 session 同步也无接收者。
        if (shared.destroyed) return;
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
            title: "",
            preview: "",
            status: "active",
            lastMsgTs: now,
            updatedAt: new Date(now).toISOString(),
          });
        }
        this.dependencies.docManager.setChatActiveSession(shared.rcsSessionId, newSessionId);
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
    if (activeSessionId && !summaries.some((summary) => summary.sessionId === activeSessionId)) {
      this.dependencies.registry.forEachByRcsSession(shared.rcsSessionId, (entry) => {
        entry.acpSessionId = null;
        entry.sessionLoaded = false;
      });
    }
    return true;
  }
}
