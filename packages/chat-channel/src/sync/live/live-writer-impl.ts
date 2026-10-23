// packages/chat-channel/src/sync/live/live-writer.ts
// D 阶段单写者编排（设计 §6.1 / §6.3 / §7；规格 §3.1）：实时事件 → 合并文本 → 语义屏障 → 固定批次 → 全组一次提交 → 封口轮换。
// 不变量：① 每 scope 最多一个未决批次，批次在**执行前**固定 batchId、updateSeq 区间、摘要与原始字节，之后任何路径（含重试）都重放同一份字节；② 内存 Doc 不是事实来源，字节真相只在已提交边界，失败一律重建「canonical + 连续 tail」；③ 结果未知先查询：同批同摘要 = 成功且不重放输入，确定不存在且写权仍在 = 重放原字节，异摘要/无法判定 = 停写；④ 封口与轮换落成存储事务，「旧版停止写入」由存储拒绝兜底。
// 已知偏差（影响 + 移除条件）：① 不写块头 meta 与 ordinal 范围、记录不带 `entryOrder`（`LiveInput` 不携带该信息，写者不编造，顺序暂由块 ordinal 表达）；② `partIndex` 是块内局部序号，跨块序号需 ref 索引或 successor 路由；③ 崩溃后发现不了封口产生的 successor，`recover()` 只回到 `entryRefs` 入口；④ 代次入口没有内容块时按 DOC_NOT_FOUND 失败而非自建块，新旧共存额度由装配层调 `reserveCoexistence` 预留。①②③ 移除条件「存储或调用方补齐信息」，④「接线层登记首块并持有 AdmissionController」。
import * as Y from "yjs";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { buildDocId, createBatchId, type DocKind, parseDocId, scopeKey } from "../protocol/identity";
import type { CommitOutcome, DocFrontier, WriterLease } from "../store/types";
import { BoundaryIndex, boundaryPayload, seedBoundaryIndexFromDocs } from "./boundary-index";
import { captureChange } from "./change-capture";
import { loadCommittedDoc } from "./committed-doc";
import { ensureWritableContentDoc } from "./content-tail";
import { createDirectoryAppender, type DirectoryAppender } from "./directory-appender";
import {
  type Batch,
  CONTENT_KIND,
  type Cursor,
  fail,
  type Identity,
  malformed,
  NOOP,
  overflowOfSlices,
  type Probe,
  RUNTIME_KIND,
  type Slice,
} from "./live-writer-internal";
import { descriptorOf, entityOf } from "./live-writer-records";
import {
  LIVE_COMMIT_MAX_ATTEMPTS,
  LIVE_WRITER_LEASE_TTL_MS,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
  type LiveWriterOptions,
  type PendingBatch,
} from "./live-writer-types";
import { createMergeBuffer, type MergeBuffer, type MergeFlushRequest, type MergeKey } from "./merge-buffer";
import { createRotationController, type RotationController } from "./rotation";
import { createRuntimeDoc, type FinalEntityDescriptor } from "./runtime-doc";
import { createSealingMachine, type SealingMachine, type SealResult } from "./sealing";
import { createTextClaim, type TextClaim } from "./text-claim";
import {
  applyFrontiers,
  bytes,
  concatParts,
  expectedFrontiers,
  hex,
  records,
  requireObject,
  requireString,
  splitUtf8,
} from "./writer-support";
export class LiveWriterImpl implements LiveWriter {
  private readonly scopeKey: string;
  private readonly owner: string;
  private readonly rotation: RotationController;
  private readonly sealing: SealingMachine;
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
    const { store, clock, digest, random } = options;
    this.scopeKey = scopeKey(options.scope);
    this.owner = `live_${hex(random, 8)}`;
    this.rotation = createRotationController(options.rotation);
    this.sealing = createSealingMachine({ store, clock, digest, random });
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
    const chunkLimit = this.options.capacity.inputs.payloadChunkMaxBytes;
    const chunkBytes = Math.max(
      1,
      Math.min(chunkLimit, Math.floor(this.options.capacity.inputs.activeHardEncodedBytes / 2)),
    );
    for (const text of splitUtf8(request.text, chunkBytes)) {
      let cursor = this.cursor(CONTENT_KIND);
      for (;;) {
        const record = this.buildRecord(request.key, "text", bytes(text), this.partIndex(cursor, request.key));
        const slices: Slice[] = [];
        const hadRecords = (records(cursor.doc)?.length ?? 0) > 0;
        this.capture(slices, cursor, () => records(cursor.doc, [record]));
        const overflow = this.overflowOf(slices, record.payload.byteLength);
        if (overflow === null) {
          await this.persist(slices);
          break;
        }
        // 试写尚未交给存储；只丢弃本片，已提交前缀从 canonical + tail 恢复，绝不重放整个输入。
        await this.loadCursor(cursor.docId, cursor.kind);
        if (!hadRecords) throw this.stop("CAPACITY_EXCEEDED", `record cannot fit an empty doc: ${overflow}`);
        await this.sealActive(CONTENT_KIND);
        cursor = this.cursor(CONTENT_KIND);
      }
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
    // 终态事件会在同批写 final 记录，可能触发内容块轮转。轮转必须先于 boundary：
    // 否则 boundary 落在已封口 Doc，overflowOf 无法再把它当作写目标（DOC_NOT_FOUND）。
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
        const record = this.buildRecord(identity, "tool_boundary", boundaryBytes, ordinal);
        this.capture(slices, content, () => records(content.doc, [record]));
        recordBytes = Math.max(recordBytes, boundaryBytes.byteLength);
      }
    }
    // 终态由描述符决定而不是由 kind 决定：`kind` 只声明实体类别（如 `permission`），缺描述符的 `kind: "final"` 仍按契约报错。
    if (semantic.kind === "final" || semantic.payload.finalDescriptor !== undefined) {
      const identity: Identity = { entryId: entityId, contentSlot: "final", contentType: "final-descriptor" };
      const descriptor = bytes(JSON.stringify(descriptorOf(semantic.payload, entityId)));
      const content = this.cursor(CONTENT_KIND);
      const record = this.buildRecord(identity, "final", descriptor, this.partIndex(content, identity));
      this.capture(slices, content, () => records(content.doc, [record]));
      this.capture(slices, runtime, () => target.removeEntity(entityId));
      recordBytes = Math.max(recordBytes, descriptor.byteLength);
    } else {
      if (terminalEntity) {
        // 先提交终态描述符/引用，再在同批次移出实体；新投影只承接终态索引，
        // 工具原始输入输出仍由旧通道承载（见 ingress 已知缺口③）。
        const metadata =
          semantic.payload.metadata === undefined ? {} : requireObject(semantic.payload.metadata, "metadata");
        const terminalContent = bytes(JSON.stringify({ entityId, kind: semantic.kind, metadata }));
        const content = this.cursor(CONTENT_KIND);
        const identity: Identity = {
          entryId: `${entityId}:final`,
          contentSlot: "final",
          contentType: "final-descriptor",
        };
        const record = this.buildRecord(identity, "final", terminalContent, this.partIndex(content, identity));
        const descriptor: FinalEntityDescriptor = {
          entityId,
          kind: semantic.kind,
          contentRef: record.recordId,
          digest: this.options.digest(terminalContent),
          byteLength: terminalContent.byteLength,
          completedAt: this.options.clock.now(),
        };
        const descriptorPayload = bytes(JSON.stringify(descriptor));
        const descriptorRecord = this.buildRecord(identity, "final", descriptorPayload, record.partIndex + 1);
        this.capture(slices, content, () => records(content.doc, [record, descriptorRecord]));
        this.capture(slices, runtime, () => target.removeEntity(entityId));
        recordBytes = Math.max(terminalContent.byteLength, descriptorPayload.byteLength);
      } else {
        const record = entityOf(semantic.kind, semantic.payload);
        this.capture(slices, runtime, () => target.upsertEntity(record));
      }
    }
    const overflow = this.overflowOf(slices, recordBytes);
    if (overflow !== null) throw this.stop("CAPACITY_EXCEEDED", `semantic event exceeds the hard limit: ${overflow}`);
    await this.persist(slices);
    this.rotation.onTransaction(slices.reduce((sum, slice) => sum + slice.bytes.byteLength, 0));
  }
  private async sealActive(kind: DocKind): Promise<SealResult> {
    const current = this.cursor(kind);
    const blockIndex = parseDocId(current.docId).blockIndex + (kind === CONTENT_KIND ? 1 : 0);
    const nonce = hex(this.options.random, 8);
    const successorDocId = buildDocId({ kind, generation: this.requireGeneration(), blockIndex, nonce });
    const successorInitialState = Y.encodeStateAsUpdate(new Y.Doc());
    const result = await this.sealing.seal({
      scope: this.options.scope,
      oldDocId: current.docId,
      lease: this.requireLease(),
      finalUpdateSeq: current.lastSeq,
      successorDocId,
      successorInitialState,
    });
    this.cursors.set(kind, this.openCursor(successorDocId, kind, successorInitialState));
    // 内容轮换后新块必须立刻出现在目录里，否则客户端永远发现不了轮换后的 live 内容。
    if (kind === CONTENT_KIND) await this.directory.appendContentDoc(this.requireLease(), successorDocId);
    return result;
  }
  /** 运行态轮换（设计 §6.3）：先取出未结束与交接未完成的实体，再封口使旧版不可写；`requiredBaseSeq` 是新块自身的基线序号。 */
  private async rotateRuntimeDoc(): Promise<{ oldDocId: string; newDocId: string; requiredBaseSeq: number }> {
    const previous = this.cursor(RUNTIME_KIND);
    const carried = createRuntimeDoc(RUNTIME_KIND, this.options.limits, previous.doc).exportForRotation();
    await this.sealActive(RUNTIME_KIND);
    const successor = this.cursor(RUNTIME_KIND);
    if (carried.length > 0) {
      const target = createRuntimeDoc(RUNTIME_KIND, this.options.limits, successor.doc);
      const slices: Slice[] = [];
      this.capture(slices, successor, () => {
        for (const record of carried) target.upsertEntity(record);
      });
      const overflow = this.overflowOf(slices);
      if (overflow !== null) throw this.stop("CAPACITY_EXCEEDED", `rotation copy exceeds the hard limit: ${overflow}`);
      await this.persist(slices);
    }
    this.rotation.reset();
    return { oldDocId: previous.docId, newDocId: successor.docId, requiredBaseSeq: 0 };
  }
  /** 捕获一个改动成切片：每个改动一个事务、各得一条独立 update，同一 Doc 的序号顺延；无变更的事务不占序号（纯删除也算变更，见 `captureChange`）。 */
  private capture(slices: Slice[], cursor: Cursor, mutate: () => void): void {
    const update = captureChange(cursor.doc, mutate);
    if (update === null) return;
    const used = slices.filter((slice) => slice.docId === cursor.docId).length;
    slices.push({ docId: cursor.docId, fromSeq: cursor.lastSeq + used + 1, bytes: update });
  }
  private buildRecord(
    id: Identity,
    kind: "text" | "final" | "tool_boundary",
    payload: Uint8Array,
    partIndex: number,
  ): LiveRecordValue {
    const { entryId, contentSlot, contentType } = id;
    const recordId = `rec_${hex(this.options.random, 8)}`;
    return { recordId, entryId, contentSlot, contentType: contentType ?? "", partIndex, kind, payload };
  }
  private partIndex(cursor: Cursor, key: { entryId: string; contentSlot: string }): number {
    const existing = records<LiveRecordValue>(cursor.doc)?.toArray() ?? [];
    return existing.filter((value) => value.entryId === key.entryId && value.contentSlot === key.contentSlot).length;
  }
  private fixBatch(slices: readonly Slice[]): Batch {
    const raw = concatParts(slices.map((slice) => slice.bytes));
    return { batchId: createBatchId(this.options.random), digest: this.options.digest(raw), slices };
  }
  private async persist(slices: readonly Slice[]): Promise<void> {
    if (slices.length === 0) return;
    await this.executeBatch(this.fixBatch(slices), this.cursorsOf(slices));
  }
  /** 执行批次：全组一次 `appendUpdates`（不得部分写入后重试），按回执推进游标；`unknown` 先查询，只有结论为「确定不存在且写权仍在」才允许重放原字节。 */
  private async executeBatch(batch: Batch, cursors: ReadonlyMap<string, Cursor>): Promise<CommitOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      const lease = await this.renewLease();
      const result = await this.options.store.appendUpdates({
        scopeKey: this.scopeKey,
        epoch: lease.epoch,
        owner: lease.owner,
        batchId: batch.batchId,
        digest: batch.digest,
        expectedFrontiers: expectedFrontiers(batch.slices),
        updates: batch.slices.map((slice) => ({ docId: slice.docId, fromSeq: slice.fromSeq, bytes: slice.bytes })),
      });
      // 同幂等键异内容：本机不得覆盖已提交字节，也无从「重试」出另一个结果，只能停写。
      if (result.outcome === "conflict") throw this.stop("DIGEST_CONFLICT", `committed batch ${batch.batchId} differs`);
      if (result.outcome !== "unknown") {
        applyFrontiers(cursors, result.frontiers);
        return result.outcome;
      }
      const probe = await this.confirmBatch(batch);
      if (probe.status === "committed") {
        applyFrontiers(cursors, probe.frontiers);
        return "already-committed";
      }
      if (probe.status === "absent" && attempt < LIVE_COMMIT_MAX_ATTEMPTS) continue;
      throw this.stop("COMMIT_OUTCOME_UNKNOWN", `batch ${batch.batchId} is undecided after ${attempt} attempts`);
    }
  }
  /** 结果未知后的查询：只认已提交字节并逐片核对幂等键；混合结论按「无法判定」处理。 */
  private async confirmBatch(batch: Batch): Promise<Probe> {
    const frontiers: DocFrontier[] = [];
    for (const { docId, fromSeq } of batch.slices) {
      const first = (await this.options.store.readUpdatesAfter(docId, fromSeq - 1, 1))[0];
      if (first === undefined || first.updateSeq !== fromSeq) continue;
      if (first.batchId !== batch.batchId || first.digest !== batch.digest) return { status: "ambiguous" };
      frontiers.push({ docId, lastSeq: fromSeq });
    }
    if (frontiers.length === batch.slices.length) return { status: "committed", frontiers };
    return { status: frontiers.length === 0 ? "absent" : "ambiguous" };
  }
  /** 续租同时复核 fencing：epoch 被顶替或租约过期时立即停写（在途通知撤不回，只能先停）。 */
  private async renewLease(): Promise<WriterLease> {
    try {
      this.lease = await this.options.store.renewWriter(this.requireLease(), LIVE_WRITER_LEASE_TTL_MS);
      return this.lease;
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }
  private async rebuildFromCommitted(): Promise<void> {
    // 恢复的语义是「本机未提交输入已经不存在」：丢弃缓冲与未落地的幂等声明，
    // 重新按已提交记录判定，避免失败后同一用户消息被永久拒绝。
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
    await this.loadCursor(generation.entryRefs.runtimeDocId, RUNTIME_KIND);
    await this.directory.load(this.requireLease(), generation.generation, generation.entryRefs);
    const closureTail = generation.entryRefs.contentDocIds.at(-1);
    if (closureTail === undefined) fail("DOC_NOT_FOUND", "generation has no content block entry");
    // 历史导入的内容块全部已封口；恢复时必须改用/新建 active 尾块，否则第一次实时写入就会
    // 被存储以 RESOURCE_RETIRED 拒绝（空基线的入口闭包末位本身就是 active 块）。
    const contentDocId = await ensureWritableContentDoc({
      store: this.options.store,
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
  private async loadCursor(docId: string, kind: DocKind): Promise<Cursor> {
    const loaded = await loadCommittedDoc(this.options.store, docId);
    if (loaded === null) fail("DOC_NOT_FOUND", `document ${docId} has no committed base state`);
    const cursor = { docId, kind, ...loaded };
    this.cursors.set(kind, cursor);
    return cursor;
  }
  private openCursor(docId: string, kind: DocKind, snapshot: Uint8Array): Cursor {
    const doc = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc, snapshot);
    return { docId, kind, doc, lastSeq: 0 };
  }
  private cursor(kind: DocKind): Cursor {
    return this.cursors.get(kind) ?? fail("DOC_NOT_FOUND", `live writer has no active ${kind} doc`);
  }
  private cursorOf(docId: string): Cursor {
    const found = [...this.cursors.values()].find((entry) => entry.docId === docId);
    return found ?? fail("DOC_NOT_FOUND", `document ${docId} is not a write target of this writer`);
  }
  private cursorsOf(slices: readonly Slice[]): Map<string, Cursor> {
    return new Map(slices.map((slice) => [slice.docId, this.cursorOf(slice.docId)]));
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
  private stop(code: SyncErrorCode, message: string): SyncProtocolError {
    const error = new SyncProtocolError(code, { message });
    this.failure = error;
    return error;
  }
  private assertLive(needLease: boolean): void {
    if (this.closed) fail("RESOURCE_RETIRED", "live writer is closed");
    if (this.failure !== null) throw this.failure;
    if (needLease && this.lease === null) fail("WRITER_EPOCH_LOST", "live writer has not acquired the write lease");
  }
}
