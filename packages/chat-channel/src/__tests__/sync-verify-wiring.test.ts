// packages/chat-channel/src/__tests__/sync-verify-wiring.test.ts
// 接线阶段的对抗验证（身份 C）：本文件只用来**证伪**，刻意不复述既有回归。每个用例都写明「设计/规格要求的期望」
// 与「实测到的实际」，失败用例即缺陷证据（期望值 = 契约，失败消息里的 Received = 实际）。
//
// 观察面全部是黑盒可观测事实：发到传输端口的字节、传输层收到的关闭请求、网关自报的在途投递数、入口记录的
// 快照与装配期校验结果。唯一注入的替身是传输端口（宿主 WS 的边界）与假时钟；store、会话、额度、账本、网关、
// 控制 governor、ACK 超时登记全部用真实实现，因此每条结论都跨过真实字节边界。
//
// 范围（规格 §2 的 G1–G6）：sync/runtime/**、sync/client/transport.ts、provider/control-governor.ts、
// provider/ack-timeout.ts。

import { describe, expect, test } from "bun:test";

import * as Y from "yjs";

import { createSyncClientTransport } from "../sync/client/transport";

import {
  type ApplyAckFrame,
  type DocBaseFrame,
  decodeSyncFrame,
  type ErrorFrame,
  encodeSyncFrame,
  SYNC_PROTOCOL_VERSION,
} from "../sync/protocol/frames";

import { createAckTimeoutTracker } from "../sync/provider/ack-timeout";

import { createControlGovernor } from "../sync/provider/control-governor";

import { resolveSyncRuntimeConfig, validateSyncRuntimeConfig } from "../sync/runtime/config";

import { createLiveIngress, type SyncIngressEvent } from "../sync/runtime/ingress";
import {
  ACK_DEADLINE_MS,
  ATTEMPT_ID,
  ackReceived,
  attemptCount,
  CONTENT_DOC,
  captureSyncError,
  carriesDelivery,
  connect,
  decodedUpdates,
  GENERATION,
  helloFrame,
  isDataUpdate,
  LIFECYCLE,
  ROUND_TEXT,
  SCOPE_KEY,
  StubWriter,
  SUB_EPOCH,
  setupScope,
  subscribeFrame,
  TestClock,
  TRANSPORT_EPOCH,
  textEvent,
  tightCapacity,
  WINDOW_BYTES,
} from "./sync-verify-wiring-fixture";

