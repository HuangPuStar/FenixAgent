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

import { afterAll } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";

import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";

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

import { windowCapacity } from "./sync-window-capacity-fixture";

export const SCOPE: SyncScope = { organizationId: "org-v2", rcsSessionId: "session-verify-2" };
export const SCOPE_KEY = scopeKey(SCOPE);
export const GENERATION = "gen-verify-2";
export const RUNTIME_DOC = docIdFor("runtime", 0, "runtime");
export const CONTENT_DOC = docIdFor("content", 0, "content");
/** 第二份内容文档：用来制造「两帧 DOC_BASE 争夺同一个搁置位」的顶替场景。 */
export const SECOND_CONTENT_DOC = docIdFor("content", 1, "content-2");
/**
 * 客户端订阅的内容文档：轮换过的代次会有多个内容块，恢复的客户端会一起订阅。
 *
 * 顺序有硬含义——写入层把文本追加到**最后一个**内容块（`live-writer.ts:430` 的 `contentDocIds.at(-1)`），
 * 所以只订阅第一块时，后续写入会落在没订阅的文档上、一帧都不产出。缺口分析因此必须盯 `WRITE_DOC`。
 */
export const CONTENT_DOCS: readonly string[] = [CONTENT_DOC, SECOND_CONTENT_DOC];
/** 写入落点：内容块链的尾块。 */
export const WRITE_DOC = SECOND_CONTENT_DOC;
export const ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "control"),
  directoryDocId: docIdFor("directory", 0, "directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [...CONTENT_DOCS],
};
export const BOOTSTRAP_TTL_MS = 5_000;
export const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
export const ACK_DEADLINE_MS = 1_000;
/** 连接窗口与 socket 水位（同值）：窗口是「已发送未 ACK 字节」的唯一上限。 */
export const WINDOW_BYTES = 8_192;
/** 单轮文本长度：一帧约 0.5KiB，几轮即可吃满窗口。 */
export const ROUND_TEXT = "y".repeat(200);

export const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 可推进的假时钟：控制令牌、ACK 期限、搁置期限与交接期限都只经注入时钟取时。 */
export class TestClock implements Clock {
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
export class ProbeTransport implements SyncFrameTransport {
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

export function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

export function textState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

export function docRecord(docId: string, kind: DocKind, snapshot: Uint8Array, blockIndex = 0): SyncDocRecord {
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
export function tightCapacity(windowBytes: number): SyncCapacityProfile {
  const concurrency = { ...DEFAULT_SYNC_CAPACITY.concurrency };
  concurrency.connectionBodyWindowBytes = windowBytes;
  concurrency.socketHighWatermarkBytes = windowBytes;
  return { ...windowCapacity(windowBytes), concurrency };
}

/** 建一个有已提交代次的作用域：代次必须经 `commitGeneration` 成为当前代次，否则握手与写入都会被拒。 */
export async function seedScope(store: MemoryProjectionStore, time: TestClock, text = ""): Promise<void> {
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

export interface ScopeHarness {
  readonly runtime: SyncScopeRuntime;
  readonly transport: ProbeTransport;
  readonly time: TestClock;
  readonly config: SyncRuntimeConfig;
  /** 已回执过的 deliveryId：诚实客户端只回执自己真正收到的帧。 */
  readonly acked: Set<string>;
}

/** 装配一个 scope 运行时：合并窗口取 1 字节（每条文本立即落库），窗口大小按用例收紧。 */
export async function setupScope(windowBytes = WINDOW_BYTES): Promise<ScopeHarness> {
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

export function textEvent(delta: string, turnId: string): SyncIngressEvent {
  return {
    kind: "text-delta",
    turnId,
    entryId: `${turnId}:assistant`,
    contentSlot: "text",
    contentType: "text/plain",
    delta,
  };
}

export function helloFrame(): HelloFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    generation: GENERATION,
    loadedDocs: [],
    stateful: true,
  };
}

export function subscribeFrame(docIds: readonly string[]): SubscribeFrame {
  return { type: "SUBSCRIBE", protocolVersion: SYNC_PROTOCOL_VERSION, docIds: [...docIds], priority: "live" };
}

export function ackFrame(frame: DocBaseFrame | DocUpdateFrame): ApplyAckFrame {
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
export function decodedData(frames: readonly Uint8Array[]): Array<DocBaseFrame | DocUpdateFrame> {
  const out: Array<DocBaseFrame | DocUpdateFrame> = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

/** 字节流里的增量帧：序号连续性的判定只看它们。 */
export function decodedUpdates(frames: readonly Uint8Array[]): DocUpdateFrame[] {
  const out: DocUpdateFrame[] = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

/** 同一 deliveryId 的交接尝试次数：1 表示只有最初那一次（被拒），>1 才说明被重试过。基线帧也算。 */
export function attemptCount(frames: readonly Uint8Array[], deliveryId: string): number {
  return decodedData(frames).filter((frame) => frame.deliveryId === deliveryId).length;
}

/** 增量交付的缺口：把「客户端收到的区间」并起来，看是否从 baseSeq + 1 起连续铺满到最大 toSeq。 */
export function updateGaps(frames: readonly Uint8Array[], docId: string, fromSeq: number): string[] {
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
export async function ackReceived(h: ScopeHarness): Promise<number> {
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
export async function connect(h: ScopeHarness, docIds: readonly string[] = CONTENT_DOCS): Promise<SyncFrameGateway> {
  const gateway = h.runtime.attachTransport(h.transport);
  await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
  await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame(docIds)));
  await ackReceived(h);
  return gateway;
}

/** 客户端收到的第一条 DOC_BASE：基线序号是增量连续性的起点。 */
export function baseSeqOf(h: ScopeHarness, docId: string): number {
  for (const frame of decodedData(h.transport.sent)) {
    if (frame.type === "DOC_BASE" && frame.docId === docId) return frame.baseSeq;
  }
  throw new Error(`no DOC_BASE for ${docId} reached the client`);
}

export const isDataFrame = (bytes: Uint8Array): boolean => {
  const type = decodeSyncFrame(bytes).type;
  return type === "DOC_BASE" || type === "DOC_UPDATE";
};
export const isDataUpdate = (bytes: Uint8Array): boolean => decodeSyncFrame(bytes).type === "DOC_UPDATE";

export interface DirectHarness {
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
export async function setupDirect(windowBytes = WINDOW_BYTES): Promise<DirectHarness> {
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
export async function driveSession(h: DirectHarness): Promise<void> {
  h.gateway.driveWithheld();
  for (const frame of await h.session.tick()) h.gateway.sendOutbound(frame);
  h.gateway.scanTimeouts();
}

/** 诚实客户端：把真正收到的数据帧逐个回执一次。 */
export async function ackDirect(h: DirectHarness): Promise<number> {
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
