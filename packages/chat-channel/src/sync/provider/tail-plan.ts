// packages/chat-channel/src/sync/provider/tail-plan.ts
// E 阶段 tail 规划（设计 §8.4）：BASE_READY 之后只发 S+1 起的连续已提交边界。
//
// 三条规则：
// 1. 批次只能由 `readUpdatesAfter` 的连续结果构成；遇到缺口一律停下、不跳洞，由调用方换新 base 补齐
//    （设计 §8.4「停止该 Doc 的后续增量并申请补齐」）。
// 2. 一个批次是一帧的载荷：多条记录经 `Y.mergeUpdates` 合并，重放合并载荷与逐条重放等价且可重复应用（幂等）。
// 3. 字节上限与摘要都只针对**实际发送的载荷**：帧头与 envelope 由额度层计费（设计 §8.5），本层不重复计。

import * as Y from "yjs";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore, SyncUpdateRecord } from "../store/types";

export interface TailBatch {
  readonly docId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly payload: Uint8Array;
  readonly digest: string;
}

export interface TailPlannerDeps {
  readonly store: ProjectionStore;
  readonly digest: DigestFn;
  readonly maxBatchBytes: number;
}

export interface TailPlanner {
  /** 返回 S+1 起的连续已提交 tail；无新内容返回空数组。 */
  next(docId: string, afterSeq: number, limit: number): Promise<TailBatch[]>;
  /** 序号缺口/异代/依赖异常时停止该 Doc 后续增量并申请补齐。 */
  detectGap(docId: string, expectedSeq: number, receivedSeq: number): boolean;
}

/**
 * 单批次记录上限（同时是每次存储读取的条数）：限制一帧的结构数量，也就是客户端单次 `Y.applyUpdate`
 * 的同步成本上界（设计 §8.6.3）。记录更多只会让帧更长，不会让客户端更快追上前沿。
 */
const RECORDS_PER_BATCH = 64;

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

interface BuiltBatch {
  readonly payload: Uint8Array;
  /** 本批实际合并的记录条数：调用方据此推进页内游标。 */
  readonly count: number;
  readonly toSeq: number;
}

function mergeRange(records: readonly SyncUpdateRecord[], start: number, count: number): Uint8Array {
  const updates: Uint8Array[] = [];
  for (let offset = 0; offset < count; offset += 1) updates.push(records[start + offset].bytes);
  return Y.mergeUpdates(updates);
}

/**
 * 从 `records[start]` 起的连续前缀合并成一个批次的载荷。
 *
 * 第一条记录无条件接收：单条已提交更新不可切分，拒绝它会让该 Doc 永远追不上前沿，因此上限不可达时
 * 宁可让它独占一批。其余记录按「各记录字节之和 ≤ 上限」预筛——合并只做头部去重与结构重组，结果不会大于
 * 各记录之和——合并后再核对一次：编码非单调的极端情形下按记录回退，保证返回的载荷确实不超上限。
 */
function buildBatch(records: readonly SyncUpdateRecord[], start: number, maxBatchBytes: number): BuiltBatch {
  let count = 1;
  let total = records[start].bytes.byteLength;
  while (start + count < records.length) {
    const next = records[start + count];
    // 记录必须连续：非连续即缺口，批次的 fromSeq/toSeq 不能跨越它。
    if (next.updateSeq !== records[start + count - 1].updateSeq + 1) break;
    if (total + next.bytes.byteLength > maxBatchBytes) break;
    total += next.bytes.byteLength;
    count += 1;
  }
  let payload = mergeRange(records, start, count);
  while (payload.byteLength > maxBatchBytes && count > 1) {
    count -= 1;
    payload = mergeRange(records, start, count);
  }
  return { payload, count, toSeq: records[start + count - 1].updateSeq };
}

export function createTailPlanner(deps: TailPlannerDeps): TailPlanner {
  const { store, digest, maxBatchBytes } = deps;
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes <= 0) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "tail batch byte budget must be a positive integer" });
  }
  return {
    async next(docId: string, afterSeq: number, limit: number): Promise<TailBatch[]> {
      if (!isNonNegativeInteger(afterSeq)) {
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "tail cursor must be a non-negative integer" });
      }
      if (!isNonNegativeInteger(limit)) {
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "tail batch limit must be a non-negative integer" });
      }
      const batches: TailBatch[] = [];
      let cursor = afterSeq;
      let page: SyncUpdateRecord[] = [];
      let index = 0;
      while (batches.length < limit) {
        if (index >= page.length) {
          page = await store.readUpdatesAfter(docId, cursor, RECORDS_PER_BATCH);
          index = 0;
          if (page.length === 0) break;
        }
        // 每条记录都必须紧接游标，逐条复核而不是只看页首：读侧契约要求「遇缺口即停」，但按
        // `updateSeq > seq` 查询的 SQL adapter 与保留回收都会返回缺口之后的记录，缺口也可能落在页内。
        // 静默跳过等于让客户端永久缺一段内容，而后续批次的 fromSeq/toSeq 仍看似连续（base-plan 同样逐条复核）；
        // 宁可停在这里，由调用方换新 base 补齐。截断后重新读取会拿到同一批越界记录，同样在这一步停住。
        if (page[index].updateSeq !== cursor + 1) break;
        const built = buildBatch(page, index, maxBatchBytes);
        batches.push({
          docId,
          fromSeq: page[index].updateSeq,
          toSeq: built.toSeq,
          payload: built.payload,
          digest: digest(built.payload),
        });
        cursor = built.toSeq;
        index += built.count;
      }
      return batches;
    },

    /**
     * 缺口判定：帧的起始序号必须等于期望序号，否则一律申请补齐。
     * 跳号会留下永久空洞；重复/过期意味着游标被旧帧推进，或该帧来自已废止的 attempt 与异代次
     * （新代次从 1 重新计数）；非整数/负数序号属协议异常，保守判为需要补齐而不是当作正常帧继续。
     * `docId` 只供调用方归因：本签名同步返回、不能读存储，判定因此只用序号，参数保留以对齐协议层调用点。
     */
    detectGap(_docId: string, expectedSeq: number, receivedSeq: number): boolean {
      if (!isNonNegativeInteger(expectedSeq) || !isNonNegativeInteger(receivedSeq)) return true;
      return receivedSeq !== expectedSeq;
    },
  };
}
