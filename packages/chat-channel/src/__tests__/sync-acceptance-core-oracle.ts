// packages/chat-channel/src/__tests__/sync-acceptance-core-oracle.ts
// A 交付（设计 §15.2 场景矩阵 T01–T12）的**独立** oracle 与进程内端到端夹具。
//
// 「独立」在本文件是硬约束（设计 §15.1）：期望值一律由输入侧自行构造，绝不复用被测的分片 / 拼接 / 投影 /
// 合并实现。具体地：
//   - 历史的期望字节由本文件的 `oracleJsonBytes`（`JSON.stringify` + `TextEncoder`）给出，不调 `fidelitySerialize`；
//   - 历史的期望重组由本文件的 `joinPayloadText`（逐条解码 + 按 `partIndex` 拼接）给出，不调 `joinJsonParts`；
//   - 实时的期望文本由 `LiveIngressLog.textFor`（输入事件按接收顺序的原始 UTF-16 拼接）给出，不调 `merge-buffer`。
// 生产代码只出现在两处：被测对象本身（`createSyncScopeRuntime` / `createSyncClientTransport`）与身份/帧编解码
// （`buildDocId` / `encodeSyncFrame` / `decodeSyncFrame`）——它们是线契约，不是被验收的语义。
//
// 读取面（observation surface）与期望面严格分离：`readFlatRecords` 只做「Y.Doc → 扁平记录数组」的结构读取，
// 记录顺序即 Y.Array 顺序。客户端侧没有内容读出口（`DocHub` 只暴露 `loadedBytes` / `queueDepth`），
// 因此 `ClientMirror` 把**收到的数据帧字节**应用进测试自己的 Y.Doc——它观察的是「交付了什么字节」，
// 不参与期望构造；这一观察缺口在交付报告中如实列出。

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
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { type SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  CommitOutcome,
  GenerationEntryRefs,
  SyncDocRecord,
  SyncGenerationRecord,
  WriterLease,
} from "../sync/store/types";

// ---------------------------------------------------------------- 常量与时钟

/** 验收 scope：本文件所有用例共用同一形状，指纹只用于隔离不同夹具实例。 */
export const CORE_SCOPE: SyncScope = { organizationId: "org-acceptance", rcsSessionId: "session-acceptance" };
export const CORE_SCOPE_KEY = scopeKey(CORE_SCOPE);
/** 夹具自建代次（历史导入会把当前指针换成新代次，见 `CoreHarness.currentGeneration`）。 */
export const SEED_GENERATION = "gen-acceptance-seed";
/** 引导租约期限：夹具用完即推进时钟使之过期，把写权让给被测运行时或导入服务。 */
export const BOOTSTRAP_TTL_MS = 5_000;
/** 清理宽限期：与验收无关，取一个不会被推进到的值。 */
const LIFECYCLE = { sealGraceMs: 600_000, retireGraceMs: 600_000 } as const;
/** 默认 ACK 期限：用例只推进假时钟，不等真实墙钟。 */
export const DEFAULT_ACK_MS = 30_000;
/** 可推进的假时钟：租约、ACK 期限、轮换驻留窗口都只经它取时。 */
export class ManualClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): this {
    this.current += milliseconds;
    return this;
  }
}

// ---------------------------------------------------------------- 读取面（Y.Doc → 扁平记录）

/** 内容块与实时正文共用的记录形状（`doc.getMap("root").get("records")` 的元素）。 */
export interface FlatRecord {
  readonly recordId: string;
  readonly entryId: string;
  /** 历史块是数字槽位，实时记录是字符串槽位（"text" / "final"）。 */
  readonly contentSlot: string | number;
  readonly contentType: string | null;
  readonly partIndex: number;
  readonly kind: string;
  readonly payload: Uint8Array;
}

const UTF8 = new TextEncoder();
const UTF8_DECODE = new TextDecoder();

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`record field ${field} is not a string`);
  return value;
}

function asIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`record field ${field} is not a non-negative integer`);
  }
  return value;
}

function asSlot(value: unknown): string | number {
  if (typeof value === "string") return value;
  return asIndex(value, "contentSlot");
}

/** 一条记录的读取归一：只做类型收敛，不做任何业务解释或字段补全。 */
function readRecordValue(value: unknown): FlatRecord {
  if (typeof value !== "object" || value === null) throw new Error("record element is not an object");
  const view = new Map(Object.entries(value as Record<string, unknown>));
  const payload = view.get("payload");
  if (!(payload instanceof Uint8Array)) throw new Error("record payload is not a Uint8Array");
  const contentType = view.get("contentType");
  return {
    recordId: asString(view.get("recordId"), "recordId"),
    entryId: asString(view.get("entryId"), "entryId"),
    contentSlot: asSlot(view.get("contentSlot")),
    contentType: typeof contentType === "string" ? contentType : null,
    partIndex: asIndex(view.get("partIndex"), "partIndex"),
    kind: asString(view.get("kind"), "kind"),
    payload: new Uint8Array(payload),
  };
}

