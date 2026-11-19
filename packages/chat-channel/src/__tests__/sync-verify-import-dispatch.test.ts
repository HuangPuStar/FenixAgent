// packages/chat-channel/src/__tests__/sync-verify-wiring-2.test.ts
// V2 第二轮对抗验证（身份 V2）：目标不是复述 wave4 的修正，而是证明它**没有真正解决问题**或引入了新问题。
//
// 观察面全部是黑盒可观测事实：发到传输端口的字节序列、传输层收到的关闭请求、网关自报的在途投递数、
// 真实账本与额度的账目、入口记录快照、导入分派的池占用与在飞结算、以及「按已提交字节重放出的文档」。
// store、会话、额度、账本、出帧网关、控制 governor、ACK 超时登记、构建池、写入层全部用真实实现；注入的替身
// 只有传输端口（宿主 WS 边界）、假时钟、以及历史分派的记录源/提交口（分派器的对外缝本身）。
//
// 每个用例的期望值取设计/规格契约，失败消息里的 Received 就是实际观测值。被顶替/丢失的投递一律通过
// 「客户端收到的序号集合」与「账本残留」两条独立证据链交叉确认，不依赖实现自报的计数。

import { describe, expect, test } from "bun:test";

import { AdmissionController } from "../sync/capacity/admission";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";

import { sha256Digest } from "../sync/clock";

import type { BlockRecordInput, BuiltBlock } from "../sync/history/block-builder";

import { BlockDispatcher, type BlockRecordSource, type StagedBlockRecord } from "../sync/history/build-dispatch";

import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";

import { SyncProtocolError } from "../sync/protocol/errors";

import { buildDocId } from "../sync/protocol/identity";
import { emptyState, GENERATION } from "./sync-verify-wiring-2-fixture";

interface PoolHarness {
  readonly pool: BlockBuildPool;
  readonly admission: AdmissionController;
}

/** 只改 worker 数与任务上限的池装配：其余 fairness 字段不参与池派生，取冻结默认值。 */
function buildPool(historyBuilderWorkers: number, builderTasksMax: number): PoolHarness {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  return {
    pool: new BlockBuildPool(
      deriveBuildPoolConfig({ ...DEFAULT_SYNC_CAPACITY.fairness, historyBuilderWorkers, builderTasksMax }),
      admission,
      { now: () => 1_000 },
    ),
    admission,
  };
}

/** 编号记录输入：`payload` 由读取缝按 ordinal 现造（分派器会把占位载荷换成读取结果）。 */
function numberedRecords(count: number): StagedBlockRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceOrdinal: index + 1,
    kind: "history_object",
    payloadBytes: new TextEncoder().encode(`record-${index + 1}`).byteLength,
    entryId: `entry-${index + 1}`,
    entryOrder: index + 1,
    contentSlot: 0,
    partIndex: 0,
  }));
}

function inGroups(records: readonly StagedBlockRecord[], groupSize: number): StagedBlockRecord[][] {
  const groups: StagedBlockRecord[][] = [];
  for (let start = 0; start < records.length; start += groupSize) {
    groups.push(records.slice(start, start + groupSize));
  }
  return groups;
}

/** 读取缝替身：记录读取序号、读出期间的并发与池计数，并可选地让指定序号失败。 */
class RecordingSource implements BlockRecordSource {
  readonly ordinals: number[] = [];
  maxConcurrentReads = 0;
  readonly poolSamples: string[] = [];
  failAt: number | null = null;
  private concurrent = 0;

  constructor(private readonly pool: BlockBuildPool) {}

  async readRecords(sourceOrdinals: readonly number[]): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];
    for (const sourceOrdinal of sourceOrdinals) results.push(await this.readRecord(sourceOrdinal));
    return results;
  }

  private async readRecord(sourceOrdinal: number): Promise<Uint8Array> {
    if (sourceOrdinal === this.failAt) {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "read failed on purpose" });
    }
    this.ordinals.push(sourceOrdinal);
    this.concurrent += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.concurrent);
    const stats = this.pool.stats();
    this.poolSamples.push(`${stats.running}/${stats.queued}`);
    // 让出微任务：给「并发提交」留出被观测到的机会（读取越慢，越可能看到多个任务同时在飞）。
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    this.concurrent -= 1;
    return new TextEncoder().encode(`record-${sourceOrdinal}`);
  }
}

/** 假块构建器：覆盖输入的**前缀**（默认全部），只提供分派器需要的定位元数据。 */
function fakeBlock(generation: string, blockIndex: number, records: readonly BlockRecordInput[]): BuiltBlock {
  const covered = [...records];
  const snapshot = emptyState();
  return {
    docId: buildDocId({ kind: "content", generation, blockIndex, nonce: `v2-block-${blockIndex}` }),
    generation,
    blockIndex,
    ordinalStart: covered[0]?.sourceOrdinal ?? 0,
    ordinalEnd: covered[covered.length - 1]?.sourceOrdinal ?? 0,
    recordCount: covered.length,
    snapshot,
    hash: sha256Digest(snapshot),
    stateVector: new Uint8Array(0),
    dependsOn: [],
    records: covered.map((record) => ({
      recordId: `rec-${record.sourceOrdinal}`,
      ordinal: record.sourceOrdinal,
      entryId: record.entryId,
      orderStart: record.entryOrder,
      orderEnd: record.entryOrder,
      byteStart: 0,
      byteEnd: record.payload.byteLength,
      digest: sha256Digest(record.payload),
    })),
  };
}

