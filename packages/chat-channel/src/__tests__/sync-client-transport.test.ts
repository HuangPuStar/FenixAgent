// packages/chat-channel/src/__tests__/sync-client-transport.test.ts
// G 阶段 W4：客户端传输适配（规格 §2.5，裁决 D2）的行为回归——入站帧派发、**两种结果都回执**、补齐申请、
// 发送饱和与释放。全部走真实的 `encodeSyncFrame` / `decodeSyncFrame` 与真实 `DocHub`（不 mock 帧层，也不 mock
// apply），时间来自注入的 now，无真实等待。
//
// 裁决 D2 的断言口径：`rejected` 必须发 `APPLY_ACK{result:"rejected"}`（服务端只按 APPLY_ACK 归额度、置
// resync-required），再按拒绝原因决定是否追加 RESYNC / onFatal；`processed` 一律 `result:"processed"`。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { CLIENT_BUDGET } from "../sync/capacity/profile";
import { createSyncClientTransport, type SyncClientTransport } from "../sync/client/transport";
import {
  type ApplyAckFrame,
  type DocBaseFrame,
  type DocUpdateFrame,
  decodeSyncFrame,
  type ErrorFrame,
  encodeSyncFrame,
  type ManifestFrame,
  type ResyncFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import { buildDocId } from "../sync/protocol/identity";

const GENERATION = "gen_clienttransport0";
const CONTENT_DOC = buildDocId({ kind: "content", generation: GENERATION, blockIndex: 1, nonce: "nonce-a" });
const OTHER_DOC = buildDocId({ kind: "content", generation: GENERATION, blockIndex: 2, nonce: "nonce-b" });
const CONTROL_DOC = buildDocId({ kind: "control", generation: GENERATION, blockIndex: 0, nonce: "nonce-c" });
const RUNTIME_DOC = buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce: "nonce-d" });
const DIRECTORY_DOC = buildDocId({ kind: "directory", generation: GENERATION, blockIndex: 0, nonce: "nonce-e" });
const TRANSPORT_EPOCH = "tx_0123456789abcdef";
const SUB_EPOCH = "sub_0123456789abcdef";
const ATTEMPT = "att_0123456789abcdef";
const NEXT_ATTEMPT = "att_fedcba9876543210";

let deliveryCounter = 0;

function nextDeliveryId(): string {
  deliveryCounter += 1;
  return `dlv_${String(deliveryCounter).padStart(8, "0")}`;
}

/** 真实 Yjs 编码的载荷：同一载荷可反复应用（合并幂等），字节长度可作为计费输入。 */
function encodedPayload(text = ""): Uint8Array {
  const doc = new Y.Doc();
  if (text.length > 0) {
    doc.getText("body").insert(0, text);
  }
  const payload = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return payload;
}

/** 帧载荷用标准 base64（RFC 4648 + 填充），与服务端 `provider/session.ts` 的编码一致。 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function baseFrame(docId: string, overrides: Partial<DocBaseFrame> = {}): DocBaseFrame {
  const payload = encodedPayload(`base-${docId}`);
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation: GENERATION,
    transportEpoch: TRANSPORT_EPOCH,
    subscriptionEpoch: SUB_EPOCH,
    syncAttemptId: ATTEMPT,
    deliveryId: nextDeliveryId(),
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: toBase64(payload),
    ...overrides,
  };
}

function updateFrame(docId: string, seq: number, overrides: Partial<DocUpdateFrame> = {}): DocUpdateFrame {
  const payload = encodedPayload(`u${seq}`);
  return {
    type: "DOC_UPDATE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation: GENERATION,
    transportEpoch: TRANSPORT_EPOCH,
    subscriptionEpoch: SUB_EPOCH,
    syncAttemptId: ATTEMPT,
    deliveryId: nextDeliveryId(),
    fromSeq: seq,
    toSeq: seq,
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: toBase64(payload),
    ...overrides,
  };
}

const MANIFEST_FRAME: ManifestFrame = {
  type: "MANIFEST",
  protocolVersion: SYNC_PROTOCOL_VERSION,
  generation: GENERATION,
  pointerRevision: 1,
  referenceRevision: 1,
  controlDocId: CONTROL_DOC,
  runtimeDocId: RUNTIME_DOC,
  directoryDocId: DIRECTORY_DOC,
  recoveryState: "resumed",
};

interface Harness {
  readonly transport: SyncClientTransport;
  readonly sent: SyncFrame[];
  readonly controls: SyncFrame[];
  readonly fatals: Array<{ code: string; detail?: string }>;
  /** 服务端侧：编码后喂给 `onFrame`（走真实解码路径）。 */
  receive(frame: SyncFrame): void;
  setSendOk(ok: boolean): void;
}

