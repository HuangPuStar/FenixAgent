// packages/chat-channel/src/__tests__/sync-acceptance-planes-oracle.ts
// A8 交付（设计 §15.2 场景矩阵 T08–T12）的**独立**夹具与 oracle：不 import
// `sync-acceptance-core-oracle.ts` / `sync-acceptance-recovery-oracle.ts` 的任何实现（设计 §15.1）。
//
// 独立性做法：
//   1. 期望值一律从**输入侧**构造：实时文本由 `TextLog`（按接收顺序记录原始增量并拼接）给出，
//      历史期望由本文件的对象计数与 ordinal 覆盖给出；不调用被测的分片 / 合并 / 投影 / 拼接函数。
//   2. 读取面只用 Yjs 原语（`Y.applyUpdate` + 自己的 `root.records` 结构读取）与存储的已提交出口；
//      「缺口 / 连续 / 唯一性」的判定全部由本文件的 oracle 计算。
//   3. **在途字节**由线上字节独立记账（`DeliveryAudit`）：`SyncFrameTransport.send` 实际接受的数据帧字节
//      减去客户端回执帧结清的字节，不使用 `QuotaController` 的内部数字——T09/T10 的「outstanding 有界」
//      与「额度不膨胀」因此是对**线上事实**的断言，而不是对被测算术的复述。
// 生产代码只出现在三处：被测对象（`createSyncScopeRuntime` / `createSyncClientTransport`）、线契约
// （`encodeSyncFrame` / `decodeSyncFrame`）、身份与存储端口（`buildDocId` / `scopeKey` / `ProjectionStore`）。
//
// 唯一的测试替身是三个宿主边界：`SyncFrameTransport`（进程内队列 + 可注入的饱和 / 丢帧 / 重复帧）、
// `PlaneClock`（假时钟，用例只推进它、不等墙钟）、以及 `FaultyProjectionStore`（T08 的提交期与 finalize
// 失败注入，逐调用委托给真实 `MemoryProjectionStore`，只在第 N 次调用上抛一次错）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import type { DocHub } from "../sync/client/doc-hub";
import { createSyncClientTransport, type SyncClientTransport } from "../sync/client/transport";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import type { ImportStatus } from "../sync/history/import-service";
import type { HistoryRecordMeta, IngestedRecord } from "../sync/history/ingest";
import {
  type DocBaseFrame,
  type DocUpdateFrame,
  decodeSyncFrame,
  encodeSyncFrame,
  type HelloFrame,
  type SubscribeFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import type { SyncFrameGateway, SyncFrameTransport } from "../sync/runtime/egress";
import type { SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  CommitGenerationInput,
  CommitGenerationResult,
  CreateDocInput,
  CreateGenerationInput,
  DirectoryPage,
  DirectoryQuery,
  DocStateSnapshot,
  GenerationEntryRefs,
  ProjectionStore,
  PutSealedInput,
  PutSealedResult,
  RefQuery,
  RegisterSuccessorInput,
  RegistrationResult,
  RetireResult,
  RetireTarget,
  SealDocInput,
  SealDocResult,
  SyncDocRecord,
  SyncGenerationRecord,
  SyncRefRecord,
  SyncScopeRow,
  SyncUpdateRecord,
  WriterLease,
} from "../sync/store/types";

// ------------------------------------------------------------------ 常量与时钟

/** 清理宽限期：与验收无关，取一个不会被推进到的值（推进它意味着代次字节被回收）。 */
export const PLANES_LIFECYCLE = { sealGraceMs: 600_000, retireGraceMs: 600_000 } as const;
/** 引导租约期限：夹具用完即让时钟越过它，把写权让给被测运行时或导入服务。 */
export const BOOTSTRAP_TTL_MS = 5_000;
/** 真实实现的写者租约期限（`LIVE_WRITER_LEASE_TTL_MS`）：用例据它构造租约过期。 */
export const WRITER_LEASE_TTL_MS = 30_000;
/** 默认 ACK 期限（`capacity.concurrency.ackDeadlineMs`）。 */
export const ACK_DEADLINE_MS = 30_000;
/** 内容槽位：实时正文。 */
export const TEXT_SLOT = "text";
/** 夹具默认使用的容量档位（生产默认档，T08/T12 的池上限断言取自它）。 */
export const PLANE_CAPACITY: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY;

/**
 * 单个 tail 帧的字节上界（base64 展开 + 帧头预算）。
 *
 * 这是夹具必须满足的不变量：**连接窗口 > 单帧上界**，否则 `emit` 的 `outstanding + 帧字节 ≤ 窗口`
 * 永远不成立，该帧永远发不出去而会话反复重试（T09/T10 的窗口类用例全部失效）。生产档位
 * （512KiB 窗口 / 128KiB 合并）有 3 倍余量；`tightenWindow` 按同一比例缩放。
 */
export function maxSingleTailFrameBytes(capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY): number {
  const payload = capacity.inputs.activeSoftPayloadBytes;
  // base64 每 3 字节输入产出 4 字节；帧头/摘要/信封的预算取 4KiB（远大于实际头长度）。
  return Math.ceil(payload / 3) * 4 + 4096;
}

/** 建一个真实内存投影 store（T08 的故障注入以它为底，除注入点外全部调用到达真实实现）。 */
export function createPlaneStore(
  capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
  clock: Clock = new PlaneClock(),
): MemoryProjectionStore {
  return new MemoryProjectionStore({ clock, digest: sha256Digest, capacity, lifecycle: PLANES_LIFECYCLE });
}

/** 可推进的假时钟：租约、ACK 期限、搁置期限、合并窗口都只经它取时。 */
export class PlaneClock implements Clock {
  private current: number;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

// ------------------------------------------------------------------ 字节与文本 oracle

const UTF8_DECODER = new TextDecoder();

/** 首处字节差异的下标；完全相同返回 null（用于「重发字节一致」类断言）。 */
export function firstByteDifference(left: Uint8Array, right: Uint8Array): number | null {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? null : limit;
}

/** 按接收顺序记录实时增量，并按 entry/slot 拼接出期望文本（不调用被测的合并实现）。 */
export class TextLog {
  private readonly parts = new Map<string, string[]>();

  push(event: SyncIngressEvent): void {
    if (event.kind !== "text-delta" || event.delta === undefined) return;
    const key = `${event.entryId}\u0000${event.contentSlot}`;
    const bucket = this.parts.get(key) ?? [];
    bucket.push(event.delta);
    this.parts.set(key, bucket);
  }

  textOf(entryId: string, contentSlot: string): string {
    return (this.parts.get(`${entryId}\u0000${contentSlot}`) ?? []).join("");
  }

  keys(): { entryId: string; contentSlot: string }[] {
    return [...this.parts.keys()].map((key) => {
      const separator = key.indexOf("\u0000");
      return { entryId: key.slice(0, separator), contentSlot: key.slice(separator + 1) };
    });
  }

  /** 全部期望文本的拼接（用于「内容完整」的粗粒度断言；顺序按首次出现）。 */
  joined(): string {
    return this.keys()
      .map((key) => this.textOf(key.entryId, key.contentSlot))
      .join("");
  }
}

// ------------------------------------------------------------------ 结构读取面（Y.Doc → 记录）

/** 一条内容记录的读取形状：只做类型收敛，不做业务解释。 */
export interface FlatRecord {
  readonly recordId: string;
  readonly entryId: string;
  readonly contentSlot: string | number;
  readonly kind: string;
  readonly payload: Uint8Array;
}

function asText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`oracle: record field ${field} is not a string`);
  return value;
}

