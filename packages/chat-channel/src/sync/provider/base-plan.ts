// packages/chat-channel/src/sync/provider/base-plan.ts
// E 阶段 base 规划（设计 §8.4）：在一致读取中取得截止序号 S 与对应已提交状态，产出完整 snapshot 或差分。
//
// 三条不可让渡的规则：
// 1. 状态只由已提交字节拼出（`readDocStateAt` + `readUpdatesAfter`）：设计 §9.3 禁止编码尚未提交的内存 Doc，
//    因此本模块不持有写权、也不读任何运行态 Doc 缓存；写者屏障由调用方在与 LiveWriter 交接处持有。
// 2. 只有调用方已确认「完成过 base + 连续应用」的本地基线（以 `clientStateVector` 传入）才允许差分，
//    且该向量必须被服务端状态 @S 覆盖，否则本地结构无法由服务端字节重建 → 回退完整 snapshot。
// 3. 摘要只覆盖返回的传输字节；本地重新编码的 hash 与 canonical snapshot 的存储 hash 不构成等价证明。
//
// 已知边界（调用方必须遵守）：存储读取出口无法区分「无新内容」与「保留边界已越过锚点」——冻结签名不提供
// 保留边界读取出口。因此对封口 Doc 订阅时必须以 `requestedFromSeq` 指认其可读终态（finalSeq）；否则尾部一旦
// 回收，服务端只能给出基线快照本身，客户端将停在旧序号。请求的 generation / subscriptionEpoch / syncAttemptId
// 不参与本层判定：docId 与代次的归属必须由调用方在订阅前用已鉴权 scope 校验（读取出口按冻结签名不带 scopeKey）。

import * as Y from "yjs";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { DocStateSnapshot, ProjectionStore, SyncUpdateRecord } from "../store/types";

/** base 模式：`full` 是完整 snapshot，`diff` 是从服务端状态 @S 到客户端向量的差分；两者都必须被实际应用。 */
export type BaseMode = "full" | "diff";

export interface BasePlanRequest {
  readonly docId: string;
  readonly generation: string;
  readonly subscriptionEpoch: string;
  readonly syncAttemptId: string;
  readonly clientStateVector?: Uint8Array; // 仅当服务端已确认可信基线
  readonly requestedFromSeq?: number;
}

export interface BasePlan {
  readonly mode: BaseMode;
  readonly docId: string;
  readonly upToSeq: number;
  readonly payload: Uint8Array;
  readonly digest: string;
  readonly encodedLength: number;
  readonly stateVector: Uint8Array;
}

export interface BasePlannerDeps {
  readonly store: ProjectionStore;
  readonly digest: DigestFn;
}

export interface BasePlanner {
  /** 在写入者串行屏障 + 一致存储读取中取得截止序号 S 与已提交状态。 */
  plan(request: BasePlanRequest): Promise<BasePlan | null>;
}

/** 规范基线序号：`createDoc` 只接受 `baseSeq === 0` 的 active 基线，内容块 Doc 的 base/final 同为 0。 */
const CANONICAL_BASE_SEQ = 0;

/** 单次存储读取的记录条数：限制一次往返的返回量，不改变「遇缺口即停」的语义。 */
const BASE_READ_PAGE_RECORDS = 256;

/**
 * 单次 base 拼接的连续 tail 记录上限（不是内容上限）：轮换策略已把单个 Doc 的尾部限制在千级记录内，
 * 该上限只作为请求延迟的硬上界——超出窗口的记录改由 tail 批次继续送达，语义不变。
 */
const MAX_BASE_REPLAY_RECORDS = 4096;

/**
 * 可信基线的 state vector 规模上限：规模与协作者数量（而非文档大小）成正比，4KiB 足以覆盖数百个协作者；
 * 超出即视为异常输入，回退完整 snapshot 比继续解码更省。
 */
const MAX_CLIENT_STATE_VECTOR_BYTES = 4096;

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 取一致读取的锚点：优先调用方指认的起点（封口 Doc 的 finalSeq 等可读状态点），不可读时回退规范基线。
 * `null` 表示该 Doc 未知、已退役或没有任何可读状态——不猜测，由调用方决定换代次或换 Doc。
 */
async function readAnchor(
  store: ProjectionStore,
  docId: string,
  requestedFromSeq: number | undefined,
): Promise<DocStateSnapshot | null> {
  // 起点等于规范基线时只读一次：同一序号的重复读取不会带来新信息，只会多一次存储往返。
  const candidates =
    requestedFromSeq === undefined || requestedFromSeq === CANONICAL_BASE_SEQ
      ? [CANONICAL_BASE_SEQ]
      : [requestedFromSeq, CANONICAL_BASE_SEQ];
  for (const seq of candidates) {
    const state = await store.readDocStateAt(docId, seq);
    if (state !== null) return state;
  }
  return null;
}

