// packages/chat-channel/src/sync/runtime/scope-runtime.ts
// G 阶段 scope 级编排（规格 §2.2）：把 store / live / provider / history / capacity 组装成一个 scope 的运行时。
//
// 依赖方向（规格 §1.1）：本模块在最上层，可依赖 store/live/provider/history/capacity/protocol，不得依赖 client/。
// 三个共享账目各只有一个实例，且互相接线：`AdmissionController`（构建池与新旧共存额度）、`QuotaController`
// （帧额度）、`AckLedger`（`onRelease` 必须回到**同一个** `QuotaController`，见 ack-ledger.ts:71-73）。
//
// 已知偏差（影响 + 移除条件）：
//   ① `LiveWriterOptions` 不接收 `AdmissionController`/`RotationController`，而 `live-writer.ts` 已达 500 行上限、
//      本阶段不得修改，因此写入层内部的运行态轮换看不到本层预留的共存额度。本层改在写入层登记首块之前按运行态
//      硬限在 `hotDocLive` 预留一次（`rotation.reserveCoexistence`），交接期限到期或 dispose 时释放。
//      影响：额度是装配层的保守预留，不是写入层的事实核查。移除条件 = 写入层增加 admission 注入点。
//   ② 代次入口的首块登记（`live-writer.ts` 头部偏差④）不在本模块：块由历史导入路径提交
//      （`HistoryImportService.finalize` 后目录里已有已封口块），本层不为写入层代造块。
//   ③ 与规格 §2.4 的两处出入：网关不接收额度（窗口的唯一所有者在会话 + 账本，网关对同一帧再记一次会让连接窗口
//      减半，见 `egress.ts` 文件头偏差①），它只做自己的 socket 水位门禁；连接的终止（ACK 超时、搁置超期、版本
//      不符、宿主主动 close）由网关判定并通知本层，本层只做清账——规格 §2.2 第 3 条与 §2.4 对「谁关连接」的表述
//      重叠，按实际不重叠的职责划分落地。
//   ④ 终态收敛的唯一入口是 `convergeClosedConnection()`（由网关的 `onConnectionClosed` 触发，`dispose` 兜底一次）：
//      清账与「停止驱动会话」由同一事实触发，不存在「宿主关了连接而 tick 仍推进游标」或「清了账但会话仍被驱动」。

import { AdmissionController } from "../capacity/admission";
import type { Clock, DigestFn, RandomSource } from "../clock";
import { BlockBuildPool, deriveBuildPoolConfig } from "../history/build-pool";
import { type BuildBlockFn, HistoryImportService } from "../history/import-service";
import { HistorySpool } from "../history/spool";
import { createLiveWriter } from "../live/live-writer";
import { createRotationController, type RotationController } from "../live/rotation";
import { SyncProtocolError } from "../protocol/errors";
import type { SyncScope } from "../protocol/identity";
import { createAckLedger } from "../provider/ack-ledger";
import { createAckTimeoutTracker } from "../provider/ack-timeout";
import { createBasePlanner } from "../provider/base-plan";
import { createControlGovernor } from "../provider/control-governor";
import { createQuotaController } from "../provider/quota";
import { createProviderSession } from "../provider/session";
import { createTailPlanner } from "../provider/tail-plan";
import { MemoryProjectionStore } from "../store/memory-store";
import type { ProjectionStore } from "../store/types";
import { type SyncRuntimeConfig, validateSyncRuntimeConfig } from "./config";
import { createSyncFrameGateway, type SyncFrameGateway, type SyncFrameTransport } from "./egress";
import { createLiveIngress, LIVE_INGRESS_DIAGNOSTIC_LIMIT, type SyncIngressEvent } from "./ingress";

/** 释放时的关闭理由。 */
const DISPOSED_REASON = "scope runtime disposed";

/**
 * 历史导入装配：唯一允许接触 `node:fs` 的入口（经 `history/spool.ts`）。
 *
 * `pool` 缺省时自建一个只服务本导入的构建池（连带自建 `AdmissionController`）；由 `createSyncScopeRuntime`
 * 调用时**必须**传入共享池，否则同一 scope 会出现两份 `historyBuild` 账目，各自都能吃满池上限。
 *
 * `scope` 只用于固定装配形状，不参与目录拼装：`HistoryImportService.begin` 自取 scope 并归一化成存储键，
 * 而把 scope 字段拼进路径会引入越界写入原语（`scopeKey` 只保证不含 `/`，不保证不是 `..`）。
 * 假定 `config` 已通过 `validateSyncRuntimeConfig`（scope runtime 在构造期完成该动作，运行时不复查）。
 */
