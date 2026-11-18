// T08–T12 验收的真实 Store 装配、已提交观测与指定调用故障注入。
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import type { Clock } from "../sync/clock";
import { sha256Digest } from "../sync/clock";
import type { DocKind } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  CommitGenerationInput,
  CommitGenerationResult,
  CreateDocInput,
  CreateGenerationInput,
  DirectoryPage,
  DirectoryQuery,
  DocStateSnapshot,
  ProjectionStore,
  PutSealedInput,
  PutSealedResult,
  RefQuery,
  RegisterSuccessorInput,
  RegistrationResult,
  RetireResult,
  RetireTarget,
  SealDocInput,
  SealDocResult,
  SyncGenerationRecord,
  SyncRefRecord,
  SyncScopeRow,
  SyncSuccessorState,
  SyncUpdateRecord,
  WriterLease,
} from "../sync/store/types";

// ------------------------------------------------------------------ 常量与时钟

/** 清理宽限期：与验收无关，取一个不会被推进到的值（推进它意味着代次字节被回收）。 */
export const PLANES_LIFECYCLE = { sealGraceMs: 600_000, retireGraceMs: 600_000 } as const;
/** 引导租约期限：夹具用完即让时钟越过它，把写权让给被测运行时或导入服务。 */
export const BOOTSTRAP_TTL_MS = 5_000;
/** 真实实现的写者租约期限（`LIVE_WRITER_LEASE_TTL_MS`）：用例据它构造租约过期。 */
export const WRITER_LEASE_TTL_MS = 30_000;
/** 默认 ACK 期限（`capacity.concurrency.ackDeadlineMs`）。 */
export const ACK_DEADLINE_MS = 30_000;
/** 内容槽位：实时正文。 */
export const TEXT_SLOT = "text";
/** 夹具默认使用的容量档位（生产默认档，T08/T12 的池上限断言取自它）。 */
export const PLANE_CAPACITY: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY;

/**
 * 单个 tail 帧的字节上界（base64 展开 + 帧头预算）。
 *
 * 这是夹具必须满足的不变量：**连接窗口 > 单帧上界**，否则 `emit` 的 `outstanding + 帧字节 ≤ 窗口`
 * 永远不成立，该帧永远发不出去而会话反复重试（T09/T10 的窗口类用例全部失效）。生产档位
 * （512KiB 窗口 / 128KiB 合并）满足此约束；收紧窗口后仍须计入固定的帧头预算。
 */
export function maxSingleTailFrameBytes(capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY): number {
  const payload = capacity.inputs.activeSoftPayloadBytes;
  // base64 每 3 字节输入产出 4 字节；帧头/摘要/信封的预算取 4KiB（远大于实际头长度）。
  return Math.ceil(payload / 3) * 4 + 4096;
}

/** 建一个真实内存投影 store（T08 的故障注入以它为底，除注入点外全部调用到达真实实现）。 */
export function createPlaneStore(
  capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
  clock: Clock = new PlaneClock(),
): MemoryProjectionStore {
  return new MemoryProjectionStore({ clock, digest: sha256Digest, capacity, lifecycle: PLANES_LIFECYCLE });
}

/** 可推进的假时钟：租约、ACK 期限、搁置期限、合并窗口都只经它取时。 */
export class PlaneClock implements Clock {
  private current: number;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }
  /** 返回用例控制的时刻，避免墙钟变化影响期限判定。 */
  now(): number {
    return this.current;
  }
  /** 推进租约、回执与合并窗口共用的模拟时钟。 */
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

// ------------------------------------------------------------------ 已提交状态观测

/** `MemoryProjectionStore.exportCommittedState()` 的一行（夹具只搬运事实，不解释语义）。 */
export interface CommittedDocRow {
  readonly docId: string;
  readonly kind: DocKind;
  readonly state: string;
  readonly hash: string;
  readonly blockIndex: number | null;
  readonly ordinalStart: number | null;
  readonly ordinalEnd: number | null;
  readonly finalSeq: number | null;
}

