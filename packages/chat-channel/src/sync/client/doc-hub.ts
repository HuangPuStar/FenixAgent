// packages/chat-channel/src/sync/client/doc-hub.ts
// 客户端唯一 apply 入口与调度（设计 §8.6 第 2/4/5/6 条，规格 §3.3）。
//
// 为什么必须收口：`Y.applyUpdate` 同步且不可中断，收包路径直接 apply 会把「解码 + 结构合并 +
// observer 扫描」压进 onmessage，长会话高速输出下顶住整条主线程。这里集中 apply，按预算分片，
// 并在分片之间经注入的 yieldToHost 让出执行权（不递归 microtask）。
// 浏览器安全（规格 §3.3）：不 import node 内建、fs、process、Buffer；时间只取注入的 now。
//
// 顺序即契约（设计 §8.6 第 4 条）：processed 结果只在 apply 返回、序号/attempt 校验完成、且排队项
// 已出队（接收额度已归还）之后回调；入队、postMessage、worker 收到任务都不构成确认。

import * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import { assertMonotonicSeq, parseDocId } from "../protocol/identity";
import { type ApplyQueueEntry, createApplyQueue } from "./apply-queue";

/** 一次待应用的同步投递；字段与 `DOC_BASE` / `DOC_UPDATE` 的数据面一一对应。 */
export interface ApplyTask {
  readonly kind: "base" | "update";
  readonly docId: string;
  readonly generation: string;
  readonly subscriptionEpoch: string;
  readonly syncAttemptId: string;
  readonly deliveryId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly payload: Uint8Array;
  readonly digest: string;
}

/** apply 结果：`processed` 才允许被调用方当作 ACK 发出。 */
export interface ApplyOutcome {
  readonly deliveryId: string;
  readonly result: "processed" | "rejected";
  readonly reason?: string;
}

/**
 * `ApplyOutcome.reason` 的稳定词表：调用方据它区分「可补齐」「已作废」与「需重订」，不要匹配自由文本。
 *
 * - `malformed-task` / `unknown-doc`：任务结构或归属不合法，未入队；
 * - `generation-mismatch` / `subscription-epoch-stale` / `sync-attempt-stale`：异代或旧 attempt（§8.3）；
 * - `base-not-ready` / `sequence-gap`：该 Doc 当前不可连续应用，已申请补齐（§8.4）；
 * - `duplicate-range`：已应用边界之内，不再推进游标；
 * - `payload-too-large` / `queue-overflow`：超出接收预算（§10.4）；
 * - `apply-failed`：Yjs 应用失败，该 Doc 实例已弃用（§8.6 第 5 条）。
 */
export const APPLY_REJECT_REASONS = {
  malformedTask: "malformed-task",
  unknownDoc: "unknown-doc",
  generationMismatch: "generation-mismatch",
  subscriptionEpochStale: "subscription-epoch-stale",
  syncAttemptStale: "sync-attempt-stale",
  baseNotReady: "base-not-ready",
  sequenceGap: "sequence-gap",
  duplicateRange: "duplicate-range",
  payloadTooLarge: "payload-too-large",
  queueOverflow: "queue-overflow",
  applyFailed: "apply-failed",
} as const;

export type ApplyRejectReason = (typeof APPLY_REJECT_REASONS)[keyof typeof APPLY_REJECT_REASONS];

export interface DocHubOptions {
  readonly maxQueueBytes: number;
  readonly maxQueueTasks: number;
  /** 一次调度处理的字节/次数/时间上限；到限即让出执行权。 */
  readonly budget: { readonly maxBytes: number; readonly maxTasks: number; readonly maxMillis: number };
  readonly now: () => number;
  /** 让出执行权的原语；浏览器传宏任务调度器，测试可注入同步实现。 */
  readonly yieldToHost: () => Promise<void>;
  /** apply 结果回调；实现方据此发 ACK。 */
  readonly onOutcome: (outcome: ApplyOutcome) => void;
  /** 需要重新申请 base 时回调（设计 §8.6 第 5 条）。 */
  readonly onResyncRequired: (docId: string, reason: string) => void;
}

export interface DocHub {
  /** onmessage 边界：校验并放入有界队列，不直接同步 apply。 */
  enqueue(task: ApplyTask): void;
  /** 驱动一次调度；不递归 microtask。 */
  drain(): Promise<void>;
  /** 已加载 Doc 的引用计数管理（设计 §8.6 第 6 条）。 */
  retain(docId: string): void;
  release(docId: string): void;
  loadedBytes(): number;
  queueDepth(): number;
  dispose(): void;
}

