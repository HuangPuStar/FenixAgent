// packages/chat-channel/src/__tests__/sync-import-service.test.ts
// C2 历史导入编排（规格 §5.7）的行为守护：接收窗口与边界冻结、按 sourceOrdinal 的有限构建、
// 已提交目录的完整性验证、原子换代与失败路径的资源归还。
//
// 全部走真实实现：`MemoryProjectionStore`（内存适配器）+ 临时目录上的 `HistorySpool` + `BlockBuildPool`
// + 注入的确定性随机源与固定时钟；不 mock 模块、不读环境变量，也不为任何已知缺陷打补丁。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, type DigestFn, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { buildContentBlock } from "../sync/history/block-builder";
import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { fidelitySerialize } from "../sync/history/fidelity-json";
import { type BuildBlockFn, HistoryImportService } from "../sync/history/import-service";
import type { HistoryRecordMeta } from "../sync/history/ingest";
import { HistorySpool } from "../sync/history/spool";
import { SyncProtocolError } from "../sync/protocol/errors";
import { type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  CommitGenerationInput,
  CommitGenerationResult,
  CommitOutcome,
  GenerationEntryRefs,
  PutSealedInput,
  PutSealedResult,
  StoreLifecycleOptions,
  SyncGenerationRecord,
  WriterLease,
} from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org_sync_import", rcsSessionId: "rcs_session_import" };
const SCOPE_KEY = scopeKey(SCOPE);
const OWNER = "import-owner";
const ACP_SESSION_ID = "ses_import_service_test";
const LEASE_TTL_MS = 60_000;
/** 固定时间源：租约不过期、退役时间可逐字断言，整套用例无时间抖动。 */
const FIXED_NOW = 1_700_000_000_000;
const clock: Clock = { now: () => FIXED_NOW };
const digest: DigestFn = sha256Digest;
/** 块目标载荷压到 64B：每条记录各自成块，才能验证「多块 + 乱序完成」的目录语义。 */
const BLOCK_TARGET_BYTES = 64;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 测试仓库的容量 profile：只改块目标，其余沿用冻结默认值（池上限与公平权重不变）。 */
function capacityWithBlockTarget(targetPayloadBytes: number): SyncCapacityProfile {
  return {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, historyBlockTargetPayloadBytes: targetPayloadBytes },
  };
}

/** 内存适配器的构造参数；`lifecycle` 必填（适配器不内置宽限期默认值）。 */
function storeOptions(capacity: SyncCapacityProfile): {
  clock: Clock;
  digest: DigestFn;
  capacity: SyncCapacityProfile;
  lifecycle: StoreLifecycleOptions;
} {
  return { clock, digest, capacity, lifecycle: { sealGraceMs: 1000, retireGraceMs: 1000 } };
}

/**
 * 测试存储：真实 `MemoryProjectionStore`，只加两项记录设施，读写语义与生产实现完全一致。
 *
 * - `holdBlockUntil` / `completionOrder`：让某个块的封口写入等另一个块先落地，用来构造乱序完成。
 * - `commitInputs`：原样记录换代提交入参，供幂等重放断言使用（不改写任何返回值）。
 */
class ImportServiceTestStore extends MemoryProjectionStore {
  /** 已落盘块的完成顺序（按块序）：证明目录顺序不是提交顺序的复读。 */
  readonly completionOrder: number[] = [];
  readonly commitInputs: CommitGenerationInput[] = [];
  private readonly gates = new Map<number, { promise: Promise<void>; release: () => void }>();
  private readonly holds = new Map<number, number>();

  /** 让 `blockIndex` 的落盘等待 `waitForIndex` 的块先落地；用于验证「乱序完成仍按 ordinal 排列」。 */
  holdBlockUntil(blockIndex: number, waitForIndex: number): void {
    this.holds.set(blockIndex, waitForIndex);
  }

