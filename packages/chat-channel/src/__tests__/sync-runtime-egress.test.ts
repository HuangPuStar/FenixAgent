// packages/chat-channel/src/__tests__/sync-runtime-egress.test.ts
// G2 出帧网关（规格 §2.4；额度职责按裁决 D1 收口）行为验证：入站协商与派发、socket 门禁、出站分类与交接、
// ACK 登记与超时扫描、搁置帧的重试与终态收敛。
// 只断言对外可观测事实（发到传输层的字节、控制窗口、超时登记、搁置帧、关闭原因与终态通知）：帧编解码、控制
// governor 与 ACK 超时登记全用真实实现，因此每条断言都跨过真实的字节边界。
//
// 门禁判据是**编码后的真实字节**（`bufferedAmount + encodedBytes > socketHighWatermark` 才拒），因此本文件里
// 「编码失败」与「被门禁拒发」是两条独立路径：编码不出字节的帧照常抛错（`egress.ts` 文件头「出站两段」）。
//
// 额度不在本文件的观察范围：连接窗口的唯一所有者在会话 + 账本（`egress.ts` 文件头偏差①），网关手上没有额度引用；
// 「ACK 归还的字节回到同一把额度」由 `sync-runtime-scope.test.ts` 用真实会话与真实额度验证。

import { describe, expect, test } from "bun:test";
import type { Clock } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  type DocUpdateFrame,
  decodeSyncFrame,
  type ErrorFrame,
  encodeSyncFrame,
  type HelloFrame,
  MAX_DATA_FRAME_BYTES,
  type ManifestFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import { type AckTimeoutTracker, createAckTimeoutTracker } from "../sync/provider/ack-timeout";
import { type ControlGovernor, createControlGovernor } from "../sync/provider/control-governor";
import type {
  AttemptState,
  HandshakeInput,
  OutboundFrame,
  ProviderSession,
  SubscribeInput,
} from "../sync/provider/session";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import { createSyncFrameGateway, type SyncFrameGateway, type SyncFrameTransport } from "../sync/runtime/egress";

const SCOPE = { organizationId: "org-1", rcsSessionId: "session-1" };
const GENERATION = "gen-1";
const TRANSPORT_EPOCH = "tx_0123456789abcdef";
const NEXT_EPOCH = "tx_fedcba9876543210";
const DELIVERY = "dlv_0123456789abcdef";
const NEXT_DELIVERY = "dlv_fedcba9876543210";
const THIRD_DELIVERY = "dlv_0011223344556677";
/** ACK 与搁置共用的期限：生产里两者同源于 `config.deadlines.ackMs`，夹具把它压到 1s，断言不依赖 30s 默认值。 */
const ACK_DEADLINE_MS = 1_000;

/** 装配配置只取真实派生路径：socket 门禁水位取 `config.quota.socketHighWatermark`，搁置期限取 `deadlines.ackMs`。 */
const CONFIG: SyncRuntimeConfig = resolveSyncRuntimeConfig({
  lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  deadlines: { ackMs: ACK_DEADLINE_MS },
});
/** socket 门禁水位：与 `config.capacity.concurrency.socketHighWatermarkBytes` 同值（装配期断言保证）。 */
const SOCKET_HIGH_WATERMARK = CONFIG.quota.socketHighWatermark;

/** 可推进的假时钟：控制令牌与 ACK 期限都只经注入时钟取时，断言不依赖真实时间。 */
class TestClock implements Clock {
  private current: number;

  constructor(current = 1_000) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }

  /** 推进时间：验证令牌回收与 ACK 超期边界。 */
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

/** 记录型传输端口：`attempts` 是交接尝试，`sent` 只含被接受的帧（`send` 返回 true）。 */
class RecordingTransport implements SyncFrameTransport {
  readonly attempts: Uint8Array[] = [];
  readonly sent: Uint8Array[] = [];
  readonly closeReasons: string[] = [];
  /** socket 待发送字节真值：由用例直接设定，验证门禁读的是真值（而非会话那套未结算字节近似）。 */
  pendingBytes = 0;
  acceptSend = true;

  send(bytes: Uint8Array): boolean {
    this.attempts.push(bytes);
    if (!this.acceptSend) return false;
    this.sent.push(bytes);
    return true;
  }

  bufferedAmount(): number {
    return this.pendingBytes;
  }

  close(reason: string): void {
    this.closeReasons.push(reason);
  }
}

/** 记录型会话：网关的职责是「原样转交」，因此只需断言它把哪个帧转成了哪次调用与哪些回帧。 */
class FakeSession implements ProviderSession {
  readonly handshakeCalls: HandshakeInput[] = [];
  readonly subscribeCalls: SubscribeInput[] = [];
  readonly ackCalls: { deliveryId: string; result: "processed" | "rejected" }[] = [];
  readonly resyncCalls: string[] = [];
  readonly replaceCalls: { generation: string; pointerRevision: number }[] = [];
  closed = false;
  state: AttemptState = "handshaking";
  /** 每个方法返回的回帧：默认空，需要验证回帧路径的用例按方法注入。 */
  replies: readonly OutboundFrame[] = [];

