import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";
import type { InputLimits } from "./profile";
import { TEXT_CLAIM_READ_BODY_BYTES, TEXT_CLAIM_READ_MIN_CONTROL_BYTES } from "./text-claim-reservations";

/** Y.Doc、游标和额度对象的固定元数据，正文编码字节不能替代对象数量。 */
export const TEXT_DOCUMENT_METADATA_BYTES = 8192;
const CHUNK_METADATA_BYTES = 64;
// 最小投影包含 scope、generation、四个 Doc、首条账本/引用及封口替换的候选元数据。
// 每行覆盖复合键、至多十六个合法身份和固定字段，二十四行同时在场仍不借正文池。
const MINIMUM_PROJECTION_INDEX_BYTES = 24 * (512 + MAX_IDENTIFIER_BYTES * 16 * 4);

/** 已接纳输入的身份、任务和正文副本必须一直保留到同一窗口确认提交。 */
export function textInputReservations(identityUnits: number, textUnits: number) {
  return { controlIndex: 384 + identityUnits * 4, ingressSpool: 128 + textUnits * 8 };
}

/** 规划前先覆盖文本、切片、旧块与目录编码，旧块仍按传输硬限封口。 */
export function textPlanBaseReservations(inputs: InputLimits, textUnits: number, textBytes: number) {
  const chunkBytes = Math.max(1, Math.min(inputs.payloadChunkMaxBytes, Math.floor(inputs.activeHardEncodedBytes / 2)));
  const chunkCountBound = Math.ceil(textBytes / Math.max(1, chunkBytes - 3));
  return {
    hotDocLive: Math.max(
      1,
      textUnits * 4 +
        textBytes * 6 +
        chunkCountBound * CHUNK_METADATA_BYTES +
        TEXT_DOCUMENT_METADATA_BYTES * 2 +
        MAX_DOC_SNAPSHOT_BYTES * 4 +
        inputs.directoryHardBytes * 2,
    ),
    persistSeal: Math.max(1, textBytes * 4 + MAX_DOC_SNAPSHOT_BYTES * 4 + inputs.directoryHardBytes * 2),
  };
}

/** 首字节写入与其已提交判重都必须可接纳，Store 留存的首条账本与临时资源同时计费。 */
export function minimumTextPlanReservations(inputs: InputLimits) {
  const base = textPlanBaseReservations(inputs, 1, 1);
  // MergeKey 五段各受单标识上限约束；ASCII 的 UTF-16 码元数达到这个最坏值。
  const retainedInput = textInputReservations(MAX_IDENTIFIER_BYTES * 5, 1);
  const identityUnits = MAX_IDENTIFIER_BYTES * 3;
  // 规划确认前 Store 已保留首次更新的两份字节，必须覆盖二者同时在场的峰值。
  const retainedFirstUpdateBytes = 2 * (inputs.recordHeaderMaxBytes + 1 + MAX_IDENTIFIER_BYTES + 128);
  return {
    controlIndex: MINIMUM_PROJECTION_INDEX_BYTES + TEXT_CLAIM_READ_MIN_CONTROL_BYTES + retainedInput.controlIndex,
    ingressSpool: retainedInput.ingressSpool,
    hotDocLive: Math.max(
      TEXT_CLAIM_READ_BODY_BYTES + retainedFirstUpdateBytes,
      base.hotDocLive +
        identityUnits * 2 +
        1024 +
        TEXT_DOCUMENT_METADATA_BYTES +
        MAX_IDENTIFIER_BYTES * 12 +
        retainedFirstUpdateBytes,
    ),
    persistSeal: base.persistSeal + 6 * (512 + identityUnits * 3) + 512 + MAX_IDENTIFIER_BYTES * 12,
  };
}