  override async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    const blockIndex = input.doc.blockIndex ?? -1;
    const waitFor = this.holds.get(blockIndex);
    if (waitFor !== undefined) {
      await this.gate(waitFor).promise;
    }
    const result = await super.putSealedIfAbsent(input);
    this.completionOrder.push(blockIndex);
    this.gate(blockIndex).release();
    return result;
  }

  override async commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
    const result = await super.commitGeneration(input);
    this.commitInputs.push(input);
    return result;
  }

  private gate(blockIndex: number): { promise: Promise<void>; release: () => void } {
    const existing = this.gates.get(blockIndex);
    if (existing !== undefined) {
      return existing;
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { promise, release };
    this.gates.set(blockIndex, entry);
    return entry;
  }
}

interface Harness {
  store: ImportServiceTestStore;
  spool: HistorySpool;
  pool: BlockBuildPool;
  admission: AdmissionController;
  service: HistoryImportService;
}

/** 装配一套真实依赖；`buildBlock` 缺省即 canonical 块构建器。 */
async function createHarness(
  options: { capacity?: SyncCapacityProfile; buildBlock?: BuildBlockFn } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "sync-import-"));
  tempRoots.push(root);
  const capacity = options.capacity ?? capacityWithBlockTarget(BLOCK_TARGET_BYTES);
  const store = new ImportServiceTestStore(storeOptions(capacity));
  const admission = new AdmissionController(capacity);
  const pool = new BlockBuildPool(deriveBuildPoolConfig(capacity.fairness), admission, clock);
  const spool = new HistorySpool(
    { basePath: join(root, "spool"), segmentBytes: 1024, taskQuotaBytes: 64 * 1024, processQuotaBytes: 256 * 1024 },
    clock,
  );
  const service = new HistoryImportService({
    store,
    spool,
    pool,
    clock,
    digest,
    capacity,
    rand: deterministicRandomSource("sync-import-service"),
    admission,
    ...(options.buildBlock === undefined ? {} : { buildBlock: options.buildBlock }),
  });
  return { store, spool, pool, admission, service };
}

function beginInput(): { scope: SyncScope; acpSessionId: string; owner: string; leaseTtlMs: number } {
  return { scope: SCOPE, acpSessionId: ACP_SESSION_ID, owner: OWNER, leaseTtlMs: LEASE_TTL_MS };
}

const RECORD_PADDING = "x".repeat(96);

/** 一条历史对象：载荷远大于块目标，保证每条记录独占一块。 */
function recordValue(ordinal: number): Record<string, unknown> {
  return { role: "assistant", text: `record-${ordinal}-${RECORD_PADDING}` };
}

function recordMeta(ordinal: number): HistoryRecordMeta {
  return { kind: "history_object", entryId: `entry-${ordinal}` };
}

/** 接收 `count` 条记录并冻结接收边界。 */
async function receiveAll(service: HistoryImportService, count: number): Promise<void> {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await service.accept(recordValue(ordinal), recordMeta(ordinal));
  }
  await service.receivingComplete();
}

/** 捕获同步协议错误：其它异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
async function captureSyncError(run: () => Promise<unknown>): Promise<SyncProtocolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

/** 失败路径的资源账目必须全部归零：暂存配额、构建池在飞任务与 historyBuild 额度。 */
function expectResourcesReleased(harness: Harness): void {
  expect(harness.spool.stats().totalBytes).toBe(0);
  expect(harness.pool.stats().running).toBe(0);
  expect(harness.pool.stats().queued).toBe(0);
  expect(harness.admission.used("historyBuild")).toBe(0);
}

/** 与服务内部 `buildEntryClosure` 同形的入口闭包；播种的旧代次只验证换代与指针，不覆盖内容块。 */
function entryClosureOf(generation: string): GenerationEntryRefs {
  return {
    controlDocId: `sync/control/${generation}/0/control`,
    directoryDocId: `sync/directory/${generation}/0/directory`,
    runtimeDocId: `sync/runtime/${generation}/0/runtime`,
    contentDocIds: [],
  };
}

