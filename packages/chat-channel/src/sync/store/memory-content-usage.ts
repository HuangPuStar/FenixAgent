import * as Y from "yjs";
import { type DecodedStateUpdate, decodeStateUpdate } from "../capacity/encoded-state-bound";

/** 仅内存 adapter 持有的保守上界；不是可移植快照中的可信事实。 */
export interface ContentUsage {
  readonly recordCountUpper: number;
  readonly maxPayloadBytes: number;
  readonly hasLiveText: boolean;
}

/** 增量中的删除、文本和不透明结构分别决定是否可能撤回跨块证明。 */
export interface ContentDelta {
  readonly usage: ContentUsage;
  readonly deletes: boolean;
  readonly opaque: boolean;
  readonly encoding: DecodedStateUpdate;
}

/** 一次解析同时估算容量并识别可能改写现存 canonical 文本的增量。 */
export function analyzeContentUpdate(update: Uint8Array): ContentDelta {
  let recordCountUpper = 0,
    maxPayloadBytes = 0,
    hasLiveText = false,
    opaque = false;
  const encoding = decodeStateUpdate(update),
    decoded = encoding.decoded;
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
      const payload = (value as { payload?: unknown }).payload;
      if (payload instanceof Uint8Array) maxPayloadBytes = Math.max(maxPayloadBytes, payload.byteLength);
    }
  }
  return {
    usage: { recordCountUpper, maxPayloadBytes, hasLiveText },
    deletes: decoded.ds.clients.size > 0,
    opaque,
    encoding,
  };
}

/** 包含隐藏和待接入内容，后续引用激活也不会低估记录或载荷。 */
export function contentUpdateUsage(update: Uint8Array): ContentUsage {
  return analyzeContentUpdate(update).usage;
}

/** 重复或重叠更新只抬高上界；无法证明安全时交回真实 Doc 校验。 */
export function appendContentUsage(usage: ContentUsage, additions: readonly ContentDelta[]): ContentUsage {
  let { recordCountUpper, maxPayloadBytes, hasLiveText } = usage;
  for (const { usage: next } of additions) {
    recordCountUpper = Math.min(Number.MAX_SAFE_INTEGER, recordCountUpper + next.recordCountUpper);
    maxPayloadBytes = Math.max(maxPayloadBytes, next.maxPayloadBytes);
    hasLiveText ||= next.hasLiveText;
  }
  return { recordCountUpper, maxPayloadBytes, hasLiveText };
}
