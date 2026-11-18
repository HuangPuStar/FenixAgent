import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { DigestFn, RandomSource } from "../clock";
import type { ContentBatchSeal } from "../store/live-content-batch-types";
import type { ProjectionStore, SyncDocRecord } from "../store/types";
import type { DirectoryAppender } from "./directory-appender";
import type { Cursor, Slice } from "./live-writer-internal";
import type { MergeFlushRequest } from "./merge-buffer";

/** 离线规划仅借用当前正文与目录，不拥有原游标的生命周期。 */
export interface TextBatchPlanOptions {
  readonly request: MergeFlushRequest;
  readonly cursor: Cursor;
  readonly scopeKey: string;
  readonly generation: string;
  readonly capacity: SyncCapacityProfile;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly store: ProjectionStore;
  readonly directory: DirectoryAppender;
  readonly admission?: AdmissionController;
  /** 单raw帧可叠加先前窗口；调用方自定义合并阈值时应同步传入该完整flush上限。 */
  readonly maxFlushBytes?: number;
}

/** 字节、封口及目录发现性在同一存储事务落地后，调用 commit 安装目录缓存并接管 finalCursor。 */
export interface TextBatchPlan {
  /** 每个正文piece一条有界更新，同Doc的fromSeq连续；整个数组只提交一次。 */
  readonly slices: readonly Slice[];
  readonly newDocs: readonly SyncDocRecord[];
  readonly seals: readonly ContentBatchSeal[];
  readonly cursors: ReadonlyMap<string, Cursor>;
  readonly finalCursor: Cursor;
  readonly expectedPointerRevision: number;
  commit(): void;
  dispose(): void;
}

/** 当前目录根与末页的有界读写状态。 */
export interface TextDirectoryState {
  readonly generation: string;
  readonly root: Cursor;
  readonly page: Cursor | null;
}

/** 目录状态随正文整批提交；未提交时 dispose 不改动原缓存。 */
export interface TextDirectoryPlan {
  readonly slices: readonly Slice[];
  readonly newDocs: readonly SyncDocRecord[];
  readonly cursors: ReadonlyMap<string, Cursor>;
  commit(): void;
  dispose(): void;
}
