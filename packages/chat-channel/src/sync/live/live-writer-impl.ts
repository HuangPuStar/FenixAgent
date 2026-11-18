import * as Y from "yjs";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { buildDocId, type DocKind, parseDocId, scopeKey } from "../protocol/identity";
import type { CommitOutcome, SyncRefRecord, WriterLease } from "../store/types";
import { BoundaryIndex, boundaryPayload, seedBoundaryIndexFromDocs } from "./boundary-index";
import { captureSlice } from "./change-capture";
import { appendCommittedBatch, loadCommittedDoc, openLiveCursor } from "./committed-doc";
import { createDirectoryAppender, type DirectoryAppender } from "./directory-appender";
import { type ContentObjectRef, writeLiveContentObject } from "./live-content-object";
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
import { rebuildLiveProjection } from "./live-writer-rebuild";
import {
  buildLiveRecord,
  buildNextLiveRecord,
  buildTerminalRecords,
  descriptorOf,
  entityOf,
} from "./live-writer-records";
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
import { buildRuntimeSuccessorState, createRuntimeDoc } from "./runtime-doc";
import { createSealingMachine, type SealingMachine, type SealResult } from "./sealing";
import { writeAtomicText } from "./text-batch-commit";
import { createTextClaim, type TextClaim } from "./text-claim";
import { retainWriterFailure } from "./writer-failure";
import { buildPendingBatch, bytes, hex, records, requireObject, requireString } from "./writer-support";
export class LiveWriterImpl implements LiveWriter {
  private readonly scopeKey: string;
  private readonly owner: string;
  private readonly rotation: RotationController;
  private sealing: SealingMachine;
  private merge: MergeBuffer;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: unknown = null;
  /** 只认封口已证明未发布路由的那次错误，外围冲刷仍保留它供写入观测。 */
  private reacquirableFailure: SyncProtocolError | null = null;
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
    // 旧租约排队输入须先按原错结清，清错不能使它们跨租约或跨代次复活。
    if (this.reacquirableFailure !== null) await this.queue;
    this.assertLive(false);
    // 租约被占或已过期时存储直接拒绝（SCOPE_BUSY）；本层不排队等待，等待会让「谁在写」不可判定。
    const lease = await this.options.store.acquireWriter(this.scopeKey, this.owner, LIVE_WRITER_LEASE_TTL_MS);
    if (this.closed) {
      await this.options.store.releaseWriter?.(lease);
      this.assertLive(false);
    }
    this.lease = lease;
    try {
      await this.rebuildFromCommitted();
    } catch (error) {
      if (this.closed)
        throw new SyncProtocolError("RESOURCE_RETIRED", { message: "live writer is closed", cause: error });
      throw error;
    }
    this.assertLive(false);
    if (this.failure === this.reacquirableFailure) this.failure = null;
    this.reacquirableFailure = null;
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
    if (input.idempotent === true) {
      const merge = this.merge;
      const accepted = await this.textClaim.claim({
        entryId,
        contentSlot,
        activeDoc: this.cursor(CONTENT_KIND).doc,
        historyDocIds: this.historyContentDocIds,
      });
      this.assertLive(true);
      if (merge !== this.merge)
        throw new SyncProtocolError("WRITER_EPOCH_LOST", {
          message: "text admission outlived writer rebuild",
          retryable: true,
        });
      if (!accepted) return;
    }
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
  /** 只记录实际执行冲刷的首错；队列门禁的延迟拒绝不得回写已恢复的状态，后台错误仍供后续输入观测。 */
  private scheduleText(request: MergeFlushRequest): void {
    const task = this.enqueue(() =>
      this.writeText(request).catch((error: unknown) => {
        this.failure ??= error;
        throw error;
      }),
    );
    this.lastFlush = task;
    void task.catch(NOOP);
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => (this.failure === null ? task() : Promise.reject(this.failure)));
    this.queue = run.then(NOOP, NOOP);
    return run;
  }
  /** 同一次合并冲刷的正文、跨块封口和目录在一个提交点生效，失败不留下前缀。 */
  private async writeText(request: MergeFlushRequest): Promise<void> {
    try {
      const cursor = await writeAtomicText({
        options: this.options,
        scopeKey: this.scopeKey,
        generation: this.requireGeneration(),
        request,
        cursor: this.cursor(CONTENT_KIND),
        directory: this.directory,
        renew: () => this.renewLease(),
        stop: (code, message, cause) => this.stop(code, message, cause),
      });
      this.cursors.get(CONTENT_KIND)?.doc.destroy();
      this.cursors.set(CONTENT_KIND, cursor);
    } catch (error) {
      if (error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED") {
        this.failure = error;
        this.reacquirableFailure = error;
        this.lease = null;
      }
      throw error;
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
        const content = this.cursor(CONTENT_KIND);
        const terminalRecords = buildTerminalRecords({
          random: this.options.random,
          digest: this.options.digest,
          doc: content.doc,
          entityId,
          kind: semantic.kind,
          metadata,
          completedAt: this.options.clock.now(),
        });
        captureSlice(slices, content, () => records(content.doc, terminalRecords));
        captureSlice(slices, runtime, () => target.removeEntity(entityId));
        recordBytes = Math.max(...terminalRecords.map((record) => record.payload.byteLength));
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
      this.failure = error;
      // 只有确认路由未提交的正常过期可重新竞争写权；目录交接失败仍持有 committed 事实。
      if (
        error instanceof SyncProtocolError &&
        error.code === "LEASE_EXPIRED" &&
        this.sealing.routeOutcome === "absent"
      ) {
        this.lease = null;
        this.reacquirableFailure = error;
      }
      throw error;
    }
  }
  /** 运行态轮换（设计 §6.3）：先取出未结束与交接未完成的实体，再封口使旧版不可写；`requiredBaseSeq` 是新块自身的基线序号。 */
  private async rotateRuntimeDoc(): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    const previous = this.cursor(RUNTIME_KIND);
    const initialState = buildRuntimeSuccessorState(previous.doc, this.options.limits);
    await this.sealActive(RUNTIME_KIND, initialState);
    this.rotation.reset();
    return { oldDocId: previous.docId, newDocId: this.cursor(RUNTIME_KIND).docId, requiredBaseSeq: 0 };
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
        this.failure = retainWriterFailure(this.failure ?? error, reloadError);
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
    const projection = await rebuildLiveProjection({
      options: this.options,
      scopeKey: this.scopeKey,
      lease: this.requireLease(),
      sealing: this.sealing,
      directory: this.directory,
      renew: () => this.renewLease(),
      stop: (code, message, cause) => this.stop(code, message, cause),
    });
    if (this.closed) {
      for (const cursor of projection.cursors.values()) cursor.doc.destroy();
      this.assertLive(false);
    }
    this.generation = projection.generation;
    this.historyContentDocIds = projection.historyContentDocIds;
    for (const [kind, cursor] of projection.cursors) {
      this.cursors.get(kind)?.doc.destroy();
      this.cursors.set(kind, cursor);
    }
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
    if (this.failure !== null && (needLease || this.failure !== this.reacquirableFailure)) throw this.failure;
    if (needLease && this.lease === null) fail("WRITER_EPOCH_LOST", "live writer has not acquired the write lease");
  }
}
