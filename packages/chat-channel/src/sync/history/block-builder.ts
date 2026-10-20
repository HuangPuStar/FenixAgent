// packages/chat-channel/src/sync/history/block-builder.ts
// C2 单块构建（规格 §5.4，设计 §5.2 / §4.2）：把一段连续的导入记录编码成一个 canonical 内容块 Doc。
//
// 三条必须同时成立的契约（违反即数据串扰、摘要不可复现或内存泄漏）：
// 1. 结构逐字固定：`doc.getMap("root")` 的键为 schemaVersion/kind/generation/blockIndex/ordinalStart/
//    ordinalEnd/recordCount/records，`records` 元素是**七个字段的扁平普通对象**（不嵌套 Y.Map/Y.Text）。
//    读取契约与构建期共用这一份结构，改键必须同步改所有读者；键序也参与编码字节（见 `toFlatRecord`）。
// 2. 同输入必须产出同一份 canonical 字节：Yjs 每次构造 Doc 都取随机 clientID，而 clientID 会被编码进
//    每个 struct 的 ID —— 直接构造会让「同内容重建」得到不同 snapshot/hash，使同摘要重试、幂等重放与
//    冲突判定全部失效。故本函数把 clientID 由记录内容确定性派生（见 `deriveClientId`）。
// 3. 构建期 Doc 是私有临时物：一次调用只构建一个块，返回前必须 `destroy()`（否则每块泄一个 Doc，
//    且活着的 Doc 会被误接进广播路径）。本函数不注册 observer、不接 provider，也不持有模块级引用。
//
// 规格未定、此处定死的三点（集成方如另有裁定，改动只落在本文件）：
// - 返回值只覆盖输入的**前缀**：能装进硬限的最长连续记录段，剩余记录由 `sourceOrdinal > ordinalEnd`
//   表达，必须由调用方再次调用本函数继续构建；本函数不排队、不循环、也不静默丢弃。
// - 超硬限时的「最多一次重新分块」实现为**一次有界重新定界**：在记录边界上二分出最大可行前缀
//   （≤⌈log2 n⌉ 次编码），不做多轮「分块 → 再分块」，也不做无界线性收缩。
// - `records[].byteStart/byteEnd` 是**记录自身载荷**的字节区间（恒为 `[0, payloadBytes)`）。逻辑对象内的
//   分片偏移只能由知道分片边界的调用方（`splitJsonParts` 的结果）写入 `SyncRefRecord`，本函数不猜。

import * as Y from "yjs";

import type { DigestFn, RandomSource } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier, buildDocId } from "../protocol/identity";
import type { HistoryRecordKind } from "./ingest";

/** 内容块根键的 schema 版本；与读取契约同源，读到未知版本必须拒绝而不是尽力解析。 */
const CONTENT_SCHEMA_VERSION = 1;

/** 单事务最多写入的记录数（规格 §5.4）：事务越大，单次 apply 的峰值内存与失败面越大且越难重放。 */
const MAX_RECORDS_PER_TRANSACTION = 256;

/** docId 的 nonce 字节数：8 字节 = 16 hex，与协议内其它 epoch 标识同宽。 */
const NONCE_BYTES = 8;

/** recordId 中载荷摘要的取样长度：足够区分同块内的不同记录，又不把 id 撑长。 */
const RECORD_ID_DIGEST_CHARS = 16;

/** 32 位 FNV-1a 的初始值与质数；仅用于把内容折叠成 clientID，不是摘要算法（摘要仍由注入的 `DigestFn` 给出）。 */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** 一条待构建的记录：来自导入接收编号结果，序号连续是块的完整性前提。 */
export interface BlockRecordInput {
  /** 源对象在本次 load 中的接收序号，从 1 开始且块内连续递增。 */
  sourceOrdinal: number;
  kind: HistoryRecordKind;
  payload: Uint8Array;
  entryId: string;
  /** 时间线位置（设计 §4.2：任务完成时间与网络到达时间都不能改变它）。 */
  entryOrder: number;
  /** 同一 entry 内的内容位置。 */
  contentSlot: number;
  /** 逻辑对象的分片序号；整对象记录固定为 0。 */
  partIndex: number;
}

/** Y.Doc 中 `records` 的元素形状：扁平普通对象，键序与规格 §5.4 逐字一致。 */
interface FlatRecordValue {
  recordId: string;
  entryId: string;
  entryOrder: number;
  contentSlot: number;
  partIndex: number;
  kind: HistoryRecordKind;
  payload: Uint8Array;
}

/**
 * 块内一条记录的位置描述，供提交方写目录与派生索引。
 *
 * `orderStart/orderEnd` 与 `byteStart/byteEnd` 都是**范围**字段：本函数每条记录只覆盖一个 entryOrder、
 * 且只覆盖自身载荷，故起止相等 / 从 0 起（合并多片段属实时写入路径，不在历史构建内发生）。
 */