/** 出站帧按类型过滤：出站一律解码后再断言，避免只比较本层构造函数。 */
function sentFrames<T extends SyncFrame["type"]>(harness: Harness, type: T): Array<Extract<SyncFrame, { type: T }>> {
  return harness.sent.filter((frame): frame is Extract<SyncFrame, { type: T }> => frame.type === type);
}

/** 裁决 D2：被拒绝的投递必须有 `result:"rejected"` 的 APPLY_ACK（原样带回投递身份，不带 `appliedSeq`）。 */
function expectRejectedAck(harness: Harness, frame: DocBaseFrame | DocUpdateFrame, docId: string): void {
  expect(sentFrames(harness, "APPLY_ACK")).toContainEqual({
    type: "APPLY_ACK",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    transportEpoch: TRANSPORT_EPOCH,
    deliveryId: frame.deliveryId,
    result: "rejected",
    docId,
  } satisfies ApplyAckFrame);
}

function createHarness(): Harness {
  const sent: SyncFrame[] = [];
  const controls: SyncFrame[] = [];
  const fatals: Array<{ code: string; detail?: string }> = [];
  let sendOk = true;
  const transport = createSyncClientTransport({
    send: (bytes) => {
      if (!sendOk) {
        return false;
      }
      sent.push(decodeSyncFrame(bytes));
      return true;
    },
    now: () => 1700000000000,
    yieldToHost: async () => {},
    onControl: (frame) => controls.push(frame),
    onFatal: (code, detail) => fatals.push({ code, detail }),
  });
  return {
    transport,
    sent,
    controls,
    fatals,
    receive: (frame) => transport.onFrame(encodeSyncFrame(frame)),
    setSendOk: (ok) => {
      sendOk = ok;
    },
  };
}

/** 建立可信基线并驱动一次调度：后续增量才有可应用的连续边界。 */
async function primeBaseline(harness: Harness, docId: string): Promise<void> {
  harness.transport.hub.retain(docId);
  harness.receive(baseFrame(docId));
  await harness.transport.drain();
}

