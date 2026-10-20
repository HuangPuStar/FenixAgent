// packages/chat-channel/src/__tests__/sync-acceptance-planes.test.ts
// A8 交付：设计 §15.2 场景矩阵 **T08–T12** 的端到端验收（与 `sync-acceptance-core.test.ts` 的 T01–T07 互补）。
//
// 端到端口径与 T01–T07 一致：真实 `createSyncScopeRuntime` + 真实 `createSyncClientTransport` + 真实
// `encodeSyncFrame`/`decodeSyncFrame` 字节；夹具与 oracle 在 `sync-acceptance-planes-oracle.ts`（独立文件，
// 不 import 另两份验收 oracle，设计 §15.1）。时间一律由注入的假时钟推进，不用墙钟等待。
//
// 场景结论表（每条结论都由本文件对应 describe 内的断言支撑；失败与缺口逐条写在「未覆盖」段）：
// | 场景 | 结论 | 断言口径 |
// | --- | --- | --- |
// | T08 | 通过 | 接收期（重复对象）/构建期（池额度）/提交期（封口提交）/finalize（换代提交）各注入一次失败：失败尝试不落地、指针与修订号不动；超大对象分片后导入成功，重试后输入逐条保留、不重复、目录连续 |
// | T09 | 通过 | 慢端与后台标签页：在途字节 ≤ 连接窗口且不重复投递；快端与写入侧不受影响；恢复后一次补齐、不重复、队列归零 |
// | T10 | 通过 | 回执丢失/重复/旧代次都不改变在途账目；丢帧与重复帧后缺口经 RESYNC 补齐（应用序号 1..max 连续、增量区间不重叠）；RESYNC 次数有界 |
// | T11 | 通过 | 同一时刻只有一个有效写者（SCOPE_BUSY 且存储未变）；租约过期与旧 epoch 写入被拒；换写者后旧已提交字节可重发；旧 pointerRevision 不使客户端回退 |
// | T12 | 通过 | 同 scope 第二个 load 被 SCOPE_BUSY 拒绝；跨连接共用一份 `AdmissionController`（越界 ADMISSION_REJECTED、释放后归零）；多块导入不饿死；导入持写权期间实时写入有界失败、导入不损坏已提交内容 |
//
// 未覆盖（不得当已覆盖）：
// 1. T08 的「进程被杀/断电」分支：内存 store 无持久化，只能注入调用级失败，不能构造进程终止；
// 2. T12 的「两个历史 load 真并行」：`activeLoadsPerScope = 1` 使第二个在协议层被拒（设计行为），
//    本夹具为单 scope，跨 scope 并行构建未覆盖；
// 3. T09/T10 的「真实 socket 背压」：`SyncFrameTransport` 为进程内替身，`bufferedAmount` 恒为 0，
//    因此 socket 水位门禁分支未被触发（只覆盖连接窗口分支）。

import { describe, expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import { type ApplyAckFrame, type GenerationReplaceFrame, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";
import { type SyncScope } from "../sync/protocol/identity";
import type { SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import type { SyncGenerationRecord } from "../sync/store/types";
import {
  createPlaneHarness,
  createPlaneStore,
  duplicateRecordIds,
  FaultyProjectionStore,
  type FaultyStoreMethod,
  PLANE_CAPACITY,
  PlaneClock,
  type PlaneConnection,
  type PlaneHarness,
  type PlaneHarnessOptions,
  TEXT_SLOT,
  textOfRecords,
  WRITER_LEASE_TTL_MS,
} from "./sync-acceptance-planes-oracle";

// ------------------------------------------------------------------ 用例脚手架

async function withHarness(
  options: PlaneHarnessOptions,
  body: (harness: PlaneHarness) => Promise<void>,
): Promise<void> {
  const harness = await createPlaneHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.disposeAll();
  }
}

/** T08 专用：以「故障注入 store」装配夹具；除被注入的那一次调用外，读写全部到达真实内存 store。 */
async function withFaultyHarness(
  fault: { readonly method: FaultyStoreMethod; readonly afterCalls: number; readonly error: Error },
  body: (harness: PlaneHarness, faulty: FaultyProjectionStore) => Promise<void>,
): Promise<void> {
  const clock = new PlaneClock();
  const capacity = PLANE_CAPACITY;
  const faulty = new FaultyProjectionStore(createPlaneStore(capacity, clock), fault);
  const harness = await createPlaneHarness({ store: faulty, clock, capacity });
  try {
    await body(harness, faulty);
  } finally {
    await harness.disposeAll();
  }
}

function primaryOf(harness: PlaneHarness): PlaneConnection {
  const primary = harness.primary;
  if (primary === null) throw new Error("acceptance: harness has no primary connection");
  return primary;
}

/** 断言异步操作以指定协议码失败；返回错误对象以便继续检查 retryable 等字段。 */
async function expectProtocolError(run: () => Promise<unknown>, code: string): Promise<SyncProtocolError> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SyncProtocolError);
  const error = caught as SyncProtocolError;
  expect(error.code).toBe(code);
  return error;
}

// ------------------------------------------------------------------ 冒烟（夹具自检）

describe("T00 夹具自检", () => {
  test("端到端冒烟：握手 → 订阅 → 实时写入 → 客户端收到同一份文本", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      await harness.writeText("你好");
      await harness.writeText("，世界");

      const records = primary.mirror.records(harness.seedContentDocId);
      expect(textOfRecords(records, "turn-1:assistant", TEXT_SLOT)).toBe("你好，世界");
      expect(duplicateRecordIds(records)).toEqual([]);
      expect(primary.fatal).toEqual([]);
      expect(harness.log.joined()).toBe("你好，世界");
    });
  });

  test("客户端镜像与已提交字节一致：实时写入的记录可从存储侧复现", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      await harness.writeText("abc");

      const submitted = await harness.canonicalRecords(harness.seedContentDocId);
      expect(textOfRecords(submitted, "turn-1:assistant", TEXT_SLOT)).toBe("abc");
      // 逐条记录比对（不比对 Yjs 编码字节：不同构建顺序的 canonical 编码不可逐字节比较，语义才是口径）。
      const mirrored = primary.mirror.records(harness.seedContentDocId);
      expect(mirrored.map((record) => record.recordId)).toEqual(submitted.map((record) => record.recordId));
      expect(mirrored.map((record) => [...record.payload])).toEqual(submitted.map((record) => [...record.payload]));
    });
  });
});

