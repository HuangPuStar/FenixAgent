import { expect, test } from "bun:test";
import { sha256Digest } from "../sync/clock";
import type { ProjectionStore, SyncDocRecord } from "../sync/store/types";
import {
  createPlaneHarness,
  createPlaneStore,
  FaultyProjectionStore,
  type FaultyStoreMethod,
  maxSingleTailFrameBytes,
  PlaneClock,
  tightenWindow,
} from "./sync-acceptance-planes-oracle";

/** 先用真实 Store 完成引导，避免待测故障被引导写入提前消费。 */
async function fixture(method: FaultyStoreMethod = "appendUpdates", afterCalls = 0) {
  const clock = new PlaneClock();
  const base = createPlaneStore(undefined, clock);
  const harness = await createPlaneHarness({ store: base, clock, connect: false });
  const fault = new Error(`test ${method} unavailable`);
  const store = new FaultyProjectionStore(base, { method, afterCalls, error: fault });
  const lease = await store.acquireWriter(harness.scopeKey, "planes-test", 1000);
  return { base, store, harness, lease, clock, fault };
}

/** 每次准备独立幂等键；故障前后可直接比较真实 Store 的已提交事实。 */
async function prepareWrite(
  f: Awaited<ReturnType<typeof fixture>>,
  method: FaultyStoreMethod,
  index: number,
): Promise<() => Promise<{ outcome: string }>> {
  const { scopeKey, seedGeneration, seedContentDocId } = f.harness;
  const epoch = f.lease.epoch;
  if (method === "appendUpdates") {
    const input = {
      scopeKey,
      epoch,
      owner: f.lease.owner,
      batchId: `fault-batch-${index}`,
      digest: `fault-digest-${index}`,
      expectedFrontiers: [{ docId: seedContentDocId, lastSeq: index }],
      updates: [{ docId: seedContentDocId, fromSeq: index + 1, bytes: new Uint8Array([0, 0]) }],
    };
    return () => f.store.appendUpdates(input);
  }
  if (method === "commitGeneration") {
    const current = await f.base.readScopePointer(scopeKey);
    const template = await f.base.readGeneration(scopeKey, seedGeneration);
    if (!current || !template) throw new Error("fixture generation is missing");
    const generation = {
      ...template,
      generation: `fault-generation-${index}`,
      loadId: `fault-load-${index}`,
      state: "staging" as const,
    };
    await f.store.createGeneration({ scopeKey, epoch, generation });
    const input = {
      scopeKey,
      epoch,
      expectedCurrent: current.currentGeneration,
      expectedPointerRevision: current.pointerRevision,
      newGeneration: generation,
      entryClosure: generation.entryRefs,
      retired: [],
    };
    return () => f.store.commitGeneration(input);
  }
  const snapshot = new Uint8Array([0, 0]);
  const doc: SyncDocRecord = {
    scopeKey,
    generation: seedGeneration,
    docId: `fault-doc-${index}`,
    kind: "content",
    state: method === "createDoc" ? "active" : "sealed",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: method === "createDoc" ? null : 0,
    blockIndex: index,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
  const input = { scopeKey, epoch, doc };
  return method === "createDoc" ? () => f.store.createDoc(input) : () => f.store.putSealedIfAbsent(input);
}

// 固定帧头使 4KiB 及等于帧上界的窗口无法发送，夹具应在运行前拒绝。
test("收紧窗口拒绝容不下单个 tail 帧的容量档位", () => {
  expect(() => tightenWindow(4096)).toThrow();
  expect(() => tightenWindow(6144)).toThrow();
  expect(() => tightenWindow(Number.NaN)).toThrow();
  expect(() => tightenWindow(Number.POSITIVE_INFINITY)).toThrow();
});

// 合法窗口保留原有缩放结果，包含刚超过实际帧上界的临界档位。
test("收紧窗口保留可发送的容量档位", () => {
  for (const [windowBytes, payloadBytes, frameBytes] of [
    [6145, 1536, 6144],
    [65_536, 16_384, 25_944],
  ]) {
    const capacity = tightenWindow(windowBytes);
    expect(capacity.concurrency.connectionBodyWindowBytes).toBe(windowBytes);
    expect(capacity.concurrency.socketHighWatermarkBytes).toBe(windowBytes);
    expect(capacity.inputs.activeSoftPayloadBytes).toBe(payloadBytes);
    expect(maxSingleTailFrameBytes(capacity)).toBe(frameBytes);
  }
});

// 主动释放必须到达真实租约，让下一写者无需等到旧租约过期就能接管。
test("故障注入 Store 透传租约释放并立即交接写权", async () => {
  const f = await fixture();
  try {
    const store: ProjectionStore = f.store;
    await store.releaseWriter?.(f.lease);
    const next = await f.base.acquireWriter(f.harness.scopeKey, "next-owner", 1000);
    expect(next.epoch).toBe(f.lease.epoch + 1);
    expect(next.expiresAt).toBe(f.lease.expiresAt);
    await f.store.confirmWriter(next, f.harness.seedGeneration);
    await expect(f.store.confirmWriter(f.lease, f.harness.seedGeneration)).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
    expect(f.store.didFire()).toBe(false);
  } finally {
    await f.harness.disposeAll();
    f.base.dispose();
  }
});

for (const method of ["createDoc", "appendUpdates", "putSealedIfAbsent", "commitGeneration"] as const) {
  // 指定调用以 Promise 拒绝且不落库，后续同键重试只提交一次，其他调用不会重复触发故障。
  test(`故障注入 ${method} 保留异步拒绝与真实提交的幂等边界`, async () => {
    const f = await fixture(method, 1);
    try {
      expect((await (await prepareWrite(f, method, 0))()).outcome).toBe("committed");
      expect(f.store.didFire()).toBe(false);
      const write = await prepareWrite(f, method, 1);
      const before = f.base.exportCommittedState();
      const rejected = write();
      expect(rejected).toBeInstanceOf(Promise);
      await expect(rejected).rejects.toBe(f.fault);
      expect(f.store.didFire()).toBe(true);
      expect(f.base.exportCommittedState()).toEqual(before);
      expect((await write()).outcome).toBe("committed");
      const committed = f.base.exportCommittedState();
      expect((await write()).outcome).toBe("already-committed");
      expect(f.base.exportCommittedState()).toEqual(committed);
      expect((await (await prepareWrite(f, method, 2))()).outcome).toBe("committed");
    } finally {
      await f.harness.disposeAll();
      f.base.dispose();
    }
  });
}

// 委托必须验证底层真实租约和当前代，不能靠缺省成功跳过 fencing。
test("故障注入 Store 透传写者确认的成功与拒绝结果", async () => {
  const f = await fixture();
  try {
    await f.store.confirmWriter(f.lease, f.harness.seedGeneration);
    await expect(f.store.confirmWriter({ ...f.lease, owner: "other" }, f.harness.seedGeneration)).rejects.toMatchObject(
      { code: "WRITER_EPOCH_LOST" },
    );
    await expect(f.store.confirmWriter(f.lease, "other-generation")).rejects.toMatchObject({
      code: "GENERATION_MISMATCH",
    });
    f.clock.advance(1000);
    await expect(f.store.confirmWriter(f.lease, f.harness.seedGeneration)).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    });
    expect(f.store.didFire()).toBe(false);
  } finally {
    await f.harness.disposeAll();
    f.base.dispose();
  }
});

