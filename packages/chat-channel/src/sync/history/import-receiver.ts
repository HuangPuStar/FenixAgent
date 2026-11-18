import type { AdmissionController, Reservation } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { HistoryIngest, HistoryRecordMeta, IngestedRecord } from "./ingest";
import { type AdmittedHistoryPayload, admitHistoryObject } from "./object-admission";
import { planHistoryParts } from "./object-parts";

/** 导入源记录；顺序由源迭代器决定，不能并发拉取或交错大对象分片。 */
export interface HistoryInputRecord {
  value: unknown;
  meta: HistoryRecordMeta;
}

/** 同一个接收入口负责单条及有界批次，分片规则和接纳校验只维护一份。 */
export class HistoryImportReceiver {
  private largeObjectInFlight = false;
  private cancelled = false;
  private flushing = false;
  private releasePending: (() => void) | null = null;
  /** 异步源暂停时仍然持有接收边界，禁止其他入口提前封口。 */
  receivingBatch = false;
  private readonly recordBudgetBytes: number;

  constructor(
    private readonly deps: {
      ingest: HistoryIngest;
      capacity: SyncCapacityProfile;
      admission?: AdmissionController;
      digest: DigestFn;
      onAccepted(record: IngestedRecord, meta: HistoryRecordMeta): void;
    },
  ) {
    this.recordBudgetBytes = Math.min(
      Math.max(4096, deps.capacity.inputs.historyBlockTargetPayloadBytes),
      deps.capacity.inputs.historyBlockHardBytes - 4096,
    );
  }

  /** 原始对象只校验一次，超出物理记录预算时仍按既有对象分片协议接收。 */
  async accept(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    return this.acceptPrepared(value, meta, admitHistoryObject(value, this.deps.capacity, this.deps.admission));
  }

  /** 小对象在块预算及 256 条上限内合并，所有暂存副本由共享 historyBuild 池计费。 */
  async acceptRecords(records: Iterable<HistoryInputRecord> | AsyncIterable<HistoryInputRecord>): Promise<void> {
    this.receivingBatch = true;
    const pending: { payload: AdmittedHistoryPayload; meta: HistoryRecordMeta }[] = [];
    const reservations: Reservation[] = [];
    let bytes = 0;
    const release = () => {
      for (const reservation of reservations.splice(0)) reservation.release();
      pending.length = 0;
      bytes = 0;
    };
    this.releasePending = release;
    const flush = async () => {
      if (pending.length === 0) return;
      this.flushing = true;
      try {
        const accepted = await this.deps.ingest.acceptAdmittedBatch(pending);
        if (!this.cancelled)
          accepted.forEach((record, index) => {
            this.deps.onAccepted(record, pending[index]!.meta);
          });
      } finally {
        release();
        this.flushing = false;
      }
    };
    try {
      for await (const record of records) {
        if (this.cancelled)
          throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history receive was cancelled" });
        const value = record.value;
        const accepted = admitHistoryObject(value, this.deps.capacity, this.deps.admission);
        if (
          accepted.bytes.byteLength > this.recordBudgetBytes ||
          accepted.reservation !== null ||
          !this.deps.admission
        ) {
          try {
            await flush();
          } catch (error) {
            accepted.reservation?.release();
            throw error;
          }
          await this.acceptPrepared(value, record.meta, accepted);
          continue;
        }
        if (pending.length >= 256 || bytes + accepted.bytes.byteLength > this.recordBudgetBytes) await flush();
        if (this.cancelled)
          throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history receive was cancelled" });
        // 私有 canonical 字节和接纳副本同时存在；合并及写盘副本由 ingest 另行预留。
        reservations.push(this.deps.admission.reserve("historyBuild", accepted.bytes.byteLength * 2 + 256));
        const part = planHistoryParts({
          value,
          meta: record.meta,
          serializedBytes: accepted.bytes,
          recordBudgetBytes: this.recordBudgetBytes,
          digest: this.deps.digest,
        })[0]!;
        pending.push({ payload: accepted.payload, meta: part.meta });
        bytes += accepted.bytes.byteLength;
      }
      await flush();
    } finally {
      release();
      this.releasePending = null;
      this.receivingBatch = false;
    }
  }

  /** 不等待外部源下一次 yield 即归还批次额度；迟到记录随后显式失败。 */
  abort(): void {
    this.cancelled = true;
    if (!this.flushing) this.releasePending?.();
  }

  private async acceptPrepared(
    value: unknown,
    meta: HistoryRecordMeta,
    accepted: ReturnType<typeof admitHistoryObject>,
  ): Promise<IngestedRecord> {
    const large = accepted.reservation !== null;
    let ownsLargeSlot = false;
    try {
      if (this.cancelled)
        throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history receive was cancelled" });
      if (large) {
        if (this.largeObjectInFlight)
          throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "a large history object is already in flight" });
        this.largeObjectInFlight = true;
        ownsLargeSlot = true;
      }
      const parts = planHistoryParts({
        value,
        meta,
        serializedBytes: accepted.bytes,
        recordBudgetBytes: this.recordBudgetBytes,
        digest: this.deps.digest,
      });
      let last: IngestedRecord | null = null;
      for (const part of parts) {
        if (this.cancelled)
          throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history receive was cancelled" });
        last =
          accepted.bytes.byteLength <= this.recordBudgetBytes
            ? await this.deps.ingest.acceptAdmitted(accepted.payload, part.meta)
            : await this.deps.ingest.accept(part.value, part.meta);
        if (this.cancelled)
          throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history receive was cancelled" });
        this.deps.onAccepted(last, part.meta);
      }
      if (!last) throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history object produced no record" });
      return last;
    } finally {
      accepted.reservation?.release();
      if (ownsLargeSlot) this.largeObjectInFlight = false;
    }
  }
}
