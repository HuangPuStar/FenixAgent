// packages/chat-channel/src/sync/runtime/ingress-failure-reporter.ts
// live ingress 失败的计数与有界日志：容量/协议错误可能在每个事件上重复出现，
// 逐条 ERROR 会淹没日志；这里按时间窗只输出摘要，计数始终累加供观测。

import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";

export interface IngressFailureDiagnostics {
  readonly total: number;
  readonly lastCode: SyncErrorCode | null;
}

export interface IngressFailureReporter {
  report(error: unknown): void;
  diagnostics(): IngressFailureDiagnostics;
}

/** 默认日志窗口：5s 内同类失败只输出一条摘要。 */
const DEFAULT_LOG_INTERVAL_MS = 5_000;

export function createIngressFailureReporter(input: {
  readonly report: (message: string, error: unknown) => void;
  readonly now: () => number;
  readonly intervalMs?: number;
}): IngressFailureReporter {
  const intervalMs = input.intervalMs ?? DEFAULT_LOG_INTERVAL_MS;
  let total = 0;
  let lastCode: SyncErrorCode | null = null;
  let lastLogAt = 0;
  return {
    report(error: unknown): void {
      total += 1;
      lastCode = error instanceof SyncProtocolError ? error.code : null;
      const now = input.now();
      if (lastLogAt !== 0 && now - lastLogAt < intervalMs) return;
      lastLogAt = now;
      input.report(`sync host ingress failed (total=${total}, code=${lastCode ?? "UNKNOWN"})`, error);
    },
    diagnostics(): IngressFailureDiagnostics {
      return { total, lastCode };
    },
  };
}