/** 读取一个已重建 Doc 的全部记录（顺序即 Y.Array 顺序 = 写入顺序）。 */
export function readFlatRecords(doc: Y.Doc): FlatRecord[] {
  const root = doc.getMap<unknown>("root");
  const records = root.get("records");
  if (!(records instanceof Y.Array)) return [];
  return records.toArray().map(readRecordValue);
}

/** 已重建 Doc 的根元数据（历史块有 ordinal 边界；实时块没有）。 */
export function readDocRootKeys(doc: Y.Doc): string[] {
  return [...doc.getMap<unknown>("root").keys()];
}

/** 运行态实体（`doc.getMap("runtime")` 的条目）；`finalDescriptor` 只报告是否存在，不解释其内容。 */
export interface RuntimeEntity {
  readonly entityId: string;
  readonly kind: string;
  readonly state: string;
  readonly toolCallId: string | null;
  readonly hasFinalDescriptor: boolean;
}

/**
 * 运行态实体表的根键：`live-writer.ts:67` 的 `RUNTIME_KIND = "runtime"` 经 `createRuntimeDoc` 直接作根键
 * （`runtime-doc.ts:250`）；实体类型（tool/permission/error/cancel）是表内条目的字段，不是根键。
 * 读取侧不 import 生产模块，只按 Y.Doc 结构读。
 */
const RUNTIME_ENTITY_TABLE = "runtime";

/** 读取运行态 Doc 的实体表；`finalDescriptor` 只报告存在性，不解释内容。 */
export function readRuntimeEntities(doc: Y.Doc): RuntimeEntity[] {
  const entities: RuntimeEntity[] = [];
  doc.getMap<unknown>(RUNTIME_ENTITY_TABLE).forEach((value, key) => {
    if (typeof value !== "object" || value === null) throw new Error("runtime entity is not an object");
    const view = new Map(Object.entries(value as Record<string, unknown>));
    entities.push({
      entityId: asString(view.get("entityId") ?? key, "entityId"),
      kind: asString(view.get("kind"), "kind"),
      state: asString(view.get("state"), "state"),
      toolCallId: typeof view.get("toolCallId") === "string" ? (view.get("toolCallId") as string) : null,
      hasFinalDescriptor: view.get("finalDescriptor") !== undefined,
    });
  });
  return entities.sort((left, right) => left.entityId.localeCompare(right.entityId));
}

/** 记录载荷的 UTF-8 文本（读取契约：载荷是保真 JSON 字节，解码本身不解释内容）。 */
export function decodePayload(payload: Uint8Array): string {
  return UTF8_DECODE.decode(payload);
}

/** 实时正文的期望重组：同 entry/slot 的 `text` 记录按 `partIndex` 拼接后解码。 */
export function liveText(records: readonly FlatRecord[], entryId: string, contentSlot: string): string {
  return records
    .filter((record) => record.entryId === entryId && record.contentSlot === contentSlot && record.kind === "text")
    .sort((left, right) => left.partIndex - right.partIndex)
    .map((record) => decodePayload(record.payload))
    .join("");
}

/**
 * 历史文本的期望重组：每条记录是一个独立保真 JSON 值（长文本的物理片段），
 * 因此重组 = 逐条 `JSON.parse` 后按 `partIndex` 拼接——与 `joinJsonParts` 的字节级重组不是同一条路径，
 * 这里显式选择前者，因为 `accept(value)` 每次接收的都是完整 JS 值而非原始字节。
 */
export function joinPayloadText(records: readonly FlatRecord[], entryId: string, contentSlot: string | number): string {
  return records
    .filter((record) => record.entryId === entryId && record.contentSlot === contentSlot)
    .sort((left, right) => left.partIndex - right.partIndex)
    .map((record) => {
      const parsed: unknown = JSON.parse(decodePayload(record.payload));
      if (typeof parsed !== "string") throw new Error("expected a JSON string payload for a text fragment");
      return parsed;
    })
    .join("");
}

// ---------------------------------------------------------------- 期望构造（输入侧）

/** 历史对象的独立期望字节：直接 `JSON.stringify`，不经被测保真序列化器。 */
export function oracleJsonBytes(value: unknown): Uint8Array {
  return UTF8.encode(JSON.stringify(value));
}

/** 逐字节比对，失败时给出首个差异位置（避免整段字节 dump）。 */
export function byteDifference(actual: Uint8Array, expected: Uint8Array): string | null {
  if (actual.byteLength !== expected.byteLength) {
    return `length ${actual.byteLength} !== expected ${expected.byteLength}`;
  }
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      return `byte ${index}: ${String(actual[index])} !== ${String(expected[index])}`;
    }
  }
  return null;
}

/** 实时输入事件记录器：期望值就是「我发出去的东西按接收顺序拼接」。 */
export class LiveIngressLog {
  private readonly events: SyncIngressEvent[] = [];

  push(event: SyncIngressEvent): void {
    this.events.push(event);
  }

  get all(): readonly SyncIngressEvent[] {
    return this.events;
  }

  /** oracle：同一 entry/slot 的 `delta` 按接收顺序原样拼接，不做替换、不补字符、不去重。 */
  textFor(entryId: string, contentSlot: string): string {
    let text = "";
    for (const event of this.events) {
      if (event.kind === "text-delta" && event.entryId === entryId && event.contentSlot === contentSlot) {
        text += event.delta ?? "";
      }
    }
    return text;
  }

