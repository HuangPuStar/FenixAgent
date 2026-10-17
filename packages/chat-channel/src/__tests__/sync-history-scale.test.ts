// packages/chat-channel/src/__tests__/sync-history-scale.test.ts
// 历史导入的突发规模与背压回归（缺陷记录：`.peri/plans/chat-sync-runtime-profile-result.md` §4、§3.2 缺陷 1/2）。
//
// 覆盖四条不变式：
// ① 规模：7 个块（`--small=193` 的最小复现规模）与设计 §15.1 T02 形状（19,900×4KiB + 100×228KiB = 20,000 对象
//    ≈100MiB）都必须导入完成，且提交目录覆盖整个接收边界、逐条内容与顺序一致。
// ② 背压：生产者受消费者约束——池只有 1 个 worker、0 个排队位时，导入仍串行完成；池的容量语义不变，
//    非等待入口 `submit` 在队列满时依旧同步抛 `CAPACITY_EXCEEDED`（不静默丢弃）。
// ③ 失败次序：失败路径必须等在飞构建任务结清再释放暂存——失败前不得释放段文件，失败后才清账。
// ④ 诊断：整条失败路径不得留下无人 await 的拒绝（`bun test` 会把未处理拒绝判为本文件失败，见探测结论）。
//
// 全部走真实实现：`MemoryProjectionStore` + 临时目录上的 `HistorySpool` + `BlockBuildPool` +
// `HistoryImportService`（真实 `buildContentBlock`），只注入确定性随机源与固定时钟；不 mock 模块、
// 不读环境变量、不调池容量常量。内容 oracle 是 `JSON.parse(payload)` 与输入对象的深比较（不比对被测算出的字节）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, type DigestFn, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { buildContentBlock } from "../sync/history/block-builder";
import { BlockBuildPool, type BuildPoolConfig, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { type BuildBlockFn, HistoryImportService } from "../sync/history/import-service";
import type { HistoryRecordMeta } from "../sync/history/ingest";
import { HistorySpool } from "../sync/history/spool";
import { SyncProtocolError } from "../sync/protocol/errors";
import type { SyncScope } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { PutSealedInput, PutSealedResult, StoreLifecycleOptions } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org_sync_scale", rcsSessionId: "rcs_session_scale" };
const OWNER = "scale-owner";
const ACP_SESSION_ID = "ses_sync_scale_test";
const LEASE_TTL_MS = 600_000;
/** 固定时间源：池的排队时长与租约都不参与断言，用固定时钟排除时间抖动。 */
const FIXED_NOW = 1_700_000_000_000;
const clock: Clock = { now: () => FIXED_NOW };
const digest: DigestFn = sha256Digest;

/** 设计 §15.3 的历史突发形状：19,900 个小对象 + 100 个大对象，总载荷约 100MiB。 */
const BURST_SMALL_OBJECTS = 19_900;
const BURST_LARGE_OBJECTS = 100;
const BURST_SMALL_BYTES = 4 * 1024;
const BURST_LARGE_BYTES = 228 * 1024;
/** 最小复现规模：默认块目标（131,072B）下 192 个对象正好 6 个块、193 个对象是第 7 个块。 */
const SEVEN_BLOCK_OBJECTS = 193;
/** 目录读取上限取容量档案的 `inputs.directoryMaxRefs`，与运行时装配同一口径。 */
const DIRECTORY_LIMIT = DEFAULT_SYNC_CAPACITY.inputs.directoryMaxRefs;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 目标字节数不同、其余沿用冻结默认值的容量档案（只为制造「多条记录、多块」的形状，不改池上限）。 */
function capacityWithBlockTarget(targetPayloadBytes: number): SyncCapacityProfile {
  return {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, historyBlockTargetPayloadBytes: targetPayloadBytes },
  };
}

/**
 * 一条历史对象：`pad` 把保真载荷补齐到目标字节数。
 * `pad` 是纯 ASCII，JSON 片段里每字符一字节，因此序列化后的字节数精确等于 `targetBytes`（不靠估算）。
 */
function historyObject(index: number, targetBytes: number): { index: number; marker: string; pad: string } {
  const head = new TextEncoder().encode(JSON.stringify({ index, marker: objectMarker(index), pad: "" })).byteLength;
  return { index, marker: objectMarker(index), pad: "x".repeat(Math.max(0, targetBytes - head)) };
}

function objectMarker(index: number): string {
  return `object-${index}`;
}

function recordMeta(ordinal: number): HistoryRecordMeta {
  return { kind: "history_object", entryId: `entry-${ordinal}` };
}

/** 测试存储：真实 `MemoryProjectionStore`，只加一个「让某块封口写入等门闸」的钩子（用于构造在飞任务）。 */
class ScaleTestStore extends MemoryProjectionStore {
  private gate: { promise: Promise<void>; release: () => void } | null = null;
  private gateOrdinal: number | null = null;
  private readonly opened: number[] = [];