  async handshake(input: HandshakeInput): Promise<readonly OutboundFrame[]> {
    this.handshakeCalls.push(input);
    return this.replies;
  }

  async subscribe(request: SubscribeInput): Promise<readonly OutboundFrame[]> {
    this.subscribeCalls.push(request);
    return this.replies;
  }

  async onAck(deliveryId: string, result: "processed" | "rejected"): Promise<readonly OutboundFrame[]> {
    this.ackCalls.push({ deliveryId, result });
    return this.replies;
  }

  async tick(): Promise<readonly OutboundFrame[]> {
    return this.replies;
  }

  async resync(docId: string): Promise<readonly OutboundFrame[]> {
    this.resyncCalls.push(docId);
    return this.replies;
  }

  async replaceGeneration(input: { generation: string; pointerRevision: number }): Promise<readonly OutboundFrame[]> {
    this.replaceCalls.push(input);
    return this.replies;
  }

  close(): void {
    this.closed = true;
  }
}

interface Harness {
  readonly gateway: SyncFrameGateway;
  readonly session: FakeSession;
  readonly transport: RecordingTransport;
  readonly control: ControlGovernor;
  readonly timeouts: AckTimeoutTracker;
  readonly clock: TestClock;
  readonly mismatches: number[];
  /** 连接进入终态的通知（编排者据此清账）：断言「终态只通知一次」。 */
  readonly closedNotices: string[];
  /** 被顶替的数据帧通知（编排者据此归还窗口字节）：断言「顶替即结算，且每条只结算一次」。 */
  readonly abandoned: string[];
}

function makeHarness(options: { readonly controlWindowBytes?: number } = {}): Harness {
  const clock = new TestClock();
  const session = new FakeSession();
  const transport = new RecordingTransport();
  const control = createControlGovernor({
    clock,
    framesPerSecond: 100,
    windowBytes: options.controlWindowBytes ?? 32 * 1024,
  });
  const timeouts = createAckTimeoutTracker({ clock, ackDeadlineMs: CONFIG.deadlines.ackMs });
  const mismatches: number[] = [];
  const closedNotices: string[] = [];
  const abandoned: string[] = [];
  const gateway = createSyncFrameGateway({
    scope: SCOPE,
    session,
    transport,
    clock,
    config: CONFIG,
    control,
    timeouts,
    onProtocolMismatch: (version) => mismatches.push(version),
    onDeliveryAbandoned: (deliveryId) => abandoned.push(deliveryId),
    onConnectionClosed: (reason) => closedNotices.push(reason),
  });
  return { gateway, session, transport, control, timeouts, clock, mismatches, closedNotices, abandoned };
}

const BYTES = new TextEncoder();

/** 非法或不兼容帧的入站字节：编码器不做 schema 校验，因此可以造出「版本不对」的线上字节。 */
function encodeRaw(value: unknown): Uint8Array {
  return BYTES.encode(JSON.stringify(value));
}

function helloFrame(overrides: Partial<HelloFrame> = {}): HelloFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    generation: GENERATION,
    loadedDocs: [{ docId: "doc-1" }],
    stateful: true,
    ...overrides,
  };
}

function manifestFrame(overrides: Partial<ManifestFrame> = {}): ManifestFrame {
  return {
    type: "MANIFEST",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    generation: GENERATION,
    pointerRevision: 1,
    referenceRevision: 1,
    controlDocId: "doc-control",
    runtimeDocId: "doc-runtime",
    directoryDocId: "doc-directory",
    recoveryState: "ready",
    ...overrides,
  };
}

function docUpdateFrame(overrides: Partial<DocUpdateFrame> = {}): DocUpdateFrame {
  return {
    type: "DOC_UPDATE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId: "doc-1",
    generation: GENERATION,
    transportEpoch: TRANSPORT_EPOCH,
    subscriptionEpoch: "sub-1",
    syncAttemptId: "sa-1",
    deliveryId: DELIVERY,
    fromSeq: 1,
    toSeq: 1,
    payloadDigest: "digest-1",
    encodedLength: 5,
    payload: "AAAAAA==",
    ...overrides,
  };
}

function dataOutbound(frame: DocUpdateFrame = docUpdateFrame()): OutboundFrame {
  return { frame, taskClass: "realtime", deliveryId: frame.deliveryId };
}

