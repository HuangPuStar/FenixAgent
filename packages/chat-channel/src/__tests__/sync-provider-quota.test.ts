import { describe, expect, test } from "bun:test";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import { type AckLedger, type AckRecord, createAckLedger } from "../sync/provider/ack-ledger";
import {
  createQuotaController,
  type QuotaController,
  type QuotaControllerOptions,
  type TaskClass,
} from "../sync/provider/quota";

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

/**
 * 测试窗口取 4096 字节：份额可按 13 分之几手算，权重比例与设计 §10.5 一致
 * （实时 8 / 当前历史 3 / 后台历史 1，控制记 1），结果仍是「一小段字节能表示的比例」。
 */
const WINDOW_BYTES = 4096;
const SOCKET_WATERMARK = WINDOW_BYTES;
const MAX_DIRTY_DOCS = 128;
/** 生产窗口：512KiB 是单连接**最高值**，用字面量锁定「初始不预分配」。 */
const PRODUCTION_WINDOW_BYTES = 524288;
const FAIRNESS: Readonly<Record<TaskClass, number>> = {
  control: 1,
  realtime: 8,
  "history-current": 3,
  "history-background": 1,
};
// 份额 = floor(4096 × 权重 / 13)：控制 315、实时 2520、当前历史 945、后台历史 315（合计 4095 ≤ 窗口）。
const SHARE_CONTROL = 315;
const SHARE_REALTIME = 2520;
const SHARE_HISTORY_BACKGROUND = 315;

function makeQuota(overrides: Partial<QuotaControllerOptions> = {}): QuotaController {
  return createQuotaController({
    maxOutstandingBytes: WINDOW_BYTES,
    socketHighWatermark: SOCKET_WATERMARK,
    fairness: FAIRNESS,
    maxDirtyDocs: MAX_DIRTY_DOCS,
    ...overrides,
  });
}

const TRANSPORT_EPOCH = "tx_0123456789abcdef";
const REPLACED_EPOCH = "tx_0011223344556677";
const DELIVERY_ID = "dlv_0123456789abcdef";
const NEXT_DELIVERY_ID = "dlv_0011223344556677";
const DOC_ID = "doc-content-gen1-block0";

function ackRecord(overrides: Partial<AckRecord> = {}): AckRecord {
  return {
    transportEpoch: TRANSPORT_EPOCH,
    deliveryId: DELIVERY_ID,
    docId: DOC_ID,
    fromSeq: 1,
    toSeq: 1,
    bytes: 1024,
    taskClass: "realtime",
    ...overrides,
  };
}

interface LedgerHarness {
  readonly ledger: AckLedger;
  readonly releases: Array<{ taskClass: TaskClass; bytes: number }>;
}

/** 账本接到真实额度账目上：归还若被额度账本拒绝，测试会直接抛错，不必额外断言。 */
function wire(quota: QuotaController): LedgerHarness {
  const releases: Array<{ taskClass: TaskClass; bytes: number }> = [];
  const ledger = createAckLedger({
    onRelease: (taskClass, bytes) => {
      releases.push({ taskClass, bytes });
      quota.release(taskClass, bytes);
    },
  });
  return { ledger, releases };
}

