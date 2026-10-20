import { describe, expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import {
  CLIENT_BUDGET,
  CONCURRENCY_LIMITS,
  DEFAULT_SYNC_CAPACITY,
  FAIRNESS_CONFIG,
  INPUT_LIMITS,
  SERVER_POOL_BYTES,
  SERVER_TOTAL_BYTES,
  type SyncCapacityProfile,
  TRANSPORT_SUBPOOL_BYTES,
  validateCapacityProfile,
} from "../sync/capacity/profile";
import { SyncProtocolError } from "../sync/protocol/errors";

/** 捕获容量层错误：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
function captureCapacityError(run: () => unknown): SyncProtocolError {
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

/** 断言校验或接纳被拒：统一核对错误码，并确认 message 指认了具体不成立的项。 */
function expectCapacityRejection(run: () => unknown, expectedFragment: string): SyncProtocolError {
  const error = captureCapacityError(run);
  expect(error.code).toBe("ADMISSION_REJECTED");
  expect(error.message).toContain(expectedFragment);
  return error;
}

describe("默认容量 profile", () => {
  // 默认 profile 是启用前唯一门禁：它必须自洽，否则任何接线都会在启动期直接失败。
  test("默认 profile 通过启用前校验", () => {
    expect(() => validateCapacityProfile(DEFAULT_SYNC_CAPACITY)).not.toThrow();
  });

  // 服务端子池与传输子池的字节数是评审冻结的验收基线，用字面量锁定，调参必须伴随评审记录。
  test("服务端子池与传输子池数值逐字落地（设计 §10.1）", () => {
    expect(SERVER_TOTAL_BYTES).toBe(536870912);
    expect(SERVER_POOL_BYTES).toEqual({
      frameParse: 134217728,
      ingressSpool: 67108864,
      historyBuild: 67108864,
      hotDocLive: 67108864,
      persistSeal: 33554432,
      transportCache: 100663296,
      controlIndex: 33554432,
      safetyReserve: 33554432,
    });
    expect(TRANSPORT_SUBPOOL_BYTES).toEqual({
      outstandingLedger: 33554432,
      socketCopy: 33554432,
      sharedSnapshotCache: 33554432,
    });
  });

  // 输入上限决定了解析复杂度与单单元内存放大，数值漂移会直接改变协议可接受的输入面。
  test("输入与数据单元上限数值逐字落地（设计 §10.2）", () => {
    expect(INPUT_LIMITS).toEqual({
      maxRawAcpFrameBytes: 16777216,
      jsonMaxDepth: 64,
      jsonMaxNodes: 65536,
      largeFrameThresholdBytes: 1048576,
      historyBlockTargetPayloadBytes: 131072,
      historyBlockHardBytes: 218100,
      recordHeaderMaxBytes: 4096,
      payloadChunkMaxBytes: 16384,
      maxRecordsPerDoc: 2048,
      maxTransactionsPerDoc: 2048,
      liveMergeMaxMs: 33,
      liveMergeMaxBytes: 16384,
      activeSoftPayloadBytes: 131072,
      activeHardEncodedBytes: 218100,
      runtimeLivePayloadBytes: 65536,
      runtimeMaxEntities: 256,
      runtimeEntityMaxBytes: 1024,
      runtimeSoftSnapshotBytes: 131072,
      runtimeHardSnapshotBytes: 218100,
      runtimeRotationsPerScope: 1,
      controlEntryBytes: 8192,
      controlSoftBytes: 32768,
      controlHardBytes: 65536,
      directorySoftBytes: 131072,
      directoryHardBytes: 218100,
      directoryMaxRefs: 2048,
      locatePageMaxItems: 64,
      locatePageMaxBytes: 32768,
      finalDescriptorMaxBytes: 4096,
      dependsOnMax: 8,
      clientInFlightDepsMax: 64,
      clientVerifyPageMax: 64,
    });
  });

  // 并发与磁盘上限决定接纳面与暂存配额，任一数值被改小都会改变过载行为，必须逐字锁定。
  test("并发、磁盘与连接上限数值逐字落地（设计 §10.3）", () => {
    expect(CONCURRENCY_LIMITS).toEqual({
      maxConnections: 200,
      maxConnectionsPerScope: 8,
      maxConnectionsPerTenant: 64,
      activeWriteScopesPerProcess: 32,
      activeWriteScopesPerTenant: 8,
      activeLoadsPerProcess: 2,
      activeLoadsPerScope: 1,
      activeLoadsPerTenant: 1,
      pendingLoadQueueMax: 16,
      loadSpoolTaskBytes: 2147483648,
      loadSpoolProcessBytes: 8589934592,
      loadSpoolSegmentBytes: 8388608,
      liveWaitPerScopeBytes: 4194304,
      sealingBlocksPerScope: 2,
      sealingBlocksPerProcess: 16,
      sqlTransactionsMax: 4,
      sqlBatchParamBytes: 1048576,
      sqlTimeoutMs: 5000,
      sqlRetriesMax: 2,
      connectionBodyWindowBytes: 524288,
      connectionBodyWindowTasks: 32,
      globalOutstandingBytes: 33554432,
      socketHighWatermarkBytes: 524288,
      globalSocketReserveBytes: 33554432,
      controlWindowPerConnectionBytes: 32768,
      controlFramesPerSecond: 100,
      globalControlPoolBytes: 33554432,
      ackDeadlineMs: 30000,
      handoffDeadlineMs: 30000,
    });
  });

  // 客户端预算与公平权重同属验收基线：权重配比与客户端池之和都会影响慢端与后台任务的进展判定。
  test("客户端预算与公平配置数值逐字落地（设计 §10.4 / §10.5）", () => {
    expect(CLIENT_BUDGET).toEqual({
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
    expect(FAIRNESS_CONFIG).toEqual({
      historyBuilderWorkers: 2,
      builderTasksMax: 6,
      weights: { live: 8, currentHistory: 3, backgroundHistory: 1 },
      quantumBytes: 16384,
      minServiceMs: 2000,
      backgroundAggregateBytesPerSecond: 262144,
      perImportPersistBytesPerSecond: 1048576,
    });
  });

  // 默认值是全局共享常量，运行期改写会让不同装配拿到不同口径，因此必须冻结。
  test("默认 profile 及其分组均被冻结", () => {
    expect(Object.isFrozen(DEFAULT_SYNC_CAPACITY)).toBe(true);
    expect(Object.isFrozen(SERVER_POOL_BYTES)).toBe(true);
    expect(Object.isFrozen(FAIRNESS_CONFIG.weights)).toBe(true);
    expect(Reflect.set(DEFAULT_SYNC_CAPACITY, "serverPools", {})).toBe(false);
    expect(Reflect.set(SERVER_POOL_BYTES, "frameParse", 1)).toBe(false);
    expect(SERVER_POOL_BYTES.frameParse).toBe(134217728);
  });
});

describe("容量校验拒绝", () => {
  // 自洽性校验必须判断「profile 内部关系」，而不是「等于默认值」，否则调参后的合法配置会被误杀。
  test("调整后仍自洽的 profile 可以通过校验", () => {
    const profile = {
      ...DEFAULT_SYNC_CAPACITY,
      serverPools: { ...SERVER_POOL_BYTES, frameParse: 167772160, transportCache: 67108864 },
      transportSubpools: { outstandingLedger: 25165824, socketCopy: 25165824, sharedSnapshotCache: 16777216 },
    };
    expect(() => validateCapacityProfile(profile)).not.toThrow();
  });

  // 子池之和是 512MiB 验收前提：多出 1 字节即为超卖，必须拒绝启用。
  test("子池之和与总预留不一致时拒绝", () => {
    const serverPools = { ...SERVER_POOL_BYTES, frameParse: SERVER_POOL_BYTES.frameParse + 1 };
    const error = expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, serverPools }),
      "server pool sum",
    );
    expect(error.message).toContain("SERVER_TOTAL_BYTES");
  });

  // 传输子池合计不符会让 outstanding、socket 拷贝与快照缓存互相借额度，冲破 transportCache 上限。
  test("传输子池之和与 transportCache 不一致时拒绝", () => {
    const transportSubpools = { ...TRANSPORT_SUBPOOL_BYTES, socketCopy: TRANSPORT_SUBPOOL_BYTES.socketCopy + 1 };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, transportSubpools }),
      "transport subpool sum",
    );
  });

  // 客户端各池之和必须等于客户端总预算，否则客户端会在超预算状态下接收投影。
  test("客户端各池之和与总预算不一致时拒绝", () => {
    const client = { ...CLIENT_BUDGET, projectionSegmentsBytes: CLIENT_BUDGET.projectionSegmentsBytes - 1 };
    expectCapacityRejection(() => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, client }), "client pool sum");
  });

  // 单段不小于单任务时，一次写段就会顶到任务配额，没有留给文件系统开销的余量。
  test("暂存单段大于等于单任务时拒绝", () => {
    const concurrency = { ...CONCURRENCY_LIMITS, loadSpoolSegmentBytes: CONCURRENCY_LIMITS.loadSpoolTaskBytes };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, concurrency }),
      "loadSpoolSegmentBytes",
    );
  });

  // 任务上限乘并发不得超过进程配额，否则并发起来的两个 load 必然突破磁盘预算。
  test("暂存任务上限乘并发超过进程配额时拒绝", () => {
    const concurrency = {
      ...CONCURRENCY_LIMITS,
      loadSpoolProcessBytes: CONCURRENCY_LIMITS.loadSpoolTaskBytes * CONCURRENCY_LIMITS.activeLoadsPerProcess - 1,
    };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, concurrency }),
      "loadSpoolProcessBytes",
    );
  });

  // 单个构建任务最坏占用（硬限 ×2 + 目标载荷）放不进 historyBuild 时，构建阶段必然越预算。
  test("构建任务最坏占用装不进历史构建池时拒绝", () => {
    const historyBuild = INPUT_LIMITS.historyBlockHardBytes * 2 + INPUT_LIMITS.historyBlockTargetPayloadBytes - 1;
    const serverPools = {
      ...SERVER_POOL_BYTES,
      historyBuild,
      // 差额补给安全余量，保持子池总和不变，确保命中的是第 4 项而不是「和不等」。
      safetyReserve: SERVER_POOL_BYTES.safetyReserve + (SERVER_POOL_BYTES.historyBuild - historyBuild),
    };
    expectCapacityRejection(() => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, serverPools }), "historyBuild");
  });

  // 目标载荷超过硬限时，构建器的「目标」在物理上就不可达，必须在启用前暴露。
  test("历史块目标载荷超过硬限时拒绝", () => {
    const inputs = { ...INPUT_LIMITS, historyBlockTargetPayloadBytes: INPUT_LIMITS.historyBlockHardBytes + 1 };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, inputs }),
      "historyBlockTargetPayloadBytes",
    );
  });

  // 扁平头 4KiB 是协议不变量而非可调项：放宽它等于改了数据单元契约。
  test("正文扁平头超过 4KiB 协议不变量时拒绝", () => {
    const inputs = { ...INPUT_LIMITS, recordHeaderMaxBytes: 8192 };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, inputs }),
      "recordHeaderMaxBytes",
    );
  });

  // 正文窗口高于 socket 水位会先授予再发不出，把连接拖成长期未完成发送。
  test("连接正文窗口超过 socket 水位时拒绝", () => {
    const concurrency = {
      ...CONCURRENCY_LIMITS,
      connectionBodyWindowBytes: CONCURRENCY_LIMITS.socketHighWatermarkBytes + 1,
    };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, concurrency }),
      "connectionBodyWindowBytes",
    );
  });

  // 全局 outstanding 超过全局 socket 预留时，预留本身即可顶穿水位。
  test("全局 outstanding 超过全局 socket 预留时拒绝", () => {
    const concurrency = {
      ...CONCURRENCY_LIMITS,
      globalOutstandingBytes: CONCURRENCY_LIMITS.globalSocketReserveBytes + 1,
    };
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, concurrency }),
      "globalOutstandingBytes",
    );
  });

  // 0、负数与小数都不是合法预算：它们会让上限比较失去意义，必须在启用前逐项拦下。
  test("任一数值不是正整数时拒绝", () => {
    for (const invalid of [0, -64, 1.5]) {
      const inputs = { ...INPUT_LIMITS, jsonMaxDepth: invalid };
      expectCapacityRejection(() => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, inputs }), "jsonMaxDepth");
    }
    const profile = { ...DEFAULT_SYNC_CAPACITY, inputs: { ...INPUT_LIMITS, jsonMaxDepth: 0 } };
    expectCapacityRejection(() => validateCapacityProfile(profile), "positive integer");
  });

  // 缺配置同样必须拒绝启用：形状走查要以默认 profile 为模板报出缺键路径，而不是让求和静默算错。
  test("缺失配置键时拒绝", () => {
    const partialConcurrency = Object.fromEntries(
      Object.entries(CONCURRENCY_LIMITS).filter(([key]) => key !== "sqlTimeoutMs"),
    );
    const error = expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, concurrency: partialConcurrency }),
      ".sqlTimeoutMs",
    );
    expect(error.message).toContain("is missing");
  });

  // 分组缺失或被写成标量时无法进行任何算术比较，必须在入口直接指出路径。
  test("分组缺失或不是对象时拒绝", () => {
    expectCapacityRejection(() => validateCapacityProfile(undefined), "profile is missing");
    expectCapacityRejection(
      () => validateCapacityProfile({ ...DEFAULT_SYNC_CAPACITY, fairness: "frozen" }),
      "profile.fairness",
    );
  });
});

