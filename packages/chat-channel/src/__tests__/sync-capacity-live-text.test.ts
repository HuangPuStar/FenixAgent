import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY, validateCapacityProfile } from "../sync/capacity/profile";
import { minimumTextPlanReservations } from "../sync/capacity/text-plan-reservations";

// 已接纳的首字节必须能保留到提交，单独缩小 ingress 不能获得永远无法首写的合法配置。
test("ingressSpool 连首字节保留额度也不足时在启动前拒绝", () => {
  const capacity = (ingressSpool: number) => ({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: {
      ...DEFAULT_SYNC_CAPACITY.serverPools,
      ingressSpool,
      safetyReserve:
        DEFAULT_SYNC_CAPACITY.serverPools.safetyReserve + DEFAULT_SYNC_CAPACITY.serverPools.ingressSpool - ingressSpool,
    },
  });
  expect(() => validateCapacityProfile(capacity(1))).toThrow("ingressSpool");
  expect(() => validateCapacityProfile(capacity(135))).toThrow("ingressSpool");
  expect(() => validateCapacityProfile(capacity(136))).not.toThrow();
});

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

// 可开始写入却永远装不下判重读取的档位必须在启动前拒绝，避免重试永久过载。
test("8 MiB 热池即使容纳最小规划也不能启用 claim 读取", () => {
  const hotDocLive = 8 * 1024 * 1024;
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: {
      ...DEFAULT_SYNC_CAPACITY.serverPools,
      hotDocLive,
      ingressSpool:
        DEFAULT_SYNC_CAPACITY.serverPools.ingressSpool + DEFAULT_SYNC_CAPACITY.serverPools.hotDocLive - hotDocLive,
    },
  };
  expect(() => validateCapacityProfile(capacity)).toThrow("hotDocLive");
});

// 独立控制池须同时覆盖最长合法身份的队列保留与读取元数据，不能借热池充抵。
test("首条文本保留与 claim 读取的 controlIndex 最低额在启动时校验", () => {
  const minimum = minimumTextPlanReservations(DEFAULT_SYNC_CAPACITY.inputs).controlIndex;
  const capacity = (controlIndex: number) => ({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: {
      ...DEFAULT_SYNC_CAPACITY.serverPools,
      controlIndex,
      ingressSpool:
        DEFAULT_SYNC_CAPACITY.serverPools.ingressSpool + DEFAULT_SYNC_CAPACITY.serverPools.controlIndex - controlIndex,
    },
  });
  expect(() => validateCapacityProfile(capacity(minimum - 1))).toThrow("controlIndex");
  expect(() => validateCapacityProfile(capacity(minimum))).not.toThrow();
});

// 分片 update 能通过窗口仍不足以保证首次发现后继块时可发送完整 DOC_BASE。
test("64 KiB 窗口不能启用允许更大完整快照的档位", () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, connectionBodyWindowBytes: 64 * 1024 },
  };
  expect(() => validateCapacityProfile(capacity)).toThrow("connectionBodyWindowBytes");
});
