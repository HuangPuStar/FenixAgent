// packages/chat-channel/src/sync/runtime/config.ts
// G 阶段装配配置（规格 §2.1）：把启用前的容量档案收敛成运行时唯一的一份配置输入。
//
// 所有数值都从注入的 `capacity` 派生（默认值就是 `capacity/profile.ts` 的冻结常量表 DEFAULT_SYNC_CAPACITY），
// 本文件不复制任何字节数：两处各写一份必然在调参时漂移，而漂移的表现是「某条连接的窗口比档案小」这类
// 只在压力下才暴露的隐性超额。
//
// `lifecycle` 没有默认值（`store/types.ts` 的 `StoreLifecycleOptions` 要求装配方显式给出宽限期），
// 因此 `resolveSyncRuntimeConfig` 缺它时直接拒绝——把运维决定藏进代码会让「多久后可以回收」变成隐式契约。

import {
  DEFAULT_SYNC_CAPACITY,
  type FairnessWeights,
  type InputLimits,
  type SyncCapacityProfile,
  validateCapacityProfile,
} from "../capacity/profile";
import { type Clock, cryptoRandomSource, type RandomSource, systemClock } from "../clock";
import type { RotationControllerOptions } from "../live/rotation";
import type { RuntimeDocLimits } from "../live/runtime-doc";
import { SyncProtocolError } from "../protocol/errors";
import type { TaskClass } from "../provider/quota";
import type { StoreLifecycleOptions } from "../store/types";

/** 暂存根目录的缺省值：宿主经 `spoolRootDir` 覆盖，本层不读进程环境（`packages/**` 禁 `process.env`）。 */
const DEFAULT_SPOOL_ROOT_DIR = "./data/sync-spool";

/**
 * 控制类公平权重：profile 的三类权重（实时/当前历史/后台历史）不含控制类，此处取最小正值 1。
 * 控制帧另有 `concurrency.controlWindowPerConnectionBytes`（32KiB/连接）与帧率双限流，份额只需非零
 * （`quota.ts` 拒绝零权重）：取 1 得到的份额略高于控制窗口，真正绑定的仍是控制窗口，而不是把控制帧
 * 抬到与实时类同权后挤占正文份额。
 */
const CONTROL_FAIRNESS_WEIGHT = 1;

/** 任务类校验顺序（与 `quota.ts` 的任务类清单一致）：逐类校验权重，缺项在类型层已不可表达。 */
const TASK_CLASS_ORDER = [
  "control",
  "realtime",
  "history-current",
  "history-background",
] as const satisfies readonly TaskClass[];

/** 单连接额度配置：窗口与 socket 水位必须与 capacity 的连接窗口逐值相等（见 `validateSyncRuntimeConfig`）。 */
export interface SyncRuntimeQuotaConfig {
  /** 已发送未 ACK 的字节窗口；必须等于 `concurrency.connectionBodyWindowBytes`。 */
  readonly maxOutstandingBytes: number;
  /** socket 硬水位；必须等于 `concurrency.socketHighWatermarkBytes`。 */
  readonly socketHighWatermark: number;
  /** 四类任务权重，逐类必须为正整数。 */
  readonly fairness: Readonly<Record<TaskClass, number>>;
  /** dirty 集合上限；超限说明该连接已跟不上订阅变化，必须关闭连接重新握手。 */
  readonly maxDirtyDocs: number;
}

/** 实时合并阈值；与 `LiveWriterOptions.merge` 同形。 */
export interface SyncRuntimeMergeConfig {
  readonly maxDelayMs: number;
  readonly maxBytes: number;
}

/** 控制流限流；与 `ControlGovernor` 的入参同形（帧率 + 单连接控制窗口字节）。 */
export interface SyncRuntimeControlConfig {
  readonly framesPerSecond: number;
  readonly windowBytes: number;
}

/** 各类期限。 */
export interface SyncRuntimeDeadlines {
  /** ACK 期限：超过即关连接并清账（设计 §8.5）。 */
  readonly ackMs: number;
}

/**
 * 历史暂存配置：`rootDir` 对应 `history/spool.ts` 的 `SpoolConfig.basePath`（每个 scope 在其下建自己的目录），
 * 其余字段沿用 `SpoolConfig` 的字段名与口径，装配时可直接映射，不再引入第二套命名。
 */
export interface SyncRuntimeSpoolConfig {
  readonly rootDir: string;
  readonly segmentBytes: number;
  readonly taskQuotaBytes: number;
  readonly processQuotaBytes: number;
}

/** G 阶段装配配置：运行时（store / live / provider / history）唯一的一份输入。 */
export interface SyncRuntimeConfig {
  readonly capacity: SyncCapacityProfile;
  readonly lifecycle: StoreLifecycleOptions;
  readonly quota: SyncRuntimeQuotaConfig;
  readonly merge: SyncRuntimeMergeConfig;
  /** 运行态 Doc 上限（存活载荷、实体数、实体元数据、软/硬编码水位）。 */
  readonly limits: RuntimeDocLimits;
  readonly rotation: RotationControllerOptions;
  readonly control: SyncRuntimeControlConfig;
  readonly deadlines: SyncRuntimeDeadlines;
  readonly spool: SyncRuntimeSpoolConfig;
}