export interface BuiltBlockRecord {
  recordId: string;
  ordinal: number;
  entryId: string;
  orderStart: number;
  orderEnd: number;
  byteStart: number;
  byteEnd: number;
  digest: string;
}

/** 一个构建完成的内容块：canonical 字节 + 定位元数据。 */
export interface BuiltBlock {
  docId: string;
  generation: string;
  blockIndex: number;
  ordinalStart: number;
  ordinalEnd: number;
  recordCount: number;
  /** canonical Yjs 状态：`Y.encodeStateAsUpdate(doc)`，持久化与下发的唯一权威字节。 */
  snapshot: Uint8Array;
  hash: string;
  stateVector: Uint8Array;
  /**
   * 直接依赖的 docId。内容块恒为空：块与块之间没有 CRDT 依赖，读取顺序由目录的 ordinal 范围与
   * ref 索引表达；`inputs.dependsOnMax`（8 项）约束的是需要入口屏障的 Doc，不是内容块。
   */
  dependsOn: string[];
  records: BuiltBlockRecord[];
}

/** 构建入参：规格 §5.4 内联参数的具名形式，字段语义不变（不多不少）。 */
export interface BuildContentBlockInput {
  generation: string;
  blockIndex: number;
  records: readonly BlockRecordInput[];
  /** 软水位：按载荷字节累积记录，超出即停止累积，不追求刚好填满。 */
  targetPayloadBytes: number;
  /** 硬限：编码后 snapshot 字节上限，越界只能靠减少记录数解决，不能切 CRDT 字节。 */
  hardLimitBytes: number;
  rand: RandomSource;
  digest: DigestFn;
}

/** 校验通过并补齐派生字段（recordId、payload 摘要）的记录。 */
interface PreparedRecord extends BlockRecordInput {
  readonly recordId: string;
  readonly digest: string;
}

/** 一次编码尝试的产物；每次尝试都用一个新的私有 Doc。 */
interface EncodedChunk {
  readonly records: PreparedRecord[];
  readonly snapshot: Uint8Array;
  readonly stateVector: Uint8Array;
}

/** 结构性输入错误：重试不会改变输入，必须让调用方改调用方式，而不是退避重试。 */
function rejectMalformed(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message: `content block build: ${message}` });
}

/** 容量参数非法按 `ADMISSION_REJECTED` 抛出（与容量配置校验同一口径）：启用期只暴露一种失败类型。 */
function rejectLimits(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `content block build: ${message}` });
}

/** 非负整数校验：负数、小数、`NaN` 都会让顺序元数据静默失真，必须在写 Doc 之前失败。 */
function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejectMalformed(`${field} must be a non-negative safe integer`);
  }
}

