import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY, validateCapacityProfile } from "../sync/capacity/profile";

// 池总和合法但连一次最小正文规划都容不下时，启动即拒绝，不能让每次输入永久过载。
test("512 KiB persistSeal 档位在启用前明确拒绝", () => {
  const persistSeal = 512 * 1024;
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: {
      ...DEFAULT_SYNC_CAPACITY.serverPools,
      persistSeal,
      ingressSpool:
        DEFAULT_SYNC_CAPACITY.serverPools.ingressSpool + DEFAULT_SYNC_CAPACITY.serverPools.persistSeal - persistSeal,
    },
  };
  expect(() => validateCapacityProfile(capacity)).toThrow("persistSeal");
});

// 分片 update 能通过窗口仍不足以保证首次发现后继块时可发送完整 DOC_BASE。
test("64 KiB 窗口不能启用允许更大完整快照的档位", () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, connectionBodyWindowBytes: 64 * 1024 },
  };
  expect(() => validateCapacityProfile(capacity)).toThrow("connectionBodyWindowBytes");
});
