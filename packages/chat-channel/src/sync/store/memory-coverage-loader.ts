import * as Y from "yjs";
import type { Reservation } from "../capacity/admission";
import { createEncodedStateBound } from "../capacity/encoded-state-bound";
import {
  TEXT_CLAIM_READ_BODY_BYTES,
  TEXT_CLAIM_READ_METADATA_BYTES,
  TEXT_CLAIM_REPLAY_MAX_BYTES,
} from "../capacity/text-claim-reservations";
import type { WorkingCredit } from "../capacity/working-credit";
import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import type { MemoryContentBatchState } from "./memory-live-content-batch";
import { compositeKey, fail, type StoredDoc } from "./memory-store-state";

/** 一个解码正文；提取身份后可先归还 body，保留已计费的临时索引直到整个证明收口。 */
export interface LoadedCoverageDoc {
  readonly value: Y.Doc;
  snapshot(): Uint8Array;
  releaseBody(): void;
  dispose(): void;
}

/** 可选证明的额度不足交给有界 fallback；真实协议、前沿和容量错误不被掩盖。 */
export function isCoverageBudgetRefusal(error: unknown): boolean {
  return error instanceof SyncProtocolError && error.code === "ADMISSION_REJECTED";
}

/** 每次只重放一个更新，组末检查传输硬限，组内只允许有界临时状态。 */
export function loadCoverageDoc(
  doc: StoredDoc,
  state: MemoryContentBatchState,
  credit?: WorkingCredit,
): LoadedCoverageDoc | null {
  let body: Reservation | undefined,
    metadata: Reservation | undefined,
    value: Y.Doc | undefined,
    snapshot: Uint8Array | undefined;
  const releaseBody = () => {
    value?.destroy();
    value = undefined;
    snapshot = undefined;
    body?.release();
    body = undefined;
  };
  const dispose = () => {
    releaseBody();
    metadata?.release();
    metadata = undefined;
  };
  try {
    try {
      body = state.memoryBudget?.reserve("hotDocLive", TEXT_CLAIM_READ_BODY_BYTES, credit);
      metadata = state.memoryBudget?.reserve(
        "controlIndex",
        TEXT_CLAIM_READ_METADATA_BYTES + TEXT_CLAIM_REPLAY_MAX_BYTES * 16,
        credit,
      );
    } catch (error) {
      dispose();
      if (isCoverageBudgetRefusal(error)) return null;
      throw error;
    }
    const assertBytes = (bytes: Uint8Array, limit: number) => {
      if (bytes.byteLength > limit) fail("CAPACITY_EXCEEDED", "coverage replay exceeds encoded limit");
    };
    const sealed = doc.state === "sealed";
    if (sealed && (doc.finalSeq === null || doc.finalSeq !== doc.lastSeq))
      fail("SEQUENCE_GAP", "sealed coverage has no final frontier");
    const base = sealed ? doc.snapshot : doc.baseSnapshot;
    assertBytes(base, MAX_DOC_SNAPSHOT_BYTES);
    value = new Y.Doc();
    const requireValue = () => {
      if (!value) throw new Error("coverage body already released");
      return value;
    };
    const bound = createEncodedStateBound(base);
    const check = (limit: number) => {
      if (bound.upperBytes <= limit) return;
      const active = requireValue();
      // pending 保持未知上界；同版本的更严限额复用已测字节，下一次 apply 后重新测量。
      snapshot ??= Y.encodeStateAsUpdate(active);
      assertBytes(snapshot, limit);
      bound.calibrate(snapshot.byteLength, active);
    };
    Y.applyUpdate(requireValue(), base);
    check(MAX_DOC_SNAPSHOT_BYTES);
    let batchId: string | undefined,
      digest: string | undefined,
      lastSeq = sealed ? doc.finalSeq! : doc.baseSeq;
    for (const update of sealed ? [] : (state.updates.get(compositeKey(doc.scopeKey, doc.docId)) ?? [])) {
      if (update.updateSeq !== lastSeq + 1) fail("SEQUENCE_GAP", "coverage replay frontier is not continuous");
      if (batchId !== undefined && (batchId !== update.batchId || digest !== update.digest))
        check(MAX_DOC_SNAPSHOT_BYTES);
      assertBytes(update.bytes, MAX_DOC_SNAPSHOT_BYTES);
      bound.add(update.bytes);
      Y.applyUpdate(requireValue(), update.bytes);
      snapshot = undefined;
      check(TEXT_CLAIM_REPLAY_MAX_BYTES);
      batchId = update.batchId;
      digest = update.digest;
      lastSeq = update.updateSeq;
    }
    if (lastSeq !== doc.lastSeq) fail("SEQUENCE_GAP", "coverage replay has no committed frontier");
    check(MAX_DOC_SNAPSHOT_BYTES);
    return {
      get value() {
        return requireValue();
      },
      snapshot() {
        if (!snapshot) {
          snapshot = Y.encodeStateAsUpdate(requireValue());
          assertBytes(snapshot, MAX_DOC_SNAPSHOT_BYTES);
        }
        return snapshot;
      },
      releaseBody,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
