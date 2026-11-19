import * as Y from "yjs";
import { AdmissionController } from "../capacity/admission";
import type { WorkingCredit } from "../capacity/working-credit";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { buildDocId, type DocKind, parseDocId, scopeKey } from "../protocol/identity";
import type { CommitOutcome, SyncRefRecord, WriterLease } from "../store/types";
import { BoundaryIndex, seedBoundaryIndexFromDocs } from "./boundary-index";
import { captureSlice } from "./change-capture";
import { appendCommittedBatch, loadCommittedDoc, openLiveCursor } from "./committed-doc";
import { createDirectoryAppender, type DirectoryAppender } from "./directory-appender";
import { type ContentObjectRef, writeLiveContentObject } from "./live-content-object";
import {
  type Batch,
  CONTENT_KIND,
  type Cursor,
  fail,
  malformed,
  overflowOfSlices,
  RUNTIME_KIND,
  type Slice,
} from "./live-writer-internal";
import { rebuildLiveProjection } from "./live-writer-rebuild";
import { applySemanticWrite, planSemanticWrite } from "./live-writer-semantic";
import type { LiveInput, LiveRecordValue, LiveWriter, LiveWriterOptions, PendingBatch } from "./live-writer-types";
import type { MergeFlushRequest } from "./merge-buffer";
import { createRotationController, type RotationController } from "./rotation";
import { buildRuntimeSuccessorState, createRuntimeDoc } from "./runtime-doc";
import { createSealingMachine, type SealingMachine, type SealResult } from "./sealing";
import { admitText, createTextInputAdmission, type TextAdmissionSnapshot } from "./text-admission";
import { writeAtomicText } from "./text-batch-commit";
import { createTextClaim, type TextClaim } from "./text-claim";
import { WriterAuthority, type WriterAuthorityToken } from "./writer-authority";
import { retainWriterFailure } from "./writer-failure";
import { buildPendingBatch, hex, records, requireString } from "./writer-support";
import type { WriterTextBarrier } from "./writer-text-barrier";
import { createTextWorkQueue } from "./writer-text-working";
/** 串行编排实时正文、语义实体与持久投影的写者生命周期。 */
export class LiveWriterImpl implements LiveWriter {
  private readonly options: LiveWriterOptions & { readonly admission: AdmissionController };
  private readonly scopeKey: string;
  private readonly owner: string;
  private readonly rotation: RotationController;
  private sealing: SealingMachine;
  private failure: unknown = null;
  private closing = false;
  /** 只认封口已证明未发布路由的那次错误，外围冲刷仍保留它供写入观测。 */
  private reacquirableFailure: SyncProtocolError | null = null;
  private readonly textBarrier: WriterTextBarrier;
  private readonly authority: WriterAuthority;
  private readonly cursors = new Map<DocKind, Cursor>();
  /** 工具边界 occurrence 索引，轮转沿用，恢复时覆盖当前代次全部可达块。 */
  private readonly boundaryIndex = new BoundaryIndex();
  private boundarySeeded = false;
  private readonly directory: DirectoryAppender;
  private readonly textClaim: TextClaim;
  private readonly pushText: ReturnType<typeof createTextInputAdmission>;
  /** 当前代次的入口闭包（历史导入块）；为空表示没有可对照的历史。 */
  private historyContentDocIds: readonly string[] = [];
  constructor(options: LiveWriterOptions) {
    this.options = { ...options, admission: options.admission ?? new AdmissionController(options.capacity) };
    const { store, digest, random } = this.options;
    this.scopeKey = scopeKey(options.scope);
    this.owner = `live_${hex(random, 8)}`;
    this.rotation = createRotationController(options.rotation);
    this.sealing = createSealingMachine(this.options);
    this.directory = createDirectoryAppender({ store, scopeKey: this.scopeKey, digest, random });
    this.authority = new WriterAuthority(
      store,
      () => this.failure,
      () => this.textBarrier.pause(),
    );
    this.textClaim = createTextClaim({ store, scopeKey: this.scopeKey, digest, admission: this.options.admission });
    this.textBarrier = createTextWorkQueue({
      options: this.options,
      scopeKey: this.scopeKey,
      directory: this.directory,
      content: () => this.cursor(CONTENT_KIND),
      claim: this.textClaim,
      history: () => this.historyContentDocIds,
      authority: this.authority,
      write: (request, token, credit) => this.writeText(request, token, credit),
      onFailure: (error) => {
        this.failure ??= error;
      },
    });
    this.pushText = createTextInputAdmission(this.textClaim, this.textBarrier);
  }
  /** 等旧队列结清后取得写权并安装已提交投影。 */
  async acquire(): Promise<void> {
    this.assertLive(false);
    await this.authority.rebuild(
      async () => {
        // 所有旧任务先结清；公开 renew 发现过期也不能跳过仍在规划的冲刷。
        await this.authority.drain();
        this.assertLive(false);
        await this.authority.acquire(this.scopeKey, this.owner);
        await this.rebuildFromCommitted();
        if (this.failure === this.reacquirableFailure) this.failure = null;
        this.reacquirableFailure = null;
        await this.textBarrier.flush();
        this.assertLive(false);
      },
      (error) => this.textBarrier.canRetryRebuild(error),
    );
  }
  /** 续租当前已安装投影的真实 fencing token。 */
  async renew(): Promise<void> {
    this.assertLive(true);
    await this.authority.renew();
  }
  /** 按输入种类完成声明、合并或带正文屏障的语义写入。 */
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
          generation: this.authority.generation(),
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
    const identity = { turnId, entryId, contentSlot, contentType };
    if (input.idempotent === true && delta.length > 0) {
      return await admitText({
        claim: this.textClaim,
        authority: this.authority,
        entryId,
        contentSlot,
        snapshot: () => this.textSnapshot(),
        admit: ({ generation }) => this.pushText(identity, delta, generation, true),
        pendingFlush: ({ generation }) => this.textBarrier.pending(generation, entryId, contentSlot),
      });
    }
    await this.pushText(identity, delta, this.authority.generation());
  }
  /** 声明读取面与捕获的投影身份保持一致。 */
  private textSnapshot(): TextAdmissionSnapshot {
    this.assertLive(true);
    return {
      token: this.authority.capture(),
      generation: this.authority.generation(),
      activeDoc: this.cursor(CONTENT_KIND).doc,
      historyDocIds: this.historyContentDocIds,
    };
  }
  /** 校验连续前沿并提交调用方提供的固定更新。 */
  async commit(pending: PendingBatch): Promise<CommitOutcome> {
    this.assertLive(true);
    return await this.authority.enqueue(async () => {
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
  /** 等已接纳正文确认后封口并发布后继内容块。 */
  async seal(): Promise<SealResult> {
    return await this.run(() => this.sealActive(CONTENT_KIND));
  }
  /** 保留未结束实体并轮换运行态文档。 */
  async rotateRuntime(): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    return await this.run(() => this.rotateRuntimeDoc());
  }
  /** 排空旧任务后以相同真实租约重建投影。 */
  async recover(): Promise<void> {
    this.assertLive(true);
    await this.authority.rebuild(
      async () => {
        await this.authority.drain();
        this.authority.replace();
        await this.rebuildFromCommitted();
        await this.textBarrier.flush();
      },
      (error) => this.textBarrier.canRetryRebuild(error),
    );
  }
  /** 关闭先尝试结清已接纳正文；失败仍释放资源，并把原回执交给调用方。 */
  async close(): Promise<void> {
    this.closing = true;
    this.textBarrier.pause();
    let failed = false;
    let failure: unknown;
    try {
      await this.textBarrier.flush();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.authority.close();
    } catch (error) {
      failure = failed ? retainWriterFailure(failure, error) : error;
      failed = true;
    } finally {
      this.textClaim.reset();
      this.textBarrier.close();
    }
    if (failed) throw failure;
  }
  /** 带屏障的公共动作：复核写者仍活着 → 冲刷已接收文本并等它落地（设计 §6.1「之前已接收的文本先完成写入」）→ 排队执行。 */
  private async run<T>(task: () => Promise<T>): Promise<T> {
    this.assertLive(true);
    await this.textBarrier.flush();
    this.assertLive(true);
    return await this.authority.enqueue(task);
  }
  /** 同一次合并冲刷的正文、跨块封口和目录在一个提交点生效，失败不留下前缀。 */
  private async writeText(
    request: MergeFlushRequest,
    token: WriterAuthorityToken,
    workingCredit: WorkingCredit,
  ): Promise<void> {
    try {
      this.authority.assertCurrent(token);
      const cursor = await writeAtomicText({
        options: this.options,
        scopeKey: this.scopeKey,
        generation: request.key.generation,
        request,
        workingCredit,
        cursor: this.cursor(CONTENT_KIND),
        directory: this.directory,
        renew: () => this.renewLease(token),
        stop: (code, message, cause) => this.stop(code, message, cause, token),
      });
      if (!this.authority.isCurrent(token)) {
        cursor.doc.destroy();
        return;
      }
      this.cursors.get(CONTENT_KIND)?.doc.destroy();
      this.cursors.set(CONTENT_KIND, cursor);
    } catch (error) {
      if (this.authority.isCurrent(token) && error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED") {
        this.failure = error;
        this.reacquirableFailure = error;
        this.authority.clear(token);
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
    let boundaryOrdinal: number | null = null;
    if (semantic.kind === "tool" && semantic.payload.boundary === true) {
      if (!this.boundarySeeded) {
        await seedBoundaryIndexFromDocs(
          this.boundaryIndex,
          this.options.store,
          this.authority.generation(),
          this.historyContentDocIds,
          this.cursor(CONTENT_KIND),
        );
        this.boundarySeeded = true;
      }
      boundaryOrdinal = this.boundaryIndex.claim(
        entryId,
        requireString(semantic.payload, "entityId"),
        semantic.payload.boundaryOrdinal,
      );
    }
    const gauge = createRuntimeDoc(RUNTIME_KIND, this.options.limits, this.cursor(RUNTIME_KIND).doc);
    const rotateRuntime = this.rotation.evaluate({
      encodedBytes: gauge.encodedBytes(),
      entityCount: gauge.entityCount(),
    }).rotate;
    const plan = planSemanticWrite({
      semantic,
      entryId,
      boundaryOrdinal,
      content: this.cursor(CONTENT_KIND),
      runtime: this.cursor(RUNTIME_KIND),
      rotateRuntime,
      options: this.options,
    });
    if (plan.overflow !== null)
      throw this.stop("CAPACITY_EXCEEDED", `semantic event exceeds the hard limit: ${plan.overflow}`);
    if (rotateRuntime) await this.rotateRuntimeDoc(plan.runtimeInitialState);
    if (plan.rotateContent) await this.sealActive(CONTENT_KIND);
    const slices = applySemanticWrite(plan, this.cursor(CONTENT_KIND), this.cursor(RUNTIME_KIND), this.options);
    await this.persist(slices);
    this.rotation.onTransaction(slices.reduce((sum, slice) => sum + slice.bytes.byteLength, 0));
  }
  private async sealActive(kind: DocKind, initialState?: Uint8Array): Promise<SealResult> {
    try {
      const current = this.cursor(kind);
      const blockIndex = parseDocId(current.docId).blockIndex + (kind === CONTENT_KIND ? 1 : 0);
      const nonce = hex(this.options.random, 8);
      const successorDocId = buildDocId({ kind, generation: this.authority.generation(), blockIndex, nonce });
      const successorInitialState = initialState ?? Y.encodeStateAsUpdate(new Y.Doc());
      const result = await this.sealing.seal({
        scope: this.options.scope,
        oldDocId: current.docId,
        lease: this.authority.lease(),
        finalUpdateSeq: current.lastSeq,
        successorDocId,
        successorInitialState,
      });
      this.cursors.set(kind, openLiveCursor(successorDocId, kind, successorInitialState));
      // 内容轮换后新块必须立刻出现在目录里，否则客户端永远发现不了轮换后的 live 内容。
      if (kind === CONTENT_KIND) await this.directory.appendContentDoc(this.authority.lease(), successorDocId);
      return result;
    } catch (error) {
      this.failure = error;
      // 只有确认路由未提交的正常过期可重新竞争写权；目录交接失败仍持有 committed 事实。
      if (
        error instanceof SyncProtocolError &&
        error.code === "LEASE_EXPIRED" &&
        this.sealing.routeOutcome === "absent"
      ) {
        this.authority.clear();
        this.reacquirableFailure = error;
      }
      throw error;
    }
  }
  /** 运行态轮换（设计 §6.3）：先取出未结束与交接未完成的实体，再封口使旧版不可写；`requiredBaseSeq` 是新块自身的基线序号。 */
  private async rotateRuntimeDoc(
    initial?: Uint8Array,
  ): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    const previous = this.cursor(RUNTIME_KIND);
    const initialState = initial ?? buildRuntimeSuccessorState(previous.doc, this.options.limits);
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
    const token = this.authority.captureTask();
    try {
      return await appendCommittedBatch({
        store: this.options.store,
        scopeKey: this.scopeKey,
        batch,
        cursors,
        renew: () => this.renewLease(token),
        stop: (code, message, cause) => this.stop(code, message, cause, token),
      });
    } catch (error) {
      if (!this.authority.isCurrent(token)) throw error;
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
  private async renewLease(token = this.authority.captureTask()): Promise<WriterLease> {
    try {
      return await this.authority.renew(token);
    } catch (error) {
      if (this.authority.isCurrent(token) && !(error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED"))
        this.failure = error;
      throw error;
    }
  }
  private async confirmOwnership(generation: string): Promise<void> {
    try {
      await this.options.store.confirmWriter(await this.renewLease(), generation);
    } catch (error) {
      if (error instanceof SyncProtocolError && error.code === "LEASE_EXPIRED") this.authority.clear();
      throw error;
    }
  }
  private async rebuildFromCommitted(): Promise<void> {
    const token = this.authority.captureTask();
    if (this.sealing.phase === "failed") this.sealing = createSealingMachine(this.options);
    // gate 已停输入与旧 timer，旧队列已结清；新 claim 等投影全部安装。
    this.boundaryIndex.reset();
    this.boundarySeeded = false;
    const projection = await rebuildLiveProjection({
      options: this.options,
      scopeKey: this.scopeKey,
      lease: token.lease,
      sealing: this.sealing,
      directory: this.directory,
      renew: () => this.renewLease(token),
      stop: (code, message, cause) => this.stop(code, message, cause, token),
    });
    try {
      this.authority.install(token, projection.generation);
    } catch (error) {
      for (const cursor of projection.cursors.values()) cursor.doc.destroy();
      throw error;
    }
    this.historyContentDocIds = projection.historyContentDocIds;
    for (const [kind, cursor] of projection.cursors) {
      this.cursors.get(kind)?.doc.destroy();
      this.cursors.set(kind, cursor);
    }
    this.textClaim.reset();
    this.textBarrier.resume(projection.generation);
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
  private overflowOf(slices: readonly Slice[], recordBytes = 0): string | null {
    return overflowOfSlices({
      slices,
      recordBytes,
      capacity: this.options.capacity,
      runtimeHardLimitBytes: this.options.limits.hardLimitBytes,
      cursorOf: (docId) => this.cursorOf(docId),
    });
  }
  private stop(
    code: SyncErrorCode,
    message: string,
    cause?: unknown,
    token = this.authority.captureTask(),
  ): SyncProtocolError {
    const error = new SyncProtocolError(code, { message, cause });
    if (this.authority.isCurrent(token)) this.failure = error;
    return error;
  }
  private assertLive(needLease: boolean): void {
    if (this.closing) throw new SyncProtocolError("RESOURCE_RETIRED", { message: "live writer is closing" });
    this.authority.assertOpen();
    if (this.failure !== null && (needLease || this.failure !== this.reacquirableFailure)) throw this.failure;
    if (needLease) this.authority.capture();
  }
}