/** 编码必然失败的超大数据帧：payload 超过数据帧上限时 `encodeSyncFrame` 抛 `FRAME_TOO_LARGE`。 */
function oversizedDataOutbound(): OutboundFrame {
  const frame = docUpdateFrame({ payload: "A".repeat(400 * 1024), encodedLength: 300 * 1024 });
  return { frame, taskClass: "history-current", deliveryId: "dlv_oversized" };
}

/** 编码必然失败的超大控制帧：头里的 `loadedDocs` 撑爆 4KiB 头预算，`encodeSyncFrame` 抛 `FRAME_HEADER_TOO_LARGE`。 */
function oversizedControlOutbound(): OutboundFrame {
  const loadedDocs = Array.from({ length: 4_000 }, (_, index) => ({ docId: `doc-${index}` }));
  return { frame: helloFrame({ loadedDocs }), taskClass: "control", deliveryId: "dlv_big_control" };
}

function sentFrames(harness: Harness): SyncFrame[] {
  return harness.transport.sent.map((bytes) => decodeSyncFrame(bytes));
}

function expectErrorFrame(frame: SyncFrame): ErrorFrame {
  if (frame.type !== "ERROR") throw new Error(`expected an ERROR frame, received ${frame.type}`);
  return frame;
}

async function captureSyncError(run: () => Promise<void>): Promise<SyncProtocolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

