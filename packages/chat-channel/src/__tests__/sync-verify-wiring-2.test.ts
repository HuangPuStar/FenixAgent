// packages/chat-channel/src/__tests__/sync-verify-wiring-2.test.ts
// V2 第二轮对抗验证（身份 V2）：目标不是复述 wave4 的修正，而是证明它**没有真正解决问题**或引入了新问题。
//
// 观察面全部是黑盒可观测事实：发到传输端口的字节序列、传输层收到的关闭请求、网关自报的在途投递数、
// 真实账本与额度的账目、入口记录快照、导入分派的池占用与在飞结算、以及「按已提交字节重放出的文档」。
// store、会话、额度、账本、出帧网关、控制 governor、ACK 超时登记、构建池、写入层全部用真实实现；注入的替身
// 只有传输端口（宿主 WS 边界）、假时钟、以及历史分派的记录源/提交口（分派器的对外缝本身）。
//
// 每个用例的期望值取设计/规格契约，失败消息里的 Received 就是实际观测值。被顶替/丢失的投递一律通过
// 「客户端收到的序号集合」与「账本残留」两条独立证据链交叉确认，不依赖实现自报的计数。

import { describe, expect, test } from "bun:test";

import { SyncProtocolError } from "../sync/protocol/errors";

import { decodeSyncFrame, encodeSyncFrame } from "../sync/protocol/frames";
import {
  ACK_DEADLINE_MS,
  ackDirect,
  ackReceived,
  attemptCount,
  baseSeqOf,
  CONTENT_DOC,
  CONTENT_DOCS,
  connect,
  decodedData,
  decodedUpdates,
  driveSession,
  helloFrame,
  isDataFrame,
  isDataUpdate,
  ROUND_TEXT,
  setupDirect,
  setupScope,
  subscribeFrame,
  textEvent,
  updateGaps,
  WRITE_DOC,
} from "./sync-verify-wiring-2-fixture";

