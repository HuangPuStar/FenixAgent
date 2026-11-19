import * as Y from "yjs";
import { type DecodedStateUpdate, decodeStateUpdate } from "../capacity/encoded-state-bound";
import { mayRepeatRecordIds, mergeRecordIdFilters } from "./memory-record-id-filter";

/** 仅内存 adapter 持有的保守上界；不是可移植快照中的可信事实。 */
export interface ContentUsage {
  readonly recordCountUpper: number;
  readonly maxPayloadBytes: number;
  readonly hasLiveText: boolean;
  readonly recordIdFilter: string;
}

/** 增量中的删除、文本和不透明结构分别决定是否可能撤回跨块证明。 */
export interface ContentDelta {
  readonly usage: Omit<ContentUsage, "recordIdFilter">;
  readonly deletes: boolean;
  readonly opaque: boolean;
  readonly encoding: DecodedStateUpdate;
  readonly recordIds: readonly string[];
}

/** 一次解析同时估算容量并识别可能改写现存 canonical 文本的增量。 */
export function analyzeContentUpdate(update: Uint8Array): ContentDelta {
  let recordCountUpper = 0,
    maxPayloadBytes = 0,
    hasLiveText = false,
    opaque = false;
  const encoding = decodeStateUpdate(update),
    decoded = encoding.decoded;
  const recordIds: string[] = [];
  opaque = encoding.mapWrites;
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) {
      opaque = true;
      continue;
    }
    if (struct.parentSub !== null) opaque = true;
    const content = struct.content;
    if (content.isCountable()) recordCountUpper = Math.min(Number.MAX_SAFE_INTEGER, recordCountUpper + struct.length);
    if (!(content instanceof Y.ContentAny || content instanceof Y.ContentJSON || content instanceof Y.ContentEmbed)) {
      opaque = true;
      continue;
    }
    for (const value of content.getContent() as unknown[]) {
      if (value === null || typeof value !== "object") continue;
      if ((value as { kind?: unknown }).kind === "text") hasLiveText = true;
      const recordId = (value as { recordId?: unknown }).recordId;
      if (typeof recordId === "string") recordIds.push(recordId);
      const payload = (value as { payload?: unknown }).payload;
      if (payload instanceof Uint8Array) maxPayloadBytes = Math.max(maxPayloadBytes, payload.byteLength);
    }
  }
  return {
    usage: { recordCountUpper, maxPayloadBytes, hasLiveText },
    deletes: decoded.ds.clients.size > 0,
    opaque,
    encoding,
    recordIds,
  };
}

/** 包含隐藏和待接入内容，后续引用激活也不会低估记录或载荷。 */
export function contentUpdateUsage(update: Uint8Array): ContentUsage {
  const delta = analyzeContentUpdate(update);
  return { ...delta.usage, recordIdFilter: mergeRecordIdFilters([], delta.recordIds) };
}

/** 重复或重叠更新只抬高上界；无法证明安全时交回真实 Doc 校验。 */
export function appendContentUsage(usage: ContentUsage, additions: readonly ContentDelta[]): ContentUsage {
  let { recordCountUpper, maxPayloadBytes, hasLiveText } = usage;
  for (const { usage: next } of additions) {
    recordCountUpper = Math.min(Number.MAX_SAFE_INTEGER, recordCountUpper + next.recordCountUpper);
    maxPayloadBytes = Math.max(maxPayloadBytes, next.maxPayloadBytes);
    hasLiveText ||= next.hasLiveText;
  }
  return {
    recordCountUpper,
    maxPayloadBytes,
    hasLiveText,
    recordIdFilter: mergeRecordIdFilters([usage.recordIdFilter], additionRecordIds(additions)),
  };
}

/** 旧客户端的尾插也可能接入当前数组中段；只有身份过滤器可排除同名 canonical 替换。 */
export function contentMayShadow(usage: ContentUsage, additions: readonly ContentDelta[]): boolean {
  return mayRepeatRecordIds(usage.recordIdFilter, additionRecordIds(additions));
}

function* additionRecordIds(additions: readonly ContentDelta[]): Iterable<string> {
  for (const delta of additions) yield* delta.recordIds;
}
