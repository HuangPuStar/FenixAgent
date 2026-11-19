import type { AdmissionController, Reservation } from "../capacity/admission";
import { textInputReservations } from "../capacity/text-plan-reservations";
import type { WorkingCredit } from "../capacity/working-credit";
import type { Clock } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { createMergeBuffer, type MergeBuffer, type MergeFlushRequest, type MergeKey } from "./merge-buffer";
import { isTextBatchNotWritten } from "./text-batch-commit";
import type { WriterAuthorityToken } from "./writer-authority";

type FlushState = "buffered" | "ready" | "queued" | "writing" | "refused";

/** 窗口对象即重放身份；同 key 的后续窗口不能替它确认，更不能覆盖它的原文。 */
interface RetainedFlush {
  readonly key: MergeKey;
  readonly idempotent: boolean;
  readonly holds: Reservation[];
  readonly credit: WorkingCredit;
  textBytes: number;
  chunks: number;
  workingBytes: number;
  revalidate: boolean;
  request: MergeFlushRequest | null;
  state: FlushState;
  attempt: Promise<void> | null;
  error: unknown;
  notWritten: boolean;
}

/** 合并、保留与提交队列共享一个 owner，接纳前计费，只有确定提交或显式退休才释放正文。 */
export class WriterTextBarrier {
  private readonly entries: RetainedFlush[] = [];
  private buffered: RetainedFlush | null = null;
  private merge: MergeBuffer;
  private paused = false;
  private closed = false;
  private pendingChunks = 0;
  private incoming: {
    holds: Reservation[];
    idempotent: boolean;
    window: RetainedFlush | null;
    credit: WorkingCredit | null;
    textBytes: number;
    chunks: number;
    joining: boolean;
    originalCreditBytes: number;
    prior: RetainedFlush | null;
    workingBytes: number;
  } | null = null;

  constructor(
    private readonly options: {
      readonly admission: AdmissionController;
      readonly clock: Clock;
      readonly merge: { readonly maxDelayMs: number; readonly maxBytes: number };
      readonly capture: () => WriterAuthorityToken;
      readonly enqueue: (task: () => Promise<void>) => Promise<void>;
      readonly write: (request: MergeFlushRequest, token: WriterAuthorityToken, credit: WorkingCredit) => Promise<void>;
      readonly shouldReplay: (key: MergeKey, token: WriterAuthorityToken, credit: WorkingCredit) => Promise<boolean>;
      readonly workingBytes: (key: MergeKey, bytes: number, aheadChunks: number, idempotent: boolean) => number;
      readonly chunkCount: (bytes: number) => number;
      readonly isCurrent: (token: WriterAuthorityToken) => boolean;
      readonly onFailure: (error: unknown) => void;
    },
  ) {
    this.merge = this.createMerge();
  }

  /** 新增量只在未阻塞的输入门内接纳；已拒绝窗口由显式屏障或幂等重发重试。 */
  push(key: MergeKey, delta: string, idempotent = false): Promise<void> | null {
    if (this.closed || this.paused)
      throw new SyncProtocolError("WRITER_EPOCH_LOST", { message: "text input is paused" });
    const head = this.entries[0];
    if (head?.state === "refused") throw head.error;
    if (delta.length === 0) return null;
    // 在 key switch 冲刷旧窗口之前取得新输入全部额度，拒绝连旧 timer 都不改变。
    const incoming = {
      holds: [] as Reservation[],
      idempotent,
      window: null as RetainedFlush | null,
      credit: null as WorkingCredit | null,
      textBytes: 0,
      chunks: 0,
      joining: false,
      originalCreditBytes: 0,
      prior: null as RetainedFlush | null,
      workingBytes: 0,
    };
    this.incoming = incoming;
    try {
      this.merge.push(key, delta);
    } finally {
      if (incoming.window === null) {
        for (const hold of incoming.holds) hold.release();
        if (!incoming.joining) incoming.credit?.release();
        else if (incoming.credit && !incoming.credit.closed)
          incoming.credit.shrinkTo(Math.max(incoming.originalCreditBytes, incoming.prior?.workingBytes ?? 0));
      }
      if (this.incoming === incoming) this.incoming = null;
    }
    return incoming.window?.attempt ?? null;
  }

  /** 保留正文仍拥有该身份；后续新 chunk 拒绝不得释放原来幂等输入的声明。 */
  retains(generation: string, entryId: string, contentSlot: string): boolean {
    return this.entries.some(
      (entry) =>
        entry.idempotent &&
        entry.key.generation === generation &&
        entry.key.entryId === entryId &&
        entry.key.contentSlot === contentSlot,
    );
  }

