import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { fidelitySerialize } from "../sync/history/fidelity-json";
import {
  type BarrierKind,
  createLiveWriter,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
} from "../sync/live/live-writer";
import type { RotationControllerOptions } from "../sync/live/rotation";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, ProjectionStore, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
/** 夹具内已认证 scope 的稳定存储键。 */
export const SCOPE_KEY = scopeKey(SCOPE);
/** 夹具的固定提交代次。 */
export const GENERATION = "gen-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
/** 引导租约：夹具用它登记代次与文档，随后过期，把写权让给被测写者。 */
const BOOTSTRAP_TTL_MS = 5_000;
/** 合并窗口远大于用例时长：冲刷只由屏障或字节阈值推动，不依赖真实定时器。 */
const MERGE = { maxDelayMs: 600_000, maxBytes: 1 << 20 };
const TEXT_DECODER = new TextDecoder();
/** 历史导入完成后 `ensureWritableContentDoc` 确定性创建的实时尾块。 */
export const LIVE_TAIL_ID = docIdFor("content", 1, "live-tail");

/** 历史导入记录的扁平形态：`text_part` + 旧协议数字槽位 0。 */
interface HistoryRecordFixture {
  readonly recordId: string;
  readonly entryId: string;
  readonly contentSlot: number;
  readonly contentType: string;
  readonly partIndex: number;
  readonly kind: "text_part";
  readonly payload: Uint8Array;
}

/** 构造带稳定 entryId 与旧协议数字槽位的历史文本。 */
export function historyRecord(entryId: string, text: string): HistoryRecordFixture {
  return {
    recordId: `rec_${entryId}`,
    entryId,
    contentSlot: 0,
    contentType: "text/plain",
    partIndex: 0,
    kind: "text_part",
    payload: fidelitySerialize(text),
  };
}

function encodeHistoryRecords(records: readonly HistoryRecordFixture[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    const target = new Y.Array<HistoryRecordFixture>();
    doc.getMap("root").set("records", target);
    target.push([...records]);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

interface TimeControl {
  clock: Clock;
  advance(ms: number): void;
}

/** 单写者测试共享的真实存储、时钟与文档身份。 */
export interface Runtime {
  store: MemoryProjectionStore;
  time: TimeControl;
  capacity: SyncCapacityProfile;
  runtimeId: string;
  contentId: string;
}

/** 可推进的测试时钟：租约过期、轮换期限与合并窗口都由它驱动，实现不得读真实时间。 */
export function testTime(start = 1_000): TimeControl {
  let now = start;
  return { clock: { now: () => now }, advance: (ms) => (now += ms) };
}

/** 建立使用真实 fencing、幂等和容量校验的内存存储。 */
export function makeStore(clock: Clock, capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY): MemoryProjectionStore {
  return new MemoryProjectionStore({ clock, digest: sha256Digest, capacity, lifecycle: LIFECYCLE });
}

/** 在固定测试代次内构造可追踪的文档身份。 */
export function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 空 Doc 的 canonical 字节：内容块与运行态 Doc 都以它为基线登记。 */
export function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function docRecord(docId: string, kind: DocKind, blockIndex: number, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/**
 * 建一个有已提交代次的作用域：代次必须经 `commitGeneration` 变成当前代次，否则存储会按
 * `GENERATION_NOT_CURRENT` 拒绝写者的一切写入。内容块入口写在 `entryRefs` 里——写者不自建入口，
 * 恢复路径也依赖它。
 */
export async function seed(
  runtime: Runtime,
  options: {
    contentBlocks?: boolean;
    /** 已封口的导入历史：入口闭包末位是历史块，写者必须另建 active 尾块。 */
    historyRecords?: readonly HistoryRecordFixture[];
    /** 不在入口闭包里的已封口块：用于验证 claim 不会把无关旧块当作已提交事实。 */
    orphanRecords?: readonly HistoryRecordFixture[];
  } = {},
): Promise<void> {
  const { store, time } = runtime;
  const historyRecords = options.historyRecords ?? [];
  const contentDocIds = options.contentBlocks === false ? [] : [runtime.contentId];
  const entryRefs: GenerationEntryRefs = {
    controlDocId: docIdFor("control", 0, "control"),
    directoryDocId: docIdFor("directory", 0, "directory"),
    runtimeDocId: runtime.runtimeId,
    contentDocIds,
  };
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-session-1",
    loadId: "load-1",
    state: "staging",
    importEndOrdinal: historyRecords.length > 0 ? historyRecords.length : null,
    entryRefs,
    createdAt: 1_000,
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(runtime.runtimeId, "runtime", 0, emptyState()),
  });
  const putSealed = async (docId: string, records: readonly HistoryRecordFixture[]): Promise<void> => {
    const snapshot = encodeHistoryRecords(records);
    const base = docRecord(docId, "content", 0, snapshot);
    await store.putSealedIfAbsent({
      scopeKey: SCOPE_KEY,
      epoch: lease.epoch,
      doc: {
        ...base,
        state: "sealed",
        finalSeq: 0,
        ordinalStart: 1,
        ordinalEnd: records.length,
      },
    });
  };
  if (historyRecords.length > 0) {
    await putSealed(runtime.contentId, historyRecords);
  } else {
    for (const docId of contentDocIds) {
      await store.createDoc({
        scopeKey: SCOPE_KEY,
        epoch: lease.epoch,
        doc: docRecord(docId, "content", 0, emptyState()),
      });
    }
  }
  if (options.orphanRecords !== undefined) {
    await putSealed(docIdFor("content", 0, "orphan"), options.orphanRecords);
  }
  // 推进引导租约期限以覆盖过期后重新取得 epoch 的路径。
  time.advance(BOOTSTRAP_TTL_MS + 1);
}

/** 创建互相隔离的 scope 测试资源。 */
export function createRuntime(capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY, start = 1_000): Runtime {
  const time = testTime(start);
  return {
    store: makeStore(time.clock, capacity),
    time,
    capacity,
    runtimeId: docIdFor("runtime", 0, "runtime"),
    contentId: docIdFor("content", 0, "content"),
  };
}

interface WriterOptions {
  seed?: string;
  wrap?: (runtime: Runtime) => ProjectionStore;
  rotation?: Partial<RotationControllerOptions>;
}

/** 使用相同容量和时钟装配写者，可注入存储边界故障。 */
export function newWriter(runtime: Runtime, options: WriterOptions = {}): LiveWriter {
  const clock = runtime.time.clock;
  const rotation: RotationControllerOptions = {
    clock,
    random: deterministicRandomSource("rotation"),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 600_000,
    maxTransactions: 1_000,
    ...options.rotation,
  };
  return createLiveWriter({
    scope: SCOPE,
    store: options.wrap?.(runtime) ?? runtime.store,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource(options.seed ?? "live-writer"),
    capacity: runtime.capacity,
    merge: MERGE,
    limits: RUNTIME_DOC_LIMITS,
    rotation,
  });
}

interface Fixture extends Runtime {
  writer: LiveWriter;
}

/** 已取得写权的夹具：绝大多数用例的起点。 */
export async function setup(
  options: { capacity?: SyncCapacityProfile; seed?: string; wrap?: WriterOptions["wrap"] } = {},
) {
  const runtime = createRuntime(options.capacity);
  await seed(runtime);
  const writer = newWriter(runtime, { seed: options.seed, wrap: options.wrap });
  await writer.acquire();
  return { ...runtime, writer } satisfies Fixture;
}

/** 带已封口导入历史的夹具：模拟历史先落库、写者随后 attach。 */
export async function setupWithHistory(
  historyRecords: readonly HistoryRecordFixture[],
  orphanRecords?: readonly HistoryRecordFixture[],
): Promise<Fixture> {
  const runtime = createRuntime();
  await seed(runtime, { historyRecords, orphanRecords });
  const writer = newWriter(runtime);
  await writer.acquire();
  return { ...runtime, writer };
}

/** attach 窗口补水：用户消息带 idempotent，同 turn 只能写一次。 */
export function userInput(turnId: string, delta: string): LiveInput {
  return {
    turnId,
    entryId: `${turnId}:user`,
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
    idempotent: true,
  };
}

/** 创建同轮次的流式文本输入，身份由用例明确指定。 */
export function textDelta(entryId: string, delta: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId,
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
  };
}