describe("对抗验证：出站数据帧被传输层拒发后的账目与补偿", () => {
  // 传输层 `send` 返回 false 是端口契约里的正常饱和信号（规格 §2.4）。被拒帧的字节由**会话**在 emit 时已计费
  // 并写入账本、`sendCursor` 同时推进；网关按裁决 D1 不持有额度，补偿责任因此落在网关自己：搁置该帧，`tick()`
  // 每 tick 重试同一份，直到交接成功或超过 `deadlines.ackMs`（`egress.ts:279-292`、文件头偏差④）。
  // 期望：瞬时饱和恢复后同一 `deliveryId` 被重发且**只被接受一次**；全部回执后账目归零、期限届满不断连。
  test("被拒发的数据帧被搁置并在下一 tick 重试：同一投递补齐一次，恢复后账目归零", async () => {
    const h = await setupScope();
    const gateway = await connect(h);

    // 只让「下一帧 DOC_UPDATE」被拒发一次：这一帧就是补偿路径的观察对象。
    h.transport.refuse(isDataUpdate, 1);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-a"));
    await h.runtime.tick();

    const lost = decodedUpdates(h.transport.refused);
    expect(lost.length).toBe(1);
    const lostFrame = lost[0];
    if (lostFrame === undefined) throw new Error("expected exactly one refused data frame");
    // 被拒帧确实没有到达客户端（客户端永远收不到，也不可能回执）。
    expect(carriesDelivery(h.transport.sent, lostFrame.deliveryId)).toBe(false);

    // 传输恢复后的下一 tick：重试搁置位——同一 deliveryId、同一区间，交接成功且只有一份被接受。
    h.transport.stopRefusing();
    await h.runtime.tick();
    const delivered = decodedUpdates(h.transport.sent).filter((frame) => frame.deliveryId === lostFrame.deliveryId);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.fromSeq).toBe(lostFrame.fromSeq);
    expect(delivered[0]?.toSeq).toBe(lostFrame.toSeq);
    expect(attemptCount(h.transport.attempts, lostFrame.deliveryId)).toBe(2);

    // 后续内容仍能发出：说明只是瞬时饱和，会话本身还在推进。
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-b"));
    await h.runtime.tick();
    expect(decodedUpdates(h.transport.sent).some((frame) => frame.fromSeq > lostFrame.toSeq)).toBe(true);

    // 诚实客户端回执它收到的一切（含重试成功那一帧）：账目归零，且期限届满不再断连（补偿已完成，无悬空投递）。
    await ackReceived(h);
    h.time.advance(ACK_DEADLINE_MS * 10);
    await h.runtime.tick();
    expect(gateway.outstandingDeliveries()).toBe(0);
    expect(h.transport.closeReasons).toEqual([]);
  });

  // 连接窗口（已发送未 ACK 字节）的唯一所有者是会话 + 账本，唯一归还入口是 ACK。持续拒发（慢客户端 / socket
  // 饱和）时客户端收不到任何帧、自然也无从回执，因此补偿不能靠回执：搁置位只有一位、且搁置段的起始时刻被后续
  // 被拒帧取 `min` 而不刷新（`egress.ts:183-185`），这段饱和因此有界——`deadlines.ackMs` 届满仍发不出去即关连接
  // （`egress.ts:283-291`），账目随 `onConnectionClosed` 清空（`scope-runtime.ts:238-253`）。
  // 期望：持续饱和由关连接收敛，而不是停在「连接看起来健康、内容却永久停发」；期限锚点不随后续写入滑动。
  test("持续拒发不无限延长：搁置期限锚定首次拒发，届满关连接并清空在途账目", async () => {
    const h = await setupScope();
    const gateway = await connect(h);

    h.transport.refuse(isDataUpdate);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-0"));
    await h.runtime.tick();
    const deliveryId = decodedUpdates(h.transport.refused)[0]?.deliveryId;
    if (deliveryId === undefined) throw new Error("expected one refused delivery");

    // 饱和期内每 tick 重试同一份：尝试次数增长，但被拒帧始终没有到达客户端（重试不制造重复投递）。
    await h.runtime.tick();
    expect(attemptCount(h.transport.attempts, deliveryId)).toBe(2);
    expect(carriesDelivery(h.transport.sent, deliveryId)).toBe(false);

    // 饱和期内的新写入：搁置位仍只有一位，且这段搁置的起始时刻被取 min 而不刷新。
    h.time.advance(ACK_DEADLINE_MS - 1);
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-1"));
    await h.runtime.tick();
    expect(h.transport.closeReasons).toEqual([]);

    // 越过首次拒发的期限：最后一次机会仍发不出去 → 关连接，而不是把期限顺延到最后一帧。
    h.time.advance(1);
    await h.runtime.tick();
    expect(h.transport.closeReasons.length).toBe(1);
    expect(h.transport.closeReasons[0]).toContain("could not be delivered within");

    // 收敛之后：在途账目归零，且连接终止后 tick 不再产出新尝试（否则会话会按「已发出」继续推进游标）。
    expect(gateway.outstandingDeliveries()).toBe(0);
    const attemptsAtClose = h.transport.attempts.length;
    await h.runtime.tick();
    await h.runtime.tick();
    expect(h.transport.attempts.length).toBe(attemptsAtClose);
  });

  // 宿主在 socket 关闭时调 `gateway.close()`（规格 §2.4 的终止原语）与网关自关（ACK 超时 / 搁置超期 / 版本不符）
  // 必须收敛到同一条路径：`scope-runtime` 一律经 `onConnectionClosed` 置位并清账，此后 tick 不再驱动会话——否则
  // 出帧会被已关闭的网关静默丢弃，而会话仍按「已发出」推进游标。期望：宿主关闭即清账（在途投递数归零），
  // 且关闭后 tick 不再产生任何出站尝试。
  test("宿主关闭网关即收敛：超期投递被清账且 tick 不再驱动会话", async () => {
    const h = await setupScope();
    const gateway = h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    await ackReceived(h);

    // 发一帧数据帧并被登记（客户端不回执）：这是超时扫描唯一的观察对象。
    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-open"));
    await h.runtime.tick();
    expect(gateway.outstandingDeliveries()).toBe(1);

    gateway.close("host socket closed");
    const attemptsAtClose = h.transport.attempts.length;
    h.time.advance(ACK_DEADLINE_MS * 10);
    await h.runtime.tick();

    // 宿主关闭请求只到过一次，此后 tick 不再产生任何出站尝试（连接终态，出帧路径整体停止）。
    expect(h.transport.closeReasons).toEqual(["host socket closed"]);
    expect(h.transport.attempts.length).toBe(attemptsAtClose);

    // 清账随宿主关闭一并发生（规格 §2.2 第 3 条）：期限届满不再是清账的唯一触发点，条目不会挂到 dispose。
    expect(gateway.outstandingDeliveries()).toBe(0);
  });

  // 规格 §2.4 要求「先预留后编码」，其前提是编码前字节核算真为**上界**；实测估算（按 UTF-16 代码单元计
  // `message.length`）对多字节文本是低估，会让临界区的超水位帧被放行。修正后门禁改为**先编码再判定**，判据是
  // 真实字节数（`egress.ts:196-203`）。
  // 期望（设计 §8.5：bufferedAmount + encodedFrameBytes ≤ socketHighWatermark）：超水位的帧不得发出。
  test("socket 门禁按真实编码字节判定：多字节 ERROR 文本顶过水位即拒发", async () => {
    const h = await setupScope();
    const gateway = h.runtime.attachTransport(h.transport);
    const frame: ErrorFrame = {
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      scope: SCOPE_KEY,
      message: "测".repeat(200),
    };
    const actualBytes = encodeSyncFrame(frame).byteLength;
    const watermark = h.config.quota.socketHighWatermark;
    // 真值水位只差 1 字节到顶：按设计 §8.5 的公式，这一帧已经把水位顶过头，必须被拒。
    h.transport.pendingBytes = watermark - actualBytes + 1;
    expect(h.transport.pendingBytes + actualBytes).toBeGreaterThan(watermark);

    gateway.sendOutbound({ frame, taskClass: "control", deliveryId: "dlv_probe_over_watermark" });

    // 期望：超水位的帧不发送（门禁用的是真实编码字节，不是估算上界）。
    expect(h.transport.sent).toEqual([]);
  });
});

