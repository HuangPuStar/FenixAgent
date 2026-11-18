import { expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { AccountedArrayMap, commitAccountedSets } from "../sync/store/memory-accounting";

/** 在真实额度账本上触发同步重入，避免隐藏实际预留和释放行为。 */
class ReentrantAdmission extends AdmissionController {
  beforeReserve?: () => void;

  /** 保留真实额度检查，仅在入口执行可控的同步回调。 */
  override reserve(pool: ServerPoolName, bytes: number) {
    this.beforeReserve?.();
    return super.reserve(pool, bytes);
  }
}

/** 逐池核对，防止共享池之外的临时额度泄漏。 */
function usage(admission: AdmissionController): number[] {
  return (Object.keys(DEFAULT_SYNC_CAPACITY.serverPools) as ServerPoolName[]).map((pool) => admission.used(pool));
}

/** 同时覆盖完整替换、选择共享和前缀保留三种计费路径。 */
function rowsFor(admission?: AdmissionController) {
  return new AccountedArrayMap<string, number>(admission, (_key, values) => ({
    controlIndex: 128 + values.length * 16,
    hotDocLive: values.reduce((sum, value) => sum + value, 0),
    transportCache: values.length * 4,
  }));
}

const preparations = {
  replace: (rows: ReturnType<typeof rowsFor>, key: string) => rows.prepare(key, [120]),
  sharing: (rows: ReturnType<typeof rowsFor>, key: string) => rows.prepareSharing(key, [100, 20], ["hotDocLive"]),
  append: (rows: ReturnType<typeof rowsFor>, key: string) => rows.prepareAppend(key, [20]),
};

for (const [name, prepare] of Object.entries(preparations)) {
  // 第二份准备必须在任何额度申请之前拒绝，abort 与 commit 后都应允许同键重试。
  test(`${name} 同键准备互斥，结算后可重试且释放全部额度`, () => {
    const admission = new ReentrantAdmission(DEFAULT_SYNC_CAPACITY);
    const rows = rowsFor(admission);
    rows.set("doc", [100]);
    const before = usage(admission);
    const first = prepare(rows, "doc");
    const pendingUsage = usage(admission);
    try {
      admission.beforeReserve = () => {
        throw new Error("duplicate preparation reached reservation");
      };
      for (const duplicate of Object.values(preparations)) expect(() => duplicate(rows, "doc")).toThrow(/pending/);
      expect(usage(admission)).toEqual(pendingUsage);
      expect(rows.get("doc")).toEqual([100]);
      admission.beforeReserve = undefined;
      first.abort();
      first.abort();
      first.commit();
      expect(usage(admission)).toEqual(before);
      const retry = prepare(rows, "doc");
      retry.commit();
      retry.commit();
      retry.abort();
      expect(rows.get("doc")).toEqual(name === "replace" ? [120] : [100, 20]);
      const settledUsage = usage(admission);
      const afterCommit = rows.prepare("doc", [1]);
      afterCommit.abort();
      expect(usage(admission)).toEqual(settledUsage);
    } finally {
      admission.beforeReserve = undefined;
      first.abort();
      rows.clear();
    }
    expect(usage(admission).every((bytes) => bytes === 0)).toBe(true);
  });

  // reserve 的同步重入不能取得同键写权，传播失败后也不能留下 pending 标记。
  test(`${name} 预留重入失败保持旧值并允许随后重试`, () => {
    const admission = new ReentrantAdmission(DEFAULT_SYNC_CAPACITY);
    const rows = rowsFor(admission);
    rows.set("doc", [100]);
    const before = usage(admission);
    try {
      admission.beforeReserve = () => {
        admission.beforeReserve = undefined;
        rows.prepare("doc", [1]).commit();
      };
      expect(() => prepare(rows, "doc")).toThrow(/pending/);
      expect(rows.get("doc")).toEqual([100]);
      expect(usage(admission)).toEqual(before);
      prepare(rows, "doc").commit();
      expect(rows.get("doc")).toEqual(name === "replace" ? [120] : [100, 20]);
    } finally {
      admission.beforeReserve = undefined;
      rows.clear();
    }
    expect(usage(admission).every((bytes) => bytes === 0)).toBe(true);
  });

  // 后续池拒绝须归还早先池与临时数组的额度，同时释放同键准备权。
  test(`${name} 多池预留失败释放准备权与新增额度`, () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const rows = rowsFor(admission);
    rows.set("doc", [100]);
    const hold = admission.reserve("transportCache", admission.available("transportCache"));
    const before = usage(admission);
    try {
      expect(() => prepare(rows, "doc")).toThrow();
      expect(rows.get("doc")).toEqual([100]);
      expect(usage(admission)).toEqual(before);
      hold.release();
      prepare(rows, "doc").commit();
      expect(rows.get("doc")).toEqual(name === "replace" ? [120] : [100, 20]);
    } finally {
      hold.release();
      rows.clear();
    }
    expect(usage(admission).every((bytes) => bytes === 0)).toBe(true);
  });
}

// 自动回滚须释放先前键的准备权；不同键与不同 Map 的同名键仍能共同提交。
test("重复键回滚共享池准备，不阻止不同键和不同 Map 的合法批次", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const rows = rowsFor(admission);
  const other = rowsFor(admission);
  rows.set("doc", [100]);
  rows.set("next", [100]);
  other.set("doc", [100]);
  const before = usage(admission);
  try {
    expect(() =>
      commitAccountedSets((pending) => {
        pending.push(rows.prepareSharing("doc", [100, 20], ["hotDocLive"]));
        pending.push(rows.prepareAppend("next", [20]));
        pending.push(rows.prepare("doc", [120]));
      }),
    ).toThrow(/pending/);
    expect([...rows]).toEqual([
      ["doc", [100]],
      ["next", [100]],
    ]);
    expect(usage(admission)).toEqual(before);
    commitAccountedSets((pending) => {
      pending.push(rows.prepareSharing("doc", [100, 20], ["hotDocLive"]));
      pending.push(rows.prepareAppend("next", [20]));
      pending.push(other.prepare("doc", [120]));
    });
    expect([...rows]).toEqual([
      ["doc", [100, 20]],
      ["next", [100, 20]],
    ]);
    expect(other.get("doc")).toEqual([120]);
    expect(admission.used("hotDocLive")).toBe(360);
    expect(admission.used("controlIndex")).toBe(464);
    expect(admission.used("transportCache")).toBe(20);
  } finally {
    rows.clear();
    other.clear();
  }
  expect(usage(admission).every((bytes) => bytes === 0)).toBe(true);
});

// 预算是可选端口，同键准备互斥不能依赖是否启用计费。
test("无预算时也拒绝重叠准备并在回滚后允许重试", () => {
  const rows = rowsFor();
  rows.set("doc", [100]);
  expect(() =>
    commitAccountedSets((pending) => {
      pending.push(rows.prepareAppend("doc", [20]));
      pending.push(rows.prepare("doc", [120]));
    }),
  ).toThrow(/pending/);
  expect(rows.get("doc")).toEqual([100]);
  rows.prepareAppend("doc", [20]).commit();
  expect(rows.get("doc")).toEqual([100, 20]);
});
