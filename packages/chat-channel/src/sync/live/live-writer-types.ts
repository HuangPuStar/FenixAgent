// packages/chat-channel/src/sync/live/live-writer-types.ts
// 实时写者的公开契约（从 live-writer.ts 拆出，导出形状保持不变）。

import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn, RandomSource } from "../clock";
import type { HistoryRecordKind, HistoryRecordMeta } from "../history/ingest";
import type { SyncScope } from "../protocol/identity";
import type { CommitOutcome, ProjectionStore } from "../store/types";
import type { RotationControllerOptions } from "./rotation";
import type { RuntimeDocLimits } from "./runtime-doc";
import type { SealResult } from "./sealing";

export type BarrierKind = "tool" | "permission" | "error" | "cancel" | "final";

export interface LiveInput {
  readonly turnId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
  readonly kind: "text-delta" | "semantic" | "content-object";
  /** 已授权源对象；不承载应用视图类型。 */
  readonly object?: { readonly value: unknown; readonly meta: HistoryRecordMeta };
  readonly delta?: string;
  /** 同 entryId + 内容槽只提交一次；用于用户消息在写者交接/多入口下的幂等。 */
  readonly idempotent?: boolean;
  /** 语义载荷契约：`entityId` 必填，`toolCallId` / `metadata` 可选；载荷带 `finalDescriptor` 即实体交接（描述符写进内容块并在同批次移出运行态），`kind: "final"` 是它的规范形态。 */
  readonly semantic?: { readonly kind: BarrierKind; readonly payload: Record<string, unknown> };
}

export interface LiveWriterOptions {
  readonly admission?: AdmissionController;
  readonly scope: SyncScope;
  readonly store: ProjectionStore;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly capacity: SyncCapacityProfile;
  readonly merge: { readonly maxDelayMs: number; readonly maxBytes: number };
  readonly limits: RuntimeDocLimits;
  readonly rotation: RotationControllerOptions;
}

export interface PendingBatch {
  readonly batchId: string;
  readonly docId: string;
  readonly ordinalStart: number;
  readonly ordinalEnd: number;
  readonly digest: string;
  readonly payload: Uint8Array;
}

export interface LiveWriter {
  acquire(): Promise<void>;
  /** 续租当前写权；失权时清空本地租约但不把错误变成永久失败，调用方可重新竞争。 */
  renew(): Promise<void>;
  /** 文本冲刷失败仍保留已接纳窗口，由恢复或屏障重试；跨调用重发需提供幂等身份，非幂等输入逐次追加。 */
  accept(input: LiveInput): Promise<void>;
  commit(pending: PendingBatch): Promise<CommitOutcome>;
  seal(): Promise<SealResult>;
  rotateRuntime(): Promise<{ readonly oldDocId: string; readonly newDocId: string; readonly requiredBaseSeq: number }>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface LiveRecordValue {
  readonly recordId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
  readonly partIndex: number;
  readonly kind: "text" | "final" | "tool_boundary" | HistoryRecordKind;
  readonly entryOrder?: number;
  readonly sourceRevision?: number;
  readonly role?: HistoryRecordMeta["role"];
  readonly payload: Uint8Array;
}

export const LIVE_WRITER_LEASE_TTL_MS = 30_000;
export const LIVE_COMMIT_MAX_ATTEMPTS = 3;
