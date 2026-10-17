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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { createSyncClientTransport } from "../sync/client/transport";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import type { LiveInput, LiveWriter } from "../sync/live/live-writer";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  type ApplyAckFrame,
  type DocBaseFrame,
  type DocUpdateFrame,
  decodeSyncFrame,
  type ErrorFrame,
  encodeSyncFrame,
  type HelloFrame,
  MAX_DATA_FRAME_BYTES,
  type SubscribeFrame,
  SYNC_PROTOCOL_VERSION,
} from "../sync/protocol/frames";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { createAckTimeoutTracker } from "../sync/provider/ack-timeout";
import { createControlGovernor } from "../sync/provider/control-governor";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig, validateSyncRuntimeConfig } from "../sync/runtime/config";
import type { SyncFrameGateway } from "../sync/runtime/egress";
import { createLiveIngress, type SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-verify" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-verify-1";
const RUNTIME_DOC = docIdFor("runtime", 0, "runtime");
const CONTENT_DOC = docIdFor("content", 0, "content");
const ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "control"),
  directoryDocId: docIdFor("directory", 0, "directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [CONTENT_DOC],
};
const BOOTSTRAP_TTL_MS = 5_000;
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
const ACK_DEADLINE_MS = 1_000;
/** 连接窗口与 socket 水位（同值）：窗口是「已发送未 ACK 字节」的唯一上限，缺陷靠它变得可观测。 */
const WINDOW_BYTES = 4_096;
/** 单轮文本长度：一帧约 0.5KiB，几轮即可吃满 4KiB 窗口。 */
const ROUND_TEXT = "y".repeat(200);
/** 标识字段的最小合法形态（不含控制字符、不超长）。 */
const TRANSPORT_EPOCH = "tx_cloud0000000001";
const SUB_EPOCH = "sub_cloud0000000001";
const ATTEMPT_ID = "att_cloud0000000001";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 可推进（也可回拨）的假时钟：控制令牌、ACK 期限与交接期限都只经注入时钟取时。 */
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
}

/**
 * 探针传输端口：分别记录「交接尝试」「被接受的帧」「被拒的帧」「关闭请求」，并允许按谓词拒发指定帧。
 *
 * `send` 返回 false 是宿主 WS 的正常饱和信号（规格 §2.4 的端口契约），因此这是可达路径而非人为故障：
 * 被拒帧仍进 `attempts`（服务端确实尝试过发），但不进 `sent`（客户端永远收不到）。
 */
class ProbeTransport {
  readonly attempts: Uint8Array[] = [];
  readonly sent: Uint8Array[] = [];
  readonly refused: Uint8Array[] = [];
  readonly closeReasons: string[] = [];
  /** socket 待发送字节真值：验证门禁读的是真值。 */
  pendingBytes = 0;
  private refusePredicate: ((bytes: Uint8Array) => boolean) | null = null;
  private refuseBudget = 0;

  /** 按谓词拒发接下来的 N 帧；缺省 N 为持续拒发。 */
  refuse(predicate: (bytes: Uint8Array) => boolean, budget = Number.POSITIVE_INFINITY): void {
    this.refusePredicate = predicate;
    this.refuseBudget = budget;
  }

  stopRefusing(): void {
    this.refusePredicate = null;
    this.refuseBudget = 0;
  }

  send(bytes: Uint8Array): boolean {
    this.attempts.push(bytes);
    if (this.refusePredicate !== null && this.refuseBudget > 0 && this.refusePredicate(bytes)) {
      this.refuseBudget -= 1;
      this.refused.push(bytes);
      return false;
    }
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

function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function textState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function docRecord(docId: string, kind: DocKind, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: 0,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 只收紧一处容量数值：窗口与 socket 水位必须一起改（档案校验要求窗口 ≤ 水位）。 */
function tightCapacity(windowBytes: number): SyncCapacityProfile {
  const concurrency = { ...DEFAULT_SYNC_CAPACITY.concurrency };
  concurrency.connectionBodyWindowBytes = windowBytes;
  concurrency.socketHighWatermarkBytes = windowBytes;
  return { ...DEFAULT_SYNC_CAPACITY, concurrency };
}

/** 建一个有已提交代次的作用域：代次必须经 `commitGeneration` 成为当前代次，否则握手与写入都会被拒。 */
async function seedScope(store: MemoryProjectionStore, time: TestClock, text = ""): Promise<void> {
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-1",
    loadId: "load-1",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: ENTRY_REFS,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: ENTRY_REFS,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(CONTENT_DOC, "content", text === "" ? emptyState() : textState(text)),
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(RUNTIME_DOC, "runtime", emptyState()),
  });
  // 引导租约到期：运行时的写者才能以新的 epoch 取得写权（存储不提供主动释放）。
  time.advance(BOOTSTRAP_TTL_MS + 1);
}

interface ScopeHarness {
  readonly runtime: SyncScopeRuntime;
  readonly transport: ProbeTransport;
  readonly time: TestClock;
  readonly config: SyncRuntimeConfig;
  /** 已回执过的 deliveryId：诚实客户端只回执自己真正收到的帧，重复回执会掩盖账目问题。 */
  readonly acked: Set<string>;
}

/** 装配一个 scope 运行时：合并窗口取 1 字节（每条文本立即落库），窗口大小按用例收紧。 */
async function setupScope(windowBytes = WINDOW_BYTES): Promise<ScopeHarness> {
  const time = new TestClock();
  const spoolRoot = await mkdtemp(join(tmpdir(), "sync-verify-wiring-"));
  tempRoots.push(spoolRoot);
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource("verify-wiring"),
    lifecycle: LIFECYCLE,
    capacity: tightCapacity(windowBytes),
    merge: { maxBytes: 1 },
    deadlines: { ackMs: ACK_DEADLINE_MS },
    spoolRootDir: spoolRoot,
  });
  const store = new MemoryProjectionStore({
    clock: time,
    digest: sha256Digest,
    capacity: config.capacity,
    lifecycle: LIFECYCLE,
  });
  await seedScope(store, time, "seed");
  const runtime = await createSyncScopeRuntime({
    scope: SCOPE,
    config,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource("verify-wiring"),
    store,
  });
  return { runtime, transport: new ProbeTransport(), time, config, acked: new Set<string>() };
}

