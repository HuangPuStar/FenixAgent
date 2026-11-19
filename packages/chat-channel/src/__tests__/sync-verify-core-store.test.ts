// packages/chat-channel/src/__tests__/sync-verify-core.test.ts
// 对抗式验证用例：不确认实现「大致正确」，而是逐条攻击设计 §4.1 / §8.3 / §9.2 / §10.1 与规格 §3~§4 的断言。
//
// 三条纪律：
// 1. 每个用例只针对一条具体断言，输入取边界值（精确字节数、多字节字符、超限标识、畸形 profile）而不是典型值；
// 2. 断言按设计原文的**最严格读法**写，发现实现达不到就保留失败并用「缺陷复现（待修复）」标注，不放宽断言；
// 3. 失败清单与可疑点写进交付报告，`file:line` 指向实现而非测试。

import { describe, expect, test } from "bun:test";
import { sha256Digest } from "../sync/clock";
import { type CommittedStateSnapshot } from "../sync/store/memory-store";

import {
  appendInput,
  bytesOf,
  docRecord,
  expectRejectCode,
  generationRecord,
  makeStore,
  OTHER_SCOPE,
  refRecord,
  registerDoc,
  SCOPE,
  setup,
  TestClock,
} from "./sync-verify-core-store-fixture";

describe("对抗验证：存储原子性、读取边界与 fencing", () => {
  // 缺陷复现（待修复）：refs 的校验发生在字节与前沿落地之后（memory-store.ts:288-294），
  // 于是「refs 非法」这类校验失败会留下已应用的批次：读取出口随后就能看到未提交的内容。
  // 期望：任一校验失败都必须零变化（规格 §4 第 3 条「任何一项失败时不改变任何状态」）。
  test("appendUpdates 的 refs 校验失败必须整批零变化，字节与新前沿不得先落地", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await expectRejectCode(
      store.appendUpdates(appendInput(lease, { refs: [refRecord({ docId: "ghost-doc" })] })),
      "DOC_NOT_FOUND",
    );
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
    expect(await store.readDocStateAt("doc-1", 0)).not.toBeNull();
  });

  // 缺陷复现（待修复）：refs 是逐条写入的，中段出现非法项时前面的索引项已经落库。
  // 期望：失败批次不得留下任何索引项（索引必须与 canonical 字节同生共死）。
  test("refs 数组中段校验失败时不得留下半写索引项", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await expectRejectCode(
      store.appendUpdates(
        appendInput(lease, {
          refs: [refRecord({ lookupId: "kept" }), refRecord({ lookupId: "ghost", docId: "ghost-doc" })],
        }),
      ),
      "DOC_NOT_FOUND",
    );
    expect(await store.locateRefs({ generation: "gen-1", lookupKind: "entry", lookupId: "kept", limit: 10 })).toEqual(
      [],
    );
  });

  // 同 batchId 异摘要必须零变化；原批次被再次提交时只按幂等键回执原前沿，不得重复追加字节。
  test("同 batchId 异摘要冲突零变化，原批次的幂等重试不重复追加", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    const first = appendInput(lease);
    expect(await store.appendUpdates(first)).toEqual({
      outcome: "committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    const before = store.exportCommittedState();

    expect(
      await store.appendUpdates(
        appendInput(lease, {
          digest: "digest-conflict",
          expectedFrontiers: [{ docId: "doc-1", lastSeq: 1 }],
          updates: [{ docId: "doc-1", fromSeq: 2, bytes: bytesOf("update-2") }],
        }),
      ),
    ).toEqual({ outcome: "conflict", frontiers: [] });
    expect(store.exportCommittedState()).toEqual(before);

    // 重试原批次：即使写前像已过期，也应按幂等键返回原前沿而不是重新校验序号。
    expect(await store.appendUpdates(first)).toEqual({
      outcome: "already-committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    expect((await store.readUpdatesAfter("doc-1", 0, 10)).length).toBe(1);
  });

  // 两个批次声明同一 Doc 的同一前沿（都从 seq 1 起）：只允许一个落地，另一个必须被拒，
  // 否则同一序号会被两份不同字节抢占，读取出口就会出现「同 seq 两种内容」。
  test("同一 Doc 上声明同一前沿的并发追加只有一个批次落地，且不产生同序号两份字节", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    const outcomes = await Promise.allSettled([
      store.appendUpdates(
        appendInput(lease, {
          batchId: "batch-a",
          updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-a") }],
        }),
      ),
      store.appendUpdates(
        appendInput(lease, {
          batchId: "batch-b",
          updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-b") }],
        }),
      ),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    const updates = await store.readUpdatesAfter("doc-1", 0, 10);
    expect(updates.map((update) => update.updateSeq)).toEqual([1]);
    expect(updates[0].bytes).toEqual(bytesOf("update-a"));
    expect((await store.readScopePointer(SCOPE))?.writerEpoch).toBe(lease.epoch);
  });

  // fencing 失效后旧写者迟到提交必须全面失败：追加、封口、换代、登记一个都不能成功，且状态零变化。
  test("旧 epoch 的迟到写者在 append / seal / commitGeneration / createDoc 上全部被 fencing", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });

    clock.advance(100);
    const takeover = await store.acquireWriter(SCOPE, "writer-b", 100);
    expect(takeover.epoch).toBe(lease.epoch + 1);
    const before = store.exportCommittedState();

    const sealedSnapshot = bytesOf("sealed-snapshot");
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "WRITER_EPOCH_LOST");
    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: sealedSnapshot,
        finalHash: sha256Digest(sealedSnapshot),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "WRITER_EPOCH_LOST",
    );
    await expectRejectCode(
      store.commitGeneration({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedCurrent: null,
        newGeneration: generationRecord("gen-2"),
        retired: ["gen-1"],
        entryClosure: generationRecord("gen-2").entryRefs,
        expectedPointerRevision: 0,
      }),
      "WRITER_EPOCH_LOST",
    );
    await expectRejectCode(
      store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord("doc-3") }),
      "WRITER_EPOCH_LOST",
    );
    expect(store.exportCommittedState()).toEqual(before);
  });

  // 租约过期（尚无新写者）必须立即停写；同 owner 重新取得写权后 epoch 必须递增，旧凭据作废。
  test("租约过期后停写，同 owner 重取写权必须换新 epoch，旧凭据不能再续租", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    clock.advance(100);
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "LEASE_EXPIRED");

    const fresh = await store.acquireWriter(SCOPE, "writer-a", 100);
    expect(fresh.epoch).toBe(lease.epoch + 1);
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "WRITER_EPOCH_LOST");
    await expectRejectCode(store.renewWriter(lease, 100), "LEASE_EXPIRED");
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
  });

  // 退役代次不得继续写：换代后旧代次的文档必须拒绝追加（设计 §9.2「退役 generation 不得继续写」）。
  test("退役代次的文档必须拒绝追加", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    expect((await store.readGeneration(SCOPE, "gen-1"))?.state).toBe("retired");
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "RESOURCE_RETIRED");
    await expectRejectCode(
      store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord("doc-late") }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
  });

  // 缺陷复现（待修复）：sealDoc 不校验代次状态（memory-store.ts:323-354），退役代次仍可封口并递增
  // pointerRevision，等于「epoch 仍有效就能继续写」——正是设计 §9.2 明令禁止的路径。
  // 期望：退役代次的文档封口必须被拒（RESOURCE_RETIRED），且 pointerRevision 不变。
  test("退役代次的文档不得继续封口，失败时 pointerRevision 不变", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    const pointerBefore = (await store.readScopePointer(SCOPE))?.pointerRevision;
    const sealedSnapshot = bytesOf("late-seal");
    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: sealedSnapshot,
        finalHash: sha256Digest(sealedSnapshot),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "RESOURCE_RETIRED",
    );
    expect((await store.readScopePointer(SCOPE))?.pointerRevision).toBe(pointerBefore);
  });

  // 缺陷复现（待修复）：putSealedIfAbsent 不校验代次是否登记、是否可写（memory-store.ts:299-321），
  // 未登记或已退役代次的封口文档都会被写入并立即可读，形成没有任何可写代次可达的孤儿行。
  // 期望：与 createDoc 同一规则（代次已登记且非 retired），否则拒绝。
  test("putSealedIfAbsent 必须拒绝未登记与已退役的代次，不得写入孤儿行", async () => {
    const { store, lease } = await setup();
    const snapshot = bytesOf("sealed-bytes");
    await expectRejectCode(
      store.putSealedIfAbsent({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        doc: {
          ...docRecord("orphan-doc", "gen-never-registered"),
          state: "sealed",
          finalSeq: 0,
          snapshot,
          hash: sha256Digest(snapshot),
        },
      }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readDocStateAt("orphan-doc", 0)).toBeNull();
    expect(await store.readGeneration(SCOPE, "gen-never-registered")).toBeNull();

    // 已登记但已退役的代次：createDoc 会拒，封口写入必须给出同一结论。
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    const lateSnapshot = bytesOf("late-sealed");
    await expectRejectCode(
      store.putSealedIfAbsent({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        doc: {
          ...docRecord("late-sealed", "gen-1"),
          state: "sealed",
          finalSeq: 0,
          snapshot: lateSnapshot,
          hash: sha256Digest(lateSnapshot),
        },
      }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readDocStateAt("late-sealed", 0)).toBeNull();
  });

  // 缺陷复现（待修复）：docs / updates 以 docId 为唯一键（memory-store.ts:119-120、192），
  // 跨 scope 的同名 docId 会被当成「已提交」直接回 already-committed，等于跨租户静默成功。
  // 期望：行键含 scopeKey（设计 §9.1），另一个 scope 的同名 docId 必须是 conflict。
  test("跨 scope 的同名 docId 不得被当作已提交文档", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    const leaseA = await store.acquireWriter(SCOPE, "writer-a", 100);
    await store.createGeneration({
      scopeKey: SCOPE,
      epoch: leaseA.epoch,
      generation: generationRecord("gen-1", SCOPE),
    });
    await store.createDoc({ scopeKey: SCOPE, epoch: leaseA.epoch, doc: docRecord("shared-doc", "gen-1", SCOPE) });

    const leaseB = await store.acquireWriter(OTHER_SCOPE, "writer-b", 100);
    await store.createGeneration({
      scopeKey: OTHER_SCOPE,
      epoch: leaseB.epoch,
      generation: generationRecord("gen-1", OTHER_SCOPE),
    });
    const result = await store.createDoc({
      scopeKey: OTHER_SCOPE,
      epoch: leaseB.epoch,
      doc: docRecord("shared-doc", "gen-1", OTHER_SCOPE),
    });
    expect(result.outcome).toBe("conflict");
  });

  // 读取出口不得跳洞：tail 中间缺失时，从真实前沿读取必须停在缺口而不是返回更晚的更新。
  test("readUpdatesAfter 在缺口处停止，不返回缺口之后的更新", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    for (const seq of [1, 2, 3]) {
      await store.appendUpdates(
        appendInput(lease, {
          batchId: `batch-${seq}`,
          digest: `digest-${seq}`,
          expectedFrontiers: [{ docId: "doc-1", lastSeq: seq - 1 }],
          updates: [{ docId: "doc-1", fromSeq: seq, bytes: bytesOf(`update-${seq}`) }],
        }),
      );
    }
    const snapshot = store.exportCommittedState();
    const withGap: CommittedStateSnapshot = {
      ...snapshot,
      updates: snapshot.updates.filter((update) => update.updateSeq !== 2),
    };
    const restored = makeStore(clock);
    restored.restoreFromCommittedState(withGap);

    expect((await restored.readUpdatesAfter("doc-1", 0, 10)).map((update) => update.updateSeq)).toEqual([1]);
    expect(await restored.readUpdatesAfter("doc-1", 1, 10)).toEqual([]); // 不得跳到 3
    expect((await restored.readUpdatesAfter("doc-1", 0, 1)).map((update) => update.updateSeq)).toEqual([1]);
  });

  // readDocStateAt 只返回明确序号的 canonical 状态：中间序号必须返回 null，不得用更晚快照顶替。
  test("readDocStateAt 不得用更晚快照顶替中间序号", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.appendUpdates(
      appendInput(lease, {
        expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
        updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-1") }],
      }),
    );
    const base = await store.readDocStateAt("doc-1", 0);
    expect(base?.lastSeq).toBe(0);
    expect(await store.readDocStateAt("doc-1", 1)).toBeNull();

    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 1,
    });
    const finalSnapshot = bytesOf("final-snapshot");
    await store.sealDoc({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedLastSeq: 1,
      docId: "doc-1",
      finalSnapshot,
      finalHash: sha256Digest(finalSnapshot),
      successorDocId: "doc-2",
      manifestChange: {},
    });
    expect((await store.readDocStateAt("doc-1", 1))?.hash).toBe(sha256Digest(finalSnapshot));
    expect((await store.readDocStateAt("doc-1", 0))?.hash).toBe(base?.hash);
    expect(await store.readDocStateAt("doc-1", 2)).toBeNull();
  });

  // 封口与换代的失败路径必须零变化：摘要不符、写前像过期的调用不得改动目录、指针或代次记录。
  test("封口与换代的失败路径保持目录、指针与代次记录不变", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    const before = store.exportCommittedState();
    const pointerBefore = (await store.readScopePointer(SCOPE))?.pointerRevision;

    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: bytesOf("snapshot-a"),
        finalHash: sha256Digest(bytesOf("snapshot-b")),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "DIGEST_CONFLICT",
    );
    expect(
      await store.commitGeneration({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedCurrent: null,
        newGeneration: generationRecord("gen-2"),
        retired: ["gen-1"],
        entryClosure: generationRecord("gen-2").entryRefs,
        expectedPointerRevision: 7,
      }),
    ).toEqual({ outcome: "conflict", currentGeneration: "", pointerRevision: pointerBefore ?? 0 });

    const pointerAfter = await store.readScopePointer(SCOPE);
    expect(pointerAfter?.currentGeneration).toBeNull();
    expect(pointerAfter?.pointerRevision).toBe(pointerBefore);
    expect((await store.readGeneration(SCOPE, "gen-2"))?.state).toBe("staging");
    expect((await store.readDirectory({ generation: "gen-1", limit: 10 })).entries).toEqual([]);
    expect(store.exportCommittedState()).toEqual(before);
  });
});