// 后继观测必须反映真实登记后的封口状态，并保留 scope 隔离，不能用 null 代替委托。
test("故障注入 Store 透传后继登记及跨 scope 读取边界", async () => {
  const f = await fixture();
  try {
    const scopeKey = f.harness.scopeKey;
    const docId = f.harness.seedContentDocId;
    expect(await f.store.readSuccessor(scopeKey, docId)).toMatchObject({ docId, state: "active", route: null });
    await f.store.registerSuccessor({
      scopeKey,
      epoch: f.lease.epoch,
      predecessorDocId: docId,
      successorDocId: "next-content",
      expectedLastSeq: 0,
    });
    expect(await f.store.readSuccessor(scopeKey, docId)).toMatchObject({
      docId,
      state: "sealing",
      route: { successorDocId: "next-content", expectedLastSeq: 0 },
    });
    expect(await f.store.readSuccessor("other-scope", docId)).toBeNull();
    expect(f.store.didFire()).toBe(false);
    const input = {
      scopeKey,
      epoch: f.lease.epoch,
      owner: f.lease.owner,
      batchId: "post-read",
      digest: "post-read-digest",
      expectedFrontiers: [],
      updates: [],
    };
    await expect(f.store.appendUpdates(input)).rejects.toBe(f.fault);
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
  } finally {
    await f.harness.disposeAll();
    f.base.dispose();
  }
});