  /** 让 `ordinalStart` 命中的块在封口前等待门闸；`openedOrdinals` 记录实际完成提交的块起点。 */
  holdBlockAt(ordinalStart: number): { release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { promise, release };
    this.gateOrdinal = ordinalStart;
    return { release };
  }

  openedOrdinals(): number[] {
    return [...this.opened];
  }

  override async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    if (this.gate !== null && input.doc.ordinalStart === this.gateOrdinal) {
      await this.gate.promise;
    }
    const result = await super.putSealedIfAbsent(input);
    this.opened.push(input.doc.ordinalStart ?? -1);
    return result;
  }
}

interface Harness {
  store: ScaleTestStore;
  spool: HistorySpool;
  pool: BlockBuildPool;
  admission: AdmissionController;
  service: HistoryImportService;
}

/** 装配一套真实依赖；`poolConfig` 缺省即 fairness 派生值（2 worker / 4 排队位）。 */
async function createHarness(
  options: { capacity?: SyncCapacityProfile; poolConfig?: BuildPoolConfig; buildBlock?: BuildBlockFn } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "sync-history-scale-"));
  tempRoots.push(root);
  const capacity = options.capacity ?? DEFAULT_SYNC_CAPACITY;
  const lifecycle: StoreLifecycleOptions = { sealGraceMs: 1000, retireGraceMs: 1000 };
  const store = new ScaleTestStore({ clock, digest, capacity, lifecycle });
  const admission = new AdmissionController(capacity);
  const pool = new BlockBuildPool(options.poolConfig ?? deriveBuildPoolConfig(capacity.fairness), admission, clock);
  const spool = new HistorySpool(
    {
      basePath: join(root, "spool"),
      segmentBytes: capacity.concurrency.loadSpoolTaskBytes,
      taskQuotaBytes: capacity.concurrency.loadSpoolTaskBytes,
      processQuotaBytes: capacity.concurrency.loadSpoolProcessBytes,
    },
    clock,
  );
  const service = new HistoryImportService({
    store,
    spool,
    pool,
    clock,
    digest,
    capacity,
    rand: deterministicRandomSource("sync-history-scale"),
    admission,
    ...(options.buildBlock === undefined ? {} : { buildBlock: options.buildBlock }),
  });
  return { store, spool, pool, admission, service };
}

function beginInput(): { scope: SyncScope; acpSessionId: string; owner: string; leaseTtlMs: number } {
  return { scope: SCOPE, acpSessionId: ACP_SESSION_ID, owner: OWNER, leaseTtlMs: LEASE_TTL_MS };
}

/** 接收 `count` 条记录（第 i 条的载荷按 `payloadBytes(i)` 归类），返回载荷字节总数。 */
async function receive(
  service: HistoryImportService,
  generated: { count: number; payloadBytes: (ordinal: number) => number },
): Promise<number> {
  let totalBytes = 0;
  for (let ordinal = 1; ordinal <= generated.count; ordinal += 1) {
    const record = await service.accept(historyObject(ordinal, generated.payloadBytes(ordinal)), recordMeta(ordinal));
    totalBytes += record.payloadBytes;
  }
  await service.receivingComplete();
  return totalBytes;
}

/** 读取一个内容块的 `ordinalStart` 与记录载荷：只取定位与正文，不复用受测的目录/解码实现。 */
async function readContentBlock(
  store: ScaleTestStore,
  docId: string,
): Promise<{ ordinalStart: number; ordinalEnd: number; payloads: Uint8Array[] }> {
  const base = await store.readDocStateAt(docId, 0);
  if (base === null) {
    throw new Error(`content block ${docId} has no committed baseline at seq 0`);
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base.snapshot);
  const root = doc.getMap("root");
  const records = root.get("records");
  if (!(records instanceof Y.Array)) {
    throw new Error(`content block ${docId} has no records array`);
  }
  const payloads = records.toArray().map((item: unknown, position: number) => {
    if (typeof item !== "object" || item === null || !("payload" in item) || !(item.payload instanceof Uint8Array)) {
      throw new Error(`content block ${docId} record ${position} has no payload bytes`);
    }
    return item.payload;
  });
  return {
    ordinalStart: requireNumber(root.get("ordinalStart"), docId, "ordinalStart"),
    ordinalEnd: requireNumber(root.get("ordinalEnd"), docId, "ordinalEnd"),
    payloads,
  };
}

function requireNumber(value: unknown, docId: string, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`content block ${docId} has no numeric ${field}`);
  }
  return value;
}

