// packages/chat-channel/src/__tests__/sync-live-writer.test.ts
// D 阶段单写者编排（`sync/live/live-writer.ts`）的行为测试：合并与屏障、固定批次、结果未知三态、超硬上限重拆、
// 写权与租约 fencing、运行态轮换、崩溃恢复。断言跑在真实 `MemoryProjectionStore` 上——幂等键、前沿复核、封口
// 事务都是存储契约，用替身自证会掩盖实现与契约的分歧；唯一注入是 `wrap` 上的三个委托代理（在真实实现之上只改
// 回执或计数，不伪造结局）。

import { expect, test } from "bun:test";
import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import {
  type BarrierKind,
  createLiveWriter,
  LIVE_WRITER_LEASE_TTL_MS,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
} from "../sync/live/live-writer";
import type { RotationControllerOptions } from "../sync/live/rotation";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";
import {
  DIRECTORY_PAGE_SIZE,
  directoryPageDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../sync/protocol/directory";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  GenerationEntryRefs,
  ProjectionStore,
  SyncDocRecord,
  SyncGenerationRecord,
} from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
/** 引导租约：夹具用它登记代次与文档，随后过期，把写权让给被测写者。 */
const BOOTSTRAP_TTL_MS = 5_000;
/** 合并窗口远大于用例时长：冲刷只由屏障或字节阈值推动，不依赖真实定时器。 */
const MERGE = { maxDelayMs: 600_000, maxBytes: 1 << 20 };
const UTF8 = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

interface TimeControl {
  clock: Clock;
  advance(ms: number): void;
}

interface Runtime {
  store: MemoryProjectionStore;
  time: TimeControl;
  capacity: SyncCapacityProfile;
  runtimeId: string;
  contentId: string;
}

/** 可推进的测试时钟：租约过期、轮换期限与合并窗口都由它驱动，实现不得读真实时间。 */
function testTime(start = 1_000): TimeControl {
  let now = start;
  return { clock: { now: () => now }, advance: (ms) => (now += ms) };
}

function makeStore(clock: Clock, capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY): MemoryProjectionStore {
  return new MemoryProjectionStore({ clock, digest: sha256Digest, capacity, lifecycle: LIFECYCLE });
}

function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 空 Doc 的 canonical 字节：内容块与运行态 Doc 都以它为基线登记。 */
function emptyState(): Uint8Array {
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
async function seed(runtime: Runtime, options: { contentBlocks?: boolean } = {}): Promise<void> {
  const { store, time } = runtime;
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
    importEndOrdinal: null,
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
  for (const docId of contentDocIds) {
    await store.createDoc({
      scopeKey: SCOPE_KEY,
      epoch: lease.epoch,
      doc: docRecord(docId, "content", 0, emptyState()),
    });
  }
  // 引导租约到期：写者才能以新的 epoch 取得写权（存储不提供主动释放）。
  time.advance(BOOTSTRAP_TTL_MS + 1);
}

function createRuntime(capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY, start = 1_000): Runtime {
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

function newWriter(runtime: Runtime, options: WriterOptions = {}): LiveWriter {
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
async function setup(options: { capacity?: SyncCapacityProfile; seed?: string; wrap?: WriterOptions["wrap"] } = {}) {
  const runtime = createRuntime(options.capacity);
  await seed(runtime);
  const writer = newWriter(runtime, { seed: options.seed, wrap: options.wrap });
  await writer.acquire();
  return { ...runtime, writer } satisfies Fixture;
}

function textDelta(entryId: string, delta: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId,
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
  };
}

function semantic(kind: BarrierKind, payload: Record<string, unknown>): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "turn-1",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "semantic",
    semantic: { kind, payload },
  };
}

function committed(runtime: Runtime) {
  return runtime.store.exportCommittedState();
}

function updatesOf(runtime: Runtime, docId: string) {
  return committed(runtime).updates.filter((update) => update.docId === docId);
}

function docOf(runtime: Runtime, docId: string) {
  return committed(runtime).docs.find((doc) => doc.docId === docId);
}

