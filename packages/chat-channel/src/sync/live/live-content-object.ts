import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { DigestFn } from "../clock";
import { fidelitySerialize } from "../history/fidelity-json";
import { admitHistoryObject } from "../history/object-admission";
import { planHistoryParts } from "../history/object-parts";
import type { LiveInput, LiveRecordValue } from "./live-writer-types";

/** 通用完整对象沿既有 live 提交与轮换入口写入；全部片提交后才结束。 */
export async function writeLiveContentObject(input: {
  readonly object: NonNullable<LiveInput["object"]>;
  readonly capacity: SyncCapacityProfile;
  readonly digest: DigestFn;
  readonly admission?: AdmissionController;
  readonly append: (record: Omit<LiveRecordValue, "recordId">) => Promise<void>;
}): Promise<void> {
  const { value, meta } = input.object;
  const accepted = admitHistoryObject(value, input.capacity, input.admission);
  try {
    const parts = planHistoryParts({
      value,
      meta,
      serializedBytes: accepted.bytes,
      recordBudgetBytes: input.capacity.inputs.payloadChunkMaxBytes,
      digest: input.digest,
    });
    for (const part of parts) {
      await input.append({
        entryId: meta.entryId ?? "content-object",
        entryOrder: meta.entryOrder,
        sourceRevision: meta.sourceRevision,
        role: meta.role,
        contentSlot: String(meta.contentSlot ?? 0),
        contentType: "application/json",
        kind: meta.kind,
        partIndex: part.meta.partIndex ?? 0,
        payload: fidelitySerialize(part.value),
      });
    }
  } finally {
    accepted.reservation?.release();
  }
}
