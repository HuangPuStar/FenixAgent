import { describe, expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, SERVER_POOL_BYTES, type SyncCapacityProfile } from "../sync/capacity/profile";
import type { Clock } from "../sync/clock";
import { BlockBuildPool, type BuildPoolConfig, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { SyncProtocolError } from "../sync/protocol/errors";

/** 可控时钟：排队等待时长断言必须来自注入时钟，用真实时间断言会引入 flake。 */
function createTestClock(startMs = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = startMs;
  return {
    clock: { now: (): number => now },
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** 手动驱动的任务体：并发上限与排队行为只有在任务可被外部挂起时才可断言。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出事件循环：等微任务与已排定的宏任务跑完，用于断言 drain 尚未完成。 */
async function settleEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 捕获同步拒绝：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
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

/** 单任务字节数：额度断言用整数份数与它对齐，便于核对「已用 = 份数 × 单份」。 */
const TASK_BYTES = 1024;

/** 测试池额度（1MiB，远大于单任务）：账目断言只关心份数，不关心默认 64MiB 的量级。 */
const TEST_POOL_BYTES = 1024 * 1024;

/** 测试池：注入可控时钟与真实 AdmissionController，配置默认取 fairness 派生值。 */
function createTestPool(options: { config?: BuildPoolConfig; historyBuildBytes?: number } = {}): {
  pool: BlockBuildPool;
  admission: AdmissionController;
  advanceClock: (ms: number) => void;
} {
  const profile: SyncCapacityProfile = {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...SERVER_POOL_BYTES, historyBuild: options.historyBuildBytes ?? TEST_POOL_BYTES },
  };
  const admission = new AdmissionController(profile);
  const { clock, advance } = createTestClock();
  const config = options.config ?? deriveBuildPoolConfig(DEFAULT_SYNC_CAPACITY.fairness);
  return { pool: new BlockBuildPool(config, admission, clock), admission, advanceClock: advance };
}

/** 提交 count 个由外部驱动结算的任务，用于构造「已满队列」这类确定性状态。 */
function submitGatedTasks(
  pool: BlockBuildPool,
  count: number,
): {
  gates: Deferred<void>[];
  submitted: Promise<void>[];
} {
  const gates = Array.from({ length: count }, () => createDeferred<void>());
  const submitted = gates.map((gate) => pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise }));
  return { gates, submitted };
}

/** 释放全部闸门并等待所有已提交任务结算，避免测试结束时留下在飞任务。 */
async function releaseAll(gates: Deferred<void>[], submitted: Promise<void>[]): Promise<void> {
  for (const gate of gates) {
    gate.resolve();
  }
  await Promise.all(submitted);
}

describe("BlockBuildPool 并发与排队", () => {
  // 并发上限是池存在的理由：同时提交 6 个任务时只允许 2 个在跑，其余排队，绝不超额启动。
  test("同时提交多个任务时运行数不超过 maxConcurrent", async () => {
    const { pool } = createTestPool();
    const gates = Array.from({ length: 6 }, () => createDeferred<void>());
    const observedRunning: number[] = [];
    const submitted = gates.map((gate) =>
      pool.submit({
        estimateBytes: TASK_BYTES,
        run: async (): Promise<void> => {
          observedRunning.push(pool.stats().running);
          await gate.promise;
        },
      }),
    );

    expect(pool.stats()).toEqual({ running: 2, queued: 4, completed: 0, failed: 0 });
    expect(observedRunning).toEqual([1, 2]);

    await releaseAll(gates, submitted);

    expect(Math.max(...observedRunning)).toBe(2);
    expect(observedRunning).toHaveLength(6);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 6, failed: 0 });
  });

  // 排队必须有硬上限：第 7 个任务同步抛错而不是创建第 7 个 Promise，额度也只覆盖已接纳的 6 个。
  test("队列满时同步抛 CAPACITY_EXCEEDED 且不新增额度占用", async () => {
    const { pool, admission } = createTestPool();
    const { gates, submitted } = submitGatedTasks(pool, 6);

    const error = captureSyncError(() => pool.submit({ estimateBytes: TASK_BYTES, run: async () => undefined }));

    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(pool.stats()).toEqual({ running: 2, queued: 4, completed: 0, failed: 0 });
    expect(admission.used("historyBuild")).toBe(6 * TASK_BYTES);

    await releaseAll(gates, submitted);
    expect(pool.stats().completed).toBe(6);
  });

  // 槽位按提交顺序填充（FIFO）：先提交的任务先拿到空出的 worker，避免后续小块持续插队饿死后排。
  test("槽位按提交顺序填充", async () => {
    const { pool } = createTestPool({ config: { maxConcurrent: 1, maxQueued: 2, tasksMax: 3 } });
    const gates = Array.from({ length: 3 }, () => createDeferred<void>());
    const started: string[] = [];
    const submitted = ["a", "b", "c"].map((name, index) =>
      pool.submit({
        estimateBytes: TASK_BYTES,
        run: async (): Promise<void> => {
          started.push(name);
          await gates[index].promise;
        },
      }),
    );

    expect(started).toEqual(["a"]);
    gates[0].resolve();
    await submitted[0];
    expect(started).toEqual(["a", "b"]);
    gates[1].resolve();
    await submitted[1];
    expect(started).toEqual(["a", "b", "c"]);

    gates[2].resolve();
    await Promise.all(submitted);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 3, failed: 0 });
  });
});

