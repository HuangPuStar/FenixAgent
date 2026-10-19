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
import * as Y from "yjs";
import { getActiveGeneration, getOrCreateActiveGeneration, publishActiveGeneration } from "../persist/redis";
import type { SnapshotPersistConfig, SnapshotPersistConfigSource } from "../persist/snapshot-config";
import { encodeYjsReplaceFrame, MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { DEFAULT_QUESTION_TIMEOUT_MS, type NormalizedEvent } from "../schema";
import type { ChatDoc, ProjectionDocs, SessionDoc } from "../types";
import { applyNormalizedEvent } from "./aggregator";
import { getEntriesMap, getEntryOrder, getSessionRoot, hasChatDocContent, isCallbackEntryId } from "./chat-writer";
import {
  BATCHABLE_EVENT_TYPES,
  DEFAULT_BATCH_WINDOW_MS,
  normalizeUserText,
  notifyPermissionRequested,
  preserveAgentProjection,
  readEntryText,
} from "./doc-manager-projection";
import { createChatDoc, createSessionDoc, loadChatDoc, loadSessionDoc, SnapshotHydrationError } from "./factory";
import {
  type FenceSnapshot,
  type ProjectionDocKind,
  ProjectionFences,
  type ReplacementAttempt,
} from "./projection-fence";
import { SessionTitleState, type SessionTitleStore } from "./session-title-store";

export interface DocManagerOptions {
  /** Redis 连接获取器（惰性求值，支持连接延迟建立） */
  getRedis?: () => Redis | Cluster | null;
  /** 会话标题持久存储端口；生产默认使用同一 Redis 连接，测试可注入独立实现。 */
  sessionTitleStore?: SessionTitleStore;
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

/** AskUserQuestion 问题投影成功的通知（控制面据此安排 120s 超时迁移定时器） */
export type QuestionRequestedHandler = (
  rcsSessionId: string,
  question: { questionId: string; expiresAt: string },
) => void;

/**
 * 已驻留 Doc 的快路径复核结果。
 * `stale` 携带复核起点的 fence 快照：重载期间 close 可能落在 map 删除之后、内部快照
 * 捕获之前，只有这份快照能观察到那次关闭。
 */
type ExistingDocRevalidation<D> =
  | { readonly kind: "current"; readonly doc: D }
  | { readonly kind: "stale"; readonly closeGuard: FenceSnapshot };

export class DocManager {
  private chatDocs = new Map<string, ChatDoc>();
  private sessionDocs = new Map<string, SessionDoc>();
  /**
   * 每个 rcsSessionId 的投影生命周期栅栏：close 与 replace 使用独立 epoch，
   * 并登记在途换代供 open 安装前等待（语义见 projection-fence.ts）。
   */
  private readonly fences = new ProjectionFences();
  /** 同一会话的并发打开共享同一 Promise，避免重复创建 Doc / provider。 */
  private chatOpens = new Map<string, Promise<ChatDoc>>();
  private sessionOpens = new Map<string, Promise<SessionDoc>>();
  private closingSessionDocs = new Map<string, Promise<void>>();
  private readonly sessionTitles: SessionTitleState;
  private getRedis: () => Redis | Cluster | null;
  // 只能经 setSnapshotPersistConfigSource 注入：值依赖启动后才可读的宿主模块配置，
  // 而本类的生产单例在文件加载期就构造完成。
  private snapshotPersistConfig: SnapshotPersistConfigSource | null = null;
  private onYjsUpdate: ((docName: string, update: Uint8Array) => void) | null;
  private onError: ((context: string, err: unknown) => void) | undefined;
  private onLog: ((msg: string) => void) | undefined;
  private onPermissionRequested: PermissionRequestedHandler | null;
  private onQuestionRequested: QuestionRequestedHandler | null;
  private batchWindowMs: number;
  private acpBatchBuffers = new Map<string, { events: NormalizedEvent[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(options?: DocManagerOptions) {
    this.getRedis = options?.getRedis ?? (() => null);
    this.sessionTitles = new SessionTitleState(options?.sessionTitleStore ?? null);
    this.onYjsUpdate = options?.onYjsUpdate ?? null;
    this.onError = options?.onError;
    this.onLog = options?.onLog;
    this.onPermissionRequested = null;
    this.onQuestionRequested = null;
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

  /**
   * 设置或清除 AskUserQuestion 问题请求回调（控制面 SessionChannel 注入：
   * 安排 120s 超时迁移定时器，与权限回调同模式）。
   */
  setQuestionRequestedHandler(handler: QuestionRequestedHandler | null): void {
    this.onQuestionRequested = handler;
  }

  /**
   * 设置或清除快照参数来源（控制面装配注入：宿主 env 投影 → `ChatChannelDependencies.snapshotPersist`
   * → 本方法）。单槽位装配点，与权限/问题回调同模式；只在打开 Doc 时惰性求值。
   */
  setSnapshotPersistConfigSource(source: SnapshotPersistConfigSource | null): void {
    this.snapshotPersistConfig = source;
  }

  /** 宿主装配标题持久存储；Redis 与文件后端只能选择其一。 */
  setSessionTitleStore(store: SessionTitleStore | null): void {
    this.sessionTitles.setStore(store);
  }

  /** 解析快照参数；未注入时返回 undefined，由 factory 在 Redis 模式下明确拒绝。 */
  private resolveSnapshotPersistConfig(): SnapshotPersistConfig | undefined {
    return this.snapshotPersistConfig?.();
  }

  /** 丢弃水合期间已被换代 / 关闭的本地 Doc；销毁失败只上报，不覆盖主流程结论。 */
  private async discardOpenedDoc(doc: ChatDoc | SessionDoc, context: string): Promise<void> {
    try {
      await doc.destroy();
    } catch (err) {
      this.onError?.(context, err);
    }
  }

  /**
   * `stale` 水合失败的收口：map 已有新世代 Doc 时直接返回它；本地换代仍在途时等待后重查；
   * 否则返回 null，由调用方重新读取 active generation 并在上限内重试加载。
   */
  private async resolveStaleOpen<D>(
    kind: ProjectionDocKind,
    rcsSessionId: string,
    snapshot: FenceSnapshot,
    docs: Map<string, D>,
  ): Promise<D | null> {
    for (;;) {
      const current = docs.get(rcsSessionId);
      if (current) return current;
      if (this.fences.isClosed(snapshot)) throw new Error(`${kind} doc was closed during open`);
      if (!this.fences.hasReplacement(rcsSessionId)) return null;
      await this.fences.waitForReplacement(rcsSessionId);
    }
  }

  /**
   * open 的关闭判定：除内部快照外还要看快路径复核起点的快照。close 可能落在旧 Doc
   * 从 map 删除之后、内部快照捕获之前，此时内部快照拿到的是新建 fence，看不到关闭。
   */
  private isClosedForOpen(snapshot: FenceSnapshot, closeGuard?: FenceSnapshot): boolean {
    if (this.fences.isClosed(snapshot)) return true;
    return closeGuard !== undefined && this.fences.isClosed(closeGuard);
  }

  /**
   * 加载完成后的安装收口。与旧实现的区别是把“换代失败”从“关闭”中拆开：
   * - 关闭：丢弃并拒绝；
   * - 换代成功：返回 map 中的新世代 Doc；
   * - 换代失败：active generation 未变，复核世代后安装本次加载结果；
   * - 等待期间又出现换代：继续等待，绝不在换代未落定时写 map。
   */
  private async finalizeOpenedDoc<D extends ChatDoc | SessionDoc>(
    kind: ProjectionDocKind,
    rcsSessionId: string,
    snapshot: FenceSnapshot,
    closeGuard: FenceSnapshot | undefined,
    docs: Map<string, D>,
    doc: D,
    redis: Redis | Cluster | null,
  ): Promise<{ kind: "current"; doc: D } | { kind: "installed" } | { kind: "retry" }> {
    const context = `[DocManager] destroy stale ${kind} doc for ${rcsSessionId}`;
    const maxSettleLoops = 8;
    let observedReplaceEpoch = snapshot.replaceEpoch;

    for (let loop = 0; loop < maxSettleLoops; loop += 1) {
      const current = docs.get(rcsSessionId);
      if (current) {
        await this.discardOpenedDoc(doc, context);
        return { kind: "current", doc: current };
      }
      if (this.isClosedForOpen(snapshot, closeGuard)) {
        await this.discardOpenedDoc(doc, context);
        throw new Error(`${kind} doc was closed during open`);
      }

      if (this.fences.hasReplacement(rcsSessionId)) {
        await this.fences.waitForReplacement(rcsSessionId);
        continue;
      }

      // Redis 模式下安装前始终复核 active generation：fence 只能观察本进程经过同一对象的
      // 换代，close 删除登记后新 open 拿到的是新 fence；跨进程换代也不会触碰本地 epoch。
      // 复核结果先暂存，等同步段确认 close/换代优先级后再决定安装还是重试。
      const generationCurrent = redis ? await this.isGenerationCurrent(redis, rcsSessionId, doc.generation) : true;

      // 复核 await 窗口内可能发生 close / replace 提交：以下检查到写 map 之间没有 await。
      const settledCurrent = docs.get(rcsSessionId);
      if (settledCurrent) {
        await this.discardOpenedDoc(doc, context);
        return { kind: "current", doc: settledCurrent };
      }
      if (this.isClosedForOpen(snapshot, closeGuard)) {
        await this.discardOpenedDoc(doc, context);
        throw new Error(`${kind} doc was closed during open`);
      }
      if (this.fences.hasReplacement(rcsSessionId)) continue;
      if (snapshot.fence.replaceEpoch !== observedReplaceEpoch) {
        observedReplaceEpoch = snapshot.fence.replaceEpoch;
        continue;
      }
      if (!generationCurrent) {
        await this.discardOpenedDoc(doc, context);
        return { kind: "retry" };
      }

      // 从这里到写 map 没有 await：check-then-install 原子，close / replace 无法插队。
      this.registerDocBroadcast(doc.ydoc, `${kind}:${rcsSessionId}`);
      docs.set(rcsSessionId, doc);
      return { kind: "installed" };
    }

    await this.discardOpenedDoc(doc, context);
    throw new Error(`projection replacement did not settle during ${kind} open for ${rcsSessionId}`);
  }

  /** Redis 模式下确认加载世代仍是 active generation；内存模式没有跨进程换代。 */
  private async isGenerationCurrent(
    redis: Redis | Cluster | null,
    rcsSessionId: string,
    generation: string,
  ): Promise<boolean> {
    if (!redis) return true;
    // 只读复核：不复用 getOrCreateActiveGeneration，避免 key 缺失时凭空创建新世代。
    return (await getActiveGeneration(redis, rcsSessionId)) === generation;
  }

  /**
   * Redis 模式下已驻留 Doc 的快路径复核：跨进程换代不会触碰本地 fence，只能以只读
   * active generation 判定。返回 `current` 表示可直接复用；返回 `stale` 表示已驻留 Doc
   * 过期，并携带复核起点的 fence 快照，供重载流程在安装前识别同一窗口内的 close。
   */
  private async revalidateExistingDoc<D extends ChatDoc | SessionDoc>(
    kind: ProjectionDocKind,
    rcsSessionId: string,
    existing: D,
    docs: Map<string, D>,
  ): Promise<ExistingDocRevalidation<D>> {
    const redis = this.getRedis();
    // 内存模式没有跨进程换代，保持原有直接返回语义。
    if (!redis) return { kind: "current", doc: existing };

    // 先捕获 fence 快照再 await：复核窗口内 close 必须让本次 open 放弃，不得复活。
    const snapshot = this.fences.snapshot(kind, rcsSessionId);
    let active: string | null;
    try {
      active = await getActiveGeneration(redis, rcsSessionId);
    } catch (err) {
      // 已有 Doc 时 Redis 故障优先可用性：不重载、不销毁，避免调用方因 open 失败
      // 继续写消息而丢事件。代价是故障期间不收敛跨进程换代，恢复后下一次 open 收敛。
      this.onError?.(
        `[DocManager] active generation revalidation failed for existing ${kind} doc ${rcsSessionId}; reusing in-memory doc`,
        err,
      );
      return { kind: "current", doc: existing };
    }

    if (this.fences.isClosed(snapshot)) throw new Error(`${kind} doc was closed during open`);
    const current = docs.get(rcsSessionId);
    // 复核窗口内已被 close（map 为空）或 replace（map 已换对象）：以 map 当前值为准。
    if (current !== existing) {
      return current ? { kind: "current", doc: current } : { kind: "stale", closeGuard: snapshot };
    }
    if (active === existing.generation) return { kind: "current", doc: existing };
    return { kind: "stale", closeGuard: snapshot };
  }

  /**
   * open 返回前的同步复核：close 可能落在安装完成之后、调用方续体之前。
   * map 为空说明关闭已发生，拒绝返回已销毁 Doc；已被换代则返回 map 中的当前对象。
   */
  private requireCurrentDoc<D extends ChatDoc | SessionDoc>(
    kind: ProjectionDocKind,
    rcsSessionId: string,
    docs: Map<string, D>,
  ): D {
    const current = docs.get(rcsSessionId);
    if (current) return current;
    throw new Error(`${kind} doc was closed during open`);
  }

  private isStaleHydration(error: unknown): error is SnapshotHydrationError {
    return error instanceof SnapshotHydrationError && error.outcome.status === "stale";
  }

  /** 绑定 Y.Doc 的 update 事件到广播回调 */
  private registerDocBroadcast(ydoc: Y.Doc, docName: string): void {
    ydoc.on("update", (update: Uint8Array) => {
      this.onYjsUpdate?.(docName, update);
    });
  }

  // ── Chat Doc ──

  /**
   * 打开或获取已有的 Chat Doc（内存/Redis 模式）。
   *
   * Redis 模式会等待初始快照水合完成后再返回：握手历史源同步读取 `openChat()` 的结果，
   * 提前返回会把空视图当成“无历史”并缓存为已完成引导。
   * 并发调用共享同一 Promise，后到者同样在快照水合后才拿到 Doc。
   */
  async openChat(rcsSessionId: string): Promise<ChatDoc> {
    const existing = this.chatDocs.get(rcsSessionId);
    let closeGuard: FenceSnapshot | undefined;
    if (existing) {
      const checked = await this.revalidateExistingDoc("chat", rcsSessionId, existing, this.chatDocs);
      if (checked.kind === "current") return this.requireCurrentDoc("chat", rcsSessionId, this.chatDocs);
      // 快路径复核起点写入的 fence 快照：覆盖 map 删除后、重载内部快照前的 close。
      closeGuard = checked.closeGuard;
    }

    const inflight = this.chatOpens.get(rcsSessionId);
    if (inflight) {
      await inflight;
      return this.requireCurrentDoc("chat", rcsSessionId, this.chatDocs);
    }

    // 快路径复核后的 compare-and-delete 与 opening 登记必须在同一同步段完成：
    // 并发调用者只会看到完整删除或已登记的 opening，不会重复加载 / 销毁。
    const stale = existing && this.chatDocs.get(rcsSessionId) === existing ? existing : null;
    if (stale) this.chatDocs.delete(rcsSessionId);
    const opening = (async () => {
      if (stale) {
        await this.discardOpenedDoc(stale, `[DocManager] destroy stale chat doc for ${rcsSessionId}`);
      }
      return this.openChatInternal(rcsSessionId, closeGuard);
    })();
    this.chatOpens.set(rcsSessionId, opening);
    try {
      await opening;
      return this.requireCurrentDoc("chat", rcsSessionId, this.chatDocs);
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
    const snapshot = this.fences.snapshot("chat", rcsSessionId);
    const redis = this.getRedis();
    const snapshotConfig = this.resolveSnapshotPersistConfig();
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const generation = redis
        ? await getOrCreateActiveGeneration(redis, rcsSessionId)
        : (this.sessionDocs.get(rcsSessionId)?.generation ?? `gen_${crypto.randomUUID()}`);
      if (this.fences.isClosed(snapshot)) throw new Error("chat doc was closed during open");

      let doc: ChatDoc;
      try {
        doc = redis
          ? await loadChatDoc(rcsSessionId, redis, generation, snapshotConfig)
          : createChatDoc(rcsSessionId, null, generation);
      } catch (error) {
        if (!this.isStaleHydration(error)) throw error;
        const current = await this.resolveStaleOpen("chat", rcsSessionId, snapshot, this.chatDocs);
        if (current) return current;
        if (attempt === maxRetries) throw error;
        continue;
      }

      const resolution = await this.finalizeOpenedDoc(
        "chat",
        rcsSessionId,
        snapshot,
        closeGuard,
        this.chatDocs,
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
    // 先递增 closeEpoch：关闭时仍在途的 open 必须拒绝，在途 replace 必须放弃提交。
    this.fences.close("chat", rcsSessionId);
    const doc = this.chatDocs.get(rcsSessionId);
    if (doc) {
      this.chatDocs.delete(rcsSessionId);
      await doc.destroy();
    }
  }

  // ── Session Doc ──
  /**
   * 打开或获取已有的 Session Doc（_userId/_agentId 为兼容旧调用方保留）。
   * 与 `openChat` 相同：Redis 模式等待快照水合，并发调用共享同一 Promise。
   */
  async openSession(_userId: string, _agentId: string, rcsSessionId: string): Promise<SessionDoc> {
    await this.closingSessionDocs.get(rcsSessionId);
    const existing = this.sessionDocs.get(rcsSessionId);
    let closeGuard: FenceSnapshot | undefined;
    if (existing) {
      const checked = await this.revalidateExistingDoc("session", rcsSessionId, existing, this.sessionDocs);
      if (checked.kind === "current") return this.requireCurrentDoc("session", rcsSessionId, this.sessionDocs);
      // 与 openChat 相同：把复核起点快照带入重载，覆盖 delete 后的 close 窗口。
      closeGuard = checked.closeGuard;
    }

    const inflight = this.sessionOpens.get(rcsSessionId);
    if (inflight) {
      await inflight;
      return this.requireCurrentDoc("session", rcsSessionId, this.sessionDocs);
    }

    // 与 openChat 相同：compare-and-delete 与 opening 登记在同一同步段，并发调用共享一次重载。
    const stale = existing && this.sessionDocs.get(rcsSessionId) === existing ? existing : null;
    if (stale) this.sessionDocs.delete(rcsSessionId);
    const opening = (async () => {
      if (stale) {
        await this.discardOpenedDoc(stale, `[DocManager] destroy stale session doc for ${rcsSessionId}`);
      }
      return this.openSessionInternal(rcsSessionId, closeGuard);
    })();
    this.sessionOpens.set(rcsSessionId, opening);
    try {
      await opening;
      return this.requireCurrentDoc("session", rcsSessionId, this.sessionDocs);
    } finally {
      if (this.sessionOpens.get(rcsSessionId) === opening) this.sessionOpens.delete(rcsSessionId);
    }
  }

  /** 与 openChatInternal 相同：closeGuard 覆盖快路径删除旧 Doc 后的关闭窗口。 */
  private async openSessionInternal(rcsSessionId: string, closeGuard?: FenceSnapshot): Promise<SessionDoc> {
    const snapshot = this.fences.snapshot("session", rcsSessionId);
    const redis = this.getRedis();
    const snapshotConfig = this.resolveSnapshotPersistConfig();
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const generation = redis
        ? await getOrCreateActiveGeneration(redis, rcsSessionId)
        : (this.chatDocs.get(rcsSessionId)?.generation ?? `gen_${crypto.randomUUID()}`);
      if (this.fences.isClosed(snapshot)) throw new Error("session doc was closed during open");

      let doc: SessionDoc;
      try {
        doc = redis
          ? await loadSessionDoc(rcsSessionId, redis, generation, snapshotConfig)
          : createSessionDoc(rcsSessionId, null, generation);
      } catch (error) {
        if (!this.isStaleHydration(error)) throw error;
        const current = await this.resolveStaleOpen("session", rcsSessionId, snapshot, this.sessionDocs);
        if (current) return current;
        if (attempt === maxRetries) throw error;
        continue;
      }

      // 标题回读是另一段慢速 await：先快速排除已换代 / 已关闭，再刷新标题，
      // 最后仍由 finalize 做一次无竞态的安装校验。
      const existing = this.sessionDocs.get(rcsSessionId);
      if (existing) {
        await this.discardOpenedDoc(doc, `[DocManager] destroy stale session doc for ${rcsSessionId}`);
        return existing;
      }
      if (this.fences.isClosed(snapshot)) {
        await this.discardOpenedDoc(doc, `[DocManager] destroy stale session doc for ${rcsSessionId}`);
        throw new Error("session doc was closed during open");
      }
      try {
        if (!(await this.sessionTitles.refresh(rcsSessionId))) throw new Error("session metadata load superseded");
      } catch (error) {
        await doc.destroy();
        throw error;
      }

      const resolution = await this.finalizeOpenedDoc(
        "session",
        rcsSessionId,
        snapshot,
        closeGuard,
        this.sessionDocs,
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

  /** 将当前 RCS 会话内的 ACP 会话标题写入 Redis 权威元数据，再更新 Session Doc 投影。 */
  async renameSession(
    rcsSessionId: string,
    sessionId: string,
    title: string,
    boundSessionId: string | null,
  ): Promise<void> {
    const doc = this.sessionDocs.get(rcsSessionId);
    if (!doc) throw new Error("session metadata unavailable");
    await this.sessionTitles.rename(doc.ydoc, rcsSessionId, sessionId, title, boundSessionId);
  }

  /** Agent 确认删除后移除 Fenix 标题，防止同 ID 的后继列表继承旧名称。 */
  async removeSessionTitle(rcsSessionId: string, sessionId: string): Promise<void> {
    await this.sessionTitles.delete(rcsSessionId, sessionId);
  }

  /** 每次接收 Agent 列表前回读持久标题，确保其他进程的重命名不会被本地旧缓存覆盖。 */
  async refreshSessionTitles(rcsSessionId: string): Promise<boolean> {
    return this.sessionTitles.refresh(rcsSessionId);
  }

  getSession(rcsSessionId: string): SessionDoc | undefined {
    return this.sessionDocs.get(rcsSessionId);
  }

  getSessionYdoc(rcsSessionId: string): Y.Doc | undefined {
    return this.sessionDocs.get(rcsSessionId)?.ydoc;
  }

  /** 关闭并销毁 Session Doc，同时取消待处理的 ACP 批次 */
  async closeSession(rcsSessionId: string): Promise<void> {
    const existingClose = this.closingSessionDocs.get(rcsSessionId);
    if (existingClose) return existingClose;
    // 先递增 closeEpoch：关闭时仍在途的 open 必须拒绝，在途 replace 必须放弃提交。
    this.fences.close("session", rcsSessionId);
    this.cancelACPBatch(rcsSessionId);
    const doc = this.sessionDocs.get(rcsSessionId);
    this.sessionDocs.delete(rcsSessionId);
    const closing = (async () => {
      await this.sessionTitles.close(rcsSessionId);
      if (doc) await doc.destroy();
    })();
    this.closingSessionDocs.set(rcsSessionId, closing);
    try {
      await closing;
    } finally {
      if (this.closingSessionDocs.get(rcsSessionId) === closing) this.closingSessionDocs.delete(rcsSessionId);
    }
  }

  // ── 投影换代 ──
  /** 返回当前 Chat/Session 投影共同世代；尚未完整打开时返回 null。 */
  getProjectionGeneration(rcsSessionId: string): string | null {
    const chat = this.chatDocs.get(rcsSessionId);
    const session = this.sessionDocs.get(rcsSessionId);
    return chat && session && chat.generation === session.generation ? chat.generation : null;
  }

  /**
   * 创建全新 StructStore 并原子替换 Chat/Session 投影组。
   * 新 Doc 完整构造并绑定广播后才交换 map；旧 provider 在交换后销毁，迟到事件因
   * processNormalizedEvent 总是从 map 取当前 Doc，不会写回旧 generation。
   */
  async replaceProjection(rcsSessionId: string, targetAcpSessionId: string | null): Promise<ProjectionDocs> {
    return this.fences.runReplacement(rcsSessionId, (attempt) =>
      this.replaceProjectionInternal(rcsSessionId, targetAcpSessionId, attempt),
    );
  }

  private async replaceProjectionInternal(
    rcsSessionId: string,
    targetAcpSessionId: string | null,
    attempt: ReplacementAttempt,
  ): Promise<ProjectionDocs> {
    this.cancelACPBatch(rcsSessionId);
    const generation = `gen_${crypto.randomUUID()}`;
    const redis = this.getRedis();
    const expectedGeneration = redis
      ? await getOrCreateActiveGeneration(redis, rcsSessionId)
      : (this.getProjectionGeneration(rcsSessionId) ?? generation);
    let chat: ChatDoc | null = null;
    let session: SessionDoc | null = null;
    let publishedGeneration = false;
    try {
      // 换代同样走装配投影的快照参数：新 generation 的 provider 需要同一组节流 / TTL 值。
      const snapshot = this.resolveSnapshotPersistConfig();
      chat = createChatDoc(rcsSessionId, redis, generation, snapshot);
      session = createSessionDoc(rcsSessionId, redis, generation, snapshot);
      const oldChat = this.chatDocs.get(rcsSessionId);
      const oldSession = this.sessionDocs.get(rcsSessionId);
      preserveAgentProjection(oldSession?.ydoc, session.ydoc);

      // 超限 replacement 交给 broadcaster 丢帧并留诊断；换代本身不得在提交前失败。
      for (const [docName, update] of [
        [`chat:${rcsSessionId}`, Y.encodeStateAsUpdate(chat.ydoc)],
        [`session:${rcsSessionId}`, Y.encodeStateAsUpdate(session.ydoc)],
      ] as const) {
        if (update.byteLength > MAX_YJS_SYNC_PAYLOAD_BYTES) continue;
        encodeYjsReplaceFrame(docName, generation, update);
      }

      // publish 之前先校验一次：已关闭时不必再推进 active generation。
      this.fences.assertReplacementOpen(attempt);
      if (redis && !(await publishActiveGeneration(redis, rcsSessionId, expectedGeneration, generation))) {
        throw new Error("projection generation changed concurrently");
      }
      publishedGeneration = redis !== null;
      // publish await 窗口内可能发生 close：关闭优先，销毁新 Doc 并放弃提交，
      // 绝不把已关闭的会话重新写回 map（复活）。
      this.fences.assertReplacementOpen(attempt);

      this.registerDocBroadcast(chat.ydoc, `chat:${rcsSessionId}`);
      this.registerDocBroadcast(session.ydoc, `session:${rcsSessionId}`);
      this.chatDocs.set(rcsSessionId, chat);
      this.sessionDocs.set(rcsSessionId, session);
      // 提交后再次递增：覆盖在换代等待窗口内才完成加载、且尚未安装的 open。
      this.fences.commitReplacement(attempt);

      try {
        await Promise.all([oldChat?.destroy(), oldSession?.destroy()]);
      } catch (err) {
        this.onError?.("destroy replaced projection", err);
      }
      return { rcsSessionId, generation, targetAcpSessionId, chat, session };
    } catch (err) {
      // CAS 已推进 active generation 后仍可能被 close 中止；不回滚 Redis（可能已被别的换代推进），
      // 但必须留下明确诊断：后续 open 的安装前复核会选中该新世代。
      if (publishedGeneration) {
        this.onLog?.(
          `[DocManager] replacement for ${rcsSessionId} advanced active generation to ${generation} before being aborted`,
        );
      }
      await Promise.allSettled([chat?.destroy(), session?.destroy()]);
      throw err;
    }
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

  /**
   * 文档中是否已存在同文本的 user entry（实时回显 / 重复回放的去重判定）。
   *
   * 用途：窗口外无 turnId 的 user_message（relay 的 callback 分类）需要区分
   * 「实时 prompt 回显 / 迟到历史回放」与「真异步回调」。回显的文本必然已由
   * `registerUserMessage` 写入 Chat Doc，命中即回显/重复回放；未命中视为回调。
   *
   * 匹配集合排除 callback_* 条目：它们同样是 role=user，但不是 `registerUserMessage`
   * 写的（是回调自己的提问气泡）。纳入匹配会让周期性重复同一提示词的真回调命中上
   * 一次回调的条目，提问与回答整条被静默丢弃——数据丢失比错位更糟，故回调条目
   * 一律不参与回显去重。
   *
   * 归一化口径：trim + 折叠空白——引擎回显可能改写空白，逐字比较会漏判；
   * 空文本一律返回 false（不得把空回显当"已有内容"，否则真回调会被吞）。
   * 复杂度 O(entry 数)，每条回显帧一次调用，无需缓存（条目量级放大时再加窗口）。
   */
  hasUserMessageText(rcsSessionId: string, text: string): boolean {
    const doc = this.chatDocs.get(rcsSessionId);
    if (!doc) return false;
    const target = normalizeUserText(text);
    if (!target) return false;
    const entries = getEntriesMap(doc.ydoc);
    for (const entryId of getEntryOrder(doc.ydoc).toArray()) {
      if (isCallbackEntryId(entryId)) continue;
      const entry = entries.get(entryId);
      if (entry?.get("role") !== "user") continue;
      if (normalizeUserText(readEntryText(entry)) === target) return true;
    }
    return false;
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
  /** 通知控制面：AskUserQuestion 问题已投影到 Session Doc（expiresAt 以投影值为准） */
  private notifyQuestionRequested(rcsSessionId: string, sessionDoc: Y.Doc, event: NormalizedEvent): void {
    const questionId = event.update.questionId as string | undefined;
    if (typeof questionId !== "string") return;
    const projection = (sessionDoc.getMap("root").get("pendingQuestions") as Y.Map<Y.Map<unknown>> | undefined)?.get(
      questionId,
    );
    const expiresAt =
      (projection?.get("expiresAt") as string | undefined) ??
      (event.update.expiresAt as string | undefined) ??
      new Date(Date.now() + DEFAULT_QUESTION_TIMEOUT_MS).toISOString();
    this.onQuestionRequested?.(rcsSessionId, { questionId, expiresAt });
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
      const projectedEvent = this.sessionTitles.project(
        rcsSessionId,
        event,
        (getSessionRoot(sessionDoc.ydoc).get("session") as Y.Map<unknown>).get("sessionId"),
      );
      const result = applyNormalizedEvent({ chat: chatDoc.ydoc, session: sessionDoc.ydoc }, projectedEvent);
      if (!result.applied && result.reason) {
        this.onLog?.(`[DocManager] event rejected (${event.type}): ${result.reason}`);
      }
      if (result.applied && event.type === "permission_requested") {
        notifyPermissionRequested(this.onPermissionRequested, rcsSessionId, sessionDoc.ydoc, event);
      }
      if (result.applied && event.type === "question_requested") {
        this.notifyQuestionRequested(rcsSessionId, sessionDoc.ydoc, event);
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

  /**
   * 观测信号（SP-C2）：当前内存中打开的 Chat / Session Doc 数量。
   * 仅用于周期日志与长期采集（内存回收是否生效的曲线），不承载业务语义。
   */
  openedDocCount(): { chat: number; session: number } {
    return { chat: this.chatDocs.size, session: this.sessionDocs.size };
  }

  /** 关闭所有 Doc 并清理内部状态 */
  async closeAll(): Promise<void> {
    // 先整体递增 closeEpoch 并清空登记：在途 open / replace 通过持有的 fence 引用观察到
    // 关闭，新 open 使用全新登记；避免 fence Map 随会话累积。
    this.fences.closeAll();

    const batchKeys = [...this.acpBatchBuffers.keys()];
    for (const rcsSessionId of batchKeys) {
      this.cancelACPBatch(rcsSessionId);
    }

    for (const rcsSessionId of [...this.sessionDocs.keys()]) await this.closeSession(rcsSessionId);

    for (const doc of this.chatDocs.values()) {
      await doc.destroy();
    }
    this.chatDocs.clear();
  }
}
