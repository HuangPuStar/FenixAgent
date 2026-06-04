export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: "full" | "none";
  shouldRetry?: (error: unknown) => boolean;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Retry aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Retry aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: Partial<RetryOptions>,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  const jitter = opts?.jitter ?? "full";
  const shouldRetry = opts?.shouldRetry ?? (() => true);
  const signal = opts?.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      if (!shouldRetry(error)) throw error;
      if (signal?.aborted) throw new DOMException("Retry aborted", "AbortError");

      const rawDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const delay = jitter === "full" ? rawDelay * (0.5 + Math.random() * 0.5) : rawDelay;
      await sleep(delay, signal);
    }
  }
  throw lastError;
}