function asSlot(value: unknown): string | number {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("oracle: record contentSlot is neither a string nor a non-negative integer");
}

/** 读取一个已重建 Doc 的 `root.records`（顺序即 Y.Array 顺序 = 写入顺序）。 */
export function readRecords(doc: Y.Doc): FlatRecord[] {
  const records = doc.getMap<unknown>("root").get("records");
  if (!(records instanceof Y.Array)) return [];
  return records.toArray().map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("oracle: record element is not an object");
    const view = new Map(Object.entries(value as Record<string, unknown>));
    const payload = view.get("payload");
    if (!(payload instanceof Uint8Array)) throw new Error("oracle: record payload is not a Uint8Array");
    return {
      recordId: asText(view.get("recordId"), "recordId"),
      entryId: asText(view.get("entryId"), "entryId"),
      contentSlot: asSlot(view.get("contentSlot")),
      kind: asText(view.get("kind"), "kind"),
      payload: new Uint8Array(payload),
    };
  });
}

/** 同一 entry/slot 的文本读取：逐条解码后按记录顺序拼接（本文件自己的拼接口径）。 */
export function textOfRecords(records: readonly FlatRecord[], entryId: string, contentSlot: string | number): string {
  return records
    .filter((record) => record.entryId === entryId && record.contentSlot === contentSlot)
    .map((record) => UTF8_DECODER.decode(record.payload))
    .join("");
}

/** 记录身份的唯一性检查：返回重复出现的 recordId（空数组即全部唯一）。 */
export function duplicateRecordIds(records: readonly FlatRecord[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const record of records) {
    if (seen.has(record.recordId)) duplicates.push(record.recordId);
    seen.add(record.recordId);
  }
  return duplicates;
}

/** 运行态实体（`doc.getMap("runtime")` 的条目）；只搬运事实，不解释语义。 */
export interface RuntimeEntityView {
  readonly entityId: string;
  readonly kind: string;
  readonly state: string;
}

/** 读取运行态实体表（根键名由 Y.Doc 结构给出，不 import 生产常量）。 */
export function readRuntimeEntities(doc: Y.Doc, table = "runtime"): RuntimeEntityView[] {
  const entities: RuntimeEntityView[] = [];
  doc.getMap<unknown>(table).forEach((value, key) => {
    if (typeof value !== "object" || value === null) throw new Error("oracle: runtime entity is not an object");
    const view = new Map(Object.entries(value as Record<string, unknown>));
    entities.push({
      entityId: asText(view.get("entityId") ?? key, "entityId"),
      kind: asText(view.get("kind"), "kind"),
      state: asText(view.get("state"), "state"),
    });
  });
  return entities.sort((left, right) => left.entityId.localeCompare(right.entityId));
}

// ------------------------------------------------------------------ 传输端口与线上记账

/** 一条被观察到的线上帧。 */
export interface WireRecord {
  readonly direction: "server-to-client" | "client-to-server";
  readonly frame: SyncFrame;
  readonly bytes: Uint8Array;
}

/**
 * 进程内传输端口（宿主 WS 边界）：`send` 返回 false 表示传输饱和，`close` 记录理由。
 *
 * 与真实宿主一致的三个原语之外，额外提供用例需要的注入点：`refuseNext`（下 N 次 `send` 返回 false）、
 * `bufferedBytes`（socket 待发送真值）、`dropOutbound` / `dropInbound`（丢帧）、`duplicateInbound`（重复注入）。
 */
export class PlaneLink implements SyncFrameTransport {
  /** 服务端出站队列：由 `pump` 交给客户端 `onFrame`。 */
  readonly outbound: Uint8Array[] = [];
  /** 客户端出站队列：由 `pump` 交给服务端 `onInboundBytes`。 */
  readonly inbound: Uint8Array[] = [];
  /** `send` 返回 true 的帧（真正交付到线上的字节）。 */
  readonly accepted: WireRecord[] = [];
  /** 全部出站尝试（含被拒）——用于「搁置位只有一位」这类观测。 */
  readonly attempts: WireRecord[] = [];
  /**
   * 服务端**实际派发**过的入站帧（客户端 → 服务端方向的观察点）。
   *
   * 与 `DeliveryAudit` 的分工：审计只关心带 `deliveryId` 的回执与在途字节，这里保留每一条入站帧的形状，
   * 供 T10 断言「客户端发过 RESYNC」「重复 ACK 被重复派发」这类线上事实。被 `dropInbound` 丢掉的帧
   * 从未到达服务端，两个观察面都不记录。
   */
  readonly observedInbound: SyncFrame[] = [];
  readonly closeReasons: string[] = [];
  /** socket 待发送字节真值（网关门禁的输入）。 */
  bufferedBytes = 0;
  dropOutbound: ((frame: SyncFrame) => boolean) | null = null;
  /** 丢一条客户端→服务端的帧（模拟链路丢失）：该帧不派发、不入账，与「服务端收到后自行丢弃」不同。 */
  dropInbound: ((frame: SyncFrame) => boolean) | null = null;
  duplicateInbound: ((frame: SyncFrame) => boolean) | null = null;
  private refuseRemaining = 0;
  private closed = false;

  /** 让接下来的 `count` 次 `send` 返回 false（传输饱和）。 */
  refuseNext(count: number): void {
    this.refuseRemaining += count;
  }

