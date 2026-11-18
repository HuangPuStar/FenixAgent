import { expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { SyncProtocolError } from "../sync/protocol/errors";
import { AccountedArrayMap, commitAccountedSets, indexBytes } from "../sync/store/memory-accounting";

// 每条元数据只应在首次加入账本时编码，旧前缀不能使追加成本随账本长度增长。
test("连续追加只估算新增元数据且基数只计费一次", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  let serializations = 0;
  const rows = new AccountedArrayMap<string, { toJSON(): string }>(admission, (key, values) => ({
    controlIndex: 128 + key.length * 2 + values.reduce((sum, value) => sum + indexBytes(value), 0),
  }));
  rows.set("doc", []);
  try {
    for (let index = 0; index < 32; index++) {
      rows
        .prepareAppend("doc", [
          {
            toJSON() {
              serializations++;
              return "x";
            },
          },
        ])
        .commit();
    }
    expect(serializations).toBe(32);
    expect(rows.get("doc")).toHaveLength(32);
    // JSON 字符串 "x" 长 3，每行元数据为 128 + 3 * 4，账本基数为 128 + 3 * 2。
    expect(admission.used("controlIndex")).toBe(4614);
  } finally {
    rows.clear();
  }
  expect(admission.used("controlIndex")).toBe(0);
});

// 未配置预算时元数据估算没有消费方，普通替换与追加都不能触发它。
test("无预算的账本替换和追加完全跳过估算", () => {
  const rows = new AccountedArrayMap<string, number>(undefined, () => {
    throw new Error("unbudgeted estimate must not run");
  });
  rows.set("doc", [1]);
  rows.prepareAppend("doc", [2]).commit();
  expect(rows.get("doc")).toEqual([1, 2]);
  rows.set("doc", [3]);
  expect(rows.get("doc")).toEqual([3]);
});

// 后续准备失败必须撤回早先的新增额度和总量，重试不能漏计或重复计费。
test("整批追加回滚保留旧账本的累计用量", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const rows = new AccountedArrayMap<string, number>(admission, (_key, values) => ({
    hotDocLive: values.reduce((sum, bytes) => sum + bytes, 0),
    controlIndex: 128 + values.length * 16,
  }));
  rows.set("first", [100]);
  rows.set("second", [200]);
  const first = rows.get("first");
  const second = rows.get("second");
  const hold = admission.reserve("hotDocLive", admission.available("hotDocLive") - 25);
  try {
    expect(() =>
      commitAccountedSets((pending) => {
        pending.push(rows.prepareAppend("first", [10]));
        pending.push(rows.prepareAppend("second", [20]));
      }),
    ).toThrow(SyncProtocolError);
    expect(rows.get("first")).toBe(first);
    expect(rows.get("second")).toBe(second);
    expect(rows.accountedBytes("first", "hotDocLive")).toBe(100);
    expect(rows.accountedBytes("second", "hotDocLive")).toBe(200);
    expect(admission.available("hotDocLive")).toBe(25);
    expect(admission.used("controlIndex")).toBe(288);
    hold.release();
    commitAccountedSets((pending) => {
      pending.push(rows.prepareAppend("first", [10]));
      pending.push(rows.prepareAppend("second", [20]));
    });
    expect(rows.get("first")).toEqual([100, 10]);
    expect(rows.get("second")).toEqual([200, 20]);
    expect(admission.used("hotDocLive")).toBe(330);
    expect(admission.used("controlIndex")).toBe(320);
    expect(rows.accountedBytes("first", "hotDocLive")).toBe(110);
    expect(rows.accountedBytes("second", "hotDocLive")).toBe(220);
    rows.set("first", [5]);
    expect(rows.accountedBytes("first", "hotDocLive")).toBe(5);
    expect(admission.used("hotDocLive")).toBe(225);
    expect(admission.used("controlIndex")).toBe(304);
  } finally {
    hold.release();
    rows.clear();
  }
  expect(admission.used("hotDocLive")).toBe(0);
  expect(admission.used("controlIndex")).toBe(0);
});
