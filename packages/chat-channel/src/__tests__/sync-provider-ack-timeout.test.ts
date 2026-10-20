import { describe, expect, test } from "bun:test";
import { CONCURRENCY_LIMITS } from "../sync/capacity/profile";
import type { Clock } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import { MAX_IDENTIFIER_BYTES } from "../sync/protocol/identity";
import type { AckTimeoutTracker, AckTimeoutTrackerOptions } from "../sync/provider/ack-timeout";
import { createAckTimeoutTracker } from "../sync/provider/ack-timeout";

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

/** 可推进、可回拨的假时钟：到期判定只经注入时钟取时，断言不依赖真实时间。 */
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

  /** 时钟回拨：验证倒退不会把未到期的投递误判为超期断连。 */
  rewind(milliseconds: number): void {
    this.current -= milliseconds;
  }
}

/** 期限取 1 秒便于手算边界；生产值另有一条按 profile 常量装配的用例。 */
const ACK_DEADLINE_MS = 1_000;
const TRANSPORT_EPOCH = "tx_0123456789abcdef";
const NEXT_EPOCH = "tx_0011223344556677";
const DELIVERY_FIRST = "dlv_first";
const DELIVERY_SECOND = "dlv_second";
const DELIVERY_THIRD = "dlv_third";

interface TrackerHarness {
  readonly tracker: AckTimeoutTracker;
  readonly clock: TestClock;
}

function makeTracker(overrides: Partial<AckTimeoutTrackerOptions> = {}): TrackerHarness {
  const clock = new TestClock();
  return {
    tracker: createAckTimeoutTracker({ clock, ackDeadlineMs: ACK_DEADLINE_MS, ...overrides }),
    clock,
  };
}

/** 超期投递的 deliveryId 序列：扫描顺序断言与集合断言分开表达。 */
function expiredIds(tracker: AckTimeoutTracker): string[] {
  return tracker.scan().map((entry) => entry.deliveryId);
}

