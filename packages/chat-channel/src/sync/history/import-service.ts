// packages/chat-channel/src/sync/history/import-service.ts
// C2 历史导入编排（规格 §5.7）：接收边界、有限构建、已提交目录校验与原子换代。
//
// 导入尝试是一次性的：失败后必须释放本次 load 的资源，重试由调用方重新调用 begin，取得新的
// loadId/generation，避免把带洞的暂存流继续追加到旧目录。存储只通过 ProjectionStore 的已提交
// 读取出口回答完整性；本服务不缓存「可能已经提交」的事实。

import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn, RandomSource } from "../clock";
import { asSyncProtocolError, type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { createGenerationId, createLoadId, type SyncScope, scopeKey } from "../protocol/identity";
import type {
  CommitGenerationResult,
  CommitOutcome,
  GenerationEntryRefs,
  ProjectionStore,
  SyncGenerationRecord,
  WriterLease,
} from "../store/types";
import {
  type BlockRecordInput,
  type BuildContentBlockInput,
  type BuiltBlock,
  buildContentBlock,
} from "./block-builder";
import type { BlockBuildPool } from "./build-pool";
import { HistoryCommitter } from "./committer";
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

  constructor(deps: ImportDependencies) {
    this.store = deps.store;
    this.spool = deps.spool;
    this.pool = deps.pool;
    this.clock = deps.clock;
    this.digest = deps.digest;
    this.capacity = deps.capacity;
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
      admission: undefined,
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
          entryRefs: this.initialEntryClosure(generation),
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
    this.attempt = {
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
    return { loadId, generation };
  }

  /** 接收一条对象并保留构建所需的轻量元数据；接收窗口由 HistoryIngest 负责冻结。 */
  async accept(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    const attempt = this.requireAttempt();
    if (attempt.state !== "receiving") {
      throw this.incomplete("receiving boundary is frozen");
    }
    try {
      const record = await attempt.ingest.accept(value, meta);
      attempt.records.push(record);
      attempt.metadata.push(meta);
      attempt.receivedOrdinal = record.sourceOrdinal;
      return record;
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  /** 先同步冻结接收状态，再等待暂存器封口；冻结后任何新对象都被拒绝。 */
  async receivingComplete(): Promise<void> {
    const attempt = this.requireAttempt();
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
      await this.fail(error);
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
      const blocks = this.makeBlockInputs(attempt);
      const pending = blocks.map((records, index) => this.submitBlock(attempt, committer, records, index));
      await Promise.all(pending);
      await this.pool.drain();
      const directory = await committer.listDirectory(this.capacity.inputs.directoryMaxRefs);
      attempt.committedBlocks = directory.blocks.length;
      // 缺口由存储按已提交块之间的断裂给出；此处不再过滤「首块之前」的虚报缺口——那属于存储侧
      // 的目录语义（见 memory-store-state.ts 的 readDirectory）。
      attempt.gaps = directory.gaps;
      this.assertComplete(attempt, directory.blocks, attempt.gaps.length === 0);
      attempt.state = "importComplete";
    } catch (error) {
      await this.fail(error);
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
      await this.fail(error);
      throw error;
    }
    try {
      const pointer = await this.store.readScopePointer(attempt.scopeKey);
      const expectedCurrent = pointer?.currentGeneration ?? null;
      const expectedPointerRevision = pointer?.pointerRevision ?? 0;
      const entryClosure = await this.buildEntryClosure(attempt);
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
      const finalResult = {
        outcome: result.outcome,
        generation: result.currentGeneration,
        pointerRevision: result.pointerRevision,
      };
      attempt.finalResult = finalResult;
      await this.cleanup(attempt);
      return finalResult;
    } catch (error) {
      await this.fail(error);
      throw error;
    }
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

  private incomplete(message: string): SyncProtocolError {
    const attempt = this.attempt;
    return new SyncProtocolError("IMPORT_INCOMPLETE", {
      message,
      safeContext: attempt === null ? {} : { scope: attempt.scopeKey, generation: attempt.generation },
    });
  }

  private makeBlockInputs(attempt: ImportAttempt): BlockRecordInput[][] {
    const result: BlockRecordInput[][] = [];
    const target = this.capacity.inputs.historyBlockTargetPayloadBytes;
    let current: BlockRecordInput[] = [];
    let currentBytes = 0;
    for (let index = 0; index < attempt.records.length; index += 1) {
      const record = attempt.records[index];
      const meta = attempt.metadata[index];
      const payload = new Uint8Array(0);
      const item: BlockRecordInput = {
        sourceOrdinal: record.sourceOrdinal,
        kind: record.kind,
        payload,
        entryId: meta.entryId ?? `ordinal-${record.sourceOrdinal}`,
        entryOrder: record.sourceOrdinal,
        contentSlot: meta.contentSlot ?? 0,
        partIndex: meta.partIndex ?? 0,
      };
      // 构建前的尺寸只是软分块提示；真正的 payload 在 build task 中从 spool 读取并替换。
      const estimated = record.payloadBytes;
      if (current.length > 0 && currentBytes + estimated > target) {
        result.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += estimated;
    }
    if (current.length > 0) {
      result.push(current);
    }
    return result;
  }

  private submitBlock(
    attempt: ImportAttempt,
    committer: HistoryCommitter,
    records: BlockRecordInput[],
    blockIndex: number,
  ): Promise<void> {
    const estimateBytes = Math.max(
      1,
      records.reduce((sum, record) => sum + record.payload.byteLength, 0),
    );
    return this.pool.submit({
      estimateBytes,
      run: async (): Promise<void> => {
        const materialized: BlockRecordInput[] = [];
        for (const record of records) {
          const payload = await attempt.ingest.readRecord(record.sourceOrdinal);
          materialized.push({ ...record, payload });
        }
        const block = this.buildBlock({
          generation: attempt.generation,
          blockIndex,
          records: materialized,
          targetPayloadBytes: this.capacity.inputs.historyBlockTargetPayloadBytes,
          hardLimitBytes: this.capacity.inputs.historyBlockHardBytes,
          rand: this.rand,
          digest: this.digest,
        });
        const result = await committer.commitBlock(block);
        if (result.outcome === "committed" || result.outcome === "already-committed") {
          attempt.committedBlocks += 1;
        }
      },
    });
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

  private async buildEntryClosure(attempt: ImportAttempt): Promise<GenerationEntryRefs> {
    const directory = await this.store.readDirectory({
      generation: attempt.generation,
      limit: this.capacity.inputs.directoryMaxRefs,
    });
    return {
      controlDocId: `sync/control/${attempt.generation}/0/control`,
      directoryDocId: `sync/directory/${attempt.generation}/0/directory`,
      runtimeDocId: `sync/runtime/${attempt.generation}/0/runtime`,
      contentDocIds: directory.entries.filter((entry) => entry.sealed).map((entry) => entry.docId),
    };
  }

  private initialEntryClosure(generation: string): GenerationEntryRefs {
    return {
      controlDocId: `sync/control/${generation}/0/control`,
      directoryDocId: `sync/directory/${generation}/0/directory`,
      runtimeDocId: `sync/runtime/${generation}/0/runtime`,
      contentDocIds: [],
    };
  }

  private async fail(error: unknown): Promise<void> {
    const attempt = this.attempt;
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
