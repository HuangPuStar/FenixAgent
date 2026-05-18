/**
 * DAG 执行取消管理器。
 *
 * 提供 AbortSignal 共享机制，所有节点执行时监听同一信号。
 * 支持优雅关闭：cancel() 后给 RUNNING 节点一段宽限期完成清理。
 */

export class CancellationManager {
  private abortController: AbortController;
  private readonly gracePeriodMs: number;

  constructor(gracePeriodMs = 10000) {
    this.abortController = new AbortController();
    this.gracePeriodMs = gracePeriodMs;
  }

  /** 获取共享的 AbortSignal，所有节点执行时监听此信号 */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** DAG 是否已被取消 */
  get cancelled(): boolean {
    return this.abortController.signal.aborted;
  }

  /** 请求取消 — 停止调度新节点，向所有 RUNNING 节点发送 abort */
  cancel(): void {
    this.abortController.abort();
  }

  /** 等待 grace period 后返回（SIGKILL 兜底由 executor 处理） */
  waitForGracePeriod(): Promise<void> {
    if (this.cancelled) {
      return new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));
    }
    return Promise.resolve();
  }
}
