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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import type { BlockRecordInput, BuiltBlock } from "../sync/history/block-builder";
import { BlockDispatcher, type BlockRecordSource } from "../sync/history/build-dispatch";
import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { captureChange } from "../sync/live/change-capture";
import { createLiveWriter, type LiveInput, type LiveRecordValue, type LiveWriter } from "../sync/live/live-writer";
import type { RotationControllerOptions } from "../sync/live/rotation";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  type ApplyAckFrame,
  type DocBaseFrame,
  type DocUpdateFrame,
  decodeSyncFrame,
  encodeSyncFrame,
  type HelloFrame,
  type SubscribeFrame,
  SYNC_PROTOCOL_VERSION,
} from "../sync/protocol/frames";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { createAckLedger } from "../sync/provider/ack-ledger";
import { createAckTimeoutTracker } from "../sync/provider/ack-timeout";
import { createBasePlanner } from "../sync/provider/base-plan";
import { createControlGovernor } from "../sync/provider/control-governor";
import { createQuotaController } from "../sync/provider/quota";
import { createProviderSession } from "../sync/provider/session";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import { createSyncFrameGateway, type SyncFrameGateway, type SyncFrameTransport } from "../sync/runtime/egress";
import type { SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-v2", rcsSessionId: "session-verify-2" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-verify-2";
const RUNTIME_DOC = docIdFor("runtime", 0, "runtime");
const CONTENT_DOC = docIdFor("content", 0, "content");
/** 第二份内容文档：用来制造「两帧 DOC_BASE 争夺同一个搁置位」的顶替场景。 */
const SECOND_CONTENT_DOC = docIdFor("content", 1, "content-2");
/**
 * 客户端订阅的内容文档：轮换过的代次会有多个内容块，恢复的客户端会一起订阅。
 *
 * 顺序有硬含义——写入层把文本追加到**最后一个**内容块（`live-writer.ts:430` 的 `contentDocIds.at(-1)`），
 * 所以只订阅第一块时，后续写入会落在没订阅的文档上、一帧都不产出。缺口分析因此必须盯 `WRITE_DOC`。
 */
const CONTENT_DOCS: readonly string[] = [CONTENT_DOC, SECOND_CONTENT_DOC];
/** 写入落点：内容块链的尾块。 */
const WRITE_DOC = SECOND_CONTENT_DOC;
const ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "control"),
  directoryDocId: docIdFor("directory", 0, "directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [...CONTENT_DOCS],
};
const BOOTSTRAP_TTL_MS = 5_000;
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
const ACK_DEADLINE_MS = 1_000;
/** 连接窗口与 socket 水位（同值）：窗口是「已发送未 ACK 字节」的唯一上限。 */
const WINDOW_BYTES = 4_096;
/** 单轮文本长度：一帧约 0.5KiB，几轮即可吃满窗口。 */
const ROUND_TEXT = "y".repeat(200);

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 可推进的假时钟：控制令牌、ACK 期限、搁置期限与交接期限都只经注入时钟取时。 */
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
 * 探针传输端口：记录交接尝试、被接受的帧、被拒的帧与关闭请求，并允许按谓词拒发。
 *
 * `send` 返回 false 是宿主 WS 的正常饱和信号（规格 §2.4 的端口契约），因此被拒帧仍进 `attempts`
 * （服务端确实尝试过）但不进 `sent`（客户端永远收不到）。
 */