export function createSyncHistoryImport(input: {
  readonly scope: SyncScope;
  readonly store: ProjectionStore;
  readonly config: SyncRuntimeConfig;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly buildBlock?: BuildBlockFn;
  readonly pool?: BlockBuildPool;
}): HistoryImportService {
  const { config } = input;
  const spool = new HistorySpool(
    {
      basePath: config.spool.rootDir,
      segmentBytes: config.spool.segmentBytes,
      taskQuotaBytes: config.spool.taskQuotaBytes,
      processQuotaBytes: config.spool.processQuotaBytes,
    },
    input.clock,
  );
  const pool =
    input.pool ??
    new BlockBuildPool(
      deriveBuildPoolConfig(config.capacity.fairness),
      new AdmissionController(config.capacity),
      input.clock,
    );
  return new HistoryImportService({
    store: input.store,
    spool,
    pool,
    clock: input.clock,
    digest: input.digest,
    capacity: config.capacity,
    rand: input.random,
    buildBlock: input.buildBlock,
  });
}

/** 连接窗口观测：均为只读快照，不参与任何协议判定。 */
export interface SyncTransportDiagnostics {
  /** 已授予但未归还的字节，即「已发送未 ACK」。 */
  readonly outstandingBytes: number;
  /** 在途发送任务数（一次预留对应一次 ACK / 自结算）。 */
  readonly pendingTasks: number;
  /** ACK 账本中已记录但未结算的投递数。 */
  readonly unackedDeliveries: number;
}

/** 单 scope 运行时（规格 §2.2 冻结契约）：方法名与语义不得改名或增删。 */
export interface SyncScopeRuntime {
  /** 实时入口：把已规范化的 ACP 事件交给写入层（内部经 ingress 分配 ingress 序号）。 */
  acceptIngress(event: SyncIngressEvent): Promise<void>;
  /** 绑定出站传输；同一 scope 只允许一次（重复绑定抛 `ADMISSION_REJECTED`）。 */
  attachTransport(transport: SyncFrameTransport): SyncFrameGateway;
  /** 单条已认证连接上的入站字节（帧解码与派发在网关内）。 */
  onInboundBytes(bytes: Uint8Array): Promise<void>;
  /** 驱动追赶、ACK 超时扫描与预留到期释放；不返回帧（帧由网关直接发）。 */
  tick(): Promise<void>;
  /** 连接窗口快照（观测/测试）；不改变账目。 */
  transportDiagnostics(): SyncTransportDiagnostics;
  /** 历史导入入口（同一实例，供 ACP load 路径调用）。 */
  history: HistoryImportService;
  /** 释放本 scope 全部资源（Doc、定时器、租约、额度）；重复调用无副作用。 */
  dispose(): Promise<void>;
}

/**
 * 组装一个 scope 的运行时（规格 §2.2）。
 *
 * `store` 与 `admission` 缺省自建：`store` 缺省是内存 adapter（本阶段无 PostgreSQL adapter，规格 §0.3 第 2 条），
 * `admission` 必须由编排者持有，否则构建池与共存预留会各持一份账目。装配是同步的，`Promise` 返回值保留给
 * 需要异步初始化（连接池、迁移检查）的存储 adapter。
 */