describe("ack timeout tracker", () => {
  // 未到期限不得判定超期：判定早了会因网络抖动误断健康连接。
  test("未到 ackDeadlineMs 的投递不超期且仍计入在途", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS - 1);

    expect(tracker.scan()).toEqual([]);
    expect(tracker.outstandingCount()).toBe(1);
  });

  // 边界取等号即超期，并带出登记时的代次：调用方据此判断该断开的是否是当前连接。
  test("满 ackDeadlineMs 即算超期并回传登记时的 transportEpoch", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS);

    expect(tracker.scan()).toEqual([{ deliveryId: DELIVERY_FIRST, transportEpoch: TRANSPORT_EPOCH }]);
  });

  // 同 id 同代次重复登记（重传）幂等且不续期：重传不能把一个收不到 ACK 的投递的期限一再推后。
  test("同 deliveryId 同代次重复登记幂等且不续期", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS - 1);
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);
    expect(tracker.outstandingCount()).toBe(1);

    clock.advance(1);

    // 保留首次登记的时刻与代次：期限仍从首次登记起算，超期归属仍是原连接。
    expect(tracker.scan()).toEqual([{ deliveryId: DELIVERY_FIRST, transportEpoch: TRANSPORT_EPOCH }]);
  });

  // 同 id 换代次说明 deliveryId 被跨代次复用：静默忽略会藏起这一真实缺陷，且超期报告会把责任记到错误的
  // 连接上，因此与 ack-ledger 同口径抛错，且不替换首次登记的条目。
  test("同 deliveryId 不同代次重复登记抛 MALFORMED_FRAME", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS - 1);
    const error = expectSyncErrorCode(() => tracker.track(DELIVERY_FIRST, NEXT_EPOCH), "MALFORMED_FRAME");

    // 错误信息只含 id 与两个代次：不带帧正文，可安全进入日志与 ERROR 帧的说明字段。
    expect(error.message).toBe(
      `ack timeout rejected: deliveryId ${DELIVERY_FIRST} is already tracked with transportEpoch ` +
        `${TRANSPORT_EPOCH}, received ${NEXT_EPOCH}`,
    );
    expect(tracker.outstandingCount()).toBe(1);

    // 抛错不改动首次登记：期限仍从首次登记起算，超期仍归因到原代次。
    clock.advance(1);
    expect(tracker.scan()).toEqual([{ deliveryId: DELIVERY_FIRST, transportEpoch: TRANSPORT_EPOCH }]);
  });

  // ACK 到达即注销：结算后不得再被扫描成超期，否则已确认的投递会误断连接。
  test("settle 注销已登记投递并返回 true", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    expect(tracker.settle(DELIVERY_FIRST)).toBe(true);
    expect(tracker.outstandingCount()).toBe(0);

    clock.advance(ACK_DEADLINE_MS);
    expect(tracker.scan()).toEqual([]);
  });

  // 未登记与重复结算都只是无效果，不是异常：迟到 ACK、伪造 id 与重复 ACK 都走这条路。
  test("settle 未登记或重复结算返回 false 且不抛错", () => {
    const { tracker } = makeTracker();

    expect(tracker.settle(DELIVERY_FIRST)).toBe(false);
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);
    expect(tracker.settle(DELIVERY_FIRST)).toBe(true);
    expect(tracker.settle(DELIVERY_FIRST)).toBe(false);
  });

  // 扫描顺序必须是登记顺序：日志与断言都依赖稳定顺序，第二次扫描也要给出同一结果。
  test("scan 按登记顺序返回且重复扫描结果一致", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_SECOND, TRANSPORT_EPOCH);
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);
    tracker.track(DELIVERY_THIRD, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS);

    expect(expiredIds(tracker)).toEqual([DELIVERY_SECOND, DELIVERY_FIRST, DELIVERY_THIRD]);
    // 扫描是只读查询：超期条目保留到 settle/reset，调用方才能在一次 tick 里既取证据又决定动作。
    expect(expiredIds(tracker)).toEqual([DELIVERY_SECOND, DELIVERY_FIRST, DELIVERY_THIRD]);
    expect(tracker.outstandingCount()).toBe(3);
  });

  // 时间回拨只会推迟超期，不会把健康投递误判为超期（负差值不满足 `>= ackDeadlineMs`）。
  test("时钟回退不会把未到期的投递误判为超期", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS);
    clock.rewind(ACK_DEADLINE_MS * 2);

    expect(tracker.scan()).toEqual([]);
    expect(tracker.outstandingCount()).toBe(1);
  });

  // reset 是断连清账：清空全部条目，之后同一 id 可重新登记并以新时刻起算。
  test("reset 清空在途条目并允许重新登记同一 deliveryId", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);
    tracker.track(DELIVERY_SECOND, TRANSPORT_EPOCH);
    clock.advance(ACK_DEADLINE_MS);
    expect(expiredIds(tracker)).toHaveLength(2);

    tracker.reset();

    expect(tracker.outstandingCount()).toBe(0);
    expect(tracker.scan()).toEqual([]);

    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);
    expect(tracker.scan()).toEqual([]);
    clock.advance(ACK_DEADLINE_MS);
    expect(expiredIds(tracker)).toEqual([DELIVERY_FIRST]);
  });

  // 每条投递各自计时：先登记的先超期，后来的投递不得被前者的期限提前带走。
  test("各投递期限独立，先登记的先超期", () => {
    const { tracker, clock } = makeTracker();
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(ACK_DEADLINE_MS - 1);
    tracker.track(DELIVERY_SECOND, TRANSPORT_EPOCH);
    clock.advance(1);

    expect(expiredIds(tracker)).toEqual([DELIVERY_FIRST]);
    expect(tracker.outstandingCount()).toBe(2);
  });

  // 期限非法会让所有投递「立刻超期」或「永不超期」，必须在装配期就拒绝而不是运行期静默。
  test("ackDeadlineMs 非正或非整数时抛 ADMISSION_REJECTED", () => {
    expectSyncErrorCode(() => makeTracker({ ackDeadlineMs: 0 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeTracker({ ackDeadlineMs: -1 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeTracker({ ackDeadlineMs: 0.5 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeTracker({ ackDeadlineMs: Number.NaN }), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => makeTracker({ ackDeadlineMs: Number.POSITIVE_INFINITY }), "ADMISSION_REJECTED");
  });

  // 标识违规与帧层同口径：空串是畸形帧、超长是标识过长，且违规登记不留任何条目。
  test("非法 deliveryId / transportEpoch 在登记与结算时被拒绝", () => {
    const { tracker } = makeTracker();

    expectSyncErrorCode(() => tracker.track("", TRANSPORT_EPOCH), "MALFORMED_FRAME");
    expectSyncErrorCode(() => tracker.track(DELIVERY_FIRST, ""), "MALFORMED_FRAME");
    expectSyncErrorCode(
      () => tracker.track("d".repeat(MAX_IDENTIFIER_BYTES + 1), TRANSPORT_EPOCH),
      "IDENTIFIER_TOO_LONG",
    );
    expectSyncErrorCode(() => tracker.settle(""), "MALFORMED_FRAME");

    expect(tracker.outstandingCount()).toBe(0);
  });

  // 生效期限只能来自 capacity/profile 的声明常量（30s），不得在本层另抄一份数值。
  test("按 profile 的 ackDeadlineMs 装配时边界与声明一致", () => {
    const clock = new TestClock();
    const tracker = createAckTimeoutTracker({ clock, ackDeadlineMs: CONCURRENCY_LIMITS.ackDeadlineMs });
    tracker.track(DELIVERY_FIRST, TRANSPORT_EPOCH);

    clock.advance(CONCURRENCY_LIMITS.ackDeadlineMs - 1);
    expect(tracker.scan()).toEqual([]);

    clock.advance(1);
    expect(expiredIds(tracker)).toEqual([DELIVERY_FIRST]);
  });
});
