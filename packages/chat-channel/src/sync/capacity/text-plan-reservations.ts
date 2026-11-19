import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";
import type { InputLimits } from "./profile";

/** Y.Doc、游标和额度对象的固定元数据，正文编码字节不能替代对象数量。 */
export const TEXT_DOCUMENT_METADATA_BYTES = 8192;
const CHUNK_METADATA_BYTES = 64;

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

/** 一个字节及其合法身份、单正文游标都应可接纳，否则该档位无法开始正文写入。 */
export function minimumTextPlanReservations(inputs: InputLimits) {
  const base = textPlanBaseReservations(inputs, 1, 1);
  const identityUnits = MAX_IDENTIFIER_BYTES * 3;
  // 规划确认前 Store 已保留首次更新的两份字节，必须覆盖二者同时在场的峰值。
  const retainedFirstUpdateBytes = 2 * (inputs.recordHeaderMaxBytes + 1 + MAX_IDENTIFIER_BYTES + 128);
  return {
    hotDocLive:
      base.hotDocLive +
      identityUnits * 2 +
      1024 +
      TEXT_DOCUMENT_METADATA_BYTES +
      MAX_IDENTIFIER_BYTES * 12 +
      retainedFirstUpdateBytes,
    persistSeal: base.persistSeal + 6 * (512 + identityUnits * 3) + 512 + MAX_IDENTIFIER_BYTES * 12,
  };
}
