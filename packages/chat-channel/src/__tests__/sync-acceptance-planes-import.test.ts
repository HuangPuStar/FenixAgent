// 同步端到端行为验收。
import { describe, expect, test } from "bun:test";

import { type SyncScope } from "../sync/protocol/identity";

import type { SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { expectProtocolError, mirrorText, primaryOf, withHarness } from "./sync-acceptance-planes-fixture";
import {
  createPlaneHarness,
  createPlaneStore,
  duplicateRecordIds,
  PLANE_CAPACITY,
  PlaneClock,
  TEXT_SLOT,
  textOfRecords,
} from "./sync-acceptance-planes-oracle";

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
  // 同 scope 第二个 load 被拒：同一服务的重复 begin 与另一条连接的 begin 都是 SCOPE_BUSY。
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

  // 接收副本与构建共用预算，其他连接占满池时应在复制前拒绝并支持整轮重试。
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
      const rejected = await expectProtocolError(
        () =>
          service.accept("payload", {
            kind: "text_part",
            entryId: "h1",
            contentSlot: 0,
            partIndex: 0,
          }),
        "ADMISSION_REJECTED",
      );
      expect(rejected.retryable).toBe(true);
      expect(service.status().failure?.code).toBe("ADMISSION_REJECTED");
      expect(await harness.generationState(attempt.generation)).not.toBe("committed");
      // 被拒的接收不留下额度占用：账目仍是外部预扣的那一份。
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

  // 多块导入不被饿死：全部块构建提交、条数与载荷逐条守恒、目录连续。
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

  // 跨 scope 的两个 load 可以同时进行：各自持有自己的写权，内容互不污染。
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

  // 导入持写权期间的实时写入明确失败：租约到期后写者让位、内容与镜像都恢复实时。
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

import { HISTORY_PARTS, historyJson, receiveHistory, writerOwner } from "./sync-acceptance-planes-fixture";
