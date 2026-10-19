// packages/chat-channel/src/state/doc-open-service.ts
// Chat / Session Doc 的打开与关闭生命周期：并发 open 合并、快路径复核、安装收口与关闭登记。
//
// DocManager 持有 Map、fences、标题状态与配置来源，本类只通过构造参数共享这些对象，
// 不复制状态；replaceProjection 与 closeAll 使用 DocManager 持有的同一份 fences。

import type { Cluster, Redis } from "ioredis";
import { getOrCreateActiveGeneration } from "../persist/redis";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import type { ChatDoc, SessionDoc } from "../types";
import {
  type DocOpenFenceDeps,
  discardOpenedDoc,
  finalizeOpenedDoc,
  isClosedForOpen,
  isStaleHydration,
  requireCurrentDoc,
  resolveStaleOpen,
  revalidateExistingDoc,
} from "./doc-open-fence";
import { createChatDoc, createSessionDoc, loadChatDoc, loadSessionDoc } from "./factory";
import type { FenceSnapshot } from "./projection-fence";
import type { SessionTitleState } from "./session-title-store";

export interface DocOpenServiceDeps extends DocOpenFenceDeps {
  readonly chatDocs: Map<string, ChatDoc>;
  readonly sessionDocs: Map<string, SessionDoc>;
  readonly sessionTitles: SessionTitleState;
  /** 与 DocManager.closeAll 共享，用于 closeSession / openSession 的关闭去重。 */
  readonly closingSessionDocs: Map<string, Promise<void>>;
  readonly cancelACPBatch: (rcsSessionId: string) => void;
  readonly cancelAllACPBatches: () => void;
  readonly resolveSnapshotPersistConfig: () => SnapshotPersistConfig | undefined;
}

export class DocOpenService {
  /** 同一会话的并发打开共享同一 Promise，避免重复创建 Doc / provider。 */
  private readonly chatOpens = new Map<string, Promise<ChatDoc>>();
  private readonly sessionOpens = new Map<string, Promise<SessionDoc>>();

  constructor(private readonly deps: DocOpenServiceDeps) {}

  // ── Chat Doc ──

  /**
   * 打开或获取已有的 Chat Doc（内存/Redis 模式）。
   *
   * Redis 模式会等待初始快照水合完成后再返回：握手历史源同步读取 `openChat()` 的结果，
   * 提前返回会把空视图当成“无历史”并缓存为已完成引导。
   * 并发调用共享同一 Promise，后到者同样在快照水合后才拿到 Doc。
   */
  async openChat(rcsSessionId: string): Promise<ChatDoc> {
    const existing = this.deps.chatDocs.get(rcsSessionId);
    let closeGuard: FenceSnapshot | undefined;
    if (existing) {
      const checked = await revalidateExistingDoc(this.deps, "chat", rcsSessionId, existing, this.deps.chatDocs);
      if (checked.kind === "current") return requireCurrentDoc("chat", rcsSessionId, this.deps.chatDocs);
      // 快路径复核起点写入的 fence 快照：覆盖 map 删除后、重载内部快照前的 close。
      closeGuard = checked.closeGuard;
    }

    const inflight = this.chatOpens.get(rcsSessionId);
    if (inflight) {
      await inflight;
      return requireCurrentDoc("chat", rcsSessionId, this.deps.chatDocs);
    }

    // 快路径复核后的 compare-and-delete 与 opening 登记必须在同一同步段完成：
    // 并发调用者只会看到完整删除或已登记的 opening，不会重复加载 / 销毁。
    const stale = existing && this.deps.chatDocs.get(rcsSessionId) === existing ? existing : null;
    if (stale) this.deps.chatDocs.delete(rcsSessionId);
    const opening = (async () => {
      if (stale) {
        await discardOpenedDoc(stale, `[DocManager] destroy stale chat doc for ${rcsSessionId}`, this.deps.onError);
      }
      return this.openChatInternal(rcsSessionId, closeGuard);
    })();
    this.chatOpens.set(rcsSessionId, opening);
    try {
      await opening;
      return requireCurrentDoc("chat", rcsSessionId, this.deps.chatDocs);
    } finally {
      if (this.chatOpens.get(rcsSessionId) === opening) this.chatOpens.delete(rcsSessionId);
    }
  }

