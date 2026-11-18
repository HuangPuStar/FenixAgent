import type { DigestFn } from "../clock";
import type { SyncRefRecord } from "../store/types";
import type { LiveRecordValue } from "./live-writer-types";
import { bytes } from "./writer-support";

/** 文本声明只定位稳定条目与槽位；正文和分片数不参与幂等身份。 */
export interface TextClaimIdentity {
  readonly scopeKey: string;
  readonly generation: string;
  readonly entryId: string;
  readonly contentSlot: string;
}

/** 查找键包含已鉴权 scope 与代次，字符串槽位编码在摘要中避免与历史数字槽位混用。 */
export function textClaimLookupId(digest: DigestFn, identity: TextClaimIdentity): string {
  return digest(
    bytes(JSON.stringify([1, identity.scopeKey, identity.generation, identity.entryId, identity.contentSlot])),
  );
}

/** 每次冲刷只保留末片定位；真实正文仍只存在 canonical 记录中。 */
export function textClaimRef(
  digest: DigestFn,
  identity: TextClaimIdentity,
  docId: string,
  record: LiveRecordValue,
): SyncRefRecord {
  return {
    scopeKey: identity.scopeKey,
    generation: identity.generation,
    lookupKind: "live-text",
    lookupId: textClaimLookupId(digest, identity),
    contentSlot: 0,
    partIndex: 0,
    docId,
    recordId: record.recordId,
    orderStart: 0,
    orderEnd: 0,
    byteStart: 0,
    byteEnd: record.payload.byteLength,
  };
}
