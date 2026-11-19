import { appendMemoryUpdates } from "./memory-append-updates";
import { readMemoryTextCoverage } from "./memory-text-coverage";
import type { LiveTextCoverageQuery } from "./read-types";
// packages/chat-channel/src/sync/store/memory-store.ts
// B 阶段内存 adapter：以同步临界区模拟事务，保留 fencing、幂等和已提交读取边界。
// lifecycle 必须由装配方显式提供；宽限期没有冻结数值，不能在 adapter 内隐藏默认值。
// export/restore 只用于测试「已提交快照 + 连续 tail」恢复，不替代 PostgreSQL adapter。

import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn } from "../clock";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import type { MemoryBudget } from "./memory-accounting";
import { stripDerivedMemoryState } from "./memory-derived-state";
import { commitMemoryContentBatch } from "./memory-live-content-batch";
import { prepareActiveDocument, sameSuccessorBase } from "./memory-store-documents";
import {
  type CommitRecord,
  compositeKey,
  copyBytes,
  copyGeneration,
  copyRefs,
  fail,
  MemoryStoreState,
  type StoredDoc,
  sameRefs,
} from "./memory-store-state";

export type { CommittedStateSnapshot } from "./memory-store-state";

import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  CommitContentBatchInput,
  CommitGenerationInput,
  CommitGenerationResult,
  CreateDocInput,
  CreateGenerationInput,
  ProjectionStore,
  PutSealedInput,
  PutSealedResult,
  RegisterSuccessorInput,
  RegistrationResult,
  RetireResult,
  RetireTarget,
  SealDocInput,
  SealDocResult,
  StoreLifecycleOptions,
  SyncGenerationRecord,
  SyncScopeRow,
  WriterLease,
} from "./types";

/** 以同步提交段实现原子写入，并校验 scope、代次与写者 fencing。 */
export class MemoryProjectionStore extends MemoryStoreState implements ProjectionStore {
  private readonly clock: Clock;
  private readonly digest: DigestFn;
  private readonly capacity: SyncCapacityProfile;
  private readonly lifecycle: StoreLifecycleOptions;

  constructor(options: {
    clock: Clock;
    digest: DigestFn;
    capacity: SyncCapacityProfile;
    lifecycle: StoreLifecycleOptions;
    memoryBudget?: MemoryBudget;
  }) {
    super(options.memoryBudget);
    this.clock = options.clock;
    this.digest = options.digest;
    this.capacity = options.capacity;
    this.lifecycle = options.lifecycle;
  }

  private assertSnapshotSize(snapshot: Uint8Array): void {
    if (snapshot.byteLength > MAX_DOC_SNAPSHOT_BYTES) fail("CAPACITY_EXCEEDED", "snapshot exceeds transport budget");
  }
  async acquireWriter(scopeKey: string, owner: string, ttlMs: number): Promise<WriterLease> {
    this.assertTtl(ttlMs);
    const now = this.clock.now();
    const current = this.scopes.get(scopeKey);
    if (current?.leaseExpiresAt && current.leaseExpiresAt > now) {
      if (current.writerOwner !== owner) fail("SCOPE_BUSY", "scope already has an active writer");
      current.leaseExpiresAt = now + ttlMs;
      return this.lease(current);
    }
    const row: SyncScopeRow = {
      scopeKey,
      currentGeneration: current?.currentGeneration ?? null,
      pointerRevision: current?.pointerRevision ?? 0,
      writerEpoch: (current?.writerEpoch ?? 0) + 1,
      writerOwner: owner,
      leaseExpiresAt: now + ttlMs,
    };
    this.scopes.set(scopeKey, row);
    return this.lease(row);
  }
  async renewWriter(lease: WriterLease, ttlMs: number): Promise<WriterLease> {
    this.assertTtl(ttlMs);
    const row = this.scopes.get(lease.scopeKey);
    if (
      row === undefined ||
      row.writerEpoch !== lease.epoch ||
      row.writerOwner !== lease.owner ||
      row.leaseExpiresAt <= this.clock.now()
    )
      fail("LEASE_EXPIRED", "writer lease is no longer valid");
    row.leaseExpiresAt = this.clock.now() + ttlMs;
    return this.lease(row);
  }