describe("BlockBuildPool 额度与结算", () => {
  // 额度在任务进入池时预留、结算时释放：在飞 3 个任务（2 跑 1 排队）必须恰好占用 3 份额度。
  test("每个任务在进入时预留、结束时释放（含排队任务）", async () => {
    const { pool, admission } = createTestPool();
    const gates = Array.from({ length: 3 }, () => createDeferred<void>());
    const submitted = gates.map((gate) => pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise }));

    expect(admission.used("historyBuild")).toBe(3 * TASK_BYTES);
    expect(admission.available("historyBuild")).toBe(TEST_POOL_BYTES - 3 * TASK_BYTES);

    gates[0].resolve();
    await submitted[0];
    expect(pool.stats().running).toBe(2);
    expect(admission.used("historyBuild")).toBe(2 * TASK_BYTES);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(submitted);
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 任务失败是常态路径：额度必须归还到 0，否则一次构建失败会永久吃掉一份构建额度。
  test("任务异步失败时归还额度并计入 failed", async () => {
    const { pool, admission } = createTestPool();
    const failure = pool.submit({
      estimateBytes: TASK_BYTES,
      run: async (): Promise<void> => {
        throw new Error("build failed");
      },
    });

    await expect(failure).rejects.toThrow("build failed");

    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 0, failed: 1 });
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 同步抛错同样走结算路径：否则「进入任务体即校验失败」会永久占用额度且不计入失败。
  test("任务体同步抛错时归还额度并拒绝调用方 Promise", async () => {
    const { pool, admission } = createTestPool();
    const failure = pool.submit({
      estimateBytes: TASK_BYTES,
      run: (): Promise<void> => {
        throw new Error("synchronous failure");
      },
    });

    await expect(failure).rejects.toThrow("synchronous failure");

    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 0, failed: 1 });
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 成功与失败必须分别计数：导入编排用 failed 判定重试，混算会让成功的块被误判为需要重试。
  test("stats 分别累计成功与失败", async () => {
    const { pool, admission } = createTestPool();
    const first = pool.submit({ estimateBytes: TASK_BYTES, run: async () => "first" });
    const second = pool.submit({
      estimateBytes: TASK_BYTES,
      run: async (): Promise<string> => {
        throw new Error("boom");
      },
    });
    const third = pool.submit({ estimateBytes: TASK_BYTES, run: async () => "third" });
    const rejected = expect(second).rejects.toThrow("boom");

    await Promise.all([first, third]);
    await rejected;

    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 2, failed: 1 });
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 单任务字节数超出池额度由 admission 裁决：拒绝发生在建 Promise 之前，槽位与账目都不得变化。
  test("单任务超过池额度时抛 ADMISSION_REJECTED 且不占用槽位", () => {
    const { pool, admission } = createTestPool({ historyBuildBytes: 4096 });

    const error = captureSyncError(() => pool.submit({ estimateBytes: 8192, run: async () => undefined }));

    expect(error.code).toBe("ADMISSION_REJECTED");
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 0, failed: 0 });
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 过载时最需要知道「积压还在不在动」，因此拒绝信息里的等待时长来自注入时钟而非真实时间。
  test("队列满的拒绝信息带出最老任务的等待时长", async () => {
    const { pool, advanceClock } = createTestPool();
    const { gates, submitted } = submitGatedTasks(pool, 6);

    advanceClock(2000);
    const error = captureSyncError(() => pool.submit({ estimateBytes: TASK_BYTES, run: async () => undefined }));

    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("oldest task waiting 2000ms");

    await releaseAll(gates, submitted);
  });
});