  send(bytes: Uint8Array): boolean {
    const frame = decodeSyncFrame(bytes);
    this.attempts.push({ direction: "server-to-client", frame, bytes });
    if (this.refuseRemaining > 0) {
      this.refuseRemaining -= 1;
      return false;
    }
    if (this.closed) return false;
    this.accepted.push({ direction: "server-to-client", frame, bytes });
    this.outbound.push(bytes);
    return true;
  }
  bufferedAmount(): number {
    return this.bufferedBytes;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReasons.push(reason);
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** 客户端出站（`SyncClientTransportOptions.send`）：饱和返回 false，由客户端层自行保留积压。 */
  sendFromClient(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    this.inbound.push(bytes);
    return true;
  }
}

/**
 * 线上在途字节记账（T09/T10 的独立口径）。
 *
 * `delivered` = 传输层真正接受的**数据帧**字节（按 `deliveryId` 去重，重复投递单独记录）；
 * `acked` = 客户端回执帧结清过的 `deliveryId`。两者之差就是「已发送未回执」——被测算术若超发或重复归还，
 * 这个数字会越过配置窗口，而它与 `QuotaController` 的内部状态没有任何共享。
 */
export class DeliveryAudit {
  readonly delivered = new Map<string, number>();
  readonly acked = new Set<string>();
  readonly duplicateDeliveries: string[] = [];
  /** 回执里出现、但从未在本连接投递过的 deliveryId（伪造 / 异代次）。 */
  readonly unknownAcks: string[] = [];
  /** 代次与最近一次已接受数据帧不同的回执（T10 的「旧 epoch ACK 应被忽略」）。 */
  readonly staleEpochAcks: string[] = [];
  private epoch: string | null = null;

  /** 记录本连接在线上观测到的代次：只有同代次回执才允许结清在途（与实现同口径的线上事实）。 */
  noteEpoch(epoch: string): void {
    this.epoch = epoch;
  }

  /** 记录一条出站帧；只有带 `deliveryId` 的数据帧计入在途。 */
  recordOutbound(record: WireRecord): void {
    const deliveryId = deliveryIdOf(record.frame);
    if (deliveryId === null) return;
    if (this.delivered.has(deliveryId)) {
      this.duplicateDeliveries.push(deliveryId);
      return;
    }
    this.delivered.set(deliveryId, record.bytes.byteLength);
  }

  /**
   * 记录一条入站回执帧（两种结果都归还额度，因此都结清）；异代次回执单独记账、不结清。
   *
   * 只对被**派发到服务端**的回执记账：`dropInbound` 丢掉的帧由 `roundOf` 拦在记账之前。
   */
  recordInbound(record: WireRecord): void {
    const deliveryId = deliveryIdOf(record.frame);
    if (deliveryId === null) return;
    const epoch = record.frame.type === "APPLY_ACK" ? record.frame.transportEpoch : null;
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) {
      this.staleEpochAcks.push(deliveryId);
      return;
    }
    if (!this.delivered.has(deliveryId)) this.unknownAcks.push(deliveryId);
    this.acked.add(deliveryId);
  }

  outstandingBytes(): number {
    let total = 0;
    for (const [deliveryId, bytes] of this.delivered) {
      if (!this.acked.has(deliveryId)) total += bytes;
    }
    return total;
  }

  outstandingCount(): number {
    let count = 0;
    for (const deliveryId of this.delivered.keys()) {
      if (!this.acked.has(deliveryId)) count += 1;
    }
    return count;
  }

  deliveredBytes(): number {
    let total = 0;
    for (const bytes of this.delivered.values()) total += bytes;
    return total;
  }
}

/** 取帧上的 `deliveryId`（线契约字段：只有数据帧与回执帧带它）。 */
export function deliveryIdOf(frame: SyncFrame): string | null {
  if (!("deliveryId" in frame)) return null;
  const value = frame.deliveryId;
  return typeof value === "string" ? value : null;
}

/** 一次真正应用到客户端镜像的投递（base 与应用序号区间；`kind` 只用于区分来源）。 */
export interface AppliedDelivery {
  readonly kind: "base" | "update";
  readonly docId: string;
  readonly deliveryId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
}

/**
 * 应用序号覆盖（T10 的「缺口可补齐」独立口径）：只记录**真正应用到镜像**的数据帧区间，
 * 由此给出「1..max 是否连续覆盖」与「同一区间被两个增量帧重复投递」两个事实。
 *
 * 与 `PlaneMirror` 的分工：镜像回答「字节合成了什么内容」，这里回答「应用序号有没有洞」；
 * 两者都不读取被测算术的内部游标（`session.appliedSeq` / `doc-hub.entry.appliedSeq`）。
 */
export class DeliveryTrace {
  readonly applied: AppliedDelivery[] = [];

  noteBase(docId: string, deliveryId: string, baseSeq: number): void {
    this.applied.push({ kind: "base", docId, deliveryId, fromSeq: 0, toSeq: baseSeq });
  }

  noteUpdate(docId: string, deliveryId: string, fromSeq: number, toSeq: number): void {
    this.applied.push({ kind: "update", docId, deliveryId, fromSeq, toSeq });
  }

  /** 1..maxSeq 的覆盖：缺口列表与最大序号；base 的下界 0 归一到 1（业务序号从 1 起）。 */
  coverage(docId: string): { gaps: number[]; maxSeq: number } {
    const seen = new Set<number>();
    let maxSeq = 0;
    for (const delivery of this.applied) {
      if (delivery.docId !== docId) continue;
      const start = Math.max(1, delivery.fromSeq);
      for (let seq = start; seq <= delivery.toSeq; seq += 1) {
        seen.add(seq);
        maxSeq = Math.max(maxSeq, seq);
      }
    }
    const gaps: number[] = [];
    for (let seq = 1; seq <= maxSeq; seq += 1) {
      if (!seen.has(seq)) gaps.push(seq);
    }
    return { gaps, maxSeq };
  }