describe("sync client transport 入站帧派发", () => {
  // 收包路径只入队不同步 apply：DOC_BASE 必须落成 base 任务并在调度后回 processed ACK。
  test("DOC_BASE 转 base 任务入 hub，调度后回 processed ACK", async () => {
    const harness = createHarness();
    const payload = encodedPayload("base");
    const frame = baseFrame(CONTENT_DOC, { payload: toBase64(payload), encodedLength: payload.byteLength });
    harness.transport.hub.retain(CONTENT_DOC);
    harness.receive(frame);
    expect(harness.transport.hub.queueDepth()).toBe(1);
    expect(harness.controls).toEqual([]);
    await harness.transport.drain();
    expect(harness.transport.hub.loadedBytes()).toBe(payload.byteLength);
    expect(sentFrames(harness, "APPLY_ACK")).toEqual([
      {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: TRANSPORT_EPOCH,
        deliveryId: frame.deliveryId,
        result: "processed",
        docId: CONTENT_DOC,
      } satisfies ApplyAckFrame,
    ]);
  });

  // 增量的 seq 区间直接来自帧字段：连续即可应用，缺口必须显式补基线而不是悄悄跳过。
  test("连续 DOC_UPDATE 映射 fromSeq/toSeq 并应用到边界", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    const first = updateFrame(CONTENT_DOC, 1);
    harness.receive(first);
    harness.receive(updateFrame(CONTENT_DOC, 2));
    await harness.transport.drain();
    expect(harness.fatals).toEqual([]);
    const acked = sentFrames(harness, "APPLY_ACK").map((ack) => ack.deliveryId);
    expect(acked).toContain(first.deliveryId);
    expect(acked).toHaveLength(3);
  });

  // 控制帧不属于应用面：交 onControl 且不占用接收队列、不产生出站帧。
  test("控制帧交 onControl，不进队列也不产生出站帧", () => {
    const harness = createHarness();
    harness.receive(MANIFEST_FRAME);
    expect(harness.controls.map((frame) => frame.type)).toEqual(["MANIFEST"]);
    expect(harness.transport.hub.queueDepth()).toBe(0);
    expect(harness.sent).toEqual([]);
    expect(harness.fatals).toEqual([]);
  });

  // onControl 是可选观测面：未注入时控制帧不得让 onmessage 边界抛错。
  test("未注入 onControl 时控制帧不抛错", () => {
    const transport = createSyncClientTransport({
      send: () => true,
      now: () => 0,
      yieldToHost: async () => {},
      onFatal: () => {
        throw new Error("fatal must not be reported for a control frame");
      },
    });
    expect(() => transport.onFrame(encodeSyncFrame(MANIFEST_FRAME))).not.toThrow();
  });

  // ERROR 帧是服务端的终态通告：按协议级失败上报（码 + 安全短句），不重复投给 onControl。
  test("ERROR 帧转 onFatal 且不再交 onControl", () => {
    const harness = createHarness();
    const errorFrame: ErrorFrame = {
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      message: "client protocol version is not supported",
    };
    harness.receive(errorFrame);
    expect(harness.fatals).toEqual([
      { code: "PROTOCOL_VERSION_UNSUPPORTED", detail: "client protocol version is not supported" },
    ]);
    expect(harness.controls).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  // onmessage 边界不允许抛错：解码失败转 onFatal，异常不得逃到事件循环。
  test("解码失败转 onFatal 且不抛出到调用方栈上", () => {
    const harness = createHarness();
    expect(() => harness.transport.onFrame(new TextEncoder().encode("{ not a frame"))).not.toThrow();
    expect(harness.fatals.map((entry) => entry.code)).toEqual(["MALFORMED_FRAME"]);
    expect(harness.transport.hub.queueDepth()).toBe(0);
  });

  // 单次畸形帧不能把连接带进死状态：后续合法帧仍应正常入队并回 ACK。
  test("解码失败后仍能处理后续合法帧", async () => {
    const harness = createHarness();
    harness.transport.onFrame(new TextEncoder().encode("null"));
    harness.transport.hub.retain(CONTENT_DOC);
    harness.receive(baseFrame(CONTENT_DOC));
    await harness.transport.drain();
    expect(harness.fatals.map((entry) => entry.code)).toEqual(["MALFORMED_FRAME"]);
    expect(sentFrames(harness, "APPLY_ACK")).toHaveLength(1);
  });

  // 载荷字节与 encodedLength 不符说明帧不自洽：按畸形帧上报，绝不把可疑字节送进 Yjs。
  test("载荷长度与 encodedLength 不符时转 onFatal 且不入队", () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    harness.receive(baseFrame(CONTENT_DOC, { encodedLength: 4096 }));
    expect(harness.fatals.map((entry) => entry.code)).toEqual(["MALFORMED_FRAME"]);
    expect(harness.transport.hub.queueDepth()).toBe(0);
    expect(harness.sent).toEqual([]);
  });
});

