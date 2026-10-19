// packages/chat-channel/src/sync/live/live-writer.ts
// D 阶段单写者编排（设计 §6.1 / §6.3 / §7；规格 §3.1）：实时事件 → 合并文本 → 语义屏障 → 固定批次 → 全组一次提交 → 封口轮换。
// 不变量：① 每 scope 最多一个未决批次，批次在**执行前**固定 batchId、updateSeq 区间、摘要与原始字节，之后任何路径（含重试）都重放同一份字节；② 内存 Doc 不是事实来源，字节真相只在已提交边界，失败一律重建「canonical + 连续 tail」；③ 结果未知先查询：同批同摘要 = 成功且不重放输入，确定不存在且写权仍在 = 重放原字节，异摘要/无法判定 = 停写；④ 封口与轮换落成存储事务，「旧版停止写入」由存储拒绝兜底。
// 已知偏差（影响 + 移除条件）：① 不写块头 meta 与 ordinal 范围、记录不带 `entryOrder`（`LiveInput` 不携带该信息，写者不编造，顺序暂由块 ordinal 表达）；② `partIndex` 是块内局部序号，跨块序号需 ref 索引或 successor 路由；③ 崩溃后发现不了封口产生的 successor，`recover()` 只回到 `entryRefs` 入口；④ 代次入口没有内容块时按 DOC_NOT_FOUND 失败而非自建块，新旧共存额度由装配层调 `reserveCoexistence` 预留。①②③ 移除条件「存储或调用方补齐信息」，④「接线层登记首块并持有 AdmissionController」。
import * as Y from "yjs";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn, RandomSource } from "../clock";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { buildDocId, createBatchId, type DocKind, parseDocId, type SyncScope, scopeKey } from "../protocol/identity";
import type { CommitOutcome, DocFrontier, ProjectionStore, WriterLease } from "../store/types";
import { captureChange } from "./change-capture";
import { ensureWritableContentDoc } from "./content-tail";
import { createDirectoryAppender, type DirectoryAppender } from "./directory-appender";
import { createMergeBuffer, type MergeBuffer, type MergeFlushRequest, type MergeKey } from "./merge-buffer";
import { createRotationController, type RotationController, type RotationControllerOptions } from "./rotation";
import type { FinalEntityDescriptor, RuntimeDocLimits, RuntimeEntityRecord } from "./runtime-doc";
import { createRuntimeDoc } from "./runtime-doc";
import { createSealingMachine, type SealingMachine, type SealResult } from "./sealing";
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
export type BarrierKind = "tool" | "permission" | "error" | "cancel" | "final";
export interface LiveInput {
  readonly turnId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
  readonly kind: "text-delta" | "semantic";
  readonly delta?: string;
  /** 语义载荷契约：`entityId` 必填，`toolCallId` / `metadata` 可选；载荷带 `finalDescriptor` 即实体交接（描述符写进内容块并在同批次移出运行态），`kind: "final"` 是它的规范形态。 */
  readonly semantic?: { readonly kind: BarrierKind; readonly payload: Record<string, unknown> };
}
export interface LiveWriterOptions {
  readonly scope: SyncScope;
  readonly store: ProjectionStore;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly capacity: SyncCapacityProfile;
  readonly merge: { readonly maxDelayMs: number; readonly maxBytes: number };
  readonly limits: RuntimeDocLimits;
  readonly rotation: RotationControllerOptions;
}
export interface PendingBatch {
  readonly batchId: string;
  readonly docId: string;
  readonly ordinalStart: number;
  readonly ordinalEnd: number;
  readonly digest: string;
  readonly payload: Uint8Array;
}
export interface LiveWriter {
  acquire(): Promise<void>;
  accept(input: LiveInput): Promise<void>;
  commit(pending: PendingBatch): Promise<CommitOutcome>;
  seal(): Promise<SealResult>;
  rotateRuntime(): Promise<{ readonly oldDocId: string; readonly newDocId: string; readonly requiredBaseSeq: number }>;
  recover(): Promise<void>;
  close(): Promise<void>;
}
export interface LiveRecordValue {
  readonly recordId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
  readonly partIndex: number;
  readonly kind: "text" | "final";
  readonly payload: Uint8Array;
}
export const LIVE_WRITER_LEASE_TTL_MS = 30_000;
export const LIVE_COMMIT_MAX_ATTEMPTS = 3;
const CONTENT_KIND: DocKind = "content";
const RUNTIME_KIND: DocKind = "runtime";
const NOOP = (): void => {};
const ENTITY_KINDS: ReadonlySet<string> = new Set(["tool", "permission", "error", "cancel"]);
type Identity = { readonly entryId: string; readonly contentSlot: string; readonly contentType?: string };
type Cursor = { readonly docId: string; readonly kind: DocKind; doc: Y.Doc; lastSeq: number };
type Slice = { readonly docId: string; readonly fromSeq: number; readonly bytes: Uint8Array };
type Batch = { readonly batchId: string; readonly digest: string; readonly slices: readonly Slice[] };
type Probe =
  | { readonly status: "committed"; readonly frontiers: DocFrontier[] }
  | { readonly status: "absent" | "ambiguous" };
