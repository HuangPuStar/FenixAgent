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
import type { NormalizedEvent } from "../schema";
import type { DocManager } from "../state";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import type { RelayMessage, SharedRelay } from "./connection-types";

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
      this.dispatch(shared, normalized);
    }

    if (msgType === "status") {
      const payload = raw.payload as Record<string, unknown> | undefined;
      const capabilities = payload?.capabilities as Record<string, boolean> | undefined;
      this.dispatch(shared, {
        type: "agent_status",
        update: {
          instanceId: shared.instanceId,
          acpSessionId: registry.findActiveSessionIdByRcsSession(shared.rcsSessionId) ?? null,
          status: "ready",
          capabilities: capabilities ?? {},
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

    try {
      const rpc = extractJsonRpc(raw);
      if (!rpc || !("result" in rpc)) return;
      const result = rpc.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object") return;
      const newSessionId = result.sessionId;
      if (typeof newSessionId === "string" && newSessionId.length > 0) {
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
        // 会话元信息（sessionId/status）经规范化事件写入 Session Doc session
        this.dispatch(shared, {
          type: "session_updated",
          update: { sessionId: newSessionId, status: "ready" },
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
