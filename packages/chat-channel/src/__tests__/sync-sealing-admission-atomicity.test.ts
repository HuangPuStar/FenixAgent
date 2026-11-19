import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createSealingMachine, type SealRequest } from "../sync/live/sealing";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore, SealDocInput, SyncDocRecord } from "../sync/store/types";
import { exactSealingSnapshot, SealingAdmission } from "./sync-sealing-admission-fixture";

const SCOPE = { organizationId: "r6", rcsSessionId: "quota" };
const KEY = scopeKey(SCOPE);
const GENERATION = "gen-r6";
const clock = { now: () => 1000 };

/** 真实预算与当前代次；只有回执故障使用委托，不替换存储的提交行为。 */
async function fixture(baseSnapshot?: Uint8Array) {
  const admission = new SealingAdmission(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const lease = await store.acquireWriter(KEY, "owner", 10000);
  const id = (nonce: string) => buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce });
  const a = id("a");
  const b = id("b");
  const emptyDoc = new Y.Doc();
  const empty = Y.encodeStateAsUpdate(emptyDoc);
  emptyDoc.destroy();
  const base = baseSnapshot ?? empty;
  const record = (docId: string, snapshot = empty): SyncDocRecord => ({
    scopeKey: KEY,
    generation: GENERATION,
    docId,
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
  });
  const generation = {
    scopeKey: KEY,
    generation: GENERATION,
    acpSessionId: "ses_r6",
    loadId: "load-r6",
    state: "staging" as const,
    importEndOrdinal: null,
    createdAt: 1000,
    entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: a, contentDocIds: [] },
  };
  await store.createGeneration({ scopeKey: KEY, epoch: lease.epoch, generation });
  await store.createDoc({ scopeKey: KEY, epoch: lease.epoch, doc: record(a, base) });
  await store.commitGeneration({
    scopeKey: KEY,
    epoch: lease.epoch,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    newGeneration: generation,
    entryClosure: generation.entryRefs,
    retired: [],
  });
  const edit = new Y.Doc();
  edit.clientID = 67890;
  edit.getText("body").insert(0, "tail");
  const bytes = Y.encodeStateAsUpdate(edit);
  edit.destroy();
  await store.appendUpdates({
    scopeKey: KEY,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "tail",
    digest: sha256Digest(bytes),
    expectedFrontiers: [{ docId: a, lastSeq: 0 }],
    updates: [{ docId: a, fromSeq: 1, bytes }],
  });
  const request = (successorDocId = b): SealRequest => ({
    scope: SCOPE,
    oldDocId: a,
    lease,
    finalUpdateSeq: 1,
    successorDocId,
    successorInitialState: empty,
  });
  const machine = (target: ProjectionStore = store) =>
    createSealingMachine({ store: target, clock, digest: sha256Digest, random: deterministicRandomSource("r6") });
  const sealInput = (snapshot: Uint8Array): SealDocInput => ({
    scopeKey: KEY,
    epoch: lease.epoch,
    docId: a,
    expectedLastSeq: 1,
    successorDocId: b,
    finalSnapshot: snapshot,
    finalHash: sha256Digest(snapshot),
    manifestChange: { activeDocId: b },
  });
  async function registerRoute(): Promise<void> {
    await store.createDoc({ scopeKey: KEY, epoch: lease.epoch, doc: record(b) });
    await store.registerSuccessor({
      scopeKey: KEY,
      epoch: lease.epoch,
      predecessorDocId: a,
      successorDocId: b,
      expectedLastSeq: 1,
    });
  }
  return { store, admission, lease, a, b, id, empty, record, request, machine, sealInput, registerRoute };
}

/** 固定剩余额度，失败与重试期间由真实 AdmissionController 负责拒绝。 */
function leaveAvailable(admission: AdmissionController, pool: ServerPoolName, bytes: number) {
  return admission.reserve(pool, admission.available(pool) - bytes);
}

function usage(admission: AdmissionController) {
  return Object.fromEntries(
    Object.keys(DEFAULT_SYNC_CAPACITY.serverPools).map((name) => [name, admission.used(name as ServerPoolName)]),
  );
}

function expectReleased(admission: AdmissionController): void {
  expect(Object.values(usage(admission)).every((bytes) => bytes === 0)).toBe(true);
}

