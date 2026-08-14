// packages/chat-channel/src/state/doc-manager.ts
// DocManager：管理 Chat / Session 两份 Y.Doc 的完整生命周期与 ACP 投影入口。
//
// 职责：
// - 内存中 Y.Doc 实例的 Map 管理（chatDocs / sessionDocs）
// - Doc 的创建/加载/销毁（可选 Redis 持久化）
// - 规范化事件（NormalizedEvent）的微批次合并与投影（processNormalizedEvent）
// - Y.Doc update 广播回调绑定
//
// 绑定规则：只有已绑定并打开过 Doc 的 rcsSessionId 才接受事件；
// 无 Doc / 已解绑的 rcsSessionId 直接丢弃，绝不重建旧 Doc。

import type { Cluster, Redis } from "ioredis";
import type * as Y from "yjs";
import { DEFAULT_PERMISSION_TIMEOUT_MS, type NormalizedEvent } from "../schema";
import type { ChatDoc, SessionDoc } from "../types";
import { applyNormalizedEvent } from "./aggregator";
import { clearChatDocContent, clearSessionDocContent, hasChatDocContent } from "./chat-writer";
import { createChatDoc, createSessionDoc, loadChatDoc, loadSessionDoc } from "./factory";

/** 合并窗口（毫秒）：文本/思考增量可落入同一窗口合并为一个 yjs:update */
const DEFAULT_BATCH_WINDOW_MS = 16;

/** 可合并的内容类事件；控制类事件（工具/权限/终态/断链）必须先 flush 再立即写入 */
const BATCHABLE_EVENT_TYPES = new Set(["message_delta", "reasoning_delta"]);

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

/** 权限请求投影成功的通知（控制面据此安排超时迁移定时器，C5） */
export type PermissionRequestedHandler = (
  rcsSessionId: string,
  permission: { permissionId: string; expiresAt: string },
) => void;

export class DocManager {
  private chatDocs = new Map<string, ChatDoc>();
  private sessionDocs = new Map<string, SessionDoc>();
  private getRedis: () => Redis | Cluster | null;
  private onYjsUpdate: ((docName: string, update: Uint8Array) => void) | null;
  private onError: ((context: string, err: unknown) => void) | undefined;
  private onLog: ((msg: string) => void) | undefined;
  private onPermissionRequested: PermissionRequestedHandler | null;
  private batchWindowMs: number;
  private acpBatchBuffers = new Map<string, { events: NormalizedEvent[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(options?: DocManagerOptions) {
    this.getRedis = options?.getRedis ?? (() => null);
    this.onYjsUpdate = options?.onYjsUpdate ?? null;
    this.onError = options?.onError;
    this.onLog = options?.onLog;
    this.onPermissionRequested = null;
    this.batchWindowMs = options?.acpBatchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  }

  // ── Broadcast ──

  /** 设置或清除 Y.Doc update 广播回调 */
  setBroadcastHandler(handler: ((docName: string, update: Uint8Array) => void) | null): void {
    this.onYjsUpdate = handler;
  }

  /**
   * 设置或清除权限请求回调（控制面 SessionChannel 注入：安排超时迁移定时器）。
   * 与广播回调一样是单槽位装配点，重复设置会覆盖前者。
   */
  setPermissionRequestedHandler(handler: PermissionRequestedHandler | null): void {
    this.onPermissionRequested = handler;
  }

  /** 绑定 Y.Doc 的 update 事件到广播回调 */
  private registerDocBroadcast(ydoc: Y.Doc, docName: string): void {
    ydoc.on("update", (update: Uint8Array) => {
      this.onYjsUpdate?.(docName, update);
    });
  }

  // ── Chat Doc ──

  /** 打开或获取已有的 Chat Doc（内存/Redis 模式） */
  async openChat(rcsSessionId: string): Promise<ChatDoc> {
    const existing = this.chatDocs.get(rcsSessionId);
    if (existing) return existing;

    const redis = this.getRedis();
    const doc = redis ? loadChatDoc(rcsSessionId, redis) : createChatDoc(rcsSessionId, null);
    this.registerDocBroadcast(doc.ydoc, `chat:${rcsSessionId}`);
    this.chatDocs.set(rcsSessionId, doc);
    return doc;
  }

  /** 获取 Chat Doc（不创建） */
  getChat(rcsSessionId: string): ChatDoc | undefined {
    return this.chatDocs.get(rcsSessionId);
  }

  /** 获取 Chat Doc 底层 Y.Doc（用于外部直接操作） */
  getChatYdoc(rcsSessionId: string): Y.Doc | undefined {
    return this.chatDocs.get(rcsSessionId)?.ydoc;
  }

  /** 关闭并销毁 Chat Doc */
  async closeChat(rcsSessionId: string): Promise<void> {
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) {
      this.chatDocs.delete(rcsSessionId);
      await doc.destroy();
    }
  }

  // ── Session Doc ──

  /** 打开或获取已有的 Session Doc（_userId/_agentId 为兼容旧调用方保留） */
  async openSession(_userId: string, _agentId: string, rcsSessionId: string): Promise<SessionDoc> {
    const existing = this.sessionDocs.get(rcsSessionId);
    if (existing) return existing;

    const redis = this.getRedis();
    const doc = redis ? loadSessionDoc(rcsSessionId, redis) : createSessionDoc(rcsSessionId, null);
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
    const doc = this.sessionDocs.get(rcsSessionId);
    this.sessionDocs.delete(rcsSessionId);
    if (doc) {
      await doc.destroy();
    }
  }

  // ── 会话切换清理 ──

  /** 在 Y.Doc 事务内原地清空 Session Doc（禁止 destroy+recreate 制造异步竞态） */
  clearSessionDocContent(rcsSessionId: string): void {
    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc) return;
    clearSessionDocContent(doc.ydoc);
  }

