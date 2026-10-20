import { describe, expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  CommitGenerationInput,
  CreateDocInput,
  CreateGenerationInput,
  RegisterSuccessorInput,
  SealDocInput,
  SyncDocRecord,
  SyncGenerationRecord,
  WriterLease,
} from "../sync/store/types";

class TestClock implements Clock {
  private current: number;

  constructor(current = 1_000) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

const SCOPE = "org-1/session-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function makeStore(clock: TestClock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

function generation(generationId = "gen-1", loadId = "load-1"): SyncGenerationRecord {
  return {
    scopeKey: SCOPE,
    generation: generationId,
    acpSessionId: "acp-session",
    loadId,
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: `${generationId}-control`,
      directoryDocId: `${generationId}-directory`,
      runtimeDocId: `${generationId}-runtime`,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
}

function makeDoc(generationId = "gen-1", docId = "doc-1", kind: SyncDocRecord["kind"] = "runtime"): SyncDocRecord {
  const snapshot = bytes(`${docId}-snapshot`);
  return {
    scopeKey: SCOPE,
    generation: generationId,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: kind === "content" ? 0 : null,
    ordinalStart: kind === "content" ? 0 : null,
    ordinalEnd: kind === "content" ? 0 : null,
    dependsOn: [],
  };
}

async function setupStore(): Promise<{ store: MemoryProjectionStore; clock: TestClock; lease: WriterLease }> {
  const clock = new TestClock();
  const store = makeStore(clock);
  const lease = await store.acquireWriter(SCOPE, "writer-a", 100);
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generation() });
  return { store, clock, lease };
}

async function createDoc(store: MemoryProjectionStore, lease: WriterLease, doc = makeDoc()): Promise<void> {
  const input: CreateDocInput = { scopeKey: SCOPE, epoch: lease.epoch, doc };
  await store.createDoc(input);
}

function appendInput(
  lease: WriterLease,
  overrides: Partial<Parameters<MemoryProjectionStore["appendUpdates"]>[0]> = {},
) {
  return {
    scopeKey: SCOPE,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "digest-1",
    expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
    updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytes("update-1") }],
    ...overrides,
  };
}

async function expectCode(action: Promise<unknown>, code: SyncProtocolError["code"]): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