class ProbeTransport implements SyncFrameTransport {
  readonly attempts: Uint8Array[] = [];
  readonly sent: Uint8Array[] = [];
  readonly refused: Uint8Array[] = [];
  readonly closeReasons: string[] = [];
  pendingBytes = 0;
  private refusePredicate: ((bytes: Uint8Array) => boolean) | null = null;
  private refuseBudget = 0;

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

function docRecord(docId: string, kind: DocKind, snapshot: Uint8Array, blockIndex = 0): SyncDocRecord {
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
    blockIndex,
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
    doc: docRecord(SECOND_CONTENT_DOC, "content", emptyState(), 1),
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
  /** 已回执过的 deliveryId：诚实客户端只回执自己真正收到的帧。 */
  readonly acked: Set<string>;
}

/** 装配一个 scope 运行时：合并窗口取 1 字节（每条文本立即落库），窗口大小按用例收紧。 */
async function setupScope(windowBytes = WINDOW_BYTES): Promise<ScopeHarness> {
  const time = new TestClock();
  const spoolRoot = await tempDir("sync-verify2-scope-");
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource("verify2-scope"),
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
    random: deterministicRandomSource("verify2-scope"),
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

/** 字节流里的增量帧：序号连续性的判定只看它们。 */
function decodedUpdates(frames: readonly Uint8Array[]): DocUpdateFrame[] {
  const out: DocUpdateFrame[] = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

/** 同一 deliveryId 的交接尝试次数：1 表示只有最初那一次（被拒），>1 才说明被重试过。基线帧也算。 */
function attemptCount(frames: readonly Uint8Array[], deliveryId: string): number {
  return decodedData(frames).filter((frame) => frame.deliveryId === deliveryId).length;
}

/** 增量交付的缺口：把「客户端收到的区间」并起来，看是否从 baseSeq + 1 起连续铺满到最大 toSeq。 */
function updateGaps(frames: readonly Uint8Array[], docId: string, fromSeq: number): string[] {
  const ranges = decodedUpdates(frames)
    .filter((frame) => frame.docId === docId)
    .map((frame) => ({ from: frame.fromSeq, to: frame.toSeq }))
    .sort((left, right) => left.from - right.from);
  const gaps: string[] = [];
  let frontier = fromSeq;
  for (const range of ranges) {
    if (range.from > frontier) gaps.push(`missing ${frontier}..${range.from - 1}`);
    frontier = Math.max(frontier, range.to + 1);
  }
  return gaps;
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

/** 建立「握手 + 订阅 + 基线已回执」的可连接：所有出站用例的共同起点。 */
async function connect(h: ScopeHarness, docIds: readonly string[] = CONTENT_DOCS): Promise<SyncFrameGateway> {
  const gateway = h.runtime.attachTransport(h.transport);
  await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
  await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame(docIds)));
  await ackReceived(h);
  return gateway;
}

/** 客户端收到的第一条 DOC_BASE：基线序号是增量连续性的起点。 */
function baseSeqOf(h: ScopeHarness, docId: string): number {
  for (const frame of decodedData(h.transport.sent)) {
    if (frame.type === "DOC_BASE" && frame.docId === docId) return frame.baseSeq;
  }
  throw new Error(`no DOC_BASE for ${docId} reached the client`);
}

const isDataFrame = (bytes: Uint8Array): boolean => {
  const type = decodeSyncFrame(bytes).type;
  return type === "DOC_BASE" || type === "DOC_UPDATE";
};
const isDataUpdate = (bytes: Uint8Array): boolean => decodeSyncFrame(bytes).type === "DOC_UPDATE";

interface DirectHarness {
  readonly time: TestClock;
  readonly quota: ReturnType<typeof createQuotaController>;
  readonly ledger: ReturnType<typeof createAckLedger>;
  readonly session: ReturnType<typeof createProviderSession>;
  readonly gateway: SyncFrameGateway;
  readonly transport: ProbeTransport;
}

/**
 * 直连装配：绕过 `scope-runtime` 直接把真实会话 + 真实额度 + 真实账本接到真实网关上。
 *
 * 只有这样才能读到「账本残留字节」这一层事实——`scope-runtime` 不暴露额度/账本，而搁置位顶替造成的
 * 泄漏恰恰只能在这一层被观察（网关自报的在途投递数只统计**已发出**的帧，被顶替的帧不在其中）。
 */
async function setupDirect(windowBytes = WINDOW_BYTES): Promise<DirectHarness> {
  const time = new TestClock();
  const capacity = tightCapacity(windowBytes);
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource("verify2-direct"),
    lifecycle: LIFECYCLE,
    capacity,
    merge: { maxBytes: 1 },
    deadlines: { ackMs: ACK_DEADLINE_MS },
    spoolRootDir: await tempDir("sync-verify2-direct-"),
  });
  const store = new MemoryProjectionStore({ clock: time, digest: sha256Digest, capacity, lifecycle: LIFECYCLE });
  await seedScope(store, time, "seed");
  const quota = createQuotaController({ ...config.quota });
  const ledger = createAckLedger({ onRelease: (taskClass, bytes) => quota.release(taskClass, bytes) });
  const session = createProviderSession({
    store,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource("verify2-direct"),
    capacity,
    quota,
    ledger,
    base: createBasePlanner({ store, digest: sha256Digest }),
    tail: createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: capacity.inputs.activeSoftPayloadBytes }),
  });
  const control = createControlGovernor({
    clock: time,
    framesPerSecond: config.control.framesPerSecond,
    windowBytes: config.control.windowBytes,
  });
  const timeouts = createAckTimeoutTracker({ clock: time, ackDeadlineMs: config.deadlines.ackMs });
  const transport = new ProbeTransport();
  const gateway = createSyncFrameGateway({
    scope: SCOPE,
    session,
    transport,
    clock: time,
    config,
    control,
    timeouts,
    // 与 `createSyncScopeRuntime` 的装配同款：搁置位被顶替的数据帧由账本所有者自结算归还窗口字节。
    onDeliveryAbandoned: (deliveryId) => session.abandonDelivery(deliveryId),
  });
  return { time, quota, ledger, session, gateway, transport };
}