// ------------------------------------------------------------------ T08 load 每个阶段失败后重试

/** T08 的历史输入：三条文本对象；期望文本由输入侧拼接给出（不调用被测的合并/投影实现）。 */
const HISTORY_PARTS = ["alpha|", "beta|", "gamma|"] as const;
/**
 * 历史期望文本 = 输入对象的**规范化 JSON** 逐条首尾相接（设计 §15.1 的历史 oracle）。
 * 记录载荷保存的是保真 JSON 字节，因此字符串对象在载荷里带引号，这正是要断言的内容。
 */
function historyJson(parts: readonly string[] = HISTORY_PARTS): string {
  return parts.map((part) => JSON.stringify(part)).join("");
}
/** 接收这批输入：同一 entry 的三个片段，`partIndex` 决定块内顺序。 */
async function receiveHistory(harness: PlaneHarness, parts: readonly string[] = HISTORY_PARTS): Promise<void> {
  for (const [index, text] of parts.entries()) {
    await harness.acceptHistoryText(text, { entryId: "h1", partIndex: index });
  }
}

/**
 * 断言一次导入动作以原始异常失败，同时（服务层的可判定出口）`status()` 暴露稳定码与可重试判定。
 *
 * `HistoryImportService` 的三个动作在失败时**原样抛出**内部异常（保留 cause，交由上层归一化），
 * 稳定码只经 `status().failure` 暴露——因此这里两个事实都断言，缺一不可。
 */
async function expectImportFailure(
  harness: PlaneHarness,
  run: () => Promise<unknown>,
  code: string,
  retryable: boolean,
): Promise<void> {
  const thrown = await run().then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Error);
  const status = harness.importStatus();
  expect(status?.state).toBe("failed");
  expect(status?.failure?.code).toBe(code);
  expect(status?.failure?.retryable).toBe(retryable);
}

