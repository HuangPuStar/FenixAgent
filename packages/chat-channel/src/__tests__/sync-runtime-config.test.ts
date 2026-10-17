// packages/chat-channel/src/__tests__/sync-runtime-config.test.ts
// G 阶段装配配置（`sync/runtime/config.ts`）的行为守护：数值必须全部派生自容量档案、配额与容量档案的
// 连接窗口等值、自相矛盾的配置在启用前被拒绝。
//
// 断言口径与 `sync-capacity.test.ts` 一致：逐值对照 `capacity/profile.ts` 的既有常量，而不是对照本文件的字面量。

import { describe, expect, test } from "bun:test";
import {
  CONCURRENCY_LIMITS,
  DEFAULT_SYNC_CAPACITY,
  FAIRNESS_CONFIG,
  INPUT_LIMITS,
  type SyncCapacityProfile,
} from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  resolveSyncRuntimeConfig,
  type SyncRuntimeConfig,
  type SyncRuntimeConfigOverrides,
  validateSyncRuntimeConfig,
} from "../sync/runtime/config";

/** 固定时间源：rotation 选项要求注入时钟，配置派生本身不得读真实时间。 */
const CLOCK: Clock = { now: () => 1_700_000_000_000 };

/** 清理宽限期没有默认值（`store/types.ts` 的装配契约）：每个用例都必须显式给出。 */
const LIFECYCLE = { sealGraceMs: 1_000, retireGraceMs: 2_000 } as const;

/** 一份最小可用的覆盖集：只注入时钟/随机源与必需的宽限期，其余全部由 profile 派生。 */
function overrides(extra: Partial<SyncRuntimeConfigOverrides> = {}): SyncRuntimeConfigOverrides {
  return { clock: CLOCK, random: deterministicRandomSource("runtime-config"), lifecycle: LIFECYCLE, ...extra };
}

/** 按覆盖集解析配置；缺 lifecycle 的用例单独走 expect。 */
function resolve(extra: Partial<SyncRuntimeConfigOverrides> = {}): SyncRuntimeConfig {
  return resolveSyncRuntimeConfig(overrides(extra));
}

/** 捕获配置层错误：非 SyncProtocolError 原样抛出，避免把断言失败误判成「确实抛了错」。 */
function captureConfigError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

/** 断言装配期拒绝：统一核对错误码，并确认 message 指认了不成立的项。 */
function expectConfigRejection(run: () => unknown, expectedFragment: string): SyncProtocolError {
  const error = captureConfigError(run);
  expect(error.code).toBe("ADMISSION_REJECTED");
  expect(error.message).toContain(expectedFragment);
  return error;
}

/** 改容量的连接窗口（与 socket 水位）：用来构造「配额与档案一致/不一致」两侧。 */
function capacityWithWindow(
  connectionBodyWindowBytes: number,
  socketHighWatermarkBytes: number = DEFAULT_SYNC_CAPACITY.concurrency.socketHighWatermarkBytes,
): SyncCapacityProfile {
  return {
    ...DEFAULT_SYNC_CAPACITY,
    concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, connectionBodyWindowBytes, socketHighWatermarkBytes },
  };
}

