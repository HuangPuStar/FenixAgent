import { expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { adoptWorkingReservation, WORKING_CREDIT, type WorkingCredit } from "../sync/capacity/working-credit";
import { sha256Digest } from "../sync/clock";
import { AccountedMap, commitAccountedSets } from "../sync/store/memory-accounting";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 使写路径必须消费已保留的工作额度，不能借用全局剩余空间蒙混过关。 */
function fillControl(admission: AdmissionController) {
  return admission.reserve("controlIndex", admission.available("controlIndex"));
}

// 内部能力使用符号键携带，既有 JSON 与 structuredClone 观察仍只看见可移植批次数据。
test("工作额度符号不进入批次 JSON 或 structuredClone", async () => {
  const f = await contentBatchFixture(),
    credit = f.admission.createWorkingCredit(65536);
  try {
    const input = { ...f.input, [WORKING_CREDIT]: credit };
    expect(() => JSON.stringify(input)).not.toThrow();
    const copy = structuredClone(input);
    expect(copy.updates).toEqual(input.updates);
    expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
    for (const doc of input.newDocs) Object.assign(doc, { [WORKING_CREDIT]: credit });
    expect((await f.store.commitContentBatch(input)).outcome).toBe("committed");
    expect(f.store.exportCommittedState().docs.every((doc) => Object.getOwnPropertySymbols(doc).length === 0)).toBe(
      true,
    );
  } finally {
    credit.release();
    f.store.dispose();
  }
});

// 没有注入预算的 adapter 维持原契约，不把其它运行环境的内部 token 当成本地计费能力。
test("未注入 Store 预算时忽略工作额度 token", async () => {
  const f = await contentBatchFixture(),
    snapshot = f.store.exportCommittedState();
  f.store.dispose();
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const credit = f.admission.createWorkingCredit(65536);
  try {
    store.restoreFromCommittedState(snapshot);
    const lease = await store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    expect((await store.commitContentBatch({ ...f.input, epoch: lease.epoch, [WORKING_CREDIT]: credit })).outcome).toBe(
      "committed",
    );
    expect(credit.availableBytes).toBe(65536);
  } finally {
    credit.release();
    store.dispose();
  }
  expect(f.usage()).toEqual([0, 0, 0]);
});

// head 的只读证明也必须能借用 escrow，临时分子全部返回，发布的正缓存另归 Store 持有。
test("覆盖查询由工作额度资助并接管最终正缓存计费", async () => {
  const f = await contentBatchFixture(),
    credit = f.admission.createWorkingCredit(8 * 1024 * 1024);
  const blocker = fillControl(f.admission),
    initial = credit.availableBytes;
  try {
    expect(
      (
        await f.store.readLiveTextCoverage({
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          docIds: [f.ids[0]],
          [WORKING_CREDIT]: credit,
        })
      ).size,
    ).toBe(1);
    expect(credit.availableBytes).toBeLessThan(initial);
    expect(initial - credit.availableBytes).toBeLessThan(8192);
    blocker.release();
    credit.release();
    f.store.dispose();
    expect(f.usage()).toEqual([0, 0, 0]);
  } finally {
    blocker.release();
    credit.release();
    f.store.dispose();
  }
});

for (const atomic of [false, true]) {
  // 空闲池已被其它作用域占满时，已接纳窗口仍能由真实 escrow 完成 Store 提交。
  test(`Store 从同 Controller 工作额度提交并保留常驻计费，原子=${atomic}`, async () => {
    const f = await contentBatchFixture(),
      credit = f.admission.createWorkingCredit(64 * 1024);
    const blocker = fillControl(f.admission),
      initial = credit.availableBytes;
    try {
      const input = atomic
        ? { ...f.input, [WORKING_CREDIT]: credit }
        : {
            ...f.input,
            [WORKING_CREDIT]: credit,
            refs: [],
            expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
            updates: [f.input.updates[0]],
          };
      const result = atomic ? await f.store.commitContentBatch(input) : await f.store.appendUpdates(input);
      expect(result.outcome).toBe("committed");
      expect(credit.availableBytes).toBeLessThan(initial);
      expect(JSON.stringify(f.store.exportCommittedState())).not.toContain("workingCredit");
      blocker.release();
      credit.release();
      expect(f.admission.used("controlIndex")).toBeGreaterThan(0);
      f.store.dispose();
      expect(f.usage()).toEqual([0, 0, 0]);
    } finally {
      blocker.release();
      credit.release();
      f.store.dispose();
    }
  });
}

for (const invalid of ["foreign", "forged", "closed"] as const) {
  // token 结构、父类和充足全局额度都不能代替签发身份与 open 状态，拒绝不得改变 Store。
  test(`Store 拒绝 ${invalid} 工作额度能力且无副作用`, async () => {
    const f = await contentBatchFixture(),
      foreign = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const issued = invalid === "foreign" ? foreign.createWorkingCredit(65536) : f.admission.createWorkingCredit(65536);
    // 仅在测试中伪造带相同原型的能力，不能由结构相等取得签发资格。
    const credit = invalid === "forged" ? (Object.create(issued) as WorkingCredit) : issued;
    if (invalid === "closed") issued.release();
    try {
      const before = f.store.exportCommittedState(),
        usage = f.usage();
      await expect(f.store.commitContentBatch({ ...f.input, [WORKING_CREDIT]: credit })).rejects.toMatchObject({
        code: "ADMISSION_REJECTED",
      });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
    } finally {
      issued.release();
      f.store.dispose();
    }
  });
}

// 子额度准备失败要返还仍打开的窗口，扩展后同一计划可重试，不能提前释放其它已接纳窗口。
test("Store 工作额度不足完整归还后扩展可重试", async () => {
  const f = await contentBatchFixture(),
    credit = f.admission.createWorkingCredit(1024);
  let blocker = fillControl(f.admission);
  try {
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(f.store.commitContentBatch({ ...f.input, [WORKING_CREDIT]: credit })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    expect(credit.availableBytes).toBe(1024);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    blocker.release();
    credit.growTo(65536);
    blocker = fillControl(f.admission);
    expect((await f.store.commitContentBatch({ ...f.input, [WORKING_CREDIT]: credit })).outcome).toBe("committed");
  } finally {
    blocker.release();
    credit.release();
    f.store.dispose();
  }
  expect(f.usage()).toEqual([0, 0, 0]);
});

// CAS 前父窗口关闭不能提前释放 prepared 子额度；拒绝后子额度回全局而非复活已关闭窗口。
test("最终 CAS 拒绝在途关闭的工作额度时不泄漏或复活窗口", async () => {
  let credit: WorkingCredit | undefined,
    armed = false;
  const f = await contentBatchFixture(DEFAULT_SYNC_CAPACITY, {
    digest: (bytes) => {
      if (armed && credit && credit.availableBytes < 65536 && !credit.closed) {
        credit.release();
        f.advance(10000);
      }
      return sha256Digest(bytes);
    },
  });
  try {
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    credit = f.admission.createWorkingCredit(65536);
    armed = true;
    await expect(f.store.commitContentBatch({ ...f.input, [WORKING_CREDIT]: credit })).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    });
    expect(credit.closed).toBe(true);
    expect(credit.availableBytes).toBe(0);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    credit?.release();
    f.store.dispose();
  }
  expect(f.usage()).toEqual([0, 0, 0]);
});