  /** 收到过 `text-delta` 的 entry/slot 组合（判定「哪些 key 必须有记录」）。 */
  textKeys(): { entryId: string; contentSlot: string }[] {
    const keys: { entryId: string; contentSlot: string }[] = [];
    for (const event of this.events) {
      if (event.kind !== "text-delta") continue;
      if (!keys.some((key) => key.entryId === event.entryId && key.contentSlot === event.contentSlot)) {
        keys.push({ entryId: event.entryId, contentSlot: event.contentSlot });
      }
    }
    return keys;
  }

  /** 语义事件的期望终态：toolCallId 集合与 final 集合（按接收顺序）。 */
  semanticPayloads(): Record<string, unknown>[] {
    const payloads: Record<string, unknown>[] = [];
    for (const event of this.events) {
      if (event.kind === "semantic" && event.semantic !== undefined) payloads.push(event.semantic.payload);
    }
    return payloads;
  }
}

// ---------------------------------------------------------------- 进程内连接

/** 记录型传输端口：服务端出站 → `toServerClient` 队列；`send` 可被置为饱和以模拟慢端。 */
export class CoreLink implements SyncFrameTransport {
  /** 服务端待投递给客户端的字节（由 pump 取走）。 */
  readonly pendingToClient: Uint8Array[] = [];
  /** 客户端待投递给服务端的字节（由 pump 取走）。 */
  readonly pendingToServer: Uint8Array[] = [];
  readonly closeReasons: string[] = [];
  /** socket 待发送字节真值：用例抬高它即可让网关的 socket 门禁拒发帧。 */
  buffered = 0;
  /** `send` 的返回值：false 模拟传输层饱和（帧被搁置，不排队、不重试同一帧）。 */
  acceptOutbound = true;
  /** 客户端出站方向是否饱和（false 时客户端控制帧进入本端 pending 缓冲）。 */
  acceptInbound = true;
  /** 丢帧注入：返回 true 表示该帧被丢弃（模拟网络丢失 / ACK 丢失）。 */
  dropServerFrame: ((frame: SyncFrame) => boolean) | null = null;
  dropClientFrame: ((frame: SyncFrame) => boolean) | null = null;
  /** 重复投递注入：返回 true 时同一帧被投递两次（模拟重复帧）。 */
  duplicateClientFrame: ((frame: SyncFrame) => boolean) | null = null;
  private clientSaturated = false;

  send(bytes: Uint8Array): boolean {
    if (!this.acceptOutbound) return false;
    this.pendingToClient.push(bytes);
    return true;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  close(reason: string): void {
    this.closeReasons.push(reason);
  }

  /** 客户端出站：饱和时返回 false，由客户端传输层自行缓冲（与真实 WS 同语义）。 */
  sendFromClient(bytes: Uint8Array): boolean {
    if (this.clientSaturated) return false;
    this.pendingToServer.push(bytes);
    return true;
  }

  setClientSaturated(saturated: boolean): void {
    this.clientSaturated = saturated;
  }
}

/** 客户端交付镜像：把收到的数据帧载荷应用进测试自己的 Y.Doc（读取面，见文件头）。 */
export class ClientMirror {
  private readonly docs = new Map<string, Y.Doc>();

  applyFrame(frame: DocBaseFrame | DocUpdateFrame, payload: Uint8Array): void {
    const doc = this.docs.get(frame.docId) ?? new Y.Doc();
    Y.applyUpdate(doc, payload);
    this.docs.set(frame.docId, doc);
  }

  has(docId: string): boolean {
    return this.docs.has(docId);
  }

  readRecords(docId: string): FlatRecord[] {
    const doc = this.docs.get(docId);
    return doc === undefined ? [] : readFlatRecords(doc);
  }

  /** 镜像 Doc 的 canonical 字节；未收到该 Doc 的任何数据帧时返回 null（区分「空」与「没收到」）。 */
  canonicalBytes(docId: string): Uint8Array | null {
    const doc = this.docs.get(docId);
    return doc === undefined ? null : Y.encodeStateAsUpdate(doc);
  }