function textEvent(delta: string, turnId: string): SyncIngressEvent {
  return {
    kind: "text-delta",
    turnId,
    entryId: `${turnId}:assistant`,
    contentSlot: "text",
    contentType: "text/plain",
    delta,
  };
}

function helloFrame(): HelloFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    generation: GENERATION,
    loadedDocs: [],
    stateful: true,
  };
}

function subscribeFrame(docIds: readonly string[]): SubscribeFrame {
  return { type: "SUBSCRIBE", protocolVersion: SYNC_PROTOCOL_VERSION, docIds: [...docIds], priority: "live" };
}

function ackFrame(frame: DocBaseFrame | DocUpdateFrame): ApplyAckFrame {
  return {
    type: "APPLY_ACK",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    transportEpoch: frame.transportEpoch,
    deliveryId: frame.deliveryId,
    result: "processed",
    docId: frame.docId,
  };
}

/** 字节流里的数据帧（DOC_BASE / DOC_UPDATE）：只有它们需要回执。 */
function decodedData(frames: readonly Uint8Array[]): Array<DocBaseFrame | DocUpdateFrame> {
  const out: Array<DocBaseFrame | DocUpdateFrame> = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

/** 字节流里的增量帧：序号缺口的判定只看它们。 */
function decodedUpdates(frames: readonly Uint8Array[]): DocUpdateFrame[] {
  const out: DocUpdateFrame[] = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

function carriesDelivery(frames: readonly Uint8Array[], deliveryId: string): boolean {
  return decodedUpdates(frames).some((frame) => frame.deliveryId === deliveryId);
}

/** 同一 deliveryId 的交接尝试次数：1 表示只有最初那一次（被拒），>1 才说明被重试过。 */
function attemptCount(frames: readonly Uint8Array[], deliveryId: string): number {
  return decodedUpdates(frames).filter((frame) => frame.deliveryId === deliveryId).length;
}

/** 逐个回执客户端**真正收到**的数据帧（已回执过的跳过）：ACK 是额度归还的唯一路径。 */
async function ackReceived(h: ScopeHarness): Promise<number> {
  let count = 0;
  for (const frame of decodedData(h.transport.sent)) {
    if (h.acked.has(frame.deliveryId)) continue;
    h.acked.add(frame.deliveryId);
    await h.runtime.onInboundBytes(encodeSyncFrame(ackFrame(frame)));
    count += 1;
  }
  return count;
}

/** 建立「握手 + 订阅 + 基线已回执」的可写连接：所有出站用例的共同起点；返回网关以便读在途账目。 */
async function connect(h: ScopeHarness): Promise<SyncFrameGateway> {
  const gateway = h.runtime.attachTransport(h.transport);
  await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
  await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
  await ackReceived(h);
  return gateway;
}

const isDataUpdate = (bytes: Uint8Array): boolean => decodeSyncFrame(bytes).type === "DOC_UPDATE";

function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

/** 取出协议错误：非本层错误原样上抛，避免把「类型不对」当成「校验生效」。 */
async function rejectionOf(promise: Promise<unknown>): Promise<SyncProtocolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the promise to be rejected");
}

/** 原始线上字节：帧编码器不做 schema 校验，因此可以造出「版本不对」或「结构不对」的输入。 */
const TEXT_ENCODER = new TextEncoder();

function encodeRaw(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value));
}

/** 入口只调 `accept`：其余出口抛错而不是返回空值，避免替身在无关路径上伪装成成功。 */
function unusedWriterMethod<T>(name: string): Promise<T> {
  throw new Error(`stub writer does not implement ${name}`);
}

class StubWriter implements LiveWriter {
  readonly inputs: LiveInput[] = [];

  readonly acquire: LiveWriter["acquire"] = () => unusedWriterMethod("acquire");
  readonly commit: LiveWriter["commit"] = () => unusedWriterMethod("commit");
  readonly seal: LiveWriter["seal"] = () => unusedWriterMethod("seal");
  readonly rotateRuntime: LiveWriter["rotateRuntime"] = () => unusedWriterMethod("rotateRuntime");
  readonly recover: LiveWriter["recover"] = () => unusedWriterMethod("recover");
  readonly close: LiveWriter["close"] = () => unusedWriterMethod("close");

  async accept(input: LiveInput): Promise<void> {
    this.inputs.push(input);
  }
}

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
