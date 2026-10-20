// packages/chat-channel/src/sync/capacity/profile.ts
// 同步容量预算（设计 §10 / 规格 §3.5）：单进程 512MiB 的初始验收 profile 与启用前校验。
//
// 数值是冻结契约：设计 §10 允许在保留评审记录后调参，但不允许在一次验收中降低负载以宣称达标，
// 因此这里逐字落地表格中的字节数，不做 `256 * 1024 * 1024` 之类的换算——评审时要能与表格逐行对照。
// 所有池都是「最坏预留」：真实峰值还受解码放大、CRDT 结构与 GC 副本影响，预留不足按验收失败处理。
// 校验必须发生在启用前（设计 §10.1）：缺配置或自相矛盾的配置若不在装配期拦下，要么在请求路径上抛错，
// 要么更糟——某个池参与的比较因为 NaN 恒为 false，从而静默放行一切。

import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";

/** 单进程同步资源预留总量（设计 §10.1）：512MiB。不等于全应用 RSS 上限，运行时与其他业务另计。 */
export const SERVER_TOTAL_BYTES = 536870912;

/**
 * 冻结一张预算表并抹掉字面量类型：设计 §10 允许带评审记录调参，字段类型因此必须是 `number`，
 * 否则 `Object.freeze` 保留的字面量类型会让任何调整后的 profile 都通不过类型检查。
 */
function freezeBudgetTable<T extends Record<string, number>>(table: T): Readonly<{ [K in keyof T]: number }> {
  return Object.freeze(table);
}

/** 服务端子池上限（设计 §10.1 表格）；键名即池的身份，`ServerPoolName` 取自本对象的键。 */
export const SERVER_POOL_BYTES = freezeBudgetTable({
  /** 大帧解析 128MiB：同时最多 1 个 >1MiB 对象（raw、UTF-16 解码、JSON 节点与有限输出）。 */
  frameParse: 134217728,
  /** 常规入口/暂存队列 64MiB：raw 小帧、解码后对象、文件写入在途与队列。 */
  ingressSpool: 67108864,
  /** 历史构建 64MiB：两个 worker 的输入、Y.Doc、编码产物及 postMessage 副本。 */
  historyBuild: 67108864,
  /** 热 Doc/live 未提交 64MiB：各 scope 当前 Doc、运行态交接、live 输入与未决批次。 */
  hotDocLive: 67108864,
  /** 持久化/封口 32MiB：SQL 参数与 driver 副本、重试原字节、在途事务。 */
  persistSeal: 33554432,
  /** 传输/快照缓存 96MiB：由 `TRANSPORT_SUBPOOL_BYTES` 三分，合计必须等于本值。 */
  transportCache: 100663296,
  /** 控制/索引/代际交接 32MiB：控制帧、有限查询页、旧/新入口交接、任务元数据。 */
  controlIndex: 33554432,
  /** 不可借用安全余量 32MiB：已接纳任务的瞬时编码与释放延迟，不得据此扩大接纳窗口。 */
  safetyReserve: 33554432,
});

/** 服务端子池上限表。 */
export type ServerPoolBytes = typeof SERVER_POOL_BYTES;

/**
 * 传输子池上限（设计 §10.1「传输/快照缓存」行）：outstanding 账本与发送任务、socket 拷贝预留、
 * 共享 snapshot 缓存各 32MiB，合计等于 `SERVER_POOL_BYTES.transportCache`。
 */
export const TRANSPORT_SUBPOOL_BYTES = freezeBudgetTable({
  outstandingLedger: 33554432,
  socketCopy: 33554432,
  sharedSnapshotCache: 33554432,
});

/** 传输子池上限表。 */
export type TransportSubpoolBytes = typeof TRANSPORT_SUBPOOL_BYTES;

/**
 * 输入与数据单元上限（设计 §10.2）。注释按设计表格的「项目」分组，不逐字段重复解释。
 * 字节上限挡不住 `[` × 1e6 这类结构炸弹，所以深度、节点、记录与事务数量上限必须同时存在。
 */
