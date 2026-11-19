// packages/chat-channel/src/__tests__/sync-runtime-scope.test.ts
// G 阶段 scope 级编排（`sync/runtime/scope-runtime.ts`，规格 §2.2）的行为测试：账目的单一实例与接线、新旧共存
// 额度的预留与到期释放、ACK 超时的断连清账、搁置帧的重试与终态收敛、dispose 幂等。
//
// 除假时钟与记录型传输端口外全部用真实实现（`MemoryProjectionStore`、真实会话、真实出帧网关、真实额度/账本）：
// 本文件考的正是「谁与谁共用同一份账目」，用替身自证会把接线错误连同被测对象一起替掉。
//
// 已知观测缺口（影响 + 移除条件）：
//   ① ACK 超时路径上的 `ledger.reset()` / `quota.reset()` 是两本内部账目，黑盒只能观察到「连接已终止且不重复
//      关闭」；账目清空要等额度/账本提供诊断快照出口才能直接断言。清账顺序（先账本后额度）因此只由实现注释保证。
//      同一套清账里的 `timeouts.reset()` 可观测：`gateway.outstandingDeliveries()` 就是它，用例据此断言「归零」。
//   ② dispose 不取消在途的历史导入：`HistoryImportService` 没有取消原语（`history/import-service.ts` 不在本阶段
//      可改范围），本层只保证运行态路径停止；移除条件＝该方法补齐取消出口。

import { describe, expect, test } from "bun:test";

import { AdmissionController } from "../sync/capacity/admission";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";

import { decodeSyncFrame, encodeSyncFrame } from "../sync/protocol/frames";
import {
  ACK_DEADLINE_MS,
  ackAll,
  CONTENT_DOC,
  captureSyncError,
  dataFrames,
  HANDOFF_DEADLINE_MS,
  helloFrame,
  RecordingTransport,
  ROUND_TEXT,
  ROUNDS,
  rejectionOf,
  SCOPE,
  setup,
  subscribeFrame,
  textEvent,
  tightCapacity,
  WINDOW_BYTES,
} from "./sync-runtime-scope-fixture";

describe("装配：共享账目与入口契约", () => {
  // 编排者注入的存储必须是写入落点：运行时自建第二份存储会让「已提交」在编排者眼里永远为空。
  test("实时写入落在编排者注入的同一份存储上", async () => {
    const h = await setup();

    await h.runtime.acceptIngress(textEvent("hello"));

    const updates = h.store.exportCommittedState().updates;
    expect(updates.some((update) => update.docId === CONTENT_DOC)).toBe(true);
  });

  // 历史导入必须与实时写入争用同一把写权：两边各持一份存储时都能拿到租约，导入会与实时写入并发改同一代次。
  test("历史导入入口读取的是同一份存储的写权", async () => {
    const h = await setup();

    await h.runtime.acceptIngress(textEvent("hold-lease"));
    const error = await rejectionOf(
      h.runtime.history.begin({ scope: SCOPE, acpSessionId: "acp-2", owner: "importer", leaseTtlMs: 1_000 }),
    );

    expect(error.code).toBe("SCOPE_BUSY");
  });

  // 未绑定传输时没有可派发的连接：入站字节必须显式失败，静默丢弃会让「客户端一直在发」表现为连接正常。
  test("未绑定传输时入站字节被拒为 BINDING_UNKNOWN", async () => {
    const h = await setup();

    const error = await rejectionOf(h.runtime.onInboundBytes(encodeSyncFrame(helloFrame())));

    expect(error.code).toBe("BINDING_UNKNOWN");
  });

  // 同一 scope 只允许一条连接：重复绑定被拒，且已绑定的网关必须继续工作（拒绝不能把原连接一并废掉）。
  test("传输只能绑定一次，重复绑定被拒且原网关继续工作", async () => {
    const h = await setup();
    const second = new RecordingTransport();

    h.runtime.attachTransport(h.transport);
    const error = captureSyncError(() => h.runtime.attachTransport(second));
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));

    expect(error.code).toBe("ADMISSION_REJECTED");
    expect(h.transport.sent.map((bytes) => decodeSyncFrame(bytes).type)).toEqual(["HELLO", "MANIFEST"]);
    expect(second.sent).toEqual([]);
  });

  // 账本 `onRelease` 必须回到**同一把**连接额度：额度未接线时（或接到第二份控制器）ACCOUNT 归还的字节
  // 到不了会话，窗口在若干轮后耗尽——拒绝不抛错，只表现为「没有新帧」，因此只能靠「帧必须持续出现」判定。
  test("ACK 归还的字节回到同一把额度：总量远超窗口的连续帧仍能全部发出", async () => {
    const h = await setup({ capacity: tightCapacity({ windowBytes: WINDOW_BYTES }) });
    h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.acceptIngress(textEvent("seed"));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    // 基线必须先回执：BASE_READY 与 tail 都排在它之后（会话的顺序不可交换）。
    expect(await ackAll(h.runtime, dataFrames(h.transport, 0))).toBe(1);

    const perRound: number[] = [];
    const subscribed = new Set([CONTENT_DOC]);
    for (let round = 0; round < ROUNDS; round += 1) {
      await h.runtime.acceptIngress(textEvent(ROUND_TEXT, `turn-${round}`));
      const from = h.transport.sent.length;
      await h.runtime.tick();
      const successors = h.store
        .exportCommittedState()
        .docs.filter((doc) => doc.kind === "content" && !subscribed.has(doc.docId));
      if (successors.length > 0) {
        for (const doc of successors) subscribed.add(doc.docId);
        await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame(successors.map((doc) => doc.docId))));
      }
      const frames = dataFrames(h.transport, from);
      perRound.push(frames.length);
      await ackAll(h.runtime, frames);
    }

    expect(perRound.every((count) => count > 0)).toBe(true);
    expect(perRound.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(ROUNDS);
  });
});

