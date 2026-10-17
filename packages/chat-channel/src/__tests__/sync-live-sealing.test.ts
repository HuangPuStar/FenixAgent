// packages/chat-channel/src/__tests__/sync-live-sealing.test.ts
// D 阶段封口协议机（`sync/live/sealing.ts`）的行为测试：正常四步、事务内前沿复核、孤儿回收、同摘要重试与异摘要
// 停写、有界重试、崩溃后按已提交 tail 恢复、以及阶段护栏。断言跑在真实 `MemoryProjectionStore` 上：前沿复核、
// 路由幂等与封口事务属于存储契约，用替身自证会掩盖实现与契约的分歧；唯一注入见 `failingStore`。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createSealingMachine, SEAL_MAX_ATTEMPTS, type SealingMachine, type SealRequest } from "../sync/live/sealing";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  ProjectionStore,
  RegisterSuccessorInput,
  SealDocInput,
  SyncDocRecord,
  WriterLease,
} from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

/** 封口协议机本阶段不取时，时间只供存储的租约判定使用，固定时刻即可。 */
function testClock(): Clock {
  return { now: () => 1_000 };
}

/** 固定 clientID 的 Y.Doc：Yjs 默认随机 clientID，不固定则两次搭建得不到同一份字节。 */
function newDoc(clientId: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  return doc;
}

/** 基线快照：前驱 Doc 封口前已提交的内容。 */
function baseSnapshot(): Uint8Array {
  const doc = newDoc(1);
  doc.getText("body").insert(0, "base");
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

/** 空的合法 Yjs 更新：预分配 successor 的初始状态。 */
function emptyState(): Uint8Array {
  const doc = newDoc(2);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

/** 生成一串「相对前一段增量」的已提交更新：每段只含该次编辑新增的 struct。 */
function tailUpdates(base: Uint8Array, fragments: readonly string[], clientId = 3): Uint8Array[] {
  const doc = newDoc(clientId);
  Y.applyUpdate(doc, base);
  const text = doc.getText("body");
  const updates: Uint8Array[] = [];
  for (const fragment of fragments) {
    const before = Y.encodeStateVector(doc);
    text.insert(text.length, fragment);
    updates.push(Y.encodeStateAsUpdate(doc, before));
  }
  doc.destroy();
  return updates;
}

/** 独立重放 base + 连续 tail：测试侧的证据，用来核对摘要、状态向量与编码长度。 */
function replay(base: Uint8Array, updates: readonly Uint8Array[]): Uint8Array {
  const doc = newDoc(4);
  Y.applyUpdate(doc, base);
  for (const update of updates) Y.applyUpdate(doc, update);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function stateVectorOf(snapshot: Uint8Array): Uint8Array {
  const doc = newDoc(5);
  Y.applyUpdate(doc, snapshot);
  const vector = Y.encodeStateVector(doc);
  doc.destroy();
  return vector;
}

function makeStore(clock: Clock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

function docId(nonce: string): string {
  return buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce });
}

function docRecord(targetDocId: string, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId: targetDocId,
    kind: "runtime",
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

async function registerDoc(
  store: MemoryProjectionStore,
  lease: WriterLease,
  targetDocId: string,
  snapshot: Uint8Array,
): Promise<void> {
  await store.createDoc({ scopeKey: SCOPE_KEY, epoch: lease.epoch, doc: docRecord(targetDocId, snapshot) });
}

interface Fixture {
  store: MemoryProjectionStore;
  lease: WriterLease;
  predecessorDocId: string;
  successorDocId: string;
  base: Uint8Array;
  updates: Uint8Array[];
  finalUpdateSeq: number;
}

/** 已提交谱系：可写的 active 前驱（base 0 + 连续 tail）与预分配的 successor 身份。 */
async function setup(fragments: readonly string[] = ["one", "two"]): Promise<Fixture> {
  const store = makeStore(testClock());
  const lease = await store.acquireWriter(SCOPE_KEY, "writer-a", 60_000);
  await store.createGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    generation: {
      scopeKey: SCOPE_KEY,
      generation: GENERATION,
      acpSessionId: "acp-session-1",
      loadId: "load-1",
      state: "staging",
      importEndOrdinal: null,
      entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: "runtime", contentDocIds: [] },
      createdAt: 1_000,
    },
  });
  const predecessorDocId = docId("a");
  const successorDocId = docId("b");
  const base = baseSnapshot();
  await registerDoc(store, lease, predecessorDocId, base);
  const updates = tailUpdates(base, fragments);
  const result = await store.appendUpdates({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "batch-digest-1",
    expectedFrontiers: [{ docId: predecessorDocId, lastSeq: 0 }],
    updates: updates.map((bytes, index) => ({ docId: predecessorDocId, fromSeq: index + 1, bytes })),
  });
  if (result.outcome !== "committed") throw new Error(`tail append did not commit: ${result.outcome}`);
  return { store, lease, predecessorDocId, successorDocId, base, updates, finalUpdateSeq: result.frontiers[0].lastSeq };
}

