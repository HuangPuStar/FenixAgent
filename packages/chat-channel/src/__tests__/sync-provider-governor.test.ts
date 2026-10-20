import { describe, expect, test } from "bun:test";
import { CONCURRENCY_LIMITS } from "../sync/capacity/profile";
import type { Clock } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
/** barrel 是出帧网关的取用路径，单独导入以验证两个新模块确实被导出。 */
import * as providerBarrel from "../sync/provider";
import type { ControlGovernor, ControlGovernorOptions } from "../sync/provider/control-governor";
import { createControlGovernor } from "../sync/provider/control-governor";

/** 捕获本层协议错误：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

function expectSyncErrorCode(run: () => unknown, code: SyncErrorCode): SyncProtocolError {
  const error = captureSyncError(run);
  expect(error.code).toBe(code);
  return error;
}

/** 可推进、可回拨的假时钟：令牌补充只经注入时钟取时，断言不依赖真实时间。 */
class TestClock implements Clock {
  private current: number;

  constructor(current = 1_000) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  /** 时钟回拨：验证速率限制不因时间倒退而凭空发放令牌。 */
  rewind(milliseconds: number): void {
    this.current -= milliseconds;
  }

  setNow(value: number): void {
    this.current = value;
  }
}

/** 100 帧/秒 ⇒ 10ms 补充一枚令牌；窗口 1000 字节便于手算在途账目。 */
const FRAMES_PER_SECOND = 100;
const WINDOW_BYTES = 1_000;
/** 令牌用例里的帧都取 1 字节，让「一帧」与「一字节」的账目可以分别读出。 */
const TOKEN_FRAME_BYTES = 1;

function makeGovernor(clock: Clock, overrides: Partial<ControlGovernorOptions> = {}): ControlGovernor {
  return createControlGovernor({
    clock,
    framesPerSecond: FRAMES_PER_SECOND,
    windowBytes: WINDOW_BYTES,
    ...overrides,
  });
}

/** 用尽满桶令牌（每帧 1 字节，远不触及窗口）。 */
function drainTokens(governor: ControlGovernor, times = FRAMES_PER_SECOND): void {
  for (let index = 0; index < times; index += 1) {
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(true);
  }
}