describe("单连接发送额度（设计 §8.5）", () => {
  // 512KiB 是单连接最高值而不是每条连接预分配：预分配会把名义额度变成真实内存，初始账目必须为 0。
  test("初始 outstanding 为 0，只有真的授予才占用字节", () => {
    const quota = makeQuota({
      maxOutstandingBytes: PRODUCTION_WINDOW_BYTES,
      socketHighWatermark: PRODUCTION_WINDOW_BYTES,
    });
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 0, pendingTasks: 0 });
    expect(quota.tryReserve("realtime", 1024, 0)).toBe(true);
    expect(quota.snapshot()).toEqual({ outstandingBytes: 1024, grantedBytes: 1024, pendingTasks: 1 });
  });

  // 额度覆盖已发送未 ACK 字节：窗口被在途字节占满后拒绝新帧，归还后才恢复。
  test("未 ACK 字节占满窗口后拒绝新帧，release 归还后恢复", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("realtime", WINDOW_BYTES, 0)).toBe(true);
    expect(quota.snapshot().outstandingBytes).toBe(WINDOW_BYTES);
    expect(quota.tryReserve("realtime", 1, 0)).toBe(false);
    quota.release("realtime", WINDOW_BYTES);
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: WINDOW_BYTES, pendingTasks: 0 });
    expect(quota.tryReserve("realtime", 1, 0)).toBe(true);
  });

  // 发送前必须同时检查 bufferedAmount + 编码帧字节 ≤ socket 硬水位：相等放行，越 1 字节拒绝。
  test("socket 水位按 bufferedAmount + 编码帧字节判定，边界取等号", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("control", 96, SOCKET_WATERMARK - 96)).toBe(true);
    const granted = quota.snapshot();
    expect(quota.tryReserve("control", 97, SOCKET_WATERMARK - 96)).toBe(false);
    expect(quota.snapshot()).toEqual(granted);
    expect(quota.tryReserve("control", 97, SOCKET_WATERMARK - 97)).toBe(true);
  });

  // 参数违规是调用方缺陷而不是额度不足：负数会凭空造额度、NaN 会让比较恒不成立，必须立刻抛出。
  test("非法参数与未知类目抛 ADMISSION_REJECTED，且不留半途账目", () => {
    const quota = makeQuota();
    expectSyncErrorCode(() => quota.tryReserve("realtime", 0, 0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.tryReserve("realtime", -1, 0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.tryReserve("realtime", 1.5, 0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.tryReserve("realtime", Number.NaN, 0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.tryReserve("realtime", 1, -1), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.tryReserve("background" as unknown as TaskClass, 1, 0), "ADMISSION_REJECTED");
    expectSyncErrorCode(() => quota.release("realtime", 0), "ADMISSION_REJECTED");
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 0, pendingTasks: 0 });
  });

  // 配置自相矛盾必须装配期就失败：窗口高于 socket 水位会授予物理上发不出的额度。
  test("构造期校验窗口与水位的相对关系、权重与 dirty 上限", () => {
    expectSyncErrorCode(() => makeQuota({ maxOutstandingBytes: 8192 }), "ADMISSION_REJECTED");
    expectSyncErrorCode(
      () => makeQuota({ fairness: { control: 1, realtime: 8, "history-current": 3, "history-background": 0 } }),
      "ADMISSION_REJECTED",
    );
    expectSyncErrorCode(() => makeQuota({ maxDirtyDocs: 0 }), "ADMISSION_REJECTED");
  });

  // 多退字节会凭空造出容量并让后续 ACK 永久错位，因此超过该类在途字节的归还在源头拒绝。
  test("release 按类目独立记账，不得超过该类在途字节", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("realtime", 100, 0)).toBe(true);
    // 实时占用的字节不能作为后台历史的归还依据
    expectSyncErrorCode(() => quota.release("history-background", 100), "ADMISSION_REJECTED");
    expect(quota.tryReserve("history-background", 100, 0)).toBe(true);
    expectSyncErrorCode(() => quota.release("history-background", 101), "ADMISSION_REJECTED");
    expect(quota.snapshot().outstandingBytes).toBe(200);
    quota.release("history-background", 100);
    expect(quota.snapshot().outstandingBytes).toBe(100);
  });
});