function routeInput(
  fixture: Fixture,
  overrides: { successorDocId?: string; expectedLastSeq?: number } = {},
): RegisterSuccessorInput {
  return {
    scopeKey: SCOPE_KEY,
    epoch: fixture.lease.epoch,
    predecessorDocId: fixture.predecessorDocId,
    successorDocId: overrides.successorDocId ?? fixture.successorDocId,
    expectedLastSeq: overrides.expectedLastSeq ?? fixture.finalUpdateSeq,
  };
}

function sealInput(fixture: Fixture, finalSnapshot: Uint8Array): SealDocInput {
  return {
    scopeKey: SCOPE_KEY,
    epoch: fixture.lease.epoch,
    expectedLastSeq: fixture.finalUpdateSeq,
    docId: fixture.predecessorDocId,
    finalSnapshot,
    finalHash: sha256Digest(finalSnapshot),
    successorDocId: fixture.successorDocId,
    manifestChange: { activeDocId: fixture.successorDocId },
  };
}

function sealRequest(fixture: Fixture, overrides: Partial<SealRequest> = {}): SealRequest {
  return {
    scope: SCOPE,
    oldDocId: fixture.predecessorDocId,
    lease: fixture.lease,
    finalUpdateSeq: fixture.finalUpdateSeq,
    successorDocId: fixture.successorDocId,
    successorInitialState: emptyState(),
    ...overrides,
  };
}

function machineFor(store: ProjectionStore): SealingMachine {
  return createSealingMachine({
    store,
    clock: testClock(),
    digest: sha256Digest,
    random: deterministicRandomSource("sealing-test"),
  });
}

async function expectCode(action: Promise<unknown>, code: SyncProtocolError["code"]): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

/**
 * 故障注入委托：`createDoc` 的前 N 次按注入抛 `CAPACITY_EXCEEDED`，其余调用全部转交真实
 * `MemoryProjectionStore`（不伪造任何结局）。重试次数无法从最终状态观察，只能注入可控失败并计数。
 */
function failingStore(target: ProjectionStore, failFirstCreateDocCalls: number, counts: Map<string, number>) {
  return new Proxy(target, {
    get(source, property, receiver) {
      const value: unknown = Reflect.get(source, property, receiver);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        const key = String(property);
        const seen = (counts.get(key) ?? 0) + 1;
        counts.set(key, seen);
        if (key === "createDoc" && seen <= failFirstCreateDocCalls) {
          throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "injected over-capacity failure" });
        }
        return method.apply(source, args);
      };
    },
  }) as ProjectionStore;
}