  /** 在 Y.Doc 事务内原地清空 Chat Doc 时间线（与 Session Doc 同批切换） */
  clearChatDocContent(rcsSessionId: string): void {
    const doc = this.chatDocs.get(rcsSessionId);
    if (!doc) return;
    clearChatDocContent(doc.ydoc);
  }

  /**
   * 检查该 rcsSessionId 是否已有时间线内容（重连时判断是否可跳过全量回放）。
   * 权威依据是 Chat Doc 的 entryOrder/toolCalls（时间线已迁至 Chat Doc），
   * 因此方法名反映语义（timeline），不再用可能误导为 Session Doc 的旧名。
   */
  hasTimelineContent(rcsSessionId: string): boolean {
    const doc = this.chatDocs.get(rcsSessionId);
    if (!doc) return false;
    return hasChatDocContent(doc.ydoc);
  }

  // ── 用户消息注册 ──

  /**
   * 注册用户消息：生成新 turn 并投递 user_message 规范化事件。
   * turnId 每次调用生成新值（恢复执行必须创建显式新 turn，不得复用已终结 turn）；
   * 返回 turnId 供控制面（CommandCoordinator）写入 committed Ack。
   */
  registerUserMessage(rcsSessionId: string, content: string): string {
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.processNormalizedEvent(rcsSessionId, {
      type: "user_message",
      update: { content: { type: "text", text: content } },
      content: { type: "text", text: content },
      turnId,
    });
    return turnId;
  }

  // ── 规范化事件微批次合并 ──

  /** 刷新指定 rcsSessionId 的批次，将所有等待中的事件批量写入 Y.Doc */
  private flushACPBatch(rcsSessionId: string): void {
    const batch = this.acpBatchBuffers.get(rcsSessionId);
    if (!batch) return;
    this.acpBatchBuffers.delete(rcsSessionId);
    clearTimeout(batch.timer);

    const chatDoc = this.chatDocs.get(rcsSessionId);
    const sessionDoc = this.sessionDocs.get(rcsSessionId);
    if (!chatDoc || !sessionDoc || batch.events.length === 0) return;

    try {
      // 窗口内全部事件合并为单个 yjs:update：外层 transact 包裹，聚合层内部的
      // 嵌套 transact 自动并入同一事务——N 个事件产生 1 次广播而非 N 次。
      chatDoc.ydoc.transact(() => {
        sessionDoc.ydoc.transact(() => {
          for (const event of batch.events) {
            // 多个事件按顺序投影；幂等性由聚合层各投影的幂等键保证
            const result = applyNormalizedEvent({ chat: chatDoc.ydoc, session: sessionDoc.ydoc }, event);
            if (!result.applied && result.reason) {
              this.onLog?.(`[DocManager] event rejected (${event.type}): ${result.reason}`);
            }
          }
        });
      });
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
   * 通知控制面：权限请求已投影到 Session Doc。expiresAt 以投影值为准
   * （聚合层对缺失值有默认），避免事件载荷与投影不一致导致定时器错位。
   */
  private notifyPermissionRequested(rcsSessionId: string, sessionDoc: Y.Doc, event: NormalizedEvent): void {
    const permissionId =
      (event.update.permissionId as string | undefined) ?? (event.update.requestId as string | undefined);
    if (typeof permissionId !== "string") return;
    const projection = (sessionDoc.getMap("root").get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined)?.get(
      permissionId,
    );
    const expiresAt =
      (projection?.get("expiresAt") as string | undefined) ??
      (event.update.expiresAt as string | undefined) ??
      new Date(Date.now() + DEFAULT_PERMISSION_TIMEOUT_MS).toISOString();
    this.onPermissionRequested?.(rcsSessionId, { permissionId, expiresAt });
  }

  /**
   * 处理单个规范化事件（聚合层唯一入口）。
   * - binding 不存在（无内存 Doc）→ 丢弃，不重建旧 Doc
   * - 内容类事件（message/reasoning 增量）进入微批次合并窗口
   * - 控制类事件（工具/权限/终态/元信息）先 flush 当前批次再立即写入
   */
  processNormalizedEvent(rcsSessionId: string, event: NormalizedEvent): void {
    const chatDoc = this.chatDocs.get(rcsSessionId);
    const sessionDoc = this.sessionDocs.get(rcsSessionId);
    if (!chatDoc || !sessionDoc) {
      this.onLog?.(`[DocManager] Session ${rcsSessionId} not in memory, event dropped`);
      return;
    }

    if (!BATCHABLE_EVENT_TYPES.has(event.type)) {
      try {
        this.flushACPBatch(rcsSessionId);
      } catch (err) {
        this.onError?.(`[DocManager] flushACPBatch failed before control event ${event.type}`, err);
      }
      const result = applyNormalizedEvent({ chat: chatDoc.ydoc, session: sessionDoc.ydoc }, event);
      if (!result.applied && result.reason) {
        this.onLog?.(`[DocManager] event rejected (${event.type}): ${result.reason}`);
      }
      if (result.applied && event.type === "permission_requested") {
        this.notifyPermissionRequested(rcsSessionId, sessionDoc.ydoc, event);
      }
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