describe("V2 历史导入：分派器的在飞窗口与失败结算", () => {
  // 批量读入前必须按真实载荷取得额度，零字节占位索引不能绕过内存预算。
  test("暂存批次读取期间已预留全部载荷额度", async () => {
    const { pool, admission } = buildPool(1, 2);
    const records = numberedRecords(2);
    const dispatcher = new BlockDispatcher(pool, {
      source: {
        async readRecords(ordinals) {
          expect(admission.used("historyBuild")).toBeGreaterThanOrEqual(16);
          return ordinals.map((ordinal) => new TextEncoder().encode(`record-${ordinal}`));
        },
      },
      buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
      commitBlock: async () => "committed",
    });
    await dispatcher.dispatch([records]);
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 契约（规格 §5.7 背压 + 设计 §15.1 T02）：20,000 对象的零间隔突发是默认形状（700+ 块），生产者必须受
  // 消费者约束——池上限不变、提交不撞满队列；每条记录只被读取一次（续建不得把整组重读一遍）。
  test("两万对象形状：在飞窗口不超过池 worker 数，队列不为负、每条记录只读一次", async () => {
    const { pool, admission } = buildPool(2, 6);
    const source = new RecordingSource(pool);
    const committed: number[] = [];
    const dispatcher = new BlockDispatcher(pool, {
      source,
      buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
      commitBlock: async (block) => {
        committed.push(block.recordCount);
        return "committed";
      },
    });

    const total = 20_000;
    await dispatcher.dispatch(inGroups(numberedRecords(total), 30));

    // 每条记录恰好读一次：读取序号的集合必须等于 1..total（无重读、无遗漏）。
    expect(source.ordinals.length).toBe(total);
    expect(new Set(source.ordinals).size).toBe(total);
    expect(Math.min(...source.ordinals)).toBe(1);
    expect(Math.max(...source.ordinals)).toBe(total);
    // 在飞窗口 ≤ worker 数：并发读取是各组在飞的直接证据。
    expect(source.maxConcurrentReads).toBeLessThanOrEqual(pool.workerCount());
    // 池不得排队：分派器的窗口等于 worker 数，跑满的池里不该有第 3 个任务。
    const queued = source.poolSamples.filter((sample) => !sample.endsWith("/0"));
    expect(queued).toEqual([]);
    // 全部组按序提交，覆盖整个接收边界。
    expect(committed.length).toBe(Math.ceil(total / 30));
    expect(committed.reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(dispatcher.committedBlocks()).toBe(committed.length);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: committed.length, failed: 0 });
    // 池额度是提交时预留的内存承诺：全部结算后必须归零，否则导入越跑越没额度。
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 契约（build-dispatch.ts 文件头不变式 ③）：失败必须先结清在飞任务再抛出，否则调用方的暂存释放会与在飞
  // 读取重叠；首个失败是权威原因，后续不得再有读取动作。
  test("一组失败：先结清在飞任务再抛首个失败，读取停止且额度与队列归零", async () => {
    const { pool, admission } = buildPool(2, 6);
    const source = new RecordingSource(pool);
    // 第 3 组的第一条记录读取即失败（组大小 4 → 第 9 条记录）。
    source.failAt = 9;
    const committed: number[] = [];
    const dispatcher = new BlockDispatcher(pool, {
      source,
      buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
      commitBlock: async (block) => {
        committed.push(block.recordCount);
        return "committed";
      },
    });

    const failure = dispatcher.dispatch(inGroups(numberedRecords(48), 4)).then(
      () => null,
      (error: unknown) => error,
    );
    const error = await failure;
    expect(error instanceof SyncProtocolError).toBe(true);
    expect(dispatcher.committedBlocks()).toBe(committed.length);
    // 结算完成：池里没有在飞任务、没有排队，失败只记一次，读取也不再继续。
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: committed.length, failed: 1 });
    // 额度是「先预留后释放」的账目：失败任务的预留同样必须归还干净。
    expect(admission.used("historyBuild")).toBe(0);
    const readsAtFailure = source.ordinals.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(source.ordinals.length).toBe(readsAtFailure);
    expect(dispatcher.committedBlocks()).toBeLessThan(12);
  });

  // 契约（规格 §5.7「同一池服务多个生产者」）：两个分派器共用一个单 worker 池时必须交替推进，谁都不被饿死。
  test("两个分派器共用一个单 worker 池：两组导入都跑完，不互相饿死", async () => {
    const { pool, admission } = buildPool(1, 2);
    const first = new RecordingSource(pool);
    const second = new RecordingSource(pool);
    const committed: string[] = [];
    const dispatcherOf = (source: RecordingSource, tag: string): BlockDispatcher =>
      new BlockDispatcher(pool, {
        source,
        buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
        commitBlock: async () => {
          committed.push(tag);
          return "committed";
        },
      });

    await Promise.all([
      dispatcherOf(first, "first").dispatch(inGroups(numberedRecords(20), 4)),
      dispatcherOf(second, "second").dispatch(inGroups(numberedRecords(20), 4)),
    ]);

    expect(first.ordinals.length).toBe(20);
    expect(second.ordinals.length).toBe(20);
    expect(committed.filter((tag) => tag === "first").length).toBe(5);
    expect(committed.filter((tag) => tag === "second").length).toBe(5);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 10, failed: 0 });
    expect(admission.used("historyBuild")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// D 组（方向 5）：live 写入层的纯删除、同名重建与封口交错（自有 oracle：编号输入序列）
// ---------------------------------------------------------------------------------------------------