describe("四类任务公平与轮转（设计 §8.5、§10.5）", () => {
  // 份额按权重分配：实时最大，历史类最低但非零；其它提问类还有余量时，任何类都不得越过自己的份额。
  test("份额按权重分配，实时不得在其它类用尽前越份额，用尽后轮转", () => {
    const quota = makeQuota();
    // 实时用满自己的份额 2520 = floor(4096 × 8 / 13)
    expect(quota.tryReserve("realtime", SHARE_REALTIME, 0)).toBe(true);
    // 后台历史也提了问（1 字节），它的份额 315 = floor(4096 × 1 / 13) 还远没用完
    expect(quota.tryReserve("history-background", 1, 0)).toBe(true);
    // 实时在份额外再要 1 字节被拒：后台历史还有余量，本轮的额度要留给它
    expect(quota.tryReserve("realtime", 1, 0)).toBe(false);
    expect(quota.snapshot().outstandingBytes).toBe(SHARE_REALTIME + 1);
    // 后台历史用满最低份额，本轮提问类全部用尽
    expect(quota.tryReserve("history-background", SHARE_HISTORY_BACKGROUND - 1, 0)).toBe(true);
    // 轮转在同一调用内完成：实时重新获得整份份额，调用方不需要额外重试
    expect(quota.tryReserve("realtime", 1, 0)).toBe(true);
    expect(quota.snapshot()).toEqual({
      outstandingBytes: SHARE_REALTIME + SHARE_HISTORY_BACKGROUND + 1,
      grantedBytes: SHARE_REALTIME + SHARE_HISTORY_BACKGROUND + 1,
      pendingTasks: 4,
    });
  });

  // base 快照（协议上限 288KiB）大于历史类份额：在途为零的类允许发一帧超出份额的帧，但只此一帧。
  test("超出份额的单帧只允许空载类发送，且立即用尽本轮份额", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("history-background", 1280, 0)).toBe(true);
    // 实时提问保证轮次不会因为只有后台历史提问而立刻推进
    expect(quota.tryReserve("realtime", 1, 0)).toBe(true);
    expect(quota.tryReserve("history-background", 1, 0)).toBe(false);
    // 超出份额的单帧仍受连接窗口约束，不能借空载放行无限占用
    const tight = makeQuota();
    expect(tight.tryReserve("realtime", 3000, 0)).toBe(true);
    expect(tight.tryReserve("history-background", 1097, 0)).toBe(false);
    expect(tight.tryReserve("history-background", 1096, 0)).toBe(true);
  });

  // 静默类不得挡住轮次结束：发过一帧后不再发送的类把帧结清即退出轮次判定，其它类仍可用满整窗；
  // 若让它一直挡住轮次（它永远进不了 spent），持续发送的类会退化成每类一帧在途。
  test("发过一帧后静默的类不再挡住后续轮次", () => {
    const quota = makeQuota({
      maxOutstandingBytes: PRODUCTION_WINDOW_BYTES,
      socketHighWatermark: PRODUCTION_WINDOW_BYTES,
    });
    const frameBytes = 4_096;
    // 握手期发过一帧控制流并结清，此后控制类静默
    expect(quota.tryReserve("control", 100, 0)).toBe(true);
    quota.release("control", 100);
    let granted = 0;
    while (quota.tryReserve("realtime", frameBytes, 0)) granted += 1;
    // 实时类可用满整窗（512KiB / 4KiB = 128 帧），而不是只拿到自己那一份份额后停在一帧
    expect(granted).toBe(PRODUCTION_WINDOW_BYTES / frameBytes);
  });

  // 权重悬殊时份额下限 1 字节托底：历史类仍然拿得到额度，否则历史会永久饥饿（设计 §8.5）。
  test("极端权重下份额下限仍保证历史类非零额度", () => {
    const quota = makeQuota({
      maxOutstandingBytes: 100,
      socketHighWatermark: 100,
      fairness: { control: 1, realtime: 1000, "history-current": 1, "history-background": 1 },
    });
    // 实时 99 = floor(100 × 1000 / 1003)，其余三类 floor(100 / 1003) = 0 → 下限抬到 1
    expect(quota.tryReserve("realtime", 99, 0)).toBe(true);
    expect(quota.tryReserve("history-background", 1, 0)).toBe(true);
    quota.release("realtime", 99);
    // 归还腾出窗口后进入下一轮，历史类仍能拿到自己的 1 字节；份额为 0 时这一请求必然被拒
    expect(quota.tryReserve("history-background", 1, 0)).toBe(true);
    expect(quota.snapshot().outstandingBytes).toBe(2);
  });

  // 控制流也限频：字节计入同一连接窗口，且不得借高优先级挤出其它类的份额。
  test("控制流受份额与总窗口双重约束，不能绕过总预算", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("control", SHARE_CONTROL, 0)).toBe(true);
    expect(quota.tryReserve("realtime", 1, 0)).toBe(true);
    // 控制类在份额外再要 1 字节被拒（实时类还没用完份额）
    expect(quota.tryReserve("control", 1, 0)).toBe(false);
    // 控制类已占用的字节计入同一窗口：其余类可授予的字节按剩余窗口收缩
    const remaining = WINDOW_BYTES - SHARE_CONTROL - 1;
    expect(quota.tryReserve("history-current", remaining + 1, 0)).toBe(false);
    expect(quota.tryReserve("history-current", remaining, 0)).toBe(true);
    expect(quota.snapshot().outstandingBytes).toBe(WINDOW_BYTES);
  });

  // dirty 集合最多 128 个：超限说明连接已跟不上订阅变化，只能关闭连接重新握手。
  test("dirty 集合幂等，超限抛 CAPACITY_EXCEEDED 要求重连", () => {
    const quota = makeQuota();
    quota.markDirty("doc-1");
    quota.markDirty("doc-1");
    expect(quota.dirtyCount()).toBe(1);
    quota.clearDirty("doc-1");
    quota.clearDirty("doc-1");
    expect(quota.dirtyCount()).toBe(0);

    for (let index = 0; index < MAX_DIRTY_DOCS; index += 1) {
      quota.markDirty(`doc-${index}`);
    }
    expect(quota.dirtyCount()).toBe(MAX_DIRTY_DOCS);
    const error = expectSyncErrorCode(() => quota.markDirty("doc-overflow"), "CAPACITY_EXCEEDED");
    expect(error.message).toContain(String(MAX_DIRTY_DOCS));
    expect(quota.dirtyCount()).toBe(MAX_DIRTY_DOCS);
    // 释放名额后可继续标记：只有超限那一笔被拒
    quota.clearDirty("doc-0");
    quota.markDirty("doc-overflow");
    expect(quota.dirtyCount()).toBe(MAX_DIRTY_DOCS);
  });

  // docId 走协议层标识规则：非法标识会污染后续补差判定，因此在入口拒绝而不静默纳入集合。
  test("dirty 的 docId 必须通过标识校验", () => {
    const quota = makeQuota();
    expectSyncErrorCode(() => quota.markDirty(""), "MALFORMED_FRAME");
    expectSyncErrorCode(() => quota.markDirty("doc\u0000id"), "MALFORMED_FRAME");
    expectSyncErrorCode(() => quota.markDirty("x".repeat(257)), "IDENTIFIER_TOO_LONG");
    expectSyncErrorCode(() => quota.clearDirty("x".repeat(257)), "IDENTIFIER_TOO_LONG");
    expect(quota.dirtyCount()).toBe(0);
  });

  // 断连清账（设计 §8.5）：额度、轮次与 dirty 一并归零，重连重新握手后按新连接记账。
  test("reset 清账后额度、轮次与 dirty 全部归零", () => {
    const quota = makeQuota();
    expect(quota.tryReserve("realtime", 100, 0)).toBe(true);
    expect(quota.tryReserve("control", 50, 0)).toBe(true);
    quota.markDirty("doc-1");
    expect(quota.snapshot()).toEqual({ outstandingBytes: 150, grantedBytes: 150, pendingTasks: 2 });
    quota.reset();
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 0, pendingTasks: 0 });
    expect(quota.dirtyCount()).toBe(0);
    expect(quota.tryReserve("realtime", 150, 0)).toBe(true);
    expect(quota.snapshot().outstandingBytes).toBe(150);
  });
});