  /** 被两个以上**增量帧**重复覆盖的序号（base 重发不算：换 attempt 后重发基线是设计允许的补齐）。 */
  duplicateUpdateSeqs(docId: string): number[] {
    const counts = new Map<number, number>();
    for (const delivery of this.applied) {
      if (delivery.docId !== docId || delivery.kind !== "update") continue;
      for (let seq = delivery.fromSeq; seq <= delivery.toSeq; seq += 1) {
        counts.set(seq, (counts.get(seq) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([seq]) => seq)
      .sort((a, b) => a - b);
  }

  updateRanges(docId: string): string[] {
    return this.applied
      .filter((delivery) => delivery.docId === docId && delivery.kind === "update")
      .map((delivery) => `${delivery.fromSeq}-${delivery.toSeq}`);
  }
}

/** 客户端内容镜像：只应用**收到的数据帧字节**，不参与期望构造（观察「交付了什么字节」）。 */
export class PlaneMirror {
  private readonly docs = new Map<string, Y.Doc>();

  applyFrame(frame: DocBaseFrame | DocUpdateFrame): void {
    const doc = this.docOf(frame.docId);
    Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
  }

  has(docId: string): boolean {
    return this.docs.has(docId);
  }

  records(docId: string): FlatRecord[] {
    const doc = this.docs.get(docId);
    return doc === undefined ? [] : readRecords(doc);
  }

  entities(docId: string): RuntimeEntityView[] {
    const doc = this.docs.get(docId);
    return doc === undefined ? [] : readRuntimeEntities(doc);
  }

  /** 镜像的 canonical 字节；从未见过该 Doc 时返回 null（不伪造空 Doc）。 */
  canonicalBytes(docId: string): Uint8Array | null {
    const doc = this.docs.get(docId);
    return doc === undefined ? null : Y.encodeStateAsUpdate(doc);
  }

  docIds(): string[] {
    return [...this.docs.keys()];
  }

  private docOf(docId: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing !== undefined) return existing;
    const created = new Y.Doc();
    this.docs.set(docId, created);
    return created;
  }
}

// ------------------------------------------------------------------ 已提交状态观测

/** `MemoryProjectionStore.exportCommittedState()` 的一行（夹具只搬运事实，不解释语义）。 */
export interface CommittedDocRow {
  readonly docId: string;
  readonly kind: DocKind;
  readonly state: string;
  readonly hash: string;
  readonly blockIndex: number | null;
  readonly ordinalStart: number | null;
  readonly ordinalEnd: number | null;
  readonly finalSeq: number | null;
}

interface CommittedStateView {
  readonly generations: { readonly generation: string; readonly state: string; readonly retiredAt: number | null }[];
  readonly docs: CommittedDocRow[];
}

/** 导出已提交状态：内存 store 的专有观测出口（存储端口没有「列出全部行」的原语）。 */
function committedStateOf(store: ProjectionStore): CommittedStateView {
  const candidate = store as Partial<{ exportCommittedState: () => CommittedStateView }>;
  if (typeof candidate.exportCommittedState !== "function") {
    throw new Error("oracle: store does not expose committed state; use MemoryProjectionStore");
  }
  return candidate.exportCommittedState();
}

// ------------------------------------------------------------------ 容量档位

/**
 * 收紧连接窗口与 tail 合并预算（窗口与 socket 水位必须同值，否则装配期校验直接拒绝）。
 *
 * tail 合并预算（`inputs.activeSoftPayloadBytes`）按窗口等比缩放，比例取生产档位的 4:1
 * （512KiB 窗口 / 128KiB 合并）。这一步不是「调参让用例通过」：单帧字节上限由它决定，而
 * `emit` 的窗口判定是 `outstanding + 单帧字节 ≤ 窗口`——若合并预算超过窗口，任何一次
 * tail 追赶都会产出一帧永远发不出去的内容，连接停在「反复重试同一帧」上，客户端再也拿不到
 * 后续内容（窗口小于单帧上限时的死锁；生产档位由 512KiB > 288KiB 帧上限避开，但没有断言守护）。
 * 因此夹具必须保持「窗口 > 单帧上限」，缩放后仍留 4 倍余量。
 */
export function tightenWindow(
  windowBytes: number,
  base: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
): SyncCapacityProfile {
  return {
    ...base,
    concurrency: {
      ...base.concurrency,
      connectionBodyWindowBytes: windowBytes,
      socketHighWatermarkBytes: windowBytes,
    },
    inputs: { ...base.inputs, activeSoftPayloadBytes: Math.floor(windowBytes / 4) },
  };
}

// ------------------------------------------------------------------ 故障注入 store（T08）

/** 可注入失败的存储方法（T08 的提交期与 finalize 失败必须落在真实路径上）。 */
export type FaultyStoreMethod = "putSealedIfAbsent" | "commitGeneration" | "appendUpdates" | "createDoc";

/**
 * 逐调用委托给真实存储，只在指定方法第 `afterCalls + 1` 次调用上抛一次错。
 *
 * 这是宿主边界上的故障注入（真实存储的语义、字节与幂等键全部保留），不是「用近似实现冒充存储」：
 * 除被注入的那一次调用外，所有读写都到达真实 `MemoryProjectionStore`。
 */
export class FaultyProjectionStore implements ProjectionStore {
  private calls = 0;
  private fired = false;

  constructor(
    private readonly base: ProjectionStore,
    private readonly fault: { method: FaultyStoreMethod; afterCalls: number; error: Error },
  ) {}

  /** 注入是否已经触发（用例据此确认「失败确实发生在本阶段」）。 */
  didFire(): boolean {
    return this.fired;
  }

  /**
   * 已提交状态观测出口透传：`MemoryProjectionStore` 的专有出口，故障注入不改变读语义
   * （否则夹具在注入 store 上连「已提交了什么」都读不到，只能改用近似实现冒充存储）。
   */
  exportCommittedState(): CommittedStateView {
    return committedStateOf(this.base);
  }

  private maybeFail(method: FaultyStoreMethod): void {
    if (this.fired || method !== this.fault.method) return;
    this.calls += 1;
    if (this.calls > this.fault.afterCalls) {
      this.fired = true;
      throw this.fault.error;
    }
  }

  acquireWriter(key: string, owner: string, ttlMs: number): Promise<WriterLease> {
    return this.base.acquireWriter(key, owner, ttlMs);
  }

  renewWriter(lease: WriterLease, ttlMs: number): Promise<WriterLease> {
    return this.base.renewWriter(lease, ttlMs);
  }

  createGeneration(input: CreateGenerationInput): Promise<RegistrationResult> {
    return this.base.createGeneration(input);
  }

  createDoc(input: CreateDocInput): Promise<RegistrationResult> {
    this.maybeFail("createDoc");
    return this.base.createDoc(input);
  }

  registerSuccessor(input: RegisterSuccessorInput): Promise<RegistrationResult> {
    return this.base.registerSuccessor(input);
  }

  appendUpdates(input: AppendUpdatesInput): Promise<AppendUpdatesResult> {
    this.maybeFail("appendUpdates");
    return this.base.appendUpdates(input);
  }

  putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    this.maybeFail("putSealedIfAbsent");
    return this.base.putSealedIfAbsent(input);
  }

  sealDoc(input: SealDocInput): Promise<SealDocResult> {
    return this.base.sealDoc(input);
  }

  commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
    this.maybeFail("commitGeneration");
    return this.base.commitGeneration(input);
  }

  readDocStateAt(docId: string, seq: number): Promise<DocStateSnapshot | null> {
    return this.base.readDocStateAt(docId, seq);
  }