/**
 * 允许覆盖的字段：默认值已能从 profile 完整派生，覆盖只服务于两件事——注入时间/随机源
 * （rotation 选项要求它们，测试也必须能推进假时钟），以及让「配置自相矛盾」在测试里可构造
 * （`validateSyncRuntimeConfig` 的等值断言只有在能注入不一致的值时才可被验证）。
 */
export interface SyncRuntimeConfigOverrides {
  /** 时间源；缺省 `systemClock`。 */
  readonly clock?: Clock;
  /** 随机源；缺省 `cryptoRandomSource`。 */
  readonly random?: RandomSource;
  /** 容量档案；缺省 `DEFAULT_SYNC_CAPACITY`。 */
  readonly capacity?: SyncCapacityProfile;
  /** 清理宽限期；**无默认值**，必须显式给出（`store/types.ts` 的装配契约）。 */
  readonly lifecycle?: StoreLifecycleOptions;
  readonly quota?: Partial<SyncRuntimeQuotaConfig>;
  readonly merge?: Partial<SyncRuntimeMergeConfig>;
  readonly control?: Partial<SyncRuntimeControlConfig>;
  readonly deadlines?: Partial<SyncRuntimeDeadlines>;
  /** 运行态轮换的驻留上限与事务数上限；缺省取交接期限与单 Doc 事务上限。 */
  readonly rotation?: { readonly maxResidentMs?: number; readonly maxTransactions?: number };
  readonly spoolRootDir?: string;
}

/** 校验与装配失败的统一出口：message 只含字段路径与数值（无正文、无凭据），可直接进启动日志。 */
function reject(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `sync runtime config rejected: ${message}` });
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject(`${field} must be a positive integer, received ${String(value)}`);
  }
}

/** 等值断言：两侧数值同时给出，启动期一次就能定位是哪一侧配错了。 */
function assertEqual(actual: number, expected: number, field: string, expectedField: string): void {
  if (actual !== expected) {
    reject(`${field} ${actual} !== ${expectedField} ${expected}`);
  }
}

/**
 * 公平权重映射：profile 的三类权重对应 quota 的三类正文任务，控制类取 `CONTROL_FAIRNESS_WEIGHT`。
 * 逐类显式列出（不用展开语法），新增任务类时编译期即暴露漏配。
 */
function deriveFairness(weights: FairnessWeights): Record<TaskClass, number> {
  return {
    control: CONTROL_FAIRNESS_WEIGHT,
    realtime: weights.live,
    "history-current": weights.currentHistory,
    "history-background": weights.backgroundHistory,
  };
}

/** 运行态 Doc 上限直接取 capacity 的「运行态」行：与 `live/runtime-doc.ts` 的冻结值同源，不另抄一份。 */
function deriveRuntimeLimits(inputs: InputLimits): RuntimeDocLimits {
  return {
    maxLivePayloadBytes: inputs.runtimeLivePayloadBytes,
    maxEntities: inputs.runtimeMaxEntities,
    maxEntityMetadataBytes: inputs.runtimeEntityMaxBytes,
    softRotateBytes: inputs.runtimeSoftSnapshotBytes,
    hardLimitBytes: inputs.runtimeHardSnapshotBytes,
  };
}

/**
 * 由 profile 的既有常量派生完整配置；只允许覆盖 `SyncRuntimeConfigOverrides` 列出的字段。
 *
 * `lifecycle` 缺省时抛 `ADMISSION_REJECTED`：宽限期没有可派生的常量，静默补一个默认值等于把回收时机
 * 变成实现细节（`store/types.ts` 明确禁止 adapter 内置默认值，装配层同样不得代劳）。
 */