describe("ACK 账本（设计 §8.5）", () => {
  // 同代次 ACK 按服务端记录值归还，并回到正确的类目账目（历史额度不会被归还给实时）。
  test("同代次 ACK 归还记录字节与对应类目", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("history-background", 300, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 300, taskClass: "history-background" }));
    expect(ledger.outstandingCount()).toBe(1);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(300);
    expect(releases).toEqual([{ taskClass: "history-background", bytes: 300 }]);
    expect(ledger.outstandingCount()).toBe(0);
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 300, pendingTasks: 0 });
  });

  // 重复与伪造的 ACK 都不加额度：查无此投递就是零归还，客户端无法靠重传或猜 id 放大窗口。
  test("重复 ACK 与未知 deliveryId 都不加额度", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("realtime", 1024, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 1024 }));
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(1024);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(0);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: NEXT_DELIVERY_ID, result: "processed" })).toBe(
      0,
    );
    expect(releases).toHaveLength(1);
    expect(ledger.outstandingCount()).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });

  // 归还失败必须可重试：`onRelease` 抛错时投递记录保留，额度不会静默泄漏，修正账目后同一 ACK 仍能结清。
  test("归还失败时记录保留，同一 ACK 可重试结清", () => {
    const quota = makeQuota();
    const released: number[] = [];
    let failing = true;
    const ledger = createAckLedger({
      onRelease: (taskClass, bytes) => {
        if (failing) {
          failing = false;
          throw new SyncProtocolError("ADMISSION_REJECTED", { message: "quota ledger is out of sync" });
        }
        released.push(bytes);
        quota.release(taskClass, bytes);
      },
    });
    expect(quota.tryReserve("realtime", 1024, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 1024 }));

    // 第一次结清：回调的异常原样抛出，记录与额度账目都不动
    expect(() =>
      ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" }),
    ).toThrow(SyncProtocolError);
    expect(ledger.outstandingCount()).toBe(1);
    expect(quota.snapshot().outstandingBytes).toBe(1024);

    // 账目修正后重试：同一 ACK 归还到正确类目，不留残记录
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(1024);
    expect(released).toEqual([1024]);
    expect(ledger.outstandingCount()).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });

  // 旧代次 ACK 凭的是上一代次账本：不释放当前额度，记录留给本代次 ACK 结清。
  test("旧 transportEpoch 的 ACK 不加额度，记录保留到同代次结清", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("control", 128, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 128, taskClass: "control" }));
    expect(ledger.settle({ transportEpoch: REPLACED_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(0);
    expect(ledger.outstandingCount()).toBe(1);
    expect(quota.snapshot().outstandingBytes).toBe(128);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(128);
    expect(releases).toEqual([{ taskClass: "control", bytes: 128 }]);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });

  // 未被交接的投递由服务端自结算：它从未上线、客户端无从回执，字节必须归还（规格 §2.4），且同一投递只归还
  // 一次——重复归还等于凭空加额度，窗口会随一次饱和而膨胀（设计 §15.2 T10「额度不膨胀」）。
  test("abandon 只归还一次：重复调用返回 0，账目与额度一起归零", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("history-current", 439, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 439, taskClass: "history-current" }));

    expect(ledger.abandon({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID })).toBe(439);
    expect(releases).toEqual([{ taskClass: "history-current", bytes: 439 }]);
    expect(ledger.outstandingCount()).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    expect(ledger.abandon({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID })).toBe(0);
    expect(releases).toHaveLength(1);
  });

  // 未知 id 与异代次都不产生额度：前者是重复或伪造的自结算，后者凭的是上一代次账本，加额度会放大当前窗口。
  test("abandon 对未知 id 与旧代次都不归还字节", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("realtime", 512, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 512 }));

    expect(ledger.abandon({ transportEpoch: TRANSPORT_EPOCH, deliveryId: NEXT_DELIVERY_ID })).toBe(0);
    expect(ledger.abandon({ transportEpoch: REPLACED_EPOCH, deliveryId: DELIVERY_ID })).toBe(0);
    expect(releases).toEqual([]);
    expect(ledger.outstandingCount()).toBe(1);
    expect(quota.snapshot().outstandingBytes).toBe(512);
  });

  // rejected 只表示本轮 apply 失败：字节已离开在途账目，同样要结清传输额度（设计 §8.6 第 4 条）。
  test("rejected 结果同样结清传输额度", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("realtime", 2048, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 2048 }));
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "rejected" })).toBe(2048);
    expect(releases).toEqual([{ taskClass: "realtime", bytes: 2048 }]);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });

  // ACK 只结清传输额度，不推进 base/appliedSeq（设计 §8.6 第 4 条）：对外只能有这四个方法。
  // 账本面只有「记账 + 两条归还路径 + 观测 + 清账」：`settle` 走客户端回执，`abandon` 走服务端自结算
  // （投递在交接前被搁置位顶替，从未上线、客户端无从回执，字节必须归还，规格 §2.4）。
  test("账本接口只暴露结清传输额度所需的方法", () => {
    const { ledger } = wire(makeQuota());
    expect(Object.keys(ledger).sort()).toEqual(["abandon", "outstandingCount", "record", "reset", "settle"]);
  });

  // 重复帧按 deliveryId 只记一次：重复记账既不增长在途投递数，也不会归还两次。
  test("重复 record 同一 deliveryId 只记一次", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("realtime", 512, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 512 }));
    ledger.record(ackRecord({ bytes: 512 }));
    expect(ledger.outstandingCount()).toBe(1);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(512);
    expect(releases).toHaveLength(1);
  });

  // 同 id 不同内容说明 deliveryId 被复用：既不覆盖也不采纳，否则真实投递的账目会被顶替。
  test("同一 deliveryId 的冲突记录抛错且不覆盖既有账目", () => {
    const quota = makeQuota();
    const { ledger } = wire(quota);
    expect(quota.tryReserve("realtime", 512, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 512 }));
    expectSyncErrorCode(() => ledger.record(ackRecord({ bytes: 640 })), "MALFORMED_FRAME");
    expect(ledger.outstandingCount()).toBe(1);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(512);
  });

  // 记录内容受边界校验：字节数、序号与标识非法时立刻失败，不留半条账目。
  test("record 校验字节数、序号与标识", () => {
    const { ledger } = wire(makeQuota());
    expectSyncErrorCode(() => ledger.record(ackRecord({ bytes: 0 })), "MALFORMED_FRAME");
    expectSyncErrorCode(() => ledger.record(ackRecord({ bytes: -1 })), "MALFORMED_FRAME");
    expectSyncErrorCode(() => ledger.record(ackRecord({ fromSeq: 3, toSeq: 2 })), "MALFORMED_FRAME");
    expectSyncErrorCode(() => ledger.record(ackRecord({ fromSeq: -1 })), "MALFORMED_FRAME");
    expectSyncErrorCode(() => ledger.record(ackRecord({ deliveryId: "x".repeat(257) })), "IDENTIFIER_TOO_LONG");
    expect(ledger.outstandingCount()).toBe(0);
  });

  // 记录保存副本：调用方在 record 之后改写对象不得改变归还值，否则账目可由外部输入改写。
  test("记录保存副本，调用方改写不影响归还值", () => {
    const quota = makeQuota();
    const { ledger } = wire(quota);
    expect(quota.tryReserve("realtime", 700, 0)).toBe(true);
    const entry = { ...ackRecord({ bytes: 700 }) };
    ledger.record(entry);
    entry.bytes = 1;
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(700);
  });

  // 断连清账：额度账本与投递账本同时归零，旧代次 ACK 之后不会再影响新账目。
  test("reset 清账后旧 ACK 不再归还", () => {
    const quota = makeQuota();
    const { ledger, releases } = wire(quota);
    expect(quota.tryReserve("realtime", 1024, 0)).toBe(true);
    expect(quota.tryReserve("control", 128, 0)).toBe(true);
    ledger.record(ackRecord({ bytes: 1024 }));
    ledger.record(ackRecord({ deliveryId: NEXT_DELIVERY_ID, bytes: 128, taskClass: "control" }));
    expect(ledger.outstandingCount()).toBe(2);
    quota.reset();
    ledger.reset();
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 0, pendingTasks: 0 });
    expect(ledger.outstandingCount()).toBe(0);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(0);
    expect(releases).toEqual([]);
  });

  // 端到端：两个类目的帧各自结清，旧代次与重复 ACK 一点额度都不还，归还量恒等于服务端记录值。
  test("额度与账本联动：按记录值精确归还，非法 ACK 不动账目", () => {
    const quota = makeQuota();
    const { ledger } = wire(quota);
    expect(quota.tryReserve("realtime", 1024, 0)).toBe(true);
    expect(quota.tryReserve("history-current", 2048, 0)).toBe(true);
    expect(quota.snapshot()).toEqual({ outstandingBytes: 3072, grantedBytes: 3072, pendingTasks: 2 });
    ledger.record(ackRecord({ bytes: 1024 }));
    ledger.record(ackRecord({ deliveryId: NEXT_DELIVERY_ID, bytes: 2048, taskClass: "history-current" }));

    expect(ledger.settle({ transportEpoch: REPLACED_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(0);
    // 伪造/未来的 deliveryId 同样查无此投递：窗口一字不退
    expect(
      ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: "dlv_deadbeefdeadbeef", result: "processed" }),
    ).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(3072);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(1024);
    expect(quota.snapshot().outstandingBytes).toBe(2048);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: DELIVERY_ID, result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(2048);
    expect(ledger.settle({ transportEpoch: TRANSPORT_EPOCH, deliveryId: NEXT_DELIVERY_ID, result: "rejected" })).toBe(
      2048,
    );
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 3072, pendingTasks: 0 });
  });
});
