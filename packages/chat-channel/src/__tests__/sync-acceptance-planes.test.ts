// 同步端到端行为验收。
import { describe, expect, test } from "bun:test";
import type { SyncErrorCode } from "../sync/protocol/errors";
import { expectProtocolError, primaryOf, withFaultyHarness, withHarness } from "./sync-acceptance-planes-fixture";
import {
  duplicateRecordIds,
  PLANE_CAPACITY,
  type PlaneHarness,
  TEXT_SLOT,
  textOfRecords,
} from "./sync-acceptance-planes-oracle";

describe("T00 夹具自检", () => {
  // 端到端冒烟：握手 → 订阅 → 实时写入 → 客户端收到同一份文本。
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

  // 客户端镜像与已提交字节一致：实时写入的记录可从存储侧复现。
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

/**
 * 断言一次导入动作以原始异常失败，同时（服务层的可判定出口）`status()` 暴露稳定码与可重试判定。
 *
 * `HistoryImportService` 的三个动作在失败时**原样抛出**内部异常（保留 cause，交由上层归一化），
 * 稳定码只经 `status().failure` 暴露——因此这里两个事实都断言，缺一不可。
 */
async function expectImportFailure(
  harness: PlaneHarness,
  run: () => Promise<unknown>,
  code: SyncErrorCode,
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
  // 接收期失败（重复对象被拒）不切换代次，重试后输入对象逐条保留且不重复。
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

  // 构建阶段才占满预算，独立验证封存后的构建失败与整轮重试。
  test("构建期失败（构建池额度被外部占满）后重试：不误跳过对象，归还额度后覆盖连续", async () => {
    await withHarness({}, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const beforeRevision = await harness.currentPointerRevision();
      const budget = harness.config.capacity.serverPools.historyBuild;

      const attempt = await harness.beginImport();
      await receiveHistory(harness);
      await harness.history().receivingComplete();
      const held = harness.admission.reserve("historyBuild", budget);
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

  // 超大文本按记录预算分片后导入成功：同 entry 片段逐条保留且不重复。
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

  // 提交期失败（封口提交抛错）不把不完整代次设为 current，重试后目录连续、条数守恒。
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

  // finalize 失败（换代提交抛错）不切到不完整代次，重试后修订号恰好 +1。
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

import { HISTORY_PARTS, historyJson, receiveHistory } from "./sync-acceptance-planes-fixture";