describe("新旧共存额度", () => {
  // 预留必须发生在首次写入之前（写入层登记首块时旧 Doc 仍在计费），且只预留一次：重复写入不叠加占用。
  test("首次写入前不预留，首次写入按运行态硬限预留一次", async () => {
    const h = await setup();
    expect(h.admission.used("hotDocLive")).toBe(0);

    await h.runtime.acceptIngress(textEvent("first"));
    expect(h.admission.used("hotDocLive")).toBe(h.config.limits.hardLimitBytes);
    await h.runtime.acceptIngress(textEvent("second", "turn-2"));

    expect(h.admission.used("hotDocLive")).toBe(h.config.limits.hardLimitBytes);
  });

  // 额度不足必须让本次写入失败而不是静默降级：先「写进去再报错」会把一次未接纳的写入留在代次里。
  test("共存额度不足时写入以 ADMISSION_REJECTED 失败且不落库", async () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    admission.reserve("hotDocLive", DEFAULT_SYNC_CAPACITY.serverPools.hotDocLive);
    const h = await setup({ admission });

    const error = await rejectionOf(h.runtime.acceptIngress(textEvent("blocked")));

    expect(error.code).toBe("ADMISSION_REJECTED");
    expect(h.store.exportCommittedState().updates).toEqual([]);
  });

  // 交接期限内的预留不得提前归还（一次在途轮换仍需要它），届满必须归还，否则一次未落地的轮换会永久占额度。
  test("交接期限届满才释放共存预留", async () => {
    const h = await setup({ capacity: tightCapacity({ handoffDeadlineMs: HANDOFF_DEADLINE_MS }) });
    await h.runtime.acceptIngress(textEvent("rotate"));

    h.time.advance(HANDOFF_DEADLINE_MS - 1);
    await h.runtime.tick();
    expect(h.admission.used("hotDocLive")).toBe(h.config.limits.hardLimitBytes);

    h.time.advance(1);
    await h.runtime.tick();
    expect(h.admission.used("hotDocLive")).toBe(0);
  });

  // 释放后写入仍要继续：下一次写入必须重新预留，否则后续轮换会在无额度状态下开始交接。
  test("释放后再次写入会重新预留共存额度", async () => {
    const h = await setup({ capacity: tightCapacity({ handoffDeadlineMs: HANDOFF_DEADLINE_MS }) });
    await h.runtime.acceptIngress(textEvent("first"));
    h.time.advance(HANDOFF_DEADLINE_MS);
    await h.runtime.tick();
    expect(h.admission.used("hotDocLive")).toBe(0);

    await h.runtime.acceptIngress(textEvent("second", "turn-2"));

    expect(h.admission.used("hotDocLive")).toBe(h.config.limits.hardLimitBytes);
  });
});

