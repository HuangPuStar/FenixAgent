// packages/chat-channel/src/sync/history/build-pool.ts
// 有界历史块构建池（规格 §5.5，设计 §5.2 / §10.5）：提交时预留字节额度，并发与排队都设硬上限。
//
// 已记录的实现偏差（规格 §5.5 要求写入文件头）：
//   本池是进程内异步调度器，不创建 `node:worker_threads`。
//   影响范围：历史构建与主线程共享事件循环（设计 §10.5「主线程只做受限小任务」未完全满足）。
//   移除条件：落地 `worker_threads` executor 后替换，接口不变。
//
// 为什么额度在提交时（而不是真正开始时）预留：额度是内存承诺，排队中的任务同样持有输入、输出与复制开销；
// 若等调度到才预留，队列长度就成了一道没有内存上限的掩体（设计 §5.2 第 1 条）。
// 因此队列同时受 `maxQueued` 与池额度双重约束，队列满时**同步**抛错、不创建 Promise（禁止 20,000 个 Promise）。
//
// 两个提交入口，容量语义完全相同（`maxConcurrent` / `maxQueued` 都是硬上限），差别只在队列满时怎么办：
//   `submit` 同步拒绝（`CAPACITY_EXCEEDED`）——给无法等待的调用方，绝不静默丢弃；
//   `submitAwaitingCapacity` 等到有空位再提交——给必须让提交速率受消费者约束的批量生产者（历史导入的
//   20,000 对象导入有 700+ 块，一次性提交必然撞满 4 格队列；等待的提交不被池接纳，不占额度与队列槽位，
//   也不计入 `drain()` 的等待集合）。
//
// 失败语义（两种拒绝互不混淆）：池内排队容量耗尽 = `CAPACITY_EXCEEDED`；单任务字节数超出池额度 =
// `ADMISSION_REJECTED`（由 `AdmissionController` 裁决，含非正整数）。两者都在建 Promise 之前同步抛出。

import type { AdmissionController, Reservation, ServerPoolName } from "../capacity/admission";
import type { FairnessConfig } from "../capacity/profile";
import type { Clock } from "../clock";
import { SyncProtocolError } from "../protocol/errors";

/** 池调度上限；三者必须自洽，`tasksMax` 是在飞与排队之和（也是本池可创建的 Promise 上限）。 */
export interface BuildPoolConfig {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly tasksMax: number;
}

/**
 * 池运行计数。`failed` 只统计**已开始执行**后失败的任务：提交期被拒的任务没有 Promise，
 * 其失败由 `submit` 的同步抛出表达，混进 `failed` 会让「已接纳任务的失败率」无法计算。
 */
export interface BuildPoolStats {
  running: number;
  queued: number;
  completed: number;
  failed: number;
}

/** 本池唯一的额度来源；换池必须同时改这里与统计口径。 */
const BUILD_POOL_NAME: ServerPoolName = "historyBuild";

/** 一次已接纳任务的结算句柄；泛型由 `submit<T>` 的闭包保留，队列内部按类型无关存放。 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排队中的任务：额度在提交时已持有，`start` 由池在槽位可用时调用且只调用一次。 */
interface QueuedJob {
  readonly enqueuedAtMs: number;
  readonly reservation: Reservation;
  start(): void;
}

/** 队列满的统一出口：message 只含计数与等待时长（无正文、无凭据），可直接进日志。 */
function rejectQueueFull(queued: number, maxQueued: number, running: number, maxConcurrent: number, waitMs: number) {
  throw new SyncProtocolError("CAPACITY_EXCEEDED", {
    message:
      `history build pool: queue full (${queued} of ${maxQueued} queued, ${running} of ${maxConcurrent} running),` +
      ` oldest task waiting ${waitMs}ms`,
  });
}

/** 配置非法按 `ADMISSION_REJECTED` 抛出（与容量配置校验同一口径），使启用期只有一种失败类型。 */
function rejectConfig(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `history build pool config: ${message}` });
}

/**
 * 配置自洽性：`tasksMax` 必须等于 `maxConcurrent + maxQueued`。
 * 不允许两者各自为政——同一字段出现两种口径时，「池里到底能有多少任务」将取决于读代码的人，
 * 而超载行为必须能由配置唯一确定。`maxQueued = 0` 合法（不排队、并发满即拒），
 * 非法值（0 个 worker、负数队列、小数）会让上限名存实亡，一律在构造期拒绝。
 */
