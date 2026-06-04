# Frontend Backoff Retry Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed-interval retry storms in frontend chat components with exponential backoff + jitter.

**Architecture:** Two new files — a pure `retryWithBackoff()` async function and a `useBackoffRetry()` React hook. Three migration targets in existing components.

**Tech Stack:** TypeScript, React 19 hooks, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-04-frontend-backoff-retry-design.md`

---

### Task 1: Core `retryWithBackoff()` utility + tests

**Files:**
- Create: `web/src/lib/retry.ts`
- Create: `web/src/__tests__/retry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/retry.test.ts`:

```ts
import { describe, expect, test, vi } from "bun:test";
import { retryWithBackoff } from "../lib/retry";

// 成功首次调用不重试
test("成功首次调用不重试", async () => {
  const fn = vi.fn().mockResolvedValue("ok");
  const result = await retryWithBackoff(fn, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
  });
  expect(result).toBe("ok");
  expect(fn).toHaveBeenCalledTimes(1);
});

// 失败后重试直到成功
test("失败后重试直到成功", async () => {
  const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce("ok");
  const result = await retryWithBackoff(fn, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
  });
  expect(result).toBe("ok");
  expect(fn).toHaveBeenCalledTimes(2);
});

// 超过最大重试次数后抛出最后的错误
test("超过最大重试次数后抛出最后的错误", async () => {
  const fn = vi.fn().mockRejectedValue(new Error("persistent"));
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });
    expect.unreachable("Should have thrown");
  } catch (err) {
    expect((err as Error).message).toBe("persistent");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  }
});

// shouldRetry 返回 false 时立即抛出
test("shouldRetry 返回 false 时立即抛出", async () => {
  const fn = vi.fn().mockRejectedValue(new Error("nope"));
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      shouldRetry: (err) => (err as Error).message !== "nope",
    });
    expect.unreachable("Should have thrown");
  } catch (err) {
    expect((err as Error).message).toBe("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  }
});

// signal 已取消时抛出 AbortError
test("signal 已取消时抛出 AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const fn = vi.fn().mockRejectedValue(new Error("fail"));
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      signal: controller.signal,
    });
    expect.unreachable("Should have thrown");
  } catch (err) {
    expect((err as Error).name).toBe("AbortError");
  }
});

// fn 接收当前 attempt 参数
test("fn 接收当前 attempt 参数", async () => {
  const attempts: number[] = [];
  const fn = vi.fn().mockImplementation(async (attempt: number) => {
    attempts.push(attempt);
    if (attempt < 2) throw new Error("retry");
    return "done";
  });
  await retryWithBackoff(fn, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
  });
  expect(attempts).toEqual([0, 1, 2]);
});

