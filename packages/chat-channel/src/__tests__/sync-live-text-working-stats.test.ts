import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import type { DirectoryAppender } from "../sync/live/directory-appender";
import { TextClaimCache } from "../sync/live/text-claim-cache";
import { createTextWorkingEstimator } from "../sync/live/writer-text-working";

// 已计费缓存总量随重复add/delete/reset即时变化，计数不能跟身份数量或失败预留脱节。
test("claim 控制额度累计值对重复操作与拒绝保持准确", () => {
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex: 1024 },
  });
  const cache = new TextClaimCache(admission);
  cache.add("a");
  const first = cache.reservedBytes;
  expect(first).toBe(admission.used("controlIndex"));
  cache.add("a");
  expect(cache.reservedBytes).toBe(first);
  expect(() => cache.add("x".repeat(1000))).toThrow("controlIndex");
  expect(cache.reservedBytes).toBe(first);
  cache.delete("a");
  cache.delete("a");
  expect(cache.reservedBytes).toBe(0);
  cache.add("a");
  cache.add("b");
  expect(cache.reservedBytes).toBe(admission.used("controlIndex"));
  cache.clear();
  cache.clear();
  expect(cache.reservedBytes).toBe(0);
  expect(admission.used("controlIndex")).toBe(0);
});

// 正文token工作界只依赖局部游标；legacy缓存和闭包只有幂等重判需要，不能每token重扫历史。
test("非幂等估算不访问claim或history且同一安装的历史字节只汇总一次", () => {
  const doc = new Y.Doc();
  let claimReads = 0,
    historyReads = 0,
    scans = 0;
  const tracked = () =>
    new Proxy(["old-a", "old-b"], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) scans++;
        return Reflect.get(target, property, receiver);
      },
    });
  let history = tracked();
  const directory: DirectoryAppender = {
    load: async () => {},
    appendContentDoc: async () => {},
    tailContentDocId: () => null,
    planContentDocs: () => {
      throw new Error("estimate must not plan directory");
    },
    workingFrontier: () => ({ rootLastSeq: 4, pageLastSeq: 5, docIdUnits: 40 }),
  };
  const estimate = createTextWorkingEstimator({
    capacity: DEFAULT_SYNC_CAPACITY,
    scopeKey: "org/session",
    directory,
    content: () => ({ doc, docId: "sync/content/gen/0/content", kind: "content", lastSeq: 6 }),
    history: () => {
      historyReads++;
      return history;
    },
    claim: {
      reservedControlBytes: () => {
        claimReads++;
        return 4096;
      },
      claim: async () => true,
      release() {},
      reset() {},
    },
  });
  const key = { generation: "gen", turnId: "turn", entryId: "entry", contentSlot: "text", contentType: "text/plain" };
  try {
    for (let index = 0; index < 1000; index++) estimate(key, 1, 0, false);
    expect(claimReads).toBe(0);
    expect(historyReads).toBe(0);
    expect(scans).toBe(0);
    estimate(key, 1, 0, true);
    estimate(key, 1, 0, true);
    expect(scans).toBe(1);
    history = tracked();
    estimate(key, 1, 0, true);
    expect(scans).toBe(2);
    expect(claimReads).toBe(3);
  } finally {
    doc.destroy();
  }
});