describe("sync client transport 回执与补齐", () => {
  // 被拒绝的投递照样要回执（裁决 D2）：服务端只按 APPLY_ACK 归额度并置 resync-required，不回执就挂账到断连。
  test("被拒绝的投递回 result:rejected 的 APPLY_ACK，并追加 RESYNC", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    const ackedBefore = sentFrames(harness, "APPLY_ACK").length;
    const gap = updateFrame(CONTENT_DOC, 9);
    harness.receive(gap);
    await harness.transport.drain();
    expect(sentFrames(harness, "APPLY_ACK")).toHaveLength(ackedBefore + 1);
    expectRejectedAck(harness, gap, CONTENT_DOC);
    // 顺序即契约：先结清账本（ACK），再申请补齐（RESYNC）。
    expect(harness.sent.slice(-2).map((frame) => frame.type)).toEqual(["APPLY_ACK", "RESYNC"]);
    expect(sentFrames(harness, "RESYNC")).toHaveLength(1);
  });

  // 两种结果各有回执且互不干扰：拒绝在入队路径立即产出（等不到 drain），processed 在 apply 返回后产出。
  test("同一批投递里 rejected 与 processed 各回各的 APPLY_ACK", async () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    harness.transport.hub.retain(OTHER_DOC);
    const base = baseFrame(CONTENT_DOC);
    const early = updateFrame(OTHER_DOC, 1);
    harness.receive(base);
    harness.receive(early);
    await harness.transport.drain();
    expect(sentFrames(harness, "APPLY_ACK")).toEqual([
      {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: TRANSPORT_EPOCH,
        deliveryId: early.deliveryId,
        result: "rejected",
        docId: OTHER_DOC,
      } satisfies ApplyAckFrame,
      {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: TRANSPORT_EPOCH,
        deliveryId: base.deliveryId,
        result: "processed",
        docId: CONTENT_DOC,
      } satisfies ApplyAckFrame,
    ]);
    expect(sentFrames(harness, "RESYNC").map((resync) => resync.docId)).toEqual([OTHER_DOC]);
  });

  // 序号缺口只能靠换新 attempt 重建基线：RESYNC 的旧身份取自入站帧，新 attempt 必须是新值。
  test("序号缺口转 RESYNC，旧 epoch/attempt 来自入站身份", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    harness.receive(updateFrame(CONTENT_DOC, 5));
    await harness.transport.drain();
    const [resync] = sentFrames(harness, "RESYNC");
    expect(resync).toEqual({
      type: "RESYNC",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC,
      generation: GENERATION,
      previousSubscriptionEpoch: SUB_EPOCH,
      previousSyncAttemptId: ATTEMPT,
      attemptId: expect.any(String),
    } satisfies ResyncFrame);
    expect(resync?.attemptId).not.toBe(ATTEMPT);
  });

  // 增量先于基线到达时本地无从 apply：回执 rejected 并补齐，而不是把它堆进 Yjs 的 pending 结构。
  test("基线未建立（base-not-ready）时的增量回执 rejected 并追加 RESYNC", async () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    const early = updateFrame(CONTENT_DOC, 1);
    harness.receive(early);
    await harness.transport.drain();
    expectRejectedAck(harness, early, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC").map((resync) => resync.docId)).toEqual([CONTENT_DOC]);
    expect(harness.fatals).toEqual([]);
  });

  // 缺口会在队列尾部留下一串注定失败的帧：同一 Doc 的补齐申请在收到新 attempt 前必须限流。
  test("同一 Doc 的补齐申请在收到新 attempt 前只发一次", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    harness.receive(updateFrame(CONTENT_DOC, 7));
    harness.receive(updateFrame(CONTENT_DOC, 8));
    await harness.transport.drain();
    expect(sentFrames(harness, "RESYNC")).toHaveLength(1);
  });

  // 服务端换新 attempt 时被作废的排队帧必须逐条回执（doc-hub 的 discardWhere 会补发 rejected 结果），
  // 否则这些 deliveryId 会在服务端挂账；它们是纯作废，不补拉、不覆盖新身份。
  test("换 attempt 作废的排队帧逐条回执 rejected 且不补拉", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    const staleFirst = updateFrame(CONTENT_DOC, 1);
    const staleSecond = updateFrame(CONTENT_DOC, 2);
    harness.receive(staleFirst);
    harness.receive(staleSecond);
    const ackedBefore = sentFrames(harness, "APPLY_ACK").length;
    harness.receive(baseFrame(CONTENT_DOC, { subscriptionEpoch: "sub_fedcba9876543210", syncAttemptId: NEXT_ATTEMPT }));
    expect(sentFrames(harness, "APPLY_ACK")).toHaveLength(ackedBefore + 2);
    expectRejectedAck(harness, staleFirst, CONTENT_DOC);
    expectRejectedAck(harness, staleSecond, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC")).toEqual([]);
  });

  // 服务端换新 attempt（新 epoch/attempt 的基线到达）后限流必须解除，否则后续缺口再也补不上。
  test("新 attempt 到达后解除限流，下一次缺口重新申请补齐", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    harness.receive(updateFrame(CONTENT_DOC, 7));
    await harness.transport.drain();
    harness.receive(baseFrame(CONTENT_DOC, { subscriptionEpoch: "sub_fedcba9876543210", syncAttemptId: NEXT_ATTEMPT }));
    await harness.transport.drain();
    harness.receive(
      updateFrame(CONTENT_DOC, 4, { subscriptionEpoch: "sub_fedcba9876543210", syncAttemptId: NEXT_ATTEMPT }),
    );
    await harness.transport.drain();
    const resyncs = sentFrames(harness, "RESYNC");
    expect(resyncs).toHaveLength(2);
    expect(resyncs[1]?.previousSyncAttemptId).toBe(NEXT_ATTEMPT);
    expect(resyncs[1]?.attemptId).not.toBe(resyncs[0]?.attemptId);
  });

  // 结构非法（未 retain 的 Doc）只回执不补拉：不会重新订阅，补拉无从谈起；也不是连接级失败。
  test("未 retain 的 Doc 只回 result:rejected 的 APPLY_ACK", () => {
    const harness = createHarness();
    const frame = baseFrame(OTHER_DOC);
    harness.receive(frame);
    expectRejectedAck(harness, frame, OTHER_DOC);
    expect(sentFrames(harness, "RESYNC")).toEqual([]);
    expect(harness.fatals).toEqual([]);
  });

  // 接收队列溢出仍按连接级失败上报；但溢出的那条也要回执，否则服务端账本会挂到 ackDeadline 断连。
  test("接收队列溢出（第 CLIENT_BUDGET.receiveQueueTasks + 1 条）回执 rejected 并转 onFatal(CAPACITY_EXCEEDED)", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    for (let index = 0; index < CLIENT_BUDGET.receiveQueueTasks; index += 1) {
      harness.receive(updateFrame(CONTENT_DOC, 1));
    }
    expect(harness.transport.hub.queueDepth()).toBe(CLIENT_BUDGET.receiveQueueTasks);
    const overflow = updateFrame(CONTENT_DOC, 1);
    harness.receive(overflow);
    expect(harness.fatals.map((entry) => entry.code)).toEqual(["CAPACITY_EXCEEDED"]);
    expectRejectedAck(harness, overflow, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC")).toEqual([]);
  });

  // 主动补齐走同一个编帧路径：调用方显式申请不受限流约束，连续两次都照发。
  test("requestResync 主动发 RESYNC 帧", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    harness.transport.requestResync(CONTENT_DOC);
    harness.transport.requestResync(CONTENT_DOC);
    const resyncs = sentFrames(harness, "RESYNC");
    expect(resyncs).toHaveLength(2);
    expect(resyncs[0]?.previousSubscriptionEpoch).toBe(SUB_EPOCH);
    expect(resyncs[0]?.generation).toBe(GENERATION);
    expect(resyncs[0]?.attemptId).not.toBe(resyncs[1]?.attemptId);
  });

  // 从未收到数据的 Doc 无法给出 RESYNC 必填的旧身份：上报 DOC_NOT_FOUND，不静默吞掉这次申请。
  test("requestResync 对未知 Doc 转 onFatal(DOC_NOT_FOUND)", () => {
    const harness = createHarness();
    harness.transport.requestResync(OTHER_DOC);
    expect(harness.fatals).toEqual([{ code: "DOC_NOT_FOUND", detail: "resync-requested" }]);
    expect(harness.sent).toEqual([]);
  });

  // 同一 deliveryId 只结算一次：重复投递的第二个结果没有可编的帧，忽略的是已结算信息而非新信息。
  test("同一 deliveryId 的重复投递只回一个 ACK", async () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    const frame = baseFrame(CONTENT_DOC);
    harness.receive(frame);
    harness.receive(frame);
    await harness.transport.drain();
    expect(sentFrames(harness, "APPLY_ACK")).toHaveLength(1);
  });

  // 重复范围不改变本地内容，但同样要回执（裁决 D2）：该帧落在当前 attempt 上，回执后按 RESYNC 换新基线。
  test("重复范围回执 rejected 并转 RESYNC，且不重复应用", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    harness.receive(updateFrame(CONTENT_DOC, 1));
    await harness.transport.drain();
    const appliedBytes = harness.transport.hub.loadedBytes();
    const duplicate = updateFrame(CONTENT_DOC, 1);
    harness.receive(duplicate);
    await harness.transport.drain();
    expect(harness.transport.hub.loadedBytes()).toBe(appliedBytes);
    expectRejectedAck(harness, duplicate, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC")).toHaveLength(1);
  });

  // 旧 epoch 的在途帧是纯作废：只回执结清原账本，不补拉（补拉会用旧身份换掉健康的当前 attempt），
  // 也不得覆盖当前身份。
  test("旧 epoch 的在途帧只回执 rejected，且不覆盖当前身份", async () => {
    const harness = createHarness();
    await primeBaseline(harness, CONTENT_DOC);
    const stale = updateFrame(CONTENT_DOC, 1, { subscriptionEpoch: "sub_older0000000000" });
    harness.receive(stale);
    await harness.transport.drain();
    expectRejectedAck(harness, stale, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC")).toEqual([]);
    // 身份表未被旧帧改写：显式补齐申请仍以当前 attempt 为旧身份。
    harness.transport.requestResync(CONTENT_DOC);
    const [resync] = sentFrames(harness, "RESYNC");
    expect(resync?.previousSubscriptionEpoch).toBe(SUB_EPOCH);
    expect(resync?.previousSyncAttemptId).toBe(ATTEMPT);
  });

  // 代次与谱系不符时本层不裁决归属：回执 rejected 并申请补齐，让服务端（代次权威）答复 RESYNC 或 ERROR。
  test("代次与谱系不符回执 rejected 并转 RESYNC", () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    const frame = baseFrame(CONTENT_DOC, { generation: "gen_othergeneration0" });
    harness.receive(frame);
    expectRejectedAck(harness, frame, CONTENT_DOC);
    expect(sentFrames(harness, "RESYNC")).toHaveLength(1);
    expect(harness.fatals).toEqual([]);
  });
});

