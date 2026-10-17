// packages/chat-channel/src/sync/live/rotation.ts
// 运行态 Doc 的轮换决策与新旧共存额度（设计 §6.3 / §10.2「运行态」行 / 评审台账 C04）。
//
// 三个轮换理由都必须在写入路径上可判定：编码状态到软水位、累计事务数、驻留时间。判定本身无副作用：
// 换 Doc、复制实体、原子切换引用由写入路径负责，本层只回答「该不该换」。
// 大小维度只看**编码状态**（实测编码字节或写入路径的预估字节）：设计 §6.3 明确「不能认为当前键少
// 就永久复用一个 Doc」——反复设置/删除少量键同样积累 CRDT 成本，键数量因此不是轮换理由。
// 新旧共存额度是轮换的失败出口：轮换期间旧 Doc 未释放、新 Doc 已开始写入，两边同时在
// `hotDocLive` 池计费（设计 §10.1）。额度不足或已有一次轮换在途时必须立刻报容量错误，而不是
// 「再转一次就能腾出额度」——设计 §10.2 限定「轮换≤1个/scope」，C04 也要求该场景给出一次明确错误。

import type { AdmissionController, Reservation } from "../capacity/admission";
import type { Clock, RandomSource } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { RuntimeDocLimits } from "./runtime-doc";

/** 轮换理由：编码状态到软水位、驻留超时、累计事务数到上限。 */
export type RotationReason = "size-soft" | "deadline" | "transaction-count";

export interface RotationDecision {
  readonly rotate: boolean;
  readonly reason?: RotationReason;
}

export interface RotationControllerOptions {
  readonly clock: Clock;
  /**
   * 随机源由冻结签名保留，本层不消费：三个理由都必须确定——同一输入要能给出同一决策，
   * 才能按注入的 Clock 复盘「为什么在这里轮换」。需要错峰的调度应放在装配层，而不是把
   * 不确定性埋进决策函数。
   */
  readonly random: RandomSource;
  readonly limits: RuntimeDocLimits;
  readonly maxResidentMs: number;
  readonly maxTransactions: number;
}

export interface RotationController {
  /** 记录一次已写入事务的字节数：累计事务数与累计载荷，供写前预判软水位。 */
  onTransaction(bytes: number): void;
  evaluate(current: { encodedBytes: number; entityCount: number }): RotationDecision;
  /** 预留新旧共存额度；不足时抛容量错误而非无限轮换。 */
  reserveCoexistence(admission: AdmissionController, bytes: number): void;
  reset(): void;
}

/** 容量参数非法按容量配置的统一口径拒绝（ADMISSION_REJECTED），不引入第二种失败类型。 */
function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `rotation ${field} must be a positive integer, received ${String(value)}`,
    });
  }
}

/** 共存额度必须是正安全整数：0 或负数会让「预留—释放」之后凭空多出可用额度。 */
function assertCoexistenceBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `rotation coexistence bytes must be a positive safe integer, received ${String(bytes)}`,
    });
  }
}

export function createRotationController(options: RotationControllerOptions): RotationController {
  const { clock, limits, maxResidentMs, maxTransactions } = options;
  assertPositiveInteger(maxResidentMs, "maxResidentMs");
  assertPositiveInteger(maxTransactions, "maxTransactions");

  // 驻留期从创建时刻起算：此时刚建好 Doc，计时与计数都从零开始。
  let residentSince = clock.now();
  let transactions = 0;
  let payloadBytes = 0;
  /** 已签发的共存预留：非空即表示上一次轮换尚未交接完成。 */
  let coexistence: Reservation | null = null;

  return {
    onTransaction(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new SyncProtocolError("ADMISSION_REJECTED", {
          message: `rotation transaction size must be a non-negative safe integer, received ${String(bytes)}`,
        });
      }
      transactions += 1;
      payloadBytes += bytes;
    },
    evaluate(current) {
      // 累计载荷是编码状态的下界（每次写入带来的 CRDT 开销净增），取二者较大值可在不整篇
      // encode 的前提下保守判断软水位：写入路径因此可以只传预估字节（设计 §6.1「写前预估」）。
      const estimatedBytes = Math.max(current.encodedBytes, payloadBytes);
      if (estimatedBytes >= limits.softRotateBytes) {
        // `current.entityCount` 刻意不参与判定：实体满载是容量错误（§6.2），复制到新 Doc 也不会
        // 减少未结束实体，因此它不是轮换理由。
        return { rotate: true, reason: "size-soft" };
      }
      if (clock.now() - residentSince >= maxResidentMs) {
        return { rotate: true, reason: "deadline" };
      }
      if (transactions >= maxTransactions) {
        return { rotate: true, reason: "transaction-count" };
      }
      return { rotate: false };
    },
    reserveCoexistence(admission, bytes) {
      assertCoexistenceBytes(bytes);
      if (coexistence !== null) {
        // 同一轮换重放同一额度是幂等的：可恢复重试会重跑这一步，此时不能把重放判成新轮换。
        if (coexistence.bytes === bytes) {
          return;
        }
        throw new SyncProtocolError("CAPACITY_EXCEEDED", {
          message:
            `runtime rotation coexistence is already reserved for ${coexistence.bytes} bytes,` +
            ` requested ${bytes}: the previous rotation has not completed its handoff`,
        });
      }
      // 准入层拒绝原样传播（错误码表已把它归为可重试的瞬态过载），不翻译成第二种错误码：
      // 池名与余量是定位问题所需的上下文，替换错误类型只会把这份上下文弄丢。
      coexistence = admission.reserve("hotDocLive", bytes);
    },
    reset() {
      residentSince = clock.now();
      transactions = 0;
      payloadBytes = 0;
      coexistence?.release();
      coexistence = null;
    },
  };
}