describe("ACK 超时断连", () => {
  // 期限未到不得关连接；届满由 tick 扫描判定，关连接只发生一次（重复关闭会让宿主侧无法判定关闭原因）。
  test("ACK 期限内不关连接，届满时 tick 关闭连接且只关一次", async () => {
    const h = await setup({ ackMs: ACK_DEADLINE_MS });
    h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    // 场景前提：订阅已产生一条在途数据帧，否则超时扫描无对象，用例会退化成空跑。
    expect(dataFrames(h.transport, 0).length).toBe(1);

    h.time.advance(ACK_DEADLINE_MS - 1);
    await h.runtime.tick();
    expect(h.transport.closeReasons).toEqual([]);

    h.time.advance(1);
    await h.runtime.tick();
    expect(h.transport.closeReasons.length).toBe(1);
    expect(h.transport.closeReasons[0]).toContain("ack timeout");
  });

  // 已终止的连接不得继续产出：产出的帧无处投递，而会话会按「已发出」推进游标；空跑的 tick 也不得重复关闭。
  test("断连后不再发帧、不再重复关闭，dispose 也不产生第二次关闭", async () => {
    const h = await setup({ ackMs: ACK_DEADLINE_MS });
    h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    h.time.advance(ACK_DEADLINE_MS);
    await h.runtime.tick();

    // 断连后仍有新内容写入：只有「连接已终态」才能解释「tick 不发帧」。
    await h.runtime.acceptIngress(textEvent("after-timeout"));
    const sent = h.transport.sent.length;
    await h.runtime.tick();
    await h.runtime.tick();

    expect(h.transport.sent.length).toBe(sent);
    expect(h.transport.closeReasons.length).toBe(1);
    await h.runtime.dispose();
    expect(h.transport.closeReasons.length).toBe(1);
  });
});

describe("搁置帧的重试与终态收敛", () => {
  // 数据帧被传输层拒发不等于内容丢失：帧进搁置位，下一 tick 由 `driveWithheld()` 补发**同一份字节**（重发不重编码
  // 也不复制投递），客户端因此看到连续内容；若只是跳过，客户端没有任何重试触发，缺口会永久留在投影里
  test("数据帧被拒发：下一 tick 补发同一份字节并登记 ACK 期限", async () => {
    const h = await setup();
    const gateway = h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    await ackAll(h.runtime, dataFrames(h.transport, 0));
    const baselineAttempts = h.transport.attempts.length;

    h.transport.acceptSend = false;
    await h.runtime.acceptIngress(textEvent("held"));
    await h.runtime.tick();
    // 拒发：尝试过但没上线，也没有 ACK 登记（登记只发生在交接成功之后）
    expect(h.transport.attempts.length).toBe(baselineAttempts + 1);
    expect(dataFrames(h.transport, 0).length).toBe(1);
    expect(gateway.outstandingDeliveries()).toBe(0);

    h.transport.acceptSend = true;
    await h.runtime.tick();

    // 补发的是同一份字节：序号连续的更新帧因此上线，连接不因一次饱和被判定为终态
    expect(h.transport.attempts.length).toBe(baselineAttempts + 2);
    expect(h.transport.sent.at(-1)).toEqual(h.transport.attempts.at(-2));
    expect(dataFrames(h.transport, 0).length).toBe(2);
    expect(gateway.outstandingDeliveries()).toBe(1);
    expect(h.transport.closeReasons).toEqual([]);
  });

  // 搁置超过期限仍发不出去：连接已无投递能力，必须走与 ACK 超时同一条终态收敛——关连接一次、清账一次（在途
  // 投递归零），此后 tick 不再推进会话，否则会话按「已发出」推进游标而帧无人接收，两端内容永久分叉
  test("搁置超期：关连接并清账一次，此后 tick 不再推进会话", async () => {
    const h = await setup({ ackMs: ACK_DEADLINE_MS });
    const gateway = h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    await ackAll(h.runtime, dataFrames(h.transport, 0));
    h.transport.acceptSend = false;

    await h.runtime.acceptIngress(textEvent("held"));
    await h.runtime.tick();
    h.time.advance(ACK_DEADLINE_MS - 1);
    await h.runtime.tick();
    expect(h.transport.closeReasons).toEqual([]);

    h.time.advance(1);
    await h.runtime.tick();

    expect(h.transport.closeReasons.length).toBe(1);
    expect(h.transport.closeReasons[0]).toContain("could not be delivered");
    expect(gateway.outstandingDeliveries()).toBe(0);

    // 终态之后：新内容不再产生任何出站尝试，重复 tick 不重复关闭，宿主再关一次也不产生第二次关闭
    await h.runtime.acceptIngress(textEvent("after-close"));
    const attemptsAtClose = h.transport.attempts.length;
    await h.runtime.tick();
    await h.runtime.tick();
    gateway.close("host socket closed");

    expect(h.transport.attempts.length).toBe(attemptsAtClose);
    expect(h.transport.closeReasons.length).toBe(1);
    expect(gateway.outstandingDeliveries()).toBe(0);
  });
});

