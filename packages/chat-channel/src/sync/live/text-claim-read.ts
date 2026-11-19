import * as Y from "yjs";
import type { AdmissionBudget, Reservation } from "../capacity/admission";
import { createEncodedStateBound } from "../capacity/encoded-state-bound";
import {
  TEXT_CLAIM_READ_BASE_BYTES,
  TEXT_CLAIM_READ_GROWTH_BYTES,
  TEXT_CLAIM_READ_METADATA_BYTES,
  TEXT_CLAIM_REPLAY_MAX_BYTES,
} from "../capacity/text-claim-reservations";
import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { parseDocId } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";

/** 单个存储返回值不能借读取页数绕过传输硬限，也不能先交给解码器再判定。 */
function assertBounded(update: Uint8Array, limit = MAX_DOC_SNAPSHOT_BYTES): void {
  if (update.byteLength > limit)
    throw new SyncProtocolError("CAPACITY_EXCEEDED", {
      message:
        limit === MAX_DOC_SNAPSHOT_BYTES
          ? "text claim committed bytes exceed the transport limit"
          : "text claim intermediate state exceeds its replay memory limit",
    });
}

/** 先取共享额度；封口块只读最终 canonical，活跃块逐条重放，消费回调仅能带走判定或身份。 */
export async function readTextClaimDoc<T>(input: {
  readonly store: ProjectionStore;
  readonly admission: AdmissionBudget;
  readonly scopeKey: string;
  readonly docId: string;
  readonly assertCurrent: () => void;
  readonly consume: (doc: Y.Doc, lastSeq: number) => T;
}): Promise<T | null> {
  let body: Reservation | undefined;
  let growth: Reservation | undefined;
  let metadata: Reservation | undefined;
  let doc: Y.Doc | undefined;
  try {
    input.assertCurrent();
    body = input.admission.reserve("hotDocLive", TEXT_CLAIM_READ_BASE_BYTES);
    metadata = input.admission.reserve("controlIndex", TEXT_CLAIM_READ_METADATA_BYTES + input.docId.length * 4);
    const identity = parseDocId(input.docId);
    const state = await input.store.readSuccessor(input.scopeKey, input.docId);
    input.assertCurrent();
    if (state === null) return null;
    if (
      state.scopeKey !== input.scopeKey ||
      state.docId !== input.docId ||
      state.kind !== "content" ||
      state.kind !== identity.kind ||
      state.generation !== identity.generation
    )
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim document crosses its authority" });
    if (state.state !== "active" && state.state !== "sealing" && state.state !== "sealed")
      throw new SyncProtocolError("RESOURCE_RETIRED", { message: "text claim document is not readable" });
    const sealed = state.state === "sealed";
    let requestedSeq = 0;
    if (sealed) {
      const finalSeq = state.finalSeq;
      if (!Number.isSafeInteger(finalSeq) || finalSeq === null || finalSeq < 0)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim sealed frontier is invalid" });
      requestedSeq = finalSeq;
    }
    // 封口后的最终 canonical 不再变化；旧 ledger 的大中间态不能阻断已提交文本判重。
    const base = await input.store.readDocStateAt(input.docId, requestedSeq);
    input.assertCurrent();
    if (base === null) return null;
    if (base.docId !== input.docId)
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim snapshot belongs to another doc" });
    if (base.lastSeq !== requestedSeq)
      throw new SyncProtocolError("SEQUENCE_GAP", { message: "text claim snapshot differs from requested frontier" });
    assertBounded(base.snapshot);
    doc = new Y.Doc({ guid: input.docId });
    const current = doc;
    const bound = createEncodedStateBound(base.snapshot);
    Y.applyUpdate(current, base.snapshot);
    const measure = (limit: number) => {
      const snapshot = Y.encodeStateAsUpdate(current);
      assertBounded(snapshot, limit);
      bound.calibrate(snapshot.byteLength, current);
      return snapshot.byteLength;
    };
    const checkpoint = (limit: number) => {
      if (bound.upperBytes > limit) measure(limit);
    };
    checkpoint(MAX_DOC_SNAPSHOT_BYTES);
    if (sealed) return input.consume(current, base.lastSeq);
    let lastSeq = base.lastSeq;
    let batch: { id: string; digest: string } | null = null;
    for (;;) {
      const page = await input.store.readUpdatesAfter(input.docId, lastSeq, 1);
      input.assertCurrent();
      if (page.length > 1)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim tail exceeded its one-update page" });
      const update = page[0];
      if (update && update.updateSeq !== lastSeq + 1)
        throw new SyncProtocolError("SEQUENCE_GAP", { message: "text claim tail is not continuous" });
      // 原子提交的当前 Doc 子序列连续可见；下一批或空页才证明当前批完整，不能按分页截断判快照。
      if (batch && (!update || update.batchId !== batch.id || update.digest !== batch.digest)) {
        checkpoint(MAX_DOC_SNAPSHOT_BYTES);
        growth?.release();
        growth = undefined;
      }
      if (!update) return input.consume(current, lastSeq);
      assertBounded(update.bytes);
      bound.add(update.bytes);
      Y.applyUpdate(current, update.bytes);
      // 正常状态加一条输入由基础额度覆盖；确实变大后才资助下一次读取的额外峰值。
      if (
        bound.upperBytes > MAX_DOC_SNAPSHOT_BYTES &&
        measure(TEXT_CLAIM_REPLAY_MAX_BYTES) > MAX_DOC_SNAPSHOT_BYTES &&
        growth === undefined
      )
        growth = input.admission.reserve("hotDocLive", TEXT_CLAIM_READ_GROWTH_BYTES);
      batch = { id: update.batchId, digest: update.digest };
      lastSeq = update.updateSeq;
    }
  } finally {
    doc?.destroy();
    growth?.release();
    metadata?.release();
    body?.release();
  }
}