  readUpdatesAfter(docId: string, seq: number, limit: number): Promise<SyncUpdateRecord[]> {
    return this.base.readUpdatesAfter(docId, seq, limit);
  }

  readScopePointer(key: string): Promise<SyncScopeRow | null> {
    return this.base.readScopePointer(key);
  }

  readGeneration(key: string, generation: string): Promise<SyncGenerationRecord | null> {
    return this.base.readGeneration(key, generation);
  }

  readDirectory(query: DirectoryQuery): Promise<DirectoryPage> {
    return this.base.readDirectory(query);
  }

  locateRefs(query: RefQuery): Promise<SyncRefRecord[]> {
    return this.base.locateRefs(query);
  }

  retireAndCollect(key: string, target: RetireTarget): Promise<RetireResult> {
    return this.base.retireAndCollect(key, target);
  }
}

// ------------------------------------------------------------------ 夹具

/** 单条连接（= 一个 scope 运行时 + 一条进程内传输 + 一个真实客户端传输）。 */
export interface PlaneConnection {
  readonly label: string;
  readonly runtime: SyncScopeRuntime;
  readonly gateway: SyncFrameGateway;
  readonly link: PlaneLink;
  readonly client: SyncClientTransport;
  readonly hub: DocHub;
  readonly mirror: PlaneMirror;
  readonly audit: DeliveryAudit;
  /** 真正应用到镜像的数据帧区间（应用序号连续性的独立口径）。 */
  readonly applied: DeliveryTrace;
  readonly fatal: { readonly code: string; readonly detail: string | undefined }[];
  /** 收到的控制帧（本层不解释，只记录）。 */
  readonly control: SyncFrame[];
  /** 完整握手（HELLO）→ 交付 MANIFEST 与 HELLO 回执。 */
  handshake(input?: { generation?: string; loadedDocs?: readonly string[] }): Promise<void>;
  subscribe(docIds?: readonly string[], priority?: SubscribeFrame["priority"]): Promise<void>;
  writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void>;
  writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void>;
  acceptIngress(event: SyncIngressEvent): Promise<void>;
  /** 直接入站一条帧（不经队列），用于断言同步拒绝（例如旧 pointerRevision）。 */
  sendFrameNow(frame: SyncFrame): Promise<void>;
  /**
   * 暂停 / 恢复客户端的 apply 调度（T09 的慢客户端与后台标签页）。
   *
   * 暂停后仍收字节、仍进 hub 队列，但不 `drain`：不 apply、不回执——这正是「标签页被节流」的线上表现，
   * 服务端因此拿不到回执，只能靠连接窗口自我约束。暂停是夹具开关，不是生产常量。
   */
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  dispose(): Promise<void>;
}

export interface PlaneHarness {
  readonly scope: SyncScope;
  readonly scopeKey: string;
  readonly store: ProjectionStore;
  readonly admission: AdmissionController;
  readonly time: PlaneClock;
  readonly config: SyncRuntimeConfig;
  readonly seedGeneration: string;
  readonly seedContentDocId: string;
  readonly seedRuntimeDocId: string;
  readonly seedEntryRefs: GenerationEntryRefs;
  /** 构造期签发、返回前已过期的引导租约（T11 的旧 epoch 写入拒绝用它）。 */
  readonly bootstrapLease: WriterLease;
  readonly log: TextLog;
  readonly spoolRoot: string;
  /** 第一条连接（`connect: false` 时为 null）。 */
  readonly primary: PlaneConnection | null;
  readonly connections: readonly PlaneConnection[];
  /** 在同一存储上再开一条连接（独立运行时 / 会话 / 额度）。 */
  connect(label: string, options?: { readonly seed?: string }): Promise<PlaneConnection>;
  /** 推进一轮：每条连接各自「出站 → 客户端 drain → 入站 → tick」。 */
  round(): Promise<number>;
  /** 推进到静止（无帧流动）或达到轮数上限。 */
  pump(): Promise<void>;
  /** 静止并返回本轮推进的帧数。 */
  settle(): Promise<number>;
  writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void>;
  writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void>;
  canonicalBytes(docId: string): Promise<Uint8Array>;
  canonicalRecords(docId: string): Promise<FlatRecord[]>;
  runtimeEntities(docId?: string): Promise<RuntimeEntityView[]>;
  docsOfKind(kind: DocKind): CommittedDocRow[];
  allDocRows(): CommittedDocRow[];
  generationState(generation: string): Promise<string>;
  currentGeneration(): Promise<string>;
  currentEntryRefs(): Promise<GenerationEntryRefs>;
  currentPointerRevision(): Promise<number>;
  contentDocIds(): Promise<string[]>;
  /** 目录覆盖：ordinal 1..max 是否被恰好覆盖一次（返回缺口与重复序号）。 */
  coverage(generation?: string): Promise<{ gaps: number[]; duplicates: number[]; maxOrdinal: number }>;
  /** 已提交代次的全部内容块记录（按目录 ordinal 展开；跨块顺序的唯一依据）。 */
  flatRecords(): Promise<FlatRecord[]>;
  /** 历史导入入口（所有连接共享同一实现实例，取第一条连接的服务）。 */
  history(): SyncScopeRuntime["history"];
  beginImport(input?: { readonly owner?: string; readonly leaseTtlMs?: number }): Promise<{
    loadId: string;
    generation: string;
  }>;
  acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord>;
  acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord>;
  importStatus(): ImportStatus | null;
  /** 把一条客户端帧排入入站队列（丢帧 / 重复 / 伪造注入都走这里）。 */
  queueClientFrame(connection: PlaneConnection, frame: SyncFrame): void;
  disposeAll(): Promise<void>;
}

export interface PlaneHarnessOptions {
  readonly scope?: SyncScope;
  /** 随机源种子：影响代次 / 写者 owner / deliveryId；多连接场景必须彼此不同。 */
  readonly seed?: string;
  readonly generation?: string;
  readonly capacity?: SyncCapacityProfile;
  /** 收紧连接窗口（与 socket 水位同值）。 */
  readonly windowBytes?: number;
  readonly merge?: { readonly maxBytes?: number; readonly maxDelayMs?: number };
  readonly ackMs?: number;
  readonly store?: ProjectionStore;
  readonly admission?: AdmissionController;
  readonly clock?: PlaneClock;
  readonly spoolRoot?: string;
  /** 是否立刻建立第一条连接（只做历史导入的 scope 不需要）。 */
  readonly connect?: boolean;
}

/** 每轮的 pump 上限：静止判定靠「本轮没有帧流动」，这个数字只防止实现缺陷造成死循环。 */
const MAX_PUMP_ROUNDS = 32;
/** 单 Doc 增量读取上限：验收数据集远小于它，取大值以避免把「截断」误判成「内容缺失」。 */
const UPDATE_READ_LIMIT = 100_000;