describe("sync client transport 发送与释放", () => {
  // send 返回 false 只表示瞬时饱和：回执必须留在有界积压里，等下一次调度冲出去。
  test("发送饱和时不丢 ACK，恢复后在下一次 drain 发出", async () => {
    const harness = createHarness();
    harness.setSendOk(false);
    harness.transport.hub.retain(CONTENT_DOC);
    harness.receive(baseFrame(CONTENT_DOC));
    await harness.transport.drain();
    expect(harness.sent).toEqual([]);
    harness.setSendOk(true);
    await harness.transport.drain();
    expect(sentFrames(harness, "APPLY_ACK")).toHaveLength(1);
  });

  // 积压超过整份客户端控制预算说明连接已不可用：清空积压并显式上报 CAPACITY_EXCEEDED，不静默丢失。
  test("积压超过控制预算时转 onFatal(CAPACITY_EXCEEDED)", async () => {
    const harness = createHarness();
    harness.setSendOk(false);
    await primeBaseline(harness, CONTENT_DOC);
    for (let seq = 1; seq <= CLIENT_BUDGET.receiveQueueTasks; seq += 1) {
      harness.receive(updateFrame(CONTENT_DOC, seq));
    }
    await harness.transport.drain();
    expect(harness.fatals.map((entry) => entry.code)).toEqual(["CAPACITY_EXCEEDED"]);
    expect(sentFrames(harness, "APPLY_ACK")).toEqual([]);
  });

  // 释放后不再接收、不再回调、不再发帧；重复释放无副作用（调用方可能在断连与卸载路径各调一次）。
  test("dispose 后不再接收，重复 dispose 幂等", async () => {
    const harness = createHarness();
    harness.transport.hub.retain(CONTENT_DOC);
    harness.transport.dispose();
    harness.transport.dispose();
    harness.receive(baseFrame(CONTENT_DOC));
    await harness.transport.drain();
    harness.transport.requestResync(CONTENT_DOC);
    expect(harness.transport.hub.queueDepth()).toBe(0);
    expect(harness.sent).toEqual([]);
    expect(harness.controls).toEqual([]);
    expect(harness.fatals).toEqual([]);
  });
});
