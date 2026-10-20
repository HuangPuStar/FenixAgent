// packages/chat-channel/src/sync/client/apply-queue.ts
// 客户端有界接收队列（设计 §8.6 第 1 条）：收包路径只做边界校验与入队，不在包到达时同步 apply。
//
// 双上限缺一不可：条数上限挡住「大量极小帧」，字节上限挡住「少量超大帧」；只留一个都会让另一侧
// 成为绕过客户端预算的通道（设计 §10.4：接收队列 ≤1MiB / 64 任务）。
// 溢出时拒绝**新**任务而不驱逐已入队任务：已入队项保持着 Doc 内顺序，驱逐任意一条都会在客户端
// 制造无法察觉的序号缺口；拒绝新任务让上层发 rejected ACK 并申请补齐，缺口由此显式化。
// 浏览器安全（规格 §3.3）：不得 import node 内建、fs、process、Buffer。

import type { ApplyTask } from "./doc-hub";

/** 排队项：任务与计费字节绑定，出队时按同一数值归还额度，避免账实漂移。 */
export interface ApplyQueueEntry {
  readonly task: ApplyTask;
  /** 计费口径为载荷原始字节；帧头与 base64 膨胀属于传输层账本（E 阶段）的计费范围。 */
  readonly bytes: number;
}

export interface ApplyQueueOptions {
  readonly maxBytes: number;
  readonly maxTasks: number;
}

export interface ApplyQueue {
  /** 入队；触达任一上限返回 false 且队列状态不变（不驱逐旧任务、不改动字节计数）。 */
  push(entry: ApplyQueueEntry): boolean;
  /** 取下一条任务：base 优先，同类按入队顺序。队列为空返回 null。 */
  take(): ApplyQueueEntry | null;
  /** 移除满足条件的排队项并返回（换 attempt 时按新身份作废旧帧，见 §8.3）。 */
  discardWhere(predicate: (task: ApplyTask) => boolean): ApplyQueueEntry[];
  /** 清空并返回全部排队项（断连清账由调用方整体处理）。 */
  clear(): ApplyQueueEntry[];
  size(): number;
  pendingBytes(): number;
}

/** 上限必须是可判定的非负整数：`NaN` 之类的配置会让容量比较恒为 false，静默变成无界队列。 */
function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`apply queue ${name} must be a non-negative safe integer, received ${String(value)}`);
  }
}

export function createApplyQueue(options: ApplyQueueOptions): ApplyQueue {
  assertLimit("maxBytes", options.maxBytes);
  assertLimit("maxTasks", options.maxTasks);
  const items: ApplyQueueEntry[] = [];
  let pendingBytes = 0;

  return {
    push(entry: ApplyQueueEntry): boolean {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new RangeError(`apply queue entry bytes must be a non-negative safe integer, received ${entry.bytes}`);
      }
      if (items.length + 1 > options.maxTasks || pendingBytes + entry.bytes > options.maxBytes) {
        return false;
      }
      items.push(entry);
      pendingBytes += entry.bytes;
      return true;
    },

    take(): ApplyQueueEntry | null {
      // base 优先：可信基线是增量的前提，先建基线能缩短该 Doc 不可用的时间窗；其余严格 FIFO，
      // 跨 Doc 重排不会破坏任何 Doc 自身的顺序（同 Doc 的 base 必先于其增量入队）。
      let index = 0;
      while (index < items.length && items[index].task.kind !== "base") {
        index += 1;
      }
      const target = index < items.length ? index : 0;
      const entry = items[target];
      if (entry === undefined) {
        return null;
      }
      items.splice(target, 1);
      pendingBytes -= entry.bytes;
      return entry;
    },

    discardWhere(predicate: (task: ApplyTask) => boolean): ApplyQueueEntry[] {
      const discarded: ApplyQueueEntry[] = [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const entry = items[index];
        if (!predicate(entry.task)) {
          continue;
        }
        items.splice(index, 1);
        pendingBytes -= entry.bytes;
        discarded.push(entry);
      }
      // 逆序遍历保证删除安全，但返回值按入队顺序给出，调用方的 ACK 次序与到达次序一致。
      return discarded.reverse();
    },

    clear(): ApplyQueueEntry[] {
      const cleared = items.slice();
      items.length = 0;
      pendingBytes = 0;
      return cleared;
    },

    size(): number {
      return items.length;
    },

    pendingBytes(): number {
      return pendingBytes;
    },
  };
}