/** 一条内容块的读取视图（ordinal 范围来自目录行，记录来自已提交字节）。 */
export interface PlaneDirectoryBlock {
  readonly docId: string;
  readonly ordinalStart: number;
  readonly ordinalEnd: number;
  readonly records: FlatRecord[];
}

/** 空 Y.Doc 的 canonical 字节（验收的初始基线：没有任何记录）。 */
function emptyDocBytes(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** 登记初始 active 文档（`MemoryProjectionStore` 要求 active + baseSeq 0 + 摘要一致）。 */
function activeDocRecord(input: {
  scopeKey: string;
  generation: string;
  docId: string;
  kind: DocKind;
  snapshot: Uint8Array;
}): SyncDocRecord {
  return {
    scopeKey: input.scopeKey,
    generation: input.generation,
    docId: input.docId,
    kind: input.kind,
    state: "active",
    snapshot: input.snapshot,
    hash: sha256Digest(input.snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: 0,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 代次入口闭包：与 `buildDocId` 的线格式一致（`sync/<kind>/<generation>/<index>/<nonce>`）。 */
function entryRefsFor(generation: string): GenerationEntryRefs {
  return {
    controlDocId: buildDocId({ kind: "control", generation, blockIndex: 0, nonce: "control" }),
    directoryDocId: buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: "directory" }),
    runtimeDocId: buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: "runtime" }),
    contentDocIds: [buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "content" })],
  };
}

class PlaneConnectionImpl implements PlaneConnection {
  readonly link: PlaneLink;
  readonly mirror = new PlaneMirror();
  readonly audit = new DeliveryAudit();
  readonly applied = new DeliveryTrace();
  readonly fatal: { code: string; detail: string | undefined }[] = [];
  readonly control: SyncFrame[] = [];
  readonly hub: DocHub;
  private boundGateway: SyncFrameGateway | null = null;

  constructor(
    readonly label: string,
    readonly runtime: SyncScopeRuntime,
    link: PlaneLink,
    private readonly harness: PlaneHarnessImpl,
  ) {
    this.link = link;
    this.hub = this.client.hub;
  }

  /** 运行时只允许绑定一次端口，故网关在构造之后注入。 */
  attachGateway(gateway: SyncFrameGateway): void {
    this.boundGateway = gateway;
  }

  get gateway(): SyncFrameGateway {
    if (this.boundGateway === null) throw new Error(`连接 ${this.label} 未绑定网关`);
    return this.boundGateway;
  }

  readonly client: SyncClientTransport = createSyncClientTransport({
    // 假时钟 + 立即兑现的让出点：验收不等待墙钟，但保留「分片之间让出执行权」的调用点。
    send: (bytes) => this.link.sendFromClient(bytes),
    now: () => this.harness.time.now(),
    yieldToHost: () => Promise.resolve(),
    onControl: (frame) => this.control.push(frame),
    onFatal: (code, detail) => this.fatal.push({ code, detail }),
  });

  async handshake(input?: { generation?: string; loadedDocs?: readonly string[] }): Promise<void> {
    const generation = input?.generation ?? (await this.harness.currentGeneration());
    const frame: HelloFrame = {
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: this.harness.scope,
      generation,
      loadedDocs: (input?.loadedDocs ?? []).map((docId) => ({ docId })),
      stateful: false,
    };
    await this.sendFrameNow(frame);
    await this.harness.pump();
  }

  async subscribe(docIds?: readonly string[], priority: SubscribeFrame["priority"] = "live"): Promise<void> {
    const target = docIds ?? (await this.harness.contentDocIds());
    for (const docId of target) this.hub.retain(docId);
    const frame: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [...target],
      priority,
    };
    await this.sendFrameNow(frame);
    await this.harness.pump();
  }

  async acceptIngress(event: SyncIngressEvent): Promise<void> {
    await this.runtime.acceptIngress(event);
  }

  async writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void> {
    const turnId = key?.turnId ?? "turn-1";
    const event: SyncIngressEvent = {
      kind: "text-delta",
      turnId,
      entryId: key?.entryId ?? `${turnId}:assistant`,
      contentSlot: key?.contentSlot ?? TEXT_SLOT,
      contentType: "text/plain",
      delta,
    };
    this.harness.log.push(event);
    await this.acceptIngress(event);
    await this.harness.pump();
  }

  async writeSemantic(kind: string, payload: Record<string, unknown>, turnId = "turn-1"): Promise<void> {
    const event: SyncIngressEvent = {
      kind: "semantic",
      turnId,
      entryId: `${turnId}:assistant`,
      contentSlot: TEXT_SLOT,
      contentType: "text/plain",
      semantic: { kind: kind as "tool", payload },
    };
    await this.acceptIngress(event);
    await this.harness.pump();
  }

  async sendFrameNow(frame: SyncFrame): Promise<void> {
    await this.runtime.onInboundBytes(encodeSyncFrame(frame));
  }

  paused = false;

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async dispose(): Promise<void> {
    this.client.dispose();
    await this.runtime.dispose();
  }
}

class PlaneHarnessImpl implements PlaneHarness {
  readonly log = new TextLog();
  private readonly attached: PlaneConnectionImpl[] = [];

  constructor(
    readonly scope: SyncScope,
    readonly scopeKey: string,
    readonly store: ProjectionStore,
    readonly admission: AdmissionController,
    readonly time: PlaneClock,
    readonly config: SyncRuntimeConfig,
    readonly seedGeneration: string,
    readonly seedContentDocId: string,
    readonly seedRuntimeDocId: string,
    readonly seedEntryRefs: GenerationEntryRefs,
    readonly bootstrapLease: WriterLease,
    readonly spoolRoot: string,
    private readonly ownedSpoolRoot: boolean,
  ) {}

  get connections(): readonly PlaneConnection[] {
    return this.attached;
  }

  get primary(): PlaneConnection | null {
    return this.attached[0] ?? null;
  }

  async connect(label: string, options?: { readonly seed?: string }): Promise<PlaneConnection> {
    const runtime = await createSyncScopeRuntime({
      scope: this.scope,
      config: this.config,
      clock: this.time,
      digest: sha256Digest,
      random: deterministicRandomSource(options?.seed ?? `${label}-runtime`),
      store: this.store,
      admission: this.admission,
    });
    // `attachTransport` 每个 scope 只允许绑定一次，因此必须先建 link 与连接对象，再完成绑定。
    const link = new PlaneLink();
    const connection = new PlaneConnectionImpl(label, runtime, link, this);
    const gateway = runtime.attachTransport(link);
    connection.attachGateway(gateway);
    this.attached.push(connection);
    return connection;
  }