describe("BlockBuildPool 生命周期", () => {
  // drain 要等的是「全部已接纳任务」：排队任务也持有额度与输入副本，只等在飞任务会让导入提前收尾。
  test("drain 等待在飞与排队任务全部结算", async () => {
    const { pool } = createTestPool();
    const { gates, submitted } = submitGatedTasks(pool, 4);
    let drained = false;
    const drainPromise = pool.drain().then(() => {
      drained = true;
    });

    await settleEventLoop();
    expect(drained).toBe(false);

    gates[0].resolve();
    gates[1].resolve();
    await settleEventLoop();
    // 空出的两个槽位被排队任务填满，此时池仍非空闲。
    expect(pool.stats().running).toBe(2);
    expect(pool.stats().queued).toBe(0);
    expect(drained).toBe(false);

    gates[2].resolve();
    gates[3].resolve();
    await drainPromise;

    expect(drained).toBe(true);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 4, failed: 0 });
    await Promise.all(submitted);
  });

  // 空闲时 drain 立即完成且不进入「关闭」状态：同一池要能跨多轮导入复用。
  test("drain 在空闲时立即完成且不阻塞后续提交", async () => {
    const { pool } = createTestPool();

    await pool.drain();
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 0, failed: 0 });

    const gate = createDeferred<void>();
    const submitted = pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise });
    const drainPromise = pool.drain();
    gate.resolve();

    await drainPromise;
    await submitted;
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 1, failed: 0 });
  });
});

describe("BlockBuildPool 配置", () => {
  // 规格 §5.5 的默认口径：2 个固定构建 worker、总任务上限 6，队列容量因此是 4。
  test("默认配置由 fairness 派生（2 worker / 6 总任务 / 4 排队）", () => {
    expect(deriveBuildPoolConfig(DEFAULT_SYNC_CAPACITY.fairness)).toEqual({
      maxConcurrent: 2,
      maxQueued: 4,
      tasksMax: 6,
    });
  });

  // 派生配置必须真的落到调度上：7 个任务时前 6 个被接纳（2 跑 4 排），第 7 个被拒。
  test("按派生默认配置建池时第 7 个任务被拒", async () => {
    const { pool } = createTestPool();
    const { gates, submitted } = submitGatedTasks(pool, 6);

    const error = captureSyncError(() => pool.submit({ estimateBytes: TASK_BYTES, run: async () => undefined }));

    expect(error.code).toBe("CAPACITY_EXCEEDED");
    await releaseAll(gates, submitted);
  });

  // tasksMax 必须等于在飞 + 排队之和：同一字段两种口径会让「池里能有多少任务」取决于读代码的人。
  test("配置不自洽时在构造期拒绝", () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const { clock } = createTestClock();

    const error = captureSyncError(
      () => new BlockBuildPool({ maxConcurrent: 2, maxQueued: 3, tasksMax: 6 }, admission, clock),
    );

    expect(error.code).toBe("ADMISSION_REJECTED");
    expect(error.message).toContain("tasksMax");
  });

  // 非法数值会让上限名存实亡（0 个 worker 永不执行、小数上限不可判定），必须在构造期拒绝。
  test("非法数值配置在构造期拒绝", () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const { clock } = createTestClock();
    const invalidConfigs: BuildPoolConfig[] = [
      { maxConcurrent: 0, maxQueued: 6, tasksMax: 6 },
      { maxConcurrent: 2, maxQueued: -1, tasksMax: 1 },
      { maxConcurrent: 1.5, maxQueued: 1, tasksMax: 2.5 },
    ];

    for (const config of invalidConfigs) {
      const error = captureSyncError(() => new BlockBuildPool(config, admission, clock));
      expect(error.code).toBe("ADMISSION_REJECTED");
    }
  });
});
