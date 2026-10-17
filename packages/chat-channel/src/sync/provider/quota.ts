// packages/chat-channel/src/sync/provider/quota.ts
// 单连接发送额度与四类任务公平（设计 §8.5、规格 §3.2）。
//
// 额度口径：账目只覆盖**已发送未 ACK 字节**，按需动态授予。512KiB 是单连接最高值，不是每条连接预分配
// ——预分配会把 200 条连接的名义额度变成真实内存，因此初始 outstanding 为 0，只有真的授予一帧才占用。
// 调用方传入的 `encodedBytes` 必须已含 wire/envelope 开销；本模块只按传入值计费，不猜测帧结构
// （帧字节上限由 protocol/frames 负责）。
//
// 公平口径：每类任务按权重取得**本轮**字节份额（deficit round robin 的字节形式）。份额之和不超过窗口，
// 因此四类同时吃满份额也不会越过连接窗口。份额用尽后：
// - 在途为零的类仍可发一帧（base 快照可达 288KiB，大于历史类份额，否则历史同步永远发不出），
//   只受窗口与 socket 水位约束；授予后本轮即视为用尽，不会连续超发；
// - 其余情况拒绝，并推进轮次判定：本轮拿到过授予的类都已用尽或已无在途字节，就是新一轮的开始。
// 轮次结束条件刻意保守——**仍在消费本轮额度的类**（本轮拿到过授予且还有在途字节）不算结束，宁可让窗口余量
// 空闲一轮，也不把它借给突发类；否则 ACK 释放的额度会被实时类持续抢走，历史类永远等不到（设计 §8.5 要避免
// 的饥饿）。反过来，「拿到过授予但已无在途字节」的类不再挡住轮次结束：它可能此后静默，永久挡住轮次会把所有类
// 退化成「窗口空闲时也只能一帧在途」，而这一退化与该类当时的负载无关（详见 rotateIfSpent）。
// 独占连接的单类不受此限：它一被拒绝就满足结束条件，随即进入新一轮，不会因自己的份额停发。
//
// 本模块没有时间源：按帧速率的限频需要时钟，属会话层职责；这里只做字节账目与份额，控制流同样计入
// 同一窗口与份额，不能借高优先级绕过总预算。

import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";

/** 四类发送任务（设计 §8.5）：控制、实时、当前历史、后台历史。 */
export type TaskClass = "control" | "realtime" | "history-current" | "history-background";

/** 运行时类目清单：份额校验、轮次复位与快照汇总都走它；漏项会表现为某类账目恒为零。 */
const TASK_CLASSES = [
  "control",
  "realtime",
  "history-current",
  "history-background",
] as const satisfies readonly TaskClass[];

/** 各类账目初值：显式列出四类，漏一类会因不满足 `Record<TaskClass, number>` 编译失败。 */
const ZERO_PER_CLASS: Record<TaskClass, number> = {
  control: 0,
  realtime: 0,
  "history-current": 0,
  "history-background": 0,
};

/** 份额下限：权重再悬殊也不允许某类归零，否则该类永远拿不到额度（历史饥饿）。 */
const MIN_CLASS_SHARE_BYTES = 1;

export interface QuotaSnapshot {
  /** 已授予但未归还的字节，即「已发送未 ACK」。 */
  readonly outstandingBytes: number;
  /** 自上次 `reset` 起累计授予的字节，只用于观测，不参与任何判定。 */
  readonly grantedBytes: number;
  /** 在途任务数：按「一次 `tryReserve` 授予 = 一次 `release` 结清」配对；部分归只会让计数偏小。 */
  readonly pendingTasks: number;
}

export interface QuotaControllerOptions {
  /** 单连接窗口上限（512KiB 为最高值）。 */
  readonly maxOutstandingBytes: number;
  /** socket 硬水位：`bufferedAmount + encodedBytes` 不得超过它。 */
  readonly socketHighWatermark: number;
  /** 四类任务权重，逐类必须为正整数；份额 = 窗口 × 该权重 / 权重和。 */
  readonly fairness: Readonly<Record<TaskClass, number>>;
  /** dirty 集合上限（128）：超限说明该连接已跟不上订阅变化，必须关闭连接重新握手。 */
  readonly maxDirtyDocs: number;
}

export interface QuotaController {
  /**
   * 发送前检查；不足返回 false（调用方保留有界任务引用，不编码）。
   *
   * 同时判定 socket 水位、连接窗口与类目份额；被拒的调用不改变任何账目，可原样重试。
   */
  tryReserve(taskClass: TaskClass, encodedBytes: number, bufferedAmount: number): boolean;
  /** 归还一帧已结清（或已废止）的字节；超过该类在途字节即调用方缺陷，直接抛出。 */
  release(taskClass: TaskClass, bytes: number): void;
  snapshot(): QuotaSnapshot;
  /** 标记该 Doc 需要补差；同 docId 幂等，超限抛 `CAPACITY_EXCEEDED`（调用方据此关闭连接）。 */
  markDirty(docId: string): void;
  clearDirty(docId: string): void;
  dirtyCount(): number;
  /** 断连清账（设计 §8.5）。 */
  reset(): void;
}