/** 单个已加载 Doc 的同步状态。 */
interface DocEntry {
  readonly docId: string;
  /** 来自 docId 谱系，不接受任务字段改写：代次只能由握手/`GENERATION_REPLACE` 引入（§8.3）。 */
  readonly generation: string;
  doc: Y.Doc;
  refCount: number;
  subscriptionEpoch: string | null;
  syncAttemptId: string | null;
  /** 可信基线是否已建立；false 时不得应用增量（§8.4）。不变量：false ⇒ appliedSeq === 0。 */
  baseReady: boolean;
  /** 同一 attempt 内的连续应用边界；单调不减——重传的旧 base 只并内容，不回退边界（见 applyBase）。 */
  appliedSeq: number;
  /** 保守驻留估算：累计已应用载荷字节；Yjs 合并/GC 只会让它高估，不会低估（安全方向）。 */
  residentBytes: number;
  /** 已发出补齐申请且尚未被新基线清除，避免失败路径重复回调。 */
  resyncRequested: boolean;
}

function assertBudget(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`doc hub budget ${name} must be a non-negative finite number, received ${String(value)}`);
  }
}

export function createDocHub(options: DocHubOptions): DocHub {
  assertBudget("maxBytes", options.budget.maxBytes);
  assertBudget("maxTasks", options.budget.maxTasks);
  assertBudget("maxMillis", options.budget.maxMillis);

  const queue = createApplyQueue({ maxBytes: options.maxQueueBytes, maxTasks: options.maxQueueTasks });
  const entries = new Map<string, DocEntry>();
  let draining: Promise<void> | null = null;
  let disposed = false;

  function isCurrentAttempt(entry: DocEntry, task: ApplyTask): boolean {
    return entry.subscriptionEpoch === task.subscriptionEpoch && entry.syncAttemptId === task.syncAttemptId;
  }

  function staleReason(entry: DocEntry, task: ApplyTask): ApplyRejectReason {
    return entry.subscriptionEpoch === task.subscriptionEpoch
      ? APPLY_REJECT_REASONS.syncAttemptStale
      : APPLY_REJECT_REASONS.subscriptionEpochStale;
  }

  function emitRejected(task: ApplyTask, reason: ApplyRejectReason): void {
    options.onOutcome({ deliveryId: task.deliveryId, result: "rejected", reason });
  }

  /**
   * 同一 Doc 的补齐申请在收到新基线前只发一次：缺口/失败后队列里剩的帧会连续失败，
   * 逐条回调会把 resync 风暴打到会话层（不做无边界重试）。
   *
   * `force` 用于「补齐申请的回应本身又失败」：此时不重新申请，客户端会永久停在缺基线状态
   * ——不传播失败同样是一种静默掩盖。
   */
  function requestResync(entry: DocEntry, reason: string, force = false): void {
    if (entry.resyncRequested && !force) {
      return;
    }
    entry.resyncRequested = true;
    options.onResyncRequired(entry.docId, reason);
  }

  /** 弃用当前实例：apply 可能已部分写入，含这些字节的 Doc 不可继续作为基线（§8.6 第 5 条）。 */
  function dropDocContent(entry: DocEntry): void {
    entry.doc.destroy();
    entry.doc = new Y.Doc();
    entry.residentBytes = 0;
    entry.baseReady = false;
    entry.appliedSeq = 0;
  }

  /** 保留 Yjs 失败原文作为诊断后缀：原因词表匹配只看前缀，诊断信息不因此丢失。 */
  function describeApplyFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return message.length > 0 ? `${APPLY_REJECT_REASONS.applyFailed}: ${message}` : APPLY_REJECT_REASONS.applyFailed;
  }

  /**
   * apply 返回后的 attempt 复核（§8.6 第 4 条：确认需在 apply 返回且校验完成之后）。
   * 只可能在 observer 重入把 attempt 换掉的场景下失败，此时该帧字节已不属于新基线。
   */
  function supersededAfterApply(entry: DocEntry, task: ApplyTask): boolean {
    if (isCurrentAttempt(entry, task)) {
      return false;
    }
    emitRejected(task, staleReason(entry, task));
    return true;
  }

  function applyBase(entry: DocEntry, task: ApplyTask): void {
    // 无基线时只能从**空** Doc 应用完整 snapshot；已有基线时该帧是同一 attempt 内的增量差分，
    // 必须落在原实例上（换实例即换 attempt，见 §8.4）。ApplyTask 冻结签名不带 base mode，
    // 该判定完全依赖本地基线状态。
    const replacing = !entry.baseReady;
    const target = replacing ? new Y.Doc() : entry.doc;
    try {
      Y.applyUpdate(target, task.payload);
    } catch (error) {
      if (replacing) {
        // 候选实例未生效，现役实例未被触碰：只丢候选，既有内容留给视图继续展示。
        target.destroy();
      } else {
        dropDocContent(entry);
      }
      emitRejected(task, APPLY_REJECT_REASONS.applyFailed);
      requestResync(entry, describeApplyFailure(error), true);
      return;
    }
    if (supersededAfterApply(entry, task)) {
      if (replacing) {
        target.destroy();
      }
      return;
    }
    if (replacing) {
      entry.doc.destroy();
      entry.doc = target;
      entry.residentBytes = task.payload.byteLength;
    } else {
      entry.residentBytes += task.payload.byteLength;
    }
    entry.baseReady = true;
    // 边界只能前进：同一 attempt 内的 base 是「基线 + 差分」的递进（§8.4），服务端重传或乱序会让旧 base
    // 后到。无条件回写旧边界会让紧随其后的合法增量（fromSeq = 新边界 + 1）被判成序号缺口，并连带作废基线，
    // 触发一次多余的完整补齐；内容由 Yjs 幂等合并，因此这里只取前进方向。
    entry.appliedSeq = Math.max(entry.appliedSeq, task.toSeq);
    entry.resyncRequested = false;
    options.onOutcome({ deliveryId: task.deliveryId, result: "processed" });
  }

  function applyIncrement(entry: DocEntry, task: ApplyTask): void {
    if (!entry.baseReady) {
      // BASE_READY 之前不得应用增量：把它并入不可信前置状态会让内容看似完整（§8.4）。
      emitRejected(task, APPLY_REJECT_REASONS.baseNotReady);
      requestResync(entry, APPLY_REJECT_REASONS.baseNotReady);
      return;
    }
    if (task.toSeq <= entry.appliedSeq) {
      // 已应用边界之内（重传/重复帧）：不再推进游标；Yjs 幂等不以牺牲序号连续性为代价。
      emitRejected(task, APPLY_REJECT_REASONS.duplicateRange);
      return;
    }
    try {
      assertMonotonicSeq(task.fromSeq, entry.appliedSeq);
    } catch (error) {
      // 只把「序号缺口」转成拒绝结果，其余异常原样抛出，避免把实现缺陷伪装成数据问题。
      if (!(error instanceof SyncProtocolError) || error.code !== "SEQUENCE_GAP") {
        throw error;
      }
      entry.baseReady = false;
      entry.appliedSeq = 0;
      emitRejected(task, APPLY_REJECT_REASONS.sequenceGap);
      requestResync(entry, APPLY_REJECT_REASONS.sequenceGap);
      return;
    }
    try {
      Y.applyUpdate(entry.doc, task.payload);
    } catch (error) {
      dropDocContent(entry);
      emitRejected(task, APPLY_REJECT_REASONS.applyFailed);
      requestResync(entry, describeApplyFailure(error));
      return;
    }
    if (supersededAfterApply(entry, task)) {
      return;
    }
    entry.appliedSeq = task.toSeq;
    entry.residentBytes += task.payload.byteLength;
    options.onOutcome({ deliveryId: task.deliveryId, result: "processed" });
  }

  function processOne(queued: ApplyQueueEntry): void {
    const { task } = queued;
    const entry = entries.get(task.docId);
    if (entry === undefined) {
      // 排队期间该 Doc 已被 release：帧已无归属，只结清传输额度，不申请补齐（不会重新订阅）。
      emitRejected(task, APPLY_REJECT_REASONS.unknownDoc);
      return;
    }
    if (!isCurrentAttempt(entry, task)) {
      // 排队期间换了 attempt：旧帧只结清原账本，不 apply、不动新游标（§8.3）。
      emitRejected(task, staleReason(entry, task));
      return;
    }
    if (task.kind === "base") {
      applyBase(entry, task);
      return;
    }
    applyIncrement(entry, task);
  }

  async function drainSlices(): Promise<void> {
    while (!disposed) {
      const sliceStart = options.now();
      let sliceTasks = 0;
      let sliceBytes = 0;
      while (!disposed) {
        // 预算只在两次 apply 之间生效（Y.applyUpdate 不可中断）；第一项必须执行，否则 now 不前进时
        // 队列永远无法推进。
        const overBudget =
          sliceTasks >= options.budget.maxTasks ||
          sliceBytes >= options.budget.maxBytes ||
          options.now() - sliceStart >= options.budget.maxMillis;
        if (sliceTasks > 0 && overBudget) {
          break;
        }
        const queued = queue.take();
        if (queued === null) {
          break;
        }
        sliceTasks += 1;
        sliceBytes += queued.bytes;
        processOne(queued);
      }
      if (disposed || queue.size() === 0) {
        break;
      }
      await options.yieldToHost();
    }
  }

  return {
    enqueue(task: ApplyTask): void {
      // dispose 后到达的迟到帧直接丢弃：连接已断，任何结果都没有账本可结清，也不再回调消费方。
      if (disposed) {
        return;
      }
      if (
        // 队列项不是类型检查器能保证的东西：调用方可能来自 postMessage 的直接转发。
        !(task.payload instanceof Uint8Array) ||
        !Number.isSafeInteger(task.fromSeq) ||
        !Number.isSafeInteger(task.toSeq) ||
        task.fromSeq < 0 ||
        task.toSeq < task.fromSeq
      ) {
        emitRejected(task, APPLY_REJECT_REASONS.malformedTask);
        return;
      }
      const entry = entries.get(task.docId);
      if (entry === undefined) {
        // 客户端不得因任意 docId 建文档（§8.3）：未 retain 的 Doc 一律拒绝。
        emitRejected(task, APPLY_REJECT_REASONS.unknownDoc);
        return;
      }
      if (task.generation !== entry.generation) {
        emitRejected(task, APPLY_REJECT_REASONS.generationMismatch);
        return;
      }
      const bytes = task.payload.byteLength;
      if (bytes > options.maxQueueBytes) {
        // 单项就超过整个接收预算，永远不会被接纳：显式拒绝好过每次排队失败。
        emitRejected(task, APPLY_REJECT_REASONS.payloadTooLarge);
        return;
      }
      if (task.kind === "base") {
        // 新 attempt 的 base 是重新协商的起点：作废旧 attempt 的排队帧并重置本地基线（§8.3/§8.4）。
        // 身份切换先于容量判定生效——attempt 变化是既成事实，与随后的入队成败无关。
        if (entry.syncAttemptId === null || !isCurrentAttempt(entry, task)) {
          const superseded = queue.discardWhere(
            (queuedTask) =>
              queuedTask.docId === entry.docId &&
              (queuedTask.subscriptionEpoch !== task.subscriptionEpoch ||
                queuedTask.syncAttemptId !== task.syncAttemptId),
          );
          entry.subscriptionEpoch = task.subscriptionEpoch;
          entry.syncAttemptId = task.syncAttemptId;
          entry.baseReady = false;
          entry.appliedSeq = 0;
          entry.resyncRequested = false;
          for (const discarded of superseded) {
            // 作废帧只结清原账本（§8.3）：补发 rejected 结果，避免服务端账本长期挂着这些投递。
            emitRejected(discarded.task, staleReason(entry, discarded.task));
          }
        }
      } else {
        if (entry.syncAttemptId === null) {
          emitRejected(task, APPLY_REJECT_REASONS.baseNotReady);
          requestResync(entry, APPLY_REJECT_REASONS.baseNotReady);
          return;
        }
        if (!isCurrentAttempt(entry, task)) {
          emitRejected(task, staleReason(entry, task));
          return;
        }
      }
      if (!queue.push({ task, bytes })) {
        emitRejected(task, APPLY_REJECT_REASONS.queueOverflow);
      }
    },

    drain(): Promise<void> {
      if (disposed) {
        return Promise.resolve();
      }
      if (draining !== null) {
        // 并发调用合并到同一次调度：两个驱动交错会让同一 Doc 的任务乱序 apply。
        return draining;
      }
      const run = drainSlices().finally(() => {
        draining = null;
      });
      draining = run;
      return run;
    },

    retain(docId: string): void {
      if (disposed) {
        throw new Error("doc hub is disposed");
      }
      const existing = entries.get(docId);
      if (existing !== undefined) {
        existing.refCount += 1;
        return;
      }
      // 非法 docId 是调用方的编程错误而非线上数据问题：解析失败直接抛出，不静默建条目。
      const { generation } = parseDocId(docId);
      entries.set(docId, {
        docId,
        generation,
        doc: new Y.Doc(),
        refCount: 1,
        subscriptionEpoch: null,
        syncAttemptId: null,
        baseReady: false,
        appliedSeq: 0,
        residentBytes: 0,
        resyncRequested: false,
      });
    },

    release(docId: string): void {
      const entry = entries.get(docId);
      if (entry === undefined) {
        // 未配对的 release 会让引用计数漂移并把 Doc 泄漏给后续 retain，必须显式失败。
        throw new Error(`doc hub release without matching retain: ${docId}`);
      }
      entry.refCount -= 1;
      if (entry.refCount > 0) {
        return;
      }
      entry.doc.destroy();
      entries.delete(docId);
    },

    loadedBytes(): number {
      let total = 0;
      for (const entry of entries.values()) {
        total += entry.residentBytes;
      }
      return total;
    },

    queueDepth(): number {
      return queue.size();
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // 断连清账由上层整体重置账本（§8.5），故这里不逐条补 rejected；dispose 后也不再回调消费方。
      queue.clear();
      for (const entry of entries.values()) {
        entry.doc.destroy();
      }
      entries.clear();
    },
  };
}