describe("对抗验证：入口记录的快照稳定性", () => {
  // 规格 §2.3 要求 `records()` 提供只读视图、记录必须与 writer 实际收到的输入逐字段相等（设计 §15.1 把它
  // 定为实时 oracle）。快照必须对**任意**载荷成立：同一对象在载荷里出现两次时，两次都必须指向冻结副本，
  // 且别名关系保持（`ingress.ts:114-133` 的 `WeakMap` 语义），否则调用方事后改写会穿透已记录的快照，
  // oracle 的逐字段比对随之失效。期望：接收后改写调用方对象不影响已记录快照，两份引用相等且都不可变。
  test("载荷里同一对象被引用两次时保留别名并各为冻结副本：事后改写改不到已记录快照", async () => {
    const writer = new StubWriter();
    const ingress = createLiveIngress({ writer, maxRecords: 8 });
    const shared = { value: 1 };
    const event: SyncIngressEvent = {
      kind: "semantic",
      turnId: "turn-1",
      entryId: "turn-1:assistant",
      contentSlot: "semantic",
      contentType: "application/json",
      semantic: { kind: "tool", payload: { first: shared, second: shared } },
    };

    await ingress.accept(event);
    const record = ingress.records()[0];
    if (record === undefined) throw new Error("expected one ingress record");
    if (record.event.semantic === undefined) throw new Error("expected a semantic ingress record");
    const payload = record.event.semantic.payload;

    // 两份引用都不得是调用方原对象，且互为同一份冻结副本（别名被保留，而不是展开成两份互不相干的拷贝）。
    expect(payload.first).not.toBe(shared);
    expect(payload.second).toBe(payload.first);
    expect(Object.isFrozen(payload.first)).toBe(true);
    expect(Object.isFrozen(payload.second)).toBe(true);

    shared.value = 2;
    expect(payload.first).toEqual({ value: 1 });
    expect(payload.second).toEqual({ value: 1 });
  });
});

