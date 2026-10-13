// 上游熔断状态机（3C）的行为契约：这里只测「什么时候短路、什么时候放行探测、什么时候恢复」，不碰 HTTP。
// 时钟由 `createUpstreamHealth({ now })` 注入，冷却窗口按毫秒推进，用例不必真的等待。
//
// 阈值与冷却取测试自己的小值（3 次 / 1000ms）：断言的是状态迁移本身，与部署常量解耦；部署常量另有用例
// 固化，避免「测试跟着常量漂移」或「改了常量而测试仍绿」。

import { describe, expect, test } from "bun:test";
import {
  createUpstreamHealth,
  UPSTREAM_COOLDOWN_MS,
  UPSTREAM_FAILURE_THRESHOLD,
} from "../server/services/upstream-health";

/** 可控时钟与判定器；`advance` 只推进本用例的时钟。 */
function createHarness(failureThreshold = 3, cooldownMs = 1000) {
  let nowMs = 0;
  const health = createUpstreamHealth({ now: () => nowMs, failureThreshold, cooldownMs });
  return {
    health,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("上游熔断状态机", () => {
  // 部署常量是对外行为的一部分（阈值决定多久判死上游、冷却决定多久恢复一次探测），改动必须是有意识的。
  test("部署常量固定为 5 次失败与 30s 冷却", () => {
    expect(UPSTREAM_FAILURE_THRESHOLD).toBe(5);
    expect(UPSTREAM_COOLDOWN_MS).toBe(30_000);
  });

  // 阈值内的失败不该阻断流量：上游偶发抖动时请求应继续被放行，否则单次超时就会放大成整体不可用。
  test("未达阈值的连续失败仍放行", () => {
    const { health } = createHarness();

    health.recordUpstreamFailure("timeout");
    health.recordUpstreamFailure("network");

    expect(health.tryAcquire()).toBe(true);
    expect(health.snapshot().consecutiveFailures).toBe(2);
  });

  // 达到阈值即打开：冷却期内不再放行任何调用（这正是熔断的意义——别让每个用户请求替我们探测死掉的上游）。
  test("达到阈值后打开并在冷却期内短路", () => {
    const { health, advance } = createHarness();

    health.recordUpstreamFailure("timeout");
    health.recordUpstreamFailure("network");
    health.recordUpstreamFailure("upstream_5xx");

    expect(health.snapshot().state).toBe("open");
    expect(health.tryAcquire()).toBe(false);
    advance(999);
    expect(health.tryAcquire()).toBe(false);
    expect(health.snapshot().cooldownRemainingMs).toBe(1);
  });

  // 冷却结束后半开：只放行一次探测，探测在途时其余并发调用仍被短路（探测信号必须干净，否则一次成功会被
  // 一堆并发请求掩盖成「已经恢复」）。
  test("冷却结束后半开，且只放行一次探测", () => {
    const { health, advance } = createHarness();
    for (let i = 0; i < 3; i += 1) health.recordUpstreamFailure("upstream_5xx");

    advance(1000);
    expect(health.tryAcquire()).toBe(true);
    expect(health.snapshot().state).toBe("half_open");
    expect(health.tryAcquire()).toBe(false);
  });

  // 探测成功即恢复：状态回到关闭、连续失败清零、冷却窗口清空，后续调用恢复放行。
  test("探测成功后恢复为关闭态", () => {
    const { health, advance } = createHarness();
    for (let i = 0; i < 3; i += 1) health.recordUpstreamFailure("timeout");
    advance(1000);
    expect(health.tryAcquire()).toBe(true);

    health.recordUpstreamSuccess();

    expect(health.snapshot()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      openedAtMs: null,
      cooldownRemainingMs: 0,
    });
    expect(health.tryAcquire()).toBe(true);
  });

  // 探测失败必须重新打开并刷新冷却起点：半开探测是唯一能证明「上游恢复了」的信号，它失败就说明还没恢复。
  test("探测失败重新打开并刷新冷却窗口", () => {
    const { health, advance } = createHarness();
    for (let i = 0; i < 3; i += 1) health.recordUpstreamFailure("timeout");
    advance(1000);
    expect(health.tryAcquire()).toBe(true);

    health.recordUpstreamFailure("network");

    expect(health.snapshot().state).toBe("open");
    expect(health.snapshot().cooldownRemainingMs).toBe(1000);
    expect(health.tryAcquire()).toBe(false);
    advance(1000);
    expect(health.tryAcquire()).toBe(true);
  });

  // 成功一次就把连续失败清零：熔断记的是「连续」失败，偶发失败之间夹着成功时不该累积成打开态。
  test("成功清零连续失败计数", () => {
    const { health } = createHarness();

    health.recordUpstreamFailure("timeout");
    health.recordUpstreamFailure("timeout");
    health.recordUpstreamSuccess();
    health.recordUpstreamFailure("timeout");
    health.recordUpstreamFailure("timeout");

    expect(health.snapshot().state).toBe("closed");
    expect(health.snapshot().consecutiveFailures).toBe(2);
  });

  // 打开前发出的在途请求失败时不得延长冷却：否则持续有在途请求会让「打开态」永远刷新，永远不回半开。
  test("打开态下的在途失败不刷新冷却起点", () => {
    const { health, advance } = createHarness();
    for (let i = 0; i < 3; i += 1) health.recordUpstreamFailure("timeout");
    const openedAt = health.snapshot().openedAtMs;

    advance(500);
    health.recordUpstreamFailure("timeout");

    expect(health.snapshot().openedAtMs).toBe(openedAt);
    advance(500);
    expect(health.tryAcquire()).toBe(true);
  });

  // 本地错误（路径非法、配置缺失）与上游健康无关：它不计数、不打开，也不清零已有的失败计数。
  test("本地错误不改变状态与计数", () => {
    const { health } = createHarness();
    health.recordUpstreamFailure("timeout");
    health.recordUpstreamFailure("timeout");

    health.recordLocalError();

    expect(health.snapshot().state).toBe("closed");
    expect(health.snapshot().consecutiveFailures).toBe(2);
    expect(health.tryAcquire()).toBe(true);
  });
});