  async round(): Promise<number> {
    let moved = 0;
    for (const connection of this.attached) {
      moved += await this.roundOf(connection);
    }
    return moved;
  }

  private async roundOf(connection: PlaneConnectionImpl): Promise<number> {
    let moved = 0;
    while (connection.link.outbound.length > 0) {
      const bytes = connection.link.outbound.shift();
      if (bytes === undefined) break;
      moved += 1;
      const record: WireRecord = { direction: "server-to-client", frame: decodeSyncFrame(bytes), bytes };
      connection.audit.recordOutbound(record);
      if (connection.link.dropOutbound?.(record.frame) === true) continue;
      const frame = record.frame;
      if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") {
        connection.audit.noteEpoch(frame.transportEpoch);
        connection.mirror.applyFrame(frame);
        if (frame.type === "DOC_BASE") connection.applied.noteBase(frame.docId, frame.deliveryId, frame.baseSeq);
        else connection.applied.noteUpdate(frame.docId, frame.deliveryId, frame.fromSeq, frame.toSeq);
      }
      connection.client.onFrame(bytes);
    }
    if (!connection.paused) await connection.client.drain();
    while (connection.link.inbound.length > 0) {
      const bytes = connection.link.inbound.shift();
      if (bytes === undefined) break;
      moved += 1;
      const record: WireRecord = { direction: "client-to-server", frame: decodeSyncFrame(bytes), bytes };
      const duplicate = connection.link.duplicateInbound?.(record.frame) === true;
      // 链路丢帧：这一帧从未到达服务端，因此既不算「实际派发过的入站帧」，也不得进回执账目——
      // 否则「丢了 ACK」在观测里会表现成「已结清」，T10 的账目断言就变成了恒真。
      if (connection.link.dropInbound?.(record.frame) === true) continue;
      connection.audit.recordInbound(record);
      connection.link.observedInbound.push(record.frame);
      await connection.runtime.onInboundBytes(bytes);
      if (duplicate) {
        // 重复注入走同一条派发路径：线上真值就是「服务端看到同一帧两次」。
        connection.link.observedInbound.push(record.frame);
        await connection.runtime.onInboundBytes(bytes);
      }
    }
    await connection.runtime.tick();
    return moved;
  }

  async pump(): Promise<void> {
    for (let index = 0; index < MAX_PUMP_ROUNDS; index += 1) {
      const moved = await this.round();
      if (moved === 0 && this.isQuiet()) return;
    }
    throw new Error(`planes acceptance pump did not settle within ${MAX_PUMP_ROUNDS} rounds`);
  }

  /**
   * 静止判定必须同时看两个方向：`tick` 在轮次末尾产出的帧落在 `outbound` 里、要到下一轮才交付，
   * 只看「本轮搬运数 0」会在一帧刚产出时就宣告静止，把服务端还没来得及发出的字节留在队列里。
   */
  private isQuiet(): boolean {
    return this.attached.every(
      (connection) => connection.link.outbound.length === 0 && connection.link.inbound.length === 0,
    );
  }

  async settle(): Promise<number> {
    let moved = 0;
    for (let index = 0; index < MAX_PUMP_ROUNDS; index += 1) {
      const round = await this.round();
      moved += round;
      if (round === 0) return moved;
    }
    throw new Error(`planes acceptance settle did not converge within ${MAX_PUMP_ROUNDS} rounds`);
  }

  async writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void> {
    await this.requirePrimary().writeText(delta, key);
  }

  async writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void> {
    await this.requirePrimary().writeSemantic(kind, payload, turnId);
  }

  private requirePrimary(): PlaneConnection {
    const primary = this.primary;
    if (primary === null) throw new Error("oracle: harness has no connection");
    return primary;
  }

  async canonicalBytes(docId: string): Promise<Uint8Array> {
    const base = await this.store.readDocStateAt(docId, 0);
    if (base === null) throw new Error(`oracle: doc ${docId} has no committed baseline at seq 0`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base.snapshot);
    const updates = await this.store.readUpdatesAfter(docId, 0, UPDATE_READ_LIMIT);
    for (const update of updates) Y.applyUpdate(doc, update.bytes);
    return Y.encodeStateAsUpdate(doc);
  }

  async canonicalRecords(docId: string): Promise<FlatRecord[]> {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(docId));
    return readRecords(doc);
  }

  async runtimeEntities(docId?: string): Promise<RuntimeEntityView[]> {
    const target = docId ?? this.seedRuntimeDocId;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(target));
    return readRuntimeEntities(doc);
  }

  docsOfKind(kind: DocKind): CommittedDocRow[] {
    return this.allDocRows()
      .filter((row) => row.kind === kind)
      .sort((left, right) => (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
  }

  allDocRows(): CommittedDocRow[] {
    return committedStateOf(this.store).docs.map((row) => ({
      docId: row.docId,
      kind: row.kind,
      state: row.state,
      hash: row.hash,
      blockIndex: row.blockIndex,
      ordinalStart: row.ordinalStart,
      ordinalEnd: row.ordinalEnd,
      finalSeq: row.finalSeq,
    }));
  }

  async generationState(generation: string): Promise<string> {
    const record = await this.store.readGeneration(this.scopeKey, generation);
    return record?.state ?? "unknown";
  }

  async currentGeneration(): Promise<string> {
    const pointer = await this.store.readScopePointer(this.scopeKey);
    return pointer?.currentGeneration ?? this.seedGeneration;
  }

  async currentEntryRefs(): Promise<GenerationEntryRefs> {
    const record = await this.store.readGeneration(this.scopeKey, await this.currentGeneration());
    if (record === null) throw new Error("oracle: current generation record is missing");
    return record.entryRefs;
  }

  async currentPointerRevision(): Promise<number> {
    const pointer = await this.store.readScopePointer(this.scopeKey);
    return pointer?.pointerRevision ?? 0;
  }

  async contentDocIds(): Promise<string[]> {
    const record = await this.store.readGeneration(this.scopeKey, await this.currentGeneration());
    return record === null ? [] : [...record.entryRefs.contentDocIds];
  }

  async directoryBlocks(generation?: string): Promise<PlaneDirectoryBlock[]> {
    const target = generation ?? (await this.currentGeneration());
    const page = await this.store.readDirectory({ generation: target, limit: 2048 });
    const blocks: PlaneDirectoryBlock[] = [];
    for (const entry of [...page.entries].sort((left, right) => left.ordinalStart - right.ordinalStart)) {
      const doc = new Y.Doc();
      const base = await this.store.readDocStateAt(entry.docId, 0);
      if (base === null) throw new Error(`oracle: sealed block ${entry.docId} has no committed baseline`);
      Y.applyUpdate(doc, base.snapshot);
      blocks.push({
        docId: entry.docId,
        ordinalStart: entry.ordinalStart,
        ordinalEnd: entry.ordinalEnd,
        records: readRecords(doc),
      });
    }
    return blocks;
  }

  async coverage(generation?: string): Promise<{ gaps: number[]; duplicates: number[]; maxOrdinal: number }> {
    const blocks = await this.directoryBlocks(generation);
    const seen = new Map<number, number>();
    let maxOrdinal = 0;
    for (const block of blocks) {
      for (let ordinal = block.ordinalStart; ordinal <= block.ordinalEnd; ordinal += 1) {
        seen.set(ordinal, (seen.get(ordinal) ?? 0) + 1);
        maxOrdinal = Math.max(maxOrdinal, ordinal);
      }
    }
    const gaps: number[] = [];
    const duplicates: number[] = [];
    for (let ordinal = 1; ordinal <= maxOrdinal; ordinal += 1) {
      const count = seen.get(ordinal) ?? 0;
      if (count === 0) gaps.push(ordinal);
      if (count > 1) duplicates.push(ordinal);
    }
    return { gaps, duplicates, maxOrdinal };
  }

  async flatRecords(): Promise<FlatRecord[]> {
    const blocks = await this.directoryBlocks();
    return blocks.flatMap((block) => block.records);
  }

  history(): SyncScopeRuntime["history"] {
    return this.requirePrimary().runtime.history;
  }

  async beginImport(input?: { readonly owner?: string; readonly leaseTtlMs?: number }): Promise<{
    loadId: string;
    generation: string;
  }> {
    return await this.history().begin({
      scope: this.scope,
      acpSessionId: "acp-planes",
      owner: input?.owner ?? "planes-importer",
      leaseTtlMs: input?.leaseTtlMs ?? 120_000,
    });
  }

  async acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    return await this.history().accept(value, meta);
  }

  async acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord> {
    return await this.acceptHistory(text, {
      kind: "text_part",
      entryId: key.entryId,
      contentSlot: key.contentSlot ?? 0,
      partIndex: key.partIndex ?? 0,
    });
  }

  importStatus(): ImportStatus | null {
    return this.attached.length > 0 ? this.history().status() : null;
  }

  queueClientFrame(connection: PlaneConnection, frame: SyncFrame): void {
    connection.link.inbound.push(encodeSyncFrame(frame));
  }

  async finishImport(): Promise<{ outcome: string; generation: string; pointerRevision: number }> {
    const service = this.history();
    await service.receivingComplete();
    await service.buildAndCommit();
    return await service.finalize();
  }

  async disposeAll(): Promise<void> {
    for (const connection of [...this.attached]) {
      await connection.dispose();
    }
    this.attached.length = 0;
    if (this.ownedSpoolRoot) {
      await rm(this.spoolRoot, { recursive: true, force: true });
    }
  }
}