  /** 安装后的读取/写入拒绝都由队首的本次未写证明背书，不依赖错误码猜测未知结果。 */
  canRetryRebuild(error: unknown): boolean {
    const head = this.entries[0];
    return (
      head?.error === error &&
      head.notWritten &&
      error instanceof SyncProtocolError &&
      error.code === "ADMISSION_REJECTED"
    );
  }

  /** 重发共享已开始的精确 attempt；尚未触发冲刷的缓冲不被判重确认意外冲刷。 */
  pending(generation: string, entryId: string, contentSlot: string): Promise<void> | null {
    let target: RetainedFlush | undefined;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (
        entry.request !== null &&
        entry.idempotent &&
        entry.key.generation === generation &&
        entry.key.entryId === entryId &&
        entry.key.contentSlot === contentSlot
      ) {
        target = entry;
        break;
      }
    }
    if (!target) return null;
    if (target.state === "queued" || target.state === "writing") return target.attempt;
    return this.flushThrough(target);
  }

  /** 一次显式调用最多重试队首一次；所有后继都等该原窗口确实提交后才执行。 */
  async flush(): Promise<void> {
    if (this.closed) return;
    const retrying = this.entries[0]?.state === "refused";
    this.collectBuffered();
    const target = this.entries.at(-1);
    if (target) await this.flushThrough(target, retrying);
  }

  /** 冻结只停止 timer 和新输入，旧缓冲转换成已计费 request，不丢已确认的正文。 */
  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.merge.barrier();
    this.merge.dispose();
  }

  /** 同代重建保留确定未写窗口；真正换代才退休旧代正文，未知回执始终停写。 */
  resume(generation: string): void {
    for (const entry of [...this.entries]) {
      if (entry.key.generation !== generation) this.remove(entry);
      else if (entry.error !== null && !entry.notWritten) throw entry.error;
      else entry.revalidate = entry.idempotent;
    }
    this.paused = false;
    this.merge = this.createMerge();
  }

  /** 调用方已尝试显式结清或已得到失败回执，退休时释放本 owner 的全部保留额度。 */
  close(): void {
    this.closed = true;
    this.merge.dispose();
    for (const entry of [...this.entries]) this.remove(entry);
  }

  private createMerge(): MergeBuffer {
    return createMergeBuffer({
      ...this.options.merge,
      clock: this.options.clock,
      canAppend: () => this.buffered?.idempotent === this.incoming?.idempotent,
      beforePush: (key, delta, joining) => this.reserveInput(key, delta, joining),
      beforeAppend: (key, delta) => this.retain(key, delta),
      onFlush: (request) => this.acceptFlush(request),
    });
  }

  /** 字符串、合并副本和任务元数据均在缓冲变更前计费，拒绝只回滚本次预留。 */
  private reserveInput(key: MergeKey, delta: string, joining: boolean): void {
    const incoming = this.incoming!;
    const prior = joining ? this.buffered! : null;
    incoming.prior = prior;
    incoming.joining = joining;
    incoming.originalCreditBytes = prior?.credit.totalBytes ?? 0;
    const holds = incoming.holds;
    try {
      const budget = textInputReservations(
        Object.values(key).reduce((sum, value) => sum + value.length, 0),
        delta.length,
      );
      holds.push(this.options.admission.reserve("controlIndex", budget.controlIndex));
      this.assertAdmitting(incoming);
      holds.push(this.options.admission.reserve("ingressSpool", budget.ingressSpool));
      this.assertAdmitting(incoming);
      incoming.textBytes = (prior?.textBytes ?? 0) + new TextEncoder().encode(delta).byteLength;
      incoming.chunks = this.options.chunkCount(incoming.textBytes);
      const working = this.options.workingBytes(
        key,
        incoming.textBytes,
        this.pendingChunks - (prior?.chunks ?? 0),
        incoming.idempotent,
      );
      incoming.workingBytes = working;
      if (prior) {
        incoming.credit = prior.credit;
        prior.credit.growTo(working);
      } else incoming.credit = this.options.admission.createWorkingCredit(working);
      this.assertAdmitting(incoming);
    } catch (error) {
      for (const hold of holds) hold.release();
      throw error;
    }
  }

  private retain(key: MergeKey, _delta: string): void {
    const incoming = this.incoming;
    if (incoming === null) throw new Error("merge append has no input reservation");
    this.assertAdmitting(incoming);
    if (incoming.joining && this.buffered?.credit !== incoming.credit)
      throw new SyncProtocolError("WRITER_EPOCH_LOST", { message: "text window changed before admission" });
    this.incoming = null;
    if (this.buffered === null) {
      this.buffered = {
        key: { ...key },
        idempotent: incoming.idempotent,
        holds: [],
        credit: incoming.credit!,
        textBytes: 0,
        chunks: 0,
        workingBytes: 0,
        revalidate: false,
        request: null,
        state: "buffered",
        attempt: null,
        error: null,
        notWritten: true,
      };
      this.entries.push(this.buffered);
    }
    this.buffered.holds.push(...incoming.holds);
    this.pendingChunks += incoming.chunks - this.buffered.chunks;
    this.buffered.chunks = incoming.chunks;
    this.buffered.textBytes = incoming.textBytes;
    this.buffered.workingBytes = Math.max(this.buffered.workingBytes, incoming.workingBytes);
    incoming.window = this.buffered;
  }

  private assertAdmitting(incoming: NonNullable<WriterTextBarrier["incoming"]>): void {
    if (this.closed || this.paused || this.incoming !== incoming)
      throw new SyncProtocolError("WRITER_EPOCH_LOST", { message: "text input retired during admission" });
  }

  private acceptFlush(request: MergeFlushRequest): void {
    const entry = this.buffered;
    if (entry === null) throw new Error("merge flush has no retained input");
    this.buffered = null;
    entry.request = { ...request, key: entry.key };
    entry.state = "ready";
    if (!this.paused) this.start(entry);
  }

  /** collect 不自动排队，避免显式重试把后继窗口排在待重试队首之前。 */
  private collectBuffered(): void {
    const paused = this.paused;
    this.paused = true;
    this.merge.barrier();
    this.paused = paused;
  }

  private async flushThrough(target: RetainedFlush, retrying = true): Promise<void> {
    if (retrying && this.entries[0]?.state === "refused") {
      // 原队列可能还有未执行的后继；先让它们观察旧拒绝，再按 FIFO 启动新的 attempt。
      await Promise.allSettled(
        this.entries
          .filter((entry) => entry.state === "queued" || entry.state === "writing")
          .map((entry) => entry.attempt!),
      );
    }
    const end = this.entries.indexOf(target);
    if (end < 0) return;
    const prefix = this.entries.slice(0, end + 1);
    for (const entry of prefix) {
      if (entry.request === null) continue;
      if (entry.state !== "queued" && entry.state !== "writing") {
        if (entry.error !== null && !entry.notWritten) throw entry.error;
        this.start(entry);
      }
    }
    const results = await Promise.allSettled(prefix.map((entry) => entry.attempt!));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  /** 写入前重校窗口身份，native writer queue 吞掉 rejection 也不能让后继越过队首。 */
  private start(entry: RetainedFlush): void {
    const token = this.options.capture();
    entry.state = "queued";
    let entered = false;
    const attempt = this.options
      .enqueue(async () => {
        if (this.entries[0] !== entry)
          throw this.entries[0]?.error ?? new Error("text flush is behind its retained predecessor");
        entry.state = "writing";
        entry.credit.growTo(this.options.workingBytes(entry.key, entry.textBytes, 0, entry.idempotent));
        if (entry.revalidate) {
          const replay = await this.options.shouldReplay(entry.key, token, entry.credit);
          entry.revalidate = false;
          if (!replay) {
            this.remove(entry);
            return;
          }
        }
        entered = true;
        await this.options.write(entry.request!, token, entry.credit);
        this.remove(entry);
      })
      .catch((error: unknown) => {
        if (this.entries.includes(entry)) {
          entry.state = "refused";
          entry.error = error;
          entry.notWritten = !entered || isTextBatchNotWritten(error);
          if (
            entered &&
            this.options.isCurrent(token) &&
            (!entry.notWritten ||
              !(error instanceof SyncProtocolError) ||
              (error.code !== "ADMISSION_REJECTED" &&
                error.code !== "LEASE_EXPIRED" &&
                error.code !== "WRITER_EPOCH_LOST"))
          )
            this.options.onFailure(error);
        }
        throw error;
      });
    entry.attempt = attempt;
    void attempt.catch(() => {});
  }

  private remove(entry: RetainedFlush): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    if (this.buffered === entry) this.buffered = null;
    this.pendingChunks -= entry.chunks;
    entry.credit.release();
    for (const hold of entry.holds) hold.release();
    entry.holds.length = 0;
  }
}