describe("V2 出帧网关：搁置位顶替（被顶替的投递去哪了）", () => {
  // 契约（设计 §8.5「丢弃的是冗余发送任务，不是唯一内容」+ §8.3「发现序号缺口…申请补齐」+ §15.2 T10「缺口可
  // 补齐、额度不膨胀」）：持续拒发时被后一帧顶替掉的增量**不再重发**——内容可由该 Doc 的已提交状态补差，客户端
  // 的缺口检测会申请补齐。本层必须付出的代价只有两件：缺口只允许出现在被丢弃的那一段（其后必须连续），以及
  // 从未上线的投递不得占住窗口字节（下一条用例）。
  test("持续拒发期间被顶替的投递不再重发：缺口只出现在被丢弃的那一段，其后增量连续", async () => {
    const h = await setupScope();
    await connect(h);
    const start = baseSeqOf(h, WRITE_DOC) + 1;

    // 持续拒发：每轮 tick 里先重试搁置帧（仍被拒），再由会话产出新帧（同样被拒并顶替搁置位）。
    h.transport.refuse(isDataUpdate);
    for (const turn of ["turn-1", "turn-2", "turn-3"]) {
      await h.runtime.acceptIngress(textEvent(ROUND_TEXT, turn));
      await h.runtime.tick();
    }
    const refused = decodedUpdates(h.transport.refused);
    // 前置：确实发生了顶替（被拒帧数 > 搁置位容量 1）。
    expect(refused.length).toBeGreaterThan(1);
    const dropped = refused[0];
    const survivor = refused.at(-1);
    if (dropped === undefined || survivor === undefined) throw new Error("expected refused data frames");

    h.transport.stopRefusing();
    for (let round = 0; round < 6; round += 1) {
      await h.runtime.tick();
      await ackReceived(h);
    }

    // 被顶替的那一条：不再重发，也不因此断连（丢弃是设计许可的，补偿责任在客户端补齐）。
    expect({
      delivered: decodedUpdates(h.transport.sent).some((frame) => frame.deliveryId === dropped.deliveryId),
      closeReasons: h.transport.closeReasons.length,
    }).toEqual({ delivered: false, closeReasons: 0 });
    // 它在被顶替之前至少被重试过一次（搁置重试对每一帧都生效，被顶替不是「没进过重试」）。
    expect(attemptCount(h.transport.attempts, dropped.deliveryId)).toBeGreaterThanOrEqual(2);
    // 缺口恰好是被丢弃的那一段（起点到「活下来那一帧」的起点之前），其后增量连续铺满到最大 toSeq。
    expect(updateGaps(h.transport.sent, WRITE_DOC, start)).toEqual([`missing ${start}..${survivor.fromSeq - 1}`]);
  });

  // 契约（设计 §8.5「额度覆盖已发送未 ACK 字节」+ 规格 §2.4「`send` 返回 false 时归还上次预留」）：连接窗口是
  // 「已发送未 ACK 字节」的唯一上限；被顶替的帧既没发出也不可能被回执，它占用的字节必须由某条路径归还，否则窗口
  // 被永久吃掉（T10「额度不膨胀」）。本用例在真实账本与真实额度上检查：客户端回执全部收到的帧之后，账本与额度
  // 必须归零。
  test("被顶替的投递永久占住连接窗口：回执全部收到的帧后账本与额度仍不为零", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    // 一次订阅两份文档：两帧 DOC_BASE 同批交接，持续拒发时第二帧顶替第一帧。
    h.transport.refuse(isDataFrame);
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame(CONTENT_DOCS)));
    const refusedBases = decodedData(h.transport.refused);
    expect(refusedBases.length).toBe(2);
    const superseded = refusedBases[0];
    if (superseded === undefined) throw new Error("expected the first DOC_BASE to be refused");

    h.transport.stopRefusing();
    await driveSession(h);
    await ackDirect(h);
    await driveSession(h);

    // 期望：账本只剩「已发出未回执」的投递（此刻为 0），窗口归还干净。
    expect({ ledger: h.ledger.outstandingCount(), outstanding: h.quota.snapshot().outstandingBytes }).toEqual({
      ledger: 0,
      outstanding: 0,
    });
  });

  // 契约（设计 §8.5 + §15.2 T10「额度不膨胀」）：被顶替的投递不需要断连兜底——它是冗余发送任务，缺口由客户端
  // 补齐；本层的义务只有两条：把它的窗口字节归还，以及在恢复后仍能继续交付后续增量（不是「清了账却拖住会话」）。
  test("被顶替的投递不触发断连：窗口归还后连接继续可用，期限推远也不会因此关闭", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    h.transport.refuse(isDataFrame);
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame(CONTENT_DOCS)));
    const superseded = decodedData(h.transport.refused)[0];
    if (superseded === undefined) throw new Error("expected the first DOC_BASE to be refused");

    h.transport.stopRefusing();
    await driveSession(h);
    await ackDirect(h);
    await driveSession(h);

    // 它从没上过线（客户端无从回执），也没被再尝试第二次（搁置位里只有后来那一帧）：因此没有需要补偿的在途状态。
    expect(attemptCount(h.transport.attempts, superseded.deliveryId)).toBe(1);
    // 回执覆盖所有已收到的帧之后账目归零——被顶替那一条的字节已由自结算归还（上一条用例的同一路径）。
    expect({ ledger: h.ledger.outstandingCount(), outstanding: h.quota.snapshot().outstandingBytes }).toEqual({
      ledger: 0,
      outstanding: 0,
    });

    // 断连兜底只属于「仍在搁置位里、发不出去」的那一帧：把期限推远也不会因这条被顶替的投递关闭连接。
    h.time.advance(ACK_DEADLINE_MS * 10);
    await driveSession(h);
    expect(h.transport.closeReasons).toEqual([]);
  });

  // 契约（规格 §2.4 发送失败语义 + 设计 §8.5 断连清账）：控制帧线上不带 deliveryId、客户端无从回执，也不像数据帧
  // 那样「可由 Doc 状态补差」——MANIFEST 丢了客户端就永远订不到内容。搁置位只有一位时补发不可能发生，于是它只剩
  // 一条合格的出路：以明确理由断连，让客户端重连重新握手。
  test("握手响应被数据帧顶替：连接以明确理由关闭，不停在无清单也无断连的半握手", async () => {
    const h = await setupDirect();
    h.transport.refuse(() => true);
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    // 握手响应（HELLO + MANIFEST）全被拒后，客户端的订阅请求把 DOC_BASE 送上搁置位并顶替它们。
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));

    h.transport.stopRefusing();
    for (let round = 0; round < 6; round += 1) {
      await driveSession(h);
      await ackDirect(h);
    }

    // 被顶替的 MANIFEST 不会补发（搁置位只留一位，而控制帧没有第二次产出它的入口），因此必须在顶替当刻就以
    // 明确理由关闭连接：客户端据此重连重新握手，不会停在「看起来健康、实际订不到内容」的半握手状态。
    const manifests = h.transport.sent.filter((bytes) => decodeSyncFrame(bytes).type === "MANIFEST");
    expect({ manifests: manifests.length, closeReasons: h.transport.closeReasons.length }).toEqual({
      manifests: 0,
      closeReasons: 1,
    });
    expect(h.transport.closeReasons[0]).toContain("was superseded before delivery");
  });

  // 回归对照（wave4 的修正本身）：只拒发一帧时不发生顶替，搁置帧必须在下一 tick 被重发且只被接受一次，
  // 全部回执后账目归零，期限届满也不该断连。本用例用来证明上面的失败不是夹具问题。
  test("对照：只拒发一帧时被正确补发一次，回执后账目归零且不断连", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    h.transport.refuse(isDataFrame, 1);
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    const refusedFrame = decodedData(h.transport.refused)[0];
    if (refusedFrame === undefined) throw new Error("expected one refused DOC_BASE");

    h.transport.stopRefusing();
    await driveSession(h);
    await ackDirect(h);
    await driveSession(h);

    expect(attemptCount(h.transport.attempts, refusedFrame.deliveryId)).toBe(2);
    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);
    h.time.advance(ACK_DEADLINE_MS * 10);
    await driveSession(h);
    expect(h.transport.closeReasons).toEqual([]);
  });
});