  async releaseWriter(lease: WriterLease): Promise<void> {
    const row = this.scopes.get(lease.scopeKey);
    if (row === undefined || row.writerEpoch !== lease.epoch || row.writerOwner !== lease.owner) return;
    row.writerOwner = null;
    row.leaseExpiresAt = 0;
  }
  /** 在同一同步临界区确认写者仍拥有当前代，供无写入操作建立确认边界。 */
  async confirmWriter(lease: WriterLease, generation: string): Promise<void> {
    const scope = this.requireLease(lease.scopeKey, lease.epoch, lease.owner);
    if (scope.currentGeneration !== generation) fail("GENERATION_MISMATCH", "writer generation is no longer current");
  }

  async createGeneration(input: CreateGenerationInput): Promise<RegistrationResult> {
    this.requireLease(input.scopeKey, input.epoch);
    const value = stripDerivedMemoryState(input.generation);
    if (value.scopeKey !== input.scopeKey || value.state !== "staging")
      fail("MALFORMED_FRAME", "generation registration must be staging and belong to scope");
    const id = compositeKey(input.scopeKey, value.generation);
    const existing = this.generations.get(id);
    if (existing !== undefined)
      return existing.loadId === value.loadId && existing.state === "staging"
        ? { outcome: "already-committed" }
        : { outcome: "conflict" };
    this.generations.set(id, { ...value, entryRefs: copyRefs(value.entryRefs), retiredAt: null });
    return { outcome: "committed" };
  }

  async createDoc(input: CreateDocInput): Promise<RegistrationResult> {
    this.requireLease(input.scopeKey, input.epoch);
    const doc = stripDerivedMemoryState(input.doc);
    this.assertSnapshotSize(doc.snapshot);
    if (doc.scopeKey !== input.scopeKey) fail("DOC_NOT_FOUND", "document generation is not registered");
    const key = compositeKey(input.scopeKey, doc.docId);
    const existing = this.docs.get(key);
    if (existing !== undefined)
      return existing.hash === doc.hash ? { outcome: "already-committed" } : { outcome: "conflict" };
    if (this.findDoc(doc.docId) !== undefined) return { outcome: "conflict" };
    const generation = this.generations.get(compositeKey(input.scopeKey, doc.generation));
    if (generation === undefined || !["staging", "committed"].includes(generation.state))
      fail("DOC_NOT_FOUND", "document generation is not registered");
    this.registerDocument(key, prepareActiveDocument(doc, this.digest, this.capacity.inputs.dependsOnMax));
    return { outcome: "committed" };
  }

  async registerSuccessor(input: RegisterSuccessorInput): Promise<RegistrationResult> {
    this.requireLease(input.scopeKey, input.epoch);
    const key = compositeKey(input.scopeKey, input.predecessorDocId);
    const predecessor = this.docs.get(key);
    if (predecessor === undefined || predecessor.scopeKey !== input.scopeKey)
      fail("DOC_NOT_FOUND", "predecessor document is unknown");
    if (predecessor.lastSeq !== input.expectedLastSeq)
      fail("SEQUENCE_GAP", "successor route expected frontier is stale");
    const existing = this.successors.get(key);
    if (
      existing &&
      (existing.successorDocId !== input.successorDocId || existing.expectedLastSeq !== input.expectedLastSeq)
    )
      return { outcome: "conflict" };
    let successor: StoredDoc | undefined;
    if (input.successorDoc) {
      this.assertWritableDoc(input.scopeKey, input.predecessorDocId);
      const doc = input.successorDoc;
      if (
        doc.scopeKey !== input.scopeKey ||
        doc.docId !== input.successorDocId ||
        doc.docId === predecessor.docId ||
        doc.generation !== predecessor.generation ||
        doc.kind !== predecessor.kind
      )
        fail("GENERATION_MISMATCH", "successor identity differs from predecessor");
      successor = prepareActiveDocument(doc, this.digest, this.capacity.inputs.dependsOnMax);
      const target = this.docs.get(compositeKey(input.scopeKey, input.successorDocId));
      if (target) {
        if (!sameSuccessorBase(target, successor, existing !== undefined)) return { outcome: "conflict" };
        successor = undefined;
      } else if (this.findDoc(input.successorDocId)) return { outcome: "conflict" };
    }
    if (existing) {
      // 纯路由可先提交；带初始文档的重放只有在目标与空 ledger 都落地后才算完成。
      if (successor) this.registerDocument(compositeKey(input.scopeKey, successor.docId), successor);
      return { outcome: "already-committed" };
    }
    this.registerDocumentRoute(input, predecessor, successor);
    return { outcome: "committed" };
  }