describe("resolveSyncRuntimeConfig 的数值来源", () => {
  // 额度窗口与 socket 水位必须逐值等于容量档案的连接窗口：两侧口径不一致会让「还能发多少」出现两个答案。
  test("配额窗口与 socket 水位取自容量档案的连接窗口", () => {
    const config = resolve();
    expect(config.quota.maxOutstandingBytes).toBe(CONCURRENCY_LIMITS.connectionBodyWindowBytes);
    expect(config.quota.socketHighWatermark).toBe(CONCURRENCY_LIMITS.socketHighWatermarkBytes);
    expect(config.quota.maxOutstandingBytes).toBe(config.capacity.concurrency.connectionBodyWindowBytes);
  });

  // 合并阈值、控制限流与 ACK 期限都必须引用 profile 的既有常量，不得在装配层另抄一份。
  test("合并阈值、控制限流与期限取自 profile 的既有常量", () => {
    const config = resolve();
    expect(config.merge).toEqual({
      maxDelayMs: INPUT_LIMITS.liveMergeMaxMs,
      maxBytes: INPUT_LIMITS.liveMergeMaxBytes,
    });
    expect(config.control).toEqual({
      framesPerSecond: CONCURRENCY_LIMITS.controlFramesPerSecond,
      windowBytes: CONCURRENCY_LIMITS.controlWindowPerConnectionBytes,
    });
    expect(config.deadlines.ackMs).toBe(CONCURRENCY_LIMITS.ackDeadlineMs);
  });

  // 公平权重：三类正文任务来自 profile 的权重表，控制类取最小正值（控制帧另有 32KiB/连接的控制窗口限流）。
  test("公平权重来自 profile 权重表，控制类取最小正值且仍满足 quota 的正整数要求", () => {
    const config = resolve();
    expect(config.quota.fairness).toEqual({
      control: 1,
      realtime: FAIRNESS_CONFIG.weights.live,
      "history-current": FAIRNESS_CONFIG.weights.currentHistory,
      "history-background": FAIRNESS_CONFIG.weights.backgroundHistory,
    });
    expect(() => validateSyncRuntimeConfig(config)).not.toThrow();
  });

  // 运行态上限与轮换共享同一份 limits 对象：写入层与轮换决策若各持一份，调参只改到一侧就会让轮换判定失真。
  test("运行态上限来自 profile 的运行态行，且与轮换选项共用同一份对象", () => {
    const config = resolve();
    expect(config.limits).toEqual({
      maxLivePayloadBytes: INPUT_LIMITS.runtimeLivePayloadBytes,
      maxEntities: INPUT_LIMITS.runtimeMaxEntities,
      maxEntityMetadataBytes: INPUT_LIMITS.runtimeEntityMaxBytes,
      softRotateBytes: INPUT_LIMITS.runtimeSoftSnapshotBytes,
      hardLimitBytes: INPUT_LIMITS.runtimeHardSnapshotBytes,
    });
    expect(config.rotation.limits).toBe(config.limits);
    expect(config.rotation.maxResidentMs).toBe(CONCURRENCY_LIMITS.handoffDeadlineMs);
    expect(config.rotation.maxTransactions).toBe(INPUT_LIMITS.maxTransactionsPerDoc);
    expect(config.rotation.clock).toBe(CLOCK);
  });

  // 暂存三档配额取 profile 的 loadSpool* 常量；根目录是唯一没有常量可派的字段，必须允许宿主覆盖。
  test("暂存配额取自 profile，根目录由覆盖给出", () => {
    const config = resolve({ spoolRootDir: "/tmp/sync-spool-test" });
    expect(config.spool).toEqual({
      rootDir: "/tmp/sync-spool-test",
      segmentBytes: CONCURRENCY_LIMITS.loadSpoolSegmentBytes,
      taskQuotaBytes: CONCURRENCY_LIMITS.loadSpoolTaskBytes,
      processQuotaBytes: CONCURRENCY_LIMITS.loadSpoolProcessBytes,
    });
    expect(resolve().spool.rootDir.length).toBeGreaterThan(0);
  });

  // 清理宽限期没有可派生的常量：缺省必须拒绝装配，不得静默补一个「多久后可以回收」的默认值。
  test("缺 lifecycle 时拒绝解析，不产出半成品配置", () => {
    const error = expectConfigRejection(
      () => resolveSyncRuntimeConfig({ clock: CLOCK, random: deterministicRandomSource("no-lifecycle") }),
      "lifecycle is required",
    );
    expect(error.code).toBe("ADMISSION_REJECTED");
  });

  // 覆盖只改被指定的字段，其余仍由 profile 派生；同时改档案与配额侧后必须仍能通过校验。
  test("覆盖只影响指定字段，档案与配额同改后仍通过校验", () => {
    const config = resolve({
      capacity: capacityWithWindow(4_096, 4_096),
      quota: { maxOutstandingBytes: 4_096, socketHighWatermark: 4_096, maxDirtyDocs: 4 },
      rotation: { maxResidentMs: 60_000, maxTransactions: 7 },
      deadlines: { ackMs: 1_234 },
      merge: { maxDelayMs: 5 },
    });
    expect(config.quota.maxOutstandingBytes).toBe(4_096);
    expect(config.quota.maxDirtyDocs).toBe(4);
    expect(config.rotation.maxResidentMs).toBe(60_000);
    expect(config.rotation.maxTransactions).toBe(7);
    expect(config.deadlines.ackMs).toBe(1_234);
    expect(config.merge).toEqual({ maxDelayMs: 5, maxBytes: INPUT_LIMITS.liveMergeMaxBytes });
    expect(() => validateSyncRuntimeConfig(config)).not.toThrow();
  });

  // 默认档案解析出的配置必须自洽：否则任何接线都会在启动期直接失败。
  test("默认档案解析出的配置通过启用前校验", () => {
    expect(() => validateSyncRuntimeConfig(resolve())).not.toThrow();
  });
});