function assertBuildPoolConfig(config: BuildPoolConfig): void {
  if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent <= 0) {
    rejectConfig(`maxConcurrent must be a positive integer, received ${String(config.maxConcurrent)}`);
  }
  if (!Number.isInteger(config.maxQueued) || config.maxQueued < 0) {
    rejectConfig(`maxQueued must be a non-negative integer, received ${String(config.maxQueued)}`);
  }
  if (!Number.isInteger(config.tasksMax) || config.tasksMax <= 0) {
    rejectConfig(`tasksMax must be a positive integer, received ${String(config.tasksMax)}`);
  }
  const sum = config.maxConcurrent + config.maxQueued;
  if (sum !== config.tasksMax) {
    rejectConfig(`tasksMax (${config.tasksMax}) must equal maxConcurrent + maxQueued (${sum})`);
  }
}

/** 按 fairness 口径派生默认配置（设计 §10.5：2 个固定构建 worker、总任务上限 6 → 队列 4）。 */
export function deriveBuildPoolConfig(fairness: FairnessConfig): BuildPoolConfig {
  const config: BuildPoolConfig = Object.freeze({
    maxConcurrent: fairness.historyBuilderWorkers,
    maxQueued: fairness.builderTasksMax - fairness.historyBuilderWorkers,
    tasksMax: fairness.builderTasksMax,
  });
  // 派生即校验：配置错误必须在装配期暴露，而不是等到第一个导入任务提交时。
  assertBuildPoolConfig(config);
  return config;
}

/**
 * 有界构建池：`submit` 接纳任务（预留额度 + 排队），`stats` 观察进度，`drain` 等待清空。
 *
 * 池不拥有任务语义：`run` 的失败原样透传给调用方（不包装、不改错误码），池只保证结算与归还一定发生。
 */