  docIds(): string[] {
    return [...this.docs.keys()];
  }
}

/** 服务端发出的每一帧（解码成功才记录）；`bytes` 保留原始字节以便逐字节比对。 */
export interface RecordedFrame {
  readonly direction: "server-to-client" | "client-to-server";
  readonly frame: SyncFrame;
  readonly bytes: Uint8Array;
}

export interface FatalRecord {
  readonly code: string;
  readonly detail: string | undefined;
}

// ---------------------------------------------------------------- 夹具

export interface CoreHarnessOptions {
  /** 收紧连接窗口与 socket 水位（两者同值，档案校验要求）。 */
  readonly windowBytes?: number;
  readonly ackMs?: number;
  /** 合并阈值：默认 `maxBytes: 1`，使每条 `acceptIngress` 都立刻落库（不依赖 33ms 真实定时器）。 */
  readonly merge?: { readonly maxBytes?: number; readonly maxDelayMs?: number };
  /** 运行态轮换阈值：`maxResidentMs` 取小时级可让轮换只在显式推进时钟后发生。 */
  readonly rotation?: { readonly maxResidentMs?: number; readonly maxTransactions?: number };
  readonly admission?: AdmissionController;
  /** 内容块基线文本：非空时夹具的内容块自带内容（用于「封口后 canonical 不变」类断言）。 */
  readonly seedText?: string;
  /** 代次标识：默认 `SEED_GENERATION`。 */
  readonly generation?: string;
  /** 随机源种子：两条连接（多客户端用例）必须用不同种子，否则写者标识会撞车。 */
  readonly seed?: string;
  /**
   * 复用另一夹具的 store / 额度账目 / 代次：用于「第二条连接」「重连后重发」「第二个写者」这类场景。
   * 复用方不再登记代次（登记是幂等边界，重复登记会与既有行冲突），只新起一个运行时与一条连接。
   */
  readonly reuse?: CoreHarness;
}

/** 一个内容块的读取视图（历史块有 ordinal 边界，实时块为 null）。 */
export interface BlockView {
  readonly docId: string;
  readonly ordinalStart: number | null;
  readonly ordinalEnd: number | null;
  readonly records: FlatRecord[];
}

/** 已提交状态里一行的只读投影：只搬运事实，不解释语义。 */
export interface DocRowView {
  readonly docId: string;
  readonly kind: DocKind;
  readonly state: string;
  readonly blockIndex: number | null;
  readonly ordinalStart: number | null;
  readonly ordinalEnd: number | null;
  readonly finalSeq: number | null;
  readonly hash: string;
}

export interface CoreHarness {
  readonly scope: SyncScope;
  readonly scopeKey: string;
  readonly seedGeneration: string;
  readonly seedContentDocId: string;
  readonly seedRuntimeDocId: string;
  /** 夹具自建代次的入口闭包；复用夹具下与来源夹具相同（同一代次）。 */
  readonly seedEntryRefs: GenerationEntryRefs;
  readonly time: ManualClock;
  readonly store: MemoryProjectionStore;
  readonly admission: AdmissionController;
  /** 夹具自建代次时签发的引导租约（构造时已过期）；复用夹具下为 `null`。 */
  readonly bootstrapLease: WriterLease | null;
  readonly config: SyncRuntimeConfig;
  readonly runtime: SyncScopeRuntime;
  readonly gateway: ReturnType<SyncScopeRuntime["attachTransport"]>;
  readonly link: CoreLink;
  readonly client: SyncClientTransport;
  readonly hub: DocHub;
  readonly mirror: ClientMirror;
  readonly log: LiveIngressLog;
  readonly frames: RecordedFrame[];
  readonly controlFrames: SyncFrame[];
  readonly fatal: FatalRecord[];
  /** pump 每一轮推过的帧数（判定「静止」与「有界循环」）。 */
  readonly pumpRounds: number[];
  readonly spoolRoot: string;
  /** 当前已提交代次（历史导入会把指针换成新代次）。 */
  currentGeneration(): Promise<string>;
  /** 当前代次的入口闭包；换代后即为新代次的入口。 */
  currentEntryRefs(): Promise<GenerationEntryRefs>;
  /** 当前代次的已封口内容块 docId（无则空数组）。 */
  contentDocIds(): Promise<string[]>;
  /** 内容块视图：历史块按 `ordinalStart` 升序（跨块顺序的唯一依据）。 */
  blocks(docIds?: readonly string[]): Promise<BlockView[]>;
  /** 全部记录（按块顺序展开）；历史导入的顺序断言以它为准。 */
  flatRecords(docIds?: readonly string[]): Promise<FlatRecord[]>;
  /** store canonical 字节（base 快照 + 顺序增量）。 */
  canonicalBytes(docId: string): Promise<Uint8Array>;
  /** store canonical 记录。 */
  canonicalRecords(docId: string): Promise<FlatRecord[]>;
  /** 运行态实体（缺省读夹具的运行态 Doc）。 */
  canonicalEntities(docId?: string): Promise<RuntimeEntity[]>;
  /** 已提交状态里某一类 Doc 的行（封口状态、块序号、ordinal 范围、canonical 摘要）。 */
  docsOfKind(kind: DocKind): DocRowView[];
  /** 已提交状态的全量 Doc 行（用于「没有多余 Doc 被创建」类断言）。 */
  allDocs(): DocRowView[];
  /** 客户端镜像的运行态实体。 */
  mirrorEntities(docId?: string): RuntimeEntity[];
  /** 已提交文档行的 canonical 摘要（sealed 后即封口摘要）。 */
  canonicalDigest(docId: string): Promise<string>;
  /** 只读的已提交状态导出（用于断言「指针未动」「没有部分提交」）。 */
  committedSnapshot(): ReturnType<MemoryProjectionStore["exportCommittedState"]>;
  handshake(input?: { readonly generation?: string; readonly loadedDocs?: readonly string[] }): Promise<void>;
  subscribe(docIds?: readonly string[], priority?: SubscribeFrame["priority"]): Promise<void>;
  /** 写入一条实时事件 + 驱动到静止。 */
  write(event: SyncIngressEvent): Promise<void>;
  /** 便捷写入：文本增量。 */
  writeText(
    delta: string,
    key?: { readonly turnId?: string; readonly entryId?: string; readonly contentSlot?: string },
  ): Promise<void>;
  /** 便捷写入：语义事件（tool / permission / error / cancel / final）。 */
  writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void>;
  /** 开始一次历史导入：取写权、新建代次与 loadId（写权被占时以 `SCOPE_BUSY` 明确失败）。 */
  beginImport(owner?: string): Promise<{ loadId: string; generation: string }>;
  /** 接收一个历史对象（编号由入口签发）。 */
  acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord>;
  /** 便捷接收：一条完整文本（`text_part`，partIndex 由调用方给出，默认 0）。 */
  acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord>;
  /** 本次夹具是否开过导入；未开过时返回 `null`（`HistoryImportService.status()` 需要一次已开始的尝试）。 */
  importStatus(): ImportStatus | null;
  /**
   * 直接注入一条客户端帧字节（不经客户端传输层）：用于「旧 epoch 的 ACK」「畸形帧」这类
   * 客户端实现不会自发产生的入站输入；走 `link.pendingToServer`，因此丢帧/重复注入钩子同样生效。
   */
  queueClientFrame(frame: SyncFrame): void;
  /** 冻结接收边界 → 分块构建提交 → 原子换代。 */
  finishImport(): Promise<{ outcome: CommitOutcome; generation: string; pointerRevision: number }>;
  pump(): Promise<void>;
  /** 驱动到静止并返回本次推进的轮数。 */
  settle(): Promise<number>;
  dispose(): Promise<void>;
  /** 释放夹具（含临时目录清理）。 */
  destroy(): Promise<void>;
}

/** 单个记录的登记形状（配合注入的自建文档）。 */
export function docRecordFor(input: {
  scopeKey: string;
  generation: string;
  docId: string;
  kind: DocKind;
  snapshot: Uint8Array;
  blockIndex?: number;
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
    blockIndex: input.blockIndex ?? 0,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 空 Y.Doc 的 canonical 字节。 */
export function emptyDocState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** 带文本的 Y.Doc 基线：放在内容块 `root.records` 之外的自定义键上，只用来把基线撑出真实字节。 */
export function textState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("seed").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** 收紧连接窗口（窗口与 socket 水位必须同值，见 `validateSyncRuntimeConfig`）。 */
export function tightenWindow(windowBytes: number): SyncCapacityProfile {
  const concurrency = { ...DEFAULT_SYNC_CAPACITY.concurrency };
  concurrency.connectionBodyWindowBytes = windowBytes;
  concurrency.socketHighWatermarkBytes = windowBytes;
  return { ...DEFAULT_SYNC_CAPACITY, concurrency };
}

/** 每轮的 pump 上限：静止判定靠「本轮没有帧流动」，这个数字只是防止实现缺陷造成死循环。 */
const MAX_PUMP_ROUNDS = 24;
/** 单 Doc 增量读取上限：验收数据集远小于它，取大值以避免把「截断」误判成「内容缺失」。 */
const UPDATE_READ_LIMIT = 200_000;

/**
 * 登记并提交一个代次，再登记内容块与运行态 Doc，最后让引导租约过期。
 *
 * 代次必须经 `commitGeneration` 成为当前代次：`session.handshake` 校验「指针代次 == 声明代次且该代已提交」，
 * 未提交的代次只能被拒绝——这正是 T08「不得切到不完整 generation」的被观察事实。
 */
async function seedScope(
  store: MemoryProjectionStore,
  time: ManualClock,
  input: {
    generation: string;
    entryRefs: GenerationEntryRefs;
    contentDocId: string;
    runtimeDocId: string;
    seedText?: string;
  },
): Promise<WriterLease> {
  const lease = await store.acquireWriter(CORE_SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: CORE_SCOPE_KEY,
    generation: input.generation,
    acpSessionId: "acp-acceptance",
    loadId: "load-acceptance",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: input.entryRefs,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: CORE_SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: CORE_SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: input.entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: CORE_SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecordFor({
      scopeKey: CORE_SCOPE_KEY,
      generation: input.generation,
      docId: input.contentDocId,
      kind: "content",
      snapshot: input.seedText === undefined ? emptyDocState() : textState(input.seedText),
    }),
  });
  await store.createDoc({
    scopeKey: CORE_SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecordFor({
      scopeKey: CORE_SCOPE_KEY,
      generation: input.generation,
      docId: input.runtimeDocId,
      kind: "runtime",
      snapshot: emptyDocState(),
    }),
  });
  time.advance(BOOTSTRAP_TTL_MS + 1);
  // 引导租约在返回时已过期：用例可据此验证「旧 epoch 的写入被 fencing 拒绝」。
  return lease;
}

class CoreHarnessImpl implements CoreHarness {
  readonly scope: SyncScope = CORE_SCOPE;
  readonly scopeKey: string = CORE_SCOPE_KEY;
  readonly seedGeneration: string;
  readonly seedContentDocId: string;
  readonly seedRuntimeDocId: string;
  readonly seedEntryRefs: GenerationEntryRefs;
  readonly time: ManualClock;
  readonly store: MemoryProjectionStore;
  readonly admission: AdmissionController;
  readonly bootstrapLease: WriterLease | null;
  readonly config: SyncRuntimeConfig;
  readonly runtime: SyncScopeRuntime;
  readonly gateway: ReturnType<SyncScopeRuntime["attachTransport"]>;
  readonly link: CoreLink;
  readonly client: SyncClientTransport;
  readonly hub: DocHub;
  readonly mirror = new ClientMirror();
  readonly log = new LiveIngressLog();
  readonly frames: RecordedFrame[] = [];
  readonly controlFrames: SyncFrame[] = [];
  readonly fatal: FatalRecord[] = [];
  readonly pumpRounds: number[] = [];
  readonly spoolRoot: string;
  private readonly ownedSpoolRoot: boolean;
  private handleDisposed = false;
  private importAttempted = false;

  constructor(input: {
    config: SyncRuntimeConfig;
    store: MemoryProjectionStore;
    runtime: SyncScopeRuntime;
    admission: AdmissionController;
    time: ManualClock;
    gateway: ReturnType<SyncScopeRuntime["attachTransport"]>;
    link: CoreLink;
    spoolRoot: string;
    ownedSpoolRoot: boolean;
    generation: string;
    contentDocId: string;
    runtimeDocId: string;
    entryRefs: GenerationEntryRefs;
    bootstrapLease: WriterLease | null;
  }) {
    this.config = input.config;
    this.store = input.store;
    this.runtime = input.runtime;
    this.admission = input.admission;
    this.time = input.time;
    this.bootstrapLease = input.bootstrapLease;
    this.gateway = input.gateway;
    this.link = input.link;
    this.spoolRoot = input.spoolRoot;
    this.ownedSpoolRoot = input.ownedSpoolRoot;
    this.seedGeneration = input.generation;
    this.seedContentDocId = input.contentDocId;
    this.seedRuntimeDocId = input.runtimeDocId;
    this.seedEntryRefs = input.entryRefs;
    // 客户端传输：出站经 `link.sendFromClient`（可置饱和），时间取假时钟，`yieldToHost` 为立即兑现的微任务
    // ——验收不等待墙钟，但保留「分片之间让出执行权」的调用点。
    this.client = createSyncClientTransport({
      send: (bytes) => this.link.sendFromClient(bytes),
      now: () => this.time.now(),
      yieldToHost: () => Promise.resolve(),
      onControl: (frame) => this.controlFrames.push(frame),
      onFatal: (code, detail) => this.fatal.push({ code, detail }),
    });
    // 客户端只暴露这一个调度入口：apply 结果（processed / rejected）与补齐申请都从它出来。
    this.hub = this.client.hub;
  }

  // ------------------------------------------------------------ 读取面

  async currentGeneration(): Promise<string> {
    const pointer = await this.store.readScopePointer(this.scopeKey);
    return pointer?.currentGeneration ?? this.seedGeneration;
  }

  async currentEntryRefs(): Promise<GenerationEntryRefs> {
    const record = await this.store.readGeneration(this.scopeKey, await this.currentGeneration());
    if (record === null) throw new Error("current generation record is missing from the store");
    return record.entryRefs;
  }

  async contentDocIds(): Promise<string[]> {
    const generation = await this.currentGeneration();
    const record = await this.store.readGeneration(this.scopeKey, generation);
    if (record === null) return [];
    return [...record.entryRefs.contentDocIds];
  }

  async canonicalBytes(docId: string): Promise<Uint8Array> {
    const base = await this.store.readDocStateAt(docId, 0);
    if (base === null) throw new Error(`doc ${docId} has no committed baseline at seq 0`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base.snapshot);
    const updates = await this.store.readUpdatesAfter(docId, 0, UPDATE_READ_LIMIT);
    for (const update of updates) Y.applyUpdate(doc, update.bytes);
    return Y.encodeStateAsUpdate(doc);
  }

  async canonicalRecords(docId: string): Promise<FlatRecord[]> {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(docId));
    return readFlatRecords(doc);
  }

  async canonicalEntities(docId?: string): Promise<RuntimeEntity[]> {
    const target = docId ?? this.seedRuntimeDocId;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(target));
    return readRuntimeEntities(doc);
  }