describe("validateSyncRuntimeConfig 的装配期断言", () => {
  // 侦察 §4.3 的核心缺口：quota 窗口大于档案窗口时没有任何断言会失败，因此必须在这里逐值核对。
  test("配额窗口小于档案连接窗口时拒绝，并给出两侧数值", () => {
    const config = resolve({ quota: { maxOutstandingBytes: CONCURRENCY_LIMITS.connectionBodyWindowBytes - 1 } });
    const error = expectConfigRejection(() => validateSyncRuntimeConfig(config), "quota.maxOutstandingBytes");
    expect(error.message).toContain(String(CONCURRENCY_LIMITS.connectionBodyWindowBytes));
  });

  // socket 水位与档案不等同样会让「已授予却发不出的额度」出现，必须拒绝。
  test("配额 socket 水位与档案不等时拒绝", () => {
    const config = resolve({ quota: { socketHighWatermark: CONCURRENCY_LIMITS.socketHighWatermarkBytes + 1 } });
    expectConfigRejection(() => validateSyncRuntimeConfig(config), "quota.socketHighWatermark");
  });

  // 宽限期为零或负数会让封口后的尾部立刻可回收，等于取消保护期。
  test("清理宽限期非正整数时拒绝", () => {
    for (const sealGraceMs of [0, -1, 1.5]) {
      const config = resolve({ lifecycle: { sealGraceMs, retireGraceMs: 100 } });
      expectConfigRejection(() => validateSyncRuntimeConfig(config), "lifecycle.sealGraceMs");
    }
    const retire = resolve({ lifecycle: { sealGraceMs: 100, retireGraceMs: 0 } });
    expectConfigRejection(() => validateSyncRuntimeConfig(retire), "lifecycle.retireGraceMs");
  });

  // 合并阈值非正会让「首增量起算的定时冲刷」失去边界；控制窗口超过档案上限则等于绕过控制池。
  test("合并阈值非正、控制窗口超上限、帧率非正时分别拒绝", () => {
    const mergeZero = resolve({ merge: { maxBytes: 0 } });
    expectConfigRejection(() => validateSyncRuntimeConfig(mergeZero), "merge.maxBytes");

    const wideControl = resolve({ control: { windowBytes: CONCURRENCY_LIMITS.controlWindowPerConnectionBytes + 1 } });
    expectConfigRejection(() => validateSyncRuntimeConfig(wideControl), "control.windowBytes");

    const noFrames = resolve({ control: { framesPerSecond: 0 } });
    expectConfigRejection(() => validateSyncRuntimeConfig(noFrames), "control.framesPerSecond");
  });

  // 暂存根目录为空会把 load 目录写到进程工作目录下的随机位置，必须在装配期拒绝。
  test("暂存根目录为空白时拒绝", () => {
    for (const root of ["", "   "]) {
      const config = resolve({ spoolRootDir: root });
      expectConfigRejection(() => validateSyncRuntimeConfig(config), "spool.rootDir");
    }
  });

  // 档案本身损坏时必须先于配额断言报出（否则「不相等」的结论建立在坏基准上）。
  test("容量档案自相矛盾时拒绝，且先于配额断言报出", () => {
    const broken: SyncCapacityProfile = {
      ...DEFAULT_SYNC_CAPACITY,
      concurrency: {
        ...CONCURRENCY_LIMITS,
        connectionBodyWindowBytes: CONCURRENCY_LIMITS.socketHighWatermarkBytes * 2,
      },
    };
    const config = resolve({
      capacity: broken,
      quota: { maxOutstandingBytes: broken.concurrency.connectionBodyWindowBytes },
    });
    expectConfigRejection(() => validateSyncRuntimeConfig(config), "capacity profile rejected");
  });

  // 权重为 0 或非整数会让该类所有比较恒为 false（看似永不超限），必须在装配期拒绝。
  test("公平权重非正整数时拒绝", () => {
    const config = resolve();
    const broken: SyncRuntimeConfig = {
      ...config,
      quota: { ...config.quota, fairness: { ...config.quota.fairness, control: 0 } },
    };
    expectConfigRejection(() => validateSyncRuntimeConfig(broken), "quota.fairness.control");
  });
});