export function resolveSyncRuntimeConfig(overrides?: SyncRuntimeConfigOverrides): SyncRuntimeConfig {
  const clock = overrides?.clock ?? systemClock;
  const random = overrides?.random ?? cryptoRandomSource;
  const capacity = overrides?.capacity ?? DEFAULT_SYNC_CAPACITY;
  const lifecycle = overrides?.lifecycle;
  if (lifecycle === undefined) {
    reject("lifecycle is required: sealGraceMs / retireGraceMs have no default");
  }
  const limits = deriveRuntimeLimits(capacity.inputs);
  const concurrency = capacity.concurrency;
  return {
    capacity,
    lifecycle,
    quota: {
      maxOutstandingBytes: concurrency.connectionBodyWindowBytes,
      socketHighWatermark: concurrency.socketHighWatermarkBytes,
      fairness: deriveFairness(capacity.fairness.weights),
      // dirty 上限取驻留文档数（128）：两者都是「单个客户端能同时跟住多少对象」的口径。
      maxDirtyDocs: capacity.client.maxResidentDocs,
      ...overrides?.quota,
    },
    merge: {
      maxDelayMs: capacity.inputs.liveMergeMaxMs,
      maxBytes: capacity.inputs.liveMergeMaxBytes,
      ...overrides?.merge,
    },
    limits,
    rotation: {
      clock,
      random,
      limits,
      // 轮换本质是一次新旧交接，驻留上限沿用交接期限（30s）：避免出现两个无法比较的「多久算久」。
      maxResidentMs: overrides?.rotation?.maxResidentMs ?? concurrency.handoffDeadlineMs,
      maxTransactions: overrides?.rotation?.maxTransactions ?? capacity.inputs.maxTransactionsPerDoc,
    },
    control: {
      framesPerSecond: concurrency.controlFramesPerSecond,
      windowBytes: concurrency.controlWindowPerConnectionBytes,
      ...overrides?.control,
    },
    deadlines: { ackMs: concurrency.ackDeadlineMs, ...overrides?.deadlines },
    spool: {
      rootDir: overrides?.spoolRootDir ?? DEFAULT_SPOOL_ROOT_DIR,
      segmentBytes: concurrency.loadSpoolSegmentBytes,
      taskQuotaBytes: concurrency.loadSpoolTaskBytes,
      processQuotaBytes: concurrency.loadSpoolProcessBytes,
    },
  };
}

/**
 * 装配期自洽校验（设计 §10；侦察 §4.3）。失败抛 `ADMISSION_REJECTED`，消息只含字段名与数值。
 *
 * 最关键的一条是额度窗口与容量档案的连接窗口**等值**：两侧各自只断言「窗口 ≤ socket 水位」，
 * 若装配时 quota 窗口大于 capacity 窗口，容量档案的预检与本层额度会给出两套「还能发多少」的答案，
 * 而没有任何断言会失败（侦察 §4.3）。校验只在这里做一次，运行时不复查。
 */
export function validateSyncRuntimeConfig(config: SyncRuntimeConfig): void {
  // 容量档案是其余等值断言的比较基准，先校验它：否则下面报出的「不相等」可能只是档案本身损坏。
  validateCapacityProfile(config.capacity);

  const concurrency = config.capacity.concurrency;
  const quota = config.quota;
  assertEqual(
    quota.maxOutstandingBytes,
    concurrency.connectionBodyWindowBytes,
    "quota.maxOutstandingBytes",
    "capacity.concurrency.connectionBodyWindowBytes",
  );
  assertEqual(
    quota.socketHighWatermark,
    concurrency.socketHighWatermarkBytes,
    "quota.socketHighWatermark",
    "capacity.concurrency.socketHighWatermarkBytes",
  );
  for (const taskClass of TASK_CLASS_ORDER) {
    assertPositiveInteger(quota.fairness[taskClass], `quota.fairness.${taskClass}`);
  }
  assertPositiveInteger(quota.maxDirtyDocs, "quota.maxDirtyDocs");

  assertPositiveInteger(config.lifecycle.sealGraceMs, "lifecycle.sealGraceMs");
  assertPositiveInteger(config.lifecycle.retireGraceMs, "lifecycle.retireGraceMs");

  assertPositiveInteger(config.merge.maxDelayMs, "merge.maxDelayMs");
  assertPositiveInteger(config.merge.maxBytes, "merge.maxBytes");

  const control = config.control;
  assertPositiveInteger(control.framesPerSecond, "control.framesPerSecond");
  assertPositiveInteger(control.windowBytes, "control.windowBytes");
  if (control.windowBytes > concurrency.controlWindowPerConnectionBytes) {
    reject(
      `control.windowBytes ${control.windowBytes} >` +
        ` capacity.concurrency.controlWindowPerConnectionBytes ${concurrency.controlWindowPerConnectionBytes}`,
    );
  }
  assertPositiveInteger(config.deadlines.ackMs, "deadlines.ackMs");

  const spool = config.spool;
  if (spool.rootDir.trim().length === 0) {
    reject(`spool.rootDir must not be blank, received ${JSON.stringify(spool.rootDir)}`);
  }
  assertPositiveInteger(spool.segmentBytes, "spool.segmentBytes");
  assertPositiveInteger(spool.taskQuotaBytes, "spool.taskQuotaBytes");
  assertPositiveInteger(spool.processQuotaBytes, "spool.processQuotaBytes");

  const limits = config.limits;
  assertPositiveInteger(limits.maxLivePayloadBytes, "limits.maxLivePayloadBytes");
  assertPositiveInteger(limits.maxEntities, "limits.maxEntities");
  assertPositiveInteger(limits.maxEntityMetadataBytes, "limits.maxEntityMetadataBytes");
  assertPositiveInteger(limits.softRotateBytes, "limits.softRotateBytes");
  assertPositiveInteger(limits.hardLimitBytes, "limits.hardLimitBytes");

  assertPositiveInteger(config.rotation.maxResidentMs, "rotation.maxResidentMs");
  assertPositiveInteger(config.rotation.maxTransactions, "rotation.maxTransactions");
}