describe("T08 load 每个阶段失败后重试", () => {
  test("接收期失败（重复对象被拒）不切换代次，重试后输入对象逐条保留且不重复", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const beforeRevision = await harness.currentPointerRevision();

      const attempt = await harness.beginImport();
      await harness.acceptHistoryText(HISTORY_PARTS[0], { entryId: "h1", partIndex: 0 });
      // 同一身份在接收窗口内重复接收被拒：去重只在本 load 内成立，跨 load 不去重（设计 §5.3）。
      const rejected = await expectProtocolError(
        () => harness.acceptHistoryText(HISTORY_PARTS[0], { entryId: "h1", partIndex: 0 }),
        "DUPLICATE_OBJECT",
      );
      expect(rejected.retryable).toBe(false);

      // 失败尝试不落地：状态 failed、当前代次与修订号都不动、没有已提交块。
      const failed = harness.importStatus();
      expect(failed?.state).toBe("failed");
      expect(failed?.generation).toBe(attempt.generation);
      expect(await harness.currentGeneration()).toBe(harness.seedGeneration);
      expect(await harness.generationState(attempt.generation)).not.toBe("committed");
      expect(await harness.currentPointerRevision()).toBe(beforeRevision);
      expect(harness.docsOfKind("content").filter((row) => row.docId.includes(attempt.generation))).toEqual([]);

      // 重试：新 loadId/代次，重新接收**同一批**对象 —— 不误跳过、不重复。
      const retry = await harness.beginImport();
      expect(retry.generation).not.toBe(attempt.generation);
      await receiveHistory(harness);
      const finished = await harness.finishImport();
      expect(finished.outcome).toBe("committed");
      expect(finished.generation).toBe(retry.generation);

      const records = await harness.flatRecords();
      expect(records.length).toBe(HISTORY_PARTS.length);
      expect(textOfRecords(records, "h1", 0)).toBe(historyJson());
      expect(duplicateRecordIds(records)).toEqual([]);
      expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: HISTORY_PARTS.length });
    });
  });

  test("构建期失败（构建池额度被外部占满）后重试：不误跳过对象，归还额度后覆盖连续", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const beforeRevision = await harness.currentPointerRevision();
      const budget = harness.config.capacity.serverPools.historyBuild;

      // 外部预扣吃满整池额度：构建提交必须在这里被拒（跨连接共用同一本账，见 T12）。
      const held = harness.admission.reserve("historyBuild", budget);
      const attempt = await harness.beginImport();
      await receiveHistory(harness);
      await harness.history().receivingComplete();
      const rejected = await expectProtocolError(() => harness.history().buildAndCommit(), "ADMISSION_REJECTED");
      expect(rejected.retryable).toBe(true);

      expect(harness.importStatus()?.state).toBe("failed");
      expect(await harness.generationState(attempt.generation)).not.toBe("committed");
      expect(await harness.currentGeneration()).toBe(harness.seedGeneration);
      expect(await harness.currentPointerRevision()).toBe(beforeRevision);
      // 被拒的构建不留下额度占用：余额仍是外部预扣的那一份。
      expect(harness.admission.used("historyBuild")).toBe(budget);

      held.release();
      const retry = await harness.beginImport();
      await receiveHistory(harness);
      const finished = await harness.finishImport();
      expect(finished.outcome).toBe("committed");
      expect(finished.generation).toBe(retry.generation);

      const records = await harness.flatRecords();
      expect(records.length).toBe(HISTORY_PARTS.length);
      expect(textOfRecords(records, "h1", 0)).toBe(historyJson());
      expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: HISTORY_PARTS.length });
      expect(harness.admission.used("historyBuild")).toBe(0);
    });
  });

  test("超大文本按记录预算分片后导入成功：同 entry 片段逐条保留且不重复", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const oversized = "x".repeat(PLANE_CAPACITY.inputs.historyBlockHardBytes + 8192);

      const attempt = await harness.beginImport();
      await harness.acceptHistoryText(HISTORY_PARTS[0], { entryId: "h1", partIndex: 0 });
      // 单条超过块硬限不再停写：接收期按记录预算拆成多个可传输分片，构建期逐片提交。
      await harness.acceptHistoryText(oversized, { entryId: "h1", partIndex: 1 });
      const finished = await harness.finishImport();
      expect(finished.outcome).toBe("committed");
      expect(finished.generation).toBe(attempt.generation);

      const records = await harness.flatRecords();
      const decoder = new TextDecoder();
      const text = records
        .filter((record) => record.entryId === "h1" && record.contentSlot === 0)
        .sort((left, right) => left.partIndex - right.partIndex)
        .map((record) => JSON.parse(decoder.decode(record.payload)) as string)
        .join("");
      expect(text).toBe(`${HISTORY_PARTS[0]}${oversized}`);
      expect(duplicateRecordIds(records)).toEqual([]);
      const coverage = await harness.coverage();
      expect(coverage.gaps).toEqual([]);
      expect(coverage.duplicates).toEqual([]);
      expect(coverage.maxOrdinal).toBe(records.length);
    });
  });

  test("提交期失败（封口提交抛错）不把不完整代次设为 current，重试后目录连续、条数守恒", async () => {
    const payloads = ["A".repeat(100_000), "B".repeat(100_000)];
    // 第 2 次 `putSealedIfAbsent` 抛错：首个块已封口，第二个块失败，属「部分块已落地」的最坏提交期故障。
    await withFaultyHarness(
      { method: "putSealedIfAbsent", afterCalls: 1, error: new Error("injected seal failure") },
      async (harness, faulty) => {
        const primary = primaryOf(harness);
        await primary.handshake();
        await primary.subscribe();
        const beforeRevision = await harness.currentPointerRevision();
        const attempt = await harness.beginImport();
        await receiveHistory(harness, payloads);
        await harness.history().receivingComplete();
        await expectImportFailure(harness, () => harness.history().buildAndCommit(), "STAGING_FAILED", true);
        expect(faulty.didFire()).toBe(true);

        // 失败代次不是 current：指针与修订号不动，current 代次的目录里没有它的块。
        expect(await harness.currentGeneration()).toBe(harness.seedGeneration);
        expect(await harness.currentPointerRevision()).toBe(beforeRevision);
        expect(await harness.generationState(attempt.generation)).not.toBe("committed");
        expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: 0 });

        // 重试：同样的两块重新接收、构建、提交；块数与载荷长度逐条守恒。
        const retry = await harness.beginImport();
        expect(retry.generation).not.toBe(attempt.generation);
        await receiveHistory(harness, payloads);
        const finished = await harness.finishImport();
        expect(finished.outcome).toBe("committed");
        expect(finished.generation).toBe(retry.generation);

        const blocks = await harness.directoryBlocks();
        expect(blocks.length).toBeGreaterThanOrEqual(2);
        const records = await harness.flatRecords();
        expect(records.length).toBe(payloads.length);
        expect(records.map((record) => record.payload.byteLength)).toEqual(
          payloads.map((text) => JSON.stringify(text).length),
        );
        expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: payloads.length });
        expect(duplicateRecordIds(records)).toEqual([]);
        expect(await harness.currentPointerRevision()).toBe(beforeRevision + 1);
      },
    );
  });

  test("finalize 失败（换代提交抛错）不切到不完整代次，重试后修订号恰好 +1", async () => {
    const payloads = ["A".repeat(100_000), "B".repeat(100_000)];
    // 第 2 次 `commitGeneration` 抛错：第 1 次是夹具引导提交，第 2 次即本次 load 的 finalize。
    await withFaultyHarness(
      { method: "commitGeneration", afterCalls: 1, error: new Error("injected swap failure") },
      async (harness, faulty) => {
        const primary = primaryOf(harness);
        await primary.handshake();
        await primary.subscribe();
        const beforeRevision = await harness.currentPointerRevision();
        const attempt = await harness.beginImport();
        await receiveHistory(harness, payloads);
        await harness.history().receivingComplete();
        await harness.history().buildAndCommit();
        await expectImportFailure(harness, () => harness.history().finalize(), "STAGING_FAILED", true);
        expect(faulty.didFire()).toBe(true);

        // 指针停在旧代次且修订号不前进：客户端不会被带到只落了一半字节的代次上。
        expect(await harness.currentGeneration()).toBe(harness.seedGeneration);
        expect(await harness.currentPointerRevision()).toBe(beforeRevision);
        expect(await harness.generationState(attempt.generation)).not.toBe("committed");

        // 重试：完整重来一次，修订号只在成功那次前进一次。
        const retry = await harness.beginImport();
        await receiveHistory(harness, payloads);
        const finished = await harness.finishImport();
        expect(finished.outcome).toBe("committed");
        expect(finished.generation).toBe(retry.generation);
        expect(finished.pointerRevision).toBe(beforeRevision + 1);
        expect(await harness.generationState(retry.generation)).toBe("committed");
        const records = await harness.flatRecords();
        expect(records.length).toBe(payloads.length);
        expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: payloads.length });
      },
    );
  });
});

// ------------------------------------------------------------------ T09 慢客户端 / 后台标签页 / 多客户端不同速度

/** 收紧后的连接窗口：在途字节的判定边界与 `tightenWindow` 同值，避免用例里出现两处常数。 */
const TIGHT_WINDOW_BYTES = 32_768;

/** 慢端镜像里该 entry 的文本（与写入侧真值同口径：同一 entry/slot）。 */
function mirrorText(connection: PlaneConnection, docId: string): string {
  return textOfRecords(connection.mirror.records(docId), "turn-1:assistant", TEXT_SLOT);
}

/** 逐块写入并返回写入侧真值：由本层按写入顺序拼接，不读被测的合并结果。 */
async function writeChunks(harness: PlaneHarness, count: number, bodyBytes = 4096): Promise<string> {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const delta = `${index}:${"x".repeat(bodyBytes)}`;
    parts.push(delta);
    await harness.writeText(delta);
  }
  return parts.join("");
}