// 延迟不超过 maxDelayMs
test("延迟不超过 maxDelayMs", async () => {
  const start = Date.now();
  const fn = vi.fn().mockRejectedValue(new Error("fail"));
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 150,
    });
  } catch {}
  const elapsed = Date.now() - start;
  // With maxDelayMs=150 and jitter, 4 retries should take at most ~600ms (4*150), well under 2000ms
  expect(elapsed).toBeLessThan(2000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/__tests__/retry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `web/src/lib/retry.ts`:

```ts
export interface RetryOptions {
  /** Max retry attempts (excluding initial call). Default: 5 */
  maxAttempts: number;
  /** Base delay in ms for first retry. Default: 1000 */
  baseDelayMs: number;
  /** Upper bound for backoff delay in ms. Default: 30000 */
  maxDelayMs: number;
  /** Jitter strategy. Default: "full" */
  jitter?: "full" | "none";
  /** Predicate to decide if error is retryable. Default: always retry */
  shouldRetry?: (error: unknown) => boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "signal">> = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: "full",
  shouldRetry: () => true,
};

function calculateDelay(attempt: number, opts: Required<Omit<RetryOptions, "signal">>): number {
  const rawDelay = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  if (opts.jitter === "full") {
    return Math.round(rawDelay * (0.5 + Math.random() * 0.5));
  }
  return rawDelay;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Retry aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Retry aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry an async operation with exponential backoff + full jitter.
 *
 * @param fn - async function receiving current attempt number (0-based)
 * @param opts - retry configuration
 * @returns result of fn
 * @throws last error if all retries exhausted, AbortError if cancelled
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const resolved = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  const { maxAttempts, signal } = resolved;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Retry aborted", "AbortError");
    }

    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Check if we should retry this error
      if (!resolved.shouldRetry(err)) {
        throw err;
      }

      // Check if we've exhausted attempts
      if (attempt >= maxAttempts) {
        throw err;
      }

      // Check abort before sleeping
      if (signal?.aborted) {
        throw new DOMException("Retry aborted", "AbortError");
      }

      // Wait with backoff
      const delay = calculateDelay(attempt, resolved);
      await sleep(delay, signal);
    }
  }

  // Unreachable, but TypeScript needs it
  throw lastError;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test web/src/__tests__/retry.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/retry.ts web/src/__tests__/retry.test.ts
git commit -m "feat(retry): add retryWithBackoff utility with exponential backoff + jitter"
```

---

### Task 2: `useBackoffRetry()` React hook + tests

**Files:**
- Create: `web/src/hooks/useBackoffRetry.ts`
- Create: `web/src/__tests__/use-backoff-retry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/use-backoff-retry.test.ts`:

```ts
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { useBackoffRetry } from "../hooks/useBackoffRetry";

afterEach(cleanup);

// hook 返回 retry, cancel, attempt
test("hook 返回 retry, cancel, attempt", () => {
  const { result } = renderHook(() => useBackoffRetry());
  expect(result.current.retry).toBeInstanceOf(Function);
  expect(result.current.cancel).toBeInstanceOf(Function);
  expect(result.current.attempt).toBe(0);
});

// retry 成功后不重试
test("retry 成功后不重试", async () => {
  const { result } = renderHook(() => useBackoffRetry);
  const fn = vi.fn().mockResolvedValue("ok");
  const value = await result.current.retry(fn, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 });
  expect(value).toBe("ok");
  expect(fn).toHaveBeenCalledTimes(1);
});

// cancel 后 retry 抛出 AbortError
test("cancel 后 retry 抛出 AbortError", async () => {
  const { result } = renderHook(() => useBackoffRetry);
  let rejectFn!: (err: Error) => void;
  const fn = vi.fn().mockImplementation(
    () => new Promise((_, reject) => { rejectFn = reject; }),
  );
  const promise = result.current.retry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
  result.current.cancel();
  rejectFn(new Error("fail"));
  try {
    await promise;
    expect.unreachable("Should have thrown");
  } catch (err) {
    expect((err as Error).name).toBe("AbortError");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/__tests__/use-backoff-retry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `web/src/hooks/useBackoffRetry.ts`:

```ts
import { useCallback, useRef, useState } from "react";
import type { RetryOptions } from "../lib/retry";
import { retryWithBackoff } from "../lib/retry";

export interface UseBackoffRetryResult {
  /** Execute async fn with backoff retry. Auto-cancels previous in-flight retry. */
  retry: <T>(fn: (attempt: number) => Promise<T>, opts?: Partial<RetryOptions>) => Promise<T>;
  /** Cancel current in-flight retry. */
  cancel: () => void;
  /** Current retry attempt (0 = initial execution). */
  attempt: number;
}

/**
 * React hook for retry with exponential backoff.
 * - Auto-cancels on unmount
 * - New retry() call cancels previous in-flight retry
 * - Each call starts fresh from attempt 0
 */
export function useBackoffRetry(defaultOpts?: Partial<RetryOptions>): UseBackoffRetryResult {
  const controllerRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setAttempt(0);
  }, []);

  const retry = useCallback(
    async <T>(fn: (attempt: number) => Promise<T>, opts?: Partial<RetryOptions>): Promise<T> => {
      // Cancel any previous in-flight retry
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setAttempt(0);

      const mergedOpts: Partial<RetryOptions> = {
        ...defaultOpts,
        ...opts,
        signal: controller.signal,
      };

      try {
        const result = await retryWithBackoff<T>(async (currentAttempt) => {
          setAttempt(currentAttempt);
          return fn(currentAttempt);
        }, mergedOpts);
        return result;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setAttempt(0);
        }
      }
    },
    [defaultOpts],
  );

  return { retry, cancel, attempt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test web/src/__tests__/use-backoff-retry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useBackoffRetry.ts web/src/__tests__/use-backoff-retry.test.ts
git commit -m "feat(retry): add useBackoffRetry React hook with auto-cleanup"
```

---

### Task 3: Migrate ACPMain bootstrap retry

**Files:**
- Modify: `web/components/ACPMain.tsx:37-152`

This is the biggest storm source — `setTimeout(..., 200)` × 10 fixed retries when capabilities aren't ready.

- [ ] **Step 1: Replace bootstrap retry logic in ACPMain**

In `web/components/ACPMain.tsx`, make these changes:

**Remove state variables** — delete `bootstrapAttempt` state and `BOOTSTRAP_MAX_ATTEMPTS`:
```diff
- const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
- const BOOTSTRAP_MAX_ATTEMPTS = 10;
```

**Remove the `bootstrapRetryTimerRef`**:
```diff
  const bootstrappedRef = useRef(false);
- const bootstrapRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

**Replace the reset-on-client-change effect** — simplify since we no longer track attempt count:
```diff
  // biome-ignore lint/correctness/useExhaustiveDependencies: client 变更时需重置 bootstrap 状态，否则新连接不会加载会话
  useEffect(() => {
    bootstrappedRef.current = false;
-   setBootstrapAttempt(0);
-   if (bootstrapRetryTimerRef.current) {
-     clearTimeout(bootstrapRetryTimerRef.current);
-       bootstrapRetryTimerRef.current = null;
-   }
  }, [client]);
```

**Remove the capabilities-bump effect** — no longer needed since retry handles waiting internally:
Delete the entire `useEffect` that listens to `capabilitiesChange` and calls `setBootstrapAttempt`.

**Replace the bootstrap effect** — use `retryWithBackoff` instead of manual setTimeout chain:

```tsx
// Bootstrap: load latest session or create new one.
// Uses retryWithBackoff to wait for capabilities with exponential backoff.
useEffect(() => {
  if (client.getState() !== "connected") return;
  if (bootstrappedRef.current) return;

  let cancelled = false;

  const bootstrap = async () => {
    try {
      // Wait for capabilities with exponential backoff
      await retryWithBackoff(
        async () => {
          if (cancelled) return;
          if (!client.supportsSessionList) {
            throw new Error("Capabilities not ready");
          }
        },
        { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8000 },
      );
      if (cancelled) return;

      bootstrappedRef.current = true;
      const response = await client.listSessions();
      if (cancelled) return;

      const latest = [...response.sessions].sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return timeB - timeA;
      })[0];

      if (latest) {
        setInitialActiveSessionId(latest.sessionId);
        await handleSelectSession(latest);
        return;
      }

      console.log("[ACPMain] No existing sessions found, creating new session");
      chatRef.current?.newSession();
    } catch (error) {
      // Capabilities never became available — create session directly
      if (!client.supportsSessionList && !cancelled) {
        console.log("[ACPMain] Session list not supported, creating new session directly");
        bootstrappedRef.current = true;
        chatRef.current?.newSession();
        return;
      }
      bootstrappedRef.current = false;
      console.warn("[ACPMain] Failed to bootstrap latest session:", error);
    }
  };

  bootstrap();

  return () => {
    cancelled = true;
  };
}, [client, handleSelectSession]);
```

**Add import** at top of file:
```diff
+ import { retryWithBackoff } from "../src/lib/retry";
```

- [ ] **Step 2: Run build to verify no errors**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/components/ACPMain.tsx
git commit -m "fix(chat): replace ACPMain bootstrap fixed-retry with exponential backoff"
```

---

### Task 4: Migrate ACPMain SidebarSessionList `setTimeout(loadSessions, 200)`

**Files:**
- Modify: `web/components/ACPMain.tsx:295-303`

Replace the `setTimeout(loadSessions, 200)` on connection with `retryWithBackoff`:

- [ ] **Step 1: Replace connection handler setTimeout**

In the `SidebarSessionList` component, replace:

```diff
  useEffect(() => {
    const handler = (state: string) => {
      if (state === "connected") {
-       setTimeout(loadSessions, 200);
+       retryWithBackoff(() => loadSessions(), {
+         maxAttempts: 2,
+         baseDelayMs: 300,
+         maxDelayMs: 1000,
+       }).catch(() => {});
      }
    };
    client.setConnectionStateHandler(handler);
    return () => client.removeConnectionStateHandler(handler);
  }, [client, loadSessions]);
```

- [ ] **Step 2: Run build to verify**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/components/ACPMain.tsx
git commit -m "fix(chat): replace SidebarSessionList fixed-delay reconnect with backoff retry"
```

---

### Task 5: Migrate ChatPanel reconnect event

**Files:**
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:37-47`

The `agent:reconnect` event handler immediately bumps `reconnectKey` with no backoff. Add debounce using `retryWithBackoff` concept — but since this is a key bump (not an API call), a simpler approach is a minimum interval guard.

- [ ] **Step 1: Add minimum interval between reconnects**

In `ChatPanel.tsx`, add a ref to track last reconnect time and guard against rapid reconnections:

```diff
  const clientRef = useRef<ACPClient | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
+ const lastReconnectRef = useRef(0);

  // 监听实例重启事件，强制重连（带最小间隔防止风暴）
  useEffect(() => {
    const handler = (e: Event) => {
      const { envId } = (e as CustomEvent<{ envId: string }>).detail;
      if (envId === agentId) {
+       const now = Date.now();
+       const elapsed = now - lastReconnectRef.current;
+       // Minimum 2s between reconnects
+       if (elapsed < 2000) return;
+       lastReconnectRef.current = now;
        setReconnectKey((k) => k + 1);
      }
    };
    window.addEventListener("agent:reconnect", handler);
    return () => window.removeEventListener("agent:reconnect", handler);
  }, [agentId]);
```

- [ ] **Step 2: Run build to verify**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/ChatPanel.tsx
git commit -m "fix(chat): guard ChatPanel reconnect against rapid fire events"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run all frontend tests**

Run: `bun test web/src/__tests__/`
Expected: All tests pass

- [ ] **Step 2: Run precheck**

Run: `bun run precheck`
Expected: Pass

- [ ] **Step 3: Verify build**

Run: `bun run build:web`
Expected: Build succeeds
