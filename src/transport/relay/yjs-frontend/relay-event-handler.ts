import type { DocManager } from "@fenix/acp-server";
import {
  extractModelStateFromConfigOptions,
  extractModeStateFromConfigOptions,
  translateSimpleAction,
} from "@fenix/acp-server";
import { touchInstanceActivity } from "../../../services/acp-idle-monitor";
import { extractAcpEvent, extractJsonRpc } from "../relay-handler";
import type { ConnectionRegistry } from "./connection-registry";
import type { ClientConnection, RelayMessage, SharedRelay } from "./types";
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
        const activeSessionId = registry.findActiveSessionIdByUser(shared.agentId, shared.instanceId, shared.userId);
        if (activeSessionId && activeSessionId !== msgSessionId) return;
      }
    }

    if (msgType === "relay_closed") {
      this.dependencies.docManager.setChatConnectionStatus(shared.rcsSessionId, {
        status: "disconnected",
        since: Date.now(),
      });
      const entries: ClientConnection[] = [];
      registry.forEachByInstance(shared.agentId, shared.instanceId, (entry) => entries.push(entry));
      for (const entry of entries) {
        try {
          this.dependencies.broadcaster.sendToYjsWs(entry.ws, {
            type: "error",
            payload: { message: "Agent connection lost" },
          });
        } catch {
          /* ignore */
        }
        try {
          entry.ws.close(1011, "relay handle closed");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (msgType === "error") {
      this.dependencies.reportError("[YJS-FE] agent error", { messageType: msgType, instanceId: shared.instanceId });
      this.dependencies.docManager.setChatConnectionStatus(shared.rcsSessionId, {
        status: "disconnected",
        since: Date.now(),
      });
      this.sendToMatchingClients(shared, raw);
      return;
    }

    if (msgType === "session_error") {
      this.dependencies.reportError("[YJS-FE] session error", { messageType: msgType, instanceId: shared.instanceId });
      this.sendToMatchingClients(shared, raw);
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
      // DEBUG: Agent status 就绪 — 打印当前 chat 状态快照
      console.log("[YJS-DEBUG:SERVER] agent status received:", {
        userId: shared.userId,
        agentId: shared.agentId,
        rcsSessionId: shared.rcsSessionId,
        capabilities: capabilities ? Object.keys(capabilities) : null,
        agentName: agentInfo?.name || shared.agentId,
        ts: Date.now(),
      });
      const needsListSessions = !registry.hasStatusReceivedByUser(shared.agentId, shared.instanceId, shared.userId);
      registry.forEachByInstanceUser(shared.agentId, shared.instanceId, shared.userId, (entry) => {
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
        if (Array.isArray(sessions)) {
          this.syncSessions(shared.rcsSessionId, sessions);
          // DEBUG: 会话列表同步完成
          console.log("[YJS-DEBUG:SERVER] sessions synced:", {
            userId: shared.userId,
            agentId: shared.agentId,
            rcsSessionId: shared.rcsSessionId,
            sessionCount: sessions.length,
            sessions: sessions.map((s) => ({ id: s.sessionId, title: s.title, updatedAt: s.updatedAt })),
            ts: Date.now(),
          });
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
        this.dependencies.registerYjsDocListener(sessionDoc.ydoc, `session:${shared.rcsSessionId}`);
        const currentSessionId = registry.findActiveSessionIdByUser(shared.agentId, shared.instanceId, shared.userId);
        const isNewSession = currentSessionId !== newSessionId;
        registry.forEachByInstanceUser(shared.agentId, shared.instanceId, shared.userId, (entry) => {
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
        // DEBUG: 新会话已创建/加载
        console.log("[YJS-DEBUG:SERVER] session activated:", {
          userId: shared.userId,
          agentId: shared.agentId,
          rcsSessionId: shared.rcsSessionId,
          acpSessionId: newSessionId,
          isNew: isNewSession,
          models,
          modes,
          ts: Date.now(),
        });
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
      if (Array.isArray(sessions)) this.syncSessions(shared.rcsSessionId, sessions);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] session sync failed:", err);
    }
  }

  private sendToMatchingClients(shared: SharedRelay, data: unknown): void {
    this.dependencies.registry.forEachByInstance(shared.agentId, shared.instanceId, (entry) => {
      this.dependencies.broadcaster.sendToYjsWs(entry.ws, data);
    });
  }

  private syncSessions(rcsSessionId: string, sessions: Array<Record<string, unknown>>): void {
    const summaries = sessions
      .filter((s): s is Record<string, unknown> & { sessionId: string } => typeof s.sessionId === "string")
      .map((s) => {
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
    if (summaries.length > 0) {
      this.dependencies.docManager.syncChatSessions(rcsSessionId, summaries);
    }
  }
}