export class BlockBuildPool {
  private readonly config: BuildPoolConfig;
  private readonly admission: AdmissionController;
  private readonly clock: Clock;
  /** FIFO 队列：非空即并发已满，槽位一空就按提交顺序填充，避免小任务持续插队饿死后排。 */
  private readonly queue: QueuedJob[] = [];
  private readonly drainWaiters: (() => void)[] = [];
  /** `submitAwaitingCapacity` 的容量等待者；空位一出现就全部唤醒，各自重查后仍无空位的重新排队。 */
  private readonly capacityWaiters: (() => void)[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;

  constructor(config: BuildPoolConfig, admission: AdmissionController, clock: Clock) {
    assertBuildPoolConfig(config);
    // 冻结副本：构造后调用方改写传入对象不得改变调度口径（与 admission 的上限快照同理）。
    this.config = Object.freeze({ ...config });
    this.admission = admission;
    this.clock = clock;
  }

  /** 提交一个构建任务；并发满则排队，队列满同步抛 `CAPACITY_EXCEEDED`（不创建 Promise）。 */
  submit<T>(task: { estimateBytes: number; run: () => Promise<T> }): Promise<T> {
    const hasFreeWorker = this.running < this.config.maxConcurrent;
    if (!hasFreeWorker && this.queue.length >= this.config.maxQueued) {
      rejectQueueFull(
        this.queue.length,
        this.config.maxQueued,
        this.running,
        this.config.maxConcurrent,
        this.oldestQueuedWaitMs(),
      );
    }
    // 队列容量先判、额度后取：队列检查无副作用，队列满的拒绝不应触碰额度账目；
    // `estimateBytes` 的合法性由 admission 统一裁决，失败时池内不留任何状态。
    const reservation = this.admission.reserve(BUILD_POOL_NAME, task.estimateBytes);
    const gate = createDeferred<T>();
    const job: QueuedJob = {
      enqueuedAtMs: this.clock.now(),
      reservation,
      start: (): void => {
        this.runJob(job, task.run, gate);
      },
    };
    this.queue.push(job);
    this.pump();
    return gate.promise;
  }

  /** 池的并发 worker 数：批量生产者据此约束自己的在飞窗口，使提交速率由消费者决定（容量上限不变）。 */
  workerCount(): number {
    return this.config.maxConcurrent;
  }

  /**
   * 可等待的背压提交：队列满（无空闲 worker 且队列已满）时等待空位，而不是拒绝。
   *
   * 等待不改变容量语义——`maxConcurrent` / `maxQueued` 仍是硬上限，池不会因此多跑一个任务，只是把压力
   * 回传给生产者。等不到空位时（例如某个 `run` 永不结算）本方法也永不返回，与 `drain()` 同一口径：
   * 超时是调用方的职责，池不代替它猜测。额度拒绝与 `submit` 一样是显式失败：单任务自身超预算无法靠等待解决。
   */
  async submitAwaitingCapacity<T>(task: { estimateBytes: number; run: () => Promise<T> }): Promise<T> {
    while (!this.hasCapacity()) {
      await this.waitForCapacity();
    }
    // 检查与提交之间没有 await：单线程下这条路径与 `submit` 的队列检查是同一个判据，不会被自己绕过。
    return this.submit(task);
  }

  /** 当前计数快照：返回值是独立对象，调用方改写不影响池内状态。 */
  stats(): BuildPoolStats {
    return { running: this.running, queued: this.queue.length, completed: this.completed, failed: this.failed };
  }

  /**
   * 等待**已接纳**的任务（在飞 + 排队）全部结算；空闲时立即返回。
   *
   * 不冻结池：`drain` 返回后新的 `submit` 正常受理，需要再等一轮就再调一次。
   * 若某个 `run` 永不结算，`drain` 也会一直等待——超时是调用方的职责，池不代替它猜测。
   */
  drain(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private runJob<T>(job: QueuedJob, run: () => Promise<T>, gate: Deferred<T>): void {
    this.running += 1;
    // 同步抛错与异步拒绝在此归一为同一条结算路径：异常不可能绕过额度归还与计数。
    const outcome = (async (): Promise<T> => run())();
    outcome.then(
      (value) => {
        this.finishJob(job, false);
        gate.resolve(value);
      },
      (error: unknown) => {
        this.finishJob(job, true);
        gate.reject(error);
      },
    );
  }

  /** 结算：归还额度、更新计数、填充槽位、必要时唤醒 drain 与容量等待者。 */
  private finishJob(job: QueuedJob, failed: boolean): void {
    this.running -= 1;
    // 先归还额度再通知调用方：调用方的续体里立刻提交下一块时，不应看到自己刚释放的额度仍被占用。
    job.reservation.release();
    if (failed) {
      this.failed += 1;
    } else {
      this.completed += 1;
    }
    this.pump();
    // 唤醒放在 pump 之后：空位可能在 pump 之后才存在，唤醒者各自的 `hasCapacity()` 复查因此看到真实状态。
    this.flushCapacityWaiters();
    // 空闲判定放在 pump 之后：pump 可能已接收排队任务，此时池并不空闲。
    if (this.running === 0 && this.queue.length === 0) {
      this.flushDrainWaiters();
    }
  }

  /** 是否有空位接纳新任务：与 `submit` 的队列检查同一判据，两处不得各写一份。 */
  private hasCapacity(): boolean {
    return this.running < this.config.maxConcurrent || this.queue.length < this.config.maxQueued;
  }

  /** 等待一次容量变化；唤醒是「全部唤醒 + 各自重查」，避免为每个空位维护一对一唤醒链。 */
  private waitForCapacity(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.capacityWaiters.push(resolve);
    });
  }

  private flushCapacityWaiters(): void {
    for (const resolve of this.capacityWaiters.splice(0, this.capacityWaiters.length)) {
      resolve();
    }
  }

  /** 按 FIFO 填充空槽；`start` 会同步增加 `running`，因此循环条件每次重新求值即可收敛。 */
  private pump(): void {
    while (this.running < this.config.maxConcurrent) {
      const job = this.queue.shift();
      if (job === undefined) {
        return;
      }
      job.start();
    }
  }

  private flushDrainWaiters(): void {
    for (const resolve of this.drainWaiters.splice(0, this.drainWaiters.length)) {
      resolve();
    }
  }

  /**
   * 队首任务的等待时长：过载拒绝时最需要知道的是「积压还在不在动」，
   * 它直接对应设计 §10.5 的「任一阶段不得连续 2s 无服务」。时钟回拨时钳到 0：
   * 负的等待时长会被下游当成「刚入队」的证据，反而掩盖真实的停滞。
   */
  private oldestQueuedWaitMs(): number {
    const oldest = this.queue[0];
    if (oldest === undefined) {
      return 0;
    }
    return Math.max(0, this.clock.now() - oldest.enqueuedAtMs);
  }
}
