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

import { afterAll } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";

import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";

import type { LiveInput, LiveWriter } from "../sync/live/live-writer";

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

import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";

import type { SyncFrameGateway } from "../sync/runtime/egress";

import { type SyncIngressEvent } from "../sync/runtime/ingress";

import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";

import { MemoryProjectionStore } from "../sync/store/memory-store";

import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

import { windowCapacity } from "./sync-window-capacity-fixture";

export const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-verify" };
export const SCOPE_KEY = scopeKey(SCOPE);
export const GENERATION = "gen-verify-1";
export const RUNTIME_DOC = docIdFor("runtime", 0, "runtime");
export const CONTENT_DOC = docIdFor("content", 0, "content");
export const ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "control"),
  directoryDocId: docIdFor("directory", 0, "directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [CONTENT_DOC],
};
export const BOOTSTRAP_TTL_MS = 5_000;
export const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
export const ACK_DEADLINE_MS = 1_000;
/** 连接窗口与 socket 水位（同值）：窗口是「已发送未 ACK 字节」的唯一上限，缺陷靠它变得可观测。 */
export const WINDOW_BYTES = 8_192;
/** 单轮文本长度：一帧约 0.5KiB，几轮即可吃满 4KiB 窗口。 */
export const ROUND_TEXT = "y".repeat(200);
/** 标识字段的最小合法形态（不含控制字符、不超长）。 */
export const TRANSPORT_EPOCH = "tx_cloud0000000001";
export const SUB_EPOCH = "sub_cloud0000000001";
export const ATTEMPT_ID = "att_cloud0000000001";

export const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 可推进（也可回拨）的假时钟：控制令牌、ACK 期限与交接期限都只经注入时钟取时。 */
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
 * 探针传输端口：分别记录「交接尝试」「被接受的帧」「被拒的帧」「关闭请求」，并允许按谓词拒发指定帧。
 *
 * `send` 返回 false 是宿主 WS 的正常饱和信号（规格 §2.4 的端口契约），因此这是可达路径而非人为故障：
 * 被拒帧仍进 `attempts`（服务端确实尝试过发），但不进 `sent`（客户端永远收不到）。
 */
export class ProbeTransport {
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

export function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

export function textState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

export function docRecord(docId: string, kind: DocKind, snapshot: Uint8Array): SyncDocRecord {
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
  /** 已回执过的 deliveryId：诚实客户端只回执自己真正收到的帧，重复回执会掩盖账目问题。 */
  readonly acked: Set<string>;
}

/** 装配一个 scope 运行时：合并窗口取 1 字节（每条文本立即落库），窗口大小按用例收紧。 */
export async function setupScope(windowBytes = WINDOW_BYTES): Promise<ScopeHarness> {
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

/** 字节流里的增量帧：序号缺口的判定只看它们。 */
export function decodedUpdates(frames: readonly Uint8Array[]): DocUpdateFrame[] {
  const out: DocUpdateFrame[] = [];
  for (const bytes of frames) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_UPDATE") out.push(frame);
  }
  return out;
}

export function carriesDelivery(frames: readonly Uint8Array[], deliveryId: string): boolean {
  return decodedUpdates(frames).some((frame) => frame.deliveryId === deliveryId);
}

/** 同一 deliveryId 的交接尝试次数：1 表示只有最初那一次（被拒），>1 才说明被重试过。 */
export function attemptCount(frames: readonly Uint8Array[], deliveryId: string): number {
  return decodedUpdates(frames).filter((frame) => frame.deliveryId === deliveryId).length;
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

/** 建立「握手 + 订阅 + 基线已回执」的可写连接：所有出站用例的共同起点；返回网关以便读在途账目。 */
export async function connect(h: ScopeHarness): Promise<SyncFrameGateway> {
  const gateway = h.runtime.attachTransport(h.transport);
  await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
  await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
  await ackReceived(h);
  return gateway;
}

export const isDataUpdate = (bytes: Uint8Array): boolean => decodeSyncFrame(bytes).type === "DOC_UPDATE";

export function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

/** 取出协议错误：非本层错误原样上抛，避免把「类型不对」当成「校验生效」。 */
export async function rejectionOf(promise: Promise<unknown>): Promise<SyncProtocolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the promise to be rejected");
}

/** 原始线上字节：帧编码器不做 schema 校验，因此可以造出「版本不对」或「结构不对」的输入。 */
export const TEXT_ENCODER = new TextEncoder();

export function encodeRaw(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value));
}

/** 入口只调 `accept`：其余出口抛错而不是返回空值，避免替身在无关路径上伪装成成功。 */
export function unusedWriterMethod<T>(name: string): Promise<T> {
  throw new Error(`stub writer does not implement ${name}`);
}

export class StubWriter implements LiveWriter {
  /** 入口记录验证不允许触发真实续租。 */
  renew(): Promise<void> {
    return unusedWriterMethod("renew");
  }
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