describe("MemoryProjectionStore", () => {
  // 同一 scope 的未过期租约拒绝不同 owner，确保单写权不会被并发写者绕过。
  test("同一 scope 的两个写者竞争时拒绝第二个写者", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    await store.acquireWriter(SCOPE, "writer-a", 100);
    await expectCode(store.acquireWriter(SCOPE, "writer-b", 100), "SCOPE_BUSY");
  });

  // 租约过期后旧 owner 不能续租，新 owner 必须取得递增 epoch 才能继续写。
  test("租约过期后可重新获取且 epoch 递增", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    const first = await store.acquireWriter(SCOPE, "writer-a", 100);
    clock.advance(100);
    await expectCode(store.renewWriter(first, 100), "LEASE_EXPIRED");
    const second = await store.acquireWriter(SCOPE, "writer-b", 100);
    expect(second.epoch).toBe(first.epoch + 1);
  });

  // 相同 owner 的租约续租保留 fencing epoch，避免合法续租制造不必要的写者切换。
  test("同 owner 未过期获取租约时保留 epoch 并延长到期时间", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    const first = await store.acquireWriter(SCOPE, "writer-a", 100);
    clock.advance(20);
    const renewed = await store.acquireWriter(SCOPE, "writer-a", 200);
    expect(renewed.epoch).toBe(first.epoch);
    expect(renewed.expiresAt).toBe(1_220);
  });

  // 登记原语必须经过同一套 fencing，旧 epoch 不能在租约更新后污染登记状态。
  test("旧 epoch 的 createGeneration 被 fencing 且不产生登记", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    const first = await store.acquireWriter(SCOPE, "writer-a", 100);
    clock.advance(100);
    await store.acquireWriter(SCOPE, "writer-b", 100);
    const input: CreateGenerationInput = { scopeKey: SCOPE, epoch: first.epoch, generation: generation() };
    await expectCode(store.createGeneration(input), "WRITER_EPOCH_LOST");
    expect(await store.readGeneration(SCOPE, "gen-1")).toBeNull();
  });

  // 代次登记只接受 staging，且同 loadId 重试不得重复写入。
  test("createGeneration 只登记 staging 并按 loadId 幂等", async () => {
    const { store, lease } = await setupStore();
    expect(
      await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generation("gen-2") }),
    ).toEqual({ outcome: "committed" });
    expect(
      await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generation("gen-2") }),
    ).toEqual({ outcome: "already-committed" });
    expect(
      await store.createGeneration({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        generation: generation("gen-2", "other-load"),
      }),
    ).toEqual({ outcome: "conflict" });
  });

  // 文档登记先建立 baseSeq=0 的可读边界，并复制快照避免调用方修改内部状态。
  test("createDoc 登记 base snapshot 并复制入参字节", async () => {
    const { store, lease } = await setupStore();
    const doc = makeDoc();
    const original = doc.snapshot;
    await createDoc(store, lease, doc);
    original[0] = 0;
    const state = await store.readDocStateAt("doc-1", 0);
    expect(state?.snapshot).toEqual(bytes("doc-1-snapshot"));
    expect(await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc })).toEqual({
      outcome: "already-committed",
    });
  });

  // 同 docId 的不同摘要必须冲突，不能覆盖已登记的 canonical snapshot。
  test("createDoc 同 docId 异摘要返回 conflict 且保留原字节", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const conflicting = makeDoc("gen-1", "doc-1");
    conflicting.snapshot = bytes("other");
    conflicting.hash = sha256Digest(conflicting.snapshot);
    expect(await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: conflicting })).toEqual({
      outcome: "conflict",
    });
    expect(await store.readDocStateAt("doc-1", 0)).toMatchObject({ snapshot: bytes("doc-1-snapshot") });
  });

  // successor 路由先登记且只能唯一绑定，防止封口后重启选择错误写入入口。
  test("registerSuccessor 同参幂等、异参冲突", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const input: RegisterSuccessorInput = {
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    };
    expect(await store.registerSuccessor(input)).toEqual({ outcome: "committed" });
    expect(await store.registerSuccessor(input)).toEqual({ outcome: "already-committed" });
    expect(await store.registerSuccessor({ ...input, successorDocId: "doc-3" })).toEqual({ outcome: "conflict" });
  });

  // appendUpdates 的正常路径一次提交多个序号，并返回新的连续前沿。
  test("appendUpdates 提交连续 tail 并返回前沿", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const result = await store.appendUpdates(
      appendInput(lease, {
        updates: [
          { docId: "doc-1", fromSeq: 1, bytes: bytes("a") },
          { docId: "doc-1", fromSeq: 2, bytes: bytes("b") },
        ],
      }),
    );
    expect(result).toEqual({ outcome: "committed", frontiers: [{ docId: "doc-1", lastSeq: 2 }] });
    expect((await store.readUpdatesAfter("doc-1", 0, 10)).map((item) => item.updateSeq)).toEqual([1, 2]);
  });

  // 同 batchId 同摘要重试只能回执此前事实，不能重复追加同一批字节。
  test("同 batchId 同摘要幂等不重复追加", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const input = appendInput(lease);
    expect(await store.appendUpdates(input)).toEqual({
      outcome: "committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    expect(await store.appendUpdates(input)).toEqual({
      outcome: "already-committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toHaveLength(1);
  });

  // 同 batchId 异摘要必须零变化，调用方不得以相同幂等键覆盖已提交字节。
  test("同 batchId 异摘要返回 conflict 且零变化", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const input = appendInput(lease);
    await store.appendUpdates(input);
    const before = store.exportCommittedState();
    expect(await store.appendUpdates({ ...input, digest: "different" })).toEqual({
      outcome: "conflict",
      frontiers: [],
    });
    expect(store.exportCommittedState()).toEqual(before);
  });

  // 任一文档前沿过期时整批必须失败，验证多文档事务不会留下部分更新。
  test("单 doc 前沿不匹配时整批零变化", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease, makeDoc("gen-1", "doc-1"));
    await createDoc(store, lease, makeDoc("gen-1", "doc-2"));
    await store.appendUpdates(appendInput(lease));
    const before = store.exportCommittedState();
    await expectCode(
      store.appendUpdates({
        ...appendInput(lease, {
          batchId: "batch-2",
          expectedFrontiers: [
            { docId: "doc-1", lastSeq: 1 },
            { docId: "doc-2", lastSeq: 1 },
          ],
          updates: [
            { docId: "doc-1", fromSeq: 2, bytes: bytes("a") },
            { docId: "doc-2", fromSeq: 2, bytes: bytes("b") },
          ],
        }),
      }),
      "SEQUENCE_GAP",
    );
    expect(store.exportCommittedState()).toEqual(before);
  });

  // 缺失文档与非连续序号均在提交前报错，确保读取边界不会出现跳洞。
  test("未知 doc 与序号跳洞均拒绝", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    await expectCode(
      store.appendUpdates(
        appendInput(lease, {
          expectedFrontiers: [{ docId: "missing", lastSeq: 0 }],
          updates: [{ docId: "missing", fromSeq: 1, bytes: bytes("missing") }],
        }),
      ),
      "DOC_NOT_FOUND",
    );
    await expectCode(
      store.appendUpdates(appendInput(lease, { updates: [{ docId: "doc-1", fromSeq: 2, bytes: bytes("gap") }] })),
      "SEQUENCE_GAP",
    );
  });

  // 租约到期后 appendUpdates 必须停止，旧 owner 不能依赖旧 lease 继续写入。
  test("租约过期后 appendUpdates 拒绝写入", async () => {
    const { store, clock, lease } = await setupStore();
    await createDoc(store, lease);
    clock.advance(100);
    await expectCode(store.appendUpdates(appendInput(lease)), "LEASE_EXPIRED");
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
  });

  // sealDoc 只接受已登记 successor，未登记前置步骤必须暴露明确错误且不改变文档。
  test("未登记 successor 时 sealDoc 失败", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const snapshot = bytes("sealed");
    const input: SealDocInput = {
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedLastSeq: 0,
      docId: "doc-1",
      finalSnapshot: snapshot,
      finalHash: sha256Digest(snapshot),
      successorDocId: "doc-2",
      manifestChange: {},
    };
    await expectCode(store.sealDoc(input), "MALFORMED_FRAME");
    expect((await store.readDocStateAt("doc-1", 0))?.hash).toBe(sha256Digest(bytes("doc-1-snapshot")));
  });

  // sealDoc 成功后文档进入不可追加状态，重复同摘要只回幂等结果。
  test("sealDoc 成功后 append 被拒且重复封口不递增指针", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    await createDoc(store, lease, makeDoc("gen-1", "doc-2"));
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    const snapshot = bytes("sealed");
    const input: SealDocInput = {
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedLastSeq: 0,
      docId: "doc-1",
      finalSnapshot: snapshot,
      finalHash: sha256Digest(snapshot),
      successorDocId: "doc-2",
      manifestChange: {},
    };
    expect(await store.sealDoc(input)).toEqual({ outcome: "committed", finalSeq: 0 });
    const pointer = await store.readScopePointer(SCOPE);
    expect(await store.sealDoc(input)).toEqual({ outcome: "already-committed", finalSeq: 0 });
    expect((await store.readScopePointer(SCOPE))?.pointerRevision).toBe(pointer?.pointerRevision);
    await expectCode(store.appendUpdates(appendInput(lease)), "RESOURCE_RETIRED");
  });

  // putSealedIfAbsent 使用 docId+hash create-if-absent，异摘要不得覆盖既有 canonical 字节。
  test("putSealedIfAbsent 同摘要幂等、异摘要冲突", async () => {
    const { store, lease } = await setupStore();
    const doc = makeDoc("gen-1", "sealed-1");
    doc.state = "sealed";
    doc.finalSeq = 0;
    expect(await store.putSealedIfAbsent({ scopeKey: SCOPE, epoch: lease.epoch, doc })).toEqual({
      outcome: "committed",
      hash: doc.hash,
    });
    expect(await store.putSealedIfAbsent({ scopeKey: SCOPE, epoch: lease.epoch, doc })).toEqual({
      outcome: "already-committed",
      hash: doc.hash,
    });
    const other = { ...doc, snapshot: bytes("other"), hash: sha256Digest(bytes("other")) };
    expect(await store.putSealedIfAbsent({ scopeKey: SCOPE, epoch: lease.epoch, doc: other })).toEqual({
      outcome: "conflict",
      hash: doc.hash,
    });
  });

  // commitGeneration 必须同时推进新代、退役旧代和指针，任一写前像不匹配都零变化。
  test("commitGeneration 原子换代并拒绝陈旧写前像", async () => {
    const { store, lease } = await setupStore();
    const old = generation("gen-old");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: old });
    const next = generation("gen-next");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: next });
    const input: CommitGenerationInput = {
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: next,
      retired: ["gen-old"],
      entryClosure: next.entryRefs,
      expectedPointerRevision: 0,
    };
    expect(await store.commitGeneration(input)).toEqual({
      outcome: "committed",
      currentGeneration: "gen-next",
      pointerRevision: 1,
    });
    const before = store.exportCommittedState();
    expect(await store.commitGeneration({ ...input, expectedPointerRevision: 0 })).toEqual({
      outcome: "already-committed",
      currentGeneration: "gen-next",
      pointerRevision: 1,
    });
    expect(store.exportCommittedState()).toEqual(before);
    expect((await store.readGeneration(SCOPE, "gen-old"))?.state).toBe("retired");
    expect((await store.readGeneration(SCOPE, "gen-next"))?.state).toBe("committed");
  });

  // commitGeneration 的并发换代若 pointerRevision 或 currentGeneration 过期，必须不改变任何记录。
  test("commitGeneration 陈旧 pointerRevision 返回 conflict 且零变化", async () => {
    const { store, lease } = await setupStore();
    const next = generation("gen-next");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: next });
    const input: CommitGenerationInput = {
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: next,
      retired: [],
      entryClosure: next.entryRefs,
      expectedPointerRevision: 9,
    };
    const before = store.exportCommittedState();
    expect(await store.commitGeneration(input)).toEqual({
      outcome: "conflict",
      currentGeneration: "",
      pointerRevision: 0,
    });
    expect(store.exportCommittedState()).toEqual(before);
  });

  // 已提交读取出口只返回明确序号的快照，未知 doc 或不存在的 seq 一律返回 null。
  test("readDocStateAt 对未知 doc 和未知 seq 返回 null", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    expect(await store.readDocStateAt("missing", 0)).toBeNull();
    expect(await store.readDocStateAt("doc-1", 1)).toBeNull();
  });

  // tail 读取遇到缺口立即停止，并按 limit 截断，不跳过未提交序号。
  test("readUpdatesAfter 连续读取并在缺口停止", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    await store.appendUpdates(
      appendInput(lease, {
        updates: [
          { docId: "doc-1", fromSeq: 1, bytes: bytes("a") },
          { docId: "doc-1", fromSeq: 2, bytes: bytes("b") },
        ],
      }),
    );
    expect((await store.readUpdatesAfter("doc-1", 0, 1)).map((item) => item.updateSeq)).toEqual([1]);
    expect((await store.readUpdatesAfter("doc-1", 1, 10)).map((item) => item.updateSeq)).toEqual([2]);
    expect(await store.readUpdatesAfter("missing", 0, 10)).toEqual([]);
  });

  // 目录与引用读取只观察已封口/已提交索引，不把 staging 文档或未知 generation 猜成可读事实。
  test("readDirectory 与 locateRefs 过滤未封口对象和未知代次", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease, makeDoc("gen-1", "content-1", "content"));
    expect((await store.readDirectory({ generation: "gen-1", limit: 10 })).entries).toEqual([]);
    expect((await store.readDirectory({ generation: "unknown", limit: 10 })).entries).toEqual([]);
    expect(await store.locateRefs({ generation: "unknown", lookupKind: "entry", lookupId: "x", limit: 10 })).toEqual(
      [],
    );
  });

  // current generation 与宽限期内的对象受保护，不能被 retireAndCollect 删除。
  test("retireAndCollect 保护 current generation 与 seal grace", async () => {
    const { store, lease } = await setupStore();
    const next = generation("gen-next");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: next });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: next,
      retired: [],
      entryClosure: next.entryRefs,
      expectedPointerRevision: 0,
    });
    await createDoc(store, lease, makeDoc("gen-next", "doc-current"));
    expect(await store.retireAndCollect(SCOPE, { kind: "generation", generation: "gen-next" })).toEqual({
      outcome: "conflict",
      retiredDocIds: [],
      deletedDocIds: [],
    });
    expect(await store.retireAndCollect(SCOPE, { kind: "doc", docId: "doc-current" })).toEqual({
      outcome: "conflict",
      retiredDocIds: [],
      deletedDocIds: [],
    });
  });

  // 退役代次跨过显式宽限期后才可回收，重复回收由 tombstone 幂等确认。
  test("退役代次过宽限期后可回收且重复调用幂等", async () => {
    const { store, clock, lease } = await setupStore();
    const old = generation("gen-old");
    const next = generation("gen-next");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: old });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: next });
    await createDoc(store, lease, makeDoc("gen-old", "old-doc"));
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: next,
      retired: ["gen-old"],
      entryClosure: next.entryRefs,
      expectedPointerRevision: 0,
    });
    expect(await store.retireAndCollect(SCOPE, { kind: "generation", generation: "gen-old" })).toEqual({
      outcome: "conflict",
      retiredDocIds: [],
      deletedDocIds: [],
    });
    clock.advance(100);
    expect(await store.retireAndCollect(SCOPE, { kind: "generation", generation: "gen-old" })).toEqual({
      outcome: "committed",
      retiredDocIds: ["old-doc"],
      deletedDocIds: ["old-doc"],
    });
    expect(await store.retireAndCollect(SCOPE, { kind: "generation", generation: "gen-old" })).toEqual({
      outcome: "already-committed",
      retiredDocIds: [],
      deletedDocIds: [],
    });
  });

  // 导出已提交边界并恢复到新 store 后，snapshot 与连续 tail 都必须可读且互不共享字节引用。
  test("exportCommittedState 到新 store restore 后 tail 可读", async () => {
    const { store, lease } = await setupStore();
    await createDoc(store, lease);
    const updateBytes = bytes("tail");
    await store.appendUpdates(appendInput(lease, { updates: [{ docId: "doc-1", fromSeq: 1, bytes: updateBytes }] }));
    const snapshot = store.exportCommittedState();
    const restored = makeStore(new TestClock());
    restored.restoreFromCommittedState(snapshot);
    updateBytes[0] = 0;
    expect((await restored.readUpdatesAfter("doc-1", 0, 10))[0]?.bytes).toEqual(bytes("tail"));
  });

  // 所有读取出口都返回副本，调用方修改返回值不能改变后续读取到的已提交状态。
  test("Uint8Array 出入参复制隔离 store 内部状态", async () => {
    const { store, lease } = await setupStore();
    const doc = makeDoc();
    await createDoc(store, lease, doc);
    const state = await store.readDocStateAt("doc-1", 0);
    if (state === null) throw new Error("expected document state");
    state.snapshot[0] = 0;
    expect((await store.readDocStateAt("doc-1", 0))?.snapshot).toEqual(bytes("doc-1-snapshot"));
  });
});
