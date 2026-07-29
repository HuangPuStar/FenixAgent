// packages/acp-server/src/state/doc-manager.ts

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import type {
  ACPEvent,
  AgentInfo,
  ChatDoc,
  ConnectionStatus,
  ModelState,
  ModeState,
  PermissionRequest,
  SessionDoc,
  SessionSummary,
} from "../types";
import { applyACPEvent } from "./aggregator";
import {
  addPermission,
  addSession,
  clearSessionYDocContent,
  resolvePermission,
  setActiveSession,
  setAgentInfo,
  setAvailableCommands,
  setCapabilities,
  setConnectionStatus,
  setModelState,
  setModeState,
  setSwitchingSession,
  setTokenUsage,
  syncSessions,
  updateSession,
} from "./chat-writer";
import { createChatDoc, createSessionDoc, loadChatDoc, loadSessionDoc } from "./factory";

/** 合并窗口（毫秒）。session/load 回放时多条消息可落入同一窗口合并为一个 yjs:update。 */
const DEFAULT_BATCH_WINDOW_MS = 16;

/** 可合并的事件类型：内容类事件。控制类事件（session_update/error 等）必须立即生效。 */
const BATCHABLE_EVENT_TYPES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "agent_message_complete",
  "prompt_complete",
  "user_message_chunk",
  "tool_call",
  "tool_call_result",
  "tool_call_error",
  "tool_call_update",
  "plan",
]);

export interface DocManagerOptions {
  /** Redis 连接获取器（惰性求值，支持连接延迟建立） */
  getRedis?: () => Redis | Cluster | null;
  /** Y.Doc update 广播回调 */
  onYjsUpdate?: ((docName: string, update: Uint8Array) => void) | null;
  /** 错误回调 */
  onError?: (context: string, err: unknown) => void;
  /** 日志回调 */
  onLog?: (msg: string) => void;
  /** ACP 事件批处理窗口（毫秒），默认 16ms */
  acpBatchWindowMs?: number;
}

/**
 * 管理 Chat 和 Session 两套 Y.Doc 的完整生命周期。
 *
 * 职责：
 * - 内存中 Y.Doc 实例的 Map 管理（chatDocs / sessionDocs）
 * - Doc 的创建/加载/销毁（可选 Redis 持久化）
 * - 所有 Chat 状态的写入（agentInfo / sessions / capabilities / modelState 等）
 * - ACP 事件的写入与微批次合并
 * - Session 切换编排
 * - Y.Doc update 广播回调绑定
 *
 * 不负责：Redis 连接管理、WebSocket 路由、日志输出（使用回调注入）。
 */
export class DocManager {
  private chatDocs = new Map<string, ChatDoc>();
  private sessionDocs = new Map<string, SessionDoc>();
  private getRedis: () => Redis | Cluster | null;
  private onYjsUpdate: ((docName: string, update: Uint8Array) => void) | null;
  private onError: ((context: string, err: unknown) => void) | undefined;
  private onLog: ((msg: string) => void) | undefined;
  private batchWindowMs: number;
  private acpBatchBuffers = new Map<string, { events: ACPEvent[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(options?: DocManagerOptions) {
    this.getRedis = options?.getRedis ?? (() => null);
    this.onYjsUpdate = options?.onYjsUpdate ?? null;
    this.onError = options?.onError;
    this.onLog = options?.onLog;
    this.batchWindowMs = options?.acpBatchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  }

  // ── Broadcast ──

  /** 设置或清除 Y.Doc update 广播回调 */
  setBroadcastHandler(handler: ((docName: string, update: Uint8Array) => void) | null): void {
    this.onYjsUpdate = handler;
  }

  /** 绑定 Y.Doc 的 update 事件到广播回调 */
  private registerDocBroadcast(ydoc: Y.Doc, docName: string): void {
    ydoc.on("update", (update: Uint8Array) => {
      this.onYjsUpdate?.(docName, update);
    });
  }

  // ── Chat 级别 ──

  /** 打开或获取已有的 Chat Doc */
  async openChat(rcsSessionId: string): Promise<ChatDoc> {
    const existing = this.chatDocs.get(rcsSessionId);
    if (existing) return existing;

    const redis = this.getRedis();
    if (!redis) {
      this.onLog?.("[DocManager] No Redis connection, running in memory-only mode");
      const doc = createChatDoc(rcsSessionId, null);
      this.registerDocBroadcast(doc.ydoc, `chat:${rcsSessionId}`);
      this.chatDocs.set(rcsSessionId, doc);
      return doc;
    }

    const doc = loadChatDoc(rcsSessionId, redis);
    this.registerDocBroadcast(doc.ydoc, `chat:${rcsSessionId}`);
    this.chatDocs.set(rcsSessionId, doc);
    return doc;
  }

  /** 获取 Chat Doc（不创建） */
  getChat(rcsSessionId: string): ChatDoc | undefined {
    return this.chatDocs.get(rcsSessionId);
  }

  /** 关闭并销毁 Chat Doc */
  async closeChat(rcsSessionId: string): Promise<void> {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) {
      await doc.destroy();
      this.chatDocs.delete(rcsSessionId);
    }
  }

  /** 获取 Chat Doc 底层 Y.Doc（用于外部直接操作） */
  getChatYdoc(rcsSessionId: string): Y.Doc | undefined {
    return this.chatDocs.get(rcsSessionId)?.ydoc;
  }

  // ── Chat 状态写入 ──

  setChatConnectionStatus(rcsSessionId: string, status: ConnectionStatus): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setConnectionStatus(doc.ydoc, status);
  }

