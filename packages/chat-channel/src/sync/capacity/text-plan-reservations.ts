import { DIRECTORY_PAGE_SIZE } from "../protocol/directory";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { MAX_IDENTIFIER_BYTES } from "../protocol/identity";
import type { InputLimits } from "./profile";
import { TEXT_CLAIM_READ_BODY_BYTES, TEXT_CLAIM_READ_MIN_CONTROL_BYTES } from "./text-claim-reservations";

/** Y.Doc、游标和额度对象的固定元数据，正文编码字节不能替代对象数量。 */
export const TEXT_DOCUMENT_METADATA_BYTES = 8192;
const CHUNK_METADATA_BYTES = 64;
// 最小投影包含 scope、generation、四个 Doc、首条账本/引用及封口替换的候选元数据。
// 每行覆盖复合键、至多十六个合法身份和固定字段，二十四行同时在场仍不借正文池。
const MINIMUM_PROJECTION_INDEX_BYTES = 24 * (512 + MAX_IDENTIFIER_BYTES * 16 * 4);

/** 已接纳输入的身份、任务和正文副本必须一直保留到同一窗口确认提交。 */
export function textInputReservations(identityUnits: number, textUnits: number) {
  return { controlIndex: 384 + identityUnits * 4, ingressSpool: 128 + textUnits * 8 };
}

/** 已加载的三个局部 Doc 前沿；历史总索引大小不参与单窗口提交的工作集。 */
export interface TextWorkingState {
  readonly contentLastSeq: number;
  readonly rootLastSeq: number;
  readonly pageLastSeq: number;
  readonly docIdUnits: number;
  readonly claimControlBytes: number;
}

/** 按本批最大分片、后继和目录行计费，覆盖完整 prepare 候选与旧 ledger 临时指针。 */
export function textWorkingControlBytes(input: {
  readonly inputs: InputLimits;
  readonly scopeUnits: number;
  readonly generationUnits: number;
  readonly textBytes: number;
  readonly aheadChunks: number;
  readonly idempotent: boolean;
  readonly state: TextWorkingState;
}): number {
  const { inputs, state, scopeUnits: scope, generationUnits: generation } = input;
  const chunkBytes = Math.max(1, Math.min(inputs.payloadChunkMaxBytes, Math.floor(inputs.activeHardEncodedBytes / 2)));
  const chunks = Math.ceil(input.textBytes / Math.max(1, chunkBytes - 3));
  const docId = Math.min(MAX_IDENTIFIER_BYTES, Math.max(state.docIdUnits, generation + 60));
  const pages = Math.ceil(chunks / DIRECTORY_PAGE_SIZE);
  // JSON 最坏转义放大2倍，再按Store UTF-16/节点放大4倍；10倍还覆盖复合索引键与字段名。
  // 文档固定项包含4.17KiB Bloom、数值/状态/编码上界；旧Doc额外覆盖8个依赖身份。
  const freshDoc = 8192 + 10 * (scope + generation + docId);
  const existingDoc = freshDoc + 8 * inputs.dependsOnMax * MAX_IDENTIFIER_BYTES;
  const update = 1024 + 10 * (scope + docId + MAX_IDENTIFIER_BYTES + 64);
  const route = 512 + 10 * (docId * 2 + scope);
  const ref = 2048 + 10 * (scope + generation + docId + MAX_IDENTIFIER_BYTES + 64);
  const batch = 2048 + 10 * (scope + MAX_IDENTIFIER_BYTES + 64) + (chunks + 2) * (256 + docId * 10);
  const scopeRow = 2048 + 10 * (scope + generation + MAX_IDENTIFIER_BYTES);
  const ledger = 384 + 8 * (state.contentLastSeq + state.rootLastSeq + state.pageLastSeq + input.aheadChunks * 3);
  // 接管期间尾块可能新增legacy身份；一份完整合法Doc的key/Map放大独立于既有缓存再预留。
  const claim = input.idempotent
    ? state.claimControlBytes + TEXT_CLAIM_READ_MIN_CONTROL_BYTES * 2 + 8192 + MAX_DOC_SNAPSHOT_BYTES * 8
    : 0;
  return Math.ceil(
    3 * existingDoc +
      (chunks + pages) * freshDoc +
      (chunks + 2) * update +
      chunks * route +
      ref +
      batch +
      scopeRow +
      ledger +
      claim,
  );
}