export const INPUT_LIMITS = freezeBudgetTable({
  // 原始 ACP 帧与 JSON 复杂度：越界立即失败连接，不进入业务解析。
  maxRawAcpFrameBytes: 16777216,
  jsonMaxDepth: 64,
  jsonMaxNodes: 65536,
  // 大帧解析：>1MiB 交由固定解析 worker，源必须先拿到 raw 缓冲额度，不能在 SDK 内部无限排队。
  largeFrameThresholdBytes: 1048576,
  // 历史构建块：目标载荷 128KiB，编码 snapshot 硬限由数据帧上限反推。
  historyBlockTargetPayloadBytes: 131072,
  historyBlockHardBytes: MAX_DOC_SNAPSHOT_BYTES,
  // 正文记录：扁平头 ≤4KiB、载荷片段 ≤16KiB，每 Doc 的记录与事务数上限。
  recordHeaderMaxBytes: 4096,
  payloadChunkMaxBytes: 16384,
  maxRecordsPerDoc: 2048,
  maxTransactionsPerDoc: 2048,
  // 实时合并：首增量后最长 33ms 或 16KiB，控制屏障提前提交；超时不代表可无限累积。
  liveMergeMaxMs: 33,
  liveMergeMaxBytes: 16384,
  // active 正文：软水位按载荷计，硬限按 snapshot/update 编码后字节计。
  activeSoftPayloadBytes: 131072,
  activeHardEncodedBytes: MAX_DOC_SNAPSHOT_BYTES,
  // 运行态：存活元数据总和、实体数、单实体大小、快照水位与轮换次数。
  runtimeLivePayloadBytes: 65536,
  runtimeMaxEntities: 256,
  runtimeEntityMaxBytes: 1024,
  runtimeSoftSnapshotBytes: 131072,
  runtimeHardSnapshotBytes: MAX_DOC_SNAPSHOT_BYTES,
  runtimeRotationsPerScope: 1,
  // 控制 Doc：固定入口 8KiB、soft 32KiB / hard 64KiB，大参数不进入控制 Doc。
  controlEntryBytes: 8192,
  controlSoftBytes: 32768,
  controlHardBytes: 65536,
  // 目录页：soft 128KiB / hard 由数据帧上限反推、最多 2048 引用；定位页 ≤64 项且 ≤32KiB。
  directorySoftBytes: 131072,
  directoryHardBytes: MAX_DOC_SNAPSHOT_BYTES,
  directoryMaxRefs: 2048,
  locatePageMaxItems: 64,
  locatePageMaxBytes: 32768,
  // 最终描述与依赖：descriptor ≤4KiB、直接 dependsOn ≤8 项；客户端同时在飞与校验页各有限额。
  finalDescriptorMaxBytes: 4096,
  dependsOnMax: 8,
  clientInFlightDepsMax: 64,
  clientVerifyPageMax: 64,
});

/** 输入与数据单元上限表。 */
export type InputLimits = typeof INPUT_LIMITS;

/**
 * 并发、磁盘与连接上限（设计 §10.3）。这些上限只决定「能不能接纳」，不保证全部上限可同时占满：
 * 任何接纳都必须先取得对应的池额度。
 */
export const CONCURRENCY_LIMITS = freezeBudgetTable({
  // 连接数：进程 200、单 scope 8、单租户 64，且仍须先取得全局内存额度。
  maxConnections: 200,
  maxConnectionsPerScope: 8,
  maxConnectionsPerTenant: 64,
  // 活跃写入 scope：数量上限，只有资源预留成功才接纳。
  activeWriteScopesPerProcess: 32,
  activeWriteScopesPerTenant: 8,
  // 活跃 load：进程 2、scope 1、租户 1；待启动队列超限即明确忙，未接纳前不调用 ACP。
  activeLoadsPerProcess: 2,
  activeLoadsPerScope: 1,
  activeLoadsPerTenant: 1,
  pendingLoadQueueMax: 16,
  // load 暂存配额：段大小必须小于任务上限，任务上限 × 并发不得超过进程配额；配额含尚未删除的段。
  loadSpoolTaskBytes: 2147483648,
  loadSpoolProcessBytes: 8589934592,
  loadSpoolSegmentBytes: 8388608,
  // live 等待与 sealing：满则失败当前连续性，不伪装已确认。
  liveWaitPerScopeBytes: 4194304,
  sealingBlocksPerScope: 2,
  sealingBlocksPerProcess: 16,
  // SQL 事务：2 个保留 live、1 个保留 history、1 个可借用；超时后先查未知结果再重试。
  sqlTransactionsMax: 4,
  sqlBatchParamBytes: 1048576,
  sqlTimeoutMs: 5000,
  sqlRetriesMax: 2,
  // 连接正文窗口与 socket 水位：窗口不得超过水位，未授予的额度不能提前编码。
  connectionBodyWindowBytes: 524288,
  connectionBodyWindowTasks: 32,
  globalOutstandingBytes: 33554432,
  socketHighWatermarkBytes: 524288,
  globalSocketReserveBytes: 33554432,
  // 控制窗口：32KiB/连接且受全局 32MiB 控制池限制，100 帧/秒。
  controlWindowPerConnectionBytes: 32768,
  controlFramesPerSecond: 100,
  globalControlPoolBytes: 33554432,
  // ACK/任务 deadline：30s 无进展断开该连接；base/引用交接 30s 失败后重订阅。
  ackDeadlineMs: 30000,
  handoffDeadlineMs: 30000,
});