  allDocs(): DocRowView[] {
    return this.committedSnapshot().docs.map((row) => ({
      docId: row.docId,
      kind: row.kind,
      state: row.state,
      blockIndex: row.blockIndex,
      ordinalStart: row.ordinalStart,
      ordinalEnd: row.ordinalEnd,
      finalSeq: row.finalSeq,
      hash: row.hash,
    }));
  }

  docsOfKind(kind: DocKind): DocRowView[] {
    return this.allDocs()
      .filter((row) => row.kind === kind)
      .sort((left, right) => (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
  }

  async blocks(docIds?: readonly string[]): Promise<BlockView[]> {
    // 跨块顺序的唯一依据是目录的 ordinal 范围（设计 §4.2）：不可读的块不参与排序，避免用 docId 猜顺序。
    const targets = docIds ?? (await this.contentDocIds());
    const rows = new Map(this.allDocs().map((row) => [row.docId, row]));
    const views: BlockView[] = [];
    for (const docId of targets) {
      const row = rows.get(docId);
      views.push({
        docId,
        ordinalStart: row?.ordinalStart ?? null,
        ordinalEnd: row?.ordinalEnd ?? null,
        records: await this.canonicalRecords(docId),
      });
    }
    return views.sort((left, right) => (left.ordinalStart ?? 0) - (right.ordinalStart ?? 0));
  }

  async flatRecords(docIds?: readonly string[]): Promise<FlatRecord[]> {
    const views = await this.blocks(docIds);
    return views.flatMap((view) => view.records);
  }

  mirrorEntities(docId?: string): RuntimeEntity[] {
    const target = docId ?? this.seedRuntimeDocId;
    const bytes = this.mirror.canonicalBytes(target);
    if (bytes === null) return [];
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    return readRuntimeEntities(doc);
  }

  async canonicalDigest(docId: string): Promise<string> {
    const snapshot = this.committedSnapshot();
    const row = snapshot.docs.find((doc) => doc.docId === docId);
    if (row === undefined) throw new Error(`doc ${docId} is not registered`);
    return row.hash;
  }

  committedSnapshot(): ReturnType<MemoryProjectionStore["exportCommittedState"]> {
    return this.store.exportCommittedState();
  }

  // ------------------------------------------------------------ 驱动

  /** 单轮：服务端出站 → 客户端入站 → 客户端 drain（回执）→ 服务端入站 → 服务端 tick。 */
  private async round(): Promise<number> {
    let moved = 0;
    while (this.link.pendingToClient.length > 0) {
      const bytes = this.link.pendingToClient.shift();
      if (bytes === undefined) break;
      moved += 1;
      const frame = decodeSyncFrame(bytes);
      this.frames.push({ direction: "server-to-client", frame, bytes });
      if (this.link.dropServerFrame?.(frame) === true) continue;
      if (frame.type === "DOC_BASE") {
        this.mirror.applyFrame(frame, Buffer.from(frame.payload, "base64"));
      } else if (frame.type === "DOC_UPDATE") {
        this.mirror.applyFrame(frame, Buffer.from(frame.payload, "base64"));
      }
      this.client.onFrame(bytes);
    }
    await this.client.drain();
    while (this.link.pendingToServer.length > 0) {
      const bytes = this.link.pendingToServer.shift();
      if (bytes === undefined) break;
      moved += 1;
      const frame = decodeSyncFrame(bytes);
      this.frames.push({ direction: "client-to-server", frame, bytes });
      const duplicate = this.link.duplicateClientFrame?.(frame) === true;
      if (this.link.dropClientFrame?.(frame) === true) continue;
      await this.runtime.onInboundBytes(bytes);
      if (duplicate) await this.runtime.onInboundBytes(bytes);
    }
    await this.runtime.tick();
    return moved;
  }

  async pump(): Promise<void> {
    for (let index = 0; index < MAX_PUMP_ROUNDS; index += 1) {
      const moved = await this.round();
      this.pumpRounds.push(moved);
      if (moved === 0 && this.link.pendingToClient.length === 0 && this.link.pendingToServer.length === 0) {
        return;
      }
    }
    throw new Error(`sync acceptance pump did not settle within ${MAX_PUMP_ROUNDS} rounds`);
  }

  async settle(): Promise<number> {
    const before = this.frames.length;
    await this.pump();
    return this.frames.length - before;
  }

  async handshake(input?: { readonly generation?: string; readonly loadedDocs?: readonly string[] }): Promise<void> {
    const generation = input?.generation ?? (await this.currentGeneration());
    const frame: HelloFrame = {
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: this.scope,
      generation,
      loadedDocs: (input?.loadedDocs ?? []).map((docId) => ({ docId })),
      stateful: false,
    };
    await this.runtime.onInboundBytes(encodeSyncFrame(frame));
    await this.pump();
  }

  async subscribe(docIds?: readonly string[], priority: SubscribeFrame["priority"] = "live"): Promise<void> {
    const target = docIds ?? (await this.contentDocIds());
    for (const docId of target) this.hub.retain(docId);
    const frame: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [...target],
      priority,
    };
    await this.runtime.onInboundBytes(encodeSyncFrame(frame));
    await this.pump();
  }

  async write(event: SyncIngressEvent): Promise<void> {
    this.log.push(event);
    await this.runtime.acceptIngress(event);
    await this.pump();
  }

  async writeText(
    delta: string,
    key?: { readonly turnId?: string; readonly entryId?: string; readonly contentSlot?: string },
  ): Promise<void> {
    const turnId = key?.turnId ?? "turn-1";
    await this.write({
      kind: "text-delta",
      turnId,
      entryId: key?.entryId ?? `${turnId}:assistant`,
      contentSlot: key?.contentSlot ?? "text",
      contentType: "text/plain",
      delta,
    });
  }

  async writeSemantic(kind: string, payload: Record<string, unknown>, turnId = "turn-1"): Promise<void> {
    await this.write({
      kind: "semantic",
      turnId,
      entryId: `${turnId}:assistant`,
      contentSlot: "text",
      contentType: "text/plain",
      semantic: { kind: kind as "tool", payload },
    });
  }

  async beginImport(owner = "acceptance-importer"): Promise<{ loadId: string; generation: string }> {
    const started = await this.runtime.history.begin({
      scope: this.scope,
      acpSessionId: "acp-acceptance",
      owner,
      leaseTtlMs: 120_000,
    });
    this.importAttempted = true;
    return started;
  }

  async acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    return await this.runtime.history.accept(value, meta);
  }

