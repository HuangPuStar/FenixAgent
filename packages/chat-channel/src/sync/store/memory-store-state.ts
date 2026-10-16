// 内存 adapter 的状态与快照复制；业务写入校验仍由 memory-store.ts 持有。
import { SyncProtocolError } from "../protocol/errors";
import type {
  DirectoryPage,
  DirectoryQuery,
  DocStateSnapshot,
  GenerationEntryRefs,
  RefQuery,
  SyncDocRecord,
  SyncGenerationRecord,
  SyncRefRecord,
  SyncScopeRow,
  SyncUpdateRecord,
} from "./types";

/** 内存文档的已提交前沿与生命周期元数据。 */
export interface StoredDoc extends SyncDocRecord {
  lastSeq: number;
  baseSnapshot: Uint8Array;
  baseHash: string;
  sealedAt: number | null;
  retiredAt: number | null;
}
interface StoredGeneration extends SyncGenerationRecord {
  retiredAt: number | null;
}
interface BatchRecord {
  digest: string;
  frontiers: { docId: string; lastSeq: number }[];
}
interface SuccessorRoute {
  successorDocId: string;
  expectedLastSeq: number;
}
/** 换代提交的幂等写前像。 */
export interface CommitRecord {
  expectedCurrent: string | null;
  expectedPointerRevision: number;
  entryClosure: GenerationEntryRefs;
  retired: string[];
}
/** 可移植的提交快照；字节均为副本，调用方不能取得内部可变状态。 */
export interface CommittedStateSnapshot {
  scopes: SyncScopeRow[];
  generations: StoredGeneration[];
  docs: StoredDoc[];
  updates: SyncUpdateRecord[];
  refs: SyncRefRecord[];
  batches: { scopeKey: string; batchId: string; digest: string; frontiers: { docId: string; lastSeq: number }[] }[];
  successors: { predecessorDocId: string; route: SuccessorRoute }[];
  commits: { scopeKey: string; generation: string; record: CommitRecord }[];
  retireTombstones: string[];
}
/** 隔离可变字节缓冲。 */
export const copyBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);
/** 所有持久行索引均包含 scope，禁止以裸 docId 作为行键。 */
export const compositeKey = (scopeKey: string, value: string): string => `${scopeKey}\u0000${value}`;
/** 保留协议错误码交由调用方处理。 */
export function fail(code: ConstructorParameters<typeof SyncProtocolError>[0], message: string): never {
  throw new SyncProtocolError(code, { message });
}
/** 隔离入口闭包的可变数组。 */
export function copyRefs(refs: GenerationEntryRefs): GenerationEntryRefs {
  return { ...refs, contentDocIds: [...refs.contentDocIds] };
}
/** 比较幂等提交的入口闭包。 */
export function sameRefs(left: GenerationEntryRefs, right: GenerationEntryRefs): boolean {
  return (
    left.controlDocId === right.controlDocId &&
    left.directoryDocId === right.directoryDocId &&
    left.runtimeDocId === right.runtimeDocId &&
    left.contentDocIds.length === right.contentDocIds.length &&
    left.contentDocIds.every((id, index) => id === right.contentDocIds[index])
  );
}
function copyDoc(doc: StoredDoc): StoredDoc {
  return {
    ...doc,
    snapshot: copyBytes(doc.snapshot),
    baseSnapshot: copyBytes(doc.baseSnapshot),
    dependsOn: [...doc.dependsOn],
  };
}
/** 隔离代次入口闭包。 */
export function copyGeneration(value: StoredGeneration): StoredGeneration {
  return { ...value, entryRefs: copyRefs(value.entryRefs) };
}
/** 隔离已提交更新的字节。 */
export function copyUpdate(value: SyncUpdateRecord): SyncUpdateRecord {
  return { ...value, bytes: copyBytes(value.bytes) };
}
/** 返回独立索引记录。 */
export function copyRef(value: SyncRefRecord): SyncRefRecord {
  return { ...value };
}

/** 仅供内存 adapter 使用的状态容器，不提供业务写入入口。 */
export class MemoryStoreState {
  protected readonly scopes = new Map<string, SyncScopeRow>();
  protected readonly generations = new Map<string, StoredGeneration>();
  protected readonly docs = new Map<string, StoredDoc>();
  protected readonly updates = new Map<string, SyncUpdateRecord[]>();
  protected readonly refs = new Map<string, SyncRefRecord>();
  protected readonly batches = new Map<string, BatchRecord>();
  protected readonly successors = new Map<string, SuccessorRoute>();
  protected readonly commits = new Map<string, CommitRecord>();
  protected readonly retireTombstones = new Set<string>();

