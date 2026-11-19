import * as Y from "yjs";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import type { SyncCapacityProfile } from "./profile";

/** 内容块在候选更新后的容量指标；encodedBytes 可以是保守上界。 */
export interface ContentDocStats {
  readonly encodedBytes: number;
  readonly recordCount: number;
  readonly maxPayloadBytes: number;
  readonly lastSeq: number;
  readonly baseSeq?: number;
}

/** Store 准确统计与 writer 无副作用预演共用的唯一容量判据。 */
export function contentStatsOverflow(stats: ContentDocStats, capacity: SyncCapacityProfile): string | null {
  const limits = capacity.inputs;
  if (stats.lastSeq - (stats.baseSeq ?? 0) > limits.maxTransactionsPerDoc)
    return "content transaction capacity exceeded";
  if (stats.encodedBytes > Math.min(MAX_DOC_SNAPSHOT_BYTES, limits.activeHardEncodedBytes))
    return "content snapshot exceeds active write limit";
  if (stats.recordCount > limits.maxRecordsPerDoc) return "content record capacity exceeded";
  if (stats.maxPayloadBytes > limits.payloadChunkMaxBytes) return "content payload capacity exceeded";
  return null;
}

/** 正文写入的统一硬限制；封口未增长的旧块另按传输上限校验，不倒查新的写入配置。 */
export function contentDocOverflow(input: {
  readonly doc: Y.Doc;
  readonly capacity: SyncCapacityProfile;
  readonly lastSeq: number;
  readonly baseSeq?: number;
  readonly snapshot?: Uint8Array;
}): string | null {
  const records = input.doc.getMap<unknown>("root").get("records");
  let maxPayloadBytes = 0;
  for (const record of records instanceof Y.Array ? (records.toArray() as unknown[]) : []) {
    if (record === null || typeof record !== "object") continue;
    const payload = (record as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) maxPayloadBytes = Math.max(maxPayloadBytes, payload.byteLength);
  }
  return contentStatsOverflow(
    {
      encodedBytes: (input.snapshot ?? Y.encodeStateAsUpdate(input.doc)).byteLength,
      recordCount: records instanceof Y.Array ? records.length : 0,
      maxPayloadBytes,
      lastSeq: input.lastSeq,
      baseSeq: input.baseSeq,
    },
    input.capacity,
  );
}

/** 派生定位只能指向真实 canonical 记录，不能以索引本身证明正文存在。 */
export function contentRecordIds(doc: Y.Doc): ReadonlySet<string> {
  const records = doc.getMap<unknown>("root").get("records");
  const result = new Set<string>();
  if (!(records instanceof Y.Array)) return result;
  for (const record of records.toArray() as unknown[]) {
    if (
      record !== null &&
      typeof record === "object" &&
      typeof (record as { recordId?: unknown }).recordId === "string"
    )
      result.add((record as { recordId: string }).recordId);
  }
  return result;
}
