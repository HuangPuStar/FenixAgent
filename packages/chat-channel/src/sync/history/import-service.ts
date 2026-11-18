// 历史导入编排：接收、有限构建、目录校验与原子换代。

import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn, RandomSource } from "../clock";
import { directoryRootDocId } from "../protocol/directory";
import { asSyncProtocolError, type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { createGenerationId, createLoadId, type SyncScope, scopeKey } from "../protocol/identity";
import type {
  CommitOutcome,
  GenerationEntryRefs,
  ProjectionStore,
  SyncGenerationRecord,
  WriterLease,
} from "../store/types";
import { type BuildContentBlockInput, type BuiltBlock, buildContentBlock } from "./block-builder";
import { BlockDispatcher, createHistoryBlockInputs } from "./build-dispatch";
import type { BlockBuildPool } from "./build-pool";
import { type CommittedBlockRef, HistoryCommitter } from "./committer";
import { ImportEntryDocuments } from "./import-entry-documents";
import { HistoryImportReceiver, type HistoryInputRecord } from "./import-receiver";
import { HistoryIngest, type HistoryRecordMeta, type IngestedRecord } from "./ingest";
import type { HistorySpool } from "./spool";

/** 导入状态；`importComplete` 只表示完整性验证已通过，原子换代仍由 `finalize` 完成。 */
export type ImportState = "receiving" | "receivingComplete" | "building" | "importComplete" | "failed";

/** 对外状态快照；失败只暴露稳定错误码和可重试判定，不回显正文或路径。 */
export interface ImportStatus {
  state: ImportState;
  generation: string;
  loadId: string;
  receivedOrdinal: number;
  committedBlocks: number;
  gaps: { afterOrdinal: number; beforeOrdinal: number }[];
  failure?: { code: SyncErrorCode; retryable: boolean };
}

/** 构建函数可注入以测试乱序完成和破坏性完整性路径；默认使用 C2 canonical block builder。 */
export type BuildBlockFn = (input: BuildContentBlockInput) => BuiltBlock;

interface ImportAttempt {
  scope: SyncScope;
  scopeKey: string;
  acpSessionId: string;
  owner: string;
  leaseTtlMs: number;
  lease: WriterLease;
  generation: string;
  loadId: string;
  ingest: HistoryIngest;
  receiver: HistoryImportReceiver;
  state: ImportState;
  receivedOrdinal: number;
  records: IngestedRecord[];
  metadata: HistoryRecordMeta[];
  committedBlocks: number;
  gaps: { afterOrdinal: number; beforeOrdinal: number }[];
  failure: SyncProtocolError | null;
  cleaned: boolean;
  finalResult: { outcome: CommitOutcome; generation: string; pointerRevision: number } | null;
}

interface ImportDependencies {
  store: ProjectionStore;
  spool: HistorySpool;
  pool: BlockBuildPool;
  clock: Clock;
  digest: DigestFn;
  capacity: SyncCapacityProfile;
  rand: RandomSource;
  admission?: AdmissionController;
  buildBlock?: BuildBlockFn;
}

/**
 * 历史导入服务：所有资源均由构造参数注入，且一个实例同一时刻只承载一个导入尝试。
 * `admission` 仅用于测试或外层已共享的账目；构建池自身已经持有 historyBuild 额度。
 */
export class HistoryImportService {
  private readonly store: ProjectionStore;
  private readonly spool: HistorySpool;
  private readonly pool: BlockBuildPool;
  private readonly clock: Clock;
  private readonly digest: DigestFn;
  private readonly capacity: SyncCapacityProfile;
  private readonly rand: RandomSource;
  private readonly buildBlock: BuildBlockFn;
  private attempt: ImportAttempt | null = null;
  private readonly admission: AdmissionController | undefined;
  private readonly entryDocuments: ImportEntryDocuments;

  constructor(deps: ImportDependencies) {
    this.store = deps.store;
    this.spool = deps.spool;
    this.pool = deps.pool;
    this.clock = deps.clock;
    this.digest = deps.digest;
    this.capacity = deps.capacity;
    this.admission = deps.admission;
    this.entryDocuments = new ImportEntryDocuments(deps.store, deps.capacity, deps.digest);
    this.rand = deps.rand;
    this.buildBlock = deps.buildBlock ?? buildContentBlock;
  }

  /** 开始新尝试：先取得 writer，再新建 loadId/generation 和独立暂存目录。 */
  async begin(input: {
    scope: SyncScope;
    acpSessionId: string;
    owner: string;
    leaseTtlMs: number;
  }): Promise<{ loadId: string; generation: string }> {
    if (this.attempt !== null && !this.attempt.cleaned) {
      throw new SyncProtocolError("SCOPE_BUSY", { message: "an import attempt is already active" });
    }
    const key = scopeKey(input.scope);
    const lease = await this.store.acquireWriter(key, input.owner, input.leaseTtlMs);
    const generation = createGenerationId(this.rand);
    const loadId = createLoadId(this.rand);
    const ingest = new HistoryIngest({
      spool: this.spool,
      clock: this.clock,
      digest: this.digest,
      capacity: this.capacity,
      admission: this.admission,
    });
    try {
      await ingest.begin({ scopeKey: key, generation, loadId });
      const registration = await this.store.createGeneration({
        scopeKey: key,
        epoch: lease.epoch,
        generation: {
          scopeKey: key,
          generation,
          acpSessionId: input.acpSessionId,
          loadId,
          state: "staging",
          importEndOrdinal: null,
          entryRefs: this.entryDocuments.initialEntryClosure(generation),
          createdAt: this.clock.now(),
        },
      });
      if (registration.outcome === "conflict") {
        throw new SyncProtocolError("GENERATION_MISMATCH", { message: "generation registration conflicts" });
      }
      if (registration.outcome === "unknown") {
        throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
          message: "generation registration outcome is unknown",
        });
      }
    } catch (error) {
      await this.releaseAttemptResources(loadId, lease);
      throw error;
    }
    const attempt: ImportAttempt = {
      receiver: new HistoryImportReceiver({
        ingest,
        capacity: this.capacity,
        admission: this.admission,
        digest: this.digest,
        onAccepted(record, meta) {
          attempt.records.push(record);
          attempt.metadata.push(meta);
          attempt.receivedOrdinal = record.sourceOrdinal;
        },
      }),
      scope: input.scope,
      scopeKey: key,
      acpSessionId: input.acpSessionId,
      owner: input.owner,
      leaseTtlMs: input.leaseTtlMs,
      lease,
      generation,
      loadId,
      ingest,
      state: "receiving",
      receivedOrdinal: 0,
      records: [],
      metadata: [],
      committedBlocks: 0,
      gaps: [],
      failure: null,
      cleaned: false,
      finalResult: null,
    };
    this.attempt = attempt;
    return { loadId, generation };
  }

  /** 接收一条对象并保留构建所需的轻量元数据；超大对象按记录预算拆成多条物理记录。 */
  async accept(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    const attempt = this.requireAttempt();
    if (attempt.state !== "receiving" || attempt.receiver.receivingBatch) {
      throw this.incomplete("receiving boundary is frozen");
    }
    try {
      return await attempt.receiver.accept(value, meta);
    } catch (error) {
      await this.fail(error, attempt);
      throw error;
    }
  }

  /** 顺序消费导入源，在既有构建预算内合并小对象写入。 */
  async acceptRecords(records: Iterable<HistoryInputRecord> | AsyncIterable<HistoryInputRecord>): Promise<void> {
    const attempt = this.requireAttempt();
    if (attempt.state !== "receiving" || attempt.receiver.receivingBatch)
      throw this.incomplete("receiving boundary is frozen");
    try {
      await attempt.receiver.acceptRecords(records);
    } catch (error) {
      await this.fail(error, attempt);
      throw error;
    }
  }

  /** 先同步冻结接收状态，再等待暂存器封口；冻结后任何新对象都被拒绝。 */
  async receivingComplete(): Promise<void> {
    const attempt = this.requireAttempt();
    if (attempt.receiver.receivingBatch) throw this.incomplete("history source is still receiving");
    if (attempt.state === "receivingComplete" || attempt.state === "building" || attempt.state === "importComplete") {
      return;
    }
    if (attempt.state !== "receiving") {
      throw attempt.failure ?? this.incomplete("import is not receiving");
    }
    try {
      attempt.ingest.markReceivingComplete(attempt.receivedOrdinal);
      await attempt.ingest.stagedManifest();
      attempt.state = "receivingComplete";
    } catch (error) {
      await this.fail(error, attempt);
      throw error;
    }
  }

  /** 按 sourceOrdinal 分块，允许池内任务乱序完成，但只按已提交目录判定结果。 */
  async buildAndCommit(): Promise<void> {
    const attempt = this.requireAttempt();
    if (attempt.state === "importComplete") {
      return;
    }
    if (attempt.state !== "receivingComplete") {
      throw attempt.failure ?? this.incomplete("receiving boundary is not complete");
    }
    attempt.state = "building";
    try {
      const committer = new HistoryCommitter({
        store: this.store,
        scopeKey: attempt.scopeKey,
        generation: attempt.generation,
        lease: attempt.lease,
        digest: this.digest,
      });
      const blocks = createHistoryBlockInputs(
        attempt.records,
        attempt.metadata,
        this.capacity.inputs.historyBlockTargetPayloadBytes,
      );
      const dispatcher = this.makeDispatcher(attempt, committer);
      await dispatcher.dispatch(blocks);
      attempt.committedBlocks = dispatcher.committedBlocks();
      await this.pool.drain();
      const pageSize = this.capacity.inputs.directoryMaxRefs;
      const committedRefs: CommittedBlockRef[] = [];
      let afterOrdinal: number | undefined;
      let complete = false;
      for (;;) {
        const page = await committer.listDirectory(pageSize, afterOrdinal);
        committedRefs.push(...page.blocks);
        attempt.gaps = page.gaps;
        complete = page.complete;
        if (page.blocks.length < pageSize) break;
        const last = page.blocks[page.blocks.length - 1];
        if (last.ordinalEnd <= (afterOrdinal ?? -1)) {
          throw new SyncProtocolError("MALFORMED_FRAME", {
            message: "directory cursor did not advance",
            safeContext: { generation: attempt.generation, ordinal: last.ordinalEnd },
          });
        }
        afterOrdinal = last.ordinalEnd;
      }
      attempt.committedBlocks = committedRefs.length;
      this.assertComplete(attempt, committedRefs, complete);
      attempt.state = "importComplete";
    } catch (error) {
      await this.fail(error, attempt);
      throw error;
    }
  }

  /** 原子切换当前代次；同一实例重复调用只返回第一次结果，不重做导入。 */
  async finalize(): Promise<{ outcome: CommitOutcome; generation: string; pointerRevision: number }> {
    const attempt = this.requireAttempt();
    if (attempt.finalResult !== null) {
      return attempt.finalResult;
    }
    if (attempt.state !== "importComplete") {
      const error = attempt.failure ?? this.incomplete("import is not complete");
      await this.fail(error, attempt);
      throw error;
    }
    try {
      const pointer = await this.store.readScopePointer(attempt.scopeKey);
      const expectedCurrent = pointer?.currentGeneration ?? null;
      const expectedPointerRevision = pointer?.pointerRevision ?? 0;
      const contentDocIds = await this.entryDocuments.readCommittedContentDocIds(attempt);
      // 入口闭包必须先可读，再发布引用它们的 MANIFEST。
      attempt.lease = await this.store.renewWriter(attempt.lease, attempt.leaseTtlMs);
      await this.entryDocuments.createEntryDocuments(attempt, contentDocIds);
      const entryClosure: GenerationEntryRefs = {
        controlDocId: this.entryDocuments.controlDocId(attempt.generation),
        directoryDocId: directoryRootDocId(attempt.generation),
        runtimeDocId: this.entryDocuments.runtimeDocId(attempt.generation),
        contentDocIds,
      };
      const record: SyncGenerationRecord = {
        scopeKey: attempt.scopeKey,
        generation: attempt.generation,
        acpSessionId: attempt.acpSessionId,
        loadId: attempt.loadId,
        state: "staging",
        importEndOrdinal: attempt.receivedOrdinal,
        entryRefs: entryClosure,
        createdAt: this.clock.now(),
      };
      const result = await this.store.commitGeneration({
        scopeKey: attempt.scopeKey,
        epoch: attempt.lease.epoch,
        expectedCurrent,
        newGeneration: record,
        retired: expectedCurrent === null ? [] : [expectedCurrent],
        entryClosure,
        expectedPointerRevision,
      });
      // conflict/unknown 都不代表新代次已切换：若照常缓存并 cleanup，调用方会把错误代次当成功复用，
      // 也无法再凭原租约重读指针。交给 catch 走 fail()，让本次导入显式失败。
      if (result.outcome === "conflict") {
        throw new SyncProtocolError("POINTER_REVISION_STALE", {
          message: "generation switch conflicts with current pointer",
        });
      }
      if (result.outcome === "unknown") {
        throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
          message: "generation switch outcome is unknown",
        });
      }
      const finalResult = {
        outcome: result.outcome,
        generation: result.currentGeneration,
        pointerRevision: result.pointerRevision,
      };
      attempt.finalResult = finalResult;
      await this.cleanup(attempt);
      return finalResult;
    } catch (error) {
      await this.fail(error, attempt);
      throw error;
    }
  }

  /** 源迭代等外层失败同样必须释放导入租约与暂存。 */
  async abort(error: unknown, loadId?: string): Promise<void> {
    if (loadId !== undefined && this.attempt?.loadId !== loadId) return;
    await this.fail(error);
  }

  /** 返回独立状态快照；失败状态只保留稳定码与 retryable。 */
  status(): ImportStatus {
    const attempt = this.attempt;
    if (attempt === null) {
      return { state: "failed", generation: "", loadId: "", receivedOrdinal: 0, committedBlocks: 0, gaps: [] };
    }
    const status: ImportStatus = {
      state: attempt.state,
      generation: attempt.generation,
      loadId: attempt.loadId,
      receivedOrdinal: attempt.receivedOrdinal,
      committedBlocks: attempt.committedBlocks,
      gaps: attempt.gaps.map((gap) => ({ ...gap })),
    };
    if (attempt.failure !== null) {
      status.failure = { code: attempt.failure.code, retryable: attempt.failure.retryable };
    }
    return status;
  }

  private requireAttempt(): ImportAttempt {
    if (this.attempt === null) {
      throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "import has not begun" });
    }
    return this.attempt;
  }

  private incomplete(message: string, cause?: unknown): SyncProtocolError {
    const attempt = this.attempt;
    return new SyncProtocolError("IMPORT_INCOMPLETE", {
      message,
      ...(cause === undefined ? {} : { cause }),
      safeContext: attempt === null ? {} : { scope: attempt.scopeKey, generation: attempt.generation },
    });
  }

  /** 装配本组载荷字节与构建入参（块序号与在飞窗口由分派器决定），提交结局折算成已提交块数。 */
  private makeDispatcher(attempt: ImportAttempt, committer: HistoryCommitter): BlockDispatcher {
    return new BlockDispatcher(
      this.pool,
      {
        source: { readRecords: (sourceOrdinals) => attempt.ingest.readRecords(sourceOrdinals) },
        buildBlock: ({ blockIndex, records }) =>
          this.buildBlock({
            generation: attempt.generation,
            blockIndex,
            records: [...records],
            targetPayloadBytes: this.capacity.inputs.historyBlockTargetPayloadBytes,
            hardLimitBytes: this.capacity.inputs.historyBlockHardBytes,
            rand: this.rand,
            digest: this.digest,
          }),
        commitBlock: async (block) => {
          const result = await committer.commitBlock(block);
          return result.outcome;
        },
      },
      { scope: attempt.scopeKey, generation: attempt.generation },
    );
  }

  private assertComplete(
    attempt: ImportAttempt,
    blocks: { ordinalStart: number; ordinalEnd: number; hash: string }[],
    complete: boolean,
  ): void {
    if (!complete || attempt.gaps.length > 0 || blocks.length === 0) {
      throw this.incomplete("committed directory is not continuous");
    }
    let next = 1;
    for (const block of blocks) {
      if (block.ordinalStart !== next || block.ordinalEnd < block.ordinalStart) {
        throw this.incomplete("committed directory does not cover the receiving boundary");
      }
      next = block.ordinalEnd + 1;
      if (this.digest.length === 0 || block.hash.length === 0) {
        throw this.incomplete("committed block digest is missing");
      }
    }
    if (next - 1 !== attempt.receivedOrdinal) {
      throw this.incomplete("committed directory does not reach the receiving boundary");
    }
  }

  private async fail(error: unknown, attempt = this.attempt): Promise<void> {
    if (attempt === null || attempt.cleaned) {
      return;
    }
    const protocolError = asSyncProtocolError(error, "STAGING_FAILED");
    attempt.failure = protocolError;
    attempt.state = "failed";
    await this.cleanup(attempt);
  }

  private async cleanup(attempt: ImportAttempt): Promise<void> {
    if (attempt.cleaned) {
      return;
    }
    attempt.cleaned = true;
    attempt.receiver.abort();
    try {
      await this.spool.completeTask(attempt.loadId);
    } catch {
      await this.spool.failTask(attempt.loadId, "import cleanup failed");
    }
    await this.releaseWriter(attempt.lease);
  }

  private async releaseAttemptResources(loadId: string, lease: WriterLease): Promise<void> {
    try {
      await this.spool.completeTask(loadId);
    } catch {
      await this.spool.failTask(loadId, "begin cleanup failed");
    }
    await this.releaseWriter(lease);
  }

  private async releaseWriter(lease: WriterLease): Promise<void> {
    const store = this.store as ProjectionStore & { releaseWriter?: (lease: WriterLease) => Promise<void> };
    if (store.releaseWriter !== undefined) {
      await store.releaseWriter(lease);
    }
  }
}