/** 并发、磁盘与连接上限表。 */
export type ConcurrencyLimits = typeof CONCURRENCY_LIMITS;

/**
 * 客户端预算（设计 §10.4）：接收/控制 2MiB、Y.Doc 驻留 32MiB、投影片段 16MiB、
 * 单对象重组/解码 64MiB、索引/依赖/代际交接 8MiB、安全余量 6MiB，合计等于 `totalBytes`。
 * 其余字段是池内约束（队列、驻留文档数、单对象上限、等待与并发），本身不是池，不参与求和。
 */
export const CLIENT_BUDGET = freezeBudgetTable({
  totalBytes: 134217728,
  receiveControlBytes: 2097152,
  yDocResidentBytes: 33554432,
  projectionSegmentsBytes: 16777216,
  singleObjectMaterializeBytes: 67108864,
  indexDepsGenerationBytes: 8388608,
  safetyReserveBytes: 6291456,
  receiveQueueBytes: 1048576,
  receiveQueueTasks: 64,
  maxResidentDocs: 128,
  singleMaterializeContentBytes: 16777216,
  materializeWaitMaxMs: 30000,
  concurrentRangeRequests: 8,
  rangeRequestMaxBytes: 1048576,
  projectionLruBytes: 16777216,
  applySliceTargetMs: 4,
});

/** 客户端预算表。 */
export type ClientBudget = typeof CLIENT_BUDGET;

/** 公平权重（设计 §10.5）：实时 / 当前历史 / 后台历史按字节的 deficit round robin 配比。 */
export interface FairnessWeights {
  readonly live: number;
  readonly currentHistory: number;
  readonly backgroundHistory: number;
}

/**
 * 公平与进展配置（设计 §10.5）。本组含嵌套权重对象，无法走 `freezeBudgetTable` 的抹类型路径，
 * 故直接声明接口并从常量标注类型。
 */
export interface FairnessConfig {
  readonly historyBuilderWorkers: number;
  readonly builderTasksMax: number;
  readonly weights: FairnessWeights;
  readonly quantumBytes: number;
  readonly minServiceMs: number;
  readonly backgroundAggregateBytesPerSecond: number;
  readonly perImportPersistBytesPerSecond: number;
}

/**
 * 公平与进展配置：权重不替代池上限；`minServiceMs` 是任一阶段连续无服务的上限，用来判定饥饿。
 */
export const FAIRNESS_CONFIG: FairnessConfig = Object.freeze({
  historyBuilderWorkers: 2,
  builderTasksMax: 6,
  weights: Object.freeze({ live: 8, currentHistory: 3, backgroundHistory: 1 }),
  quantumBytes: 16384,
  minServiceMs: 2000,
  backgroundAggregateBytesPerSecond: 262144,
  perImportPersistBytesPerSecond: 1048576,
});

/** 同步容量 profile：启用前的唯一容量输入（设计 §10）。 */
export interface SyncCapacityProfile {
  readonly serverPools: ServerPoolBytes;
  readonly transportSubpools: TransportSubpoolBytes;
  readonly inputs: InputLimits;
  readonly concurrency: ConcurrencyLimits;
  readonly client: ClientBudget;
  readonly fairness: FairnessConfig;
}

/** 设计 §10 的初始验收 profile。冻结对象：调参必须带评审记录下发新版本，不得原地改写。 */
export const DEFAULT_SYNC_CAPACITY: SyncCapacityProfile = Object.freeze({
  serverPools: SERVER_POOL_BYTES,
  transportSubpools: TRANSPORT_SUBPOOL_BYTES,
  inputs: INPUT_LIMITS,
  concurrency: CONCURRENCY_LIMITS,
  client: CLIENT_BUDGET,
  fairness: FAIRNESS_CONFIG,
});

