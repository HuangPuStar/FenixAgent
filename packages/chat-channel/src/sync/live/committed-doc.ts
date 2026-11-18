import * as Y from "yjs";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { DocKind } from "../protocol/identity";
import type { AppendUpdatesResult, CommitOutcome, DocFrontier, ProjectionStore, WriterLease } from "../store/types";
import type { Batch, Cursor, Probe } from "./live-writer-internal";
import { LIVE_COMMIT_MAX_ATTEMPTS } from "./live-writer-types";
import { applyFrontiers, expectedFrontiers } from "./writer-support";

/** successor 的本地游标与已登记 snapshot 共用同一份 Yjs 身份。 */
export function openLiveCursor(docId: string, kind: DocKind, snapshot: Uint8Array): Cursor {
  const doc = new Y.Doc({ guid: docId });
  try {
    Y.applyUpdate(doc, snapshot);
    return { docId, kind, doc, lastSeq: 0 };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** canonical + 连续 tail 才是已提交事实；封口前的 base 不一定包含全部边界。 */
export async function loadCommittedDoc(
  store: ProjectionStore,
  docId: string,
): Promise<{ readonly doc: Y.Doc; readonly lastSeq: number } | null> {
  const base = await store.readDocStateAt(docId, 0);
  if (base === null) return null;
  const doc = new Y.Doc({ guid: docId });
  try {
    Y.applyUpdate(doc, base.snapshot);
    let lastSeq = base.lastSeq;
    for (;;) {
      const page = await store.readUpdatesAfter(docId, lastSeq, 256);
      if (page.length === 0) return { doc, lastSeq };
      for (const update of page) {
        if (update.updateSeq !== lastSeq + 1) {
          throw new SyncProtocolError("SEQUENCE_GAP", { message: `tail of ${docId} is not continuous` });
        }
        Y.applyUpdate(doc, update.bytes);
        lastSeq = update.updateSeq;
      }
    }
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** 未知回执只以已提交 tail 核对；混合结果不能猜作未提交并重放。 */
export async function probeCommittedBatch(store: ProjectionStore, batch: Batch): Promise<Probe> {
  const frontiers: DocFrontier[] = [];
  for (const { docId, fromSeq } of batch.slices) {
    const first = (await store.readUpdatesAfter(docId, fromSeq - 1, 1))[0];
    if (first === undefined || first.updateSeq !== fromSeq) continue;
    if (first.batchId !== batch.batchId || first.digest !== batch.digest) return { status: "ambiguous" };
    frontiers.push({ docId, lastSeq: fromSeq });
  }
  if (frontiers.length === batch.slices.length) return { status: "committed", frontiers };
  return { status: frontiers.length === 0 ? "absent" : "ambiguous" };
}

/** 执行批次：全组一次 `appendUpdates`（不得部分写入后重试），按回执推进游标；`unknown` 先查询，只有结论为「确定不存在且写权仍在」才允许重放原字节。 */
export async function appendCommittedBatch(input: {
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly batch: Batch;
  readonly cursors: ReadonlyMap<string, Cursor>;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<CommitOutcome> {
  const { batch, cursors } = input;
  let unresolved = false;
  for (let attempt = 1; ; attempt += 1) {
    let result: AppendUpdatesResult;
    try {
      const lease = await input.renew();
      result = await input.store.appendUpdates({
        scopeKey: input.scopeKey,
        epoch: lease.epoch,
        owner: lease.owner,
        batchId: batch.batchId,
        digest: batch.digest,
        expectedFrontiers: expectedFrontiers(batch.slices),
        updates: batch.slices.map((slice) => ({ docId: slice.docId, fromSeq: slice.fromSeq, bytes: slice.bytes })),
        refs: batch.refs,
      });
    } catch (error) {
      if (unresolved) throw input.stop("COMMIT_OUTCOME_UNKNOWN", `batch ${batch.batchId} retry failed`, error);
      throw error;
    }
    // 同幂等键异内容：本机不得覆盖已提交字节，也无从「重试」出另一个结果，只能停写。
    if (result.outcome === "conflict") throw input.stop("DIGEST_CONFLICT", `committed batch ${batch.batchId} differs`);
    if (result.outcome !== "unknown") {
      applyFrontiers(cursors, result.frontiers);
      return result.outcome;
    }
    unresolved = true;
    let probe: Probe;
    try {
      probe = await probeCommittedBatch(input.store, batch);
    } catch (error) {
      throw input.stop("COMMIT_OUTCOME_UNKNOWN", `batch ${batch.batchId} could not be confirmed`, error);
    }
    if (probe.status === "committed") {
      applyFrontiers(cursors, probe.frontiers);
      return "already-committed";
    }
    if (probe.status === "absent" && attempt < LIVE_COMMIT_MAX_ATTEMPTS) continue;
    throw input.stop("COMMIT_OUTCOME_UNKNOWN", `batch ${batch.batchId} is undecided after ${attempt} attempts`);
  }
}