/** 取 docId 的 nonce：每次构建尝试都换新，同谱系的不同尝试据此区分（禁止复用旧 guid 重建后合并）。 */
function randomNonce(rand: RandomSource): string {
  const bytes = rand.bytes(NONCE_BYTES);
  if (bytes.length !== NONCE_BYTES) {
    rejectMalformed(`random source returned ${bytes.length} bytes, expected ${NONCE_BYTES}`);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 校验记录序列并补齐派生字段。
 *
 * 强制块内 ordinal 连续递增：目录靠 `[ordinalStart, ordinalEnd]` 与 recordCount 判定覆盖与缺口，
 * 序号重复或跳号会让「块覆盖的区间」与「块内实际记录」不一致，缺口检测随后会给出错误结论。
 */
function prepareRecords(records: readonly BlockRecordInput[], digest: DigestFn): PreparedRecord[] {
  if (records.length === 0) {
    rejectMalformed("records must not be empty: an empty block covers no ordinal range");
  }
  const prepared: PreparedRecord[] = [];
  let previousOrdinal: number | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertIdentifier(record.entryId, `records[${index}].entryId`);
    if (!(record.payload instanceof Uint8Array)) {
      rejectMalformed(`records[${index}].payload must be a Uint8Array`);
    }
    if (!Number.isSafeInteger(record.sourceOrdinal) || record.sourceOrdinal <= 0) {
      rejectMalformed(`records[${index}].sourceOrdinal must be a positive safe integer`);
    }
    if (previousOrdinal !== null && record.sourceOrdinal !== previousOrdinal + 1) {
      rejectMalformed(`records[${index}].sourceOrdinal must be ${previousOrdinal + 1}`);
    }
    assertNonNegativeInteger(record.entryOrder, `records[${index}].entryOrder`);
    assertNonNegativeInteger(record.contentSlot, `records[${index}].contentSlot`);
    assertNonNegativeInteger(record.partIndex, `records[${index}].partIndex`);
    const payloadDigest = digest(record.payload);
    prepared.push({
      ...record,
      // recordId 由「序号 + 载荷摘要」派生：同内容重建得到同一 id（重建产物可重复 apply 而不产生重复记录），
      // 同块内载荷相同的两条记录也因序号不同而不撞号。
      recordId: `rec_${record.sourceOrdinal}_${payloadDigest.slice(0, RECORD_ID_DIGEST_CHARS)}`,
      digest: payloadDigest,
    });
    previousOrdinal = record.sourceOrdinal;
  }
  return prepared;
}

/**
 * 按软水位选取最长前缀；首条记录无论多大都先纳入（单条超限由硬限裁决，而不是在这里静默丢记录）。
 */
function selectTargetPrefix(records: readonly PreparedRecord[], targetPayloadBytes: number): number {
  let accumulated = 0;
  for (let index = 0; index < records.length; index += 1) {
    const next = accumulated + records[index].payload.byteLength;
    if (index > 0 && next > targetPayloadBytes) {
      return index;
    }
    accumulated = next;
  }
  return records.length;
}

/**
 * 派生 clientID：折叠「序号 + 载荷摘要」成 32 位无符号整数。
 *
 * 为什么不能用随机构造值：struct ID 就是 `(clientID, clock)`，随机 clientID 会让同一份内容在不同次构建
 * 得到不同字节，摘要随之一变——「同 docId 同摘要即幂等」「同摘要重试成功」这两条路径立刻失效。
 * 折叠值随内容变化，则两段不同内容不会共享 struct ID，重复 apply 同一份产物仍是幂等的。
 */
function deriveClientId(records: readonly PreparedRecord[]): number {
  let acc = FNV_OFFSET_BASIS;
  for (const record of records) {
    const seed = `${record.sourceOrdinal}:${record.digest}`;
    for (let index = 0; index < seed.length; index += 1) {
      acc = Math.imul(acc ^ seed.charCodeAt(index), FNV_PRIME) >>> 0;
    }
  }
  return acc >>> 0;
}

/** 扁平元素的键序固定为规格 §5.4 的顺序：`ContentAny` 按对象自身键序编码，换序会改变 canonical 字节。 */
function toFlatRecord(record: PreparedRecord): FlatRecordValue {
  return {
    recordId: record.recordId,
    entryId: record.entryId,
    entryOrder: record.entryOrder,
    contentSlot: record.contentSlot,
    partIndex: record.partIndex,
    kind: record.kind,
    payload: record.payload,
  };
}

/** 写入块头键；与首批记录同一个事务，读者不会读到「有记录但无 schemaVersion」的中间态。 */
function writeBlockMeta(
  root: Y.Map<unknown>,
  records: readonly PreparedRecord[],
  generation: string,
  blockIndex: number,
): void {
  root.set("schemaVersion", CONTENT_SCHEMA_VERSION);
  root.set("kind", "content");
  root.set("generation", generation);
  root.set("blockIndex", blockIndex);
  root.set("ordinalStart", records[0].sourceOrdinal);
  root.set("ordinalEnd", records[records.length - 1].sourceOrdinal);
  root.set("recordCount", records.length);
}

/**
 * 构造私有 Doc 并取 canonical 字节；无论成功还是中途抛错都在 `finally` 中 destroy。
 *
 * 记录按 ≤256 条一批写入：批次划分不影响编码字节（struct ID 只由 clientID 与 clock 决定，与事务边界无关），
 * 但它决定了单事务的写入规模。
 */
function encodeChunk(
  records: readonly PreparedRecord[],
  docId: string,
  generation: string,
  blockIndex: number,
): EncodedChunk {
  const doc = new Y.Doc({ guid: docId });
  try {
    doc.clientID = deriveClientId(records);
    const root = doc.getMap("root");
    const target = new Y.Array<FlatRecordValue>();
    const firstBatch = records.slice(0, MAX_RECORDS_PER_TRANSACTION).map(toFlatRecord);
    doc.transact(() => {
      writeBlockMeta(root, records, generation, blockIndex);
      root.set("records", target);
      target.push(firstBatch);
    });
    for (let offset = MAX_RECORDS_PER_TRANSACTION; offset < records.length; offset += MAX_RECORDS_PER_TRANSACTION) {
      const batch = records.slice(offset, offset + MAX_RECORDS_PER_TRANSACTION).map(toFlatRecord);
      doc.transact(() => {
        target.push(batch);
      });
    }
    return { records: [...records], snapshot: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally {
    doc.destroy();
  }
}

/**
 * 一次有界重新定界：在记录边界上二分出能装进硬限的最长前缀。
 *
 * 为什么是二分而不是「砍半一次」或线性收缩：snapshot 字节数随追加记录单调不减，二分（≤⌈log2 n⌉ 次编码）
 * 一次就能定到最大可行前缀，既不重复多轮「分块 → 再分块」，也不做无界线性重试。返回 `null` 表示
 * 连一条记录都装不进硬限——此时不存在更小的合法块，必须报容量错误。
 */
function fitWithinHardLimit(
  records: readonly PreparedRecord[],
  upperBound: number,
  docId: string,
  generation: string,
  blockIndex: number,
  hardLimitBytes: number,
): EncodedChunk | null {
  let low = 1;
  let high = upperBound - 1;
  let best: EncodedChunk | null = null;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const attempt = encodeChunk(records.slice(0, mid), docId, generation, blockIndex);
    if (attempt.snapshot.byteLength <= hardLimitBytes) {
      best = attempt;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** 硬限不可满足：单条记录本身就编码超限（既不能拆已发布 CRDT，也不能靠网络分片遮蔽超大 snapshot）。 */
function rejectHardLimit(
  docId: string,
  generation: string,
  firstOrdinal: number,
  encodedBytes: number,
  hardLimitBytes: number,
): never {
  throw new SyncProtocolError("CAPACITY_EXCEEDED", {
    message:
      `content block ${docId}: encoded snapshot of ${encodedBytes} bytes exceeds hard limit ${hardLimitBytes};` +
      " a single record does not fit and cannot be split by re-chunking",
    safeContext: { generation, docId, ordinal: firstOrdinal },
  });
}

/** 组装返回值：ordinal 范围与记录数只来自实际纳入的记录，保证与 snapshot 内容一致。 */
function finalizeBlock(input: BuildContentBlockInput, docId: string, chunk: EncodedChunk): BuiltBlock {
  return {
    docId,
    generation: input.generation,
    blockIndex: input.blockIndex,
    ordinalStart: chunk.records[0].sourceOrdinal,
    ordinalEnd: chunk.records[chunk.records.length - 1].sourceOrdinal,
    recordCount: chunk.records.length,
    snapshot: chunk.snapshot,
    hash: input.digest(chunk.snapshot),
    stateVector: chunk.stateVector,
    dependsOn: [],
    records: chunk.records.map((record) => ({
      recordId: record.recordId,
      ordinal: record.sourceOrdinal,
      entryId: record.entryId,
      orderStart: record.entryOrder,
      orderEnd: record.entryOrder,
      byteStart: 0,
      byteEnd: record.payload.byteLength,
      digest: record.digest,
    })),
  };
}

/**
 * 构建一个内容块，返回其 canonical 快照与定位元数据（同步函数：只做内存编码与一次摘要，不含 I/O）。
 *
 * 典型用法：调用方持有按 `sourceOrdinal` 递增的记录，本函数返回 `ordinalStart..ordinalEnd` 的前缀块；
 * 若 `ordinalEnd` 小于调用方最后一条记录的序号，用剩余记录再次调用本函数，直到全部记录成块。
 */
export function buildContentBlock(input: BuildContentBlockInput): BuiltBlock {
  if (!Number.isSafeInteger(input.targetPayloadBytes) || input.targetPayloadBytes <= 0) {
    rejectLimits("targetPayloadBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.hardLimitBytes) || input.hardLimitBytes <= 0) {
    rejectLimits("hardLimitBytes must be a positive safe integer");
  }
  if (input.targetPayloadBytes > input.hardLimitBytes) {
    rejectLimits("targetPayloadBytes must not exceed hardLimitBytes");
  }
  // docId 先算：generation（含 `/` 或控制字符）与 blockIndex 非法时在建 Doc 之前就失败。
  const docId = buildDocId({
    kind: "content",
    generation: input.generation,
    blockIndex: input.blockIndex,
    nonce: randomNonce(input.rand),
  });
  const prepared = prepareRecords(input.records, input.digest);
  const targetLength = selectTargetPrefix(prepared, input.targetPayloadBytes);
  const attempt = encodeChunk(prepared.slice(0, targetLength), docId, input.generation, input.blockIndex);
  if (attempt.snapshot.byteLength <= input.hardLimitBytes) {
    return finalizeBlock(input, docId, attempt);
  }
  const fitted = fitWithinHardLimit(
    prepared,
    targetLength,
    docId,
    input.generation,
    input.blockIndex,
    input.hardLimitBytes,
  );
  if (fitted === null) {
    rejectHardLimit(
      docId,
      input.generation,
      prepared[0].sourceOrdinal,
      attempt.snapshot.byteLength,
      input.hardLimitBytes,
    );
  }
  return finalizeBlock(input, docId, fitted);
}