/** 播种一个已提交的旧代次（不经过导入服务）：用于验证换代、旧代退役与指针递增。 */
async function seedCommittedGeneration(store: MemoryProjectionStore, lease: WriterLease): Promise<string> {
  const generation = "gen_seeded_previous";
  const entryRefs = entryClosureOf(generation);
  const record: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation,
    acpSessionId: ACP_SESSION_ID,
    loadId: "load_seeded_previous",
    state: "staging",
    importEndOrdinal: 1,
    entryRefs,
    createdAt: FIXED_NOW,
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation: record });
  const snapshot = new TextEncoder().encode("seeded-content-block");
  await store.putSealedIfAbsent({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: {
      scopeKey: SCOPE_KEY,
      generation,
      docId: `sync/content/${generation}/0/seeded`,
      kind: "content",
      state: "sealed",
      snapshot,
      hash: sha256Digest(snapshot),
      baseSeq: 0,
      finalSeq: 0,
      blockIndex: 0,
      ordinalStart: 1,
      ordinalEnd: 1,
      dependsOn: [],
    },
  });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    expectedCurrent: null,
    newGeneration: record,
    retired: [],
    entryClosure: entryRefs,
    expectedPointerRevision: 0,
  });
  return generation;
}

/** 导入服务 `finalize` 的返回形状；与存储的 `CommitGenerationResult` 不同（前者用 `generation`）。 */
interface FinalizeResult {
  outcome: CommitOutcome;
  generation: string;
  pointerRevision: number;
}

/** 完整导入并换代；`previous` 为真时先播种一个已提交的旧代次。 */
async function importAndFinalize(
  harness: Harness,
  options: { records?: number; previous?: boolean } = {},
): Promise<{ generation: string; loadId: string; previous: string | null; result: FinalizeResult }> {
  const lease = await harness.store.acquireWriter(SCOPE_KEY, OWNER, LEASE_TTL_MS);
  const previous = options.previous === true ? await seedCommittedGeneration(harness.store, lease) : null;
  const began = await harness.service.begin(beginInput());
  await receiveAll(harness.service, options.records ?? 2);
  await harness.service.buildAndCommit();
  const result = await harness.service.finalize();
  return { ...began, previous, result };
}

