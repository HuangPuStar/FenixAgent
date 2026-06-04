import { describe, expect, test } from "bun:test";

const { retryWithBackoff } = await import("../lib/retry");

// 成功首次调用不重试
test("fn succeeds on first call, no retry", async () => {
  const fn = async () => "ok";
  const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 });
  expect(result).toBe("ok");
});

// 失败后重试直到成功
test("fn fails once then succeeds", async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount === 1) throw new Error("fail");
    return "recovered";
  };
  const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 });
  expect(result).toBe("recovered");
  expect(callCount).toBe(2);
});

// 超过最大重试次数后抛出最后的错误
test("all attempts fail, throws last error", async () => {
  const errors = [new Error("err1"), new Error("err2"), new Error("err3")];
  let callCount = 0;
  const fn = async () => {
    throw errors[callCount++];
  };
  try {
    await retryWithBackoff(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 });
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(e).toBe(errors[2]); // last error
  }
});

// shouldRetry 返回 false 时立即抛出
test("shouldRetry returns false, no retry", async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw new Error("nope");
  };
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
      shouldRetry: () => false,
    });
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(callCount).toBe(1);
    expect((e as Error).message).toBe("nope");
  }
});

// signal 已取消时抛出 AbortError
test("pre-aborted signal throws AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw new Error("fail");
  };
  try {
    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      signal: controller.signal,
    });
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(callCount).toBe(1);
    expect((e as DOMException).name).toBe("AbortError");
  }
});

// fn 接收当前 attempt 参数
test("fn receives current attempt number", async () => {
  const attempts: number[] = [];
  let callCount = 0;
  const fn = async (attempt: number) => {
    attempts.push(attempt);
    callCount++;
    if (callCount < 4) throw new Error("retry");
    return "done";
  };
  await retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 });
  expect(attempts).toEqual([0, 1, 2, 3]);
});

// 延迟不超过 maxDelayMs
test("delay does not exceed maxDelayMs", async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount <= 3) throw new Error("retry");
    return "done";
  };
  const start = Date.now();
  await retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 15, jitter: "none" });
  const elapsed = Date.now() - start;
  // 3 retries with capped delays: min(100*2,15)=15, min(100*4,15)=15, min(100*8,15)=15 => total ~45ms max
  // With some tolerance for timer imprecision, should be well under uncapped total (100+200+400=700)
  expect(elapsed).toBeLessThan(500);
});