function fail(code: SyncErrorCode, message: string): never {
  throw new SyncProtocolError(code, { message });
}
/** 显式标注类型才会让调用点之后被收窄：无注解的 `never` 箭头函数不参与控制流分析。 */
const malformed: (message: string) => never = (message) => fail("MALFORMED_FRAME", message);
const isEntityKind = (value: unknown): value is FinalEntityDescriptor["kind"] =>
  typeof value === "string" && ENTITY_KINDS.has(value);
function entityOf(kind: BarrierKind, payload: Record<string, unknown>): RuntimeEntityRecord {
  if (kind === "final" || !ENTITY_KINDS.has(kind)) malformed(`semantic kind ${kind} is not a runtime entity`);
  const toolCallId = payload.toolCallId;
  if (toolCallId !== undefined && typeof toolCallId !== "string") malformed("invalid toolCallId");
  const metadata = payload.metadata === undefined ? {} : requireObject(payload.metadata, "semantic metadata");
  const entity = { entityId: requireString(payload, "entityId"), kind, metadata, state: "open" as const };
  return toolCallId === undefined ? entity : { ...entity, toolCallId };
}
function descriptorOf(payload: Record<string, unknown>, entityId: string): FinalEntityDescriptor {
  const { kind, contentRef, digest, byteLength, completedAt } = requireObject(payload.finalDescriptor, "descriptor");
  if (!isEntityKind(kind) || typeof contentRef !== "string" || typeof digest !== "string") malformed("bad descriptor");
  const size = typeof byteLength === "number" ? byteLength : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0 || typeof completedAt !== "number") malformed("bad descriptor");
  if (!Number.isFinite(completedAt)) malformed("bad descriptor");
  return { entityId, kind, contentRef, digest, byteLength: size, completedAt };
}
class LiveWriterImpl implements LiveWriter {
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
  private readonly directory: DirectoryAppender;
  private closed = false;
  constructor(private readonly options: LiveWriterOptions) {
    const { store, clock, digest, random } = options;
    this.scopeKey = scopeKey(options.scope);
    this.owner = `live_${hex(random, 8)}`;
    this.rotation = createRotationController(options.rotation);
    this.sealing = createSealingMachine({ store, clock, digest, random });
    this.directory = createDirectoryAppender({ store, scopeKey: this.scopeKey, digest, random });
    this.merge = this.newMerge();
  }
  async acquire(): Promise<void> {
    this.assertLive(false);
    // 租约被占或已过期时存储直接拒绝（SCOPE_BUSY）；本层不排队等待，等待会让「谁在写」不可判定。
    this.lease = await this.options.store.acquireWriter(this.scopeKey, this.owner, LIVE_WRITER_LEASE_TTL_MS);
    await this.rebuildFromCommitted();
  }
  async accept(input: LiveInput): Promise<void> {
    this.assertLive(true);
    const { turnId, entryId, contentSlot, contentType } = input;
    if (input.kind !== "text-delta") {
      const semantic = input.semantic;
      if (semantic === undefined) malformed("semantic input requires a semantic payload");
      return await this.run(() => this.writeSemantic(semantic));
    }
    const delta = input.delta;
    if (delta === undefined) malformed("text-delta input requires a delta");
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
  /** 正文增量：一条记录一个事务；超限走重拆出口（设计 §6.1）——不持久化不发布，先查询确认该批未提交，再恢复原 canonical + tail 并封口，最后把同一份输入拆小写进新块；`resplit` 保证最多重拆一次，仍超限即报容量错误并停写。 */
  private async writeText(request: MergeFlushRequest, resplit = false): Promise<void> {
    const cursor = this.cursor(CONTENT_KIND);
    const chunkLimit = this.options.capacity.inputs.payloadChunkMaxBytes;
    const chunkBytes = Math.max(1, Math.min(chunkLimit, Math.floor(this.limitOf(CONTENT_KIND) / 2)));
    const texts = resplit ? splitUtf8(request.text, chunkBytes) : [request.text];
    const base = this.partIndex(cursor, request.key);
    const slices: Slice[] = [];
    let recordBytes = 0;
    for (const [index, text] of texts.entries()) {
      const record = this.buildRecord(request.key, "text", bytes(text), base + index);
      recordBytes = Math.max(recordBytes, record.payload.byteLength);
      this.capture(slices, cursor, () => records(cursor.doc, [record]));
    }
    const overflow = this.overflowOf(slices, recordBytes);
    if (overflow === null) return await this.persist(slices);
    if (resplit) throw this.stop("CAPACITY_EXCEEDED", `re-split still exceeds the hard limit: ${overflow}`);
    // 被污染的私有投影只能丢弃（不变量 ②）：确认未提交后重放原谱系并封口，写入口随后指向新块。
    const probe = await this.confirmBatch(this.fixBatch(slices));
    if (probe.status === "committed") return applyFrontiers(this.cursorsOf(slices), probe.frontiers);
    if (probe.status === "ambiguous") throw this.stop("COMMIT_OUTCOME_UNKNOWN", `undecidable batch: ${overflow}`);
    await this.loadCursor(cursor.docId, cursor.kind);
    await this.sealActive(CONTENT_KIND);
    await this.writeText(request, true);
  }
  /** 语义事件：带终态描述符的事件（`kind: "final"`，或声明实体类别并携带描述符的等价形态）把描述符写进内容块并在同批次移出实体，其余按实体身份更新运行态；语义实体不可拆分，拆一半比一次明确失败更糟。 */
  private async writeSemantic(semantic: NonNullable<LiveInput["semantic"]>): Promise<void> {
    const gauge = createRuntimeDoc(RUNTIME_KIND, this.options.limits, this.cursor(RUNTIME_KIND).doc);
    const stats = { encodedBytes: gauge.encodedBytes(), entityCount: gauge.entityCount() };
    if (this.rotation.evaluate(stats).rotate) await this.rotateRuntimeDoc();
    const runtime = this.cursor(RUNTIME_KIND);
    const target = createRuntimeDoc(RUNTIME_KIND, this.options.limits, runtime.doc);
    const slices: Slice[] = [];
    let recordBytes = 0;
    // 终态由描述符决定而不是由 kind 决定：`kind` 只声明实体类别（如 `permission`），缺描述符的 `kind: "final"` 仍按契约报错。
    if (semantic.kind === "final" || semantic.payload.finalDescriptor !== undefined) {
      const entityId = requireString(semantic.payload, "entityId");
      const identity: Identity = { entryId: entityId, contentSlot: "final", contentType: "final-descriptor" };
      const descriptor = bytes(JSON.stringify(descriptorOf(semantic.payload, entityId)));
      const content = this.cursor(CONTENT_KIND);
      const record = this.buildRecord(identity, "final", descriptor, this.partIndex(content, identity));
      this.capture(slices, content, () => records(content.doc, [record]));
      this.capture(slices, runtime, () => target.removeEntity(entityId));
      recordBytes = descriptor.byteLength;
    } else {
      const record = entityOf(semantic.kind, semantic.payload);
      this.capture(slices, runtime, () => target.upsertEntity(record));
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
  private buildRecord(id: Identity, kind: "text" | "final", payload: Uint8Array, partIndex: number): LiveRecordValue {
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
    // 恢复的语义是「本机未提交输入已经不存在」：丢弃缓冲，而不是把它补写进重建后的 Doc。
    this.merge.dispose();
    this.merge = this.newMerge();
    const pointer = await this.options.store.readScopePointer(this.scopeKey);
    const generationId = pointer?.currentGeneration ?? null;
    if (generationId === null) fail("GENERATION_MISMATCH", "scope has no current generation");
    const generation = await this.options.store.readGeneration(this.scopeKey, generationId);
    if (generation === null) fail("GENERATION_MISMATCH", "current generation record is missing");
    if (["retired", "failed"].includes(generation.state)) fail("RESOURCE_RETIRED", generationId);
    this.generation = generation.generation;
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
    const base = await this.options.store.readDocStateAt(docId, 0);
    if (base === null) fail("DOC_NOT_FOUND", `document ${docId} has no committed base state`);
    const cursor = this.openCursor(docId, kind, base.snapshot);
    for (;;) {
      const page = await this.options.store.readUpdatesAfter(docId, cursor.lastSeq, 256);
      if (page.length === 0) break;
      for (const update of page) {
        if (update.updateSeq !== cursor.lastSeq + 1) fail("SEQUENCE_GAP", `tail of ${docId} is not continuous`);
        Y.applyUpdate(cursor.doc, update.bytes);
        cursor.lastSeq = update.updateSeq;
      }
    }
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
  private limitOf(kind: DocKind): number {
    const { limits, capacity } = this.options;
    return kind === RUNTIME_KIND ? limits.hardLimitBytes : capacity.inputs.activeHardEncodedBytes;
  }
  private overflowOf(slices: readonly Slice[], recordBytes = 0): string | null {
    const chunkLimit = this.options.capacity.inputs.payloadChunkMaxBytes;
    if (recordBytes > chunkLimit) return `record payload is ${recordBytes} bytes, chunk limit is ${chunkLimit}`;
    for (const { docId } of slices) {
      const cursor = this.cursorOf(docId);
      const size = Y.encodeStateAsUpdate(cursor.doc).byteLength;
      if (size > this.limitOf(cursor.kind)) return `snapshot of ${docId} is ${size} bytes, over the hard limit`;
    }
    return null;
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
export function createLiveWriter(options: LiveWriterOptions): LiveWriter {
  return new LiveWriterImpl(options);
}