  async acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord> {
    return await this.runtime.history.accept(text, {
      kind: "text_part",
      entryId: key.entryId,
      contentSlot: key.contentSlot ?? 0,
      partIndex: key.partIndex ?? 0,
    });
  }

  importStatus(): ImportStatus | null {
    return this.importAttempted ? this.runtime.history.status() : null;
  }

  queueClientFrame(frame: SyncFrame): void {
    // 直接入服务端入站队列（不经客户端传输层）：用于构造客户端实现不会自发产生的入站输入。
    this.link.pendingToServer.push(encodeSyncFrame(frame));
  }

  async finishImport(): Promise<{ outcome: CommitOutcome; generation: string; pointerRevision: number }> {
    await this.runtime.history.receivingComplete();
    await this.runtime.history.buildAndCommit();
    return await this.runtime.history.finalize();
  }

  // ------------------------------------------------------------ 生命周期

  async dispose(): Promise<void> {
    if (this.handleDisposed) return;
    this.handleDisposed = true;
    this.client.dispose();
    await this.runtime.dispose();
  }

  async destroy(): Promise<void> {
    await this.dispose();
    if (this.ownedSpoolRoot) {
      await rm(this.spoolRoot, { recursive: true, force: true });
    }
  }
}

/**
 * 组装一个 scope 运行时 + 一条进程内客户端连接。
 *
 * 装配顺序即真实顺序：先登记并提交一个代次与入口 Doc（否则握手与写入都会被拒），再让引导租约过期，
 * 最后把运行时的传输端口接到进程内队列上。除假时钟与传输端口外全部是真实实现。
 *
 * `options.reuse` 复用另一个夹具的 store / 额度账目 / 假时钟 / 代次（不再登记）：用于「第二条连接」、
 * 「换代后的新连接」、「第二个写者」这类场景——存储层是同一份事实，故时钟也必须同一份，
 * 否则租约与 ACK 期限会在两条连接上按不同时间推进。
 */