/**
 * 组装一个 scope 夹具：登记并提交一个代次与入口 Doc，让引导租约过期，再按需建立第一条连接。
 *
 * 装配顺序即真实顺序：没有已提交代次时握手与写入都会被拒。除假时钟、传输端口与（T08 显式注入的）
 * 故障 store 外，全部是真实实现。
 */
export async function createPlaneHarness(options: PlaneHarnessOptions = {}): Promise<PlaneHarness> {
  const scope = options.scope ?? { organizationId: "org-planes", rcsSessionId: "session-planes" };
  const key = scopeKey(scope);
  const seed = options.seed ?? "planes-acceptance";
  const time = options.clock ?? new PlaneClock();
  const spoolRoot = options.spoolRoot ?? (await mkdtemp(join(tmpdir(), "sync-planes-")));
  const capacity =
    options.capacity ??
    (options.windowBytes === undefined ? DEFAULT_SYNC_CAPACITY : tightenWindow(options.windowBytes));
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource(seed),
    lifecycle: PLANES_LIFECYCLE,
    capacity,
    merge: { maxBytes: options.merge?.maxBytes ?? 1, maxDelayMs: options.merge?.maxDelayMs ?? 30_000 },
    deadlines: { ackMs: options.ackMs ?? ACK_DEADLINE_MS },
    spoolRootDir: spoolRoot,
  });
  const store =
    options.store ??
    new MemoryProjectionStore({ clock: time, digest: sha256Digest, capacity, lifecycle: PLANES_LIFECYCLE });
  const admission = options.admission ?? new AdmissionController(capacity);
  const generation = options.generation ?? `gen-planes-${seed}`;
  const entryRefs = entryRefsFor(generation);
  const contentDocId = entryRefs.contentDocIds[0];
  const runtimeDocId = entryRefs.runtimeDocId;

  const lease = await store.acquireWriter(key, "planes-bootstrap", BOOTSTRAP_TTL_MS);
  const record: SyncGenerationRecord = {
    scopeKey: key,
    generation,
    acpSessionId: "acp-planes",
    loadId: "load-planes",
    state: "staging",
    importEndOrdinal: null,
    entryRefs,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: record });
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    expectedCurrent: null,
    newGeneration: record,
    retired: [],
    entryClosure: entryRefs,
    expectedPointerRevision: 0,
  });
  await store.createDoc({
    scopeKey: key,
    epoch: lease.epoch,
    doc: activeDocRecord({
      scopeKey: key,
      generation,
      docId: contentDocId,
      kind: "content",
      snapshot: emptyDocBytes(),
    }),
  });
  await store.createDoc({
    scopeKey: key,
    epoch: lease.epoch,
    doc: activeDocRecord({
      scopeKey: key,
      generation,
      docId: runtimeDocId,
      kind: "runtime",
      snapshot: emptyDocBytes(),
    }),
  });
  // 引导租约在返回前已过期：用例可据此验证「旧 epoch 的写入被 fencing 拒绝」。
  time.advance(BOOTSTRAP_TTL_MS + 1);

  const harness = new PlaneHarnessImpl(
    scope,
    key,
    store,
    admission,
    time,
    config,
    generation,
    contentDocId,
    runtimeDocId,
    entryRefs,
    lease,
    spoolRoot,
    // 谁创建临时目录谁负责清理：注入自定义 store 不改变暂存目录的归属（否则 T08 的每次注入都会漏一个临时目录）。
    options.spoolRoot === undefined,
  );
  if (options.connect !== false) {
    await harness.connect("primary", { seed: `${seed}-primary` });
  }
  return harness;
}