/**
 * 读取 `(afterSeq, …]` 上连续的已提交更新，不跳洞、不越过 `maxRecords`。
 * 存储契约已保证「遇缺口即停」，此处仍显式核对序号：SQL adapter 按 `updateSeq > seq` 查询时，保留边界越过
 * 客户端会返回缺口之后的记录，静默拼接会产出一份缺内容的「完整」状态。
 */
async function readContiguousUpdates(
  store: ProjectionStore,
  docId: string,
  afterSeq: number,
  maxRecords: number,
): Promise<SyncUpdateRecord[]> {
  const collected: SyncUpdateRecord[] = [];
  let cursor = afterSeq;
  while (collected.length < maxRecords) {
    const limit = Math.min(BASE_READ_PAGE_RECORDS, maxRecords - collected.length);
    const page = await store.readUpdatesAfter(docId, cursor, limit);
    if (page.length === 0) break;
    for (const record of page) {
      if (record.updateSeq !== cursor + 1) return collected;
      collected.push(record);
      cursor = record.updateSeq;
    }
    // 短页即「后续没有连续记录」（缺口或已到前沿），不再多发一次必然为空的读取。
    if (page.length < limit) break;
  }
  return collected;
}

/**
 * 可信基线判定（设计 §8.4）：客户端向量必须被服务端状态 @S 完全覆盖。
 * 覆盖失败说明本地 Doc 含服务端未知结构（异实例、本地修改）或本地时钟超前（已有未定 apply 落盘），
 * 此时差分无法重建完整副本，只有完整 snapshot 能修复——「废弃副本重走完整 base」。
 * 空向量、非法向量与超限向量一律按「无可信基线」处理而不抛错：SV 只是可选优化提示，
 * 回退完整 snapshot 是本层既定的恢复路径，为它抛错会把一次本可成功的同步变成 ERROR 帧。
 */
function trustedBaselineVector(clientStateVector: Uint8Array | undefined, serverDoc: Y.Doc): Uint8Array | null {
  if (clientStateVector === undefined || clientStateVector.byteLength === 0) return null;
  if (clientStateVector.byteLength > MAX_CLIENT_STATE_VECTOR_BYTES) return null;
  let clientState: Map<number, number>;
  try {
    clientState = Y.decodeStateVector(clientStateVector);
  } catch {
    // 非法编码只能说明该向量不可用，不能说明客户端不可用；诊断交给上层的 attempt 记录。
    return null;
  }
  // 空映射等于「客户端没有任何服务端结构」：不存在可信基线，按完整 snapshot 处理。
  if (clientState.size === 0) return null;
  const serverState = Y.decodeStateVector(Y.encodeStateVector(serverDoc));
  for (const [client, clock] of clientState) {
    const known = serverState.get(client);
    if (!isNonNegativeInteger(clock) || known === undefined || clock > known) return null;
  }
  return clientStateVector;
}

export function createBasePlanner(deps: BasePlannerDeps): BasePlanner {
  const { store, digest } = deps;
  return {
    async plan(request: BasePlanRequest): Promise<BasePlan | null> {
      const { requestedFromSeq } = request;
      if (requestedFromSeq !== undefined && !isNonNegativeInteger(requestedFromSeq)) {
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "requestedFromSeq must be a non-negative integer" });
      }
      const anchor = await readAnchor(store, request.docId, requestedFromSeq);
      if (anchor === null) return null;
      const updates = await readContiguousUpdates(store, request.docId, anchor.lastSeq, MAX_BASE_REPLAY_RECORDS);

      // 服务端状态 @S：canonical 基线快照 + 连续已提交 tail（设计 §9.3 的一致读取路径）。
      // 不要求读取期间冻结提交：出口只暴露已提交边界，拼接又沿连续序号推进，并发提交最多让 S 停在
      // 读取时刻的某个已提交点，S+1 起的 tail 仍能续上——这正是「快照 + 连续 tail」可用的前提。
      const serverDoc = new Y.Doc();
      Y.applyUpdate(serverDoc, anchor.snapshot);
      let upToSeq = anchor.lastSeq;
      for (const record of updates) {
        Y.applyUpdate(serverDoc, record.bytes);
        upToSeq = record.updateSeq;
      }

      const serverUpdate = Y.encodeStateAsUpdate(serverDoc);
      const baseline = trustedBaselineVector(request.clientStateVector, serverDoc);
      // 差分必须由服务端字节算出并原样返回（含 delete-set）；不为「SV 相等」省略一帧。
      // V1 编解码与 canonical 字节同一形态：`encodeStateAsUpdate` / `applyUpdate` / state vector 都是 V1，
      // 换成 V2 变体会让服务端产出的字节与客户端现有 apply 路径不一致。
      const payload = baseline === null ? serverUpdate : Y.diffUpdate(serverUpdate, baseline);
      return {
        mode: baseline === null ? "full" : "diff",
        docId: request.docId,
        upToSeq,
        payload,
        digest: digest(payload),
        encodedLength: payload.byteLength,
        stateVector: Y.encodeStateVector(serverDoc),
      };
    },
  };
}