/**
 * 逐块校验已提交目录：ordinal 区间必须连续、无缝地覆盖 `[1, expectedCount]`，且每条载荷
 * `JSON.parse` 后与输入对象深比较相等（顺序按目录 ordinal 区间，不依赖提交完成顺序）。
 */
async function expectDirectoryMatches(
  harness: Harness,
  generation: string,
  generated: { count: number; payloadBytes: (ordinal: number) => number },
): Promise<number> {
  const page = await harness.store.readDirectory({ generation, limit: DIRECTORY_LIMIT });
  expect(page.gaps).toEqual([]);
  expect(page.complete).toBe(true);
  const entries = [...page.entries].sort((left, right) => left.ordinalStart - right.ordinalStart);
  const decoder = new TextDecoder();
  let expectedOrdinal = 1;
  for (const entry of entries) {
    const block = await readContentBlock(harness.store, entry.docId);
    expect(block.ordinalStart).toBe(expectedOrdinal);
    expect(block.ordinalStart).toBe(entry.ordinalStart);
    expect(block.ordinalEnd).toBe(entry.ordinalEnd);
    for (const payload of block.payloads) {
      expect(payload.byteLength).toBe(generated.payloadBytes(expectedOrdinal));
      expect(JSON.parse(decoder.decode(payload))).toEqual(
        historyObject(expectedOrdinal, generated.payloadBytes(expectedOrdinal)),
      );
      expectedOrdinal += 1;
    }
  }
  expect(expectedOrdinal - 1).toBe(generated.count);
  return entries.length;
}

/** 捕获同步协议错误：其它异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

/** 等一个由任务体置位的标志：轮询只是把并发时序暴露给断言，不引入固定等待时长。 */
async function waitForFlag(isSet: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isSet()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("expected the flag to be set by an in-flight task");
}

describe("历史导入：突发规模", () => {
  // 缺陷 1 的最小复现规模：第 7 个块（第 193 个对象）在旧实现里撞满池队列并以 CAPACITY_EXCEEDED 失败。
  // 意图：标准块目标下的多块导入必须完成，且内容与顺序逐条一致。
  test("193 个对象（7 个块）导入完成且逐条一致", async () => {
    const harness = await createHarness();
    const shape = { count: SEVEN_BLOCK_OBJECTS, payloadBytes: (): number => BURST_SMALL_BYTES };
    const began = await harness.service.begin(beginInput());
    const payloadBytes = await receive(harness.service, shape);

    await harness.service.buildAndCommit();
    const status = harness.service.status();
    expect(status.state).toBe("importComplete");
    expect(status.failure).toBeUndefined();
    expect(status.receivedOrdinal).toBe(shape.count);
    expect(status.gaps).toEqual([]);
    expect(status.committedBlocks).toBeGreaterThan(6);
    expect(payloadBytes).toBe(SEVEN_BLOCK_OBJECTS * BURST_SMALL_BYTES);

    await expectDirectoryMatches(harness, began.generation, shape);
    await harness.service.finalize();
    expect(harness.service.status().state).toBe("importComplete");
  }, 60_000);

  // 设计 §15.1 T02 的标准形状：20,000 个对象 / ≈100MiB 零间隔突发。
  // 意图：满规模突发必须导入完成，目录覆盖整个接收边界，且逐条对象内容与输入完全一致。
  test("20,000 个对象 / 100MiB 突发导入完成且逐条一致", async () => {
    const harness = await createHarness();
    const shape = {
      count: BURST_SMALL_OBJECTS + BURST_LARGE_OBJECTS,
      payloadBytes: (ordinal: number): number =>
        ordinal <= BURST_SMALL_OBJECTS ? BURST_SMALL_BYTES : BURST_LARGE_BYTES,
    };
    const began = await harness.service.begin(beginInput());
    const payloadBytes = await receive(harness.service, shape);

    await harness.service.buildAndCommit();
    const status = harness.service.status();
    expect(status.state).toBe("importComplete");
    expect(status.failure).toBeUndefined();
    expect(status.receivedOrdinal).toBe(shape.count);
    expect(status.gaps).toEqual([]);
    const expectedBytes = BURST_SMALL_OBJECTS * BURST_SMALL_BYTES + BURST_LARGE_OBJECTS * BURST_LARGE_BYTES;
    expect(payloadBytes).toBe(expectedBytes);
    expect(payloadBytes).toBeGreaterThan(95 * 1024 * 1024);

    // 目录项数与载荷总量都必须落在设计形状的量级上（默认块目标 ≈131KiB ⇒ 数百个块）。
    const blockCount = await expectDirectoryMatches(harness, began.generation, shape);
    expect(blockCount).toBe(status.committedBlocks);
    expect(blockCount).toBeGreaterThan(100);
    await harness.service.finalize();
  }, 300_000);
});