/** 扁平头绝对上限（设计 §10.2「正文记录」行）：协议不变量，不作为可调参项放宽。 */
const RECORD_HEADER_ABSOLUTE_MAX_BYTES = 4096;

/**
 * 参与 `client.totalBytes` 求和的六个池（设计 §10.4）。
 * `CLIENT_BUDGET` 的其余字段是池内约束，不是池本身，重复计入会让求和校验失去意义。
 */
const CLIENT_POOL_FIELDS = [
  "receiveControlBytes",
  "yDocResidentBytes",
  "projectionSegmentsBytes",
  "singleObjectMaterializeBytes",
  "indexDepsGenerationBytes",
  "safetyReserveBytes",
] as const;

/** 校验失败统一出口：message 必须直接指认不成立的项与两侧数值，便于启动期一次性定位配置错误。 */
function rejectCapacity(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `capacity profile rejected: ${message}` });
}

/** 对象节点判定：配置经注入或 JSON 到达时，分组本身也可能缺失或被写成标量。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 形状与非正整数校验（§3.5 第 8 项）：以默认 profile 为**模板**逐路径走查。
 *
 * 用模板而不是遍历实际值：只扫实际值会放过被删掉的键（缺配置同样必须拒绝启用，设计 §10.1），
 * 而缺键在后续求和里只会表现为更难定位的差额或 NaN。模板以外的多余键不参与任何池核算，故不拦截。
 */
function assertProfileShape(node: unknown, template: unknown, path: string): void {
  if (typeof template === "number") {
    if (typeof node !== "number" || !Number.isInteger(node) || node <= 0) {
      rejectCapacity(`${path} must be a positive integer, received ${String(node)}`);
    }
    return;
  }
  if (!isRecord(template)) {
    // 默认 profile 里不存在这种节点；出现即常量本身损坏，属于开发者错误，必须立刻暴露。
    rejectCapacity(`${path} has an unsupported template node`);
  }
  if (!isRecord(node)) {
    rejectCapacity(`${path} is missing or not an object`);
  }
  for (const [key, childTemplate] of Object.entries(template)) {
    if (!(key in node)) {
      rejectCapacity(`${path}.${key} is missing`);
    }
    assertProfileShape(node[key], childTemplate, `${path}.${key}`);
  }
}

/** 校验一组池的和恰好等于给定上限；不一致意味着超卖，或某个池没有被计入。 */
function assertSumEquals(label: string, values: readonly number[], expectedLabel: string, expected: number): void {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total !== expected) {
    rejectCapacity(`${label} sum ${total} !== ${expectedLabel} ${expected}`);
  }
}

/** 校验严格小于：相等时没有留给文件系统元数据等不可控开销的余量。 */
function assertStrictlyLess(label: string, value: number, limitLabel: string, limit: number): void {
  if (value >= limit) {
    rejectCapacity(`${label} ${value} must be < ${limitLabel} ${limit}`);
  }
}

/** 校验需求放得进所属池；失败消息同时给出实际占用与池名，便于区分「配置矛盾」与「池本身太小」。 */
function assertFitsCapacity(label: string, demand: number, limitLabel: string, capacity: number): void {
  if (demand > capacity) {
    rejectCapacity(`${label} = ${demand} > ${limitLabel} ${capacity}`);
  }
}

/**
 * 启用前校验（设计 §10.1「容量 profile 启用前校验所有子池、工作槽和最大任务能放入所属池，缺配置拒绝启用」）。
 *
 * 参数声明为 `unknown` 是有意的：本函数是配置的运行时边界（配置来自注入对象或外部文件），
 * 8 条检查里本就包含「缺项」与「非正整数」两类形状问题，把参数收窄成接口只会诱使调用方用类型断言
 * 绕过检查。内部唯一的断言出现在形状走查之后——走查已证明每个模板路径都是正整数叶子。
 *
 * 失败一律抛 `ADMISSION_REJECTED`，不覆盖 `retryable`：该码在错误码表里的默认语义是瞬态拒绝
 * （见 errors.ts 的注释），启用期失败由调用方按启动错误终止进程，不会作为帧错误发给客户端。
 *
 * 返回 `void` 而非 `asserts profile is SyncCapacityProfile`：本仓库的 tsc-rs 尚未实现断言收窄，
 * 写成断言语义只会退化成一个不生效的签名。装配方持有的是 `SyncCapacityProfile` 类型的已校验配置，
 * 校验只在这里做一次，运行时不再复查。
 */