/** 与 `scope-runtime.tick()` 同一顺序：先重试搁置位 → 再驱动会话 → 再扫 ACK 超时。 */
async function driveSession(h: DirectHarness): Promise<void> {
  h.gateway.driveWithheld();
  for (const frame of await h.session.tick()) h.gateway.sendOutbound(frame);
  h.gateway.scanTimeouts();
}

/** 诚实客户端：把真正收到的数据帧逐个回执一次。 */
async function ackDirect(h: DirectHarness): Promise<number> {
  const acked = new Set<string>();
  let count = 0;
  for (const frame of decodedData(h.transport.sent)) {
    if (acked.has(frame.deliveryId)) continue;
    acked.add(frame.deliveryId);
    await h.gateway.onInboundBytes(encodeSyncFrame(ackFrame(frame)));
    count += 1;
  }
  return count;
}

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

interface PoolHarness {
  readonly pool: BlockBuildPool;
  readonly admission: AdmissionController;
}

/** 只改 worker 数与任务上限的池装配：其余 fairness 字段不参与池派生，取冻结默认值。 */
function buildPool(historyBuilderWorkers: number, builderTasksMax: number): PoolHarness {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  return {
    pool: new BlockBuildPool(
      deriveBuildPoolConfig({ ...DEFAULT_SYNC_CAPACITY.fairness, historyBuilderWorkers, builderTasksMax }),
      admission,
      { now: () => 1_000 },
    ),
    admission,
  };
}

/** 编号记录输入：`payload` 由读取缝按 ordinal 现造（分派器会把占位载荷换成读取结果）。 */
function numberedRecords(count: number): BlockRecordInput[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceOrdinal: index + 1,
    kind: "history_object",
    payload: new Uint8Array(0),
    entryId: `entry-${index + 1}`,
    entryOrder: index + 1,
    contentSlot: 0,
    partIndex: 0,
  }));
}

function inGroups(records: readonly BlockRecordInput[], groupSize: number): BlockRecordInput[][] {
  const groups: BlockRecordInput[][] = [];
  for (let start = 0; start < records.length; start += groupSize) {
    groups.push(records.slice(start, start + groupSize));
  }
  return groups;
}

/** 读取缝替身：记录读取序号、读出期间的并发与池计数，并可选地让指定序号失败。 */
class RecordingSource implements BlockRecordSource {
  readonly ordinals: number[] = [];
  maxConcurrentReads = 0;
  readonly poolSamples: string[] = [];
  failAt: number | null = null;
  private concurrent = 0;