describe("HistoryImportService 接收与冻结", () => {
  // 意图：begin 必须产出新的 loadId/generation 并进入接收窗口；撕裂后重试必须换新 loadId，不得续写旧目录。
  test("begin 新建 generation/loadId，重试得到不同 loadId", async () => {
    const harness = await createHarness();
    const first = await harness.service.begin(beginInput());
    expect(first.generation).toMatch(/^gen_[0-9a-f]{32}$/);
    expect(first.loadId).toMatch(/^load_[0-9a-f]{32}$/);
    expect(harness.service.status()).toMatchObject({
      state: "receiving",
      generation: first.generation,
      loadId: first.loadId,
      receivedOrdinal: 0,
      committedBlocks: 0,
      gaps: [],
    });

    await harness.service.accept(recordValue(1), recordMeta(1));
    // 同一身份二次提交即撕裂本次尝试（旧编号空间不再可能拼成完整导入）。
    await captureSyncError(() => harness.service.accept(recordValue(1), recordMeta(1)));
    const second = await harness.service.begin(beginInput());
    expect(second.loadId).not.toBe(first.loadId);
    expect(second.generation).not.toBe(first.generation);
    expect(harness.service.status()).toMatchObject({ state: "receiving", loadId: second.loadId, receivedOrdinal: 0 });
  });

  // 意图：一个实例同一时刻只承载一次导入，未清理的尝试必须拒绝新 begin，也不能悄悄多建一个暂存任务。
  test("未清理的尝试上 begin 抛 SCOPE_BUSY，且不新建暂存任务", async () => {
    const harness = await createHarness();
    const first = await harness.service.begin(beginInput());
    const error = await captureSyncError(() => harness.service.begin(beginInput()));
    expect(error.code).toBe("SCOPE_BUSY");
    expect(harness.service.status().loadId).toBe(first.loadId);
    expect([...harness.spool.stats().taskBytes.keys()]).toEqual([first.loadId]);
  });

  // 意图：未 begin 时所有导入动作都必须是 IMPORT_INCOMPLETE，status 给出空快照而不是伪造状态。
  test("未 begin 时各动作抛 IMPORT_INCOMPLETE，status 返回空失败快照", async () => {
    const harness = await createHarness();
    expect(harness.service.status()).toEqual({
      state: "failed",
      generation: "",
      loadId: "",
      receivedOrdinal: 0,
      committedBlocks: 0,
      gaps: [],
    });
    expect((await captureSyncError(() => harness.service.accept(recordValue(1), recordMeta(1)))).code).toBe(
      "IMPORT_INCOMPLETE",
    );
    expect((await captureSyncError(() => harness.service.receivingComplete())).code).toBe("IMPORT_INCOMPLETE");
    expect((await captureSyncError(() => harness.service.buildAndCommit())).code).toBe("IMPORT_INCOMPLETE");
    expect((await captureSyncError(() => harness.service.finalize())).code).toBe("IMPORT_INCOMPLETE");
  });

  // 意图：编号由服务签发、从 1 起连续，字节口径必须与保真序列化一致（摘要由同一份字节复算）。
  test("accept 从 1 起连续编号并回报保真字节数与摘要", async () => {
    const harness = await createHarness();
    const began = await harness.service.begin(beginInput());
    const value = recordValue(1);
    const canonical = fidelitySerialize(value);
    const first = await harness.service.accept(value, recordMeta(1));
    expect(first).toMatchObject({
      loadId: began.loadId,
      generation: began.generation,
      sourceOrdinal: 1,
      kind: "history_object",
      payloadBytes: canonical.byteLength,
      digest: sha256Digest(canonical),
    });
    const second = await harness.service.accept(recordValue(2), recordMeta(2));
    expect(second.sourceOrdinal).toBe(2);
    expect(harness.service.status().receivedOrdinal).toBe(2);
    expect(harness.spool.stats().totalBytes).toBe(canonical.byteLength + fidelitySerialize(recordValue(2)).byteLength);
  });

  // 意图：边界冻结先于任何异步构建分派，冻结后接收窗口立即关闭，但已接收字节仍保留给构建读取。
  test("边界冻结后 accept 抛 IMPORT_INCOMPLETE，尝试留在 receivingComplete", async () => {
    const harness = await createHarness();
    await harness.service.begin(beginInput());
    await receiveAll(harness.service, 2);
    const error = await captureSyncError(() => harness.service.accept(recordValue(3), recordMeta(3)));
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(harness.service.status()).toMatchObject({ state: "receivingComplete", receivedOrdinal: 2 });
    expect(harness.spool.stats().totalBytes).toBeGreaterThan(0);
  });

  // 意图：load 响应重传导致重复冻结必须幂等，且封存只发生一次、后续构建仍能覆盖完整边界。
  test("receivingComplete 幂等，重复调用后仍可完成构建", async () => {
    const harness = await createHarness();
    await harness.service.begin(beginInput());
    await harness.service.accept(recordValue(1), recordMeta(1));
    await harness.service.receivingComplete();
    await harness.service.receivingComplete();
    expect(harness.service.status()).toMatchObject({ state: "receivingComplete", receivedOrdinal: 1 });
    await harness.service.buildAndCommit();
    expect(harness.service.status()).toMatchObject({ state: "importComplete", committedBlocks: 1 });
  });

  // 意图：重复对象是本次 load 的撕裂（编号空间不再完整），必须失败并归还全部资源，不允许静默去重。
  test("重复对象抛 DUPLICATE_OBJECT 并释放本次 load 的资源", async () => {
    const harness = await createHarness();
    await harness.service.begin(beginInput());
    await harness.service.accept(recordValue(1), recordMeta(1));
    const error = await captureSyncError(() => harness.service.accept(recordValue(1), recordMeta(1)));
    expect(error.code).toBe("DUPLICATE_OBJECT");
    expect(error.retryable).toBe(false);
    expect(harness.service.status()).toMatchObject({
      state: "failed",
      failure: { code: "DUPLICATE_OBJECT", retryable: false },
    });
    expectResourcesReleased(harness);
  });
});

