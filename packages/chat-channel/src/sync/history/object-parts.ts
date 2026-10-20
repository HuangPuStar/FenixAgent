// 历史逻辑对象的分片规划（设计 §4.3）：单条记录必须装进一个可传输的 Doc，超出时拆成多条。
//
// 分片只发生在导入入口，不改变线上帧：每个分片都是独立记录，因此目录 ordinal、块硬限与传输上限
// 仍按原有单记录规则成立。`partIndex` 采用「高位逻辑片段 + 低位片内序号」复合编码，保证同一
// entry/slot 的所有片段按调用方顺序稳定排序；未分片记录也走同一编码，避免混合排序时交错。
// 对象分片用自描述信封保存原 kind、片数、总字节与摘要；文本分片仍是 JSON 字符串，现有投影按
// 记录顺序逐条解码拼接，不需要读侧新增重组协议。

import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { fidelitySerialize } from "./fidelity-json";
import type { HistoryRecordKind, HistoryRecordMeta } from "./ingest";

/** 对象分片信封键：读取方可据此识别并重组逻辑对象。 */
export const HISTORY_OBJECT_PART_KEY = "__fenixSyncObjectPart";
/** 片内序号位宽：单个逻辑片段最多 1,048,576 个物理分片。 */
const PART_BITS = 20;
const PART_MASK = (1 << PART_BITS) - 1;
const MAX_BASE_PART = Math.floor(Number.MAX_SAFE_INTEGER / (1 << PART_BITS));
/** 信封自身的保守开销（字段名、摘要、片数等）。 */
const ENVELOPE_OVERHEAD_BYTES = 512;

/** 一个待接收的物理记录：值仍走保真序列化，meta 携带稳定后的 partIndex。 */
export interface HistoryPart {
  readonly value: unknown;
  readonly meta: HistoryRecordMeta;
}

export interface HistoryPartPlanInput {
  readonly value: unknown;
  readonly meta: HistoryRecordMeta;
  /** 单条记录载荷预算（`historyBlockTargetPayloadBytes`）。 */
  readonly recordBudgetBytes: number;
  /** 超过该大小的对象保留单任务大帧路径，不在本层拆分。 */
  readonly largeFrameThresholdBytes: number;
  readonly digest: DigestFn;
}

function malformed(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message });
}

/** 复合 partIndex：同一 entry/slot 内先按逻辑片段，再按片内序号排序。 */
export function composePartIndex(base: number, fragment: number): number {
  if (!Number.isSafeInteger(base) || base < 0 || base > MAX_BASE_PART) {
    malformed("history partIndex is outside the supported range");
  }
  if (!Number.isSafeInteger(fragment) || fragment < 0 || fragment > PART_MASK) {
    malformed("history fragment index is outside the supported range");
  }
  return base * (PART_MASK + 1) + fragment;
}

function withPartIndex(meta: HistoryRecordMeta, partIndex: number): HistoryRecordMeta {
  return { ...meta, partIndex };
}

/** 按码点线性切分文本，保证每片 UTF-8 字节数不超过预算；代理对不会被拆开。 */
function splitTextBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let used = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (used > 0 && used + width > maxBytes) {
      chunks.push(text.slice(start, offset));
      start = offset;
      used = 0;
    }
    offset += char.length;
    used += width;
  }
  if (offset > start) chunks.push(text.slice(start));
  return chunks;
}

function assertPartBudget(bytes: Uint8Array, budget: number, index: number): void {
  if (bytes.byteLength > budget) {
    malformed(`history fragment ${index} is ${bytes.byteLength} bytes, budget is ${budget}`);
  }
}

/** 文本分片：每个分片仍是合法 JSON 字符串，投影按记录顺序拼接即可还原原文。 */
function splitText(value: string, meta: HistoryRecordMeta, base: number, budget: number): HistoryPart[] {
  // 最坏情况每个代码单元被 JSON 转义成 6 字节（\uXXXX）；先用保守预算切，再按实际编码收缩。
  let textBudget = Math.max(1, Math.floor((budget - ENVELOPE_OVERHEAD_BYTES) / 6));
  for (;;) {
    const chunks = splitTextBytes(value, textBudget);
    if (chunks.every((chunk) => fidelitySerialize(chunk).byteLength <= budget)) {
      return chunks.map((chunk, index) => ({
        value: chunk,
        meta: withPartIndex(meta, composePartIndex(base, index)),
      }));
    }
    textBudget = Math.floor(textBudget / 2);
    if (textBudget < 1) malformed("history text fragment cannot fit the record budget");
  }
}

/** 对象分片：原始 canonical 字节切成自描述信封，每片仍是合法 JSON 值且独立可校验。 */
function splitObject(
  bytes: Uint8Array,
  kind: HistoryRecordKind,
  meta: HistoryRecordMeta,
  base: number,
  budget: number,
  digest: DigestFn,
): HistoryPart[] {
  let rawBudget = Math.max(1, Math.floor(((budget - ENVELOPE_OVERHEAD_BYTES) * 3) / 4));
  for (;;) {
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / rawBudget));
    if (partCount <= PART_MASK + 1) {
      const parts: HistoryPart[] = [];
      const totalDigest = digest(bytes);
      for (let index = 0; index < partCount; index += 1) {
        const start = index * rawBudget;
        const end = Math.min(start + rawBudget, bytes.byteLength);
        const envelope = {
          [HISTORY_OBJECT_PART_KEY]: 1,
          kind,
          partIndex: index,
          partCount,
          totalBytes: bytes.byteLength,
          digest: totalDigest,
          data: Buffer.from(bytes.subarray(start, end)).toString("base64"),
        };
        assertPartBudget(fidelitySerialize(envelope), budget, index);
        parts.push({ value: envelope, meta: withPartIndex(meta, composePartIndex(base, index)) });
      }
      return parts;
    }
    rawBudget = Math.floor(rawBudget / 2);
    if (rawBudget < 1) malformed("history object cannot be split within the fragment index range");
  }
}

/**
 * 规划一次逻辑接收对应的物理记录。
 *
 * 超过大帧阈值的对象不在这里拆：保留 `HistoryIngest` 的单任务大帧额度和原始帧上限判定，避免
 * 拆分绕过并发/内存约束。预算内的小对象保持单条记录，只统一 partIndex 编码。
 */
export function planHistoryParts(input: HistoryPartPlanInput): HistoryPart[] {
  const { value, meta, recordBudgetBytes, largeFrameThresholdBytes, digest } = input;
  const bytes = fidelitySerialize(value);
  const base = meta.partIndex ?? 0;
  if (bytes.byteLength <= recordBudgetBytes || bytes.byteLength > largeFrameThresholdBytes) {
    return [{ value, meta: withPartIndex(meta, composePartIndex(base, 0)) }];
  }
  if (meta.kind === "text_part" && typeof value === "string") {
    return splitText(value, meta, base, recordBudgetBytes);
  }
  return splitObject(bytes, meta.kind, meta, base, recordBudgetBytes, digest);
}