export async function createCoreHarness(options: CoreHarnessOptions = {}): Promise<CoreHarnessImpl> {
  const source = options.reuse;
  const seed = options.seed ?? "acceptance-core";
  const generation = options.generation ?? source?.seedGeneration ?? SEED_GENERATION;
  const time = source?.time ?? new ManualClock();
  const spoolRoot = source?.spoolRoot ?? (await mkdtemp(join(tmpdir(), "sync-acceptance-core-")));
  const capacity =
    source?.config.capacity ??
    (options.windowBytes === undefined ? DEFAULT_SYNC_CAPACITY : tightenWindow(options.windowBytes));
  const config =
    source?.config ??
    resolveSyncRuntimeConfig({
      clock: time,
      random: deterministicRandomSource(seed),
      lifecycle: LIFECYCLE,
      capacity,
      merge: { maxBytes: options.merge?.maxBytes ?? 1, maxDelayMs: options.merge?.maxDelayMs ?? 30_000 },
      deadlines: { ackMs: options.ackMs ?? DEFAULT_ACK_MS },
      rotation: options.rotation,
      spoolRootDir: spoolRoot,
    });
  const store =
    source?.store ??
    new MemoryProjectionStore({
      clock: time,
      digest: sha256Digest,
      capacity,
      lifecycle: LIFECYCLE,
    });
  const admission = options.admission ?? source?.admission ?? new AdmissionController(capacity);
  const contentDocId =
    source?.seedContentDocId ?? buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "content0" });
  const runtimeDocId =
    source?.seedRuntimeDocId ?? buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: "runtime0" });
  const entryRefs: GenerationEntryRefs = source?.seedEntryRefs ?? {
    controlDocId: buildDocId({ kind: "control", generation, blockIndex: 0, nonce: "control0" }),
    directoryDocId: buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: "directory0" }),
    runtimeDocId,
    contentDocIds: [contentDocId],
  };
  const bootstrapLease =
    source === undefined
      ? await seedScope(store, time, {
          generation,
          entryRefs,
          contentDocId,
          runtimeDocId,
          seedText: options.seedText,
        })
      : null;
  const runtime = await createSyncScopeRuntime({
    scope: CORE_SCOPE,
    config,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource(`${seed}-runtime`),
    store,
    admission,
  });
  // 端口在同一份队列上双向接线：服务端出站 → 客户端 `onFrame`，客户端出站 → `onInboundBytes`（见 `round`）。
  const link = new CoreLink();
  const gateway = runtime.attachTransport(link);
  const harness = new CoreHarnessImpl({
    config,
    store,
    runtime,
    admission,
    time,
    bootstrapLease,
    gateway,
    link,
    spoolRoot,
    ownedSpoolRoot: source === undefined,
    generation,
    contentDocId,
    runtimeDocId,
    entryRefs,
  });
  return harness;
}
