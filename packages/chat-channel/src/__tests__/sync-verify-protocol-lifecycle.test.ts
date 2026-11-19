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

import { decodeSyncFrame, encodeSyncFrame, MAX_DATA_FRAME_BYTES, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";

import {
  ackReceived,
  CONTENT_DOC,
  captureSyncError,
  connect,
  decodedUpdates,
  encodeRaw,
  GENERATION,
  helloFrame,
  ProbeTransport,
  ROUND_TEXT,
  rejectionOf,
  SCOPE,
  setupScope,
  subscribeFrame,
  TEXT_ENCODER,
  textEvent,
} from "./sync-verify-wiring-fixture";

describe("对抗验证：版本协商与尺寸门禁的绕过尝试", () => {
  // `protocolVersion` 在 schema 里是字面量，因此「非本版本」与「版本字段不是数字」必须在原始字节上分流：前者是
  // 终态（回 PROTOCOL_VERSION_UNSUPPORTED 并关连接），后者只是畸形帧（抛错、不关连接）。把非数字也算成版本
  // 不兼容，任何垃圾都能触发终结路径；静默吞掉则让「客户端一直在发坏帧」表现为连接正常。
  // 期望：两条输入都以 MALFORMED_FRAME 上抛、无 ERROR 帧、无关闭请求，且连接随后仍能正常读写。
  test("非数字 protocolVersion 走严格解析：抛 MALFORMED_FRAME、不发 ERROR、不关连接，连接仍可用", async () => {
    const h = await setupScope();
    await connect(h);
    const sentBefore = h.transport.sent.length;

    const asString = await rejectionOf(h.runtime.onInboundBytes(encodeRaw({ ...helloFrame(), protocolVersion: "1" })));
    const missing = await rejectionOf(
      h.runtime.onInboundBytes(
        encodeRaw({ type: "HELLO", scope: SCOPE, generation: GENERATION, loadedDocs: [], stateful: true }),
      ),
    );
    expect([asString.code, missing.code]).toEqual(["MALFORMED_FRAME", "MALFORMED_FRAME"]);
    // 非数字版本不走终结路径：没有 ERROR 帧出去，也没有任何关闭请求。
    expect(h.transport.sent.length).toBe(sentBefore);
    expect(h.transport.closeReasons).toEqual([]);

    // 连接仍可用：坏帧之后写入的内容必须真的发得出去。
    await h.runtime.acceptIngress(textEvent("after-malformed", "turn-malformed"));
    await h.runtime.tick();
    expect(decodedUpdates(h.transport.sent.slice(sentBefore)).length).toBeGreaterThan(0);
  });

  // 尺寸放宽的判据是「从原始文本里探测出的帧类」，探测只看第一个 `"type"`（可以出现在无关嵌套字段里），因此
  // 必须验证「解析后按**解析结果**复核类别」这一步真的收紧了：宣告数据类不能变成进会话的通行证，真控制帧无论
  // 多长都按 32KiB 拒，超数据帧上限的字节连内容都不看。
  // 期望：三条路径都在派发前被拒、不回帧、不关连接（畸形输入的断连决定权在调用方）。
  test("宣告数据类不能绕过控制帧上限：超长垃圾与超长控制帧都在派发前被拒且不关连接", async () => {
    const h = await setupScope();
    await connect(h);
    const sentBefore = h.transport.sent.length;

    // 首个 `"type"` 声明为 DOC_UPDATE（数据类 → 允许 >32KiB 进解析），但字段不足以构成任何帧。
    const declaredData = await rejectionOf(
      h.runtime.onInboundBytes(
        encodeRaw({ type: "DOC_UPDATE", protocolVersion: SYNC_PROTOCOL_VERSION, pad: "z".repeat(40_000) }),
      ),
    );
    expect(declaredData.code).toBe("MALFORMED_FRAME");

    // 真控制帧（ERROR）带 40KB 文本：解析类别为控制类，必须按控制上限拒绝。
    const oversizedControl = await rejectionOf(
      h.runtime.onInboundBytes(
        encodeRaw({
          type: "ERROR",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          code: "MALFORMED_FRAME",
          retryable: false,
          message: "y".repeat(40_000),
        }),
      ),
    );
    expect(oversizedControl.code).toBe("FRAME_TOO_LARGE");

    // 数据帧上限是硬门禁且先于解析：宣告数据类再加超限字节，同样拿不到版本协商的机会。
    const overDataLimit = new Uint8Array(MAX_DATA_FRAME_BYTES + 1);
    overDataLimit.set(TEXT_ENCODER.encode('{"type":"DOC_UPDATE","protocolVersion":'), 0);
    const overLimit = await rejectionOf(h.runtime.onInboundBytes(overDataLimit));
    expect(overLimit.code).toBe("FRAME_TOO_LARGE");

    expect(h.transport.sent.length).toBe(sentBefore);
    expect(h.transport.closeReasons).toEqual([]);
  });

  // 数据帧上限是唯一先于版本协商的尺寸门禁（`egress.ts:327-336` 的顺序）：>32KiB 但 ≤288KiB 的帧只要原始
  // 版本不是本版本，走的就是终结路径而不是越界拒绝。顺序刻意为之——客户端要拿到「请重新加载」而不是「帧太大」。
  // 期望：旧版本的超长帧得到 PROTOCOL_VERSION_UNSUPPORTED 的 ERROR 帧与恰好一次关闭（实测一致）。
  test("尺寸顺序：>32KiB 的旧版本帧仍走版本终结路径，得到 ERROR 与一次关闭", async () => {
    const h = await setupScope();
    await connect(h);

    await h.runtime.onInboundBytes(encodeRaw({ type: "HELLO", protocolVersion: 99, pad: "q".repeat(40_000) }));

    expect(h.transport.closeReasons).toEqual(["unsupported protocol version 99"]);
    const tail = h.transport.sent.at(-1);
    expect(tail === undefined ? null : decodeSyncFrame(tail).type).toBe("ERROR");
  });
});

describe("对抗验证：scope 生命周期的边界", () => {
  // 绑定只能一次、dispose 是终态、dispose 只关一次：三条在生命周期边界上必须同时成立。dispose 的归零口径与
  // `handleAckTimeout`（`scope-runtime.ts:246-253`）一致——四条终止路径都经 `convergeClosedConnection()` 清空
  // 投递登记、账本与额度，因此 dispose 之后 `outstandingDeliveries()` 归零，观测面不会把死连接看成忙碌的。
  test("生命周期边界：二次绑定被拒、dispose 后各入口拒绝、只关一次且投递登记归零", async () => {
    const h = await setupScope();
    const gateway = h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    await ackReceived(h);

    // 传输只能绑定一次：第二个传输被拒，且被拒的动作没有顺手关掉既有连接。
    const secondBind = captureSyncError(() => h.runtime.attachTransport(new ProbeTransport()));
    expect(secondBind.code).toBe("ADMISSION_REJECTED");
    expect(h.transport.closeReasons).toEqual([]);

    await h.runtime.acceptIngress(textEvent(ROUND_TEXT, "turn-life"));
    await h.runtime.tick();
    expect(gateway.outstandingDeliveries()).toBe(1);

    await h.runtime.dispose();
    expect(h.transport.closeReasons.length).toBe(1);

    const afterDispose = await Promise.all([
      rejectionOf(h.runtime.tick()),
      rejectionOf(h.runtime.acceptIngress(textEvent("post-dispose", "turn-dead"))),
      rejectionOf(h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])))),
    ]);
    expect(afterDispose.map((error) => error.code)).toEqual([
      "RESOURCE_RETIRED",
      "RESOURCE_RETIRED",
      "RESOURCE_RETIRED",
    ]);
    const lateBind = captureSyncError(() => h.runtime.attachTransport(new ProbeTransport()));
    expect(lateBind.code).toBe("RESOURCE_RETIRED");
    // dispose 幂等：第二次调用不产生第二次关闭。
    await h.runtime.dispose();
    expect(h.transport.closeReasons.length).toBe(1);

    // 投递登记随连接进入终态一并归零：账本、额度、投递登记与 ACK 期限表是这条连接的同一份状态，口径必须一致。
    expect(gateway.outstandingDeliveries()).toBe(0);
  });
});