  /**
   * @param closeGuard 快路径 stale 时捕获的 fence 快照；安装前复核，识别旧 Doc 已从 map
   * 删除、但本方法尚未捕获内部快照期间发生的 close。
   */
  private async openChatInternal(rcsSessionId: string, closeGuard?: FenceSnapshot): Promise<ChatDoc> {
    // 快照在首次 await 前捕获并贯穿所有重试：即便 close 随后移除了 fence 登记，
    // 本次 open 仍通过对象引用观察到关闭。
    const snapshot = this.deps.fences.snapshot("chat", rcsSessionId);
    const redis = this.deps.getRedis();
    const snapshotConfig = this.deps.resolveSnapshotPersistConfig();
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const generation = redis
        ? await getOrCreateActiveGeneration(redis, rcsSessionId)
        : (this.deps.sessionDocs.get(rcsSessionId)?.generation ?? `gen_${crypto.randomUUID()}`);
      if (this.deps.fences.isClosed(snapshot)) throw new Error("chat doc was closed during open");

      let doc: ChatDoc;
      try {
        doc = redis
          ? await loadChatDoc(rcsSessionId, redis, generation, snapshotConfig)
          : createChatDoc(rcsSessionId, null, generation);
      } catch (error) {
        if (!isStaleHydration(error)) throw error;
        const current = await resolveStaleOpen(this.deps.fences, "chat", rcsSessionId, snapshot, this.deps.chatDocs);
        if (current) return current;
        if (attempt === maxRetries) throw error;
        continue;
      }

      const resolution = await finalizeOpenedDoc(
        this.deps,
        "chat",
        rcsSessionId,
        snapshot,
        closeGuard,
        this.deps.chatDocs,
        doc,
        redis,
      );
      if (resolution.kind === "current") return resolution.doc;
      if (resolution.kind === "installed") return doc;
      if (attempt === maxRetries) {
        throw new Error(`chat doc generation changed during open for ${rcsSessionId}`);
      }
    }

