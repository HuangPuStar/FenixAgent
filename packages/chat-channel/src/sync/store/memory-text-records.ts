import * as Y from "yjs";
import type { DigestFn } from "../clock";
import { textClaimLookupId } from "../live/text-claim-identity";
import type { SyncRefRecord } from "./types";

/** 使用与读取器相同的首条 recordId 语义，不能由后写同名对象覆盖校验目标。 */
export function canonicalContentRecords(doc: Y.Doc): ReadonlyMap<string, unknown> {
  const records = doc.getMap<unknown>("root").get("records");
  const result = new Map<string, unknown>();
  if (!(records instanceof Y.Array)) return result;
  for (const value of records.toArray() as unknown[]) {
    if (value === null || typeof value !== "object") continue;
    const id = (value as { recordId?: unknown }).recordId;
    if (typeof id === "string" && !result.has(id)) result.set(id, value);
  }
  return result;
}

/** live-text 定位必须满足消费者的完整身份、二进制载荷与整片范围契约。 */
export function validLiveTextRef(ref: SyncRefRecord, value: unknown, digest: DigestFn): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "text" &&
    typeof record.entryId === "string" &&
    typeof record.contentSlot === "string" &&
    record.payload instanceof Uint8Array &&
    ref.contentSlot === 0 &&
    ref.partIndex === 0 &&
    ref.lookupId ===
      textClaimLookupId(digest, {
        scopeKey: ref.scopeKey,
        generation: ref.generation,
        entryId: record.entryId,
        contentSlot: record.contentSlot,
      }) &&
    ref.byteStart === 0 &&
    ref.byteEnd === record.payload.byteLength &&
    ref.orderStart === 0 &&
    ref.orderEnd === 0
  );
}