describe("HistoryImportService 构建与完整性", () => {
  // 意图：块可以乱序完成，但已提交目录必须按 sourceOrdinal 排列、无缺口且覆盖到接收边界。
  test("乱序完成的多个块按 sourceOrdinal 排列且目录 complete", async () => {
    const harness = await createHarness();
    harness.store.holdBlockUntil(0, 1);
    const began = await harness.service.begin(beginInput());
    await receiveAll(harness.service, 2);
    await harness.service.buildAndCommit();

    expect(harness.store.completionOrder).toEqual([1, 0]);
    const page = await harness.store.readDirectory({ generation: began.generation, limit: 10 });
    expect(page.entries.map((entry) => [entry.ordinalStart, entry.ordinalEnd])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(page.complete).toBe(true);
    expect(harness.service.status()).toMatchObject({
      state: "importComplete",
      receivedOrdinal: 2,
      committedBlocks: 2,
      gaps: [],
    });
  });

  // 意图：目录没有覆盖到接收边界时必须抛 IMPORT_INCOMPLETE，且不写换代指针；`begin` 按设计 §5.1 登记的
  // staging 代次不因失败被改写——它只留在 staging，既不是 committed 也不算「改写了代次」。
  test("目录覆盖不足接收边界时抛 IMPORT_INCOMPLETE 且不改写指针与代次", async () => {
    // 默认块目标：3 条记录落进同一块；注入的构建函数丢最后一条，目录只覆盖到 ordinal 2。
    const droppingBuild: BuildBlockFn = (input) =>
      buildContentBlock({ ...input, records: input.records.slice(0, input.records.length - 1) });
    const harness = await createHarness({ capacity: DEFAULT_SYNC_CAPACITY, buildBlock: droppingBuild });
    const lease = await harness.store.acquireWriter(SCOPE_KEY, OWNER, LEASE_TTL_MS);
    const previous = await seedCommittedGeneration(harness.store, lease);
    const began = await harness.service.begin(beginInput());
    await receiveAll(harness.service, 3);

    const error = await captureSyncError(() => harness.service.buildAndCommit());
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(harness.service.status()).toMatchObject({
      state: "failed",
      failure: { code: "IMPORT_INCOMPLETE", retryable: false },
    });
    const pointer = await harness.store.readScopePointer(SCOPE_KEY);
    expect({ current: pointer?.currentGeneration, revision: pointer?.pointerRevision }).toEqual({
      current: previous,
      revision: 1,
    });
    const staged = await harness.store.readGeneration(SCOPE_KEY, began.generation);
    expect(staged).not.toBeNull();
    expect(staged?.state).not.toBe("committed");
    expectResourcesReleased(harness);
  });

  // 意图：块摘要与其字节不符时提交器必须先拒绝（占位键不可用时写入等于污染该 docId）。
  test("块摘要与 canonical 字节不符时以 DIGEST_CONFLICT 失败且不写入块", async () => {
    const corruptedHashBuild: BuildBlockFn = (input) => ({ ...buildContentBlock(input), hash: "0".repeat(64) });
    const harness = await createHarness({ buildBlock: corruptedHashBuild });
    const began = await harness.service.begin(beginInput());
    await receiveAll(harness.service, 1);

    const error = await captureSyncError(() => harness.service.buildAndCommit());
    expect(error.code).toBe("DIGEST_CONFLICT");
    expect(harness.service.status()).toMatchObject({
      state: "failed",
      failure: { code: "DIGEST_CONFLICT", retryable: false },
    });
    expect((await harness.store.readDirectory({ generation: began.generation, limit: 10 })).entries).toEqual([]);
    expectResourcesReleased(harness);
  });

  // 意图：构建任务的失败必须按原错误码透传（池不包装异常），并结算额度、标记可重试。
  test("构建任务抛错时按原码失败、可重试且额度归零", async () => {
    const refusingBuild: BuildBlockFn = () => {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "build refused by test" });
    };
    const harness = await createHarness({ buildBlock: refusingBuild });
    await harness.service.begin(beginInput());
    await receiveAll(harness.service, 1);

    const error = await captureSyncError(() => harness.service.buildAndCommit());
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(harness.service.status()).toMatchObject({
      state: "failed",
      failure: { code: "CAPACITY_EXCEEDED", retryable: true },
    });
    expectResourcesReleased(harness);
  });

  // 意图：零记录导入不是「完整导入」——空目录不得冒充已同步的历史，必须显式失败。
  test("零记录导入抛 IMPORT_INCOMPLETE", async () => {
    const harness = await createHarness();
    await harness.service.begin(beginInput());
    await harness.service.receivingComplete();
    const error = await captureSyncError(() => harness.service.buildAndCommit());
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(harness.service.status()).toMatchObject({ state: "failed", committedBlocks: 0, receivedOrdinal: 0 });
    expectResourcesReleased(harness);
  });

  // 意图：构建尚未通过完整性验证时不得换代，finalize 必须失败并清理本次 load。
  test("未完成构建就 finalize 抛 IMPORT_INCOMPLETE 并清理资源", async () => {
    const harness = await createHarness();
    await harness.service.begin(beginInput());
    await receiveAll(harness.service, 1);
    const error = await captureSyncError(() => harness.service.finalize());
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(harness.service.status()).toMatchObject({
      state: "failed",
      failure: { code: "IMPORT_INCOMPLETE", retryable: false },
    });
    expectResourcesReleased(harness);
  });
});

