// packages/chat-channel/src/sync/live/live-writer.ts
// 实时写者的公开入口：公开契约（类型/常量）从 live-writer-types 转出，实现位于 live-writer-impl。
// 对外形状保持不变；拆分只为控制单文件规模与职责边界。

import { LiveWriterImpl } from "./live-writer-impl";
import type { LiveWriter, LiveWriterOptions } from "./live-writer-types";

export type {
  BarrierKind,
  LiveInput,
  LiveRecordValue,
  LiveWriter,
  LiveWriterOptions,
  PendingBatch,
} from "./live-writer-types";
export { LIVE_COMMIT_MAX_ATTEMPTS, LIVE_WRITER_LEASE_TTL_MS } from "./live-writer-types";

export function createLiveWriter(options: LiveWriterOptions): LiveWriter {
  return new LiveWriterImpl(options);
}