export async function createSyncScopeRuntime(input: {
  readonly scope: SyncScope;
  readonly config: SyncRuntimeConfig;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly store?: ProjectionStore;
  readonly admission?: AdmissionController;
}): Promise<SyncScopeRuntime> {
  const { scope, config, clock, digest, random } = input;
  // 启用前的一次性校验（设计 §10.1）：自相矛盾的档案若不在装配期拦下，会变成请求路径上的帧错误。
  validateSyncRuntimeConfig(config);

  const store =
    input.store ?? new MemoryProjectionStore({ clock, digest, capacity: config.capacity, lifecycle: config.lifecycle });
  const admission = input.admission ?? new AdmissionController(config.capacity);

  // 额度账本与 ACK 账本共用同一个 QuotaController：ACK 归还的字节必须回到当初计费的那本账。
  const quota = createQuotaController({ ...config.quota });
  const ledger = createAckLedger({ onRelease: (taskClass, bytes) => quota.release(taskClass, bytes) });

  const session = createProviderSession({
    store,
    clock,
    digest,
    random,
    capacity: config.capacity,
    quota,
    ledger,
    base: createBasePlanner({ store, digest }),
    // 单批 tail 载荷上限取正文 Doc 的软载荷水位：base64 展开加帧头后仍在数据帧上限内（frames.ts 的 288KiB）。
    tail: createTailPlanner({ store, digest, maxBatchBytes: config.capacity.inputs.activeSoftPayloadBytes }),
  });
  const control = createControlGovernor({
    clock,
    framesPerSecond: config.control.framesPerSecond,
    windowBytes: config.control.windowBytes,
  });
  const timeouts = createAckTimeoutTracker({ clock, ackDeadlineMs: config.deadlines.ackMs });

  const writer = createLiveWriter({
    scope,
    store,
    clock,
    digest,
    random,
    capacity: config.capacity,
    merge: config.merge,
    limits: config.limits,
    rotation: config.rotation,
  });
  // 入口容量是 pending 预算（在飞 + 排队），不是累计已接收历史：条数沿用单 Doc 记录上限，字节取 live 等待预算。
  // 诊断窗口单独限定为小常量，避免把已接收事件以第二份全量数组留在内存里。
  const ingress = createLiveIngress({
    writer,
    maxRecords: config.capacity.inputs.maxRecordsPerDoc,
    maxBytes: config.capacity.concurrency.liveWaitPerScopeBytes,
    diagnosticLimit: LIVE_INGRESS_DIAGNOSTIC_LIMIT,
  });
  /** 共存额度账目：预留的持有方是轮换控制器，释放路径见 `releaseCoexistence`。 */
  const rotation: RotationController = createRotationController(config.rotation);
  const pool = new BlockBuildPool(deriveBuildPoolConfig(config.capacity.fairness), admission, clock);
  const history = createSyncHistoryImport({ scope, store, config, clock, digest, random, pool });

  let gateway: SyncFrameGateway | null = null;
  let connectionClosed = false;
  let disposed = false;
  let writerAcquired = false;
  let acquireInFlight: Promise<void> | null = null;
  let coexistenceReservedAtMs: number | null = null;

  function assertLive(): void {
    if (disposed) {
      throw new SyncProtocolError("RESOURCE_RETIRED", { message: "scope runtime is disposed" });
    }
  }

  /**
   * 新旧共存额度：按运行态硬限预留一次（文件头偏差①），交接期限到期或 dispose 时释放。
   * 同尺寸重复调用是幂等的（`reserveCoexistence` 对同一轮换重放同一额度不报错），因此可安全重试。
   */
  function reserveCoexistence(): void {
    if (coexistenceReservedAtMs !== null) return;
    rotation.reserveCoexistence(admission, config.limits.hardLimitBytes);
    coexistenceReservedAtMs = clock.now();
  }

  /** 释放共存预留：`RotationController.reset()` 是它自己的释放路径（预留随之归还 `hotDocLive`）。 */
  function releaseCoexistence(): void {
    if (coexistenceReservedAtMs === null) return;
    coexistenceReservedAtMs = null;
    rotation.reset();
  }

  /**
   * 预留到期释放（规格 §2.2 第 4 条）：交接期限（`concurrency.handoffDeadlineMs`）内没有完成交接的预留
   * 必须归还，否则一次未落地的轮换会永久占住 `hotDocLive` 额度；释放后由下一次写入重新预留。
   */
  function releaseExpiredCoexistence(): void {
    const reservedAt = coexistenceReservedAtMs;
    if (reservedAt === null) return;
    if (clock.now() - reservedAt < config.capacity.concurrency.handoffDeadlineMs) return;
    releaseCoexistence();
  }

  /**
   * 首次写入前取得写权：写入层要求先持有租约，而同 scope 的租约只有一个（历史导入期间写者必须让位，
   * 因此不在装配期抢占）。失败不缓存：租约被占（`SCOPE_BUSY`）可能在下次写入前消失，缓存失败会把瞬态变永久。
   */
  async function ensureWriter(): Promise<void> {
    if (!writerAcquired) {
      acquireInFlight ??= writer.acquire().then(
        () => {
          writerAcquired = true;
        },
        (error: unknown) => {
          acquireInFlight = null;
          throw error;
        },
      );
      await acquireInFlight;
    }
    // 写入层登记首块之前先占住共存额度：额度不足时本次写入直接失败，不进入「先转再报错」的路径。
    // 刻意放在取写权之外：预留被交接期限释放过（见 `releaseExpiredCoexistence`）后，要靠下一次写入重新占住，
    // 挂在 acquire 回调里会在写权已持有后永远跳过这一步。同尺寸重放是幂等的，写权路径上重复调用无副作用。
    reserveCoexistence();
  }

  /**
   * 连接终止的唯一收敛点（设计 §8.5、规格 §2.2 第 3 条）：先停产出，再清账——账本必须先于额度清空，否则残留
   * 条目在结清时会对已清零的额度归还字节而抛错（`session.ts` 的 `closeSession` 是同一顺序）。
   *
   * 触发者只有 `gateway` 的 `onConnectionClosed`：ACK 超时、搁置超期、协议不兼容与宿主主动关闭走同一条路径，
   * 因此不存在「清了账但会话仍被驱动」或反之。幂等：`connectionClosed` 一旦置位，后续调用与连接级别的重复关闭
   * 都不再重复清账（重复 `ledger.reset` 本身无害，但重复归还额度会凭空造出额度）。
   *
   * 投递登记与额度、账本同属这条连接的传输状态：连接终止后它的条目再无结算机会，留着只会让「已发送未回执」
   * 在观测里永久停在一个死连接的数字上（`dispose` 路径同此口径）。
   */
  function convergeClosedConnection(): void {
    if (connectionClosed) return;
    connectionClosed = true;
    session.close();
    ledger.reset();
    quota.reset();
    timeouts.reset();
  }

  return {
    async acceptIngress(event: SyncIngressEvent): Promise<void> {
      assertLive();
      await ensureWriter();
      await ingress.accept(event);
    },

    attachTransport(transport: SyncFrameTransport): SyncFrameGateway {
      assertLive();
      if (gateway !== null) {
        throw new SyncProtocolError("ADMISSION_REJECTED", {
          message: "a transport is already attached to this scope runtime",
        });
      }
      gateway = createSyncFrameGateway({
        scope,
        session,
        transport,
        clock,
        config,
        // 刻意不传额度：连接窗口的唯一所有者在会话 + 账本（`egress.ts` 文件头偏差①），网关只做 socket 水位门禁。
        control,
        timeouts,
        // 搁置位被顶替的数据帧：窗口字节必须由账本所有者自结算归还（规格 §2.4），否则一次瞬时饱和会永久吃掉额度。
        onDeliveryAbandoned: (deliveryId) => session.abandonDelivery(deliveryId),
        // 刻意不传 onProtocolMismatch：版本不符也是「连接进入终态」的一种，收敛只需下面这一个通知（避免两条回调
        // 各做一半：原先只有它改标记、无人清账）。宿主要记录客户端版本时可自行在网关装配处接该钩子。
        // 连接进入终态的唯一通知：任何关闭原因（ACK 超时、搁置超期、版本不符、宿主主动 close）都在这里清账一次。
        onConnectionClosed: () => convergeClosedConnection(),
      });
      return gateway;
    },

    async onInboundBytes(bytes: Uint8Array): Promise<void> {
      assertLive();
      const bound = gateway;
      if (bound === null) {
        throw new SyncProtocolError("BINDING_UNKNOWN", {
          message: "no transport is bound to this scope runtime",
        });
      }
      await bound.onInboundBytes(bytes);
    },

    async tick(): Promise<void> {
      assertLive();
      const bound = gateway;
      // 未绑定传输或连接已终止时不得推进会话：产出的帧无处投递，而会话会按「已发出」推进游标。
      // 连接是否终止只读 `connectionClosed`——它由网关的关闭通知置位，宿主主动 `close` 与网关自关走同一条路径。
      if (bound !== null && !connectionClosed) {
        // 搁置帧先重试：它比本次会话新产出的帧更早，先补缺口再发新帧，客户端看到的序号才连续。
        // 该调用可能在搁置超期时终止连接（随后 `connectionClosed` 置位），因此会话驱动要再判一次。
        bound.driveWithheld();
        if (!connectionClosed) {
          for (const frame of await session.tick()) bound.sendOutbound(frame);
          bound.scanTimeouts();
        }
      }
      releaseExpiredCoexistence();
    },

    transportDiagnostics(): SyncTransportDiagnostics {
      const snapshot = quota.snapshot();
      return {
        outstandingBytes: snapshot.outstandingBytes,
        pendingTasks: snapshot.pendingTasks,
        unackedDeliveries: ledger.outstandingCount(),
      };
    },

    history,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // 顺序：先停输入，再归账目，最后关写入层——反过来会让已释放的账目收到在途写入的计费请求。
      ingress.reset();
      releaseCoexistence();
      // 关连接会经 `onConnectionClosed` 触发清账；未绑定传输时没有该通知，故下面再调一次（幂等）。
      gateway?.close(DISPOSED_REASON);
      convergeClosedConnection();
      await writer.close();
    },
  };
}
