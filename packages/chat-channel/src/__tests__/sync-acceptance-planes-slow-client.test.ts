// 同步端到端行为验收。
import { describe, expect, test } from "bun:test";
import {
  liveContentIds,
  mirrorText,
  primaryOf,
  TIGHT_WINDOW_BYTES,
  withHarness,
  writeChunks,
} from "./sync-acceptance-planes-fixture";
import { duplicateRecordIds, TEXT_SLOT, textOfRecords } from "./sync-acceptance-planes-oracle";

describe("T09 慢客户端、后台标签页与多客户端不同速度", () => {
  // 后台标签页暂停期间：在途字节不越过连接窗口，写入侧不等待，恢复后一次补齐。
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
      const partial = mirrorText(primary, harness);
      expect(expected.startsWith(partial)).toBe(true);
      expect(partial.length).toBeLessThan(expected.length);

      primary.resume();
      await harness.pump();
      expect(mirrorText(primary, harness)).toBe(expected);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expectLiveCoverage(harness, primary);
      expect(primary.applied.duplicateUpdateSeqs(harness.seedContentDocId)).toEqual([]);
      expect(primary.hub.queueDepth()).toBe(0);
      expect(primary.fatal).toEqual([]);
    });
  });

  // 慢端不阻塞其他客户端：快端在慢端暂停期间拿到全部内容且账目归零。
  test("慢端不阻塞其他客户端：快端在慢端暂停期间拿到全部内容且账目归零", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const slow = primaryOf(harness);
      await slow.handshake();
      await slow.subscribe();
      const fast = await harness.connect("fast", { seed: "planes-fast" });
      await fast.handshake();
      await fast.subscribe();

      slow.pause();
      const expected = await writeChunks(harness, 12, 4096, [slow, fast]);

      // 快端不受慢端影响：内容齐全、账目清零、没有重复投递。
      expect(mirrorText(fast, harness)).toBe(expected);
      expect(fast.audit.outstandingBytes()).toBe(0);
      expect(fast.audit.duplicateDeliveries).toEqual([]);
      // 慢端被自己的窗口挡住（同一次写入对不同连接给出不同进度，慢端不拖累任何人）。
      expect(slow.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
      expect(slow.audit.outstandingBytes()).toBeGreaterThan(0);
      expect(expected.startsWith(mirrorText(slow, harness))).toBe(true);
      expect(mirrorText(slow, harness).length).toBeLessThan(expected.length);

      slow.resume();
      await harness.pump();
      expect(mirrorText(slow, harness)).toBe(expected);
      expect(slow.audit.outstandingBytes()).toBe(0);
      expectLiveCoverage(harness, slow);
      expect(slow.applied.duplicateUpdateSeqs(harness.seedContentDocId)).toEqual([]);
      expect(fast.audit.duplicateDeliveries).toEqual([]);
    });
  });

  // 节流恢复后慢端镜像与已提交字节逐条一致：不重复、载荷相同。
  test("节流恢复后慢端镜像与已提交字节逐条一致：不重复、载荷相同", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      primary.pause();
      const expected = await writeChunks(harness, 10);
      expect(mirrorText(primary, harness)).not.toBe(expected);

      primary.resume();
      await harness.pump();
      // 逐条比对记录身份与载荷（不比对 Yjs 编码字节：不同构建顺序的 canonical 编码不可逐字节比较）。
      const submitted = (await Promise.all(liveContentIds(harness).map((id) => harness.canonicalRecords(id)))).flat();
      const mirrored = liveContentIds(harness).flatMap((id) => primary.mirror.records(id));
      expect(mirrored.map((record) => record.recordId)).toEqual(submitted.map((record) => record.recordId));
      expect(mirrored.map((record) => [...record.payload])).toEqual(submitted.map((record) => [...record.payload]));
      expect(duplicateRecordIds(mirrored)).toEqual([]);
      expect(textOfRecords(mirrored, "turn-1:assistant", TEXT_SLOT)).toBe(expected);
    });
  });

  // 多客户端不同速度：两个不同步的慢端各自有界，恢复后三方内容一致。
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
      const first = await writeChunks(harness, 6, 4096, [slowest, normal, late]);
      // 第二个慢端在中间才停下：它已有的进度与第一个慢端不同。
      late.pause();
      const second = await writeChunks(harness, 6, 4096, [slowest, normal, late]);
      const expected = first + second;

      expect(mirrorText(normal, harness)).toBe(expected);
      expect(normal.audit.outstandingBytes()).toBe(0);
      for (const connection of [slowest, late]) {
        expect(connection.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
        expect(connection.audit.duplicateDeliveries).toEqual([]);
        expect(expected.startsWith(mirrorText(connection, harness))).toBe(true);
      }
      expect(mirrorText(slowest, harness).length).toBeLessThan(mirrorText(late, harness).length);

      slowest.resume();
      late.resume();
      await harness.pump();
      expect([slowest, normal, late].map((connection) => mirrorText(connection, harness))).toEqual([
        expected,
        expected,
        expected,
      ]);
      expect(slowest.audit.outstandingBytes()).toBe(0);
      expect(late.audit.outstandingBytes()).toBe(0);
      expectLiveCoverage(harness, slowest);
      expectLiveCoverage(harness, late);
    });
  });

  // 更小的连接窗口同样约束在途（8KiB 档）：慢端仍有界，恢复后内容一次补齐。
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
      await expectPartialLiveText(harness, primary, expected);
      expect(mirrorText(primary, harness).length).toBeLessThan(expected.length);

      primary.resume();
      await harness.pump();
      expect(mirrorText(primary, harness)).toBe(expected);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expectLiveCoverage(harness, primary);
    });
  });
});

// ------------------------------------------------------------------ T10 回执丢失 / 重复 / 旧代次，丢 update 后重连

/** 入站回执帧（类型收窄到 `APPLY_ACK`）：统计线上真实发生过的回执次数。 */

import { expectLiveCoverage, expectPartialLiveText } from "./sync-acceptance-planes-fixture";