export function validateCapacityProfile(profile: unknown): void {
  assertProfileShape(profile, DEFAULT_SYNC_CAPACITY, "profile");

  // 形状已由走查证明，此处断言仅用于消除 `unknown`，不重复做第二遍检查。
  const { serverPools, transportSubpools, inputs, concurrency, client } = profile as SyncCapacityProfile;

  // 1. 子池之和必须恰好等于总预留：少了会让「最坏预留之和 ≤ 512MiB」的验收前提失效，多了是超卖。
  assertSumEquals("server pool", Object.values(serverPools), "SERVER_TOTAL_BYTES", SERVER_TOTAL_BYTES);

  // 2. 传输子池是 transportCache 的三分；合计不符会让三类发送占用互相借额度，冲破本池上限。
  assertSumEquals(
    "transport subpool",
    Object.values(transportSubpools),
    "serverPools.transportCache",
    serverPools.transportCache,
  );

  // 3. 暂存配额自洽：单段必须严格小于单任务；任务上限 × 并发不得超过进程配额。
  assertStrictlyLess(
    "concurrency.loadSpoolSegmentBytes",
    concurrency.loadSpoolSegmentBytes,
    "loadSpoolTaskBytes",
    concurrency.loadSpoolTaskBytes,
  );
  assertFitsCapacity(
    "concurrency.loadSpoolTaskBytes × activeLoadsPerProcess",
    concurrency.loadSpoolTaskBytes * concurrency.activeLoadsPerProcess,
    "concurrency.loadSpoolProcessBytes",
    concurrency.loadSpoolProcessBytes,
  );

  // 4. 单个构建任务最坏占用必须放进历史构建池：硬限 ×2 是同一块数据在解析输入与编码/传回
  //    （postMessage 副本）两侧各留一份，再加载荷目标；放不下等于构建阶段必然越预算。
  assertFitsCapacity(
    "inputs.historyBlockHardBytes × 2 + historyBlockTargetPayloadBytes",
    inputs.historyBlockHardBytes * 2 + inputs.historyBlockTargetPayloadBytes,
    "serverPools.historyBuild",
    serverPools.historyBuild,
  );

  // 5. 数据单元自洽：目标载荷不得超过硬限；扁平头不得超过协议不变量 4KiB。
  assertFitsCapacity(
    "inputs.historyBlockTargetPayloadBytes",
    inputs.historyBlockTargetPayloadBytes,
    "inputs.historyBlockHardBytes",
    inputs.historyBlockHardBytes,
  );
  assertFitsCapacity(
    "inputs.recordHeaderMaxBytes",
    inputs.recordHeaderMaxBytes,
    "RECORD_HEADER_ABSOLUTE_MAX_BYTES",
    RECORD_HEADER_ABSOLUTE_MAX_BYTES,
  );

  // 能提交的 Doc 必须能由空客户端以单帧完整重建，禁止各层独立扩大硬限。
  for (const field of [
    "historyBlockHardBytes",
    "activeHardEncodedBytes",
    "runtimeHardSnapshotBytes",
    "directoryHardBytes",
    "controlHardBytes",
  ] as const) {
    assertFitsCapacity(`inputs.${field}`, inputs[field], "MAX_DOC_SNAPSHOT_BYTES", MAX_DOC_SNAPSHOT_BYTES);
  }

  // 6. 客户端各池之和必须等于客户端总预算（池的构成见 CLIENT_BUDGET 的注释）。
  assertSumEquals(
    "client pool",
    CLIENT_POOL_FIELDS.map((field) => client[field]),
    "client.totalBytes",
    client.totalBytes,
  );

  // 7. 发送侧自洽：正文窗口不得超过 socket 水位（否则会出现已授予却发不出的额度）；
  //    全局 outstanding 不得超过全局 socket 预留（否则预留本身即可顶穿水位）。
  assertFitsCapacity(
    "concurrency.connectionBodyWindowBytes",
    concurrency.connectionBodyWindowBytes,
    "concurrency.socketHighWatermarkBytes",
    concurrency.socketHighWatermarkBytes,
  );
  assertFitsCapacity(
    "concurrency.globalOutstandingBytes",
    concurrency.globalOutstandingBytes,
    "concurrency.globalSocketReserveBytes",
    concurrency.globalSocketReserveBytes,
  );
}
