// packages/chat-channel/src/sync/live/merge-buffer.ts
// 实时写入前的文本合并（设计 §6.1 / 规格 §3.1）。
//
// 只合并键完全相同的**连续**文本增量：五项任一不同都必须先冲刷，否则不同消息、或工具前后的
// 文本会被拼进同一条记录，而客户端按 entryId/contentSlot 定位记录，拼错即内容串台。
// 时间阈值从**首增量**到达时起算，不用 trailing debounce——debounce 会被持续高速输出无限推迟，
// 把「最长 33ms 提交」退化成「输出结束才提交」，UI 与持久化都拿不到中间状态。
// 字节阈值是硬上限：到达即提交，缓冲在任何情况下都不允许无界增长（设计 §10.2「实时合并」行）。
// 判定同时依赖注入 Clock 与定时器：定时器负责「不再有增量」时也能提交；Clock 负责在事件循环
// 被写路径占住、定时器延后回调时仍能识别截止时间已过（惰性过期检查），两者都不使用真实时间直读。

import type { Clock } from "../clock";
import { SyncProtocolError } from "../protocol/errors";

/** 合并键：只有完全相同的五项才能合并（设计 §6.1）。 */
export interface MergeKey {
  readonly generation: string;
  readonly turnId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
}

/** 一次合并提交：`text` 是原样拼接的结果，调用方不得再做 trim 或规范化。 */
export interface MergeFlushRequest {
  readonly key: MergeKey;
  readonly text: string;
  readonly bytes: number;
  readonly firstArrivalAt: number;
  readonly lastArrivalAt: number;
}

export interface MergeBufferOptions {
  readonly clock: Clock;
  /** 时间阈值：从**第一个**增量到达时起算，不是 trailing debounce。 */
  readonly maxDelayMs: number;
  /** 字节阈值：任一到达即提交。 */
  readonly maxBytes: number;
  readonly onFlush: (request: MergeFlushRequest) => void;
}

/** 合并缓冲：同一时刻最多缓冲一个键，键一换就先冲刷，语义屏障因此只需看当前键。 */
export interface MergeBuffer {
  /** 接收一个文本增量；键不同则先冲刷旧键的缓冲。 */
  push(key: MergeKey, delta: string): void;
  /** 语义屏障：先冲刷全部（或指定键）已接收文本，返回后调用方可推进语义状态。 */
  barrier(key?: MergeKey): void;
  /** 冲刷全部缓冲。 */
  flushAll(): void;
  /** 当前缓冲中的键数量（用于容量断言）。 */
  pendingKeys(): number;
  dispose(): void;
}

const UTF8_ENCODER = new TextEncoder();

/** 合并键相等判定：五项全等才可合并，少比一项就可能把不同目标的文本拼到一起。 */
function sameMergeKey(left: MergeKey, right: MergeKey): boolean {
  return (
    left.generation === right.generation &&
    left.turnId === right.turnId &&
    left.entryId === right.entryId &&
    left.contentSlot === right.contentSlot &&
    left.contentType === right.contentType
  );
}

/** 阈值是构造期容量参数：非法值按容量配置的统一口径（ADMISSION_REJECTED）拒绝，不引入第二种失败类型。 */
function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `merge buffer ${field} must be a positive integer, received ${String(value)}`,
    });
  }
}

interface PendingMerge {
  readonly key: MergeKey;
  readonly parts: string[];
  bytes: number;
  readonly firstArrivalAt: number;
  lastArrivalAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createMergeBuffer(options: MergeBufferOptions): MergeBuffer {
  const { clock, maxDelayMs, maxBytes, onFlush } = options;
  assertPositiveInteger(maxDelayMs, "maxDelayMs");
  assertPositiveInteger(maxBytes, "maxBytes");

  let pending: PendingMerge | null = null;
  let disposed = false;

  /**
   * 取走并清空当前缓冲。
   *
   * 必须在回调**之前**清空：回调抛错时若缓冲还在，同一段文本会被再次提交，而重复写入 Yjs
   * 无法回滚（设计禁止重复业务副作用）。代价是失败后文本不再留在缓冲里，由调用方按已提交
   * 边界恢复——这比制造重复内容更容易判定与修复。
   */
  function takePending(): MergeFlushRequest | null {
    const entry = pending;
    if (entry === null) {
      return null;
    }
    pending = null;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return {
      key: entry.key,
      text: entry.parts.join(""),
      bytes: entry.bytes,
      firstArrivalAt: entry.firstArrivalAt,
      lastArrivalAt: entry.lastArrivalAt,
    };
  }

  function flushPending(): void {
    const request = takePending();
    if (request !== null) {
      onFlush(request);
    }
  }

  /** 定时器回调：只提交自己那个缓冲，已被替换掉的缓冲不得提交（它的文本属于更晚的窗口）。 */
  function flushIfCurrent(entry: PendingMerge): void {
    if (pending === entry) {
      flushPending();
    }
  }

  return {
    push(key, delta) {
      if (disposed) {
        throw new SyncProtocolError("RESOURCE_RETIRED", { message: "merge buffer is disposed" });
      }
      if (delta.length === 0) {
        return; // 空增量不产生文本，也不应起算时间阈值。
      }
      const now = clock.now();
      // 目标缓冲必须在触发任何回调**之前**决定：冲刷回调内重入 push 会替换槽位，若之后再从槽位取目标，
      // 本次增量就会被追加进异键的缓冲（键与文本对不上，正是「只合并相同键」要防的内容串台）。
      let target = pending;
      if (target !== null && (!sameMergeKey(target.key, key) || now - target.firstArrivalAt >= maxDelayMs)) {
        flushPending();
        target = null;
      }
      if (target === null) {
        // 重入可能已占用槽位：它属于更早完成的那次 push，先让它落定——即便同键也不与本次合并，
        // 它的窗口晚于本次增量的到达时刻。只多冲一次：回调若在每次冲刷里都重入即为无界重入，判为畸形调用。
        if (pending !== null) {
          flushPending();
          if (pending !== null) {
            throw new SyncProtocolError("MALFORMED_FRAME", { message: "flush callback re-entered without draining" });
          }
        }
        const opened: PendingMerge = {
          key: { ...key },
          parts: [],
          bytes: 0,
          firstArrivalAt: now,
          lastArrivalAt: now,
          timer: null,
        };
        pending = opened;
        // 定时器只在首增量设置一次；后续增量不重设，否则等价于 trailing debounce。
        opened.timer = setTimeout(() => flushIfCurrent(opened), maxDelayMs);
        target = opened;
      }
      target.parts.push(delta);
      target.bytes += UTF8_ENCODER.encode(delta).length;
      target.lastArrivalAt = now;
      if (target.bytes >= maxBytes) {
        flushIfCurrent(target);
      }
    },
    barrier(key) {
      if (disposed) {
        return;
      }
      // 指定键与当前缓冲键不一致时无文本可提交：屏障只保证该键此前已接收的文本已写入。
      if (key === undefined || (pending !== null && sameMergeKey(pending.key, key))) {
        flushPending();
      }
    },
    flushAll() {
      if (!disposed) {
        flushPending();
      }
    },
    pendingKeys() {
      return pending === null ? 0 : 1;
    },
    dispose() {
      // 释放路径不冲刷也不回调：此时 Doc 通常已封口，再写等于把内容插回已提交边界之后。
      // 需要保留文本的调用方必须先显式 `flushAll()`，再释放。
      if (disposed) {
        return;
      }
      disposed = true;
      if (pending !== null && pending.timer !== null) {
        clearTimeout(pending.timer);
      }
      pending = null;
    },
  };
}
