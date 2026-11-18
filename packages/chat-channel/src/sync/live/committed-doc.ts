import * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import type { DocKind } from "../protocol/identity";
import type { DocFrontier, ProjectionStore } from "../store/types";
import type { Batch, Cursor, Probe } from "./live-writer-internal";

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
