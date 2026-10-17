// packages/chat-channel/src/__tests__/sync-acceptance-recovery-oracle.ts
// B 交付（T13–T24 故障与边界验收）的**独立夹具与 oracle**：不复用被测的分片/拼接/投影函数，
// 也不与 A 的 `sync-acceptance-*` 文件共享任何实现（设计 §15.1 要求 oracle 独立生成）。
//
// 独立性做法：
// 1. 线上帧是 JSON 文本：本文件只用 `JSON.parse` 读帧字段，不调用 `decodeSyncFrame`；
// 2. base64 解码、记录提取、按 entryId/contentSlot 拼接、文本→字节全部由本文件自行实现；
// 3. 内容重建只用 Yjs 原语（`Y.applyUpdate`）按**到达顺序**重放真实帧字节，再读 `root.records`。
//
// 夹具侧（进程内传输端口 + 真实 runtime + 真实 client transport）：
// - 服务端 `SyncFrameTransport.send` 同步投递给客户端 `onFrame`，`close` 只记录理由；
// - 客户端 `options.send` 进入 outbox，由 `flushClientFrames()` 显式交给 `runtime.onInboundBytes`；
// - 时间一律来自注入的 `RecoveryClock`（真实定时器只用于 merge buffer 的兜底回调）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { SyncCapacityProfile } from "../sync/capacity/profile";
import { createSyncClientTransport, type SyncClientTransport } from "../sync/client/transport";
import { type Clock, deterministicRandomSource, type RandomSource, sha256Digest } from "../sync/clock";
import type { SyncFrame } from "../sync/protocol/frames";
import { buildDocId, createGenerationId, type SyncScope, scopeKey } from "../sync/protocol/identity";
import {
  resolveSyncRuntimeConfig,
  type SyncRuntimeConfig,
  type SyncRuntimeConfigOverrides,
} from "../sync/runtime/config";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, WriterLease } from "../sync/store/types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** 每个 harness 独立的临时暂存根目录；`dispose()` 负责删除。 */
const TEMP_PREFIX = "sync-acceptance-recovery-";

/** 默认注入的时间源：固定起点，所有截止时间都由显式 `advance` 推进。 */
export class RecoveryClock implements Clock {
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

/**
 * 严格标准 base64 解码（RFC 4648 §4，只接受标准字母表与尾部填充）。
 *
 * 与生产实现的差别是刻意的：本函数不做长度预校验与输出长度推算，非法字符直接抛错，
 * 让 oracle 只回答「帧里写的是什么字节」，不复制被测实现的分支结构。
 */
export function decodeBase64Strict(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (text.length % 4 !== 0) {
    throw new Error(`oracle: base64 length ${text.length} is not a multiple of 4`);
  }
  const contentLength = text.length - padding;
  const out: number[] = [];
  for (let offset = 0; offset < text.length; offset += 4) {
    let group = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const index = offset + slot;
      const char = text[index];
      if (char === undefined) {
        throw new Error("oracle: base64 group is truncated");
      }
      if (index >= contentLength) {
        if (char !== "=") throw new Error("oracle: base64 padding appears before the end");
        group <<= 6;
        continue;
      }
      const digit = alphabet.indexOf(char);
      if (digit < 0) throw new Error("oracle: base64 payload contains a non-alphabet character");
      group = (group << 6) | digit;
    }
    out.push((group >>> 16) & 0xff, (group >>> 8) & 0xff, group & 0xff);
  }
  return new Uint8Array(out.slice(0, out.length - padding));
}

/** 线上帧的最小读取面：oracle 只认类型、docId 与 payload 三个字段，不复制帧 schema。 */
interface WireFrameView {
  readonly type: string;
  readonly docId: string;
  readonly payload: string;
}

function parseWireFrame(bytes: Uint8Array): WireFrameView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.docId !== "string") return null;
  return { type: record.type, docId: record.docId, payload: typeof record.payload === "string" ? record.payload : "" };
}

/**
 * 按到达顺序把某 Doc 的全部数据帧重放成一份独立 Y.Doc。
 *
 * 重复/乱序帧交给 Yjs 的幂等合并语义处理：oracle 不做去重，也不做排序——它复现的正是
 * 「客户端拿到帧并逐条 apply」这条唯一路径（设计 §15.1 的「最终语义必须相等」）。
 */