describe("入站：版本协商与派发", () => {
  // 非本版本帧必须在严格解析前被识别：回一条 ERROR 帧并关闭连接，不静默降级（设计 §14 要求客户端刷新）
  test("版本不兼容：回 PROTOCOL_VERSION_UNSUPPORTED 的 ERROR 帧并关闭连接", async () => {
    const harness = makeHarness();
    await harness.gateway.onInboundBytes(encodeRaw({ ...helloFrame(), protocolVersion: 2 }));

    expect(harness.transport.sent).toHaveLength(1);
    const error = expectErrorFrame(sentFrames(harness)[0]!);
    expect(error.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    expect(error.retryable).toBe(false);
    expect(error.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    expect(error.scope).toBe("org-1/session-1");
    expect(harness.transport.closeReasons).toHaveLength(1);
  });

  // 版本不兼容时不得把帧交给会话：半握手状态会以错误版本建立投影，客户端随后只会看到无声失败
  test("版本不兼容：不派发会话，且把客户端版本交给 onProtocolMismatch", async () => {
    const harness = makeHarness();
    await harness.gateway.onInboundBytes(encodeRaw({ ...helloFrame(), protocolVersion: 7 }));

    expect(harness.mismatches).toEqual([7]);
    expect(harness.session.handshakeCalls).toHaveLength(0);
    expect(harness.session.ackCalls).toHaveLength(0);
    expect(harness.transport.closeReasons[0]).toContain("7");
  });

  // 版本字段缺失或类型不对属于「内容坏」而不是「版本新」：必须落到严格解析的 MALFORMED_FRAME
  test("protocolVersion 缺失时走严格解析：抛 MALFORMED_FRAME 且不关连接", async () => {
    const harness = makeHarness();
    const error = await captureSyncError(() =>
      harness.gateway.onInboundBytes(
        encodeRaw({
          type: "HELLO",
          scope: SCOPE,
          generation: GENERATION,
          loadedDocs: [{ docId: "doc-1" }],
          stateful: true,
        }),
      ),
    );

    expect(error.code).toBe("MALFORMED_FRAME");
    expect(harness.mismatches).toHaveLength(0);
    expect(harness.transport.closeReasons).toHaveLength(0);
  });

  // 本版本 HELLO 派发：网关把帧字段映射为会话入参，并把会话回帧经控制路径发出（回帧不走旁路）
  test("HELLO 派发：会话收到 scope/generation/loadedDocs，回帧经控制路径发出", async () => {
    const harness = makeHarness();
    harness.session.replies = [{ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_reply" }];
    await harness.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));

    expect(harness.session.handshakeCalls).toEqual([
      {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        scope: SCOPE,
        generation: GENERATION,
        loadedDocs: [{ docId: "doc-1" }],
      },
    ]);
    expect(sentFrames(harness)[0]).toEqual(manifestFrame());
    expect(harness.control.snapshot().usedBytes).toBe(0);
    expect(harness.transport.closeReasons).toHaveLength(0);
  });

  // 缺代次的 HELLO 无法绑定任何入口：属于结构性输入错误，必须在转交会话前拒绝，而不是让会话按空代次查询
  test("HELLO 缺 generation：抛 MALFORMED_FRAME 且不派发", async () => {
    const harness = makeHarness();
    const error = await captureSyncError(() =>
      harness.gateway.onInboundBytes(
        encodeRaw({
          type: "HELLO",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          scope: SCOPE,
          loadedDocs: [{ docId: "doc-1" }],
          stateful: true,
        }),
      ),
    );

    expect(error.code).toBe("MALFORMED_FRAME");
    expect(harness.session.handshakeCalls).toHaveLength(0);
  });

  // SUBSCRIBE 只做字段透传：订阅优先级到任务类的映射由会话层裁决，网关不得二次解释
  test("SUBSCRIBE 派发：docIds 与 priority 原样转交", async () => {
    const harness = makeHarness();
    await harness.gateway.onInboundBytes(
      encodeSyncFrame({
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: ["doc-1", "doc-2"],
        priority: "currentHistory",
      }),
    );

    expect(harness.session.subscribeCalls).toEqual([{ docIds: ["doc-1", "doc-2"], priority: "currentHistory" }]);
  });

  // APPLY_ACK 是唯一的额度结算入口：先注销超时登记，再把回执交给会话推进业务边界
  test("APPLY_ACK：注销 ACK 超时登记并转交会话", async () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());
    expect(harness.gateway.outstandingDeliveries()).toBe(1);

    await harness.gateway.onInboundBytes(
      encodeSyncFrame({
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: TRANSPORT_EPOCH,
        deliveryId: DELIVERY,
        result: "processed",
        docId: "doc-1",
        appliedSeq: 1,
      }),
    );

    expect(harness.gateway.outstandingDeliveries()).toBe(0);
    expect(harness.session.ackCalls).toEqual([{ deliveryId: DELIVERY, result: "processed" }]);
  });

  // 异代次回执属于已废弃的连接代：既不能结算本代的超时登记，也不能推进本代游标（设计 §8.3 迟到回执口径）
  test("APPLY_ACK 异代次：不结算、不派发", async () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());

    await harness.gateway.onInboundBytes(
      encodeSyncFrame({
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: NEXT_EPOCH,
        deliveryId: DELIVERY,
        result: "processed",
        docId: "doc-1",
      }),
    );

    expect(harness.gateway.outstandingDeliveries()).toBe(1);
    expect(harness.session.ackCalls).toHaveLength(0);
  });

  // RESYNC 与 GENERATION_REPLACE 都是控制帧：网关只把身份字段转交，规划与原子性由会话层持有
  test("RESYNC 与 GENERATION_REPLACE：只转交身份字段", async () => {
    const harness = makeHarness();
    await harness.gateway.onInboundBytes(
      encodeSyncFrame({
        type: "RESYNC",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docId: "doc-1",
        generation: GENERATION,
        previousSubscriptionEpoch: "sub-0",
        previousSyncAttemptId: "sa-0",
        attemptId: "sa-1",
      }),
    );
    await harness.gateway.onInboundBytes(
      encodeSyncFrame({
        type: "GENERATION_REPLACE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        generation: GENERATION,
        pointerRevision: 3,
        referenceRevision: 3,
        controlDocId: "doc-control",
        directoryDocId: "doc-directory",
        runtimeDocId: "doc-runtime",
      }),
    );

    expect(harness.session.resyncCalls).toEqual(["doc-1"]);
    expect(harness.session.replaceCalls).toEqual([{ generation: GENERATION, pointerRevision: 3 }]);
  });

  // 服务器出站帧不得由对端发来：这是结构性协议违规，必须抛出而不是当成未知帧静默忽略
  test("入站服务器出站帧（DOC_UPDATE）抛 MALFORMED_FRAME", async () => {
    const harness = makeHarness();
    const error = await captureSyncError(() => harness.gateway.onInboundBytes(encodeSyncFrame(docUpdateFrame())));

    expect(error.code).toBe("MALFORMED_FRAME");
    expect(error.message).toContain("DOC_UPDATE");
  });

  // 对端 ERROR 帧表示协议级失败：本层没有恢复动作，抛出该错误码，但不得把对端 message 回灌进本地异常文本
  test("对端 ERROR 帧：抛出同错误码且不回显对端 message", async () => {
    const harness = makeHarness();
    const error = await captureSyncError(() =>
      harness.gateway.onInboundBytes(
        encodeSyncFrame({
          type: "ERROR",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          code: "DIGEST_CONFLICT",
          retryable: false,
          message: "leaked-payload-marker",
        }),
      ),
    );

    expect(error.code).toBe("DIGEST_CONFLICT");
    expect(error.message).not.toContain("leaked-payload-marker");
  });

  // 畸形输入必须抛出并保留分类，由调用方决定是否关连接：吞成静默返回会让「客户端一直发坏帧」看起来正常
  test("畸形字节：非 JSON 与非 UTF-8 都抛 MALFORMED_FRAME", async () => {
    const harness = makeHarness();
    const notJson = await captureSyncError(() => harness.gateway.onInboundBytes(BYTES.encode("{ not json")));
    const notUtf8 = await captureSyncError(() => harness.gateway.onInboundBytes(new Uint8Array([0xff, 0xfe, 0xfd])));

    expect(notJson.code).toBe("MALFORMED_FRAME");
    expect(notUtf8.code).toBe("MALFORMED_FRAME");
    expect(harness.session.handshakeCalls).toHaveLength(0);
  });

  // 尺寸预检先于解析：超过数据帧上限的输入不需要内容即可判定，解析开销不得转嫁给本端
  test("超尺寸入站字节：抛 FRAME_TOO_LARGE 且不派发", async () => {
    const harness = makeHarness();
    const error = await captureSyncError(() =>
      harness.gateway.onInboundBytes(new Uint8Array(MAX_DATA_FRAME_BYTES + 1)),
    );

    expect(error.code).toBe("FRAME_TOO_LARGE");
    expect(harness.session.handshakeCalls).toHaveLength(0);
    expect(harness.transport.closeReasons).toHaveLength(0);
  });

  // 已关闭的连接不再处理入站字节：终止后继续派发会让会话在半关闭连接上推进投影
  test("关闭后入站字节不再派发", async () => {
    const harness = makeHarness();
    harness.gateway.close("test");
    await harness.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));

    expect(harness.session.handshakeCalls).toHaveLength(0);
    expect(harness.transport.sent).toHaveLength(0);
  });
});

