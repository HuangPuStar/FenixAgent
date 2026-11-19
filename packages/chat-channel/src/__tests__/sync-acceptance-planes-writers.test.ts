// 同步端到端行为验收。
import { describe, expect, test } from "bun:test";

import { type GenerationReplaceFrame, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";

import type { SyncGenerationRecord } from "../sync/store/types";
import { expectProtocolError, mirrorText, primaryOf, withHarness } from "./sync-acceptance-planes-fixture";
import {
  duplicateRecordIds,
  type PlaneHarness,
  TEXT_SLOT,
  textOfRecords,
  WRITER_LEASE_TTL_MS,
} from "./sync-acceptance-planes-oracle";

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

describe("T11 两个写者竞争、租约过期与旧 epoch", () => {
  // 两个写者竞争：第二个写者被 SCOPE_BUSY 拒绝，存储里的写者与已提交内容都不变。
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

  // 租约过期后写者让位：新写者接管，旧写者的后续写入被 fencing 拒绝且不落字节。
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

  // 旧 epoch 直写存储被拒：过期租约 LEASE_EXPIRED，已被顶替的租约 WRITER_EPOCH_LOST。
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

  // 换写者后旧已提交字节可重发：新接入的连接订阅到与存储侧逐条一致的内容。
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

  // 旧入口 revision 不能回退：陈旧修订在存储与连接两侧都被拒，指针只前进。
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

import { writerOwner } from "./sync-acceptance-planes-fixture";