  // 读取契约尚无 scope 参数：写入拒绝跨 scope 同名 ID；恢复异常快照时也不得任选一行。
  protected findDoc(docId: string): StoredDoc | undefined {
    const matches = [...this.docs.values()].filter((doc) => doc.docId === docId);
    if (matches.length > 1) fail("MALFORMED_FRAME", "document identity is ambiguous without scope");
    return matches[0];
  }
  protected refKey(ref: SyncRefRecord): string {
    return [ref.scopeKey, ref.generation, ref.lookupKind, ref.lookupId, ref.contentSlot, ref.partIndex].join("\u0000");
  }
  protected deleteDoc(scopeKey: string, docId: string): void {
    const key = compositeKey(scopeKey, docId);
    this.docs.delete(key);
    this.updates.delete(key);
    for (const [id, ref] of this.refs) if (ref.scopeKey === scopeKey && ref.docId === docId) this.refs.delete(id);
    for (const [predecessor, route] of this.successors)
      if (predecessor === key || (predecessor.startsWith(`${scopeKey}\u0000`) && route.successorDocId === docId))
        this.successors.delete(predecessor);
  }

  /** 只返回指定边界的已提交快照，不能以更晚的状态替代。 */
  async readDocStateAt(docId: string, seq: number): Promise<DocStateSnapshot | null> {
    const doc = this.findDoc(docId);
    if (doc === undefined || doc.state === "retired") return null;
    if (seq === doc.baseSeq)
      return {
        docId,
        baseSeq: doc.baseSeq,
        lastSeq: doc.baseSeq,
        snapshot: copyBytes(doc.baseSnapshot),
        hash: doc.baseHash,
      };
    if (doc.state === "sealed" && seq === doc.finalSeq)
      return { docId, baseSeq: doc.baseSeq, lastSeq: doc.finalSeq, snapshot: copyBytes(doc.snapshot), hash: doc.hash };
    return null;
  }