  setChatAgentInfo(rcsSessionId: string, info: AgentInfo): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setAgentInfo(doc.ydoc, info);
  }

  setChatCapabilities(rcsSessionId: string, caps: Record<string, unknown>): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setCapabilities(doc.ydoc, caps);
  }

  setChatModelState(rcsSessionId: string, state: ModelState): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setModelState(doc.ydoc, state);
  }

  setChatModeState(rcsSessionId: string, state: ModeState): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setModeState(doc.ydoc, state);
  }

  setChatAvailableCommands(rcsSessionId: string, commands: Array<{ name: string; description?: string }>): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setAvailableCommands(doc.ydoc, commands);
  }

  setChatTokenUsage(
    rcsSessionId: string,
    usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
  ): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setTokenUsage(doc.ydoc, usage);
  }

  setChatActiveSession(rcsSessionId: string, acpSessionId: string): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) setActiveSession(doc.ydoc, acpSessionId);
  }

  // ── Session 列表管理 ──

  registerSession(rcsSessionId: string, summary: SessionSummary): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) addSession(doc.ydoc, summary);
  }

  /** 全量同步 session 列表到 Chat Doc（增/改/删） */
  syncChatSessions(rcsSessionId: string, sessions: SessionSummary[]): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) syncSessions(doc.ydoc, sessions);
  }

  updateSessionSummary(rcsSessionId: string, acpSessionId: string, patch: Partial<SessionSummary>): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) updateSession(doc.ydoc, acpSessionId, patch);
  }

  // ── Permission ──

  handlePermissionRequest(rcsSessionId: string, perm: PermissionRequest): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) addPermission(doc.ydoc, perm);
  }

  handlePermissionResolution(rcsSessionId: string, permId: string, decision: "approved" | "denied"): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) resolvePermission(doc.ydoc, permId, decision);
  }

  // ── Session 级别 ──

  /**
   * 打开或获取已有的 Session Doc。
   * _userId 和 _agentId 为兼容旧调用方保留，当前无实际使用。
   */
  async openSession(_userId: string, _agentId: string, rcsSessionId: string): Promise<SessionDoc> {
    const existing = this.sessionDocs.get(rcsSessionId);
    if (existing) {
      // 清除缓存会话可能遗留的脏 loading 状态
      const meta = existing.ydoc.getMap("meta");
      if (meta.get("loading") !== null) {
        meta.set("loading", null);
      }
      return existing;
    }

    const redis = this.getRedis();
    if (!redis) {
      const doc = createSessionDoc(rcsSessionId, null);
      this.registerDocBroadcast(doc.ydoc, `session:${rcsSessionId}`);
      this.sessionDocs.set(rcsSessionId, doc);
      return doc;
    }

    const doc = loadSessionDoc(rcsSessionId, redis);
    // 清除从 Redis 加载可能遗留的脏 loading 状态。
    // 用 setTimeout(0)（Bun）将清除动作推迟到下一个 macrotask，
    // 确保先行的 Redis getBuffer.then（microtask）先执行完毕。
    const scheduleClear = () => {
      doc.ydoc.getMap("meta").set("loading", null);
    };
    if (typeof setImmediate === "function") {
      setImmediate(scheduleClear);
    } else {
      setTimeout(scheduleClear, 0);
    }
    this.registerDocBroadcast(doc.ydoc, `session:${rcsSessionId}`);
    this.sessionDocs.set(rcsSessionId, doc);
    return doc;
  }

  getSession(rcsSessionId: string): SessionDoc | undefined {
    return this.sessionDocs.get(rcsSessionId);
  }

  getSessionYdoc(rcsSessionId: string): Y.Doc | undefined {
    return this.sessionDocs.get(rcsSessionId)?.ydoc;
  }

  /** 关闭并销毁 Session Doc，同时取消待处理的 ACP 批次 */
  async closeSession(rcsSessionId: string): Promise<void> {
    this.cancelACPBatch(rcsSessionId);
    // 提前从 Map 删除阻止新事件写入正在 destroy 的 Doc
    const doc = this.sessionDocs.get(rcsSessionId);
    this.sessionDocs.delete(rcsSessionId);
    if (doc) {
      await doc.destroy();
    }
  }

  /**
   * 在 Y.Doc 事务内原地清空 Session Doc 的全部内容。
   * 用于会话切换（load/create）时重置状态，避免 destroy+recreate 的竞态。
   */
  clearSessionDocContent(rcsSessionId: string): void {
    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc) return;
    clearSessionYDocContent(doc.ydoc);
  }

  /**
   * 检查 Session Doc 是否包含实际消息内容。
   * 判断依据：legacy messages 数组或 Phase C structuredMessages 数组任一非空。
   */
  hasSessionDocContent(rcsSessionId: string): boolean {
    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc) return false;
    const messages = doc.ydoc.getArray("messages");
    if (messages.length > 0) return true;
    const structuredMessages = doc.ydoc.getArray("structuredMessages");
    return structuredMessages.length > 0;
  }

  // ── 用户操作 ──

  /** 注册用户消息到 Session Doc（通过 processACP 批次通道写入） */
  registerUserMessage(rcsSessionId: string, content: string): void {
    this.processACP(rcsSessionId, {
      type: "user_message_chunk",
      payload: { content: { type: "text", text: content } },
    });
  }

  // ── Session 切换编排 ──

  /**
   * 编排 session 切换流程：
   * 1. 确保 Session Doc 在内存中
   * 2. 通知 agent 加载目标 session
   * 3. 更新 Chat Doc 的 activeSessionId
   */
  async switchSession(
    chatDoc: ChatDoc,
    send: (msg: unknown) => void,
    rcsSessionId: string,
    acpSessionId: string,
  ): Promise<void> {
    // 确保 Session Doc 在内存
    if (!this.sessionDocs.has(rcsSessionId)) {
      const redis = this.getRedis();
      const doc = redis ? loadSessionDoc(rcsSessionId, redis) : createSessionDoc(rcsSessionId, null);
      this.registerDocBroadcast(doc.ydoc, `session:${rcsSessionId}`);
      this.sessionDocs.set(rcsSessionId, doc);
    }

    setSwitchingSession(chatDoc.ydoc, true);

    try {
      send({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "session/load",
        params: { sessionId: acpSessionId },
      });
    } catch (err) {
      this.onError?.("[DocManager] Failed to send session/load", err);
    }

    setActiveSession(chatDoc.ydoc, acpSessionId);
  }

  // ── ACP 事件微批次合并 ──

  /** 刷新指定 rcsSessionId 的 ACP 事件批次，将所有等待中的事件批量写入 Y.Doc */
  private flushACPBatch(rcsSessionId: string): void {
    const batch = this.acpBatchBuffers.get(rcsSessionId);
    if (!batch) return;
    this.acpBatchBuffers.delete(rcsSessionId);
    clearTimeout(batch.timer);

    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc || batch.events.length === 0) return;

    try {
      if (batch.events.length === 1) {
        applyACPEvent(doc.ydoc, batch.events[0]);
      } else {
        // 多个事件合并到一个 Y.Doc 事务，N 个 session/update 帧 → 1 个 yjs:update
        doc.ydoc.transact(() => {
          for (const event of batch.events) {
            applyACPEvent(doc.ydoc, event);
          }
        });
      }
    } catch (err) {
      this.onError?.(`[DocManager] flushACPBatch failed for ${rcsSessionId}, ${batch.events.length} events lost`, err);
    }
  }

  /** 取消待处理的 ACP 事件批次 */
  private cancelACPBatch(rcsSessionId: string): void {
    const batch = this.acpBatchBuffers.get(rcsSessionId);
    if (batch) {
      clearTimeout(batch.timer);
      this.acpBatchBuffers.delete(rcsSessionId);
    }
  }

  /**
   * 处理单个 ACP 事件。
   * 内容类事件（消息、工具调用等）进入微批次合并窗口；
   * 控制类事件（session_update、error 等）立即生效。
   */
  processACP(rcsSessionId: string, event: ACPEvent): void {
    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc) {
      this.onLog?.(`[DocManager] Session ${rcsSessionId} not in memory, skipping ACP event type=${event.type}`);
      return;
    }

    // 控制类事件直接应用，不参与批处理。但必须先刷新 pending 内容批次，保证顺序
    if (!BATCHABLE_EVENT_TYPES.has(event.type)) {
      try {
        this.flushACPBatch(rcsSessionId);
      } catch (err) {
        this.onError?.(`[DocManager] flushACPBatch failed before control event ${event.type}`, err);
      }
      applyACPEvent(doc.ydoc, event);
      return;
    }

    const existing = this.acpBatchBuffers.get(rcsSessionId);
    if (existing) {
      existing.events.push(event);
      return;
    }

    const timer = setTimeout(() => this.flushACPBatch(rcsSessionId), this.batchWindowMs);
    this.acpBatchBuffers.set(rcsSessionId, { events: [event], timer });
  }

  // ── 清理 ──

  /** 关闭所有 Doc 并清理内部状态 */
  async closeAll(): Promise<void> {
    // 快照 keys，避免迭代期间 cancelACPBatch 修改 Map
    const batchKeys = [...this.acpBatchBuffers.keys()];
    for (const rcsSessionId of batchKeys) {
      this.cancelACPBatch(rcsSessionId);
    }

    for (const doc of this.sessionDocs.values()) {
      await doc.destroy();
    }
    this.sessionDocs.clear();

    for (const doc of this.chatDocs.values()) {
      await doc.destroy();
    }
    this.chatDocs.clear();
  }
}