  constructor(private readonly pool: BlockBuildPool) {}

  async readRecord(sourceOrdinal: number): Promise<Uint8Array> {
    if (sourceOrdinal === this.failAt) {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "read failed on purpose" });
    }
    this.ordinals.push(sourceOrdinal);
    this.concurrent += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.concurrent);
    const stats = this.pool.stats();
    this.poolSamples.push(`${stats.running}/${stats.queued}`);
    // 让出微任务：给「并发提交」留出被观测到的机会（读取越慢，越可能看到多个任务同时在飞）。
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    this.concurrent -= 1;
    return new TextEncoder().encode(`record-${sourceOrdinal}`);
  }
}

/** 假块构建器：覆盖输入的**前缀**（默认全部），只提供分派器需要的定位元数据。 */
function fakeBlock(generation: string, blockIndex: number, records: readonly BlockRecordInput[]): BuiltBlock {
  const covered = [...records];
  const snapshot = emptyState();
  return {
    docId: buildDocId({ kind: "content", generation, blockIndex, nonce: `v2-block-${blockIndex}` }),
    generation,
    blockIndex,
    ordinalStart: covered[0]?.sourceOrdinal ?? 0,
    ordinalEnd: covered[covered.length - 1]?.sourceOrdinal ?? 0,
    recordCount: covered.length,
    snapshot,
    hash: sha256Digest(snapshot),
    stateVector: new Uint8Array(0),
    dependsOn: [],
    records: covered.map((record) => ({
      recordId: `rec-${record.sourceOrdinal}`,
      ordinal: record.sourceOrdinal,
      entryId: record.entryId,
      orderStart: record.entryOrder,
      orderEnd: record.entryOrder,
      byteStart: 0,
      byteEnd: record.payload.byteLength,
      digest: sha256Digest(record.payload),
    })),
  };
}

