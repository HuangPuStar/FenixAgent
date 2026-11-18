import * as Y from "yjs";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { buildDocId, type DocKind, parseDocId, scopeKey } from "../protocol/identity";
import type { CommitOutcome, SyncRefRecord, WriterLease } from "../store/types";
import { BoundaryIndex, boundaryPayload, seedBoundaryIndexFromDocs } from "./boundary-index";
import { captureSlice } from "./change-capture";
import { appendCommittedBatch, loadCommittedDoc, openLiveCursor } from "./committed-doc";
import { ensureWritableContentDoc } from "./content-tail";
import { createDirectoryAppender, type DirectoryAppender } from "./directory-appender";
import { type ContentObjectRef, writeLiveContentObject } from "./live-content-object";
import { recoverLiveSuccessors } from "./live-successor";
import {
  type Batch,
  CONTENT_KIND,
  type Cursor,
  fail,
  type Identity,
  malformed,
  NOOP,
  overflowOfSlices,
  RUNTIME_KIND,
  type Slice,
} from "./live-writer-internal";
import { buildLiveRecord, buildNextLiveRecord, descriptorOf, entityOf } from "./live-writer-records";
import {
  LIVE_WRITER_LEASE_TTL_MS,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
  type LiveWriterOptions,
  type PendingBatch,
} from "./live-writer-types";
import { createMergeBuffer, type MergeBuffer, type MergeFlushRequest, type MergeKey } from "./merge-buffer";
import { createRotationController, type RotationController } from "./rotation";
import { buildRuntimeSuccessorState, createRuntimeDoc, type FinalEntityDescriptor } from "./runtime-doc";
import { restoreRuntimeSuccessor } from "./runtime-recovery";
import { createSealingMachine, type SealingMachine, type SealResult } from "./sealing";
import { createTextClaim, type TextClaim } from "./text-claim";
import { buildPendingBatch, bytes, hex, records, requireObject, requireString, splitLiveText } from "./writer-support";
export class LiveWriterImpl implements LiveWriter {
  private readonly scopeKey: string;
  private readonly owner: string;
  private readonly rotation: RotationController;
  private sealing: SealingMachine;
  private merge: MergeBuffer;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: unknown = null;
  private lastFlush: Promise<void> | null = null;
  private lease: WriterLease | null = null;
  private generation: string | null = null;
  private readonly cursors = new Map<DocKind, Cursor>();
  /** 工具边界 occurrence 索引，轮转沿用，恢复时覆盖当前代次全部可达块。 */
  private readonly boundaryIndex = new BoundaryIndex();
  private boundarySeeded = false;
  private readonly directory: DirectoryAppender;
  private readonly textClaim: TextClaim;
  /** 当前代次的入口闭包（历史导入块）；为空表示没有可对照的历史。 */
  private historyContentDocIds: readonly string[] = [];
  private closed = false;
  constructor(private readonly options: LiveWriterOptions) {
    const { store, digest, random } = options;
    this.scopeKey = scopeKey(options.scope);
    this.owner = `live_${hex(random, 8)}`;
    this.rotation = createRotationController(options.rotation);
    this.sealing = createSealingMachine(options);
    this.directory = createDirectoryAppender({ store, scopeKey: this.scopeKey, digest, random });
    this.textClaim = createTextClaim(store);
    this.merge = this.newMerge();
  }
  async acquire(): Promise<void> {
    this.assertLive(false);
    // 租约被占或已过期时存储直接拒绝（SCOPE_BUSY）；本层不排队等待，等待会让「谁在写」不可判定。
    this.lease = await this.options.store.acquireWriter(this.scopeKey, this.owner, LIVE_WRITER_LEASE_TTL_MS);
    await this.rebuildFromCommitted();
  }
  async renew(): Promise<void> {
    this.assertLive(true);
    try {
      this.lease = await this.options.store.renewWriter(this.requireLease(), LIVE_WRITER_LEASE_TTL_MS);
    } catch (error) {
      // 空闲过期是常规状态迁移：保留错误给调用方观测，但不能把它记成永久停写原因。
      this.lease = null;
      throw error;
    }
  }
  async accept(input: LiveInput): Promise<void> {
    this.assertLive(true);
    if (input.kind === "content-object") {
      const object = input.object;
      if (!object) malformed("content-object input requires an object");
      return await this.run(() =>
        writeLiveContentObject({
          object,
          capacity: this.options.capacity,
          digest: this.options.digest,
          admission: this.options.admission,
          store: this.options.store,
          scopeKey: this.scopeKey,
          generation: this.requireGeneration(),
          confirmOwnership: (generation) => this.confirmOwnership(generation),
          append: (record, ref) =>
            this.appendContentRecord(
              () => ({ ...record, recordId: record.recordId ?? `rec_${hex(this.options.random, 8)}` }),
              ref,
            ),
        }),
      );
    }
    const { turnId, entryId, contentSlot, contentType } = input;
    if (input.kind !== "text-delta") {
      const semantic = input.semantic;
      if (semantic === undefined) malformed("semantic input requires a semantic payload");
      return await this.run(() => this.writeSemantic(semantic, entryId));
    }
    const delta = input.delta;
    if (delta === undefined) malformed("text-delta input requires a delta");
    if (
      input.idempotent === true &&
      !(await this.textClaim.claim({
        entryId,
        contentSlot,
        activeDoc: this.cursor(CONTENT_KIND).doc,
        historyDocIds: this.historyContentDocIds,
      }))
    )
      return;
    const key: MergeKey = { generation: this.requireGeneration(), turnId, entryId, contentSlot, contentType };
    this.lastFlush = null;
    this.merge.push(key, delta);
    if (this.lastFlush !== null) await this.lastFlush;
  }
  async commit(pending: PendingBatch): Promise<CommitOutcome> {
    this.assertLive(true);
    return await this.enqueue(async () => {
      if (pending.ordinalEnd !== pending.ordinalStart) malformed("a slice carries exactly one update");
      if (this.options.digest(pending.payload) !== pending.digest) fail("DIGEST_CONFLICT", "batch digest mismatch");
      const cursor = this.cursorOf(pending.docId);
      if (pending.ordinalStart !== cursor.lastSeq + 1) fail("SEQUENCE_GAP", "batch is not adjacent to the frontier");
      // 对生成该字节的 Doc 重复应用是幂等的：同一批重放不会产生第二份 struct。
      Y.applyUpdate(cursor.doc, pending.payload);
      const slice: Slice = { docId: cursor.docId, fromSeq: pending.ordinalStart, bytes: pending.payload };
      const batch: Batch = { batchId: pending.batchId, digest: pending.digest, slices: [slice] };
      return await this.executeBatch(batch, new Map([[cursor.docId, cursor]]));
    });
  }
  async seal(): Promise<SealResult> {
    return await this.run(() => this.sealActive(CONTENT_KIND));
  }
  async rotateRuntime(): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    return await this.run(() => this.rotateRuntimeDoc());
  }
  async recover(): Promise<void> {
    this.assertLive(true);
    await this.enqueue(() => this.rebuildFromCommitted());
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.merge.dispose();
    const lease = this.lease;
    this.lease = null;
    // 主动让出写权：共享 store 下重连/换标签页必须在旧连接关闭后立即接管，而不是等租约 TTL。
    if (lease !== null) await this.options.store.releaseWriter?.(lease);
  }
  /** 带屏障的公共动作：复核写者仍活着 → 冲刷已接收文本并等它落地（设计 §6.1「之前已接收的文本先完成写入」）→ 排队执行。 */
  private async run<T>(task: () => Promise<T>): Promise<T> {
    this.assertLive(true);
    this.lastFlush = null;
    this.merge.barrier();
    if (this.lastFlush !== null) await this.lastFlush;
    return await this.enqueue(task);
  }
  private newMerge(): MergeBuffer {
    const { clock, merge } = this.options;
    return createMergeBuffer({ clock, ...merge, onFlush: (request) => this.scheduleText(request) });
  }
  /** 冲刷是同步回调、落库是异步的：异常记为停写原因——定时器触发的冲刷没有调用方接住，静默吞掉会让内容无声丢失。 */
  private scheduleText(request: MergeFlushRequest): void {
    const task = this.enqueue(() => this.writeText(request)).catch((error: unknown) => {
      this.failure = error;
      throw error;
    });
    this.lastFlush = task;
    void task.catch(NOOP);
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => (this.failure === null ? task() : Promise.reject(this.failure)));
    this.queue = run.then(NOOP, NOOP);
    return run;
  }
  /** 输入按目录块序和块内记录序提交；每片固定批次重试，已提交前缀不重放，未知结果仍走 fencing 失败出口。 */
  private async writeText(request: MergeFlushRequest): Promise<void> {
    for (const text of splitLiveText(request.text, this.options.capacity)) {
      await this.appendContentRecord((cursor) =>
        buildNextLiveRecord(this.options.random, cursor.doc, request.key, "text", bytes(text)),
      );
    }
  }
  private async appendContentRecord(build: (cursor: Cursor) => LiveRecordValue, ref?: ContentObjectRef): Promise<void> {
    for (;;) {
      const cursor = this.cursor(CONTENT_KIND);
      const record = build(cursor);
      const slices: Slice[] = [];
      const hadRecords = (records(cursor.doc)?.length ?? 0) > 0;
      captureSlice(slices, cursor, () => records(cursor.doc, [record]));
      const overflow = this.overflowOf(slices, record.payload.byteLength);
      if (overflow === null) {
        await this.persist(slices, ref ? [{ ...ref, docId: cursor.docId, recordId: record.recordId }] : undefined);
        return;
      }
      // 未提交的试写必须撤销，之后只把当前片写到 successor，已提交前缀不重放。
      await this.loadCursor(cursor.docId, cursor.kind);
      if (!hadRecords) throw this.stop("CAPACITY_EXCEEDED", `record cannot fit an empty doc: ${overflow}`);
      await this.sealActive(CONTENT_KIND);
    }
  }
  private async writeSemantic(semantic: NonNullable<LiveInput["semantic"]>, entryId: string): Promise<void> {
    const gauge = createRuntimeDoc(RUNTIME_KIND, this.options.limits, this.cursor(RUNTIME_KIND).doc);
    const stats = { encodedBytes: gauge.encodedBytes(), entityCount: gauge.entityCount() };
    if (this.rotation.evaluate(stats).rotate) await this.rotateRuntimeDoc();
    const runtime = this.cursor(RUNTIME_KIND);
    const target = createRuntimeDoc(RUNTIME_KIND, this.options.limits, runtime.doc);
    const slices: Slice[] = [];
    let recordBytes = 0;
    const entityId = requireString(semantic.payload, "entityId");
    const terminalEntity =
      semantic.kind !== "final" && semantic.payload.finalDescriptor === undefined && semantic.payload.terminal === true;
    // 终态可能触发轮转，须先轮转再写 boundary，避免落入已封口 Doc。
    if (terminalEntity) {
      const content = this.cursor(CONTENT_KIND);
      if (Y.encodeStateAsUpdate(content.doc).byteLength >= this.options.limits.softRotateBytes) {
        await this.sealActive(CONTENT_KIND);
      }
    }
    // 终态首帧也必须留下边界；源 occurrence 相同的重放只认第一次。
    if (semantic.kind === "tool" && semantic.payload.boundary === true) {
      if (!this.boundarySeeded) {
        await seedBoundaryIndexFromDocs(
          this.boundaryIndex,
          this.options.store,
          this.requireGeneration(),
          this.historyContentDocIds,
          this.cursor(CONTENT_KIND),
        );
        this.boundarySeeded = true;
      }
      const ordinal = this.boundaryIndex.claim(entryId, entityId, semantic.payload.boundaryOrdinal);
      if (ordinal !== null) {
        const content = this.cursor(CONTENT_KIND);
        const boundaryBytes = boundaryPayload(entityId, ordinal);
        const identity: Identity = { entryId, contentSlot: "boundary", contentType: "tool-boundary" };
        const record = buildLiveRecord(this.options.random, identity, "tool_boundary", boundaryBytes, ordinal);
        captureSlice(slices, content, () => records(content.doc, [record]));
        recordBytes = Math.max(recordBytes, boundaryBytes.byteLength);
      }
    }
    // 终态由描述符决定而不是由 kind 决定：`kind` 只声明实体类别（如 `permission`），缺描述符的 `kind: "final"` 仍按契约报错。
    if (semantic.kind === "final" || semantic.payload.finalDescriptor !== undefined) {
      const identity: Identity = { entryId: entityId, contentSlot: "final", contentType: "final-descriptor" };
      const descriptor = bytes(JSON.stringify(descriptorOf(semantic.payload, entityId)));
      const content = this.cursor(CONTENT_KIND);
      const record = buildNextLiveRecord(this.options.random, content.doc, identity, "final", descriptor);
      captureSlice(slices, content, () => records(content.doc, [record]));
      captureSlice(slices, runtime, () => target.removeEntity(entityId));
      recordBytes = Math.max(recordBytes, descriptor.byteLength);
    } else {
      if (terminalEntity) {
        // 终态描述符和实体移除必须在同一批提交，避免出现不可解析的引用。
        const metadata =
          semantic.payload.metadata === undefined ? {} : requireObject(semantic.payload.metadata, "metadata");
        const terminalContent = bytes(JSON.stringify({ entityId, kind: semantic.kind, metadata }));
        const content = this.cursor(CONTENT_KIND);
        const identity: Identity = {
          entryId: `${entityId}:final`,
          contentSlot: "final",
          contentType: "final-descriptor",
        };
        const record = buildNextLiveRecord(this.options.random, content.doc, identity, "final", terminalContent);
        const descriptor: FinalEntityDescriptor = {
          entityId,
          kind: semantic.kind,
          contentRef: record.recordId,
          digest: this.options.digest(terminalContent),
          byteLength: terminalContent.byteLength,
          completedAt: this.options.clock.now(),
        };
        const descriptorPayload = bytes(JSON.stringify(descriptor));
        const descriptorRecord = buildLiveRecord(
          this.options.random,
          identity,
          "final",
          descriptorPayload,
          record.partIndex + 1,
        );
        captureSlice(slices, content, () => records(content.doc, [record, descriptorRecord]));
        captureSlice(slices, runtime, () => target.removeEntity(entityId));
        recordBytes = Math.max(terminalContent.byteLength, descriptorPayload.byteLength);
      } else {
        const record = entityOf(semantic.kind, semantic.payload);
        captureSlice(slices, runtime, () => target.upsertEntity(record));
      }
    }
    const overflow = this.overflowOf(slices, recordBytes);
    if (overflow !== null) throw this.stop("CAPACITY_EXCEEDED", `semantic event exceeds the hard limit: ${overflow}`);
    await this.persist(slices);
    this.rotation.onTransaction(slices.reduce((sum, slice) => sum + slice.bytes.byteLength, 0));
  }
  private async sealActive(kind: DocKind, initialState?: Uint8Array): Promise<SealResult> {
    try {
      const current = this.cursor(kind);
      const blockIndex = parseDocId(current.docId).blockIndex + (kind === CONTENT_KIND ? 1 : 0);
      const nonce = hex(this.options.random, 8);
      const successorDocId = buildDocId({ kind, generation: this.requireGeneration(), blockIndex, nonce });
      const successorInitialState = initialState ?? Y.encodeStateAsUpdate(new Y.Doc());
      const result = await this.sealing.seal({
        scope: this.options.scope,
        oldDocId: current.docId,
        lease: this.requireLease(),
        finalUpdateSeq: current.lastSeq,
        successorDocId,
        successorInitialState,
      });
      this.cursors.set(kind, openLiveCursor(successorDocId, kind, successorInitialState));
      // 内容轮换后新块必须立刻出现在目录里，否则客户端永远发现不了轮换后的 live 内容。
      if (kind === CONTENT_KIND) await this.directory.appendContentDoc(this.requireLease(), successorDocId);
      return result;
    } catch (error) {
      // 轮换已可能发布一部分状态；不能把未完成目录交接的 successor 当作可写入口。
      this.failure = error;
      throw error;
    }
  }
  /** 运行态轮换（设计 §6.3）：先取出未结束与交接未完成的实体，再封口使旧版不可写；`requiredBaseSeq` 是新块自身的基线序号。 */
  private async rotateRuntimeDoc(): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    try {
      const previous = this.cursor(RUNTIME_KIND);
      const initialState = buildRuntimeSuccessorState(previous.doc, this.options.limits);
      await this.sealActive(RUNTIME_KIND, initialState);
      this.rotation.reset();
      return { oldDocId: previous.docId, newDocId: this.cursor(RUNTIME_KIND).docId, requiredBaseSeq: 0 };
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }
  private async persist(slices: readonly Slice[], refs?: SyncRefRecord[]): Promise<void> {
    if (slices.length === 0) return;
    await this.executeBatch(
      buildPendingBatch(slices, this.options.random, this.options.digest, refs),
      new Map(slices.map((slice) => [slice.docId, this.cursorOf(slice.docId)])),
    );
  }
  /** 拒绝后必须先恢复权威前沿；否则下一批会依赖尚未提交的 Yjs struct。 */
  private async executeBatch(batch: Batch, cursors: ReadonlyMap<string, Cursor>): Promise<CommitOutcome> {
    try {
      return await appendCommittedBatch({
        store: this.options.store,
        scopeKey: this.scopeKey,
        batch,
        cursors,
        renew: () => this.renewLease(),
        stop: (code, message, cause) => this.stop(code, message, cause),
      });
    } catch (error) {
      try {
        for (const cursor of cursors.values()) await this.loadCursor(cursor.docId, cursor.kind);
        this.boundaryIndex.reset();
        this.boundarySeeded = false;
      } catch (reloadError) {
        this.failure = new AggregateError([error, reloadError], "live writer cursor recovery failed");
      }
      throw error;
    }
  }
  /** 续租同时复核 fencing：epoch 被顶替或租约过期时立即停写（在途通知撤不回，只能先停）。 */
  private async renewLease(): Promise<WriterLease> {
    const current = this.requireLease();
    try {
      this.lease = await this.options.store.renewWriter(current, LIVE_WRITER_LEASE_TTL_MS);
      return this.lease;
    } catch (error) {
      if (error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED") this.lease = null;
      else this.failure = error;
      throw error;
    }
  }
  private async confirmOwnership(generation: string): Promise<void> {
    try {
      await this.options.store.confirmWriter(await this.renewLease(), generation);
    } catch (error) {
      if (error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED") this.lease = null;
      throw error;
    }
  }
  private async rebuildFromCommitted(): Promise<void> {
    if (this.sealing.phase === "failed") this.sealing = createSealingMachine(this.options);
    // 恢复时丢弃未提交缓冲和幂等声明，避免失败后同一用户消息被永久拒绝。
    this.merge.dispose();
    this.textClaim.reset();
    this.boundaryIndex.reset();
    this.boundarySeeded = false;
    this.merge = this.newMerge();
    const pointer = await this.options.store.readScopePointer(this.scopeKey);
    const generationId = pointer?.currentGeneration ?? null;
    if (generationId === null) fail("GENERATION_MISMATCH", "scope has no current generation");
    const generation = await this.options.store.readGeneration(this.scopeKey, generationId);
    if (generation === null) fail("GENERATION_MISMATCH", "current generation record is missing");
    if (["retired", "failed"].includes(generation.state)) fail("RESOURCE_RETIRED", generationId);
    this.generation = generation.generation;
    // 只有导入过历史的代次才需要跨块判重；空基线的入口闭包只是一个空活跃块。
    this.historyContentDocIds = (generation.importEndOrdinal ?? 0) > 0 ? generation.entryRefs.contentDocIds : [];
    const succession = {
      store: this.options.store,
      scope: this.options.scope,
      lease: this.requireLease(),
      sealing: this.sealing,
      admission: this.options.admission,
    };
    const runtimeDocId = await recoverLiveSuccessors({
      ...succession,
      startDocId: generation.entryRefs.runtimeDocId,
      onSuccessor: (previousId, nextId) =>
        restoreRuntimeSuccessor({
          options: this.options,
          previousId,
          nextId,
          renew: () => this.renewLease(),
          stop: (code, message, cause) => this.stop(code, message, cause),
        }),
    });
    await this.loadCursor(runtimeDocId, RUNTIME_KIND);
    await this.directory.load(this.requireLease(), generation.generation, generation.entryRefs);
    const closureTail = generation.entryRefs.contentDocIds.at(-1);
    if (closureTail === undefined) fail("DOC_NOT_FOUND", "generation has no content block entry");
    // 非空历史块均已封口，恢复后必须使用可写尾块；空基线自身已有 active 块。
    const contentDocId = await ensureWritableContentDoc({
      ...succession,
      directory: this.directory,
      scopeKey: this.scopeKey,
      generation: generation.generation,
      importEndOrdinal: generation.importEndOrdinal ?? 0,
      closureTailDocId: closureTail,
      lease: this.requireLease(),
      digest: this.options.digest,
    });
    await this.loadCursor(contentDocId, CONTENT_KIND);
    this.rotation.reset();
  }
  private async loadCursor(docId: string, kind: DocKind): Promise<void> {
    const loaded = await loadCommittedDoc(this.options.store, docId);
    if (loaded === null) fail("DOC_NOT_FOUND", `document ${docId} has no committed base state`);
    this.cursors.get(kind)?.doc.destroy();
    this.cursors.set(kind, { docId, kind, ...loaded });
  }
  private cursor(kind: DocKind): Cursor {
    return this.cursors.get(kind) ?? fail("DOC_NOT_FOUND", `live writer has no active ${kind} doc`);
  }
  private cursorOf(docId: string): Cursor {
    const found = [...this.cursors.values()].find((entry) => entry.docId === docId);
    return found ?? fail("DOC_NOT_FOUND", `document ${docId} is not a write target of this writer`);
  }
  private requireGeneration(): string {
    return this.generation ?? fail("GENERATION_MISMATCH", "live writer has no resolved generation");
  }
  private requireLease(): WriterLease {
    return this.lease ?? fail("WRITER_EPOCH_LOST", "live writer has not acquired the write lease");
  }
  private overflowOf(slices: readonly Slice[], recordBytes = 0): string | null {
    return overflowOfSlices({
      slices,
      recordBytes,
      capacity: this.options.capacity,
      runtimeHardLimitBytes: this.options.limits.hardLimitBytes,
      cursorOf: (docId) => this.cursorOf(docId),
    });
  }
  private stop(code: SyncErrorCode, message: string, cause?: unknown): SyncProtocolError {
    const error = new SyncProtocolError(code, { message, cause });
    this.failure = error;
    return error;
  }
  private assertLive(needLease: boolean): void {
    if (this.closed) fail("RESOURCE_RETIRED", "live writer is closed");
    if (this.failure !== null) throw this.failure;
    if (needLease && this.lease === null) fail("WRITER_EPOCH_LOST", "live writer has not acquired the write lease");
  }
}