export function reconstructDoc(frames: readonly Uint8Array[], docId: string): Y.Doc {
  const doc = new Y.Doc();
  for (const bytes of frames) {
    const frame = parseWireFrame(bytes);
    if (frame === null) continue;
    if (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") continue;
    if (frame.docId !== docId) continue;
    Y.applyUpdate(doc, decodeBase64Strict(frame.payload));
  }
  return doc;
}

/** 从重建后的 Doc 里读出的单条记录（形状与 `root.records` 的元素一致，键名即协议契约）。 */
export interface WireRecord {
  readonly entryId: string;
  readonly contentSlot: number;
  readonly partIndex: number;
  readonly kind: string;
  readonly bytes: Uint8Array;
}

/** 提取 `root.records`：只识别本 oracle 认识的形状，非法元素跳过而不是猜测。 */
export function extractRecords(doc: Y.Doc): WireRecord[] {
  const root = doc.getMap<unknown>("root");
  const records = root.get("records");
  if (!(records instanceof Y.Array)) return [];
  const out: WireRecord[] = [];
  for (const value of records.toArray() as unknown[]) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const payload = record.payload;
    if (!(payload instanceof Uint8Array)) continue;
    out.push({
      entryId: typeof record.entryId === "string" ? record.entryId : "",
      contentSlot: typeof record.contentSlot === "number" ? record.contentSlot : 0,
      partIndex: typeof record.partIndex === "number" ? record.partIndex : 0,
      kind: typeof record.kind === "string" ? record.kind : "",
      bytes: payload,
    });
  }
  return out;
}

/** 记录拼接键：`entryId` 与 `contentSlot` 共同定位一个逻辑入口的同一段正文。 */
export function recordKey(entryId: string, contentSlot: number): string {
  return `${entryId}\u0000${contentSlot}`;
}

/** 运行态实体的 oracle 视图：只读 `doc.getMap(kind)`（写入侧用同名根键承载实体表）。 */
export interface WireEntity {
  readonly entityId: string;
  readonly kind: string;
  readonly state: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 提取运行态实体表：键即实体身份；非对象元素跳过而不是猜测。 */
export function extractEntities(doc: Y.Doc, kind = "runtime"): WireEntity[] {
  const table = doc.getMap<unknown>(kind);
  const out: WireEntity[] = [];
  table.forEach((value, entityId) => {
    if (typeof value !== "object" || value === null) return;
    const raw = value as Record<string, unknown>;
    out.push({
      entityId,
      kind: typeof raw.kind === "string" ? raw.kind : "",
      state: typeof raw.state === "string" ? raw.state : "",
      raw,
    });
  });
  return out;
}

/**
 * 按入口拼接文本：同键记录先按 `partIndex` 升序，再逐条拼接**字节**，最后整体解码。
 *
 * 逐条解码会在代理对被切分时产出替换字符，字节级拼接才与写入侧的语义一致。
 */
export function concatEntryTexts(records: readonly WireRecord[], kind = "text"): Map<string, string> {
  const grouped = new Map<string, WireRecord[]>();
  for (const record of records) {
    if (record.kind !== kind) continue;
    const key = recordKey(record.entryId, record.contentSlot);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [record]);
    else list.push(record);
  }
  const out = new Map<string, string>();
  for (const [key, list] of grouped) {
    const ordered = [...list].sort((left, right) => left.partIndex - right.partIndex);
    out.set(key, TEXT_DECODER.decode(concatParts(ordered.map((record) => record.bytes))));
  }
  return out;
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/** 文本 → 字节的 oracle 期望值：先整体拼接再编码，保证跨输入的代理对与真实写入语义一致。 */
export function encodeOracleText(parts: readonly string[]): Uint8Array {
  return TEXT_ENCODER.encode(parts.join(""));
}

/** 期望值表：`entryId/contentSlot` → 该入口期望的原始字节（同键多次输入先拼接再编码）。 */
export function expectedBytesByEntry(
  parts: readonly { entryId: string; contentSlot: number; text: string }[],
): Map<string, Uint8Array> {
  const grouped = new Map<string, string[]>();
  for (const part of parts) {
    const key = recordKey(part.entryId, part.contentSlot);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [part.text]);
    else list.push(part.text);
  }
  const out = new Map<string, Uint8Array>();
  for (const [key, texts] of grouped) out.set(key, encodeOracleText(texts));
  return out;
}