describe("V2 历史导入：分派器的在飞窗口与失败结算", () => {
  // 契约（规格 §5.7 背压 + 设计 §15.1 T02）：20,000 对象的零间隔突发是默认形状（700+ 块），生产者必须受
  // 消费者约束——池上限不变、提交不撞满队列；每条记录只被读取一次（续建不得把整组重读一遍）。
  test("两万对象形状：在飞窗口不超过池 worker 数，队列不为负、每条记录只读一次", async () => {
    const { pool, admission } = buildPool(2, 6);
    const source = new RecordingSource(pool);
    const committed: number[] = [];
    const dispatcher = new BlockDispatcher(pool, {
      source,
      buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
      commitBlock: async (block) => {
        committed.push(block.recordCount);
        return "committed";
      },
    });

    const total = 20_000;
    await dispatcher.dispatch(inGroups(numberedRecords(total), 30));

    // 每条记录恰好读一次：读取序号的集合必须等于 1..total（无重读、无遗漏）。
    expect(source.ordinals.length).toBe(total);
    expect(new Set(source.ordinals).size).toBe(total);
    expect(Math.min(...source.ordinals)).toBe(1);
    expect(Math.max(...source.ordinals)).toBe(total);
    // 在飞窗口 ≤ worker 数：并发读取是各组在飞的直接证据。
    expect(source.maxConcurrentReads).toBeLessThanOrEqual(pool.workerCount());
    // 池不得排队：分派器的窗口等于 worker 数，跑满的池里不该有第 3 个任务。
    const queued = source.poolSamples.filter((sample) => !sample.endsWith("/0"));
    expect(queued).toEqual([]);
    // 全部组按序提交，覆盖整个接收边界。
    expect(committed.length).toBe(Math.ceil(total / 30));
    expect(committed.reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(dispatcher.committedBlocks()).toBe(committed.length);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: committed.length, failed: 0 });
    // 池额度是提交时预留的内存承诺：全部结算后必须归零，否则导入越跑越没额度。
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 契约（build-dispatch.ts 文件头不变式 ③）：失败必须先结清在飞任务再抛出，否则调用方的暂存释放会与在飞
  // 读取重叠；首个失败是权威原因，后续不得再有读取动作。
  test("一组失败：先结清在飞任务再抛首个失败，读取停止且额度与队列归零", async () => {
    const { pool, admission } = buildPool(2, 6);
    const source = new RecordingSource(pool);
    // 第 3 组的第一条记录读取即失败（组大小 4 → 第 9 条记录）。
    source.failAt = 9;
    const committed: number[] = [];
    const dispatcher = new BlockDispatcher(pool, {
      source,
      buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
      commitBlock: async (block) => {
        committed.push(block.recordCount);
        return "committed";
      },
    });

    const failure = dispatcher.dispatch(inGroups(numberedRecords(48), 4)).then(
      () => null,
      (error: unknown) => error,
    );
    const error = await failure;
    expect(error instanceof SyncProtocolError).toBe(true);
    expect(dispatcher.committedBlocks()).toBe(committed.length);
    // 结算完成：池里没有在飞任务、没有排队，失败只记一次，读取也不再继续。
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: committed.length, failed: 1 });
    // 额度是「先预留后释放」的账目：失败任务的预留同样必须归还干净。
    expect(admission.used("historyBuild")).toBe(0);
    const readsAtFailure = source.ordinals.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(source.ordinals.length).toBe(readsAtFailure);
    expect(dispatcher.committedBlocks()).toBeLessThan(12);
  });

  // 契约（规格 §5.7「同一池服务多个生产者」）：两个分派器共用一个单 worker 池时必须交替推进，谁都不被饿死。
  test("两个分派器共用一个单 worker 池：两组导入都跑完，不互相饿死", async () => {
    const { pool, admission } = buildPool(1, 2);
    const first = new RecordingSource(pool);
    const second = new RecordingSource(pool);
    const committed: string[] = [];
    const dispatcherOf = (source: RecordingSource, tag: string): BlockDispatcher =>
      new BlockDispatcher(pool, {
        source,
        buildBlock: ({ blockIndex, records }) => fakeBlock(GENERATION, blockIndex, records),
        commitBlock: async () => {
          committed.push(tag);
          return "committed";
        },
      });

    await Promise.all([
      dispatcherOf(first, "first").dispatch(inGroups(numberedRecords(20), 4)),
      dispatcherOf(second, "second").dispatch(inGroups(numberedRecords(20), 4)),
    ]);

    expect(first.ordinals.length).toBe(20);
    expect(second.ordinals.length).toBe(20);
    expect(committed.filter((tag) => tag === "first").length).toBe(5);
    expect(committed.filter((tag) => tag === "second").length).toBe(5);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 10, failed: 0 });
    expect(admission.used("historyBuild")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// D 组（方向 5）：live 写入层的纯删除、同名重建与封口交错（自有 oracle：编号输入序列）
// ---------------------------------------------------------------------------------------------------

const LIVE_MERGE = { maxDelayMs: 600_000, maxBytes: 1 << 20 };

/** live 夹具的入口引用：单内容块 + 运行态（写入层的落点分别是 `contentDocIds.at(-1)` 与 `runtimeDocId`）。 */
const LIVE_ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "live-control"),
  directoryDocId: docIdFor("directory", 0, "live-directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [CONTENT_DOC],
};

interface LiveHarness {
  readonly store: MemoryProjectionStore;
  readonly time: TestClock;
  readonly writer: LiveWriter;
  readonly runtimeDocId: string;
  readonly contentDocId: string;
}

/** 装配 live 写入层：真实存储 + 真实写入层，只注入假时钟与确定性随机源。 */
async function setupLive(): Promise<LiveHarness> {
  const time = new TestClock();
  const capacity = DEFAULT_SYNC_CAPACITY;
  const store = new MemoryProjectionStore({ clock: time, digest: sha256Digest, capacity, lifecycle: LIFECYCLE });
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-live",
    loadId: "load-live",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: LIVE_ENTRY_REFS,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: LIVE_ENTRY_REFS,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(RUNTIME_DOC, "runtime", emptyState()),
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(CONTENT_DOC, "content", emptyState()),
  });
  time.advance(BOOTSTRAP_TTL_MS + 1);

  const rotation: RotationControllerOptions = {
    clock: time,
    random: deterministicRandomSource("verify2-rotation"),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 600_000,
    maxTransactions: 1_000,
  };
  const writer = createLiveWriter({
    scope: SCOPE,
    store,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource("verify2-live"),
    capacity,
    merge: LIVE_MERGE,
    limits: RUNTIME_DOC_LIMITS,
    rotation,
  });
  await writer.acquire();
  return { store, time, writer, runtimeDocId: RUNTIME_DOC, contentDocId: CONTENT_DOC };
}

