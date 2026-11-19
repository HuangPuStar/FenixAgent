import { SyncProtocolError } from "../protocol/errors";
import type { Reservation } from "./admission";

const adopters = new WeakMap<Reservation, () => void>();

/** 仅本地基础设施传递的能力上下文；JSON 与 structuredClone 均忽略符号键。 */
export const WORKING_CREDIT: unique symbol = Symbol("sync working credit");

/** 内部拆分只改变额度 owner，不先释放已取得的全局额度。 */
export interface CreditPartition {
  readonly taken: Reservation;
  readonly remainder: Reservation | null;
}

/** 一个窗口预先取得的提交工作额度；未提交子额度失败时回流，提交后独立归 Store 持有。 */
export class WorkingCredit {
  readonly #holds: Reservation[];
  #totalBytes: number;
  #availableBytes: number;
  #closed = false;
  #growthDepth = 0;

  constructor(
    initial: Reservation,
    private readonly reserveMore: (bytes: number) => Reservation,
    private readonly partition: (hold: Reservation, bytes: number) => CreditPartition,
  ) {
    this.#holds = [initial];
    this.#totalBytes = initial.bytes;
    this.#availableBytes = initial.bytes;
  }

  /** 仅供提交前容量规划观察，不代表可从原 Controller 重复取得的空闲额度。 */
  get availableBytes(): number {
    return this.#availableBytes;
  }

  /** 已退休能力不能再授权任何子池的新申请。 */
  get closed(): boolean {
    return this.#closed;
  }

  /** 预留输入尚未接纳时记录原承诺，失败可只撤回该次扩窗。 */
  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** 只撤回尚未借出的临时扩窗，不收回在途或已发布的子额度。 */
  shrinkTo(totalBytes: number): void {
    this.assertOpen();
    if (this.#growthDepth > 0) this.reject("working credit cannot shrink during growth");
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) this.reject("invalid working credit size");
    const surplus = this.#totalBytes - totalBytes;
    if (surplus <= 0) return;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || surplus > this.#availableBytes)
      this.reject("working credit shrink includes borrowed bytes");
    let remaining = surplus;
    while (remaining > 0) {
      const hold = this.#holds.pop()!;
      if (hold.bytes <= remaining) {
        remaining -= hold.bytes;
        hold.release();
      } else {
        const divided = this.partition(hold, remaining);
        divided.taken.release();
        if (divided.remainder) this.#holds.push(divided.remainder);
        remaining = 0;
      }
    }
    this.#availableBytes -= surplus;
    this.#totalBytes = totalBytes;
  }

  /** 同一窗口增长只取得差额，拒绝不改变之前已确认的工作承诺。 */
  growTo(totalBytes: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) this.reject("invalid working credit size");
    if (totalBytes <= this.#totalBytes) return;
    this.#growthDepth++;
    try {
      const extra = this.reserveMore(totalBytes - this.#totalBytes);
      if (this.#closed) {
        extra.release();
        this.reject("working credit is closed");
      }
      // reserve 可同步重入更大的grow；只保留最新总额仍缺少的部分，不覆盖较大目标。
      const needed = Math.max(0, totalBytes - this.#totalBytes);
      if (needed === 0) {
        extra.release();
        return;
      }
      let addition = extra;
      if (needed < extra.bytes) {
        // partition 已失效原hold；只归还多申请的剩余部分。
        const divided = this.partition(extra, needed);
        addition = divided.taken;
        divided.remainder?.release();
      }
      this.#holds.push(addition);
      this.#availableBytes += needed;
      this.#totalBytes = totalBytes;
    } finally {
      this.#growthDepth--;
    }
  }

  /** Controller 验证签发者后拆出子额度；此时全局 used 不变，也没有可被其他 scope 抢走的窗口。 */
  take(bytes: number): Reservation {
    this.assertOpen();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.#availableBytes)
      this.reject("working credit is insufficient");
    const pieces: Reservation[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const hold = this.#holds.pop()!;
      if (hold.bytes <= remaining) {
        pieces.push(hold);
        remaining -= hold.bytes;
      } else {
        const divided = this.partition(hold, remaining);
        pieces.push(divided.taken);
        if (divided.remainder) this.#holds.push(divided.remainder);
        remaining = 0;
      }
    }
    this.#availableBytes -= bytes;
    let disposition: "prepared" | "committed" | "released" = "prepared";
    const child: Reservation = Object.freeze({
      pool: "controlIndex",
      bytes,
      release: () => {
        if (disposition === "released") return;
        if (disposition === "prepared" && !this.#closed) {
          this.#holds.push(...pieces);
          this.#availableBytes += bytes;
        } else for (const piece of pieces) piece.release();
        disposition = "released";
      },
    });
    adopters.set(child, () => {
      if (disposition === "prepared") disposition = "committed";
    });
    return child;
  }

  /** 退休只释放尚未借出的余量；在途子额度由其原任务结清，不能提前释放。 */
  release(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const hold of this.#holds.splice(0)) hold.release();
    this.#availableBytes = 0;
  }

  /** 信用属于当前进程，不允许误入批次摘要、快照或持久化 JSON。 */
  toJSON(): never {
    return this.reject("working credit cannot be serialized");
  }

  private assertOpen(): void {
    if (this.#closed) this.reject("working credit is closed");
  }
  private reject(message: string): never {
    throw new SyncProtocolError("ADMISSION_REJECTED", { message });
  }
}

/** Map 发布成功才接管子额度；普通 reservation 不受该内部协议影响。 */
export function adoptWorkingReservation(reservation: Reservation): void {
  adopters.get(reservation)?.();
}