describe("出站：socket 门禁、分类与交接", () => {
  // 控制帧只受 governor 约束：控制窗口是连接级的独立预算（数据帧的额度在会话与账本，本层不参与），交接后归还
  test("控制帧走 governor：交接后归还窗口字节", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound({ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_control" });

    expect(harness.transport.sent).toHaveLength(1);
    expect(sentFrames(harness)[0]).toEqual(manifestFrame());
    expect(harness.control.snapshot().usedBytes).toBe(0);
  });

  // governor 拒绝（窗口放不下这一帧）：账目不变、不发到传输层、不抛错，帧落进搁置位——重试时机由搁置期限
  // 决定，本层不因一次限流就把帧丢掉（编码先于判定，故这里只断言「没发出、没记账」）
  test("governor 拒绝：不发送、不记账、不抛错，帧进搁置位", () => {
    const harness = makeHarness({ controlWindowBytes: 64 });
    harness.gateway.sendOutbound({ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_control" });

    expect(harness.transport.attempts).toHaveLength(0);
    expect(harness.control.snapshot().usedBytes).toBe(0);
  });

  // socket 门禁读 bufferedAmount 真值（会话内部只能用未结算字节近似，session.ts:199-200）：水位内放行同一帧，
  // 恰好到水位即拒——两个断言只差这 4KiB 余量，因此判定依据确实是传输层真值而不是某个近似估计
  test("socket 门禁：真值水位决定同一帧的放行与拒绝", () => {
    const withinWatermark = makeHarness();
    withinWatermark.transport.pendingBytes = SOCKET_HIGH_WATERMARK - 4_096;
    withinWatermark.gateway.sendOutbound(dataOutbound());
    expect(withinWatermark.transport.sent).toHaveLength(1);

    const atWatermark = makeHarness();
    atWatermark.transport.pendingBytes = SOCKET_HIGH_WATERMARK;
    atWatermark.gateway.sendOutbound(dataOutbound());
    expect(atWatermark.transport.attempts).toHaveLength(0);
  });

  // 超水位帧先编码再被拒（判据是真实字节，见文件头）：不发送、不登记 ACK 期限，只留一位有界引用——同一投递
  // 重复提交不重复尝试，水位排空后新投递仍能发出
  test("超 socket 水位：先编码再判定，不发送不登记，只留一位有界引用", () => {
    const harness = makeHarness();
    harness.transport.pendingBytes = SOCKET_HIGH_WATERMARK;
    const blocked = dataOutbound();
    harness.gateway.sendOutbound(blocked);
    harness.gateway.sendOutbound(blocked);

    expect(harness.transport.attempts).toHaveLength(0);
    expect(harness.transport.sent).toHaveLength(0);
    expect(harness.gateway.outstandingDeliveries()).toBe(0);

    harness.transport.pendingBytes = 0;
    harness.gateway.sendOutbound({
      frame: docUpdateFrame({ deliveryId: NEXT_DELIVERY }),
      taskClass: "realtime",
      deliveryId: NEXT_DELIVERY,
    });
    expect(harness.transport.sent).toHaveLength(1);
  });

  // 门禁判据是编码后的真实字节数：`bufferedAmount + encodedBytes` 恰好等于水位即放行（判据是严格大于），
  // 再多 1 字节就拒发——上界必须等于真实帧长，任何估算都会在临界区放行超水位帧
  test("socket 门禁按真实编码字节判定：恰好到水位放行，多一字节即拒发", () => {
    const probe = makeHarness();
    probe.gateway.sendOutbound(dataOutbound());
    const actual = probe.transport.sent[0]!.length;
    expect(sentFrames(probe)[0]).toEqual(docUpdateFrame());

    const exact = makeHarness();
    exact.transport.pendingBytes = SOCKET_HIGH_WATERMARK - actual;
    exact.gateway.sendOutbound(dataOutbound());
    expect(exact.transport.sent).toHaveLength(1);

    const overflow = makeHarness();
    overflow.transport.pendingBytes = SOCKET_HIGH_WATERMARK - actual + 1;
    overflow.gateway.sendOutbound(dataOutbound());
    expect(overflow.transport.attempts).toHaveLength(0);
  });

  // 多字节文本是估算失效的临界场景（UTF-16 代码单元数远小于 UTF-8 字节数）：门禁必须按编码后的真实字节
  // 判定，水位差 1 字节即拒发该控制帧
  test("多字节控制帧：门禁按 UTF-8 真实字节判定，不按字符数", () => {
    const harness = makeHarness();
    const frame: ErrorFrame = {
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      scope: "org-1/session-1",
      message: "测".repeat(200),
    };
    const actual = encodeSyncFrame(frame).byteLength;
    // 字符数（200）远小于真实字节数（约 600）：按字符数估算会以为还差 400 字节才到水位
    expect(frame.message.length).toBeLessThan(actual);
    harness.transport.pendingBytes = SOCKET_HIGH_WATERMARK - actual + 1;

    harness.gateway.sendOutbound({ frame, taskClass: "control", deliveryId: "dlv_multibyte" });

    expect(harness.transport.attempts).toHaveLength(0);
    expect(harness.transport.sent).toHaveLength(0);
  });

  // 编码失败（超限帧）：异常照常抛出、传输层不得收到半成品；编码先于一切判定，因此「发不出去」不会先于
  // 「编不出字节」发生——网关不参与窗口记账，也不存在「归还预留」这回事
  test("编码失败：抛出 FRAME_TOO_LARGE 且不留投递登记", () => {
    const harness = makeHarness();

    expect(() => harness.gateway.sendOutbound(oversizedDataOutbound())).toThrow(SyncProtocolError);
    expect(harness.transport.attempts).toHaveLength(0);
    expect(harness.gateway.outstandingDeliveries()).toBe(0);

    // 超长控制帧同理：头预算撑爆即抛，不搁置也不发送
    expect(() => harness.gateway.sendOutbound(oversizedControlOutbound())).toThrow(SyncProtocolError);
    expect(harness.transport.attempts).toHaveLength(0);
  });

  // 传输饱和（send 返回 false）：不登记 ACK 期限、不抛错，该帧只留一位有界引用——窗口账目在会话与账本，
  // 网关既不占也不还，失败路径不得凭空记上一笔（`outstandingDeliveries` 保持 0 即此意）；重试时机见「搁置与重试」
  test("send 返回 false：不登记超时、不改变窗口账目、只留一位引用", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    const frame = dataOutbound();
    harness.gateway.sendOutbound(frame);
    harness.gateway.sendOutbound(frame);

    expect(harness.transport.attempts).toHaveLength(1);
    expect(harness.gateway.outstandingDeliveries()).toBe(0);

    harness.transport.acceptSend = true;
    harness.gateway.sendOutbound({
      frame: docUpdateFrame({ deliveryId: NEXT_DELIVERY }),
      taskClass: "realtime",
      deliveryId: NEXT_DELIVERY,
    });
    expect(harness.transport.sent).toHaveLength(1);
  });

  // 数据帧交接成功即登记 ACK 期限：期限用帧自带的传输代次，扫描才能区分本代与迟到回执
  test("数据帧交接成功：按帧的 transportEpoch 登记 ACK 期限", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());

    expect(harness.gateway.outstandingDeliveries()).toBe(1);
  });

  // 控制帧线上不带 deliveryId（客户端无从回执）：登记 ACK 期限只会留下永不结算的条目
  test("控制帧不登记 ACK 期限", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound({ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_control" });

    expect(harness.gateway.outstandingDeliveries()).toBe(0);
  });

  // 被拒帧不排队：内存只有一位引用，且只有 `tick()` 经 `driveWithheld()` 驱动的重试（见「搁置与重试」），
  // 水位排空本身不触发任何动作，重复提交同一投递也不重复尝试
  test("被拒帧只留一位有界引用：不排队，水位排空本身不触发补发", () => {
    const harness = makeHarness();
    harness.transport.pendingBytes = SOCKET_HIGH_WATERMARK;
    harness.gateway.sendOutbound(dataOutbound());
    harness.gateway.sendOutbound(dataOutbound());
    harness.gateway.sendOutbound({
      frame: docUpdateFrame({ deliveryId: NEXT_DELIVERY }),
      taskClass: "realtime",
      deliveryId: NEXT_DELIVERY,
    });
    harness.gateway.sendOutbound({
      frame: docUpdateFrame({ deliveryId: NEXT_DELIVERY }),
      taskClass: "realtime",
      deliveryId: NEXT_DELIVERY,
    });

    harness.transport.pendingBytes = 0;

    expect(harness.transport.attempts).toHaveLength(0);
  });

  // 水位是硬边界：满水位时该帧被拒，排空后放行——放行只能由新投递触发，不是被拒帧的补发（真值判定而非近似）
  test("socket 水位：满水位拒发，排空后新投递可发", () => {
    const harness = makeHarness();
    harness.transport.pendingBytes = SOCKET_HIGH_WATERMARK;
    harness.gateway.sendOutbound(dataOutbound());
    expect(harness.transport.sent).toHaveLength(0);

    harness.transport.pendingBytes = 0;
    harness.gateway.sendOutbound({
      frame: docUpdateFrame({ deliveryId: NEXT_DELIVERY }),
      taskClass: "realtime",
      deliveryId: NEXT_DELIVERY,
    });
    expect(harness.transport.sent).toHaveLength(1);
  });
});

describe("搁置与重试", () => {
  // `send` 返回 false 是端口的饱和信号而不是帧的缺陷：帧进搁置位，下一 tick 重试同一帧，送达后按 transportEpoch
  // 登记 ACK 期限；重试不得变成复制投递——送达的正好一份、登记的正好一条
  test("传输饱和：下一 tick 重试同一帧，送达即登记且只投递一次", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    harness.gateway.sendOutbound(dataOutbound());
    expect(harness.transport.attempts).toHaveLength(1);
    expect(harness.gateway.outstandingDeliveries()).toBe(0);

    harness.transport.acceptSend = true;
    harness.gateway.driveWithheld();

    expect(harness.transport.attempts).toHaveLength(2);
    expect(harness.transport.sent).toHaveLength(1);
    expect(sentFrames(harness)).toEqual([docUpdateFrame()]);
    expect(harness.gateway.outstandingDeliveries()).toBe(1);
    expect(harness.transport.closeReasons).toEqual([]);
  });

  // 搁置期限是本层唯一的时间界限：瞬时饱和会被下一次 tick 消解，未到期不得断连；届满仍发不出去即终态——关连接
  // 并通知一次（重复通知会让编排者重复清账），此后驱动与出帧都不得再动
  test("搁置期限：未到期不断连，届满仍发不出即关连接且只通知一次", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    harness.gateway.sendOutbound(dataOutbound());

    harness.clock.advance(ACK_DEADLINE_MS - 1);
    harness.gateway.driveWithheld();
    expect(harness.transport.closeReasons).toEqual([]);

    harness.clock.advance(1);
    harness.gateway.driveWithheld();
    expect(harness.transport.closeReasons).toHaveLength(1);
    expect(harness.transport.closeReasons[0]).toContain("could not be delivered within");
    expect(harness.closedNotices).toHaveLength(1);

    const attemptsAtClose = harness.transport.attempts.length;
    harness.gateway.driveWithheld();
    harness.gateway.sendOutbound(dataOutbound(docUpdateFrame({ deliveryId: NEXT_DELIVERY })));
    harness.gateway.scanTimeouts();

    expect(harness.transport.attempts).toHaveLength(attemptsAtClose);
    expect(harness.transport.closeReasons).toHaveLength(1);
    expect(harness.closedNotices).toHaveLength(1);
  });

  // 控制限流与传输饱和不同：节流本身就是 governor 的语义，未到期不在 tick 重试（否则每次 tick 都白编一帧），
  // 只在搁置期限到期给一次「最后机会」——窗口恢复即发出，仍拒即终态，客户端不会停在无人察觉的半握手
  test("控制限流：未到期不重试，到期做一次最后机会", () => {
    const harness = makeHarness({ controlWindowBytes: 1_024 });
    // 用真实 governor 占满窗口（这一帧小于整窗，只是当前没有余量）：属于限流，不是参数违规
    expect(harness.control.tryAcquire(1_024)).toBe(true);
    harness.gateway.sendOutbound({ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_control" });

    expect(harness.transport.attempts).toHaveLength(0);
    harness.gateway.driveWithheld();
    expect(harness.transport.attempts).toHaveLength(0);

    // 窗口恢复 + 期限届满：最后机会把同一帧发出去，连接不因一次限流被判定为终态
    harness.control.release(1_024);
    harness.clock.advance(ACK_DEADLINE_MS);
    harness.gateway.driveWithheld();

    expect(harness.transport.sent).toHaveLength(1);
    expect(sentFrames(harness)[0]).toEqual(manifestFrame());
    expect(harness.transport.closeReasons).toEqual([]);
  });

  // 搁置位只有一位：连续被拒时不排队、内存不随拒绝次数增长，重试只针对最后一位；被顶替的数据帧由编排者自结算
  // 归还窗口字节（规格 §2.4「`send` 返回 false 时归还上次预留」），缺口交给客户端的序号缺口检测补齐（设计
  // §8.5：丢弃的是冗余发送任务，不是唯一内容；§15.2 T10：缺口可补齐）
  test("搁置位有界：连续被拒只保留一位，重试只针对最后一位", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    harness.gateway.sendOutbound(dataOutbound());
    harness.gateway.sendOutbound(dataOutbound(docUpdateFrame({ deliveryId: NEXT_DELIVERY })));

    harness.transport.acceptSend = true;
    harness.gateway.driveWithheld();

    expect(harness.transport.sent).toHaveLength(1);
    expect(decodeSyncFrame(harness.transport.sent[0]!).deliveryId).toBe(NEXT_DELIVERY);
    // 被顶替的那一条必须结算一次：它的字节从未上线，留在账本里会永久吃掉窗口。
    expect(harness.abandoned).toEqual([DELIVERY]);
  });

  // 顶替即结算只发生一次：同一条被顶替的投递不得被反复归还（重复归还会凭空造出额度）
  test("被顶替的投递只结算一次：后续顶替不再重复通知同一条", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    harness.gateway.sendOutbound(dataOutbound());
    harness.gateway.sendOutbound(dataOutbound(docUpdateFrame({ deliveryId: NEXT_DELIVERY })));
    harness.gateway.sendOutbound(dataOutbound(docUpdateFrame({ deliveryId: THIRD_DELIVERY })));

    expect(harness.abandoned).toEqual([DELIVERY, NEXT_DELIVERY]);
  });

  // 控制帧没有补齐入口：它被数据帧顶替时线上没有 deliveryId、客户端无从回执，MANIFEST 丢了就再也订不到内容，
  // 因此必须收敛到明确断连并通知编排者清账（设计 §8.5：连接进入终态的每条路径共用同一次清账）
  test("控制帧被数据帧顶替：以明确理由关闭连接，不留下无清单也无断连的半握手", () => {
    const harness = makeHarness();
    harness.transport.acceptSend = false;
    harness.gateway.sendOutbound({ frame: manifestFrame(), taskClass: "control", deliveryId: "dlv_control" });
    harness.gateway.sendOutbound(dataOutbound());

    expect(harness.transport.closeReasons).toHaveLength(1);
    expect(harness.transport.closeReasons[0]).toContain("MANIFEST");
    expect(harness.transport.closeReasons[0]).toContain("was superseded before delivery");
    expect(harness.closedNotices).toEqual(harness.transport.closeReasons);
    // 控制帧没有账目，自结算通知只针对数据帧：这里不该出现它，也不该保留被顶替后送来的新帧。
    expect(harness.abandoned).toEqual([]);
    harness.transport.acceptSend = true;
    harness.gateway.driveWithheld();
    expect(harness.transport.sent).toHaveLength(0);
  });
});