interface QuotaLimits {
  readonly maxOutstandingBytes: number;
  readonly socketHighWatermark: number;
  readonly maxDirtyDocs: number;
}

/**
 * 参数违规统一出口。与「额度不足返回 false」分开：不足是正常流控，违规必须立刻暴露——
 * 负数会凭空造出额度，NaN 会让所有比较恒为 false 从而放行一切。错误码沿用 capacity/admission 的账目
 * 口径，让调用方只需处理一种异常类型。
 */
function rejectQuota(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `quota rejected: ${message}` });
}

/** 正安全整数：`Number.isSafeInteger` 同时排除 NaN、小数与超精度值（超精度会静默舍入字节数）。 */
function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    rejectQuota(`${field} must be a positive safe integer, received ${String(value)}`);
  }
  return value;
}

/** 非负安全整数：socket 的 `bufferedAmount` 允许为 0，但不得为负或非整数。 */
function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejectQuota(`${field} must be a non-negative safe integer, received ${String(value)}`);
  }
  return value;
}

/**
 * 类目运行时校验：类型层已限定四类，但 JavaScript 调用方或强制转换可能带进未知键。
 * 未知键会让份额与账目取到 `undefined`，比较恒不成立从而静默放行，或用 NaN 污染账目。
 */
function assertKnownTaskClass(value: TaskClass): TaskClass {
  if (!TASK_CLASSES.includes(value)) {
    rejectQuota(`unknown task class ${String(value)}`);
  }
  return value;
}

function resolveLimits(options: QuotaControllerOptions): QuotaLimits {
  const maxOutstandingBytes = assertPositiveInteger(options.maxOutstandingBytes, "maxOutstandingBytes");
  const socketHighWatermark = assertPositiveInteger(options.socketHighWatermark, "socketHighWatermark");
  // 窗口不得超过 socket 水位，否则会授予物理上发不出的额度（capacity/profile 启用校验第 7 项同口径）。
  if (maxOutstandingBytes > socketHighWatermark) {
    rejectQuota(`maxOutstandingBytes ${maxOutstandingBytes} exceeds socketHighWatermark ${socketHighWatermark}`);
  }
  return {
    maxOutstandingBytes,
    socketHighWatermark,
    maxDirtyDocs: assertPositiveInteger(options.maxDirtyDocs, "maxDirtyDocs"),
  };
}

/**
 * 逐类份额：`floor(窗口 × 权重 / 权重和)`，下限 1 字节。
 *
 * 权重缺失或非法立即抛出：缺失会产生 `undefined` 份额，让该类所有比较恒为 false（看似永不超限）。
 * 逐类向下取整后份额之和 ≤ 窗口，取整差额留在窗口里不被任何类独占；极端权重下 1 字节下限可能让份额
 * 之和略高于窗口，实际授予仍受窗口检查约束。
 */
function resolveShares(
  maxOutstandingBytes: number,
  fairness: Readonly<Record<TaskClass, number>>,
): Record<TaskClass, number> {
  const weights: Record<TaskClass, number> = { ...ZERO_PER_CLASS };
  let weightTotal = 0;
  for (const taskClass of TASK_CLASSES) {
    const weight = assertPositiveInteger(fairness[taskClass], `fairness.${taskClass}`);
    weights[taskClass] = weight;
    weightTotal += weight;
  }
  const shares: Record<TaskClass, number> = { ...ZERO_PER_CLASS };
  for (const taskClass of TASK_CLASSES) {
    shares[taskClass] = Math.max(
      MIN_CLASS_SHARE_BYTES,
      Math.floor((maxOutstandingBytes * weights[taskClass]) / weightTotal),
    );
  }
  return shares;
}