describe("T09 慢客户端、后台标签页与多客户端不同速度", () => {
  test("后台标签页暂停期间：在途字节不越过连接窗口，写入侧不等待，恢复后一次补齐", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 暂停 = 标签页被节流：仍收字节、仍进队列，但不 apply、不回执（与真实节流同一表现）。
      primary.pause();
      const expected = await writeChunks(harness, 12);

      // 写入侧没有被等待：12 次写入全部返回，真值也只由写入顺序决定。
      expect(harness.log.joined()).toBe(expected);
      // 在途有内容（说明确实发了）但从未越过窗口（说明没有超发）。
      expect(primary.audit.outstandingBytes()).toBeGreaterThan(0);
      expect(primary.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      // 只拿到前缀：窗口之外的内容必须等服务端拿到回执后再发，不能凭空补齐。
      const partial = mirrorText(primary, harness.seedContentDocId);
      expect(expected.startsWith(partial)).toBe(true);
      expect(partial.length).toBeLessThan(expected.length);

      primary.resume();
      await harness.pump();
      expect(mirrorText(primary, harness.seedContentDocId)).toBe(expected);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.applied.coverage(harness.seedContentDocId).gaps).toEqual([]);
      expect(primary.applied.duplicateUpdateSeqs(harness.seedContentDocId)).toEqual([]);
      expect(primary.hub.queueDepth()).toBe(0);
      expect(primary.fatal).toEqual([]);
    });
  });

  test("慢端不阻塞其他客户端：快端在慢端暂停期间拿到全部内容且账目归零", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const slow = primaryOf(harness);
      await slow.handshake();
      await slow.subscribe();
      const fast = await harness.connect("fast", { seed: "planes-fast" });
      await fast.handshake();
      await fast.subscribe();

      slow.pause();
      const expected = await writeChunks(harness, 12);

      // 快端不受慢端影响：内容齐全、账目清零、没有重复投递。
      expect(mirrorText(fast, harness.seedContentDocId)).toBe(expected);
      expect(fast.audit.outstandingBytes()).toBe(0);
      expect(fast.audit.duplicateDeliveries).toEqual([]);
      // 慢端被自己的窗口挡住（同一次写入对不同连接给出不同进度，慢端不拖累任何人）。
      expect(slow.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
      expect(slow.audit.outstandingBytes()).toBeGreaterThan(0);
      expect(expected.startsWith(mirrorText(slow, harness.seedContentDocId))).toBe(true);
      expect(mirrorText(slow, harness.seedContentDocId).length).toBeLessThan(expected.length);

      slow.resume();
      await harness.pump();
      expect(mirrorText(slow, harness.seedContentDocId)).toBe(expected);
      expect(slow.audit.outstandingBytes()).toBe(0);
      expect(slow.applied.coverage(harness.seedContentDocId).gaps).toEqual([]);
      expect(slow.applied.duplicateUpdateSeqs(harness.seedContentDocId)).toEqual([]);
      expect(fast.audit.duplicateDeliveries).toEqual([]);
    });
  });

  test("节流恢复后慢端镜像与已提交字节逐条一致：不重复、载荷相同", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      primary.pause();
      const expected = await writeChunks(harness, 10);
      expect(mirrorText(primary, harness.seedContentDocId)).not.toBe(expected);

      primary.resume();
      await harness.pump();
      // 逐条比对记录身份与载荷（不比对 Yjs 编码字节：不同构建顺序的 canonical 编码不可逐字节比较）。
      const submitted = await harness.canonicalRecords(harness.seedContentDocId);
      const mirrored = primary.mirror.records(harness.seedContentDocId);
      expect(mirrored.map((record) => record.recordId)).toEqual(submitted.map((record) => record.recordId));
      expect(mirrored.map((record) => [...record.payload])).toEqual(submitted.map((record) => [...record.payload]));
      expect(duplicateRecordIds(mirrored)).toEqual([]);
      expect(textOfRecords(mirrored, "turn-1:assistant", TEXT_SLOT)).toBe(expected);
    });
  });

  test("多客户端不同速度：两个不同步的慢端各自有界，恢复后三方内容一致", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const slowest = primaryOf(harness);
      await slowest.handshake();
      await slowest.subscribe();
      const normal = await harness.connect("normal", { seed: "planes-normal" });
      await normal.handshake();
      await normal.subscribe();
      const late = await harness.connect("late", { seed: "planes-late" });
      await late.handshake();
      await late.subscribe();

      slowest.pause();
      const first = await writeChunks(harness, 6);
      // 第二个慢端在中间才停下：它已有的进度与第一个慢端不同。
      late.pause();
      const second = await writeChunks(harness, 6);
      const expected = first + second;

      expect(mirrorText(normal, harness.seedContentDocId)).toBe(expected);
      expect(normal.audit.outstandingBytes()).toBe(0);
      for (const connection of [slowest, late]) {
        expect(connection.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
        expect(connection.audit.duplicateDeliveries).toEqual([]);
        expect(expected.startsWith(mirrorText(connection, harness.seedContentDocId))).toBe(true);
      }
      expect(mirrorText(slowest, harness.seedContentDocId).length).toBeLessThan(
        mirrorText(late, harness.seedContentDocId).length,
      );

      slowest.resume();
      late.resume();
      await harness.pump();
      expect([slowest, normal, late].map((connection) => mirrorText(connection, harness.seedContentDocId))).toEqual([
        expected,
        expected,
        expected,
      ]);
      expect(slowest.audit.outstandingBytes()).toBe(0);
      expect(late.audit.outstandingBytes()).toBe(0);
      expect(slowest.applied.coverage(harness.seedContentDocId).gaps).toEqual([]);
      expect(late.applied.coverage(harness.seedContentDocId).gaps).toEqual([]);
    });
  });

  test("更小的连接窗口同样约束在途（8KiB 档）：慢端仍有界，恢复后内容一次补齐", async () => {
    const windowBytes = 8_192;
    await withHarness({ windowBytes }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      primary.pause();
      const expected = await writeChunks(harness, 16, 1024);

      // 内容总量远大于窗口：超发会在这里直接暴露（在途字节越过窗口值）。
      expect(expected.length).toBeGreaterThan(windowBytes);
      expect(primary.audit.outstandingBytes()).toBeLessThanOrEqual(windowBytes);
      expect(expected.startsWith(mirrorText(primary, harness.seedContentDocId))).toBe(true);
      expect(mirrorText(primary, harness.seedContentDocId).length).toBeLessThan(expected.length);

      primary.resume();
      await harness.pump();
      expect(mirrorText(primary, harness.seedContentDocId)).toBe(expected);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.applied.coverage(harness.seedContentDocId).gaps).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ T10 回执丢失 / 重复 / 旧代次，丢 update 后重连

/** 入站回执帧（类型收窄到 `APPLY_ACK`）：统计线上真实发生过的回执次数。 */
function ackFrames(connection: PlaneConnection): ApplyAckFrame[] {
  return connection.link.observedInbound.filter((frame): frame is ApplyAckFrame => frame.type === "APPLY_ACK");
}

/** 取最近一条已投递数据帧的身份：伪造回执必须复用真实 deliveryId 才叫「旧代次回执」。 */
function lastDeliveredFrame(connection: PlaneConnection): {
  deliveryId: string;
  transportEpoch: string;
  docId: string;
} {
  for (let index = connection.link.accepted.length - 1; index >= 0; index -= 1) {
    const frame = connection.link.accepted[index].frame;
    if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") {
      return { deliveryId: frame.deliveryId, transportEpoch: frame.transportEpoch, docId: frame.docId };
    }
  }
  throw new Error("acceptance: connection has no delivered data frame");
}

describe("T10 回执丢失、重复与旧代次，丢 update 后重连", () => {
  test("回执丢失：到期终止该连接，之后不再堆积新投递（在途不无限增长）", async () => {
    const ackMs = 5_000;
    await withHarness({ ackMs }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 只丢回执：数据帧照常到达，服务端却永远收不到结清。
      primary.link.dropInbound = (frame) => frame.type === "APPLY_ACK";
      await harness.writeText("lost-ack");
      expect(mirrorText(primary, harness.seedContentDocId)).toBe("lost-ack");
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);
      expect(primary.audit.outstandingBytes()).toBeGreaterThan(0);

      // 未到期限不掉线：期限判的是「无进展满 ackDeadlineMs」，不是「存在未回执投递」。
      harness.time.advance(ackMs - 1);
      await harness.pump();
      expect(primary.link.closeReasons).toEqual([]);
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);

      harness.time.advance(1);
      await harness.pump();
      expect(primary.link.closeReasons.length).toBe(1);
      // 连接终止即清账：账目与额度都不留在死连接上。
      expect(primary.gateway.outstandingDeliveries()).toBe(0);

      // 终态之后不再产生新投递：数据帧总量与客户端内容都停住，在途因此不会继续增长。
      const deliveredCount = primary.link.accepted.length;
      await harness.writeText("after-close");
      await harness.pump();
      expect(primary.link.accepted.length).toBe(deliveredCount);
      expect(mirrorText(primary, harness.seedContentDocId)).toBe("lost-ack");
      expect(primary.client.hub.queueDepth()).toBe(0);
    });
  });

  test("重复回执只结清一次：账目归零、无重复投递，窗口在后续写入中仍为硬约束", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 每条回执都投递两次（同一帧走两次真实派发路径）；订阅期的回执发生在挂钩子之前，单独排除。
      const acksBefore = ackFrames(primary).length;
      primary.link.duplicateInbound = (frame) => frame.type === "APPLY_ACK";

      const first = await writeChunks(harness, 12);
      expect(mirrorText(primary, harness.seedContentDocId)).toBe(first);
      const window = ackFrames(primary).slice(acksBefore);
      const distinct = new Set(window.map((frame) => frame.deliveryId)).size;
      // 线上确实发生了重复回执，否则本用例什么都没验证。
      expect(distinct).toBeGreaterThan(0);
      expect(window.length).toBe(distinct * 2);
      expect(primary.gateway.outstandingDeliveries()).toBe(0);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.client.hub.queueDepth()).toBe(0);

      // 额度账目没有被重复归还改写：再写一轮同样大小的内容，仍然只按窗口推进。
      const second = await writeChunks(harness, 12);
      expect(mirrorText(primary, harness.seedContentDocId)).toBe(first + second);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.audit.unknownAcks).toEqual([]);
      expect(primary.fatal).toEqual([]);
    });
  });

  test("旧代次回执被丢弃：不结清在途，投递仍按期超时并终止连接", async () => {
    const ackMs = 5_000;
    await withHarness({ ackMs }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 真实回执一律丢弃：能结清在途的就只剩那条伪造的旧代次回执。
      primary.link.dropInbound = (frame) => frame.type === "APPLY_ACK";
      const expected = await writeChunks(harness, 3);
      expect(mirrorText(primary, harness.seedContentDocId)).toBe(expected);

      const delivered = lastDeliveredFrame(primary);
      const forged: ApplyAckFrame = {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: `${delivered.transportEpoch}-stale`,
        deliveryId: delivered.deliveryId,
        result: "processed",
        docId: delivered.docId,
        appliedSeq: 1,
      };
      // 真实回执继续丢，只放行这条伪造帧：它必须走到网关的派发逻辑里被按旧代次丢弃。
      primary.link.dropInbound = (frame) =>
        frame.type === "APPLY_ACK" && frame.transportEpoch !== forged.transportEpoch;
      harness.queueClientFrame(primary, forged);

      harness.time.advance(ackMs - 1);
      await harness.pump();
      // 异代次回执在网关派发前就被丢弃：它的 deliveryId 仍挂在账上，期限一到照常断开。
      expect(primary.audit.staleEpochAcks).toEqual([delivered.deliveryId]);
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);
      expect(primary.link.closeReasons).toEqual([]);

      harness.time.advance(1);
      await harness.pump();
      expect(primary.link.closeReasons.length).toBe(1);
      // 账目在终态前一直挂着那条投递，直到连接终止才成对清账。
      expect(primary.gateway.outstandingDeliveries()).toBe(0);
    });
  });

  test("丢 update 后重连：客户端检出缺口并 RESYNC，补齐后序号连续且申请次数有界", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const docId = harness.seedContentDocId;
      // 只丢一条增量帧：客户端会在紧随其后的增量上看到序号缺口。
      let dropped = 0;
      primary.link.dropOutbound = (frame) => {
        if (frame.type !== "DOC_UPDATE" || dropped > 0) return false;
        dropped += 1;
        return true;
      };

      const parts: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const delta = `${index}:${"x".repeat(1024)}`;
        parts.push(delta);
        await harness.writeText(delta);
      }
      const expected = parts.join("");
      await harness.pump();
      expect(dropped).toBe(1);

      // 缺口由客户端发现并主动申请补齐（服务端不猜），申请次数有界（不做无边界重试）。
      const resyncs = primary.link.observedInbound.filter((frame) => frame.type === "RESYNC");
      expect(resyncs.length).toBeGreaterThanOrEqual(1);
      expect(resyncs.length).toBeLessThanOrEqual(2);
      // 补齐后内容与写入侧一致，且镜像里没有重复记录。
      expect(mirrorText(primary, docId)).toBe(expected);
      expect(duplicateRecordIds(primary.mirror.records(docId))).toEqual([]);
      expect(primary.applied.coverage(docId).gaps).toEqual([]);
      expect(primary.applied.duplicateUpdateSeqs(docId)).toEqual([]);
      expect(primary.fatal).toEqual([]);
      // 被丢弃的投递仍挂在账上（永远等不到回执），但它在途字节不超过一个窗口。
      expect(primary.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
    });
  });
});

