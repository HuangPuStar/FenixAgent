import * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore } from "../store/types";

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
