// provider 会话的私有状态类型：与线上帧契约分开，避免实现细节继续膨胀会话编排文件。

import type { ManifestFrame } from "../protocol/frames";
import type { SyncScope } from "../protocol/identity";
import type { SyncGenerationRecord } from "../store/types";
import type { TaskClass } from "./quota";

export interface ManifestState {
  readonly scope: SyncScope;
  readonly entry: Omit<ManifestFrame, "type" | "protocolVersion" | "recoveryState">;
  readonly recoveryState: "ready" | "importing";
}

export interface DocAttempt {
  readonly docId: string;
  readonly subscriptionEpoch: string;
  readonly syncAttemptId: string;
  readonly taskClass: TaskClass;
  /** 有界任务引用：base 尚未送出（含因额度不足而暂缓）。 */
  needsBase: boolean;
  /** 回执确认前不得发 BASE_READY，未 READY 不得发 tail；`upToSeq` 即 `DOC_BASE.baseSeq`。 */
  base: { readonly deliveryId: string; readonly upToSeq: number; acked: boolean; readySent: boolean } | null;
  /** 客户端已确认 processed 的应用边界；`sendCursor` 是可领先它的已发送边界，尾部据此续发而不重复构建。 */
  appliedSeq: number;
  sendCursor: number;
  resyncRequired: boolean;
  resyncNotice: { readonly previousSubscriptionEpoch: string; readonly previousSyncAttemptId: string } | null;
  /** pump 串行化标记：await 期间同一 Doc 不会被第二次构建出重复帧。 */
  busy: boolean;
  readonly clientStateVector?: Uint8Array;
  readonly requestedFromSeq?: number;
}

export interface ManifestSource {
  readonly scope: SyncScope;
  readonly generation: string;
  readonly pointerRevision: number;
  readonly record: SyncGenerationRecord;
}

export interface ReplaceInput {
  readonly generation: string;
  readonly pointerRevision: number;
}
