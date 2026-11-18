// T08–T12 验收的独立读取与线上审计口径；不依赖其他验收 oracle。
import * as Y from "yjs";
import type { DocBaseFrame, DocUpdateFrame, SyncFrame } from "../sync/protocol/frames";
import { decodeSyncFrame } from "../sync/protocol/frames";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import type { SyncIngressEvent } from "../sync/runtime/ingress";

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
  /** 只从输入事件记录期望文本，避免把生产投影结果当作期望。 */
  push(event: SyncIngressEvent): void {
    if (event.kind !== "text-delta" || event.delta === undefined) return;
    const key = `${event.entryId}\u0000${event.contentSlot}`;
    const bucket = this.parts.get(key) ?? [];
    bucket.push(event.delta);
    this.parts.set(key, bucket);
  }
  /** 读取指定 entry 与槽位在输入侧累计的原文。 */
  textOf(entryId: string, contentSlot: string): string {
    return (this.parts.get(`${entryId}\u0000${contentSlot}`) ?? []).join("");
  }
  /** 按首次出现顺序列出已接收的 entry 与槽位。 */
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
  /** 记录真实接受的线上字节，拒绝发送时不计入交付。 */
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
  /** 记录首次关闭理由，后续发送保持拒绝。 */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReasons.push(reason);
  }
  /** 读取传输关闭状态以判断连接是否仍可推进。 */
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
  /** 从已交付与已回执事实计算尚未结清的线上字节。 */
  outstandingBytes(): number {
    let total = 0;
    for (const [deliveryId, bytes] of this.delivered) {
      if (!this.acked.has(deliveryId)) total += bytes;
    }
    return total;
  }
  /** 统计尚未结清的真实交付，不读取生产额度控制器。 */
  outstandingCount(): number {
    let count = 0;
    for (const deliveryId of this.delivered.keys()) {
      if (!this.acked.has(deliveryId)) count += 1;
    }
    return count;
  }
  /** 累计线上实际接受的数据帧字节。 */
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
  /** 记录真实基线覆盖的已应用序号范围。 */
  noteBase(docId: string, deliveryId: string, baseSeq: number): void {
    this.applied.push({ kind: "base", docId, deliveryId, fromSeq: 0, toSeq: baseSeq });
  }
  /** 记录真实增量覆盖的已应用序号范围。 */
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
  /** 列出实际应用过的增量区间，供重复与缺口断言使用。 */
  updateRanges(docId: string): string[] {
    return this.applied
      .filter((delivery) => delivery.docId === docId && delivery.kind === "update")
      .map((delivery) => `${delivery.fromSeq}-${delivery.toSeq}`);
  }
}

/** 客户端内容镜像：只应用**收到的数据帧字节**，不参与期望构造（观察「交付了什么字节」）。 */
export class PlaneMirror {
  private readonly docs = new Map<string, Y.Doc>();
  /** 仅把收到的数据帧应用到独立 Yjs 镜像。 */
  applyFrame(frame: DocBaseFrame | DocUpdateFrame): void {
    const doc = this.docOf(frame.docId);
    Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
  }
  /** 判断客户端是否实际见过目标文档。 */
  has(docId: string): boolean {
    return this.docs.has(docId);
  }
  /** 从独立镜像读取已交付的正文记录。 */
  records(docId: string): FlatRecord[] {
    const doc = this.docs.get(docId);
    return doc === undefined ? [] : readRecords(doc);
  }
  /** 从独立镜像读取已交付的运行态实体。 */
  entities(docId: string): RuntimeEntityView[] {
    const doc = this.docs.get(docId);
    return doc === undefined ? [] : readRuntimeEntities(doc);
  }

  /** 镜像的 canonical 字节；从未见过该 Doc 时返回 null（不伪造空 Doc）。 */
  canonicalBytes(docId: string): Uint8Array | null {
    const doc = this.docs.get(docId);
    return doc === undefined ? null : Y.encodeStateAsUpdate(doc);
  }
  /** 列出已由线上帧建立的文档镜像。 */
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
