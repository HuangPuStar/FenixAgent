/**
 * ACP request/response 关联机制。
 *
 * 同一 requestType 同时只能有一个 pending（隐式关联）。
 * 支持超时、重连后续传、永久断开时 reject all。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PendingEntry<T = any> {
  requestType: string;
  responseType: string;
  sendFn: (request: any) => void;
  request: any;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<T>;
}

export class ACPPending {
  private pending = new Map<string, PendingEntry<any>>();

  /**
   * 注册 pending 请求并立即发送。
   * 如果同 requestType 已有 pending，返回已有 promise（去重）。
   */
  sendAndWait<TResponse>(
    sendFn: (request: any) => void,
    requestType: string,
    request: any,
    responseType: string,
    timeout: number,
  ): Promise<TResponse> {
    // 去重：已有同类型 pending 则复用
    const existing = this.pending.get(requestType);
    if (existing) {
      return existing.promise as Promise<TResponse>;
    }

    let resolveFn!: (value: any) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<TResponse>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timer = setTimeout(() => {
      const entry = this.pending.get(requestType);
      if (entry) {
        this.pending.delete(requestType);
        entry.reject(new Error(`${requestType} timed out`));
      }
    }, timeout);

    sendFn(request);

    this.pending.set(requestType, {
      requestType,
      responseType,
      sendFn,
      request,
      resolve: resolveFn,
      reject: rejectFn,
      timer,
      promise,
    });

    return promise;
  }

  /**
   * 尝试用响应匹配 pending 请求。
   * 返回 true 表示匹配成功（已 resolve）。
   */
  tryResolve(responseType: string, payload: any): boolean {
    for (const [key, entry] of this.pending) {
      if (entry.responseType === responseType) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.resolve(payload);
        return true;
      }
    }
    return false;
  }

  /**
   * 重连后重新发送所有未完成的 pending 请求。
   */
  resendAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      try {
        entry.sendFn(entry.request);
      } catch (err) {
        this.pending.delete(entry.requestType);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * 拒绝所有 pending（用于永久断开）。
   */
  rejectAll(error: Error): void {
    for (const [key, entry] of this.pending) {
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