describe("对抗验证：探查后未见缺陷的方向", () => {
  // 侦察 §4.3 的缺口：容量档案的连接窗口与额度窗口各自只断言「窗口 ≤ socket 水位」，装配期必须补上等值断言，
  // 且两个方向都要拦（额度窗口小于档案窗口会让容量预检比额度更宽）。期望：两侧不等都抛 ADMISSION_REJECTED。
  test("装配期等值断言双向生效：额度窗口大于或小于档案窗口都被拒绝", () => {
    const capacity = tightCapacity(WINDOW_BYTES);
    const base = { clock: new TestClock(), lifecycle: LIFECYCLE, capacity };
    const window = capacity.concurrency.connectionBodyWindowBytes;
    const watermark = capacity.concurrency.socketHighWatermarkBytes;

    const tooLarge = captureSyncError(() =>
      validateSyncRuntimeConfig(resolveSyncRuntimeConfig({ ...base, quota: { maxOutstandingBytes: window + 1 } })),
    );
    const tooSmall = captureSyncError(() =>
      validateSyncRuntimeConfig(resolveSyncRuntimeConfig({ ...base, quota: { maxOutstandingBytes: window - 1 } })),
    );
    const socketMismatch = captureSyncError(() =>
      validateSyncRuntimeConfig(resolveSyncRuntimeConfig({ ...base, quota: { socketHighWatermark: watermark + 1 } })),
    );

    expect([tooLarge.code, tooSmall.code, socketMismatch.code]).toEqual([
      "ADMISSION_REJECTED",
      "ADMISSION_REJECTED",
      "ADMISSION_REJECTED",
    ]);
  });

  // 控制 governor 的账目守恒：令牌在长时间前进后仍以 framesPerSecond 为上限、时间回拨不补令牌、
  // `release` 多于在途字节立刻失败且账目不变（否则负数会凭空造出容量）。
  test("control governor：时间跳跃与回拨下守恒，字节账目不为负", () => {
    const clock = new TestClock();
    const framesPerSecond = 100;
    const windowBytes = 32 * 1024;

    // 一、长时间前进后的突发仍以 framesPerSecond 为上限，回拨不补令牌。
    const burst = createControlGovernor({ clock, framesPerSecond, windowBytes });
    clock.advance(1_000_000_000);
    let granted = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (burst.tryAcquire(1)) granted += 1;
    }
    expect(granted).toBe(framesPerSecond);
    expect(burst.snapshot().availableTokens).toBe(0);

    clock.advance(-1_000_000_000);
    expect(burst.snapshot().availableTokens).toBe(0);

    // 结清上面那批在途字节后账目归零：此时任何 `release` 都是「退多于在途」，必须立刻失败。
    burst.release(granted);
    expect(burst.snapshot().usedBytes).toBe(0);
    const overRelease = captureSyncError(() => burst.release(1));
    expect(overRelease.code).toBe("ADMISSION_REJECTED");
    expect(burst.snapshot().usedBytes).toBe(0);

    // 二、申请与结清配对：usedBytes 始终等于在途量，结清后归零且不为负。
    const steady = createControlGovernor({ clock: new TestClock(), framesPerSecond, windowBytes });
    let reserved = 0;
    for (const bytes of [100, 200, 300, 400]) {
      if (steady.tryAcquire(bytes)) reserved += bytes;
    }
    expect(reserved).toBeGreaterThan(0);
    expect(steady.snapshot().usedBytes).toBe(reserved);
    steady.release(reserved);
    expect(steady.snapshot().usedBytes).toBe(0);
    expect(steady.snapshot().availableTokens).toBeLessThanOrEqual(framesPerSecond);
  });

  // ACK 超时登记的边界：边界取等号即超期、`settle` 之后扫描不再报、时间回拨只推迟超期、同 id 同代次
  // 重复登记不续期。期望：四条都成立（下方逐条断言）。
  test("ack-timeout：边界取等号、settle 后不再报、回拨不误报、重复登记不续期", () => {
    const clock = new TestClock(1_000_000);
    const tracker = createAckTimeoutTracker({ clock, ackDeadlineMs: ACK_DEADLINE_MS });
    const expiredIds = (): string[] => tracker.scan().map((entry) => entry.deliveryId);

    tracker.track("dlv_a", TRANSPORT_EPOCH);
    clock.advance(ACK_DEADLINE_MS - 1);
    expect(expiredIds()).toEqual([]);
    clock.advance(1);
    expect(expiredIds()).toEqual(["dlv_a"]);

    expect(tracker.settle("dlv_a")).toBe(true);
    expect(expiredIds()).toEqual([]);
    expect(tracker.outstandingCount()).toBe(0);

    tracker.track("dlv_b", TRANSPORT_EPOCH);
    clock.advance(ACK_DEADLINE_MS * 10);
    expect(expiredIds()).toEqual(["dlv_b"]);
    clock.advance(-ACK_DEADLINE_MS * 9 - 500);
    expect(expiredIds()).toEqual([]);

    expect(tracker.settle("dlv_b")).toBe(true);
    clock.advance(100);
    tracker.track("dlv_c", TRANSPORT_EPOCH);
    clock.advance(ACK_DEADLINE_MS - 100);
    tracker.track("dlv_c", TRANSPORT_EPOCH);
    clock.advance(100);
    expect(expiredIds()).toEqual(["dlv_c"]);
    expect(tracker.outstandingCount()).toBe(1);
  });

  // 客户端传输的归属判定：代次与 docId 谱系不符的数据帧不得进入 Doc（无论载荷是否合法），且只能回 rejected
  // 回执（不得把 rejected 当 processed 发出去）。期望：loadedBytes 保持 0、回执结果全为 rejected。
  test("client transport：代次不符的数据帧不被应用，且只回 rejected 回执", async () => {
    const sent: ApplyAckFrame[] = [];
    const transport = createSyncClientTransport({
      send: (bytes) => {
        const frame = decodeSyncFrame(bytes);
        if (frame.type === "APPLY_ACK") sent.push(frame);
        return true;
      },
      now: () => 1_700_000_000_000,
      yieldToHost: async () => {},
      onFatal: () => {},
    });
    transport.hub.retain(CONTENT_DOC);

    const payload = Y.encodeStateAsUpdate(new Y.Doc());
    const mismatched: DocBaseFrame = {
      type: "DOC_BASE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC,
      generation: "gen-verify-other",
      transportEpoch: TRANSPORT_EPOCH,
      subscriptionEpoch: SUB_EPOCH,
      syncAttemptId: ATTEMPT_ID,
      deliveryId: "dlv_mismatch000001",
      baseSeq: 0,
      mode: "full",
      payloadDigest: "digest-mismatch",
      encodedLength: payload.byteLength,
      payload: Buffer.from(payload).toString("base64"),
    };
    transport.onFrame(encodeSyncFrame(mismatched));
    await transport.drain();

    expect(transport.hub.loadedBytes()).toBe(0);
    expect(sent.map((frame) => frame.result)).toEqual(["rejected"]);

    // 对照组：同一帧换成正确代次即可应用，证明上面的 0 来自拒绝而不是夹具本身不可用。
    const matching: DocBaseFrame = { ...mismatched, generation: GENERATION, deliveryId: "dlv_match00000001" };
    transport.onFrame(encodeSyncFrame(matching));
    await transport.drain();
    expect(transport.hub.loadedBytes()).toBeGreaterThan(0);
    expect(sent.map((frame) => frame.result)).toEqual(["rejected", "processed"]);
  });
});
