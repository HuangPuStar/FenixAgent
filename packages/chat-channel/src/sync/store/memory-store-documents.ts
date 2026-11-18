import type { DigestFn } from "../clock";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { copyBytes, fail, type StoredDoc } from "./memory-store-state";
import type { SyncDocRecord } from "./types";

/** 新文档与原子后继登记共用初始字节校验，并隔离调用方的可变缓冲。 */
export function prepareActiveDocument(doc: SyncDocRecord, digest: DigestFn, dependsOnMax: number): StoredDoc {
  if (doc.snapshot.byteLength > MAX_DOC_SNAPSHOT_BYTES) fail("CAPACITY_EXCEEDED", "snapshot exceeds transport budget");
  if (doc.state !== "active" || doc.baseSeq !== 0 || doc.finalSeq !== null || digest(doc.snapshot) !== doc.hash)
    fail("MALFORMED_FRAME", "new document must be an active base snapshot");
  if (doc.dependsOn.length > dependsOnMax) fail("CAPACITY_EXCEEDED", "document dependencies exceed capacity");
  const snapshot = copyBytes(doc.snapshot);
  return {
    ...doc,
    lastSeq: doc.baseSeq,
    baseSnapshot: snapshot,
    baseHash: doc.hash,
    snapshot,
    dependsOn: [...doc.dependsOn],
    sealedAt: null,
    retiredAt: null,
  };
}

/** 新路由只能复用未使用的同谱系目标，不能因摘要相同把另一身份或已写入文档接为后继。 */
export function sameSuccessorBase(existing: StoredDoc, candidate: StoredDoc): boolean {
  return (
    existing.scopeKey === candidate.scopeKey &&
    existing.docId === candidate.docId &&
    existing.generation === candidate.generation &&
    existing.kind === candidate.kind &&
    existing.state === "active" &&
    existing.baseSeq === candidate.baseSeq &&
    existing.lastSeq === candidate.baseSeq &&
    existing.finalSeq === null &&
    existing.blockIndex === candidate.blockIndex &&
    existing.ordinalStart === candidate.ordinalStart &&
    existing.ordinalEnd === candidate.ordinalEnd &&
    existing.dependsOn.length === candidate.dependsOn.length &&
    existing.dependsOn.every((id, index) => id === candidate.dependsOn[index]) &&
    existing.baseHash === candidate.baseHash &&
    existing.baseSnapshot.byteLength === candidate.baseSnapshot.byteLength &&
    existing.baseSnapshot.every((byte, index) => byte === candidate.baseSnapshot[index])
  );
}
