import { useCallback, useRef, useState } from "react";
import { type RetryOptions, retryWithBackoff } from "../lib/retry";

export interface UseBackoffRetryResult {
  retry: <T>(fn: (attempt: number) => Promise<T>, opts?: Partial<RetryOptions>) => Promise<T>;
  cancel: () => void;
  attempt: number;
}

export function useBackoffRetry(defaultOpts?: Partial<RetryOptions>): UseBackoffRetryResult {
  const controllerRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(
    <T>(fn: (attempt: number) => Promise<T>, opts?: Partial<RetryOptions>) => {
      // 取消上一次尚未完成的请求
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setAttempt(0);

      return retryWithBackoff(fn, {
        ...defaultOpts,
        ...opts,
        signal: controller.signal,
        shouldRetry: (error: unknown) => {
          const result = opts?.shouldRetry ?? defaultOpts?.shouldRetry ?? (() => true);
          const shouldContinue = result(error);
          if (shouldContinue) setAttempt((a) => a + 1);
          return shouldContinue;
        },
      });
    },
    [defaultOpts],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { retry, cancel, attempt };
}