/** 与文本切片相同的码点跨边界余量，作为先前排队窗口的 ledger 增长上界。 */
export function textWorkingChunkCount(inputs: InputLimits, textBytes: number): number {
  const chunk = Math.max(1, Math.min(inputs.payloadChunkMaxBytes, Math.floor(inputs.activeHardEncodedBytes / 2)));
  return Math.ceil(textBytes / Math.max(1, chunk - 3));
}

/** 规划前先覆盖文本、切片、旧块与目录编码，旧块仍按传输硬限封口。 */
export function textPlanBaseReservations(inputs: InputLimits, textUnits: number, textBytes: number) {
  const chunkBytes = Math.max(1, Math.min(inputs.payloadChunkMaxBytes, Math.floor(inputs.activeHardEncodedBytes / 2)));
  const chunkCountBound = Math.ceil(textBytes / Math.max(1, chunkBytes - 3));
  return {
    hotDocLive: Math.max(
      1,
      textUnits * 4 +
        textBytes * 6 +
        chunkCountBound * CHUNK_METADATA_BYTES +
        TEXT_DOCUMENT_METADATA_BYTES * 2 +
        MAX_DOC_SNAPSHOT_BYTES * 4 +
        inputs.directoryHardBytes * 2,
    ),
    persistSeal: Math.max(1, textBytes * 4 + MAX_DOC_SNAPSHOT_BYTES * 4 + inputs.directoryHardBytes * 2),
  };
}

/** 首字节写入与其已提交判重都必须可接纳，Store 留存的首条账本与临时资源同时计费。 */
export function minimumTextPlanReservations(inputs: InputLimits) {
  const base = textPlanBaseReservations(inputs, 1, 1);
  // MergeKey 五段各受单标识上限约束；ASCII 的 UTF-16 码元数达到这个最坏值。
  const retainedInput = textInputReservations(MAX_IDENTIFIER_BYTES * 5, 1);
  const working = textWorkingControlBytes({
    inputs,
    scopeUnits: MAX_IDENTIFIER_BYTES * 2 + 1,
    generationUnits: MAX_IDENTIFIER_BYTES,
    textBytes: 1,
    aheadChunks: 0,
    idempotent: true,
    state: {
      contentLastSeq: 0,
      rootLastSeq: 0,
      pageLastSeq: 0,
      docIdUnits: MAX_IDENTIFIER_BYTES,
      claimControlBytes: 0,
    },
  });
  const identityUnits = MAX_IDENTIFIER_BYTES * 3;
  // 规划确认前 Store 已保留首次更新的两份字节，必须覆盖二者同时在场的峰值。
  const retainedFirstUpdateBytes = 2 * (inputs.recordHeaderMaxBytes + 1 + MAX_IDENTIFIER_BYTES + 128);
  return {
    controlIndex:
      MINIMUM_PROJECTION_INDEX_BYTES + TEXT_CLAIM_READ_MIN_CONTROL_BYTES + retainedInput.controlIndex + working,
    ingressSpool: retainedInput.ingressSpool,
    hotDocLive: Math.max(
      TEXT_CLAIM_READ_BODY_BYTES + retainedFirstUpdateBytes,
      base.hotDocLive +
        identityUnits * 2 +
        1024 +
        TEXT_DOCUMENT_METADATA_BYTES +
        MAX_IDENTIFIER_BYTES * 12 +
        retainedFirstUpdateBytes,
    ),
    persistSeal: base.persistSeal + 6 * (512 + identityUnits * 3) + 512 + MAX_IDENTIFIER_BYTES * 12,
  };
}
