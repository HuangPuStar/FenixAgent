const FILTER_BYTES = 1024;
const FILTER_BITS = FILTER_BYTES * 8;
const ENCODING_OFFSET = 0x100;

/** 固定 8192 bit；字符避开 JSON 转义，UTF-16 与索引计费均保持固定上界。 */
export const EMPTY_RECORD_ID_FILTER = String.fromCharCode(ENCODING_OFFSET).repeat(FILTER_BYTES);

function positions(id: string): readonly number[] {
  let first = 2166136261,
    second = 0x9e3779b9;
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  second |= 1;
  return Array.from({ length: 4 }, (_, index) => (first + Math.imul(index, second)) & (FILTER_BITS - 1));
}

/** 仅作排除证明：碰撞可增加精确重建，不能把存在的身份判断为不存在。 */
export function mayContainRecordId(filter: string, id: string): boolean {
  return positions(id).every((bit) => ((filter.charCodeAt(bit >>> 3) - ENCODING_OFFSET) & (1 << (bit & 7))) !== 0);
}

/** 在固定临时位图内同时排除旧身份和本批身份碰撞，不依赖 kind 或到达次序。 */
export function mayRepeatRecordIds(filter: string, ids: Iterable<string>): boolean {
  const bits = new Uint8Array(FILTER_BYTES);
  for (let index = 0; index < FILTER_BYTES; index++) bits[index] = filter.charCodeAt(index) - ENCODING_OFFSET;
  for (const id of ids) {
    const offsets = positions(id);
    if (offsets.every((bit) => (bits[bit >>> 3] & (1 << (bit & 7))) !== 0)) return true;
    for (const bit of offsets) bits[bit >>> 3] |= 1 << (bit & 7);
  }
  return false;
}

/** 内部可信的旧位图原样并入；pending 和非 canonical 记录也保留所有潜在身份。 */
export function mergeRecordIdFilters(filters: readonly string[], ids: Iterable<string> = []): string {
  const bits = new Uint8Array(FILTER_BYTES);
  for (const filter of filters)
    for (let index = 0; index < FILTER_BYTES; index++) bits[index] |= filter.charCodeAt(index) - ENCODING_OFFSET;
  for (const id of ids) for (const bit of positions(id)) bits[bit >>> 3] |= 1 << (bit & 7);
  return String.fromCharCode(...Array.from(bits, (value) => value + ENCODING_OFFSET));
}
