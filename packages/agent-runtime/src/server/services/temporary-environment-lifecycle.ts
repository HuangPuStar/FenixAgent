import { AppError } from "@fenix/platform-sdk";

/** 可用期限的持久化投影，普通环境没有 expiresAt。 */
export interface EnvironmentExpiry {
  readonly id: string;
  readonly expiresAt?: Date | null;
  readonly expiryReclaimedAt?: Date | null;
}
/** 环境期限协调所需的持久化与严格停止操作。 */
export interface TemporaryEnvironmentLifecycleDependencies {
  now?: () => number;
  read(id: string): Promise<EnvironmentExpiry | undefined>;
  writeExpiry(id: string, expiresAt: Date): Promise<void>;
  markReclaimed(id: string, expiresAt: Date, reclaimedAt: Date): Promise<void>;
  stop(id: string): Promise<void>;
}
/** 操作取消句柄；调用方结束时必须释放。 */
export interface EnvironmentOperationLease {
  readonly signal: AbortSignal;
  release(): void;
}

/** 临时环境身份由持久前缀决定，不能通过清空 expiresAt 退化成普通环境。 */
export function isTemporaryEnvironment(id: string): boolean {
  return id.startsWith("temp-");
}
/** 保留身份但拒绝新执行，过期信息仅在调用方授权之后暴露。 */
export function assertEnvironmentAvailable(environment: EnvironmentExpiry, now = Date.now()): void {
  if (isTemporaryEnvironment(environment.id) && (!environment.expiresAt || environment.expiresAt.getTime() <= now)) {
    throw new AppError("Environment has expired; renew it before use", "ENVIRONMENT_EXPIRED", 410);
  }
}

/** 环境级串行协调；锁只覆盖准入和停止，不把整个聊天或启动等待放入锁中。 */
export class TemporaryEnvironmentLifecycle {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, Set<AbortController>>();
  constructor(private readonly deps: TemporaryEnvironmentLifecycleDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 所有准入、期限更新和严格停止使用同一环境锁。 */
  async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.locks.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  /** 仅检查用途相关的期限；归属授权必须先完成。 */
  async assertAvailable(id: string): Promise<void> {
    if (!isTemporaryEnvironment(id)) return;
    const row = await this.deps.read(id);
    if (!row) throw new AppError("Environment not found", "NOT_FOUND", 404);
    assertEnvironmentAvailable(row, this.now());
  }

  /** 在串行准入中登记取消，不缓存持久记录。 */
  async acquire(id: string): Promise<EnvironmentOperationLease> {
    return this.serialize(id, async () => {
      await this.assertAvailable(id);
      const controller = new AbortController();
      const controllers = this.operations.get(id) ?? new Set<AbortController>();
      controllers.add(controller);
      this.operations.set(id, controllers);
      return {
        signal: controller.signal,
        release: () => {
          controllers.delete(controller);
          if (controllers.size === 0 && this.operations.get(id) === controllers) this.operations.delete(id);
        },
      };
    });
  }

  /** 准入后可长时间等待；硬期限仍可取得锁并终止实际 Runtime。 */
  async admit<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!isTemporaryEnvironment(id)) return operation(new AbortController().signal);
    const lease = await this.acquire(id);
    try {
      lease.signal.throwIfAborted();
      return await operation(lease.signal);
    } finally {
      lease.release();
    }
  }

  /** 停止前在锁内重读期限；已删除环境只回收取消登记，停止失败由后续扫描补偿。 */
  async expire(id: string): Promise<Date | undefined> {
    return this.serialize(id, async () => {
      const row = await this.deps.read(id);
      if (!isTemporaryEnvironment(id)) return;
      if (row?.expiresAt && row.expiresAt.getTime() > this.now()) return row.expiresAt;
      const error = new AppError("Environment has expired", "ENVIRONMENT_EXPIRED", 410);
      // 取消登记不依赖 Agent 终态回执；停止失败的补偿仍由期限调度器负责。
      const controllers = [...(this.operations.get(id) ?? [])];
      this.operations.get(id)?.clear();
      this.operations.delete(id);
      for (const controller of controllers) controller.abort(error);
      if (row && !row.expiryReclaimedAt) {
        await this.deps.stop(id);
        if (row.expiresAt) await this.deps.markReclaimed(id, row.expiresAt, new Date(this.now()));
      }
    });
  }

  /** 更新期限后启动；启动失败保留期限。旧 stop 完成前续期不会发布新运行意图。 */
  async renew(id: string, ttl: number, activate: () => Promise<void>): Promise<Date> {
    const result = await this.serialize(id, async () => {
      const expiresAt = new Date(this.now() + ttl * 1_000);
      await this.deps.writeExpiry(id, expiresAt);
      return { expiresAt, activation: activate() };
    });
    await result.activation;
    return result.expiresAt;
  }
}