describe("control governor", () => {
  // 连接建立期允许一次满桶突发，之后按帧率受限：第 fps+1 帧必须被拒。
  test("初始满桶可连发 framesPerSecond 帧，超出即被帧率拒绝", () => {
    const governor = makeGovernor(new TestClock());

    drainTokens(governor);

    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
    expect(governor.snapshot().availableTokens).toBe(0);
  });

  // 令牌按时间惰性补充：不足一枚时不得放行（不得四舍五入），正好补满一枚后立即可以再发一帧。
  test("令牌按 10ms 一枚惰性补充，不足一枚不放行", () => {
    const clock = new TestClock();
    const governor = makeGovernor(clock);
    drainTokens(governor);

    clock.advance(5);
    expect(governor.snapshot().availableTokens).toBe(0);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);

    clock.advance(5);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(true);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
  });

  // 闲置再久也只能攒满一桶：速率限制不能被静默时间兑换成超额突发。
  test("长时间闲置后突发仍以 framesPerSecond 为上限", () => {
    const clock = new TestClock();
    const governor = makeGovernor(clock);
    drainTokens(governor);

    clock.advance(60_000);

    drainTokens(governor);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
  });

  // 时钟回拨不补令牌：回拨能刷出额度的话，速率限制就形同虚设。
  test("时间回退不补令牌，回拨后需重新走完真实时间", () => {
    const clock = new TestClock();
    const governor = makeGovernor(clock);
    drainTokens(governor);

    // 回拨 1 秒（满桶足以在这段时间里补出 100 枚，若能补就说明限制失效）。
    clock.rewind(1_000);

    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
    expect(governor.snapshot().availableTokens).toBe(0);

    // 基准点未被回挪：从回拨前的时刻起再走 500ms 才补出 50 枚，多一枚都没有。
    clock.setNow(1_500);
    let granted = 0;
    while (governor.tryAcquire(TOKEN_FRAME_BYTES)) {
      granted += 1;
    }
    expect(granted).toBe(50);
  });

  // 在途字节到顶即拒绝，且拒绝不消耗令牌（令牌限的是尝试速率，不是拒绝次数）。
  test("窗口字节到顶后拒绝，且不消耗令牌", () => {
    const governor = makeGovernor(new TestClock());

    expect(governor.tryAcquire(950)).toBe(true);
    expect(governor.snapshot().usedBytes).toBe(950);

    expect(governor.tryAcquire(51)).toBe(false);
    expect(governor.snapshot().usedBytes).toBe(950);
    expect(governor.snapshot().availableTokens).toBe(FRAMES_PER_SECOND - 1);
  });

  // 多退字节会凭空造出容量：必须与 quota 同口径立刻拒绝，且账目保持不变。
  test("release 超过在途字节抛 ADMISSION_REJECTED 且账目不变", () => {
    const governor = makeGovernor(new TestClock());
    expect(governor.tryAcquire(950)).toBe(true);

    expectSyncErrorCode(() => governor.release(951), "ADMISSION_REJECTED");
    expect(governor.snapshot().usedBytes).toBe(950);

    governor.release(950);
    expect(governor.snapshot().usedBytes).toBe(0);
    // 结清后窗口额度立即可复用。
    expect(governor.tryAcquire(51)).toBe(true);
  });

  // 单帧超过整窗永远发不出，属于拒绝而非参数违规：不得改变账目，也不得吞掉令牌。
  test("单帧超过整窗被拒且令牌与字节账目都不变", () => {
    const governor = makeGovernor(new TestClock());

    expect(governor.tryAcquire(WINDOW_BYTES + 1)).toBe(false);

    expect(governor.snapshot()).toEqual({
      windowBytes: WINDOW_BYTES,
      usedBytes: 0,
      availableTokens: FRAMES_PER_SECOND,
    });
  });

  // 被拒的调用不改变任何账目，因此可原样重试：两次结果与快照必须逐字段一致。
  test("被拒的申请可原样重试且快照逐字段不变", () => {
    const governor = makeGovernor(new TestClock());
    expect(governor.tryAcquire(950)).toBe(true);
    const before = governor.snapshot();

    expect(governor.tryAcquire(51)).toBe(false);
    expect(governor.snapshot()).toEqual(before);

    expect(governor.tryAcquire(51)).toBe(false);
    expect(governor.snapshot()).toEqual(before);
  });

  // release 只归还字节、不退还令牌：令牌随时间回收，否则持续失败的调用方可以无限占用帧率。
  test("release 归还字节但不退还令牌", () => {
    const governor = makeGovernor(new TestClock());
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(true);
    expect(governor.snapshot().availableTokens).toBe(FRAMES_PER_SECOND - 1);

    governor.release(TOKEN_FRAME_BYTES);

    expect(governor.snapshot()).toEqual({
      windowBytes: WINDOW_BYTES,
      usedBytes: 0,
      availableTokens: FRAMES_PER_SECOND - 1,
    });
  });

  // 快照必须回答「现在」「还能发几帧整帧」：不足一帧的余量不进位，窗口配置值原样回显。
  test("snapshot 回显窗口配置并把不足一帧的余量向下取整", () => {
    const clock = new TestClock();
    const governor = makeGovernor(clock);
    drainTokens(governor);

    clock.advance(5);

    expect(governor.snapshot()).toEqual({
      windowBytes: WINDOW_BYTES,
      usedBytes: FRAMES_PER_SECOND * TOKEN_FRAME_BYTES,
      availableTokens: 0,
    });
  });

  // 断连清账必须回到初始态：字节归零、令牌回满桶、补充基准点重算，复位后仍可满桶突发。
  test("reset 清空字节账目、回满令牌并重设补充基准点", () => {
    const clock = new TestClock();
    const governor = makeGovernor(clock);
    expect(governor.tryAcquire(950)).toBe(true);
    clock.advance(1_000);

    governor.reset();

    expect(governor.snapshot()).toEqual({
      windowBytes: WINDOW_BYTES,
      usedBytes: 0,
      availableTokens: FRAMES_PER_SECOND,
    });
    drainTokens(governor);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
  });

  // 参数违规是调用方缺陷而非流控：非正数、小数、NaN、无穷必须立刻抛 ADMISSION_REJECTED。
  test("构造参数与申请/结清字节非法时抛 ADMISSION_REJECTED", () => {
    const clock = new TestClock();
    expectSyncErrorCode(() => makeGovernor(clock, { framesPerSecond: 0 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeGovernor(clock, { framesPerSecond: 1.5 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeGovernor(clock, { framesPerSecond: Number.NaN }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeGovernor(clock, { windowBytes: -1 }), "ADMISSION_REJECTED");

    const governor = makeGovernor(clock);
    expectSyncErrorCode(() => governor.tryAcquire(0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => governor.tryAcquire(1.5), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => governor.tryAcquire(Number.NaN), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => governor.release(0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => governor.release(Number.POSITIVE_INFINITY), "ADMISSION_REJECTED");

    expect(governor.snapshot()).toEqual({
      windowBytes: WINDOW_BYTES,
      usedBytes: 0,
      availableTokens: FRAMES_PER_SECOND,
    });
  });

  // 生效值只能来自 capacity/profile 的声明常量（100 帧/秒、32KiB 控制窗口），本层不得另抄一份数值。
  test("按 profile 声明常量装配时突发上限与窗口配置一致", () => {
    const governor = createControlGovernor({
      clock: new TestClock(),
      framesPerSecond: CONCURRENCY_LIMITS.controlFramesPerSecond,
      windowBytes: CONCURRENCY_LIMITS.controlWindowPerConnectionBytes,
    });

    expect(governor.snapshot().windowBytes).toBe(CONCURRENCY_LIMITS.controlWindowPerConnectionBytes);
    drainTokens(governor, CONCURRENCY_LIMITS.controlFramesPerSecond);
    expect(governor.tryAcquire(TOKEN_FRAME_BYTES)).toBe(false);
  });

  // barrel 必须导出本模块：漏接线时出帧网关拿不到控制器，且只有全量类型检查才报错。
  test("provider barrel 导出控制流限频与 ACK 超时模块", () => {
    expect(typeof providerBarrel.createControlGovernor).toBe("function");
    expect(typeof providerBarrel.createAckTimeoutTracker).toBe("function");
  });
});