// ------------------------------------------------------------------ T11 写者竞争 / 租约过期 / 通知丢失

/** 夹具自己在存储边界上登记一条 staging 代次（不经导入服务：T11 只关心写权与修订号的裁决）。 */
function stagingGeneration(harness: PlaneHarness, generation: string): SyncGenerationRecord {
  return {
    scopeKey: harness.scopeKey,
    generation,
    acpSessionId: "acp-planes",
    loadId: `load-${generation}`,
    state: "staging",
    importEndOrdinal: null,
    entryRefs: harness.seedEntryRefs,
    createdAt: harness.time.now(),
  };
}

/** 存储里的写者归属：竞争判定的独立口径（不读被测运行时的内存状态）。 */
async function writerOwner(harness: PlaneHarness): Promise<string | null> {
  const pointer = await harness.store.readScopePointer(harness.scopeKey);
  return pointer?.writerOwner ?? null;
}

describe("T11 两个写者竞争、租约过期与旧 epoch", () => {
  test("两个写者竞争：第二个写者被 SCOPE_BUSY 拒绝，存储里的写者与已提交内容都不变", async () => {
    await withHarness({}, async (harness) => {
      const holder = primaryOf(harness);
      await holder.handshake();
      await holder.subscribe();
      const rival = await harness.connect("rival", { seed: "planes-rival" });
      await rival.handshake();
      await rival.subscribe();

      await harness.writeText("holder");
      const ownerBefore = await writerOwner(harness);
      const recordsBefore = await harness.canonicalRecords(harness.seedContentDocId);

      // 同一时刻只有一个有效写者：竞争者的输入被明确拒绝，不排队、不等待。
      const rejected = await expectProtocolError(() => rival.writeText("intruder"), "SCOPE_BUSY");
      expect(rejected.retryable).toBe(true);
      expect(await writerOwner(harness)).toBe(ownerBefore);
      // 被拒的输入一个字节都没有落地。
      const recordsAfter = await harness.canonicalRecords(harness.seedContentDocId);
      expect(recordsAfter.map((record) => record.recordId)).toEqual(recordsBefore.map((record) => record.recordId));
      expect(textOfRecords(recordsAfter, "turn-1:assistant", TEXT_SLOT)).toBe("holder");

      // 当前写者不受竞争影响：它的下一次写入照常提交。
      await harness.writeText("!");
      expect(
        textOfRecords(await harness.canonicalRecords(harness.seedContentDocId), "turn-1:assistant", TEXT_SLOT),
      ).toBe("holder!");
    });
  });

  test("租约过期后写者让位：新写者接管，旧写者的后续写入被 fencing 拒绝且不落字节", async () => {
    await withHarness({}, async (harness) => {
      const stale = primaryOf(harness);
      await stale.handshake();
      await stale.subscribe();
      const successor = await harness.connect("successor", { seed: "planes-successor" });
      await successor.handshake();
      await successor.subscribe();

      await harness.writeText("aaa");
      const ownerBefore = await writerOwner(harness);
      harness.time.advance(WRITER_LEASE_TTL_MS + 1);
      await harness.pump();
      // 租约到期即写权回到可用状态：接管者取得新 epoch 并成功写入。
      await successor.writeText("bbb");
      expect(await writerOwner(harness)).not.toBe(ownerBefore);

      // 旧写者的每一次新写入都被拒绝：不续租、不落字节，且失败被记住（不会在后续写入里「恢复」）。
      const fenced = await expectProtocolError(() => harness.writeText("ccc"), "LEASE_EXPIRED");
      expect(fenced.retryable).toBe(false);
      await expectProtocolError(() => harness.writeText("ddd"), "LEASE_EXPIRED");

      const records = await harness.canonicalRecords(harness.seedContentDocId);
      expect(textOfRecords(records, "turn-1:assistant", TEXT_SLOT)).toBe("aaabbb");
      expect(duplicateRecordIds(records)).toEqual([]);
      // 接管者的客户端拿到完整内容：旧写者已提交的字节不会被丢弃。
      expect(mirrorText(successor, harness.seedContentDocId)).toBe("aaabbb");
    });
  });

  test("旧 epoch 直写存储被拒：过期租约 LEASE_EXPIRED，已被顶替的租约 WRITER_EPOCH_LOST", async () => {
    await withHarness({}, async (harness) => {
      // 引导租约在夹具返回前已过期，且此刻还没有写者接管：拒绝理由必须是「过期」。
      await expectProtocolError(
        () =>
          harness.store.createGeneration({
            scopeKey: harness.scopeKey,
            epoch: harness.bootstrapLease.epoch,
            generation: stagingGeneration(harness, "gen-planes-stale-a"),
          }),
        "LEASE_EXPIRED",
      );

      // 真实写者接管后 epoch 前进：同一份旧租约变成「被顶替」，拒绝理由随之改变。
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      await harness.writeText("owner");
      await expectProtocolError(
        () =>
          harness.store.createGeneration({
            scopeKey: harness.scopeKey,
            epoch: harness.bootstrapLease.epoch,
            generation: stagingGeneration(harness, "gen-planes-stale-b"),
          }),
        "WRITER_EPOCH_LOST",
      );

      // 两次被拒都不留痕迹：旧租约不能凭写入凭空造出代次登记。
      expect(await harness.generationState("gen-planes-stale-a")).toBe("unknown");
      expect(await harness.generationState("gen-planes-stale-b")).toBe("unknown");
    });
  });

  test("换写者后旧已提交字节可重发：新接入的连接订阅到与存储侧逐条一致的内容", async () => {
    await withHarness({}, async (harness) => {
      const first = primaryOf(harness);
      await first.handshake();
      await first.subscribe();
      await harness.writeText("first-");

      harness.time.advance(WRITER_LEASE_TTL_MS + 1);
      await harness.pump();
      const second = await harness.connect("second", { seed: "planes-handover" });
      await second.handshake();
      await second.subscribe();
      await second.writeText("second-");

      // 第三条连接在换写者之后才接入：它的基线必须覆盖换写者之前的已提交字节。
      const late = await harness.connect("late", { seed: "planes-late-reader" });
      await late.handshake();
      await late.subscribe();
      expect(mirrorText(late, harness.seedContentDocId)).toBe("first-second-");
      const coverage = late.applied.coverage(harness.seedContentDocId);
      expect(coverage.gaps).toEqual([]);
      expect(coverage.maxSeq).toBeGreaterThanOrEqual(2);

      // 重发的字节与存储侧已提交字节逐条一致（不是重新生成的内容）。
      const submitted = await harness.canonicalRecords(harness.seedContentDocId);
      const mirrored = late.mirror.records(harness.seedContentDocId);
      expect(mirrored.map((record) => record.recordId)).toEqual(submitted.map((record) => record.recordId));
      expect(mirrored.map((record) => [...record.payload])).toEqual(submitted.map((record) => [...record.payload]));
    });
  });

  test("旧入口 revision 不能回退：陈旧修订在存储与连接两侧都被拒，指针只前进", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const revision = await harness.currentPointerRevision();
      expect(revision).toBeGreaterThan(0);

      // 连接侧：陈旧的 GENERATION_REPLACE 被拒，会话不切换到旧入口。
      const refs = await harness.currentEntryRefs();
      const stale: GenerationReplaceFrame = {
        type: "GENERATION_REPLACE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        generation: harness.seedGeneration,
        pointerRevision: revision - 1,
        referenceRevision: revision - 1,
        controlDocId: refs.controlDocId,
        directoryDocId: refs.directoryDocId,
        runtimeDocId: refs.runtimeDocId,
      };
      const rejected = await expectProtocolError(() => primary.sendFrameNow(stale), "POINTER_REVISION_STALE");
      expect(rejected.retryable).toBe(false);
      expect(primary.control.filter((frame) => frame.type === "GENERATION_REPLACE")).toEqual([]);
      expect(await harness.currentGeneration()).toBe(harness.seedGeneration);

      // 连接继续服务当前代次：写入照常送达。
      await harness.writeText("still-current");
      expect(mirrorText(primary, harness.seedContentDocId)).toBe("still-current");

      // 存储侧：写者接管后仍用陈旧修订提交换代，只得到冲突，指针与代次都不回退。
      harness.time.advance(WRITER_LEASE_TTL_MS + 1);
      const lease = await harness.store.acquireWriter(harness.scopeKey, "t11-stale-revision", WRITER_LEASE_TTL_MS);
      const staging = stagingGeneration(harness, "gen-planes-stale-revision");
      await harness.store.createGeneration({
        scopeKey: harness.scopeKey,
        epoch: lease.epoch,
        generation: staging,
      });
      const outcome = await harness.store.commitGeneration({
        scopeKey: harness.scopeKey,
        epoch: lease.epoch,
        expectedCurrent: harness.seedGeneration,
        newGeneration: staging,
        retired: [],
        entryClosure: harness.seedEntryRefs,
        expectedPointerRevision: revision - 1,
      });
      expect(outcome.outcome).toBe("conflict");
      expect(outcome.currentGeneration).toBe(harness.seedGeneration);
      expect(outcome.pointerRevision).toBe(revision);
      expect(await harness.currentPointerRevision()).toBe(revision);
      expect(await harness.generationState("gen-planes-stale-revision")).not.toBe("committed");
      // 已经落到客户端的已提交字节不受这次被拒的换代影响。
      expect(mirrorText(primary, harness.seedContentDocId)).toBe("still-current");
    });
  });
});