// 新文档和 ledger 可容纳而路由差 1 字节时，多次换 nonce 失败也不得累积当前代次的孤儿。
test("路由额度确定拒绝时原子撤销 successor，释放额度后可重新封口", async () => {
  const f = await fixture();
  // 固定 fixture 的 Doc 元数据 1972 + ledger 192 + route 448 = 2612 字节。
  const blocker = leaveAvailable(f.admission, "controlIndex", 2611);
  const before = f.store.exportCommittedState();
  const charged = usage(f.admission);
  try {
    for (const nonce of ["b", "c", "d"]) {
      await expect(f.machine().seal(f.request(f.id(nonce)))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    }
    blocker.release();
    await f.machine().seal(f.request());
    expect(f.store.exportCommittedState().docs.map((doc) => doc.docId)).toEqual([f.a, f.b]);
    expect(await f.store.readSuccessor(KEY, f.a)).toMatchObject({ state: "sealed", route: { successorDocId: f.b } });
  } finally {
    blocker.release();
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// 最后一份前驱元数据也必须预留成功，差一字节不能留下先准备成功的新后继与路由。
test("原子路由在全部元数据精确边界提交，拒绝可重复且无部分登记", async () => {
  const probe = await fixture();
  let boundary: Awaited<ReturnType<SealingAdmission["measurePeak"]>>;
  try {
    boundary = await probe.admission.measurePeak("controlIndex", () =>
      probe.store.registerSuccessor({
        scopeKey: KEY,
        epoch: probe.lease.epoch,
        predecessorDocId: probe.a,
        successorDocId: probe.b,
        expectedLastSeq: 1,
        successorDoc: probe.record(probe.b),
      }),
    );
  } finally {
    probe.store.dispose();
  }
  expectReleased(probe.admission);
  const f = await fixture();
  const blocker = leaveAvailable(f.admission, "controlIndex", boundary.peakBytes - 1);
  let exact: ReturnType<typeof leaveAvailable> | undefined;
  const before = f.store.exportCommittedState();
  const charged = usage(f.admission);
  const input = {
    scopeKey: KEY,
    epoch: f.lease.epoch,
    predecessorDocId: f.a,
    successorDocId: f.b,
    expectedLastSeq: 1,
    successorDoc: f.record(f.b),
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(f.store.registerSuccessor(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    }
    blocker.release();
    exact = leaveAvailable(f.admission, "controlIndex", boundary.peakBytes);
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "committed" });
    expect(f.admission.available("controlIndex")).toBe(boundary.releasedBytes);
    const committed = usage(f.admission);
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "already-committed" });
    expect(usage(f.admission)).toEqual(committed);
    expect(await f.store.readSuccessor(KEY, f.a)).toMatchObject({ state: "sealing", route: { successorDocId: f.b } });
  } finally {
    blocker.release();
    exact?.release();
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// 封口共享原有 base 缓冲，新 transport 仅须容纳 40 KiB 的 final，不应再次申请 32 KiB 的 base。
test("32 KiB base 在 48 KiB transport 余量内能完成 40 KiB 封口", async () => {
  const base = exactSealingSnapshot(32 * 1024, "b"),
    expectedBase = base.slice();
  const f = await fixture(base);
  await f.registerRoute();
  const blocker = leaveAvailable(f.admission, "transportCache", 48 * 1024);
  const before = f.admission.used("transportCache");
  const final = exactSealingSnapshot(40 * 1024, "f"),
    expectedFinal = final.slice();
  try {
    await expect(f.store.sealDoc(f.sealInput(final))).resolves.toEqual({ outcome: "committed", finalSeq: 1 });
    expect(f.admission.used("transportCache")).toBe(before + 40 * 1024);
    expect((await f.store.readDocStateAt(f.a, 0))?.snapshot).toEqual(expectedBase);
    expect((await f.store.readDocStateAt(f.a, 1))?.snapshot).toEqual(final);
    final.fill(3);
    base.fill(3);
    expect((await f.store.readDocStateAt(f.a, 0))?.snapshot).toEqual(expectedBase);
    expect((await f.store.readDocStateAt(f.a, 1))?.snapshot).toEqual(expectedFinal);
  } finally {
    blocker.release();
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// 差 1 字节必须无副作用；归还该字节后，同一已登记路由应在精确边界重试成功。
test("封口在 final 字节精确边界重试，失败不改变状态、指针或池额度", async () => {
  const f = await fixture(exactSealingSnapshot(32 * 1024, "b"));
  await f.registerRoute();
  const final = exactSealingSnapshot(40 * 1024, "f");
  const blocker = leaveAvailable(f.admission, "transportCache", final.byteLength - 1);
  let exact: ReturnType<typeof leaveAvailable> | undefined;
  const before = f.store.exportCommittedState();
  const charged = usage(f.admission);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(f.store.sealDoc(f.sealInput(final))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    }
    blocker.release();
    exact = leaveAvailable(f.admission, "transportCache", final.byteLength);
    await expect(f.store.sealDoc(f.sealInput(final))).resolves.toEqual({ outcome: "committed", finalSeq: 1 });
    expect(f.admission.available("transportCache")).toBe(0);
    expect((await f.store.readScopePointer(KEY))?.pointerRevision).toBe(2);
    const committed = usage(f.admission);
    await expect(f.store.sealDoc(f.sealInput(final))).resolves.toEqual({ outcome: "already-committed", finalSeq: 1 });
    expect(usage(f.admission)).toEqual(committed);
  } finally {
    blocker.release();
    exact?.release();
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// transport 先取得而后续元数据申请失败时，必须归还新 quota 并保留原 base charge。
test("封口元数据拒绝不会泄漏已预留 final 字节，释放后重试成功", async () => {
  const f = await fixture(exactSealingSnapshot(32 * 1024, "b"));
  await f.registerRoute();
  const blocker = leaveAvailable(f.admission, "controlIndex", 1);
  const before = f.store.exportCommittedState();
  const charged = usage(f.admission);
  const final = exactSealingSnapshot(40 * 1024, "f");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(f.store.sealDoc(f.sealInput(final))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    }
    blocker.release();
    await expect(f.store.sealDoc(f.sealInput(final))).resolves.toEqual({ outcome: "committed", finalSeq: 1 });
  } finally {
    blocker.release();
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// 已提交原子登记的回执丢失不代表失败，不能删除后继；新协议机必须沿同一路由完成重试。
test("路由提交结果未知时保留已提交 successor 与 quota，并可按同键恢复", async () => {
  const f = await fixture();
  const uncertain = new Proxy(f.store, {
    get(target, property) {
      if (property === "registerSuccessor")
        return async (...args: Parameters<MemoryProjectionStore["registerSuccessor"]>) => {
          await target.registerSuccessor(...args);
          return { outcome: "unknown" as const };
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await expect(f.machine(uncertain).seal(f.request())).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(await f.store.readSuccessor(KEY, f.a)).toMatchObject({ state: "sealing", route: { successorDocId: f.b } });
    expect((await f.store.readDocStateAt(f.b, 0))?.snapshot).toEqual(f.empty);
    expect(f.admission.used("transportCache")).toBe(f.empty.byteLength * 2);
    await expect(f.machine().seal(f.request())).resolves.toMatchObject({ docId: f.a, finalUpdateSeq: 1 });
    expect(f.store.exportCommittedState().docs).toHaveLength(2);
  } finally {
    f.store.dispose();
  }
  expectReleased(f.admission);
});

// 已封口的请求截止点冲突属于无写入的参数错误，不能毒化机器或绕过正确请求的 Store fencing。
test("已封口后错误 cutoff 不改变 phase，正确 cutoff 可重试且仍复核租约", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    const first = await machine.seal(f.request());
    await expect(machine.seal({ ...f.request(), finalUpdateSeq: 2 })).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect(machine.phase).toBe("sealed");
    expect(await machine.seal(f.request())).toEqual(first);
    await f.store.releaseWriter(f.lease);
    await f.store.acquireWriter(KEY, "replacement", 10000);
    await expect(machine.seal(f.request())).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    f.store.dispose();
  }
  expectReleased(f.admission);
});

for (const mismatch of ["kind", "state", "used", "base"] as const) {
  // 摘要相同也不代表目标身份或生命周期可复用，冲突不得发布路由或修改旧计费。
  test(`原子后继登记拒绝复用不匹配的既有目标：${mismatch}`, async () => {
    const f = await fixture();
    const candidate = f.record(f.b);
    const otherBase = exactSealingSnapshot(64, "m");
    const target = {
      ...candidate,
      ...(mismatch === "kind" ? { kind: "content" as const } : {}),
      ...(mismatch === "base" ? { snapshot: otherBase, hash: sha256Digest(otherBase) } : {}),
    };
    if (mismatch === "state")
      await f.store.putSealedIfAbsent({
        scopeKey: KEY,
        epoch: f.lease.epoch,
        doc: { ...target, state: "sealed", finalSeq: 0 },
      });
    else await f.store.createDoc({ scopeKey: KEY, epoch: f.lease.epoch, doc: target });
    if (mismatch === "used")
      await f.store.appendUpdates({
        scopeKey: KEY,
        epoch: f.lease.epoch,
        owner: f.lease.owner,
        batchId: "used-successor",
        digest: "used-successor",
        expectedFrontiers: [{ docId: f.b, lastSeq: 0 }],
        updates: [{ docId: f.b, fromSeq: 1, bytes: f.empty }],
      });
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    try {
      await expect(
        f.store.registerSuccessor({
          scopeKey: KEY,
          epoch: f.lease.epoch,
          predecessorDocId: f.a,
          successorDocId: f.b,
          expectedLastSeq: 1,
          successorDoc: candidate,
        }),
      ).resolves.toEqual({ outcome: "conflict" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    } finally {
      f.store.dispose();
    }
    expectReleased(f.admission);
  });
}

for (const mismatch of ["scope", "generation"] as const) {
  // 已有相同摘要的目标也不能让请求跨租户或跨代次绑定，失败时全部状态保持原状。
  test(`新后继绑定拒绝不匹配的请求身份：${mismatch}`, async () => {
    const f = await fixture();
    const candidate = f.record(f.b);
    await f.store.createDoc({ scopeKey: KEY, epoch: f.lease.epoch, doc: candidate });
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    try {
      await expect(
        f.store.registerSuccessor({
          scopeKey: KEY,
          epoch: f.lease.epoch,
          predecessorDocId: f.a,
          successorDocId: f.b,
          expectedLastSeq: 1,
          successorDoc: {
            ...candidate,
            ...(mismatch === "scope" ? { scopeKey: "other/quota" } : { generation: "other-generation" }),
          },
        }),
      ).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    } finally {
      f.store.dispose();
    }
    expectReleased(f.admission);
  });
}

// 首次绑定复用匹配初始目标；已绑定路由的重试不再重验后继的 active 状态或已改变的最终摘要。
test("原子绑定复用既有初始目标，后继再次封口后原路由仍幂等", async () => {
  const f = await fixture();
  const input = {
    scopeKey: KEY,
    epoch: f.lease.epoch,
    predecessorDocId: f.a,
    successorDocId: f.b,
    expectedLastSeq: 1,
    successorDoc: f.record(f.b),
  };
  try {
    await f.store.createDoc({ scopeKey: KEY, epoch: f.lease.epoch, doc: input.successorDoc });
    const transport = f.admission.used("transportCache");
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "committed" });
    expect(f.admission.used("transportCache")).toBe(transport);
    await f.machine().seal(f.request());
    const edit = new Y.Doc();
    edit.getText("body").insert(0, "successor tail");
    const bytes = Y.encodeStateAsUpdate(edit);
    edit.destroy();
    await f.store.appendUpdates({
      scopeKey: KEY,
      epoch: f.lease.epoch,
      owner: f.lease.owner,
      batchId: "successor-tail",
      digest: sha256Digest(bytes),
      expectedFrontiers: [{ docId: f.b, lastSeq: 0 }],
      updates: [{ docId: f.b, fromSeq: 1, bytes }],
    });
    await f.machine().seal({ ...f.request(f.id("c")), oldDocId: f.b });
    expect((await f.store.readDocStateAt(f.b, 1))?.hash).not.toBe(input.successorDoc.hash);
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "already-committed" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
  } finally {
    f.store.dispose();
  }
  expectReleased(f.admission);
});