describe("V2 出帧网关：终态收敛与可重入", () => {
  // 契约（设计 §8.5 + 规格 §2.2 第 3 条）：ACK 超期必须关连接并清账，且只清一次；清账之后 tick 不得再推进
  // 会话（否则会按「已发出」继续推进游标）。
  test("ACK 超期只清账一次：关闭一次、在途归零、后续 tick 不再推进会话", async () => {
    const h = await setupScope();
    const gateway = await connect(h);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-timeout"));
    await h.runtime.tick();
    expect(gateway.outstandingDeliveries()).toBeGreaterThan(0);

    h.time.advance(ACK_DEADLINE_MS * 10);
    await h.runtime.tick();
    expect(h.transport.closeReasons.length).toBe(1);
    expect(gateway.outstandingDeliveries()).toBe(0);
    expect(gateway.scanTimeouts()).toBe(0);

    const attemptsAfterClose = h.transport.attempts.length;
    await h.runtime.tick();
    await h.runtime.tick();
    expect(h.transport.attempts.length).toBe(attemptsAfterClose);
    expect(h.transport.closeReasons.length).toBe(1);
  });

  // 契约（规格 §2.2 第 5 条）：`dispose` 幂等，且释放后不再产生任何定时器或写入；宿主重复 `close`
  // 不得重复关连接（重复清账会凭空造出额度）。
  test("close 与 dispose 幂等：重复关闭只关一次，终态后 tick 与入站都不再产生副作用", async () => {
    const h = await setupScope();
    const gateway = await connect(h);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-idempotent"));
    await h.runtime.tick();

    gateway.close("host socket closed");
    gateway.close("host socket closed again");
    expect(h.transport.closeReasons.length).toBe(1);
    expect(gateway.outstandingDeliveries()).toBe(0);

    const attemptsAfterClose = h.transport.attempts.length;
    await gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.tick();
    expect(h.transport.attempts.length).toBe(attemptsAfterClose);

    await h.runtime.dispose();
    await h.runtime.dispose();
    expect(h.transport.closeReasons.length).toBe(1);
    const error = await h.runtime.tick().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error instanceof SyncProtocolError ? error.code : "no error").toBe("RESOURCE_RETIRED");
  });

  // 契约（规格 §2.4 + 网关文件头偏差④）：搁置超期仍然发不出去时必须由本层关连接并清账一次；
  // 清账后搁置位不得再驱动出帧（否则出现「清了账但会话仍被驱动」）。
  test("搁置超期关连接一次并清空搁置位：清账后 driveWithheld 不再出帧", async () => {
    const h = await setupScope();
    const gateway = await connect(h);
    h.transport.refuse(isDataUpdate);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-withheld-expiry"));
    await h.runtime.tick();
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-withheld-expiry-2"));
    await h.runtime.tick();
    expect(h.transport.closeReasons).toEqual([]);

    h.time.advance(ACK_DEADLINE_MS * 2);
    await h.runtime.tick();
    expect(h.transport.closeReasons.length).toBe(1);
    expect(gateway.outstandingDeliveries()).toBe(0);

    gateway.driveWithheld();
    const attemptsAfterClose = h.transport.attempts.length;
    gateway.driveWithheld();
    expect(h.transport.attempts.length).toBe(attemptsAfterClose);
    expect(h.transport.closeReasons.length).toBe(1);
  });

  // 契约（设计 §8.6 + 规格 §2.4）：同一 deliveryId 只能被交接一次。并发 tick（宿主不串行等待）下
  // 重试与出帧交错不得把同一份投递发出两次，否则客户端会重复 apply 同一区间。
  test("并发 tick 交错时同一 deliveryId 不会被发出两次", async () => {
    const h = await setupScope();
    await connect(h);
    h.transport.refuse(isDataUpdate, 1);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-reentrant"));

    await Promise.all([h.runtime.tick(), h.runtime.tick(), h.runtime.tick()]);
    h.transport.stopRefusing();
    await Promise.all([h.runtime.tick(), h.runtime.tick(), h.runtime.tick()]);
    await ackReceived(h);

    const delivered = decodedData(h.transport.sent);
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const frame of delivered) {
      if (seen.has(frame.deliveryId)) duplicated.push(frame.deliveryId);
      seen.add(frame.deliveryId);
    }
    expect(duplicated).toEqual([]);
    expect(updateGaps(h.transport.sent, CONTENT_DOC, baseSeqOf(h, CONTENT_DOC) + 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// C 组（方向 4）：历史导入的背压、在飞结算与并发分派
// ---------------------------------------------------------------------------------------------------