/** 按客户端的恢复路径重建文档：canonical base 快照 + 连续已提交 tail。 */
function rebuild(runtime: Runtime, docId: string): Y.Doc {
  const stored = docOf(runtime, docId);
  if (stored === undefined) throw new Error(`document ${docId} is not committed`);
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, stored.baseSnapshot);
  for (const update of updatesOf(runtime, docId)) Y.applyUpdate(doc, update.bytes);
  return doc;
}

function readRecords(runtime: Runtime, docId: string): LiveRecordValue[] {
  const records = rebuild(runtime, docId).getMap<unknown>("root").get("records");
  return records instanceof Y.Array ? (records.toArray() as LiveRecordValue[]) : [];
}

function textOf(record: LiveRecordValue): string {
  return TEXT_DECODER.decode(record.payload);
}

function readEntities(runtime: Runtime, docId: string): RuntimeEntityRecord[] {
  return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, rebuild(runtime, docId)).exportForRotation();
}

function cappedCapacity(overrides: Partial<SyncCapacityProfile["inputs"]>): SyncCapacityProfile {
  return { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, ...overrides } };
}

/** 把存储换成"只改回执/计数"的委托代理：除指定方法外一律转交真实实现。 */
function wrapStore(target: ProjectionStore, handler: (input: AppendUpdatesInput) => Promise<AppendUpdatesResult>) {
  return new Proxy(target, {
    get(source, property, receiver) {
      const value: unknown = Reflect.get(source, property, receiver);
      if (property !== "appendUpdates" || typeof value !== "function") return value;
      return (input: AppendUpdatesInput) => handler(input);
    },
  }) as ProjectionStore;
}

/** 只统计并发度：提交前后各留一次事件循环，未串行的批次会在这里暴露重叠。 */
function countingStore(target: ProjectionStore, counters: { inFlight: number; maxInFlight: number; calls: number }) {
  return wrapStore(target, async (input) => {
    counters.calls += 1;
    counters.inFlight += 1;
    counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await target.appendUpdates(input);
    } finally {
      counters.inFlight -= 1;
    }
  });
}

/** 先真实提交再报「未知」：模拟写入已落库但回执丢失。 */
function unknownAfterWrite(target: ProjectionStore, counters: { calls: number }, docId: string) {
  return wrapStore(target, async (input) => {
    if (input.updates[0].docId !== docId) return await target.appendUpdates(input);
    counters.calls += 1;
    if (counters.calls > 1) return await target.appendUpdates(input);
    await target.appendUpdates(input);
    return { outcome: "unknown", frontiers: [] };
  });
}

/** 第一次提交直接答「未知」且不落库：确定未提交的重放场景。 */
function unknownWithoutWrite(target: ProjectionStore, seen: AppendUpdatesInput[]) {
  let attempts = 0;
  return wrapStore(target, async (input) => {
    attempts += 1;
    seen.push(input);
    if (attempts > 1) return await target.appendUpdates(input);
    return { outcome: "unknown", frontiers: [] };
  });
}

/** 用异摘要真实落库再答「未知」：同幂等键下已存在别人的字节，写者必须停写。 */
function unknownWithOtherDigest(target: ProjectionStore) {
  let attempts = 0;
  return wrapStore(target, async (input) => {
    attempts += 1;
    if (attempts > 1) return await target.appendUpdates(input);
    await target.appendUpdates({ ...input, digest: `${input.digest}:other` });
    return { outcome: "unknown", frontiers: [] };
  });
}

// 同键同窗口的增量必须合并成一条正文记录，并且在语义事件推进之前完成提交。
test("同键增量合并为一条记录，语义屏障先冲刷再推进", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "he"));
  await fix.writer.accept(textDelta("entry-1", "llo"));
  await fix.writer.accept(textDelta("entry-1", "!"));
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello!"]);
  expect(updatesOf(fix, fix.contentId)).toHaveLength(1);
  expect(updatesOf(fix, fix.runtimeId)).toHaveLength(1);
  await fix.writer.close();
});

// 换消息或跨语义屏障的正文属于不同片段：合并它们会把两段内容拼到一起，读者无法再分开。
test("键切换与语义屏障隔离正文，前后不跨屏障合并", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "a"));
  await fix.writer.accept(textDelta("entry-2", "b"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  await fix.writer.accept(textDelta("entry-1", "c"));
  await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  const records = readRecords(fix, fix.contentId).map((record) => [record.entryId, textOf(record), record.partIndex]);
  expect(records).toEqual([
    ["entry-1", "a", 0],
    ["entry-2", "b", 0],
    ["entry-1", "c", 1],
  ]);
  await fix.writer.close();
});

