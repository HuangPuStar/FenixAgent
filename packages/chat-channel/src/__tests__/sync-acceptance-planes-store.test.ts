import { expect, test } from "bun:test";
import {
  createPlaneHarness,
  createPlaneStore,
  FaultyProjectionStore,
  PlaneClock,
} from "./sync-acceptance-planes-oracle";

/** 故障只落在追加路径，其余调用必须保留真实底层 Store 的认证与读取语义。 */
async function fixture() {
  const clock = new PlaneClock();
  const base = createPlaneStore(undefined, clock);
  const fault = new Error("test append unavailable");
  const store = new FaultyProjectionStore(base, { method: "appendUpdates", afterCalls: 0, error: fault });
  const harness = await createPlaneHarness({ store, clock, connect: false });
  const lease = await store.acquireWriter(harness.scopeKey, "planes-test", 1000);
  return { base, store, harness, lease, clock, fault };
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
    await expect(Promise.resolve().then(() => f.store.appendUpdates(input))).rejects.toBe(f.fault);
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
  } finally {
    await f.harness.disposeAll();
    f.base.dispose();
  }
});
