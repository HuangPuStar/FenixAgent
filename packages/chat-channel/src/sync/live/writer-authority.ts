import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore, WriterLease } from "../store/types";
import { LIVE_WRITER_LEASE_TTL_MS } from "./live-writer-types";

/** 每次安装投影都有独立身份，异步工作只持有当时实际取得的 fencing token。 */
export interface WriterAuthorityToken {
  readonly lease: WriterLease;
  generation: string | null;
}

/** 写权、投影安装与 admission 共用的生命周期门禁。 */
export class WriterAuthority {
  private current: WriterAuthorityToken | null = null;
  private currentLease: WriterLease | null = null;
  private leaseLoss: unknown = null;
  private transition: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: ProjectionStore,
    private readonly failure: () => unknown,
    private readonly stopInput: () => void,
  ) {}

  /** 重建只允许一个在途任务；门禁先于任何异步 Store 边界关闭。 */
  rebuild(task: () => Promise<void>, retainInstalled?: (error: unknown) => boolean): Promise<void> {
    this.assertOpen();
    if (this.transition !== null) return this.transition;
    const previous = this.current;
    const pending = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        // 已确认安装的新投影只在调用方证明回放未写时保留；安装失败仍不能向新输入背书。
        if (
          this.current !== null &&
          !(
            this.current !== previous &&
            this.current.generation !== null &&
            this.currentLease !== null &&
            this.failure() === null &&
            retainInstalled?.(error)
          )
        )
          this.current.generation = null;
        if (this.closed)
          throw new SyncProtocolError("RESOURCE_RETIRED", { message: "live writer is closed", cause: error });
        throw error;
      });
    this.transition = pending;
    this.stopInput();
    void pending.then(
      () => this.finish(pending),
      () => this.finish(pending),
    );
    return pending;
  }

  /** 已取得的租约开始新的投影身份，不能复用旧任务的 authority。 */
  take(lease: WriterLease): WriterAuthorityToken {
    this.assertOpen();
    this.currentLease = lease;
    this.leaseLoss = null;
    this.current = { lease, generation: null };
    return this.current;
  }

  /** 接管真实 Store 租约；关闭后的迟到回执必须释放实际取得的令牌。 */
  async acquire(scopeKey: string, owner: string): Promise<void> {
    const lease = await this.store.acquireWriter(scopeKey, owner, LIVE_WRITER_LEASE_TTL_MS);
    try {
      this.take(lease);
    } catch (error) {
      await this.store.releaseWriter?.(lease);
      throw error;
    }
  }

  /** recover 即使沿用同一租约也要失效旧投影上的异步声明。 */
  replace(): WriterAuthorityToken {
    return this.take(this.lease());
  }

  /** 新输入只能观察已安装的投影。 */
  capture(): WriterAuthorityToken {
    this.assertOpen();
    if (this.transition !== null || this.current?.generation == null || this.currentLease === null) throw this.lost();
    return this.current;
  }

  /** 已接收工作仍绑定原投影；失权由异步队列拒绝，定时器回调不抛同步异常。 */
  captureTask(): WriterAuthorityToken {
    this.assertOpen();
    if (this.current === null) throw this.lost();
    return this.current;
  }

  /** 写任务串行且持有原 authority；恢复前必须把当前队列结清。 */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const token = this.captureTask();
    const run = this.queue.then(() => {
      const error = this.failure();
      if (error !== null) throw error;
      this.assertCurrent(token);
      return task();
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 返回当前已接收队列的结清边界；重建 gate 已阻挡后续新输入。 */
  drain(): Promise<void> {
    return this.queue;
  }

  /** 相同身份才可修改写者状态；清租约本身不允许旧异步回执越过下一次 take。 */
  isCurrent(token: WriterAuthorityToken): boolean {
    return !this.closed && token === this.current;
  }

  /** 仅已完成安装且仍持权的投影能给 claim 的判定结果背书。 */
  isInstalled(token: WriterAuthorityToken): boolean {
    return this.transition === null && token.generation !== null && this.currentLease !== null && this.isCurrent(token);
  }

  /** 在途旧声明可以等待重建落定，再由调用方限定同代次的一次重新判定。 */
  async settled(): Promise<void> {
    await this.transition;
  }

  /** 内部写任务复核捕获身份，不能借用重建后替换的租约。 */
  assertCurrent(token: WriterAuthorityToken): void {
    this.assertIdentity(token);
    if (this.currentLease === null) throw this.leaseLoss ?? this.lost();
  }

  /** 任务投影身份与租约有效性分别校验，旧任务不能借用替换后的 authority。 */
  assertIdentity(token: WriterAuthorityToken): void {
    this.assertOpen();
    if (!this.isCurrent(token)) throw this.lost();
  }

  /** 判重在 Store 线性化；其成功不受随后租约过期、关闭或投影替换反向影响。 */
  async confirm(token: WriterAuthorityToken, generation: string): Promise<void> {
    this.assertCurrent(token);
    try {
      await this.store.confirmWriter(token.lease, generation);
    } catch (error) {
      if (
        this.isCurrent(token) &&
        error instanceof SyncProtocolError &&
        (error.code === "LEASE_EXPIRED" || error.code === "WRITER_EPOCH_LOST")
      ) {
        this.currentLease = null;
        this.leaseLoss = error;
      }
      throw error;
    }
  }

  /** 续租输入固定为任务捕获的真实租约，迟到回执不能替换当前 lease。 */
  async renew(token = this.capture()): Promise<WriterLease> {
    this.assertCurrent(token);
    try {
      const lease = await this.store.renewWriter(token.lease, LIVE_WRITER_LEASE_TTL_MS);
      this.assertCurrent(token);
      this.currentLease = lease;
      return lease;
    } catch (error) {
      if (this.isCurrent(token)) {
        this.currentLease = null;
        this.leaseLoss = error;
      }
      throw error;
    }
  }

  /** 清除只属于该任务的写权，旧回执不会清掉 replacement lease。 */
  clear(token = this.current): void {
    if (token === this.current) this.currentLease = null;
  }

  /** 租约读取仅供已捕获 authority 的内部动作使用。 */
  lease(): WriterLease {
    this.assertOpen();
    if (this.currentLease === null) throw this.lost();
    return this.currentLease;
  }

  /** 代次来自已安装投影，任务不能根据外部输入覆盖它。 */
  generation(): string {
    const generation = this.captureTask().generation;
    if (generation === null)
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "live writer has no resolved generation" });
    return generation;
  }

  /** 代次只在全部重建成功后发布。 */
  install(token: WriterAuthorityToken, generation: string): void {
    this.assertCurrent(token);
    token.generation = generation;
  }

  /** 关闭先失效所有 authority，再释放确实持有的 lease。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const lease = this.currentLease;
    this.currentLease = null;
    if (lease !== null) await this.store.releaseWriter?.(lease);
  }

  /** 即使尚未持有 lease，迟到的接管也必须被关闭状态拒绝。 */
  assertOpen(): void {
    if (this.closed) throw new SyncProtocolError("RESOURCE_RETIRED", { message: "live writer is closed" });
  }

  private finish(pending: Promise<void>): void {
    if (this.transition === pending) this.transition = null;
  }

  private lost(): SyncProtocolError {
    return new SyncProtocolError("WRITER_EPOCH_LOST", {
      message: "live writer has no installed write authority",
      retryable: true,
    });
  }
}