describe("超时扫描与终止", () => {
  // ACK 超期即连接失去回执能力：返回超期数并关闭连接，账本与额度的清理由编排者 tick 负责
  test("scanTimeouts：超期即关闭连接并返回超期数", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());
    harness.clock.advance(ACK_DEADLINE_MS);

    expect(harness.gateway.scanTimeouts()).toBe(1);
    expect(harness.transport.closeReasons).toHaveLength(1);
  });

  // 未超期不得误断连接：扫描是只读查询，期限未到时不改变任何状态
  test("scanTimeouts：未超期返回 0 且不关闭连接", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());
    harness.clock.advance(ACK_DEADLINE_MS - 1);

    expect(harness.gateway.scanTimeouts()).toBe(0);
    expect(harness.transport.closeReasons).toHaveLength(0);
    expect(harness.gateway.outstandingDeliveries()).toBe(1);
  });

  // 超时关闭后不得再出帧：终止语义下继续交接会把帧发给一个已被判定失去回执能力的连接
  test("超时关闭后：出帧与扫描都不再动作", () => {
    const harness = makeHarness();
    harness.gateway.sendOutbound(dataOutbound());
    harness.clock.advance(ACK_DEADLINE_MS);
    harness.gateway.scanTimeouts();

    harness.gateway.sendOutbound(dataOutbound(docUpdateFrame({ deliveryId: NEXT_DELIVERY })));
    expect(harness.transport.sent).toHaveLength(1);
    expect(harness.gateway.scanTimeouts()).toBe(0);
    expect(harness.transport.closeReasons).toHaveLength(1);
  });

  // close 必须幂等：重复关闭不得重复通知传输层，否则调用方会对同一连接做出两次清理
  test("close 幂等：传输层只收到一次关闭", () => {
    const harness = makeHarness();
    harness.gateway.close("first");
    harness.gateway.close("second");

    expect(harness.transport.closeReasons).toEqual(["first"]);
  });
});
