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

import { afterAll } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import * as Y from "yjs";

import { AdmissionController } from "../sync/capacity/admission";

import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";

import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";

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

import type { SyncFrameTransport } from "../sync/runtime/egress";

import type { SyncIngressEvent } from "../sync/runtime/ingress";

import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";

import { MemoryProjectionStore } from "../sync/store/memory-store";

import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

import { windowCapacity } from "./sync-window-capacity-fixture";

export const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-scope" };
export const SCOPE_KEY = scopeKey(SCOPE);
export const GENERATION = "gen-scope-1";
export const RUNTIME_DOC = docIdFor("runtime", 0, "runtime");
export const CONTENT_DOC = docIdFor("content", 0, "content");
export const ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "control"),
  directoryDocId: docIdFor("directory", 0, "directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [CONTENT_DOC],
};
/** 引导租约：夹具用它登记代次与文档，随后过期，把写权让给被测运行时里的真实写者。 */
export const BOOTSTRAP_TTL_MS = 5_000;
export const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
/** 共存预留的交接期限：取默认值之外的小值，避免推进到写者租约（30s）边界。 */
export const HANDOFF_DEADLINE_MS = 600;
/** ACK 期限：同上，只推进到刚好越过它。 */
export const ACK_DEADLINE_MS = 1_000;
/** 连接窗口与 socket 水位（同值）：窗口是「未 ACK 字节」的唯一上限，用例靠它观察额度是否被归还。 */
export const WINDOW_BYTES = 8_192;
/** 单轮文本长度：让每个数据帧约 0.5KiB，N 轮累计远超窗口。 */
export const ROUND_TEXT = "x".repeat(200);
/** 轮数：累计载荷约为窗口的 2 倍，额度不归还时会在中途静默停发。 */
export const ROUNDS = 32;

export const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 可推进的假时钟：租约、轮换、ACK 与交接期限都只经注入时钟取时，断言不依赖真实时间。 */
export class TestClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

/** 记录型传输端口：`sent` 只含被接受的帧（`send` 返回 true），`closeReasons` 记录每次终止请求。 */
export class RecordingTransport implements SyncFrameTransport {
  readonly sent: Uint8Array[] = [];
  readonly closeReasons: string[] = [];
  /** 交接尝试（含被拒帧）：与 `sent` 的差值即「尝试过但没能上线」的帧。 */
  readonly attempts: Uint8Array[] = [];
  /** 交接开关：置 false 表示传输饱和（`send` 返回 false），被拒帧因此落进网关的搁置位。 */
  acceptSend = true;
  /** socket 待发送字节真值：置成水位以上可让门禁（而非 `send`）成为拒发原因。 */
  pendingBytes = 0;

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

export type DataFrame = DocBaseFrame | DocUpdateFrame;

/** 空文档的 canonical 字节：内容块与运行态 Doc 都以它为基线登记。 */
export function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** 带内容的基线快照：用来把数据帧撑到接近窗口大小，使「窗口是否被归还」在少量轮次内就可判定。 */
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
export function tightCapacity(options: { windowBytes?: number; handoffDeadlineMs?: number }): SyncCapacityProfile {
  const concurrency = { ...DEFAULT_SYNC_CAPACITY.concurrency };
  if (options.windowBytes !== undefined) {
    concurrency.connectionBodyWindowBytes = options.windowBytes;
    concurrency.socketHighWatermarkBytes = options.windowBytes;
  }
  if (options.handoffDeadlineMs !== undefined) {
    concurrency.handoffDeadlineMs = options.handoffDeadlineMs;
  }
  return { ...windowCapacity(concurrency.connectionBodyWindowBytes), concurrency };
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

export interface Harness {
  runtime: SyncScopeRuntime;
  store: MemoryProjectionStore;
  admission: AdmissionController;
  time: TestClock;
  transport: RecordingTransport;
  config: SyncRuntimeConfig;
}

/**
 * 装配一个 scope 运行时：注入同一份存储与准入账目，以便断言「编排者持有的账目就是运行时使用的那一份」。
 * 合并窗口取 `maxBytes: 1`（每条文本立即冲刷并等待落库），让用例不依赖 33ms 的真实定时器。
 */
export async function setup(
  options: { capacity?: SyncCapacityProfile; ackMs?: number; admission?: AdmissionController; seedText?: string } = {},
): Promise<Harness> {
  const time = new TestClock();
  const spoolRoot = await mkdtemp(join(tmpdir(), "sync-scope-runtime-"));
  tempRoots.push(spoolRoot);
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource("scope-runtime"),
    lifecycle: LIFECYCLE,
    capacity: options.capacity,
    merge: { maxBytes: 1 },
    deadlines: { ackMs: options.ackMs ?? ACK_DEADLINE_MS },
    spoolRootDir: spoolRoot,
  });
  const store = new MemoryProjectionStore({
    clock: time,
    digest: sha256Digest,
    capacity: config.capacity,
    lifecycle: LIFECYCLE,
  });
  const admission = options.admission ?? new AdmissionController(config.capacity);
  await seedScope(store, time, options.seedText);
  const random = deterministicRandomSource("scope-runtime");
  const runtime = await createSyncScopeRuntime({
    scope: SCOPE,
    config,
    clock: time,
    digest: sha256Digest,
    random,
    store,
    admission,
  });
  return { runtime, store, admission, time, transport: new RecordingTransport(), config };
}

export function textEvent(delta: string, turnId = "turn-1"): SyncIngressEvent {
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

export function ackFrame(frame: DataFrame): ApplyAckFrame {
  return {
    type: "APPLY_ACK",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    transportEpoch: frame.transportEpoch,
    deliveryId: frame.deliveryId,
    result: "processed",
    docId: frame.docId,
  };
}

/** 从 `from` 起解码数据帧：只有 DOC_BASE / DOC_UPDATE 需要回执，控制帧线上不带 deliveryId。 */
export function dataFrames(transport: RecordingTransport, from: number): DataFrame[] {
  const frames: DataFrame[] = [];
  for (const bytes of transport.sent.slice(from)) {
    const frame = decodeSyncFrame(bytes);
    if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") frames.push(frame);
  }
  return frames;
}

/** 逐帧回执：ACK 是额度归还的唯一路径，额度未接线时这里会抛「归还字节超过在途字节」。 */
export async function ackAll(runtime: SyncScopeRuntime, frames: readonly DataFrame[]): Promise<number> {
  for (const frame of frames) {
    await runtime.onInboundBytes(encodeSyncFrame(ackFrame(frame)));
  }
  return frames.length;
}

/** 取出协议错误：非本层错误原样上抛，避免把「类型不对」当成「拒绝生效」。 */
export async function rejectionOf(promise: Promise<unknown>): Promise<SyncProtocolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the promise to be rejected");
}

export function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}