// `commit(pending)` 的 batchId、序号区间、摘要与字节由调用方固定：必须原样落到已提交记录上。
test("commit 按公开字段固定批次并写入存储", async () => {
  const fix = await setup();
  const payload = recordUpdate(fix.contentId, "direct");
  const batchId = "batch-direct";
  const digest = sha256Digest(payload);
  const outcome = await fix.writer.commit({
    batchId,
    docId: fix.contentId,
    ordinalStart: 1,
    ordinalEnd: 1,
    digest,
    payload,
  });
  expect(outcome).toBe("committed");
  const [update] = updatesOf(fix, fix.contentId);
  expect([update.batchId, update.updateSeq, update.digest]).toEqual([batchId, 1, digest]);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["direct"]);
  await fix.writer.close();
});

// 摘要是幂等键的一半：字节与摘要不符、序号与前沿不连续、区间长度不为 1 都必须在落库前拒绝。
test("commit 拒绝异摘要、不连续序号与多片区间", async () => {
  const fix = await setup();
  const payload = recordUpdate(fix.contentId, "direct");
  const digest = sha256Digest(payload);
  const batchId = "batch-reject";
  const base = { batchId, docId: fix.contentId, ordinalStart: 1, ordinalEnd: 1, payload };
  await expect(fix.writer.commit({ ...base, digest: "not-the-digest" })).rejects.toMatchObject({
    code: "DIGEST_CONFLICT",
  });
  await expect(fix.writer.commit({ ...base, ordinalStart: 2, ordinalEnd: 2, digest })).rejects.toMatchObject({
    code: "SEQUENCE_GAP",
  });
  await expect(fix.writer.commit({ ...base, ordinalEnd: 2, digest })).rejects.toMatchObject({
    code: "MALFORMED_FRAME",
  });
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.close();
});

