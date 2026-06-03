/**
 * 基于 JSON-RPC ID 的请求/响应关联。
 *
 * 每个 pending 请求通过 JSON-RPC `id` 唯一标识。
 * 支持超时、重连后重传、永久断开时 reject all。
 */
// biome-ignore lint/suspicious/noExplicitAny: generic pending requires erased types
interface PendingEntry<T = any> {
  // biome-ignore lint/suspicious/noExplicitAny: request shape is determined by caller
  request: any;
  // biome-ignore lint/suspicious/noExplicitAny: resolve value type varies by request
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<T>;
}

export class ACPPending {
  // biome-ignore lint/suspicious/noExplicitAny: pending map stores heterogeneously typed entries
  private pending = new Map<number | string, PendingEntry<any>>();

  /**
   * 注册 pending 请求。
   * 如果同 id 已有 pending，返回已有 promise（去重）。
   */
  register<TResponse>(
    id: number | string,
    // biome-ignore lint/suspicious/noExplicitAny: request shape is determined by caller
    request: any,
    timeout: number,
  ): Promise<TResponse> {
    const existing = this.pending.get(id);
    if (existing) {
      return existing.promise as Promise<TResponse>;
    }

    // biome-ignore lint/suspicious/noExplicitAny: resolve callback must accept generic response type
    let resolveFn!: (value: any) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<TResponse>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.reject(new Error(`JSON-RPC request timed out: id=${id}`));
      }
    }, timeout);

    this.pending.set(id, {
      request,
      resolve: resolveFn,
      reject: rejectFn,
      timer,
      promise,
    });

    return promise;
  }

  /**
   * 用 JSON-RPC 响应的 id 匹配 pending 请求。
   * 返回 true 表示匹配成功（已 resolve）。
   */
  // biome-ignore lint/suspicious/noExplicitAny: response payload type varies by request
  tryResolve(id: number | string, result: any): boolean {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(result);
      return true;
    }
    return false;
  }

  /**
   * 重连后重新发送所有未完成的 pending 请求。
   * 返回所有 pending 的请求数据，供调用方重新发送。
   */
  getPendingRequests(): Array<{ id: number | string; request: unknown }> {
    return [...this.pending.entries()].map(([id, entry]) => ({ id, request: entry.request }));
  }

  /**
   * 拒绝所有 pending（用于永久断开）。
   */
  rejectAll(error: Error): void {
    for (const [_key, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 是否有任何 pending 操作 */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}