  /** 已提交 tail 按连续序号读取，在缺口停止并复制返回字节。 */
  async readUpdatesAfter(docId: string, seq: number, limit: number): Promise<SyncUpdateRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) fail("MALFORMED_FRAME", "update limit must be non-negative");
    const doc = this.findDoc(docId);
    if (doc === undefined || doc.state === "retired") return [];
    const result: SyncUpdateRecord[] = [];
    let expected = seq + 1;
    for (const update of this.updates.get(compositeKey(doc.scopeKey, docId)) ?? []) {
      if (update.updateSeq < expected) continue;
      if (update.updateSeq !== expected || result.length >= limit) break;
      result.push(copyUpdate(update));
      expected += 1;
    }
    return result;
  }

  // generation-only 查询同样不能混合不同 scope 的目录与 refs。
  private findGeneration(generation: string): StoredGeneration | undefined {
    const matches = [...this.generations.values()].filter((item) => item.generation === generation);
    if (matches.length > 1) fail("GENERATION_MISMATCH", "generation identity is ambiguous without scope");
    return matches[0];
  }

  /** 返回指定代次的封口目录，并报告连续范围中的缺口。 */
  async readDirectory(query: DirectoryQuery): Promise<DirectoryPage> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 0)
      fail("MALFORMED_FRAME", "directory limit must be non-negative");
    const record = this.findGeneration(query.generation);
    const entries = [...this.docs.values()]
      .filter(
        (doc) =>
          doc.scopeKey === record?.scopeKey &&
          doc.generation === query.generation &&
          doc.kind === "content" &&
          doc.state === "sealed" &&
          doc.ordinalStart !== null &&
          doc.ordinalEnd !== null,
      )
      .sort((left, right) => left.ordinalStart! - right.ordinalStart! || left.docId.localeCompare(right.docId));
    const gaps: DirectoryPage["gaps"] = [];
    // 缺口只描述「已提交块之间」与「末端到 importEndOrdinal」的断裂：存储不知道调用方期望的起始序号，
    // 因此首个块之前一律不算缺口（曾把 previous 初始化为 -1，导致首个块 ordinalStart=1 时虚报 {-1,1}，
    // 使目录 complete 恒为 false，导入完整性校验永远无法通过）。
    let previous = entries.length === 0 ? -1 : entries[0].ordinalStart! - 1;
    for (const doc of entries) {
      if (doc.ordinalStart! > previous + 1) gaps.push({ afterOrdinal: previous, beforeOrdinal: doc.ordinalStart! });
      previous = Math.max(previous, doc.ordinalEnd!);
    }
    if (
      record?.importEndOrdinal !== null &&
      record?.importEndOrdinal !== undefined &&
      previous < record.importEndOrdinal
    )
      gaps.push({ afterOrdinal: previous, beforeOrdinal: record.importEndOrdinal });
    const after = query.afterOrdinal ?? -1;
    return {
      entries: entries
        .filter((doc) => doc.ordinalStart! > after)
        .slice(0, query.limit)
        .map((doc) => ({
          docId: doc.docId,
          ordinalStart: doc.ordinalStart!,
          ordinalEnd: doc.ordinalEnd!,
          hash: doc.hash,
          sealed: true,
        })),
      gaps,
      complete: gaps.length === 0,
    };
  }

  /** 分页读取与 canonical 字节一同提交的定位索引。 */
  async locateRefs(query: RefQuery): Promise<SyncRefRecord[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 0)
      fail("MALFORMED_FRAME", "reference limit must be non-negative");
    const generation = this.findGeneration(query.generation);
    return [...this.refs.values()]
      .filter(
        (ref) =>
          ref.scopeKey === generation?.scopeKey &&
          ref.generation === query.generation &&
          ref.lookupKind === query.lookupKind &&
          ref.lookupId === query.lookupId &&
          (query.contentSlot === undefined || ref.contentSlot === query.contentSlot) &&
          ref.partIndex > (query.afterPartIndex ?? -1),
      )
      .sort((left, right) => left.contentSlot - right.contentSlot || left.partIndex - right.partIndex)
      .slice(0, query.limit)
      .map(copyRef);
  }

  /** 仅供恢复测试；DB adapter 落地后由真实恢复路径取代，不替代 PostgreSQL 持久化。 */
  exportCommittedState(): CommittedStateSnapshot {
    const batches = [...this.batches].map(([id, value]) => {
      const [scopeKey, batchId] = id.split("\u0000");
      return { scopeKey, batchId, digest: value.digest, frontiers: value.frontiers.map((item) => ({ ...item })) };
    });
    const commits = [...this.commits].map(([id, record]) => {
      const [scopeKey, generation] = id.split("\u0000");
      return {
        scopeKey,
        generation,
        record: { ...record, entryClosure: copyRefs(record.entryClosure), retired: [...record.retired] },
      };
    });
    return {
      scopes: [...this.scopes.values()].map((row) => ({ ...row, writerOwner: null, leaseExpiresAt: 0 })),
      generations: [...this.generations.values()].map(copyGeneration),
      docs: [...this.docs.values()].map(copyDoc),
      updates: [...this.updates.values()].flat().map(copyUpdate),
      refs: [...this.refs.values()].map(copyRef),
      batches,
      successors: [...this.successors].map(([key, route]) => ({
        predecessorDocId: key.split("\u0000")[1],
        route: { ...route },
      })),
      commits,
      retireTombstones: [...this.retireTombstones],
    };
  }

  /** 恢复测试快照并重建带 scope 的索引；不恢复旧写者的租约。 */
  restoreFromCommittedState(snapshot: CommittedStateSnapshot): void {
    this.scopes.clear();
    this.generations.clear();
    this.docs.clear();
    this.updates.clear();
    this.refs.clear();
    this.batches.clear();
    this.successors.clear();
    this.commits.clear();
    this.retireTombstones.clear();
    for (const row of snapshot.scopes) this.scopes.set(row.scopeKey, { ...row, writerOwner: null, leaseExpiresAt: 0 });
    for (const value of snapshot.generations)
      this.generations.set(compositeKey(value.scopeKey, value.generation), copyGeneration(value));
    for (const doc of snapshot.docs) {
      const key = compositeKey(doc.scopeKey, doc.docId);
      this.docs.set(key, copyDoc(doc));
      this.updates.set(key, []);
    }
    for (const update of snapshot.updates)
      this.updates.get(compositeKey(update.scopeKey, update.docId))?.push(copyUpdate(update));
    for (const ref of snapshot.refs) this.refs.set(this.refKey(ref), copyRef(ref));
    for (const batch of snapshot.batches)
      this.batches.set(compositeKey(batch.scopeKey, batch.batchId), {
        digest: batch.digest,
        frontiers: batch.frontiers.map((item) => ({ ...item })),
      });
    for (const item of snapshot.successors) {
      const doc = this.findDoc(item.predecessorDocId);
      if (doc !== undefined) this.successors.set(compositeKey(doc.scopeKey, doc.docId), { ...item.route });
    }
    for (const item of snapshot.commits)
      this.commits.set(compositeKey(item.scopeKey, item.generation), {
        ...item.record,
        entryClosure: copyRefs(item.record.entryClosure),
        retired: [...item.record.retired],
      });
    for (const item of snapshot.retireTombstones) this.retireTombstones.add(item);
  }
}
