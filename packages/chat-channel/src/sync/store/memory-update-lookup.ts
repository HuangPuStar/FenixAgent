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