// ------------------------------------------------------------------ T12 并发 load 与持续实时输出

/** 在指定连接的服务上走完一次导入：接收 → 封口 → 构建提交 → 换代。 */
async function importOnService(
  service: SyncScopeRuntime["history"],
  scope: SyncScope,
  input: { readonly owner: string; readonly leaseTtlMs: number; readonly parts: readonly string[] },
): Promise<{ outcome: string; generation: string; pointerRevision: number }> {
  await service.begin({ scope, acpSessionId: "acp-planes", owner: input.owner, leaseTtlMs: input.leaseTtlMs });
  for (const [index, text] of input.parts.entries()) {
    await service.accept(text, { kind: "text_part", entryId: "h1", contentSlot: 0, partIndex: index });
  }
  await service.receivingComplete();
  await service.buildAndCommit();
  return await service.finalize();
}

describe("T12 两个历史 load 并发与持续实时输出", () => {
  test("同 scope 第二个 load 被拒：同一服务的重复 begin 与另一条连接的 begin 都是 SCOPE_BUSY", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const attempt = await harness.beginImport();
      const other = await harness.connect("other", { seed: "planes-t12-other" });

      // 同一服务：接收窗口敞着时不得再开第二个尝试（两个 load 共用编号空间会让目录静默穿插）。
      const sameService = await expectProtocolError(() => harness.beginImport(), "SCOPE_BUSY");
      expect(sameService.retryable).toBe(true);
      // 另一条连接的服务：写权已被导入持有，新尝试连租约都拿不到。
      const otherService = await expectProtocolError(
        () =>
          other.runtime.history.begin({
            scope: harness.scope,
            acpSessionId: "acp-planes",
            owner: "t12-second-import",
            leaseTtlMs: 120_000,
          }),
        "SCOPE_BUSY",
      );
      expect(otherService.retryable).toBe(true);
      // 第二个连接没有建出任何尝试，也不影响第一个导入的结果。
      expect(other.runtime.history.status().generation).toBe("");
      expect(await writerOwner(harness)).toBe("planes-importer");

      await receiveHistory(harness);
      const finished = await harness.finishImport();
      expect(finished.outcome).toBe("committed");
      expect(finished.generation).toBe(attempt.generation);
      expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: HISTORY_PARTS.length });
    });
  });

  test("全局额度上限生效：构建池被占满时另一条连接的导入被拒，归还后重试成功且额度归零", async () => {
    await withHarness({}, async (harness) => {
      const budget = harness.config.capacity.serverPools.historyBuild;
      const importer = await harness.connect("importer", { seed: "planes-t12-importer" });
      const service = importer.runtime.history;
      const leaseTtlMs = 120_000;

      // 额度账目是进程内单一实例，与连接无关：外部占满整池等于「其他连接把池用光」。
      const held = harness.admission.reserve("historyBuild", budget);
      const attempt = await service.begin({
        scope: harness.scope,
        acpSessionId: "acp-planes",
        owner: "t12-importer",
        leaseTtlMs,
      });
      await service.accept("payload", { kind: "text_part", entryId: "h1", contentSlot: 0, partIndex: 0 });
      await service.receivingComplete();
      const rejected = await expectProtocolError(() => service.buildAndCommit(), "ADMISSION_REJECTED");
      expect(rejected.retryable).toBe(true);
      expect(service.status().failure?.code).toBe("ADMISSION_REJECTED");
      expect(await harness.generationState(attempt.generation)).not.toBe("committed");
      // 被拒的构建不留下额度占用：账目仍是外部预扣的那一份。
      expect(harness.admission.used("historyBuild")).toBe(budget);

      held.release();
      expect(harness.admission.used("historyBuild")).toBe(0);
      expect(harness.admission.available("historyBuild")).toBe(budget);

      // 归还后同一条连接重试：构建与换代成功，额度再次归零（没有因失败泄漏半份账目）。
      const finished = await importOnService(service, harness.scope, {
        owner: "t12-importer",
        leaseTtlMs,
        parts: ["one|"],
      });
      expect(finished.outcome).toBe("committed");
      expect(harness.admission.used("historyBuild")).toBe(0);
      expect(textOfRecords(await harness.flatRecords(), "h1", 0)).toBe(historyJson(["one|"]));
      expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: 1 });
    });
  });

  test("多块导入不被饿死：全部块构建提交、条数与载荷逐条守恒、目录连续", async () => {
    // 单条 100KB 记录超出 128KiB 的块目标：必须落到不同的块里，构建池要连续处理整组块。
    const payloads = ["A", "B", "C", "D", "E"].map((letter) => letter.repeat(100_000));
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      await harness.beginImport();
      await receiveHistory(harness, payloads);
      const finished = await harness.finishImport();
      expect(finished.outcome).toBe("committed");

      const blocks = await harness.directoryBlocks();
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      // 构建池全部结算：池内部计数不在冻结契约的公开面上（`SyncScopeRuntime` 只暴露连接与导入入口），
      // 改用同一份账目的外部可观测量——池占用的 `historyBuild` 额度必须归零（饿死会表现为额度不归还）。
      expect(harness.admission.used("historyBuild")).toBe(0);

      const records = await harness.flatRecords();
      expect(records.length).toBe(payloads.length);
      expect(records.map((record) => record.payload.byteLength)).toEqual(
        payloads.map((text) => JSON.stringify(text).length),
      );
      expect(textOfRecords(records, "h1", 0)).toBe(historyJson(payloads));
      expect(duplicateRecordIds(records)).toEqual([]);
      expect(await harness.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: payloads.length });
    });
  });

  test("跨 scope 的两个 load 可以同时进行：各自持有自己的写权，内容互不污染", async () => {
    const clock = new PlaneClock();
    // 两个 scope 共用一份存储与时钟，但租约、代次与目录按 scope 分开。
    const store = createPlaneStore(PLANE_CAPACITY, clock);
    const alpha = await createPlaneHarness({
      scope: { organizationId: "org-planes", rcsSessionId: "session-alpha" },
      store,
      clock,
      seed: "planes-alpha",
    });
    const beta = await createPlaneHarness({
      scope: { organizationId: "org-planes", rcsSessionId: "session-beta" },
      store,
      clock,
      seed: "planes-beta",
    });
    const alphaParts = ["alpha-1|", "alpha-2|"];
    const betaParts = ["beta-1|", "beta-2|", "beta-3|"];
    try {
      const alphaImport = await alpha.beginImport({ owner: "importer-alpha", leaseTtlMs: 120_000 });
      const betaImport = await beta.beginImport({ owner: "importer-beta", leaseTtlMs: 120_000 });
      expect(alphaImport.generation).not.toBe(betaImport.generation);
      // 两个 load 同时持有写权：一个 scope 的单写权不阻塞另一个 scope。
      expect(await writerOwner(alpha)).toBe("importer-alpha");
      expect(await writerOwner(beta)).toBe("importer-beta");
      await receiveHistory(alpha, alphaParts);
      await receiveHistory(beta, betaParts);
      await alpha.history().receivingComplete();
      await beta.history().receivingComplete();

      // 两个构建/换代真并行（同一事件循环里交错推进），各自完成。
      const [alphaDone, betaDone] = await Promise.all([alpha.finishImport(), beta.finishImport()]);
      expect(alphaDone.outcome).toBe("committed");
      expect(betaDone.outcome).toBe("committed");
      expect(await alpha.currentGeneration()).toBe(alphaImport.generation);
      expect(await beta.currentGeneration()).toBe(betaImport.generation);

      // 内容互不污染：各自的目录只覆盖自己的对象。
      expect(textOfRecords(await alpha.flatRecords(), "h1", 0)).toBe(historyJson(alphaParts));
      expect(textOfRecords(await beta.flatRecords(), "h1", 0)).toBe(historyJson(betaParts));
      expect(await alpha.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: alphaParts.length });
      expect(await beta.coverage()).toEqual({ gaps: [], duplicates: [], maxOrdinal: betaParts.length });
      expect(await alpha.generationState(betaImport.generation)).toBe("unknown");
      expect(await beta.generationState(alphaImport.generation)).toBe("unknown");
    } finally {
      await alpha.disposeAll();
      await beta.disposeAll();
    }
  });

  test("导入持写权期间的实时写入明确失败：租约到期后写者让位、内容与镜像都恢复实时", async () => {
    const leaseTtlMs = 5_000;
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      await harness.beginImport({ owner: "t12-importer", leaseTtlMs });
      expect(await writerOwner(harness)).toBe("t12-importer");

      // 导入期间实时写入让位：明确忙，不排队、不等待。
      const busy = await expectProtocolError(() => harness.writeText("during-import"), "SCOPE_BUSY");
      expect(busy.retryable).toBe(true);
      expect(
        textOfRecords(await harness.canonicalRecords(harness.seedContentDocId), "turn-1:assistant", TEXT_SLOT),
      ).toBe("");

      // 导入租约到期后写者接管：实时写入立刻恢复，客户端镜像也跟上。
      harness.time.advance(leaseTtlMs + 1);
      await harness.pump();
      await harness.writeText("after-import");
      expect(await writerOwner(harness)).not.toBe("t12-importer");
      expect(
        textOfRecords(await harness.canonicalRecords(harness.seedContentDocId), "turn-1:assistant", TEXT_SLOT),
      ).toBe("after-import");
      expect(mirrorText(primary, harness.seedContentDocId)).toBe("after-import");
    });
  });
});