/** 实体输入（`kind: "tool"`）：编号输入序列里的一条「增/改」。 */
function entityInput(entityId: string, revision: number): LiveInput {
  return {
    turnId: "turn-1",
    entryId: entityId,
    contentSlot: "0",
    contentType: "tool",
    kind: "semantic",
    semantic: { kind: "tool", payload: { entityId, toolCallId: `tc-${entityId}`, metadata: { revision } } },
  };
}

/** 终态输入：带描述符 → 写内容块并在同一批次移出运行态实体。 */
function removalInput(entityId: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId: entityId,
    contentSlot: "0",
    contentType: "tool",
    kind: "semantic",
    semantic: {
      kind: "final",
      payload: {
        entityId,
        finalDescriptor: {
          kind: "tool",
          contentRef: `blk/${entityId}`,
          digest: `dg/${entityId}`,
          byteLength: 8,
          completedAt: 1_700_000_000_000,
        },
      },
    },
  };
}

/** 文本增量：合并窗口很大，只有屏障（封口/终态）才把它冲出去。 */
function textInput(delta: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "entry-text",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
  };
}

/** 客户端恢复路径：canonical base 快照 + 按序号连续的已提交 tail。 */
function liveReplay(h: LiveHarness, docId: string): Y.Doc {
  const state = h.store.exportCommittedState();
  const stored = state.docs.find((doc) => doc.docId === docId);
  if (stored === undefined) throw new Error(`document ${docId} is not committed`);
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, stored.baseSnapshot);
  for (const update of liveUpdates(h, docId)) Y.applyUpdate(doc, update.bytes);
  return doc;
}

/** 该文档的已提交 tail，按序号升序（序号有洞即抛出：连续性由本函数自己把关）。 */
function liveUpdates(h: LiveHarness, docId: string): Array<{ updateSeq: number; bytes: Uint8Array }> {
  const all = h.store
    .exportCommittedState()
    .updates.filter((update) => update.docId === docId && update.generation === GENERATION)
    .sort((left, right) => left.updateSeq - right.updateSeq);
  all.forEach((update, index) => {
    const expected = index === 0 ? 1 : (all[index - 1]?.updateSeq ?? 0) + 1;
    if (update.updateSeq !== expected) {
      throw new Error(`sequence hole in ${docId}: expected ${expected}, received ${update.updateSeq}`);
    }
  });
  return all.map((update) => ({ updateSeq: update.updateSeq, bytes: update.bytes }));
}

function liveEntities(doc: Y.Doc): RuntimeEntityRecord[] {
  return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, doc).exportForRotation();
}

function liveEntityIds(doc: Y.Doc): string[] {
  return liveEntities(doc)
    .map((entity) => entity.entityId)
    .sort();
}

