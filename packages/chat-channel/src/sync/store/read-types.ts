import type { DocKind, DocState } from "../protocol/identity";

/** 派生索引的查找类别：条目、工具调用与最终描述各自独立定位（设计 §4.4）。 */
export type RefLookupKind = "entry" | "tool" | "final" | "live-object" | "live-text";

/**
 * 某 Doc 在某个应用层序号处的已提交状态：`baseSeq` 是快照自身序号，`lastSeq` 是该处可见的连续前沿。
 *
 * `snapshot` 必须是可独立加载的 canonical 字节，`hash` 与其一致；两者是「已提交」的唯一证据。
 */
export interface DocStateSnapshot {
  docId: string;
  baseSeq: number;
  lastSeq: number;
  snapshot: Uint8Array;
  hash: string;
}

/**
 * 目录分页查询：`afterOrdinal` 是上一页末尾的序号游标（省略表示从最小编号开始），`limit` 为条目上限。
 *
 * 查询不带 `scopeKey`（A 阶段冻结签名）：`generation` 必须来自已鉴权 scope 下的
 * `readScopePointer` / `readGeneration`，禁止把客户端提供的 generation 直接传入。
 */
export interface DirectoryQuery {
  generation: string;
  afterOrdinal?: number;
  limit: number;
}

/**
 * 目录页：只列**已封口**的内容块（当前 active 引用在控制入口中，不进目录），按 `ordinalStart` 升序。
 *
 * `complete` 表示该代次已提交范围连续（`gaps` 为空）；`false` 时调用方不得宣称导入完整。
 * 分页是否取完由 `entries.length < limit` 判定，不由 `complete` 判定。
 */
export interface DirectoryPage {
  entries: {
    docId: string;
    ordinalStart: number;
    ordinalEnd: number;
    hash: string;
    sealed: boolean;
  }[];
  gaps: {
    afterOrdinal: number;
    beforeOrdinal: number;
  }[];
  complete: boolean;
}

/**
 * 引用分页查询：按 `(lookupKind, lookupId)` 定位，`contentSlot` 省略时跨 slot 顺序返回，
 * `afterPartIndex` 为上一页游标。
 *
 * 与 `DirectoryQuery` 同理不带 `scopeKey`：`generation` 必须来自已鉴权 scope 的读取结果。
 */
export interface RefQuery {
  generation: string;
  lookupKind: RefLookupKind;
  lookupId: string;
  contentSlot?: number;
  /** 与 contentSlot 一起给出时按完整定位键查询，不扫描其他引用。 */
  partIndex?: number;
  afterPartIndex?: number;
  limit: number;
}

/** 只查询已鉴权代次权威链中的块；返回值证明块内全部 live 文本身份已有有效持久索引。 */
export interface LiveTextCoverageQuery {
  readonly scopeKey: string;
  readonly generation: string;
  readonly docIds: readonly string[];
}

/** 已提交的文档生命周期与唯一后继；已知无路由与未知文档分别表达。 */
export interface SyncSuccessorState {
  readonly scopeKey: string;
  readonly docId: string;
  readonly generation: string;
  readonly kind: DocKind;
  readonly state: DocState;
  readonly route: { readonly successorDocId: string; readonly expectedLastSeq: number } | null;
}
