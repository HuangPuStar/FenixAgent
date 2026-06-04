# Frontend Backoff Retry Library

**Date**: 2026-06-04
**Status**: Approved
**Scope**: `web/` only

## Problem

Frontend chat components use fixed-interval `setTimeout` retries (200ms, 500ms) with hard-coded attempt limits. When an agent is slow or disconnected, these retries create "retry storms" — rapid repeated requests that overload the server and degrade UX.

### Identified Storm Sources

| File | Pattern | Issue |
|------|---------|-------|
| `web/components/ACPMain.tsx:105` | `setTimeout(..., 200)` × 10 | Bootstrap retry at fixed 200ms |
| `web/components/ACPMain.tsx:296` | `setTimeout(loadSessions, 200)` | Fixed delay on connect |
| `web/components/ChatPanel.tsx:42` | `agent:reconnect` → immediate `reconnectKey++` | No backoff on reconnect |

### Non-targets (not changed)

- `setInterval` polling (e.g., `loadSessions` every 30s) — not error-driven
- UI animation timers (e.g., shake 500ms) — not retry logic
- Fixed-interval status polling (e.g., `useWorkflowRun` 2s) — not error-driven

## Design

### Approach: `retryWithBackoff()` function + `useBackoffRetry()` hook

#### 1. Core Utility — `web/src/lib/retry.ts`

```ts
interface RetryOptions {
  /** Max retry attempts (excluding initial call). Default: 5 */
  maxAttempts: number;
  /** Base delay in ms for first retry. Default: 1000 */
  baseDelayMs: number;
  /** Upper bound for backoff delay in ms. Default: 30000 */
  maxDelayMs: number;
  /** Jitter strategy. Default: "full" */
  jitter?: "full" | "none";
  /** Predicate to decide if error is retryable. Default: always true */
  shouldRetry?: (error: unknown) => boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<T>
```

**Algorithm**:

```
delay = min(baseDelay * 2^attempt, maxDelay)
jitteredDelay = delay * (0.5 + Math.random() * 0.5)  // full jitter
```

- `attempt` starts at 0 (initial call). Retry attempts are 1, 2, ...
- Before each retry: check `signal.aborted` → throw `AbortError`
- If `shouldRetry(error)` returns `false` → throw immediately
- On exhaustion → throw last error

#### 2. React Hook — `web/src/hooks/useBackoffRetry.ts`

```ts
interface UseBackoffRetryResult {
  retry: <T>(fn: (attempt: number) => Promise<T>, opts?: Partial<RetryOptions>) => Promise<T>;
  cancel: () => void;
  attempt: number;
}

function useBackoffRetry(defaultOpts?: Partial<RetryOptions>): UseBackoffRetryResult
```

**Behavior**:
- Holds an internal `AbortController`; auto-aborts on unmount
- Each `retry()` call creates a new `AbortController`; previous in-flight retry is auto-cancelled
- `cancel()` = manual abort
- `defaultOpts` provides component-level defaults; per-call `opts` override
- No `reset()` needed — each `retry()` starts from attempt 0

### Migration Targets

| File | Before | After |
|------|--------|-------|
| `ACPMain.tsx:105` | `setTimeout(..., 200)` × 10 fixed | `useBackoffRetry({ maxAttempts: 5, baseDelayMs: 500 })` + `retry()` |
| `ACPMain.tsx:296` | `setTimeout(loadSessions, 200)` | `retry(() => loadSessions(), { maxAttempts: 3, baseDelayMs: 500 })` |
| `ChatPanel.tsx:42` | `agent:reconnect` → immediate `reconnectKey++` | Wrap reconnect in `useBackoffRetry` to prevent rapid restart |

### Non-migrations

- `setInterval(loadSessions, 30_000)` — polling, not error retry
- `ACPConnect.tsx:228` shake animation — UI, not retry
- `useWorkflowRun.ts` 2s polling — polling, not error retry