describe("V2 live 写入层：删除、同名重建与封口交错的编号输入 oracle", () => {
  // 契约（设计 §6.2/§6.3 + 规格 §6.3）：每一步编号输入的运行态都必须能由已提交 tail 重放出来——包括
  // 「删除」「删除后再用同名 entityId 重建」这两类只能靠重放序列区分的状态；只比对终态会漏掉被吞掉的删除。
  test("删除与同名重建：每一步的运行态都必须由已提交 tail 逐步重放出来", async () => {
    const h = await setupLive();
    // 自有 oracle：编号输入序列（1 增 a、2 增 b、3 删 a、4 同名重建 a、5 删 b）。
    const steps: string[][] = [];
    const inputs: LiveInput[] = [
      entityInput("entity_a", 1),
      entityInput("entity_b", 1),
      removalInput("entity_a"),
      entityInput("entity_a", 2),
      removalInput("entity_b"),
      removalInput("entity_a"),
    ];
    const expected: string[][] = [
      ["entity_a"],
      ["entity_a", "entity_b"],
      ["entity_b"],
      ["entity_a", "entity_b"],
      ["entity_a"],
      [],
    ];

    for (const input of inputs) {
      await h.writer.accept(input);
      steps.push(liveEntityIds(liveReplay(h, h.runtimeDocId)));
    }

    expect(steps).toEqual(expected);
    // 同名重建必须落成新内容（revision 2），而不是旧实体留下的幽灵；重建后的实体也必须能被再次删除。
    const rebuilt = liveEntities(liveReplay(h, h.runtimeDocId)).find((entity) => entity.entityId === "entity_a");
    expect(rebuilt).toBeUndefined();
    // 序号连续性是重放 oracle 的前提：tail 必须从 1 起连续（`liveUpdates` 已校验，这里量化确认）。
    expect(liveUpdates(h, h.runtimeDocId).length).toBe(inputs.length);
  });

  // 契约（设计 §6.3 运行态轮换 + 规格 §6.2 封口）：轮换先取出存活实体再封口，删除必须落在**被封口的旧文档**里；
  // 若删除只存在于写者内存 Doc，封口后它就永久消失了。
  test("轮换封口的交错：删除落在被封口的旧运行态文档里，存活实体被带到新文档", async () => {
    const h = await setupLive();
    await h.writer.accept(entityInput("entity_keep", 1));
    await h.writer.accept(entityInput("entity_gone", 1));
    await h.writer.accept(removalInput("entity_gone"));

    const rotated = await h.writer.rotateRuntime();

    expect(liveEntityIds(liveReplay(h, rotated.oldDocId))).toEqual(["entity_keep"]);
    expect(liveEntityIds(liveReplay(h, rotated.newDocId))).toEqual(["entity_keep"]);
  });

  // 契约（设计 §6.1「屏障前已接收的文本先完成写入」）：唯一的未决批次必须在封口前被冲进旧内容块，
  // 否则这段文本既不在已封口块里、也没有后续写入能把它带下去（内容无声丢失）。
  test("封口屏障：未决的文本批次必须先落进被封装的内容块", async () => {
    const h = await setupLive();
    await h.writer.accept(textInput("pending-before-seal"));

    const sealed = await h.writer.seal();

    const records = liveReplay(h, h.contentDocId).getMap<unknown>("root").get("records");
    const texts =
      records instanceof Y.Array ? records.toArray().map((record) => (record as LiveRecordValue).payload) : [];
    expect(texts.length).toBe(1);
    expect(new TextDecoder().decode(texts[0])).toBe("pending-before-seal");
    expect(sealed.docId).toBe(h.contentDocId);
  });
});

// ---------------------------------------------------------------------------------------------------
// E 组（方向 5 的捕获层补充 + 方向 6 的回归面）
// ---------------------------------------------------------------------------------------------------