/** 已提交代次与文档事实，供验收夹具查询，不包含未决写入。 */
export interface CommittedStateView {
  readonly generations: { readonly generation: string; readonly state: string; readonly retiredAt: number | null }[];
  readonly docs: CommittedDocRow[];
}

/** 导出已提交状态：内存 store 的专有观测出口（存储端口没有「列出全部行」的原语）。 */
export function committedStateOf(store: ProjectionStore): CommittedStateView {
  const candidate = store as Partial<{ exportCommittedState: () => CommittedStateView }>;
  if (typeof candidate.exportCommittedState !== "function") {
    throw new Error("oracle: store does not expose committed state; use MemoryProjectionStore");
  }
  return candidate.exportCommittedState();
}

// ------------------------------------------------------------------ 容量档位

/**
 * 收紧连接窗口与 tail 合并预算（窗口与 socket 水位必须同值，否则装配期校验直接拒绝）。
 *
 * 合并预算沿用生产档位的窗口 1/4；固定帧头不随之缩小，返回前必须验证完整帧上界严格小于窗口，
 * 否则 tail 永远无法通过 `outstanding + 帧字节 ≤ 窗口` 的发送检查。
 */
export function tightenWindow(
  windowBytes: number,
  base: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
): SyncCapacityProfile {
  const capacity: SyncCapacityProfile = {
    ...base,
    concurrency: {
      ...base.concurrency,
      connectionBodyWindowBytes: windowBytes,
      socketHighWatermarkBytes: windowBytes,
    },
    inputs: { ...base.inputs, activeSoftPayloadBytes: Math.floor(windowBytes / 4) },
  };
  const frameBytes = maxSingleTailFrameBytes(capacity);
  if (windowBytes <= frameBytes) {
    throw new Error(`oracle: connection window ${windowBytes} must exceed single tail frame bound ${frameBytes}`);
  }
  return capacity;
}

// ------------------------------------------------------------------ 故障注入 store（T08）

/** 可注入失败的存储方法（T08 的提交期与 finalize 失败必须落在真实路径上）。 */
export type FaultyStoreMethod = "putSealedIfAbsent" | "commitGeneration" | "appendUpdates" | "createDoc";

/**
 * 逐调用委托给真实存储，只在指定方法第 `afterCalls + 1` 次调用上抛一次错。
 *
 * 这是宿主边界上的故障注入（真实存储的语义、字节与幂等键全部保留），不是「用近似实现冒充存储」：
 * 除被注入的那一次调用外，所有读写都到达真实 `MemoryProjectionStore`。
 */
export class FaultyProjectionStore implements ProjectionStore {
  private calls = 0;
  private fired = false;

  constructor(
    private readonly base: ProjectionStore,
    private readonly fault: { method: FaultyStoreMethod; afterCalls: number; error: Error },
  ) {}

  /** 注入是否已经触发（用例据此确认「失败确实发生在本阶段」）。 */
  didFire(): boolean {
    return this.fired;
  }

  /**
   * 已提交状态观测出口透传：`MemoryProjectionStore` 的专有出口，故障注入不改变读语义
   * （否则夹具在注入 store 上连「已提交了什么」都读不到，只能改用近似实现冒充存储）。
   */
  exportCommittedState(): CommittedStateView {
    return committedStateOf(this.base);
  }

  private maybeFail(method: FaultyStoreMethod): void {
    if (this.fired || method !== this.fault.method) return;
    this.calls += 1;
    if (this.calls > this.fault.afterCalls) {
      this.fired = true;
      throw this.fault.error;
    }
  }
  /** 保留 {@link ProjectionStore.acquireWriter} 的底层契约。 */
  acquireWriter(key: string, owner: string, ttlMs: number): Promise<WriterLease> {
    return this.base.acquireWriter(key, owner, ttlMs);
  }
  /** 保留支持主动释放的底层 Store 的即时写权交接。 */
  releaseWriter(lease: WriterLease): Promise<void> {
    return this.base.releaseWriter?.(lease) ?? Promise.resolve();
  }
  /** 保留 {@link ProjectionStore.renewWriter} 的底层契约。 */
  renewWriter(lease: WriterLease, ttlMs: number): Promise<WriterLease> {
    return this.base.renewWriter(lease, ttlMs);
  }