/** 拼接某键在重建 Doc 里的原始字节（不做解码），供字节级相等断言。 */
export function concatBytesForKey(records: readonly WireRecord[], entryId: string, contentSlot: number): Uint8Array {
  const parts = records
    .filter((record) => record.entryId === entryId && record.contentSlot === contentSlot && record.kind === "text")
    .sort((left, right) => left.partIndex - right.partIndex)
    .map((record) => record.bytes);
  return concatParts(parts);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** 空 Y.Doc 的 canonical 字节：夹具用它登记「尚无内容」的入口 Doc。 */
export function emptyDocBytes(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

export interface SeededDocIds {
  readonly control: string;
  readonly runtime: string;
  readonly directory: string;
  readonly content: string;
}

export interface SeededGeneration {
  readonly generation: string;
  readonly docIds: SeededDocIds;
  readonly entryRefs: GenerationEntryRefs;
  readonly lease: WriterLease;
}

/**
 * 登记一个已提交代次（夹具扮演宿主接线层：代次入口四类 Doc 由宿主登记首块）。
 *
 * 这是 live-writer 头部偏差④明示的宿主职责（「接线层登记首块」），不是对被测代码的改写：
 * 全部走真实 `ProjectionStore` 原语，字节与摘要由本 fixture 自行生成。
 */
/** 代次入口四类 Doc 的确定性 id（只依赖代次字符串，重连夹具可据此复原同一集合）。 */
export function seededDocIdsFor(generation: string): SeededDocIds {
  return {
    control: buildDocId({ kind: "control", generation, blockIndex: 0, nonce: "control" }),
    runtime: buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: "runtime" }),
    directory: buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: "directory" }),
    content: buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "blk0" }),
  };
}

/** 额外空内容块的确定性 id 列表（与 `seedExtraContentDocs` 的数量一一对应）。 */
export function extraContentDocIdsFor(generation: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_value, index) =>
    buildDocId({ kind: "content", generation, blockIndex: index + 1, nonce: `blk${index + 1}` }),
  );
}

export async function seedCommittedGeneration(input: {
  store: MemoryProjectionStore;
  scopeKey: string;
  generation: string;
  owner: string;
  leaseTtlMs: number;
  extraContentDocIds?: readonly string[];
  /** 登记一个**没有内容块**的代次（live-writer 偏差④：写入层按 DOC_NOT_FOUND 失败而非自建块）。 */
  omitContentDoc?: boolean;
  /** 换代场景：提交时的期望当前代次与指针修订（默认「首个代次 + 修订 0」）。 */
  expectedCurrent?: string | null;
  expectedPointerRevision?: number;
  retired?: readonly string[];
}): Promise<SeededGeneration> {
  const { store, scopeKey: key, generation } = input;
  const lease = await store.acquireWriter(key, input.owner, input.leaseTtlMs);
  const docIds = seededDocIdsFor(generation);
  const omitted = input.omitContentDoc === true;
  const contentClosure = omitted ? [] : [docIds.content, ...(input.extraContentDocIds ?? [])];
  await store.createGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    generation: {
      scopeKey: key,
      generation,
      acpSessionId: "ses_acceptance_recovery",
      loadId: `load_${generation}`,
      state: "staging",
      importEndOrdinal: null,
      entryRefs: {
        controlDocId: docIds.control,
        directoryDocId: docIds.directory,
        runtimeDocId: docIds.runtime,
        contentDocIds: [],
      },
      createdAt: 0,
    },
  });
  const empty = emptyDocBytes();
  const hash = sha256Digest(empty);
  const kinds: readonly { docId: string; kind: SyncDocRecord["kind"] }[] = [
    { docId: docIds.control, kind: "control" },
    { docId: docIds.runtime, kind: "runtime" },
    { docId: docIds.directory, kind: "directory" },
    ...(omitted ? [] : [{ docId: docIds.content, kind: "content" as const }]),
    ...(omitted ? [] : (input.extraContentDocIds ?? []).map((docId) => ({ docId, kind: "content" as const }))),
  ];
  for (const entry of kinds) {
    await store.createDoc({
      scopeKey: key,
      epoch: lease.epoch,
      doc: {
        scopeKey: key,
        generation,
        docId: entry.docId,
        kind: entry.kind,
        state: "active",
        snapshot: empty,
        hash,
        baseSeq: 0,
        finalSeq: null,
        blockIndex: entry.kind === "content" ? 0 : null,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      },
    });
  }
  const entryRefs: GenerationEntryRefs = {
    controlDocId: docIds.control,
    directoryDocId: docIds.directory,
    runtimeDocId: docIds.runtime,
    contentDocIds: contentClosure,
  };
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    expectedCurrent: input.expectedCurrent ?? null,
    newGeneration: {
      scopeKey: key,
      generation,
      acpSessionId: "ses_acceptance_recovery",
      loadId: `load_${generation}`,
      state: "staging",
      importEndOrdinal: 0,
      entryRefs,
      createdAt: 0,
    },
    retired: [...(input.retired ?? [])],
    entryClosure: entryRefs,
    expectedPointerRevision: input.expectedPointerRevision ?? 0,
  });
  return { generation, docIds, entryRefs, lease };
}