export function createQuotaController(options: QuotaControllerOptions): QuotaController {
  const limits = resolveLimits(options);
  const shares = resolveShares(limits.maxOutstandingBytes, options.fairness);
  const outstanding: Record<TaskClass, number> = { ...ZERO_PER_CLASS };
  const roundUsage: Record<TaskClass, number> = { ...ZERO_PER_CLASS };
  /** 本轮拿到过授予的类：轮次结束判定只关心它们，因为只有它们消费了本轮份额。 */
  const asked = new Set<TaskClass>();
  /** 本轮份额已用尽的类：达到份额即计入（不等到下次提问），因此用尽份额后不再发送的类不会一直挡住轮次。 */
  const spent = new Set<TaskClass>();
  const dirtyDocs = new Set<string>();
  let outstandingTotal = 0;
  let grantedTotal = 0;
  let pendingTasks = 0;

  /**
   * 新一轮：份额是每轮配额，未用完的部分不结转。
   * 结转会让闲置连接在下一轮突发超发，等于把窗口当成了可累积的额度。
   */
  function beginRound(): void {
    for (const taskClass of TASK_CLASSES) {
      roundUsage[taskClass] = 0;
    }
    asked.clear();
    spent.clear();
  }

  function grant(taskClass: TaskClass, bytes: number): void {
    outstanding[taskClass] += bytes;
    outstandingTotal += bytes;
    roundUsage[taskClass] += bytes;
    grantedTotal += bytes;
    pendingTasks += 1;
    asked.add(taskClass);
    if (roundUsage[taskClass] >= shares[taskClass]) {
      spent.add(taskClass);
    }
  }

  function hasRoundRoom(taskClass: TaskClass, bytes: number): boolean {
    if (roundUsage[taskClass] + bytes <= shares[taskClass]) {
      return true;
    }
    // 在途为零的类可发一帧超出份额的帧：base 快照（协议上限 288KiB）大于历史类份额，
    // 否则历史同步永远发不出；授予后 roundUsage 已越过份额，本轮即视为用尽。
    return outstanding[taskClass] === 0;
  }

  /**
   * 本轮拿到过授予的类都「用尽或已静默」时开新轮；返回是否发生了轮转。
   *
   * 「已静默」= 该类当前没有在途字节：它把本轮拿到的帧全部结清后份额往往还远未用完，因此永远进不了
   * `spent`。若这类无在途字节的类也挡住轮次结束，轮次就永不推进——份额用尽后的持续发送方只剩
   * `hasRoundRoom` 的「空载类可发一帧」例外，整条连接退化成每类一帧在途，且这一退化只取决于某个类是否
   * 曾经发过一帧，与当前负载无关。仍有在途字节的类视为正在消费本轮份额，继续按保守口径占住本轮余量。
   *
   * 控制类不参与该判定：设计 §10.5 规定「控制流使用受限独立份额」，它只受自己的份额与连接窗口约束，
   * 不占正文类的轮次。否则连接建立期的一帧握手就会把正文类永久压到单轮份额。
   */
  function rotateIfSpent(): boolean {
    for (const taskClass of asked) {
      if (taskClass === "control") {
        continue;
      }
      if (!spent.has(taskClass) && outstanding[taskClass] > 0) {
        return false;
      }
    }
    beginRound();
    return true;
  }

  return {
    tryReserve(taskClass: TaskClass, encodedBytes: number, bufferedAmount: number): boolean {
      const target = assertKnownTaskClass(taskClass);
      const bytes = assertPositiveInteger(encodedBytes, "encodedBytes");
      const buffered = assertNonNegativeInteger(bufferedAmount, "bufferedAmount");
      // socket 硬水位先于任何账目：编码帧加上 socket 在途字节超限时不得授予，也不占用连接窗口。
      if (buffered + bytes > limits.socketHighWatermark) {
        return false;
      }
      if (outstandingTotal + bytes > limits.maxOutstandingBytes) {
        return false;
      }
      if (!hasRoundRoom(target, bytes)) {
        spent.add(target);
        // 轮转后原地重判一次：本轮已确实结束的调用方不必再等一次重试即可发送。
        if (!rotateIfSpent() || !hasRoundRoom(target, bytes)) {
          return false;
        }
      }
      grant(target, bytes);
      return true;
    },

    release(taskClass: TaskClass, bytes: number): void {
      const target = assertKnownTaskClass(taskClass);
      const released = assertPositiveInteger(bytes, "release bytes");
      // 多退字节会凭空造出容量，且让后续 ACK 与账目永久错位，因此在源头拒绝而不是夹到零。
      if (released > outstanding[target]) {
        rejectQuota(`release of ${released} bytes for ${target} exceeds outstanding ${outstanding[target]} bytes`);
      }
      outstanding[target] -= released;
      outstandingTotal -= released;
      // 任务计数是诊断字段：字节账目才是权威，部分归还只让计数偏小，故在此夹零而不影响容量判定。
      pendingTasks = Math.max(0, pendingTasks - 1);
    },

    snapshot(): QuotaSnapshot {
      return { outstandingBytes: outstandingTotal, grantedBytes: grantedTotal, pendingTasks };
    },

    markDirty(docId: string): void {
      // 非法标识不纳入集合：它会污染后续的补差判定，且此处已是协议边界（帧层同样拒绝）。
      assertIdentifier(docId, "dirty docId");
      if (dirtyDocs.has(docId)) {
        return;
      }
      if (dirtyDocs.size >= limits.maxDirtyDocs) {
        // 超限即关闭连接并要求重新握手（设计 §8.5、规格 §3.2）：本模块无法自行关闭连接，
        // 故用可重试的容量错误上报，重连重新握手后 dirty 集合随清账归零。
        throw new SyncProtocolError("CAPACITY_EXCEEDED", {
          message: `dirty doc set is full (${limits.maxDirtyDocs} docs): close the connection and re-handshake`,
        });
      }
      dirtyDocs.add(docId);
    },

    clearDirty(docId: string): void {
      assertIdentifier(docId, "dirty docId");
      dirtyDocs.delete(docId);
    },

    dirtyCount(): number {
      return dirtyDocs.size;
    },

    reset(): void {
      for (const taskClass of TASK_CLASSES) {
        outstanding[taskClass] = 0;
      }
      outstandingTotal = 0;
      grantedTotal = 0;
      pendingTasks = 0;
      dirtyDocs.clear();
      beginRound();
    },
  };
}
