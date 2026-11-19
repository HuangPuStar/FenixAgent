import type { AdmissionController, Reservation } from "../capacity/admission";
import { isRetryableTextRefusal } from "./text-admission";

const ENTRY_BYTES = 256;

/** 已排队正文先占有界索引额度；拒绝只阻挡屏障，匹配正文成功后即可重试语义。 */
export class WriterTextBarrier {
  private readonly reservations = new Set<Reservation>();
  private readonly active = new Set<Reservation>();
  private readonly retainedHolds = new Set<Reservation>();
  private readonly refusals = new Map<string, { readonly error: unknown; readonly holds: Set<Reservation> }>();
  /** 首次接纳文本前先计提固定槽，排队池耗尽后仍能记录一次拒绝。 */
  private overflowSlot: Reservation | null = null;
  private overflow: { readonly key: string; readonly error: unknown } | null = null;

  constructor(private readonly admission: AdmissionController) {}

  /** 排队前预留；调用方将同步失败转成可观察回执，timer 不得抛未处理异常。 */
  reserve(): Reservation {
    this.ensureSlot();
    const hold = this.admission.reserve("controlIndex", ENTRY_BYTES);
    this.reservations.add(hold);
    return hold;
  }

  /** 排队、拒绝保留和回收共用捕获投影的判据，旧异步结算不能写回新投影。 */
  enqueue(input: {
    readonly key: string;
    readonly enqueue: (task: () => Promise<void>) => Promise<void>;
    readonly write: () => Promise<void>;
    readonly isCurrent: () => boolean;
    readonly onSchedulingRefusal: () => void;
    readonly onFailure: (error: unknown) => void;
  }): Promise<void> {
    let hold: Reservation;
    const reusable = [...(this.refusals.get(input.key)?.holds ?? [])].find((entry) => !this.active.has(entry));
    try {
      hold = reusable ?? this.reserve();
      this.active.add(hold);
    } catch (error) {
      this.refuseOverflow(input.key, error);
      input.onSchedulingRefusal();
      return Promise.reject(error);
    }
    const task = input.enqueue(() =>
      input.write().catch((error: unknown) => {
        if (input.isCurrent()) {
          if (isRetryableTextRefusal(error)) {
            this.refuse(input.key, error, hold);
          } else input.onFailure(error);
        }
        throw error;
      }),
    );
    return task.finally(() => {
      this.active.delete(hold);
      if (!this.retainedHolds.has(hold)) this.release(hold);
    });
  }

  /** 已有未写正文时只接受其重试，防止无关新输入持续积累拒绝。 */
  assertInput(key: string): void {
    this.ensureSlot();
    if (this.refusals.has(key) || this.overflow?.key === key) return;
    this.assertReady();
  }

  /** 所有已接纳正文均确认后才可发布语义事件。 */
  assertReady(): void {
    if (this.overflow !== null) throw this.overflow.error;
    for (const refusal of this.refusals.values()) throw refusal.error;
  }

  /** 未提交证明与原额度一起保留，同一 key 的其他拒绝不能覆盖更早的记录。 */
  refuse(key: string, error: unknown, hold: Reservation): void {
    const refusal = this.refusals.get(key) ?? { error, holds: new Set<Reservation>() };
    refusal.holds.add(hold);
    this.retainedHolds.add(hold);
    this.refusals.set(key, refusal);
  }

  /** 同步排队额度拒绝最多一项；它生效后输入门立即阻止无关 key。 */
  refuseOverflow(key: string, error: unknown): void {
    this.overflow ??= { key, error };
  }

  /** 仅 Store 已确认的匹配重试可以消除拒绝，并归还原任务的索引额度。 */
  confirm(key: string): void {
    const refusal = this.refusals.get(key);
    if (refusal)
      for (const hold of refusal.holds) {
        this.retainedHolds.delete(hold);
        // 同 key 的后继重试可能已借用此占用并排队，必须等该任务自身结清再归还。
        if (!this.active.has(hold)) this.release(hold);
      }
    this.refusals.delete(key);
    if (this.overflow?.key === key) this.overflow = null;
  }

  /** 旧任务结清只释放自己的占用，不修改已安装投影上的拒绝状态。 */
  release(hold: Reservation): void {
    hold.release();
    this.reservations.delete(hold);
    this.active.delete(hold);
  }

  /** 重建代次时清除旧投影的全部任务占用，迟到 release 仍保持幂等。 */
  reset(): void {
    for (const hold of this.reservations) hold.release();
    this.reservations.clear();
    this.active.clear();
    this.retainedHolds.clear();
    this.refusals.clear();
    this.overflow = null;
  }

  /** 关闭释放固定应急槽，不能留下已退休 writer 的索引占用。 */
  close(): void {
    this.reset();
    this.overflowSlot?.release();
    this.overflowSlot = null;
  }

  private ensureSlot(): void {
    this.overflowSlot ??= this.admission.reserve("controlIndex", ENTRY_BYTES);
  }
}