describe("池额度预留", () => {
  // 预留只记入对应池：池间不得互相影响，且 used + available 恒等于池上限。
  test("预留记入对应池并保持守恒", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const limit = SERVER_POOL_BYTES.frameParse;
    expect(controller.used("frameParse")).toBe(0);
    expect(controller.available("frameParse")).toBe(limit);

    const reservation = controller.reserve("frameParse", 4096);
    expect(reservation.pool).toBe("frameParse");
    expect(reservation.bytes).toBe(4096);
    expect(controller.used("frameParse")).toBe(4096);
    expect(controller.available("frameParse")).toBe(limit - 4096);
    expect(controller.used("historyBuild")).toBe(0);

    reservation.release();
    expect(controller.used("frameParse")).toBe(0);
    expect(controller.available("frameParse")).toBe(limit);
  });

  // 同一池的多笔预留各自独立归还，前一笔释放不得影响后一笔。
  test("同一池的多笔预留独立核算", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const first = controller.reserve("hotDocLive", 1024);
    const second = controller.reserve("hotDocLive", 2048);
    expect(controller.used("hotDocLive")).toBe(3072);

    first.release();
    expect(controller.used("hotDocLive")).toBe(2048);
    second.release();
    expect(controller.used("hotDocLive")).toBe(0);
  });

  // 池满即拒绝、不排队不预扣：拒绝路径不得留下任何已计提用量，边界值必须恰好可用。
  test("预留超限立即拒绝且不改变账目", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const limit = SERVER_POOL_BYTES.persistSeal;
    const held = controller.reserve("persistSeal", limit - 1);
    const exact = controller.reserve("persistSeal", 1);
    expect(controller.available("persistSeal")).toBe(0);

    expectCapacityRejection(() => controller.reserve("persistSeal", 1), "persistSeal");
    expect(controller.used("persistSeal")).toBe(limit);

    exact.release();
    held.release();
    expect(controller.used("persistSeal")).toBe(0);
    expect(controller.available("persistSeal")).toBe(limit);
  });

  // release 幂等：重复释放不得重复归还额度，否则 used 会变负并放大可用额度。
  test("释放幂等且重复释放不会让已用额度变负", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const reservation = controller.reserve("transportCache", 8192);
    expect(controller.used("transportCache")).toBe(8192);

    reservation.release();
    expect(controller.used("transportCache")).toBe(0);
    reservation.release();
    reservation.release();
    expect(controller.used("transportCache")).toBe(0);
    expect(controller.available("transportCache")).toBe(SERVER_POOL_BYTES.transportCache);
  });

  // 交接成功时额度整体迁移：旧池归零、新池按新额度计费，不会出现两份占用。
  test("交接成功后旧池归还、新池计费", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const from = controller.reserve("frameParse", 8192);
    const next = controller.handoff(from, "historyBuild", 4096);

    expect(next.pool).toBe("historyBuild");
    expect(next.bytes).toBe(4096);
    expect(controller.used("frameParse")).toBe(0);
    expect(controller.used("historyBuild")).toBe(4096);

    next.release();
    expect(controller.used("historyBuild")).toBe(0);
  });

  // 交接失败必须保留原预留：先释放再取新额度会让失败路径把旧额度也丢掉，账面上凭空消失。
  test("交接目标池已满时保留原预留", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const from = controller.reserve("frameParse", 16384);
    const blocker = controller.reserve("controlIndex", SERVER_POOL_BYTES.controlIndex);

    expectCapacityRejection(() => controller.handoff(from, "controlIndex", 1), "controlIndex");
    expect(controller.used("frameParse")).toBe(16384);
    expect(controller.used("controlIndex")).toBe(SERVER_POOL_BYTES.controlIndex);

    // 失败后原预留依旧有效，仍可正常释放。
    from.release();
    expect(controller.used("frameParse")).toBe(0);
    blocker.release();
  });

  // 已释放的预留不能再次交接，也不能拿别的控制器的预留交接，否则会凭空造出额度并记错账本。
  test("已释放或非本控制器的预留不能交接", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const from = controller.reserve("frameParse", 4096);
    const next = controller.handoff(from, "historyBuild", 2048);

    expectCapacityRejection(() => controller.handoff(from, "historyBuild", 2048), "reservation");

    const other = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const foreign = other.reserve("frameParse", 4096);
    expectCapacityRejection(() => controller.handoff(foreign, "historyBuild", 2048), "reservation");
    expect(other.used("frameParse")).toBe(4096);

    next.release();
    foreign.release();
  });

  // 同池交接等价于改额度：先加后减，旧预留的重复释放不得再次归还。
  test("同一池内交接等价于调整额度", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const from = controller.reserve("frameParse", 4096);
    const next = controller.handoff(from, "frameParse", 2048);

    expect(controller.used("frameParse")).toBe(2048);
    from.release();
    expect(controller.used("frameParse")).toBe(2048);

    next.release();
    expect(controller.used("frameParse")).toBe(0);
  });

  // 非法额度是调用方缺陷：立即失败且不得进入账目，NaN 尤其会让所有上限比较静默失效。
  test("拒绝非正整数额度且不改账目", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    for (const invalid of [0, -1024, 1.5, Number.NaN]) {
      expectCapacityRejection(() => controller.reserve("frameParse", invalid), "positive integer");
    }
    expect(controller.used("frameParse")).toBe(0);
  });

  // 未知名只能在运行期经配置或 JSON 到达；不拦截会让 used 变成 NaN 并让接纳判定全部失效。
  test("拒绝未知池名", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const unknownPool: string = "bogusPool";
    expectCapacityRejection(() => controller.reserve(unknownPool as ServerPoolName, 1), "bogusPool");
    expectCapacityRejection(() => controller.used(unknownPool as ServerPoolName), "bogusPool");
  });

  // 构造时快照池上限：调用方构造后继续改写配置对象，不得让已计提账目的口径改变。
  test("构造后改写传入 profile 不影响已建控制器的上限", () => {
    const mutablePools: Record<ServerPoolName, number> = { ...SERVER_POOL_BYTES };
    const draft: SyncCapacityProfile = { ...DEFAULT_SYNC_CAPACITY, serverPools: mutablePools };
    const controller = new AdmissionController(draft);

    mutablePools.frameParse = 1;
    expect(controller.available("frameParse")).toBe(SERVER_POOL_BYTES.frameParse);
  });
});