describe("HistoryImportService 换代与幂等", () => {
  // 意图：换代必须一次性生效——指针指向新代、旧代 retired、pointerRevision 递增，新代记录为 committed。
  test("finalize 成功：指针指向新代、旧代 retired、pointerRevision 递增", async () => {
    const harness = await createHarness();
    const { generation, previous, result } = await importAndFinalize(harness, { previous: true, records: 2 });
    expect(previous).not.toBeNull();
    expect(result).toEqual({ outcome: "committed", generation, pointerRevision: 2 });
    const pointer = await harness.store.readScopePointer(SCOPE_KEY);
    expect({ current: pointer?.currentGeneration, revision: pointer?.pointerRevision }).toEqual({
      current: generation,
      revision: 2,
    });
    expect((await harness.store.readGeneration(SCOPE_KEY, previous as string))?.state).toBe("retired");
    expect((await harness.store.readGeneration(SCOPE_KEY, generation))?.state).toBe("committed");
  });

  // 意图：提交结果已确认时重复 finalize 是空操作——返回同一结果、不再发起第二次换代提交。
  test("重复 finalize 返回同一结果且不再次提交换代", async () => {
    const harness = await createHarness();
    const { generation, result } = await importAndFinalize(harness, { records: 2 });
    const before = await harness.store.readScopePointer(SCOPE_KEY);
    const retry = await harness.service.finalize();

    expect(retry).toEqual(result);
    expect(retry.generation).toBe(generation);
    expect(harness.store.commitInputs.length).toBe(1);
    const after = await harness.store.readScopePointer(SCOPE_KEY);
    expect({ current: after?.currentGeneration, revision: after?.pointerRevision }).toEqual({
      current: before?.currentGeneration,
      revision: before?.pointerRevision,
    });
  });

  // 意图：同键同内容的换代提交必须幂等——存储层认幂等键并回放已提交事实，不重复递增 pointerRevision。
  test("存储层重放同键换代提交返回 already-committed", async () => {
    const harness = await createHarness();
    const { result } = await importAndFinalize(harness, { records: 1 });
    const [submitted] = harness.store.commitInputs;
    expect(submitted).toBeDefined();

    // 写权在 finalize 后已主动归还；幂等重放必须先取得新租约，不能凭已释放的旧 epoch 提交。
    const lease = await harness.store.acquireWriter(SCOPE_KEY, "replay-owner", 30_000);
    const replay = await harness.store.commitGeneration({
      ...(submitted as CommitGenerationInput),
      epoch: lease.epoch,
    });
    expect(replay.outcome).toBe("already-committed");
    expect(replay.pointerRevision).toBe(result.pointerRevision);
    expect((await harness.store.readScopePointer(SCOPE_KEY))?.pointerRevision).toBe(result.pointerRevision);
  });

  // 意图：成功路径同样要归还全部额度：暂存目录、构建池在飞任务与 historyBuild 账目都必须归零。
  test("finalize 成功后暂存、构建池与额度账目归零", async () => {
    const harness = await createHarness();
    const { generation } = await importAndFinalize(harness, { records: 2 });
    expectResourcesReleased(harness);
    expect(harness.pool.stats().completed).toBe(2);
    expect(harness.service.status()).toMatchObject({ state: "importComplete", generation, committedBlocks: 2 });
  });
});