export interface RecoveryHarnessOptions {
  readonly clock?: RecoveryClock;
  readonly random?: RandomSource;
  readonly scope?: SyncScope;
  readonly generation?: string;
  readonly capacity?: SyncCapacityProfile;
  readonly configOverrides?: SyncRuntimeConfigOverrides;
  /** 夹具自身的写者标识：与运行时写入层的 owner 区分开，租约轮换语义才可判定。 */
  readonly hostOwner?: string;
  /** 额外登记的空内容块数量（多 Doc 场景用）。 */
  readonly seedExtraContentDocs?: number;
  /** 登记一个没有内容块的代次（写入层偏差④场景）。 */
  readonly omitContentDoc?: boolean;
  /** 复用既有存储（冷重连/竞态场景）；给出时须一并传入原 harness 的 `clock`（存储按构造期的时钟判定租约）。 */
  readonly store?: MemoryProjectionStore;
  /** 复用既有存储时跳过代次登记（调用方已登记过）。 */
  readonly skipSeed?: boolean;
}

/** 进程内端到端夹具：真实 runtime + 真实 client transport + 真实帧字节。 */
export interface RecoveryHarness {
  readonly scope: SyncScope;
  readonly scopeKey: string;
  readonly generation: string;
  readonly clock: RecoveryClock;
  readonly store: MemoryProjectionStore;
  readonly runtime: SyncScopeRuntime;
  readonly client: SyncClientTransport;
  readonly config: SyncRuntimeConfig;
  readonly docIds: SeededDocIds;
  readonly extraContentDocIds: readonly string[];
  /** 服务端 → 客户端的原始帧字节（按投递顺序）。 */
  readonly wireToClient: Uint8Array[];
  /** 客户端 → 服务端的原始帧字节（按发出顺序）。 */
  readonly wireToServer: Uint8Array[];
  /** 客户端收到的控制帧（`onControl` 回调）。 */
  readonly controlFrames: SyncFrame[];
  /** 客户端上报的协议级失败。 */
  readonly fatalCodes: { readonly code: string; readonly detail?: string }[];
  /** 服务端出站端口收到的关闭理由（调用即记录，重复关闭只记一次）。 */
  readonly serverCloseReasons: string[];
  /** 服务端出站端口是否已关闭（关闭后 `send` 返回 false 且不投递）。 */
  readonly outboundClosed: boolean;
  /** 注入的 socket 待发送字节真值；置高即触发网关的 socket 水位门禁。 */
  bufferedAmount: number;
  /** 注入的传输层饱和：为 true 时 `send` 返回 false 且不投递。 */
  sendSaturated: boolean;
  /** 客户端 outbox（尚未交给服务端的帧字节）。 */
  readonly clientOutbox: Uint8Array[];
  /** 服务端出帧网关的已登记在途投递数（ACK 超时清账的观测点）。 */
  outstandingDeliveries(): number;
  /** 构造客户端帧（JSON 文本 + UTF-8）并直接投递给服务端。 */
  sendClientFrame(frame: SyncFrame): Promise<void>;
  /** 把客户端 outbox 中的帧按序交给服务端。 */
  flushClientFrames(): Promise<void>;
  /** 一次完整往返：flush → drain → flush → tick，直到两侧都静止。 */
  settle(maxRounds?: number): Promise<void>;
  /** 重建某 Doc 的独立 Y.Doc（只看真实帧字节）。 */
  reconstruct(docId: string): Y.Doc;
  /** 释放在途资源并删除临时目录；重复调用无副作用。 */
  dispose(): Promise<void>;
}

