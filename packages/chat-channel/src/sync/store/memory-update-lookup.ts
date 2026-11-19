/** 有序连续账本按已读前沿定位下一页，避免小页反复遍历同一旧前缀。 */
export function firstUpdateAfter(updates: readonly { readonly updateSeq: number }[], seq: number): number {
  let low = 0,
    high = updates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (updates[middle].updateSeq <= seq) low = middle + 1;
    else high = middle;
  }
  return low;
}

import { SyncProtocolError } from "../protocol/errors";

/** 增量须为正安全整数并按每份 scope/doc 严格升序；跨 Doc 可交错，不重排坏快照。 */
export function assertUpdateLedgerOrder(
  updates: readonly {
    readonly scopeKey: string;
    readonly docId: string;
    readonly updateSeq: number;
  }[],
): void {
  const previous = new Map<string, number>();
  for (const update of updates) {
    const key = JSON.stringify([update.scopeKey, update.docId]),
      last = previous.get(key);
    if (
      !Number.isSafeInteger(update.updateSeq) ||
      update.updateSeq <= 0 ||
      (last !== undefined && update.updateSeq <= last)
    )
      throw new SyncProtocolError("SEQUENCE_GAP", { message: "restored document updates must be strictly ascending" });
    previous.set(key, update.updateSeq);
  }
}