  /** 保留底层写权与当前代的原子确认边界。 */
  confirmWriter(lease: WriterLease, generation: string): Promise<void> {
    return this.base.confirmWriter(lease, generation);
  }
  /** 保留 {@link ProjectionStore.createGeneration} 的底层契约。 */
  createGeneration(input: CreateGenerationInput): Promise<RegistrationResult> {
    return this.base.createGeneration(input);
  }
  /** 保留 {@link ProjectionStore.createDoc} 的底层契约。 */
  async createDoc(input: CreateDocInput): Promise<RegistrationResult> {
    this.maybeFail("createDoc");
    return this.base.createDoc(input);
  }
  /** 保留 {@link ProjectionStore.registerSuccessor} 的底层契约。 */
  registerSuccessor(input: RegisterSuccessorInput): Promise<RegistrationResult> {
    return this.base.registerSuccessor(input);
  }

  /** 读取底层真实后继状态并保留 scope 隔离。 */
  readSuccessor(scopeKey: string, docId: string): Promise<SyncSuccessorState | null> {
    return this.base.readSuccessor(scopeKey, docId);
  }
  /** 保留 {@link ProjectionStore.appendUpdates} 的底层契约。 */
  async appendUpdates(input: AppendUpdatesInput): Promise<AppendUpdatesResult> {
    this.maybeFail("appendUpdates");
    return this.base.appendUpdates(input);
  }
  /** 保留 {@link ProjectionStore.putSealedIfAbsent} 的底层契约。 */
  async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    this.maybeFail("putSealedIfAbsent");
    return this.base.putSealedIfAbsent(input);
  }
  /** 保留 {@link ProjectionStore.sealDoc} 的底层契约。 */
  sealDoc(input: SealDocInput): Promise<SealDocResult> {
    return this.base.sealDoc(input);
  }
  /** 保留 {@link ProjectionStore.commitGeneration} 的底层契约。 */
  async commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
    this.maybeFail("commitGeneration");
    return this.base.commitGeneration(input);
  }
  /** 保留 {@link ProjectionStore.readDocStateAt} 的底层契约。 */
  readDocStateAt(docId: string, seq: number): Promise<DocStateSnapshot | null> {
    return this.base.readDocStateAt(docId, seq);
  }
  /** 保留 {@link ProjectionStore.readUpdatesAfter} 的底层契约。 */
  readUpdatesAfter(docId: string, seq: number, limit: number): Promise<SyncUpdateRecord[]> {
    return this.base.readUpdatesAfter(docId, seq, limit);
  }
  /** 保留 {@link ProjectionStore.readScopePointer} 的底层契约。 */
  readScopePointer(key: string): Promise<SyncScopeRow | null> {
    return this.base.readScopePointer(key);
  }
  /** 保留 {@link ProjectionStore.readGeneration} 的底层契约。 */
  readGeneration(key: string, generation: string): Promise<SyncGenerationRecord | null> {
    return this.base.readGeneration(key, generation);
  }
  /** 保留 {@link ProjectionStore.readDirectory} 的底层契约。 */
  readDirectory(query: DirectoryQuery): Promise<DirectoryPage> {
    return this.base.readDirectory(query);
  }
  /** 保留 {@link ProjectionStore.locateRefs} 的底层契约。 */
  locateRefs(query: RefQuery): Promise<SyncRefRecord[]> {
    return this.base.locateRefs(query);
  }
  /** 保留 {@link ProjectionStore.retireAndCollect} 的底层契约。 */
  retireAndCollect(key: string, target: RetireTarget): Promise<RetireResult> {
    return this.base.retireAndCollect(key, target);
  }
}
