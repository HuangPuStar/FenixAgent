import * as Y from "yjs";
import { createEncodedStateBound } from "../capacity/encoded-state-bound";
import { TEXT_CLAIM_REPLAY_MAX_BYTES } from "../capacity/text-claim-reservations";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { fail, type StoredDoc } from "./memory-store-state";
import type { SyncUpdateRecord } from "./types";

/** 仅重建触及的 Doc；正文每步遵循读取器同一驻留上限，最终限额由写入口另行校验。 */
export function projectMemoryDoc(
  doc: StoredDoc,
  prior: readonly SyncUpdateRecord[],
  added: readonly SyncUpdateRecord[],
  beforeAdd?: (doc: Y.Doc) => void,
): Y.Doc {
  const bound = createEncodedStateBound(doc.baseSnapshot);
  const value = new Y.Doc({ guid: doc.docId });
  const check = () => {
    if (doc.kind !== "content" || bound.upperBytes <= TEXT_CLAIM_REPLAY_MAX_BYTES) return;
    const snapshot = Y.encodeStateAsUpdate(value);
    if (snapshot.byteLength > TEXT_CLAIM_REPLAY_MAX_BYTES)
      fail("CAPACITY_EXCEEDED", "content intermediate replay exceeds encoded limit");
    bound.calibrate(snapshot.byteLength, value);
  };
  const apply = (update: SyncUpdateRecord) => {
    if (doc.kind === "content" && update.bytes.byteLength > MAX_DOC_SNAPSHOT_BYTES)
      fail("CAPACITY_EXCEEDED", "content update exceeds transport limit");
    bound.add(update.bytes);
    Y.applyUpdate(value, update.bytes);
    check();
  };
  try {
    if (doc.kind === "content" && doc.baseSnapshot.byteLength > MAX_DOC_SNAPSHOT_BYTES)
      fail("CAPACITY_EXCEEDED", "content base exceeds transport limit");
    Y.applyUpdate(value, doc.baseSnapshot);
    check();
    for (const update of prior) apply(update);
    beforeAdd?.(value);
    for (const update of added) apply(update);
    return value;
  } catch (error) {
    value.destroy();
    throw error;
  }
}