export async function createRecoveryHarness(options: RecoveryHarnessOptions = {}): Promise<RecoveryHarness> {
  const clock = options.clock ?? new RecoveryClock();
  const random = options.random ?? deterministicRandomSource("acceptance-recovery");
  const scope = options.scope ?? { organizationId: "org_acceptance", rcsSessionId: "rcs_acceptance_recovery" };
  const key = scopeKey(scope);
  const generation = options.generation ?? createGenerationId(deterministicRandomSource(`gen-${key}`));
  const spoolRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const config = resolveSyncRuntimeConfig({
    ...options.configOverrides,
    clock,
    random,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    lifecycle: options.configOverrides?.lifecycle ?? { sealGraceMs: 1000, retireGraceMs: 1000 },
    spoolRootDir: spoolRoot,
  });
  const store =
    options.store ??
    new MemoryProjectionStore({
      clock,
      digest: sha256Digest,
      capacity: config.capacity,
      lifecycle: config.lifecycle,
    });
  const extraContentDocIds = extraContentDocIdsFor(generation, options.seedExtraContentDocs ?? 0);
  if (options.skipSeed !== true) {
    await seedCommittedGeneration({
      store,
      scopeKey: key,
      generation,
      owner: options.hostOwner ?? "acceptance-host",
      leaseTtlMs: 1000,
      extraContentDocIds,
      omitContentDoc: options.omitContentDoc === true,
    });
    // 夹具的登记租约必须让位于运行时写入层：推进超过 TTL 让下一次 `acquireWriter` 换新 epoch。
    clock.advance(5000);
  }
  const docIds = seededDocIdsFor(generation);

  const runtime = await createSyncScopeRuntime({ scope, config, clock, digest: sha256Digest, random, store });

  const wireToClient: Uint8Array[] = [];
  const wireToServer: Uint8Array[] = [];
  const controlFrames: SyncFrame[] = [];
  const fatalCodes: { code: string; detail?: string }[] = [];
  const serverCloseReasons: string[] = [];
  const clientOutbox: Uint8Array[] = [];
  const link = { outboundClosed: false, bufferedAmount: 0, sendSaturated: false };
  let disposed = false;

  const client = createSyncClientTransport({
    send: (bytes) => {
      if (disposed) return false;
      clientOutbox.push(bytes);
      return true;
    },
    now: () => clock.now(),
    yieldToHost: async () => {},
    onControl: (frame) => controlFrames.push(frame),
    onFatal: (code, detail) => fatalCodes.push(detail === undefined ? { code } : { code, detail }),
  });

  const transport: SyncFrameTransport = {
    send: (bytes) => {
      if (link.outboundClosed || link.sendSaturated) return false;
      wireToClient.push(bytes);
      client.onFrame(bytes);
      return true;
    },
    bufferedAmount: () => link.bufferedAmount,
    close: (reason) => {
      if (link.outboundClosed) return;
      link.outboundClosed = true;
      serverCloseReasons.push(reason);
    },
  };
  const gateway = runtime.attachTransport(transport);
  /** 已登记在途投递的观测入口：ACK 超时清理的直接证据。 */
  const outstandingDeliveries = (): number => gateway.outstandingDeliveries();

  async function flushClientFrames(): Promise<void> {
    while (clientOutbox.length > 0) {
      const head = clientOutbox.shift();
      if (head === undefined) break;
      wireToServer.push(head);
      await runtime.onInboundBytes(head);
    }
  }

  async function settle(maxRounds = 24): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      const pendingBefore = clientOutbox.length + client.hub.queueDepth();
      await flushClientFrames();
      await client.drain();
      await flushClientFrames();
      await runtime.tick();
      const pendingAfter = clientOutbox.length + client.hub.queueDepth();
      if (pendingBefore === 0 && pendingAfter === 0) return;
    }
  }

  async function sendClientFrame(frame: SyncFrame): Promise<void> {
    const bytes = TEXT_ENCODER.encode(JSON.stringify(frame));
    wireToServer.push(bytes);
    await runtime.onInboundBytes(bytes);
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
    await rm(spoolRoot, { recursive: true, force: true });
  }

  return {
    scope,
    scopeKey: key,
    generation,
    clock,
    store,
    runtime,
    client,
    config,
    docIds,
    extraContentDocIds,
    wireToClient,
    wireToServer,
    controlFrames,
    fatalCodes,
    serverCloseReasons,
    clientOutbox,
    get outboundClosed() {
      return link.outboundClosed;
    },
    get bufferedAmount() {
      return link.bufferedAmount;
    },
    set bufferedAmount(value: number) {
      link.bufferedAmount = value;
    },
    get sendSaturated() {
      return link.sendSaturated;
    },
    set sendSaturated(value: boolean) {
      link.sendSaturated = value;
    },
    sendClientFrame,
    flushClientFrames,
    settle,
    outstandingDeliveries,
    reconstruct: (docId: string) => reconstructDoc(wireToClient, docId),
    dispose,
  };
}

/** 帧类型读取：oracle 侧只做 JSON 解析，不调用被测解码器。 */
export function frameTypeOf(bytes: Uint8Array): string | null {
  const frame = parseWireFrame(bytes);
  return frame === null ? null : frame.type;
}

/** 从 real 帧字节里取出某类型帧的字段视图（oracle 观测用；不做 schema 校验）。 */
export function frameFieldsOf(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(TEXT_DECODER.decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