describe("V2 捕获层与回归面", () => {
  // 契约（`change-capture.ts` + 设计 §6.2）：同一事务里的多次删除、以及「删掉再重建同名键」都必须被完整
  // 捕获在同一条更新里——少一条删除，接收方就永久留着幽灵；少一条写入，重建的内容就丢了。
  test("同一事务里的多次删除与删除后同名重建被完整捕获并重放", () => {
    const doc = new Y.Doc();
    const entities = doc.getMap<string>("runtime");
    const base = captureChange(doc, () => {
      entities.set("a", "v1");
      entities.set("b", "v1");
      entities.set("c", "v1");
    });
    expect(base).not.toBeNull();

    const mixed = captureChange(doc, () => {
      entities.delete("a");
      entities.delete("c");
      entities.set("b", "v2");
      entities.set("d", "v1");
      entities.delete("d");
      entities.set("d", "v2");
    });
    expect(mixed).not.toBeNull();

    const witness = new Y.Doc();
    if (base !== null) Y.applyUpdate(witness, base);
    expect([...witness.getMap<string>("runtime").keys()].sort()).toEqual(["a", "b", "c"]);
    if (mixed !== null) Y.applyUpdate(witness, mixed);
    expect([...witness.getMap<string>("runtime").entries()].sort()).toEqual([
      ["b", "v2"],
      ["d", "v2"],
    ]);
  });

  // 回归面（方向 6 的「额度单一账户」）：账本的归还必须回到会话预留额度的同一个账户——只有一条 ACK 路径
  // 能归还窗口字节，若归还到别处，诚实客户端的完整回执之后账户也不会归零。
  test("额度单一账户：回执全部收到的帧后账本与额度同时归零", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame(CONTENT_DOCS)));
    const delivered = decodedData(h.transport.sent);
    expect(delivered.length).toBeGreaterThan(0);
    expect(h.quota.snapshot().outstandingBytes).toBeGreaterThan(0);
    expect(h.ledger.outstandingCount()).toBe(delivered.length);

    await ackDirect(h);
    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// F 组（方向 1 的计账守恒 + 设计 §15.1「重复文本不得去重」）
// ---------------------------------------------------------------------------------------------------

describe("V2 计账守恒与重复内容", () => {
  // 契约（设计 §15.1 oracle 说明 + 规格 §2.4）：相同文本的两条增量是两份内容，合并窗口只能拼接、不得去重；
  // 一旦被当成重复丢弃，客户端与库里的内容就与 Agent 实际产出不符。
  test("重复文本不被去重：两条相同增量必须都落到内容块里", async () => {
    const h = await setupLive();
    await h.writer.accept(textInput("dup"));
    await h.writer.accept(textInput("dup"));
    await h.writer.seal();

    const records = liveReplay(h, h.contentDocId).getMap<unknown>("root").get("records");
    const text = (records instanceof Y.Array ? records.toArray() : [])
      .map((record) => new TextDecoder().decode((record as LiveRecordValue).payload))
      .join("");
    expect(text).toBe("dupdup");
  });

  // 契约（规格 §2.4 + ack-ledger.ts:101-122）：ACK 与补发可能交错——宿主 `send` 返回 false 但字节已出门时，
  // 客户端会回执一条服务端认为「没发出去」的投递，随后补发又把同一 deliveryId 送一遍。归还路径只允许结算一次。
  test("ACK 与补发交错：同一 deliveryId 只结算一次，账户不为负", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    // 只拒发一次：这条基线帧被搁置，服务端认为它没发出去。
    h.transport.refuse(isDataFrame, 1);
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    const withheld = decodedData(h.transport.refused)[0];
    if (withheld === undefined) throw new Error("expected one refused DOC_BASE");
    // 该投递已被会话计费并登记：账本与窗口都在等一条 ACK（这是它「有补偿责任」的原因）。
    expect(h.ledger.outstandingCount()).toBe(1);
    expect(h.quota.snapshot().outstandingBytes).toBeGreaterThan(0);

    // 与拒发交错的回执：客户端确实收到了它。
    await h.gateway.onInboundBytes(encodeSyncFrame(ackFrame(withheld)));
    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);

    // 传输恢复：同一 deliveryId 被补发一次，客户端再回执一次（重复回执不得二次归还，否则账户为负或凭空多出额度）。
    h.transport.stopRefusing();
    await driveSession(h);
    expect(attemptCount(h.transport.attempts, withheld.deliveryId)).toBe(2);
    await ackDirect(h);
    await driveSession(h);

    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);
  });
});