    throw new Error(`chat doc open exhausted retries for ${rcsSessionId}`);
  }

  // ── Session Doc ──
  /**
   * 打开或获取已有的 Session Doc（_userId/_agentId 为兼容旧调用方保留）。
   * 与 `openChat` 相同：Redis 模式等待快照水合，并发调用共享同一 Promise。
   */
  async openSession(_userId: string, _agentId: string, rcsSessionId: string): Promise<SessionDoc> {
    await this.deps.closingSessionDocs.get(rcsSessionId);
    const existing = this.deps.sessionDocs.get(rcsSessionId);
    let closeGuard: FenceSnapshot | undefined;
    if (existing) {
      const checked = await revalidateExistingDoc(this.deps, "session", rcsSessionId, existing, this.deps.sessionDocs);
      if (checked.kind === "current") return requireCurrentDoc("session", rcsSessionId, this.deps.sessionDocs);
      // 与 openChat 相同：把复核起点快照带入重载，覆盖 delete 后的 close 窗口。
      closeGuard = checked.closeGuard;
    }

    const inflight = this.sessionOpens.get(rcsSessionId);
    if (inflight) {
      await inflight;
      return requireCurrentDoc("session", rcsSessionId, this.deps.sessionDocs);
    }

    // 与 openChat 相同：compare-and-delete 与 opening 登记在同一同步段，并发调用共享一次重载。
    const stale = existing && this.deps.sessionDocs.get(rcsSessionId) === existing ? existing : null;
    if (stale) this.deps.sessionDocs.delete(rcsSessionId);
    const opening = (async () => {
      if (stale) {
        await discardOpenedDoc(stale, `[DocManager] destroy stale session doc for ${rcsSessionId}`, this.deps.onError);
      }
      return this.openSessionInternal(rcsSessionId, closeGuard);
    })();
    this.sessionOpens.set(rcsSessionId, opening);
    try {
      await opening;
      return requireCurrentDoc("session", rcsSessionId, this.deps.sessionDocs);
    } finally {
      if (this.sessionOpens.get(rcsSessionId) === opening) this.sessionOpens.delete(rcsSessionId);
    }
  }

  /** 与 openChatInternal 相同：closeGuard 覆盖快路径删除旧 Doc 后的关闭窗口。 */
  private async openSessionInternal(rcsSessionId: string, closeGuard?: FenceSnapshot): Promise<SessionDoc> {
    const snapshot = this.deps.fences.snapshot("session", rcsSessionId);
    const redis = this.deps.getRedis();
    const snapshotConfig = this.deps.resolveSnapshotPersistConfig();
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const generation = redis
        ? await getOrCreateActiveGeneration(redis, rcsSessionId)
        : (this.deps.chatDocs.get(rcsSessionId)?.generation ?? `gen_${crypto.randomUUID()}`);
      if (this.deps.fences.isClosed(snapshot)) throw new Error("session doc was closed during open");

      let doc: SessionDoc;
      try {
        doc = redis
          ? await loadSessionDoc(rcsSessionId, redis, generation, snapshotConfig)
          : createSessionDoc(rcsSessionId, null, generation);
      } catch (error) {
        if (!isStaleHydration(error)) throw error;
        const current = await resolveStaleOpen(
          this.deps.fences,
          "session",
          rcsSessionId,
          snapshot,
          this.deps.sessionDocs,
        );
        if (current) return current;
        if (attempt === maxRetries) throw error;
        continue;
      }

      // 标题回读是另一段慢速 await：先快速排除已换代 / 已关闭，再刷新标题，
      // 最后仍由 finalize 做一次无竞态的安装校验。
      const existing = this.deps.sessionDocs.get(rcsSessionId);
      if (existing) {
        await discardOpenedDoc(doc, `[DocManager] destroy stale session doc for ${rcsSessionId}`, this.deps.onError);
        return existing;
      }
      if (this.deps.fences.isClosed(snapshot)) {
        await discardOpenedDoc(doc, `[DocManager] destroy stale session doc for ${rcsSessionId}`, this.deps.onError);
        throw new Error("session doc was closed during open");
      }
      try {
        if (!(await this.deps.sessionTitles.refresh(rcsSessionId))) throw new Error("session metadata load superseded");
      } catch (error) {
        await doc.destroy();
        throw error;
      }

      const resolution = await finalizeOpenedDoc(
        this.deps,
        "session",
        rcsSessionId,
        snapshot,
        closeGuard,
        this.deps.sessionDocs,
        doc,
        redis,
      );
      if (resolution.kind === "current") return resolution.doc;
      if (resolution.kind === "installed") return doc;
      if (attempt === maxRetries) {
        throw new Error(`session doc generation changed during open for ${rcsSessionId}`);
      }
    }

    throw new Error(`session doc open exhausted retries for ${rcsSessionId}`);
  }

  /** 关闭并销毁 Chat Doc */
  async closeChat(rcsSessionId: string): Promise<void> {
    // 先递增 closeEpoch：关闭时仍在途的 open 必须拒绝，在途 replace 必须放弃提交。
    this.deps.fences.close("chat", rcsSessionId);
    const doc = this.deps.chatDocs.get(rcsSessionId);
    if (doc) {
      this.deps.chatDocs.delete(rcsSessionId);
      await doc.destroy();
    }
  }

  /** 关闭并销毁 Session Doc，同时取消待处理的 ACP 批次 */
  async closeSession(rcsSessionId: string): Promise<void> {
    const existingClose = this.deps.closingSessionDocs.get(rcsSessionId);
    if (existingClose) return existingClose;
    // 先递增 closeEpoch：关闭时仍在途的 open 必须拒绝，在途 replace 必须放弃提交。
    this.deps.fences.close("session", rcsSessionId);
    this.deps.cancelACPBatch(rcsSessionId);
    const doc = this.deps.sessionDocs.get(rcsSessionId);
    this.deps.sessionDocs.delete(rcsSessionId);
    const closing = (async () => {
      await this.deps.sessionTitles.close(rcsSessionId);
      if (doc) await doc.destroy();
    })();
    this.deps.closingSessionDocs.set(rcsSessionId, closing);
    try {
      await closing;
    } finally {
      if (this.deps.closingSessionDocs.get(rcsSessionId) === closing) this.deps.closingSessionDocs.delete(rcsSessionId);
    }
  }

  /** 关闭所有 Doc 并清理内部状态。 */
  async closeAll(): Promise<void> {
    // 先整体递增 closeEpoch 并清空登记：在途 open / replace 通过持有的 fence 引用观察到
    // 关闭，新 open 使用全新登记；避免 fence Map 随会话累积。
    this.deps.fences.closeAll();
    this.deps.cancelAllACPBatches();

    for (const rcsSessionId of [...this.deps.sessionDocs.keys()]) await this.closeSession(rcsSessionId);

    for (const doc of this.deps.chatDocs.values()) {
      await doc.destroy();
    }
    this.deps.chatDocs.clear();
  }
}