describe("dispose", () => {
  // dispose 必须幂等：第二次调用既不重复关闭连接，也不重复归还额度（重复归还等于凭空造出额度）。
  test("dispose 幂等：只关一次连接、共存额度归零", async () => {
    const h = await setup();
    h.runtime.attachTransport(h.transport);
    await h.runtime.acceptIngress(textEvent("held"));
    expect(h.admission.used("hotDocLive")).toBe(h.config.limits.hardLimitBytes);

    await h.runtime.dispose();
    await h.runtime.dispose();

    expect(h.transport.closeReasons.length).toBe(1);
    expect(h.transport.closeReasons[0]).toContain("dispose");
    expect(h.admission.used("hotDocLive")).toBe(0);
  });

  // 释放后一切入口都必须失败：静默成功会让调用方以为写入仍然生效，而内容已经不在任何投影里。
  test("dispose 后所有入口以 RESOURCE_RETIRED 拒绝", async () => {
    const h = await setup();
    h.runtime.attachTransport(h.transport);
    await h.runtime.dispose();

    expect((await rejectionOf(h.runtime.acceptIngress(textEvent("late")))).code).toBe("RESOURCE_RETIRED");
    expect((await rejectionOf(h.runtime.onInboundBytes(encodeSyncFrame(helloFrame())))).code).toBe("RESOURCE_RETIRED");
    expect((await rejectionOf(h.runtime.tick())).code).toBe("RESOURCE_RETIRED");
    expect(captureSyncError(() => h.runtime.attachTransport(h.transport)).code).toBe("RESOURCE_RETIRED");
  });

  // dispose 与断连共用同一套清账口径：连接已终止，投递登记再没有结算机会，留着会让观测把一个死连接看成忙碌的
  test("dispose 归零在途投递登记：死连接不得报成「在途」", async () => {
    const h = await setup();
    const gateway = h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    // 前提：订阅已产生一条在途投递（客户端不回执），否则用例退化成空跑。
    expect(gateway.outstandingDeliveries()).toBe(1);

    await h.runtime.dispose();
    await h.runtime.dispose();

    expect(gateway.outstandingDeliveries()).toBe(0);
    expect(h.transport.closeReasons.length).toBe(1);
  });

  // 从未绑定传输的 scope 也要能干净释放：没有连接可关时 dispose 不得抛错，也不得产生关闭调用。
  test("未绑定传输时 dispose 不抛且不产生关闭调用", async () => {
    const h = await setup();

    await h.runtime.dispose();
    await h.runtime.dispose();

    expect(h.transport.closeReasons).toEqual([]);
    expect(h.admission.used("hotDocLive")).toBe(0);
  });
});