// 每 scope 最多一个未决批次：并发接收的写入必须串行提交，任何时刻都不得有两个批次同时在飞。
test("并发写入串行提交，任一时刻只有一个未决批次", async () => {
  const counters = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const fix = await setup({ wrap: (runtime) => countingStore(runtime.store, counters) });
  await fix.writer.accept(textDelta("entry-1", "a"));
  await fix.writer.accept(textDelta("entry-2", "b"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(counters.maxInFlight).toBe(1);
  expect(counters.calls).toBeGreaterThanOrEqual(3);
  await fix.writer.close();
});

// 结果未知时先查询：同批同摘要已在存储里 = 成功，不得再执行一次输入（重放副作用无法回滚）。
test("unknown 且同批同摘要已存在：确认成功且不重放输入", async () => {
  const counters = { calls: 0 };
  const fix = await setup({ wrap: (runtime) => unknownAfterWrite(runtime.store, counters, runtime.contentId) });
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(counters.calls).toBe(1);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello"]);
  expect(updatesOf(fix, fix.contentId)).toHaveLength(1);
  await fix.writer.close();
});

// 确定未提交且写权仍在时重放原字节：幂等键、摘要与字节必须逐字相同，重放后内容只出现一次。
test("unknown 且确定未提交：重放同一份字节直到提交", async () => {
  const seen: AppendUpdatesInput[] = [];
  const fix = await setup({ wrap: (runtime) => unknownWithoutWrite(runtime.store, seen) });
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  const content = seen.filter((input) => input.updates[0].docId === fix.contentId);
  expect(content).toHaveLength(2);
  expect(content[1].batchId).toBe(content[0].batchId);
  expect(content[1].digest).toBe(content[0].digest);
  expect(content[1].updates).toEqual(content[0].updates);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello"]);
  await fix.writer.close();
});

// 异摘要意味着同幂等键下已有别人的字节：无从判定更不能覆盖，写者必须停写且不再接受任何输入。
test("unknown 且查询到异摘要：写者停写", async () => {
  const fix = await setup({ wrap: (runtime) => unknownWithOtherDigest(runtime.store) });
  const first = async () => {
    await fix.writer.accept(textDelta("entry-1", "hello"));
    await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  };
  await expect(first()).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
  await expect(fix.writer.accept(textDelta("entry-1", "later"))).rejects.toMatchObject({
    code: "COMMIT_OUTCOME_UNKNOWN",
  });
  await fix.writer.close();
});

// 记录超限只拆记录；Doc 仍有空间时不得无谓封口或生成空前驱块。
test("正文按记录预算拆分且复用仍有空间的块", async () => {
  const capacity = cappedCapacity({ activeHardEncodedBytes: 4_096, payloadChunkMaxBytes: 64 });
  const fix = await setup({ capacity });
  const text = "x".repeat(200);
  await fix.writer.accept(textDelta("entry-1", text));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(updatesOf(fix, fix.contentId)).toHaveLength(4);
  expect(docOf(fix, fix.contentId)?.state).toBe("active");
  const pieces = readRecords(fix, fix.contentId);
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces.map(textOf).join("")).toBe(text);
  for (const piece of pieces) expect(piece.payload.byteLength).toBeLessThanOrEqual(64);
  await fix.writer.close();
});

// 重拆一次后仍超硬上限：报容量错误并停在该处，既不无限重拆，也不把超限字节留在已提交边界上。
test("重拆仍超硬上限时报容量错误且不发布", async () => {
  const capacity = cappedCapacity({ activeHardEncodedBytes: 24, payloadChunkMaxBytes: 64 });
  const fix = await setup({ capacity });
  const overflow = async () => {
    await fix.writer.accept(textDelta("entry-1", "x".repeat(32)));
    await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  };
  await expect(overflow()).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.close();
});

// 拿不到写权就不能写：租约被他人持有时 acquire 直接拒绝（SCOPE_BUSY），本层不排队等待。
test("租约被占时 acquire 拒绝，未持写权的写入一律失败", async () => {
  const runtime = createRuntime();
  await seed(runtime);
  const held = await runtime.store.acquireWriter(SCOPE_KEY, "other-writer", 60_000);
  expect(held.owner).toBe("other-writer");
  const writer = newWriter(runtime);
  await expect(writer.acquire()).rejects.toMatchObject({ code: "SCOPE_BUSY" });
  await expect(writer.accept(textDelta("entry-1", "a"))).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  await writer.close();
});

// 租约过期后旧 epoch 的写入被拒：fencing 由存储判定，写者随即停写，后续输入不再落库。
test("租约过期后旧 epoch 写入被拒并停写", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "before"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  fix.time.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
  const expired = async () => {
    await fix.writer.accept(textDelta("entry-1", "after"));
    await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  };
  await expect(expired()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  await expect(fix.writer.accept(textDelta("entry-1", "later"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["before"]);
  await fix.writer.close();
});

// 轮换产出 (oldDocId, newDocId, requiredBaseSeq)：旧版封口后不再接受写入，未结束实体必须被搬运到新块。
test("rotateRuntime 返回旧新文档与基线序号，旧版停止写入", async () => {
  const fix = await setup();
  await fix.writer.accept(semantic("tool", { entityId: "tool-1", metadata: { title: "read" } }));
  const rotated = await fix.writer.rotateRuntime();
  expect(rotated.oldDocId).toBe(fix.runtimeId);
  expect(rotated.newDocId).not.toBe(fix.runtimeId);
  expect(rotated.requiredBaseSeq).toBe(0);
  expect(docOf(fix, fix.runtimeId)?.state).toBe("sealed");
  expect(docOf(fix, rotated.newDocId)?.state).toBe("active");
  expect(readEntities(fix, rotated.newDocId).map((entity) => entity.entityId)).toEqual(["tool-1"]);
  const sealedUpdates = updatesOf(fix, fix.runtimeId).length;
  await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  expect(updatesOf(fix, fix.runtimeId)).toHaveLength(sealedUpdates);
  expect(readEntities(fix, rotated.newDocId).map((entity) => entity.entityId)).toEqual(["tool-1", "err-1"]);
  await fix.writer.close();
});

// 内容块轮换必须同步维护目录：新块追加到最新页，否则客户端永远发现不了轮换后的 live 内容。
test("内容块轮换后把 successor 追加到目录页", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.seal();

  const contentDocs = committed(fix).docs.filter((doc) => doc.kind === "content");
  const successor = contentDocs.find((doc) => doc.state === "active");
  if (successor === undefined) throw new Error("expected an active successor content doc");
  expect(contentDocs).toHaveLength(2);

  const rootDoc = rebuild(fix, docIdFor("directory", 0, "directory"));
  const { latestPageId } = readDirectoryRoot(rootDoc);
  expect(latestPageId).toBe(directoryPageDocId(GENERATION, 1));
  if (latestPageId === null) throw new Error("expected latest directory page");

  const pageDoc = rebuild(fix, latestPageId);
  expect(readDirectoryPage(pageDoc).contentDocIds).toEqual([fix.contentId, successor.docId]);
  await fix.writer.close();
});

// 页满后必须滚动到新页：旧页保持固定条数，新页链接旧页，根目录原子切到新页。
test("目录页满后轮换到新页并保留上一页链接", async () => {
  const fix = await setup();
  // 初始页已有入口块，再追加 DIRECTORY_PAGE_SIZE 个 successor 触发一次轮换。
  for (let index = 0; index < DIRECTORY_PAGE_SIZE; index += 1) {
    await fix.writer.seal();
  }

  const rootDoc = rebuild(fix, docIdFor("directory", 0, "directory"));
  const { latestPageId } = readDirectoryRoot(rootDoc);
  expect(latestPageId).toBe(directoryPageDocId(GENERATION, 2));
  if (latestPageId === null) throw new Error("expected rotated directory page");

  const firstPage = readDirectoryPage(rebuild(fix, directoryPageDocId(GENERATION, 1)));
  expect(firstPage.contentDocIds).toHaveLength(DIRECTORY_PAGE_SIZE);
  expect(firstPage.previousPageId).toBeNull();

  const secondPage = readDirectoryPage(rebuild(fix, latestPageId));
  expect(secondPage.contentDocIds).toHaveLength(1);
  expect(secondPage.previousPageId).toBe(directoryPageDocId(GENERATION, 1));
  await fix.writer.close();
});

// 崩溃后只能依赖已提交边界：新写者从 canonical + 连续 tail 重建，接着旧文档与旧片段序号继续写。
test("recover 从已提交 canonical + 连续 tail 重建", async () => {
  const first = await setup({ seed: "writer-before-crash" });
  await first.writer.accept(textDelta("entry-1", "hello"));
  await first.writer.accept(semantic("tool", { entityId: "tool-1" }));
  await first.writer.close();
  // 快照里只有已提交字节：旧写者的内存游标与未提交输入都不参与恢复。
  const snapshot = first.store.exportCommittedState();
  const time = testTime(1_000);
  const restored = makeStore(time.clock);
  restored.restoreFromCommittedState(snapshot);
  const runtime: Runtime = {
    store: restored,
    time,
    capacity: first.capacity,
    runtimeId: first.runtimeId,
    contentId: first.contentId,
  };
  const second = newWriter(runtime, { seed: "writer-after-crash" });
  await second.acquire();
  await second.recover();
  await second.accept(textDelta("entry-1", " world"));
  await second.accept(semantic("error", { entityId: "err-1" }));
  const records = readRecords(runtime, runtime.contentId);
  expect(records.map((record) => [textOf(record), record.partIndex])).toEqual([
    ["hello", 0],
    [" world", 1],
  ]);
  expect(updatesOf(runtime, runtime.contentId).map((update) => update.updateSeq)).toEqual([1, 2]);
  await second.close();
});

/** 造一份与写者同构的内容块更新：一条正文记录，用于驱动 `commit(pending)` 的公开路径。 */
function recordUpdate(docId: string, text: string): Uint8Array {
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, emptyState());
  const before = Y.encodeStateVector(doc);
  const records = new Y.Array<LiveRecordValue>();
  doc.getMap<unknown>("root").set("records", records);
  records.push([
    {
      recordId: `rec_${text}`,
      entryId: "entry-1",
      contentSlot: "text",
      contentType: "text/plain",
      partIndex: 0,
      kind: "text",
      payload: UTF8.encode(text),
    },
  ]);
  const bytes = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return bytes;
}
