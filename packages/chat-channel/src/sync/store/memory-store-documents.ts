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

/** 比较身份与不可变初始字节；新路由仅复用未使用目标，已提交路由允许后继继续演进。 */
export function sameSuccessorBase(existing: StoredDoc, candidate: StoredDoc, routeCommitted: boolean): boolean {
  return (
    existing.scopeKey === candidate.scopeKey &&
    existing.docId === candidate.docId &&
    existing.generation === candidate.generation &&
    existing.kind === candidate.kind &&
    (routeCommitted
      ? existing.state !== "retired"
      : existing.state === "active" && existing.lastSeq === candidate.baseSeq && existing.finalSeq === null) &&
    existing.baseSeq === candidate.baseSeq &&
    (existing.kind !== "content" || existing.blockIndex === candidate.blockIndex) &&
    // SealRequest 不表达非内容行索引、范围与依赖；这些元数据保留既有值，身份由 docId 约束。
    existing.baseHash === candidate.baseHash &&
    existing.baseSnapshot.byteLength === candidate.baseSnapshot.byteLength &&
    existing.baseSnapshot.every((byte, index) => byte === candidate.baseSnapshot[index])
  );
}