describe("历史导入回归（本次修复）", () => {
  // 回归：曾把存储的起始游标误判成缺口（本次修复）：MemoryProjectionStore.readDirectory 的 `previous` 从 -1 起算，
  // 首个块（ordinalStart=1）也被报成「ordinal 0 缺失」，complete 因此恒为 false；assertComplete 见到 !complete
  // 直接抛 IMPORT_INCOMPLETE，于是真实存储上任何完整导入都停在 failed。期望：完整导入达到 importComplete。
  test("完整导入通过完整性校验并达到 importComplete", async () => {
    const harness = await createHarness();
    const began = await harness.service.begin(beginInput());
    await receiveAll(harness.service, 2);

    // 真实存储上的完整性校验必须通过：这里不捕异常，任何抛出即为失败。
    await harness.service.buildAndCommit();
    const page = await harness.store.readDirectory({ generation: began.generation, limit: 10 });
    expect(page.entries.length).toBe(2);
    expect(page.gaps).toEqual([]);
    expect(page.complete).toBe(true);

    const status = harness.service.status();
    expect({ state: status.state, committed: status.committedBlocks }).toEqual({
      state: "importComplete",
      committed: 2,
    });
  });

  // 回归：曾未登记 staging 代次（本次修复）：begin 未调用 store.createGeneration，「loadId + staging generation」只存在于返回值里，
  // finalize 的 commitGeneration 因「staging generation is not registered」抛 GENERATION_MISMATCH。期望：begin 后
  // 存储里能读到该 staging 代次（含 loadId），finalize 正常换代并把代次变为 committed。
  test("begin 登记 staging 代次，finalize 完成换代", async () => {
    const harness = await createHarness();
    const began = await harness.service.begin(beginInput());
    const staging = await harness.store.readGeneration(SCOPE_KEY, began.generation);
    expect({ generation: staging?.generation, loadId: staging?.loadId, state: staging?.state }).toEqual({
      generation: began.generation,
      loadId: began.loadId,
      state: "staging",
    });

    await receiveAll(harness.service, 2);
    await harness.service.buildAndCommit();
    expect(harness.service.status().state).toBe("importComplete");

    const result = await harness.service.finalize();
    expect(["committed", "already-committed"]).toContain(result.outcome);
    expect(result.generation).toBe(began.generation);
    const pointer = await harness.store.readScopePointer(SCOPE_KEY);
    expect(pointer?.currentGeneration).toBe(began.generation);
    // 首次换代：指针从 revision 0 递增到 1。
    expect(pointer?.pointerRevision).toBe(1);
    expect((await harness.store.readGeneration(SCOPE_KEY, began.generation))?.state).toBe("committed");
  });

  // 回归：曾遗漏已提交内容块的换代入口闭包（本次修复）：buildEntryClosure 的注释声称「重新读取目录」以派生入口闭包，实现却直接返回空
  // contentDocIds 且从不读目录，于是换代后的入口闭包覆盖不到任何已提交内容块（与 store/types.ts
  // 「全部内容块 Doc」的定义冲突）。期望：闭包列出实际提交的内容块 docId。
  test("换代入口闭包应包含已提交的内容块 docId", async () => {
    const harness = await createHarness();
    const { generation } = await importAndFinalize(harness, { records: 2 });
    const record = await harness.store.readGeneration(SCOPE_KEY, generation);
    const page = await harness.store.readDirectory({ generation, limit: 10 });

    expect(page.entries.length).toBe(2);
    expect(record?.entryRefs.contentDocIds).toEqual(page.entries.map((entry) => entry.docId));
  });
});
