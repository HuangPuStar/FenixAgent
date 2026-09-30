// 令牌桶限流器（4B）的行为契约测试：容量、补充速率、等待时间、键隔离与内存上限。
//
// 只测纯逻辑（`createTokenBucketLimiter`），端到端行为（429 + Retry-After、按 sub / 来源分桶）在
// `canvas-bff.test.ts` 的「限流」用例里验证。时间由入参给出，不 sleep。

import { expect, test } from "bun:test";
import { createTokenBucketLimiter, policyPerMinute } from "../server/services/rate-limit";

/** 30/分钟 = 容量 30、每 2 秒补 1 个令牌，便于用整数秒推进断言。 */
const POLICY = policyPerMinute(30);

// 容量内放行、超出拒绝：这是限流器的基本语义，也是「阈值」这一配置项的唯一表达。
test("容量内放行，超出后拒绝并给出等待秒数", () => {
  const limiter = createTokenBucketLimiter();
  const now = 1_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) {
    expect(limiter.tryAcquire("k", POLICY, now).allowed).toBe(true);
  }
  const denied = limiter.tryAcquire("k", POLICY, now);
  expect(denied.allowed).toBe(false);
  // 速率 = 30/60 = 0.5 个/秒，补 1 个需要 2 秒。
  expect(denied.retryAfterSeconds).toBe(2);
});

// 时间推进后按速率补充：拒绝不是永久封禁——这正是令牌桶相对「固定窗口 + 计数」的意义。
test("推进到等待时间后恢复放行", () => {
  const limiter = createTokenBucketLimiter();
  const now = 2_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) limiter.tryAcquire("k", POLICY, now);
  const denied = limiter.tryAcquire("k", POLICY, now);
  expect(denied.allowed).toBe(false);

  const readyAt = now + denied.retryAfterSeconds * 1000;
  expect(limiter.tryAcquire("k", POLICY, readyAt).allowed).toBe(true);
  // 刚恢复时只补出 1 个令牌，紧接着的第二次仍应被拒（不因一次等待而拿到整桶）。
  expect(limiter.tryAcquire("k", POLICY, readyAt).allowed).toBe(false);
});

// 桶按用户 / 来源隔离：一个键打满不得影响另一个键（多租户互不拖累）。
test("不同键之间互相隔离", () => {
  const limiter = createTokenBucketLimiter();
  const now = 3_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) limiter.tryAcquire("heavy", POLICY, now);
  expect(limiter.tryAcquire("heavy", POLICY, now).allowed).toBe(false);
  expect(limiter.tryAcquire("light", POLICY, now).allowed).toBe(true);
});

// 桶数量有上限：超出后回收，内存不随来源/用户数无界增长（被回收的键回到满桶，语义不变）。
test("键数达到上限后回收旧桶且不影响新键", () => {
  const limiter = createTokenBucketLimiter(2);
  const now = 4_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) limiter.tryAcquire("a", POLICY, now);
  expect(limiter.tryAcquire("a", POLICY, now).allowed).toBe(false);

  // 插入两个新键把 "a" 挤出去（上限 2）。
  expect(limiter.tryAcquire("b", POLICY, now).allowed).toBe(true);
  expect(limiter.tryAcquire("c", POLICY, now).allowed).toBe(true);
  // 再插入仍不抛错，且保留的键照常按自己的配额判定。
  expect(limiter.tryAcquire("d", POLICY, now).allowed).toBe(true);
  expect(limiter.tryAcquire("d", POLICY, now).allowed).toBe(true);
});

// 每键独立满桶起步：新键的第一次请求不能因为别的键被限而失败（否则冷启动会被误伤）。
test("新键首次请求必然放行", () => {
  const limiter = createTokenBucketLimiter(4);
  const now = 5_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) limiter.tryAcquire("busy", POLICY, now);
  expect(limiter.tryAcquire("busy", POLICY, now).allowed).toBe(false);
  for (const key of ["u1", "u2", "u3"]) expect(limiter.tryAcquire(key, POLICY, now).allowed).toBe(true);
});

// reset 只服务测试：复位后必须回到满桶（否则用例之间的限流状态会互相污染）。
test("reset 后回到满桶", () => {
  const limiter = createTokenBucketLimiter();
  const now = 6_000_000;

  for (let attempt = 0; attempt < POLICY.capacity; attempt += 1) limiter.tryAcquire("k", POLICY, now);
  expect(limiter.tryAcquire("k", POLICY, now).allowed).toBe(false);

  limiter.reset();
  expect(limiter.tryAcquire("k", POLICY, now).allowed).toBe(true);
});