// prepare 已实际借出的分子可在父窗口关闭后无失败地转为 Map 常驻，随后由 Map 删除归还。
test("AccountedMap 晚提交接管已关闭父窗口的物理子额度", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY),
    credit = admission.createWorkingCredit(64);
  const map = new AccountedMap(admission, () => ({ controlIndex: 8 }));
  try {
    const prepared = map.prepare("key", "value", credit);
    expect(credit.availableBytes).toBe(56);
    credit.release();
    expect(admission.used("controlIndex")).toBe(8);
    prepared.commit();
    expect(map.get("key")).toBe("value");
    expect(admission.used("controlIndex")).toBe(8);
    map.clear();
    expect(admission.used("controlIndex")).toBe(0);
  } finally {
    credit.release();
    map.clear();
  }
});

// 首次借款后关闭父窗口再失败，整批 abort 必须归还全局且不发布任何 Map。
test("AccountedMap 父窗口关闭后的整批 abort 完整归还", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY),
    credit = admission.createWorkingCredit(64);
  const map = new AccountedMap(admission, () => ({ controlIndex: 8 })),
    failure = new Error("final CAS failed");
  expect(() =>
    commitAccountedSets((pending) => {
      pending.push(map.prepare("key", "value", credit));
      expect(credit.availableBytes).toBe(56);
      credit.release();
      throw failure;
    }),
  ).toThrow(failure);
  expect(map.size).toBe(0);
  expect(admission.used("controlIndex")).toBe(0);
  expect(credit.closed).toBe(true);
});

for (const invalid of ["foreign", "closed"] as const) {
  // 共享行没有新增额度也必须校验签发身份，不能用零增长路径绕过 foreign 或 closed 能力检查。
  test(`AccountedMap 零增长仍拒绝 ${invalid} 工作额度`, () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY),
      other = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const map = new AccountedMap(admission, () => ({ controlIndex: 8 }));
    map.set("key", "value");
    const credit = (invalid === "foreign" ? other : admission).createWorkingCredit(64);
    if (invalid === "closed") credit.release();
    let prepared: ReturnType<typeof map.prepareSharing> | undefined;
    try {
      const before = admission.used("controlIndex");
      expect(() => {
        prepared = map.prepareSharing("key", "value", ["controlIndex"], credit);
      }).toThrow("working credit");
      expect([...map]).toEqual([["key", "value"]]);
      expect(admission.used("controlIndex")).toBe(before);
    } finally {
      prepared?.abort();
      credit.release();
      map.clear();
    }
    expect(admission.used("controlIndex")).toBe(0);
  });
}

// 合法且仍 open 的能力即使空闲分子为零，也能证明无需再分配的共享行更新。
test("AccountedMap 零增长允许同 Controller 已用尽但未关闭的工作额度", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY),
    credit = admission.createWorkingCredit(64);
  const assigned = admission.reserve("controlIndex", 64, credit);
  adoptWorkingReservation(assigned);
  const map = new AccountedMap(admission, () => ({ controlIndex: 8 }));
  map.set("key", "value");
  try {
    expect(credit.availableBytes).toBe(0);
    map.prepareSharing("key", "next", ["controlIndex"], credit).commit();
    expect(map.get("key")).toBe("next");
    expect(admission.used("controlIndex")).toBe(72);
  } finally {
    assigned.release();
    credit.release();
    map.clear();
  }
  expect(admission.used("controlIndex")).toBe(0);
});
