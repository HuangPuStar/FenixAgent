import type { AppendUpdatesInput, SyncDocRecord } from "./types";

/** 同批文本更新后的封口终点；路由和最终快照随整批一次发布。 */
export interface ContentBatchSeal {
  readonly docId: string;
  readonly finalSeq: number;
  readonly finalSnapshot: Uint8Array;
  readonly finalHash: string;
  readonly successorDocId: string;
}

/** 一次逻辑文本冲刷的完整写计划，包含必要的新块、封口和目录更新。 */
export interface CommitContentBatchInput extends AppendUpdatesInput {
  readonly generation: string;
  readonly newDocs: SyncDocRecord[];
  readonly seals: ContentBatchSeal[];
  readonly expectedPointerRevision: number;
}
