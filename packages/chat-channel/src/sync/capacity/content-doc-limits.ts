import * as Y from "yjs";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import type { SyncCapacityProfile } from "./profile";

/** 正文写入的统一硬限制；封口未增长的旧块另按传输上限校验，不倒查新的写入配置。 */
export function contentDocOverflow(input: {
  readonly doc: Y.Doc;
  readonly capacity: SyncCapacityProfile;
  readonly lastSeq: number;
  readonly baseSeq?: number;
  readonly snapshot?: Uint8Array;
}): string | null {
  const limits = input.capacity.inputs;
  if (input.lastSeq - (input.baseSeq ?? 0) > limits.maxTransactionsPerDoc)
    return "content transaction capacity exceeded";
  if (
    (input.snapshot ?? Y.encodeStateAsUpdate(input.doc)).byteLength >
    Math.min(MAX_DOC_SNAPSHOT_BYTES, limits.activeHardEncodedBytes)
  )
    return "content snapshot exceeds active write limit";
  const records = input.doc.getMap<unknown>("root").get("records");
  if (!(records instanceof Y.Array)) return null;
  if (records.length > limits.maxRecordsPerDoc) return "content record capacity exceeded";
  for (const record of records.toArray() as unknown[]) {
    if (record === null || typeof record !== "object") continue;
    const payload = (record as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array && payload.byteLength > limits.payloadChunkMaxBytes)
      return "content payload capacity exceeded";
  }
  return null;
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