  /** 仅返回已由 canonical 与完整 live-text 索引证明的块，未知恢复状态按需重建。 */
  async readLiveTextCoverage(query: LiveTextCoverageQuery): Promise<ReadonlySet<string>> {
    return readMemoryTextCoverage(query, this.contentBatchState(), this.digest);
  }

  async appendUpdates(input: AppendUpdatesInput): Promise<AppendUpdatesResult> {
    const { scopeKey, epoch, owner } = input;
    this.requireLease(scopeKey, epoch, owner);
    return appendMemoryUpdates(input, this.contentBatchState(), {
      capacity: this.capacity,
      assertLease: () => {
        this.requireLease(scopeKey, epoch, owner);
      },
      assertWritableDoc: (key, docId) => this.assertWritableDoc(key, docId),
    });
  }
  /** 正文与必要的封口、后继和目录共用一个提交点。 */
  async commitContentBatch(input: CommitContentBatchInput): Promise<AppendUpdatesResult> {
    return commitMemoryContentBatch(input, this.contentBatchState(), {
      clock: this.clock,
      digest: this.digest,
      capacity: this.capacity,
    });
  }
  async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    this.requireLease(input.scopeKey, input.epoch);
    const doc = stripDerivedMemoryState(input.doc);
    this.assertSnapshotSize(doc.snapshot);
    if (doc.scopeKey !== input.scopeKey || doc.state !== "sealed" || this.digest(doc.snapshot) !== doc.hash)
      fail("MALFORMED_FRAME", "sealed document is invalid");
    const key = compositeKey(input.scopeKey, doc.docId);
    const existing = this.docs.get(key);
    if (existing !== undefined)
      return existing.hash === doc.hash
        ? { outcome: "already-committed", hash: existing.hash }
        : { outcome: "conflict", hash: existing.hash };
    if (this.findDoc(doc.docId) !== undefined) return { outcome: "conflict", hash: doc.hash };
    const generation = this.generations.get(compositeKey(input.scopeKey, doc.generation));
    if (generation === undefined || !["staging", "committed"].includes(generation.state))
      fail("DOC_NOT_FOUND", "document generation is not registered");
    if (generation.state === "committed" && this.scopes.get(input.scopeKey)?.currentGeneration !== doc.generation)
      fail("GENERATION_NOT_CURRENT", "document generation is not current");
    const snapshot = copyBytes(doc.snapshot);
    this.registerDocument(key, {
      ...doc,
      lastSeq: doc.finalSeq ?? doc.baseSeq,
      baseSnapshot: snapshot,
      baseHash: doc.hash,
      snapshot,
      dependsOn: [...doc.dependsOn],
      sealedAt: this.clock.now(),
      retiredAt: null,
    });
    return { outcome: "committed", hash: doc.hash };
  }

  async sealDoc(input: SealDocInput): Promise<SealDocResult> {
    this.assertSnapshotSize(input.finalSnapshot);
    const scope = this.requireLease(input.scopeKey, input.epoch);
    const doc = this.docs.get(compositeKey(input.scopeKey, input.docId));
    if (doc === undefined || doc.scopeKey !== input.scopeKey) fail("DOC_NOT_FOUND", "document is unknown");
    if (doc.state === "sealed")
      return doc.hash === input.finalHash
        ? { outcome: "already-committed", finalSeq: doc.finalSeq! }
        : { outcome: "conflict", finalSeq: doc.finalSeq! };
    this.assertWritableDoc(input.scopeKey, input.docId);
    // `sealing` 是路由登记留下的中间态（`registerSuccessor`）：第 4 步正是把该状态推到 `sealed`。
    if (doc.state !== "active" && doc.state !== "sealing") fail("RESOURCE_RETIRED", "document cannot be sealed");
    const route = this.successors.get(compositeKey(input.scopeKey, input.docId));
    if (route === undefined) fail("MALFORMED_FRAME", "successor not registered");
    if (
      route.successorDocId !== input.successorDocId ||
      route.expectedLastSeq !== input.expectedLastSeq ||
      doc.lastSeq !== input.expectedLastSeq
    )
      fail("SEQUENCE_GAP", "successor route does not match seal frontier");
    if (this.digest(input.finalSnapshot) !== input.finalHash)
      fail("DIGEST_CONFLICT", "final snapshot digest does not match");
    if (
      input.manifestChange.pointerRevision !== undefined &&
      input.manifestChange.pointerRevision <= scope.pointerRevision
    )
      fail("POINTER_REVISION_STALE", "manifest pointer revision is not newer");
    this.publishSealedDocument(
      {
        ...doc,
        state: "sealed",
        finalSeq: input.expectedLastSeq,
        snapshot: copyBytes(input.finalSnapshot),
        hash: input.finalHash,
        sealedAt: this.clock.now(),
      },
      {
        ...scope,
        pointerRevision: input.manifestChange.pointerRevision ?? scope.pointerRevision + 1,
      },
    );
    return { outcome: "committed", finalSeq: input.expectedLastSeq };
  }

  async commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
    const scope = this.requireLease(input.scopeKey, input.epoch);
    const commitKey = compositeKey(input.scopeKey, input.newGeneration.generation);
    const prior = this.commits.get(commitKey);
    if (
      prior !== undefined &&
      scope.currentGeneration === input.newGeneration.generation &&
      this.sameCommit(prior, input)
    )
      return {
        outcome: "already-committed",
        currentGeneration: scope.currentGeneration,
        pointerRevision: scope.pointerRevision,
      };
    const generation = this.generations.get(commitKey);
    if (
      generation === undefined ||
      generation.state !== "staging" ||
      input.newGeneration.state !== "staging" ||
      input.newGeneration.scopeKey !== input.scopeKey ||
      !sameRefs(input.newGeneration.entryRefs, input.entryClosure)
    )
      fail("GENERATION_MISMATCH", "staging generation is not registered or closure differs");
    if (scope.currentGeneration !== input.expectedCurrent || scope.pointerRevision !== input.expectedPointerRevision)
      return {
        outcome: "conflict",
        currentGeneration: scope.currentGeneration ?? "",
        pointerRevision: scope.pointerRevision,
      };
    for (const retired of input.retired) {
      const old = this.generations.get(compositeKey(input.scopeKey, retired));
      if (old === undefined || retired === input.newGeneration.generation)
        fail("GENERATION_MISMATCH", "retired generation is unknown");
    }
    const pointerRevision = scope.pointerRevision + 1;
    this.publishGeneration(
      input,
      {
        ...scope,
        currentGeneration: input.newGeneration.generation,
        pointerRevision,
      },
      this.clock.now(),
    );
    return {
      outcome: "committed",
      currentGeneration: input.newGeneration.generation,
      pointerRevision,
    };
  }

  async readScopePointer(scopeKey: string): Promise<SyncScopeRow | null> {
    const row = this.scopes.get(scopeKey);
    return row === undefined ? null : { ...row };
  }
  async readGeneration(scopeKey: string, generation: string): Promise<SyncGenerationRecord | null> {
    const value = this.generations.get(compositeKey(scopeKey, generation));
    return value === undefined ? null : copyGeneration(value);
  }

  async retireAndCollect(scopeKey: string, target: RetireTarget): Promise<RetireResult> {
    const targetKey =
      target.kind === "generation" ? compositeKey(scopeKey, target.generation) : compositeKey(scopeKey, target.docId);
    if (this.retireTombstones.has(targetKey))
      return { outcome: "already-committed", retiredDocIds: [], deletedDocIds: [] };
    const scope = this.scopes.get(scopeKey);
    if (scope === undefined) return { outcome: "conflict", retiredDocIds: [], deletedDocIds: [] };
    const now = this.clock.now();
    if (target.kind === "generation") {
      const generation = this.generations.get(targetKey);
      if (generation === undefined || scope.currentGeneration === target.generation)
        return { outcome: "conflict", retiredDocIds: [], deletedDocIds: [] };
      if (generation.state !== "retired") {
        generation.state = "retired";
        generation.retiredAt = now;
      }
      if (generation.retiredAt === null || now - generation.retiredAt < this.lifecycle.retireGraceMs)
        return { outcome: "conflict", retiredDocIds: [], deletedDocIds: [] };
      const ids = [...this.docs.values()]
        .filter((doc) => doc.scopeKey === scopeKey && doc.generation === target.generation)
        .map((doc) => doc.docId);
      for (const docId of ids) this.deleteDoc(scopeKey, docId);
      this.generations.delete(targetKey);
      this.retireTombstones.add(targetKey);
      return { outcome: "committed", retiredDocIds: ids, deletedDocIds: ids };
    }
    const doc = this.docs.get(compositeKey(scopeKey, target.docId));
    if (doc === undefined || doc.scopeKey !== scopeKey)
      return { outcome: "conflict", retiredDocIds: [], deletedDocIds: [] };
    const generation = this.generations.get(compositeKey(scopeKey, doc.generation));
    if (
      generation?.generation === scope.currentGeneration ||
      (doc.sealedAt !== null && now - doc.sealedAt < this.lifecycle.sealGraceMs) ||
      (generation !== undefined &&
        generation.retiredAt !== null &&
        now - generation.retiredAt < this.lifecycle.retireGraceMs)
    )
      return { outcome: "conflict", retiredDocIds: [], deletedDocIds: [] };
    this.deleteDoc(scopeKey, doc.docId);
    this.retireTombstones.add(targetKey);
    return { outcome: "committed", retiredDocIds: [target.docId], deletedDocIds: [target.docId] };
  }

  private lease(row: SyncScopeRow): WriterLease {
    return { scopeKey: row.scopeKey, epoch: row.writerEpoch, owner: row.writerOwner!, expiresAt: row.leaseExpiresAt };
  }
  private assertTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail("MALFORMED_FRAME", "lease ttl must be positive");
  }
  private requireLease(scopeKey: string, epoch: number, owner?: string): SyncScopeRow {
    const row = this.scopes.get(scopeKey);
    if (row === undefined || row.writerEpoch !== epoch) fail("WRITER_EPOCH_LOST", "writer epoch is fenced");
    if (row.leaseExpiresAt <= this.clock.now()) fail("LEASE_EXPIRED", "writer lease has expired");
    if (owner !== undefined && row.writerOwner !== owner) fail("WRITER_EPOCH_LOST", "writer owner is fenced");
    return row;
  }
  private assertWritableDoc(scopeKey: string, docId: string): StoredDoc {
    const doc = this.docs.get(compositeKey(scopeKey, docId));
    if (doc === undefined || doc.scopeKey !== scopeKey) fail("DOC_NOT_FOUND", "document is unknown");
    const generation = this.generations.get(compositeKey(scopeKey, doc.generation));
    if (generation === undefined || generation.state === "retired" || generation.state === "failed")
      fail("RESOURCE_RETIRED", "document generation is not writable");
    if (generation.state === "committed" && this.scopes.get(scopeKey)?.currentGeneration !== generation.generation)
      fail("GENERATION_NOT_CURRENT", "document generation is not current");
    return doc;
  }
  private sameCommit(left: CommitRecord, input: CommitGenerationInput): boolean {
    return (
      left.expectedCurrent === input.expectedCurrent &&
      left.expectedPointerRevision === input.expectedPointerRevision &&
      sameRefs(left.entryClosure, input.entryClosure) &&
      left.retired.length === input.retired.length &&
      left.retired.every((value, index) => value === input.retired[index])
    );
  }
}