describe("createSealingMachine", () => {
  // 正常路径：四步全部提交后返回的摘要/状态向量/编码长度必须与独立重放一致，此后该 Doc 不再接受写入。
  test("封口提交 canonical 快照并停止该谱系的写入", async () => {
    const fixture = await setup();
    const machine = machineFor(fixture.store);
    const request = sealRequest(fixture);
    const result = await machine.seal(request);
    const expected = replay(fixture.base, fixture.updates);

    expect(result.docId).toBe(fixture.predecessorDocId);
    expect(result.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect(result.snapshotDigest).toBe(sha256Digest(expected));
    expect(result.stateVector).toEqual(stateVectorOf(expected));
    expect(result.encodedLength).toBe(expected.byteLength);
    expect(result.dependsOn).toEqual([]);
    expect(machine.phase).toBe("sealed");
    const sealed = await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq);
    expect(sealed?.snapshot).toEqual(expected);
    expect(sealed?.hash).toBe(result.snapshotDigest);

    // 入口路由登记到唯一 successor；初始字节被复制，调用方改写自己的缓冲不得改动已提交状态。
    expect(await fixture.store.registerSuccessor(routeInput(fixture))).toEqual({ outcome: "already-committed" });
    request.successorInitialState.fill(0);
    expect((await fixture.store.readDocStateAt(fixture.successorDocId, 0))?.snapshot).toEqual(emptyState());

    // 封口后的追加一律被拒：该谱系已经封闭。
    await expectCode(
      fixture.store.appendUpdates({
        scopeKey: SCOPE_KEY,
        epoch: fixture.lease.epoch,
        owner: fixture.lease.owner,
        batchId: "batch-2",
        digest: "batch-digest-2",
        expectedFrontiers: [{ docId: fixture.predecessorDocId, lastSeq: fixture.finalUpdateSeq }],
        updates: [{ docId: fixture.predecessorDocId, fromSeq: fixture.finalUpdateSeq + 1, bytes: emptyState() }],
      }),
      "RESOURCE_RETIRED",
    );
  });

  // 第 2 步的权威在存储：本机按截止序号读到的连续区间满足要求，但存储里的真实前沿已经领先时必须拒绝。
  test("路由事务用存储内的当前前沿复核截止序号", async () => {
    const fixture = await setup();
    const machine = machineFor(fixture.store);

    await expectCode(machine.seal(sealRequest(fixture, { finalUpdateSeq: 1 })), "SEQUENCE_GAP");
    expect(machine.phase).toBe("failed");
    // 未封口：截止序号处没有已提交的 canonical 状态。
    expect(await fixture.store.readDocStateAt(fixture.predecessorDocId, 1)).toBeNull();
    // 预分配的后继没有被任何路由引用，因此可以被回收（提交删除本身即证明它此刻不可达）。
    const reclaimed = await fixture.store.retireAndCollect(SCOPE_KEY, { kind: "doc", docId: fixture.successorDocId });
    expect(reclaimed.outcome).toBe("committed");
    expect(reclaimed.deletedDocIds).toEqual([fixture.successorDocId]);
    expect(await fixture.store.readDocStateAt(fixture.successorDocId, 0)).toBeNull();
    // 路由从未登记：此刻仍可登记为唯一后继，说明失败尝试没有留下半步路由。
    expect(await fixture.store.registerSuccessor(routeInput(fixture))).toEqual({ outcome: "committed" });
  });

  // 截止序号越过已提交前沿时判缺口：不「就近取值」，也不留下任何身份登记。
  test("截止序号领先于已提交前沿时拒绝且不产生任何登记", async () => {
    const fixture = await setup(["one"]);
    const machine = machineFor(fixture.store);

    await expectCode(
      machine.seal(sealRequest(fixture, { finalUpdateSeq: fixture.finalUpdateSeq + 1 })),
      "SEQUENCE_GAP",
    );
    expect(machine.phase).toBe("failed");
    expect(await fixture.store.readDocStateAt(fixture.successorDocId, 0)).toBeNull();
    expect(await fixture.store.registerSuccessor(routeInput(fixture))).toEqual({ outcome: "committed" });
  });

  // 路由已被别的 successor 占用时封口失败；本次预分配、且不被任何路由引用的孤儿必须被回收。
  test("路由冲突时回收未被引用的预分配孤儿", async () => {
    const fixture = await setup(["one"]);
    const otherSuccessorDocId = docId("c");
    await fixture.store.registerSuccessor(routeInput(fixture, { successorDocId: otherSuccessorDocId }));
    const machine = machineFor(fixture.store);

    await expectCode(machine.seal(sealRequest(fixture)), "DUPLICATE_OBJECT");
    expect(machine.phase).toBe("failed");
    expect(await fixture.store.readDocStateAt(fixture.successorDocId, 0)).toBeNull();
    // 既有路由保持不变：冲突不得改写已经指向别的 successor 的入口。
    expect(await fixture.store.registerSuccessor(routeInput(fixture, { successorDocId: otherSuccessorDocId }))).toEqual(
      { outcome: "already-committed" },
    );
  });

  // 重试必须复用同一份字节与同一摘要：同计划重复调用按存储幂等键返回同一结果，不改写已提交状态。
  test("同一计划的重复封口按同摘要幂等返回", async () => {
    const fixture = await setup();
    const machine = machineFor(fixture.store);
    const first = await machine.seal(sealRequest(fixture));
    const second = await machine.seal(sealRequest(fixture));

    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    expect(second.finalUpdateSeq).toBe(first.finalUpdateSeq);
    expect(second.encodedLength).toBe(first.encodedLength);
    expect(second.stateVector).toEqual(first.stateVector);
    expect(machine.phase).toBe("sealed");
    expect((await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq))?.hash).toBe(
      first.snapshotDigest,
    );
  });

  // 已提交的封口摘要与本机重放的摘要不同时必须停写：不改写既有字节，也不重试（异摘要重试只会再失败一次）。
  test("已提交摘要冲突时失败停写且只尝试一次", async () => {
    const fixture = await setup(["one"]);
    await registerDoc(fixture.store, fixture.lease, fixture.successorDocId, emptyState());
    await fixture.store.registerSuccessor(routeInput(fixture));
    const committedBytes = replay(fixture.base, fixture.updates);
    const foreignBytes = replay(committedBytes, tailUpdates(committedBytes, ["foreign"], 6));
    expect(await fixture.store.sealDoc(sealInput(fixture, foreignBytes))).toEqual({
      outcome: "committed",
      finalSeq: fixture.finalUpdateSeq,
    });

    const counts = new Map<string, number>();
    const machine = machineFor(failingStore(fixture.store, 0, counts));
    await expectCode(machine.seal(sealRequest(fixture)), "DIGEST_CONFLICT");

    expect(machine.phase).toBe("failed");
    expect(counts.get("sealDoc")).toBe(1);
    expect((await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq))?.hash).toBe(
      sha256Digest(foreignBytes),
    );
  });

  // 可重试失败在有界次数内重试：注入两次容量失败后第三次成功，重试确实恢复而不是空转。
  test("可重试的容量失败在尝试上限内重试成功", async () => {
    const fixture = await setup(["one"]);
    const counts = new Map<string, number>();
    const machine = machineFor(failingStore(fixture.store, 2, counts));

    const result = await machine.seal(sealRequest(fixture));

    expect(result.snapshotDigest).toBe(sha256Digest(replay(fixture.base, fixture.updates)));
    expect(counts.get("createDoc")).toBe(3);
    expect(machine.phase).toBe("sealed");
  });

  // 超容量不是无限重试：可重试码用尽 `SEAL_MAX_ATTEMPTS` 后上抛并转 failed，且不留下半步提交。
  test("容量错误用尽尝试上限后转 failed", async () => {
    const fixture = await setup(["one"]);
    const counts = new Map<string, number>();
    const machine = machineFor(failingStore(fixture.store, Number.MAX_SAFE_INTEGER, counts));

    await expectCode(machine.seal(sealRequest(fixture)), "CAPACITY_EXCEEDED");

    expect(counts.get("createDoc")).toBe(SEAL_MAX_ATTEMPTS);
    expect(machine.phase).toBe("failed");
    expect(await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq)).toBeNull();
    expect(await fixture.store.registerSuccessor(routeInput(fixture))).toEqual({ outcome: "committed" });
  });

  // 阶段护栏：畸形请求不推进阶段，进行中与终态都拒绝新请求，失败后的机器是「停止写入」的明确信号。
  test("畸形请求、进行中与终态都按阶段拒绝", async () => {
    const fixture = await setup(["one"]);
    const machine = machineFor(fixture.store);

    await expectCode(
      machine.seal(
        sealRequest(fixture, {
          successorDocId: buildDocId({ kind: "runtime", generation: "gen-2", blockIndex: 0, nonce: "b" }),
        }),
      ),
      "GENERATION_MISMATCH",
    );
    await expectCode(
      machine.seal(sealRequest(fixture, { successorDocId: fixture.predecessorDocId })),
      "MALFORMED_FRAME",
    );
    await expectCode(
      machine.seal(sealRequest(fixture, { lease: { ...fixture.lease, scopeKey: "other/scope" } })),
      "WRITER_EPOCH_LOST",
    );
    expect(machine.phase).toBe("active");

    // 并发封口是调用方缺陷：第二个请求被拒，第一个照常完成。
    const first = machine.seal(sealRequest(fixture));
    await expectCode(machine.seal(sealRequest(fixture)), "MALFORMED_FRAME");
    expect((await first).finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    // 计划钉死：同一 Doc 换 successor 属于另一份计划，不是重试。
    await expectCode(machine.seal(sealRequest(fixture, { successorDocId: docId("c") })), "DIGEST_CONFLICT");

    const stale = machineFor(fixture.store);
    await expectCode(stale.seal(sealRequest(fixture, { finalUpdateSeq: fixture.finalUpdateSeq + 1 })), "SEQUENCE_GAP");
    await expectCode(stale.seal(sealRequest(fixture)), "MALFORMED_FRAME");
    expect(stale.phase).toBe("failed");
  });

  // 崩溃恢复：只在已提交字节上重建，不读旧写者的内存；重建出的摘要必须与封口路径产出的摘要一致。
  test("崩溃后按已提交 tail 重建同一摘要并完成封口", async () => {
    const sealedFixture = await setup();
    const sealed = await machineFor(sealedFixture.store).seal(sealRequest(sealedFixture));

    // 崩溃现场：路由已提交、前驱仍未封口（第 2 步之后、第 4 步之前）。
    const crashed = await setup();
    await registerDoc(crashed.store, crashed.lease, crashed.successorDocId, emptyState());
    await crashed.store.registerSuccessor(routeInput(crashed));

    // 新进程：只带走已提交状态，旧租约与旧写者内存都不存在。
    const restarted = makeStore(testClock());
    restarted.restoreFromCommittedState(crashed.store.exportCommittedState());
    const lease = await restarted.acquireWriter(SCOPE_KEY, "writer-b", 60_000);
    const machine = machineFor(restarted);

    const recovered = await machine.recover(crashed.predecessorDocId);
    expect(recovered?.finalUpdateSeq).toBe(crashed.finalUpdateSeq);
    expect(recovered?.snapshotDigest).toBe(sealed.snapshotDigest);
    expect(recovered?.stateVector).toEqual(sealed.stateVector);
    expect(recovered?.encodedLength).toBe(sealed.encodedLength);

    const finished = await machine.seal({
      scope: SCOPE,
      oldDocId: crashed.predecessorDocId,
      lease,
      finalUpdateSeq: crashed.finalUpdateSeq,
      successorDocId: crashed.successorDocId,
      successorInitialState: emptyState(),
    });
    expect(finished.snapshotDigest).toBe(sealed.snapshotDigest);
    expect(machine.phase).toBe("sealed");
  });

  // 已封口的 Doc 恢复时采用存储里的 canonical 字节：重放 tail 只能得到另一份候选，不能覆盖既有摘要。
  test("已封口的 Doc 恢复时采用存储里的 canonical 摘要", async () => {
    const fixture = await setup(["one"]);
    await registerDoc(fixture.store, fixture.lease, fixture.successorDocId, emptyState());
    await fixture.store.registerSuccessor(routeInput(fixture));
    const committedBytes = replay(fixture.base, fixture.updates);
    const foreignBytes = replay(committedBytes, tailUpdates(committedBytes, ["foreign"], 6));
    await fixture.store.sealDoc(sealInput(fixture, foreignBytes));

    const machine = machineFor(fixture.store);
    const recovered = await machine.recover(fixture.predecessorDocId);
    expect(recovered?.snapshotDigest).toBe(sha256Digest(foreignBytes));
    expect(recovered?.encodedLength).toBe(foreignBytes.byteLength);
    expect(recovered?.stateVector).toEqual(stateVectorOf(foreignBytes));

    // 恢复的边界：未登记的 docId 与「只有基线、没有已提交 tail」的预分配孤儿都不是可恢复谱系。
    const orphanDocId = docId("d");
    await registerDoc(fixture.store, fixture.lease, orphanDocId, emptyState());
    expect(await machine.recover(orphanDocId)).toBeNull();
    expect(await machine.recover(docId("z"))).toBeNull();
  });
});