/** 创建会先冲刷已接纳文本的语义屏障。 */
export function semantic(kind: BarrierKind, payload: Record<string, unknown>): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "turn-1",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "semantic",
    semantic: { kind, payload },
  };
}

/** 读取真实存储的已提交快照，避免把写者内存当作结果。 */
export function committed(runtime: Runtime) {
  return runtime.store.exportCommittedState();
}

/** 读取指定文档的已提交更新账本。 */
export function updatesOf(runtime: Runtime, docId: string) {
  return committed(runtime).updates.filter((update) => update.docId === docId);
}

/** 读取指定文档的已提交元数据。 */
export function docOf(runtime: Runtime, docId: string) {
  return committed(runtime).docs.find((doc) => doc.docId === docId);
}

/** 按客户端的恢复路径重建文档：canonical base 快照 + 连续已提交 tail。 */
export function rebuild(runtime: Runtime, docId: string): Y.Doc {
  const stored = docOf(runtime, docId);
  if (stored === undefined) throw new Error(`document ${docId} is not committed`);
  const doc = new Y.Doc({ guid: docId });
  try {
    Y.applyUpdate(doc, stored.baseSnapshot);
    let seq = stored.baseSeq;
    for (const update of updatesOf(runtime, docId)
      .filter((update) => update.updateSeq > seq)
      .sort((a, b) => a.updateSeq - b.updateSeq)) {
      if (update.updateSeq !== seq + 1) throw new Error("fixture recovery tail is not contiguous");
      Y.applyUpdate(doc, update.bytes);
      seq = update.updateSeq;
    }
    if (seq !== stored.lastSeq) throw new Error("fixture recovery does not reach its committed frontier");
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** 从 canonical 和连续 tail 重建正文记录。 */
export function readRecords(runtime: Runtime, docId: string): LiveRecordValue[] {
  const records = rebuild(runtime, docId).getMap<unknown>("root").get("records");
  return records instanceof Y.Array ? (records.toArray() as LiveRecordValue[]) : [];
}

/** 按 UTF-8 解码记录载荷，供独立的正文断言使用。 */
export function textOf(record: LiveRecordValue): string {
  return TEXT_DECODER.decode(record.payload);
}

/** 从已提交运行态文档读取仍存活的实体。 */
export function readEntities(runtime: Runtime, docId: string): RuntimeEntityRecord[] {
  return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, rebuild(runtime, docId)).exportForRotation();
}

/** 仅调整本用例涉及的输入预算，其余沿用标准档案。 */
export function cappedCapacity(overrides: Partial<SyncCapacityProfile["inputs"]>): SyncCapacityProfile {
  return { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, ...overrides } };
}