describe("历史导入：背压与容量语义", () => {
  // 意图：生产者受消费者约束——池只有 1 个 worker、0 个排队位时，多块导入必须等到空位再提交并完成，
  // 而不是抛 CAPACITY_EXCEEDED（容量参数不放大：1/0 就是池的硬上限）。
  test("池只有 1 个 worker 且不排队时导入仍逐块完成", async () => {
    const harness = await createHarness({
      capacity: capacityWithBlockTarget(64),
      poolConfig: { maxConcurrent: 1, maxQueued: 0, tasksMax: 1 },
    });
    const shape = { count: 4, payloadBytes: (): number => 512 };
    const began = await harness.service.begin(beginInput());
    await receive(harness.service, shape);

    await harness.service.buildAndCommit();
    expect(harness.service.status()).toMatchObject({
      state: "importComplete",
      committedBlocks: shape.count,
      gaps: [],
    });
    expect(harness.pool.stats()).toMatchObject({ running: 0, queued: 0, completed: shape.count, failed: 0 });
    await expectDirectoryMatches(harness, began.generation, shape);
  }, 30_000);

  // 意图：非等待入口的显式失败语义未被放宽——队列满时 `submit` 仍同步抛 CAPACITY_EXCEEDED（不静默丢弃），
  // 而 `submitAwaitingCapacity` 在同一状态下等待空位。
  test("队列满时非等待提交显式拒绝、等待提交等空位", async () => {
    const capacity = capacityWithBlockTarget(64);
    const admission = new AdmissionController(capacity);
    const pool = new BlockBuildPool({ maxConcurrent: 1, maxQueued: 0, tasksMax: 1 }, admission, clock);
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const first = pool.submit({ estimateBytes: 1024, run: () => held });

    const rejected = captureSyncError(() => pool.submit({ estimateBytes: 1024, run: async () => {} }));
    expect(rejected.code).toBe("CAPACITY_EXCEEDED");
    expect(rejected.retryable).toBe(true);

    let startedWaiting = false;
    const waiting = pool.submitAwaitingCapacity({
      estimateBytes: 1024,
      run: async (): Promise<void> => {
        startedWaiting = true;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(startedWaiting).toBe(false);
    expect(pool.stats()).toMatchObject({ running: 1, queued: 0 });

    releaseHeld();
    await Promise.all([first, waiting]);
    expect(startedWaiting).toBe(true);
    expect(pool.stats()).toMatchObject({ running: 0, queued: 0, completed: 2, failed: 0 });
    expect(admission.used("historyBuild")).toBe(0);
  }, 30_000);
});

describe("历史导入：失败清理次序", () => {
  // 意图：失败路径必须等在飞构建任务结清再释放暂存——失败确定后暂存仍在（段未被释放）、在飞块仍能完成提交，
  // 随后才清账；整条路径不得产生无人 await 的拒绝（bun test 会把未处理拒绝判为本文件失败）。
  test("失败先结清在飞任务再释放暂存，后续块不被 RESOURCE_RETIRED 打断", async () => {
    let refused = false;
    const refuseOrdinal = 3;
    const failingBuild: BuildBlockFn = (input) => {
      if (input.records[0].sourceOrdinal === refuseOrdinal) {
        refused = true;
        throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "build refused by scale test" });
      }
      return buildContentBlock(input);
    };
    const harness = await createHarness({ capacity: capacityWithBlockTarget(64), buildBlock: failingBuild });
    const gate = harness.store.holdBlockAt(2);
    const shape = { count: 5, payloadBytes: (): number => 512 };
    await harness.service.begin(beginInput());
    await receive(harness.service, shape);

    const failure = harness.service.buildAndCommit().then(
      () => null,
      (error: unknown) => error,
    );
    await waitForFlag(() => refused);
    // 失败已确定，但在飞块（ordinalStart=2）尚未结清：此时暂存必须仍在，且 buildAndCommit 不得提前结束。
    let settled = false;
    void failure.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(harness.spool.stats().totalBytes).toBeGreaterThan(0);
    expect(harness.pool.stats().running).toBeGreaterThan(0);

    gate.release();
    const error = await failure;
    expect(error).toBeInstanceOf(SyncProtocolError);
    expect((error as SyncProtocolError).code).toBe("CAPACITY_EXCEEDED");
    // 在飞块在清理之前完成了提交（旧实现会先释放段，让这次提交以 RESOURCE_RETIRED 失败）。
    expect(harness.store.openedOrdinals()).toContain(2);
    expect(harness.spool.stats().totalBytes).toBe(0);
    expect(harness.pool.stats()).toMatchObject({ running: 0, queued: 0 });
    expect(harness.admission.used("historyBuild")).toBe(0);
    expect(harness.service.status()).toMatchObject({ state: "failed", failure: { code: "CAPACITY_EXCEEDED" } });
  }, 60_000);
});
