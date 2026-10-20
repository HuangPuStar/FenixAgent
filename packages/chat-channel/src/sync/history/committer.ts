// packages/chat-channel/src/sync/history/committer.ts
// C2 create-if-absent 提交与已提交目录（规格 §5.6，设计 §4.4 / §5.2 第 4 条）。
//
// 本类只有两条不可动摇的规则：
// 1. 已提交字节是唯一权威。`docId + hash` 是幂等键，命中既有提交时本类**只读回并校验**，
//    绝不覆盖已提交字节：与已提交内容竞争的重建物一律丢弃（设计 §5.2 第 4 条）。
//    冲突时返回的 ref 描述的是**既有**块，而不是本次重建物——两者可能覆盖不同的 ordinal 区间。
// 2. 「已提交」只能由存储回答。本类不缓存目录、不自报连续：目录条目、缺口与连续性都来自
//    `readDirectory` 的已提交视图，一次调用取一份快照返回，不合并多次读取的结果。
//
// 本类不判断「是否覆盖到 importEndOrdinal」：它只看存储给出的连续性。把「目录内部连续」当成
// 「导入完整」会把半截历史说成完整历史，终点比对属 `HistoryImportService.finalize` 的职责。

import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { CommitOutcome, DirectoryPage, ProjectionStore, SyncDocRecord, WriterLease } from "../store/types";
import type { BuiltBlock } from "./block-builder";

/**
 * 已提交内容块的引用：读取方据此定位块、校验摘要并按 ordinal 范围推进游标。
 *
 * 不含 `sealed` 字段：只有已封口的块才允许进入这里（未封口条目在 `listDirectory` 被排除，
 * 在冲突读回路径上被视作「不可复用」）。也不含 snapshot：正文按需经存储的读取出口取。
 */
export interface CommittedBlockRef {
  docId: string;
  blockIndex: number;
  ordinalStart: number;
  ordinalEnd: number;
  hash: string;
}

/** 已提交目录中的一段缺口：`afterOrdinal` 与 `beforeOrdinal` 之间的序号（不含两端）尚无块覆盖。 */
export interface OrdinalGap {
  afterOrdinal: number;
  beforeOrdinal: number;
}

/** 目录页中的一条条目；形状直接取自存储契约，避免两处各写一份结构后悄悄漂移。 */
type DirectoryEntry = DirectoryPage["entries"][number];

/**
 * 内容块的应用层序号：块是「一次写入、不可追加」的整块 canonical 快照，没有已应用的增量更新，
 * 因此 `baseSeq` / `finalSeq` 同为 0，冲突读回的定位位置也用同一取值。
 */
const CONTENT_BLOCK_SEQ = 0;

/** 冲突读回时目录扫描的分页大小：与单次读取的响应预算同量级，不一次拉全目录。 */
const DIRECTORY_SCAN_PAGE_SIZE = 256;

/**
 * 目录扫描的条目上限（等于 `inputs.directoryMaxRefs` 的 2048，构造参数不含容量配置故在此定常量）。
 *
 * 上限的作用是让冲突读回**有界**：找不到既有条目时立刻失败并交给调用方重读边界，
 * 而不是随目录增长无限翻页（无界扫描本身就是负载）。
 */
const DIRECTORY_SCAN_MAX_ENTRIES = 2048;

/** 提交范围必须是非负安全整数：序号失真会让缺口判定给出错误结论。 */
function assertOrdinal(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      message: `content block ${field} must be a non-negative integer`,
    });
  }
}

/** 比较两个块引用：`ordinalStart` 升序，平手时用 blockIndex、docId 兜底以保持输出确定性。 */
function compareBlockRefs(left: CommittedBlockRef, right: CommittedBlockRef): number {
  if (left.ordinalStart !== right.ordinalStart) {
    return left.ordinalStart - right.ordinalStart;
  }
  if (left.blockIndex !== right.blockIndex) {
    return left.blockIndex - right.blockIndex;
  }
  return left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0;
}

/**
 * 历史导入的提交器：把构建好的内容块提交到投影存储，并回答「已提交目录现在是什么」。
 *
 * 一次导入（一个 generation + 一份 writer 租约）对应一个实例；实例不持有可变状态，
 * 因此并发提交多个块不需要额外同步——去重与竞态都由存储的 create-if-absent 承担。
 */
export class HistoryCommitter {
  private readonly store: ProjectionStore;
  private readonly scopeKey: string;
  private readonly generation: string;
  private readonly lease: WriterLease;
  private readonly digest: DigestFn;

  constructor(deps: {
    store: ProjectionStore;
    scopeKey: string;
    generation: string;
    lease: WriterLease;
    digest: DigestFn;
  }) {
    // 别的 scope 的租约不得用于本 scope：epoch 的 fencing 语义只在同一 scope 行内有意义，
    // 拿错租约写下去等于绕开单写者约束（跨租户写入的直接来源），因此在构造期就拒绝。
    if (deps.lease.scopeKey !== deps.scopeKey) {
      throw new SyncProtocolError("WRITER_EPOCH_LOST", {
        message: "commit lease belongs to another scope",
        safeContext: { scope: deps.scopeKey },
      });
    }
    this.store = deps.store;
    this.scopeKey = deps.scopeKey;
    this.generation = deps.generation;
    this.lease = deps.lease;
    this.digest = deps.digest;
  }

  /**
   * 提交一个内容块（create-if-absent）。四种结局的处理：
   *
   * - `committed`：本次首次落地，返回重建物描述的 ref；
   * - `already-committed` / `conflict`：读回既有 canonical 字节并校验摘要，返回既有块的 ref，
   *   本次重建物丢弃（冲突块不得进入可用目录）；
   * - `unknown`：只有「读回字节与本次摘要一致」这一种收敛方式。异摘要不是冲突而是真的未知，
   *   抛 `COMMIT_OUTCOME_UNKNOWN`，由调用方按同幂等键重试或重读已提交边界——禁止猜成功或回滚。
   */
  async commitBlock(block: BuiltBlock): Promise<{ ref: CommittedBlockRef; outcome: CommitOutcome }> {
    const rebuilt = this.assertBlock(block);
    const doc: SyncDocRecord = {
      scopeKey: this.scopeKey,
      generation: this.generation,
      docId: block.docId,
      kind: "content",
      state: "sealed",
      snapshot: block.snapshot,
      hash: block.hash,
      baseSeq: CONTENT_BLOCK_SEQ,
      finalSeq: CONTENT_BLOCK_SEQ,
      blockIndex: block.blockIndex,
      ordinalStart: block.ordinalStart,
      ordinalEnd: block.ordinalEnd,
      // 复制一份：调用方后续改动自己的数组不得改变已提交记录的依赖集合。
      dependsOn: [...block.dependsOn],
    };
    const settled = await this.store.putSealedIfAbsent({ scopeKey: this.scopeKey, epoch: this.lease.epoch, doc });

    if (settled.outcome === "committed") {
      if (settled.hash !== block.hash) {
        // 存储声称本次写入落地却报出别的摘要：无法确认写进去的是不是这份字节，不能当作成功。
        throw this.digestConflict(block.docId, "store reported a different digest for the block it just wrote");
      }
      return { ref: rebuilt, outcome: "committed" };
    }

    const existing = await this.readCommittedBlock(block.docId);
    if (settled.outcome === "unknown") {
      if (existing !== null && existing.hash === block.hash) {
        return { ref: existing.ref, outcome: "already-committed" };
      }
      throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
        message: "sealed block write outcome is unknown, retry with the same docId and hash",
        safeContext: { generation: this.generation, docId: block.docId },
      });
    }
    if (existing === null) {
      // 存储说该 docId 已有异摘要提交，但已提交目录里没有它：既描述不了既有块，也不允许覆盖。
      throw new SyncProtocolError("IMPORT_INCOMPLETE", {
        message: "committed block conflicts with this rebuild but is missing from the committed directory",
        safeContext: { generation: this.generation, docId: block.docId },
      });
    }
    if (existing.hash !== settled.hash) {
      // 存储自报的既有摘要与它读回的字节不符：两处证据矛盾时不得选一个信，只能报冲突交给上层重读。
      throw this.digestConflict(block.docId, "store reported a different digest than the committed bytes it returns");
    }
    return { ref: existing.ref, outcome: settled.outcome };
  }

  /**
   * 已提交目录：按 `ordinalStart` 升序的块引用 + 缺口 + 是否连续。
   *
   * `limit` 只截断条目，不影响 `gaps` / `complete`——它们是整个代次已提交范围的性质，而不是这一页的
   * 性质（分页未取完用 `blocks.length < limit` 判断）。排序在本方法内重做一次：目录顺序是存储的实现
   * 细节，本类的输出契约要求升序，任何 adapter 都得满足。
   *
   * `afterOrdinal` 缺省时从目录起点读取；调用方按上一页最后一个 `ordinalEnd` 推进即可覆盖全部内容块。
   */
  async listDirectory(
    limit: number,
    afterOrdinal?: number,
  ): Promise<{ blocks: CommittedBlockRef[]; gaps: OrdinalGap[]; complete: boolean }> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: "directory limit must be a positive safe integer",
        safeContext: { generation: this.generation },
      });
    }
    const page = await this.store.readDirectory({ generation: this.generation, afterOrdinal, limit });
    const blocks = page.entries
      // 未封口条目不进目录输出：它的字节仍在被写入，宣称成已提交块会让导入方按残缺范围收尾。
      .filter((entry) => entry.sealed)
      .map((entry) => this.toRef(entry))
      .sort(compareBlockRefs);
    const gaps = page.gaps
      .map((gap) => ({ afterOrdinal: gap.afterOrdinal, beforeOrdinal: gap.beforeOrdinal }))
      .sort((left, right) => left.afterOrdinal - right.afterOrdinal);
    return { blocks, gaps, complete: page.complete };
  }

  /**
   * 写入前的自洽校验，并给出按重建物描述的 ref。
   *
   * 摘要必须能被自己的字节复算出来：`docId + hash` 是幂等键，一旦写入一份「摘要与字节不符」的记录，
   * 该 docId 之后永远无法被正确校验（每次读回都报摘要冲突），属不可修复的污染。同理，docId 的
   * 谱系（kind / generation / blockIndex）与提交范围都在这里对齐，避免把块写进别的代次或别的块位。
   */
  private assertBlock(block: BuiltBlock): CommittedBlockRef {
    const parts = parseDocId(block.docId);
    if (parts.kind !== "content") {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: 'content block docId must carry kind "content"',
        safeContext: { docId: block.docId },
      });
    }
    if (parts.generation !== this.generation || block.generation !== this.generation) {
      throw new SyncProtocolError("GENERATION_MISMATCH", {
        message: `content block generation does not match the committing generation "${this.generation}"`,
        safeContext: { generation: this.generation, docId: block.docId },
      });
    }
    if (parts.blockIndex !== block.blockIndex) {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: "content block docId blockIndex does not match block.blockIndex",
        safeContext: { docId: block.docId },
      });
    }
    assertOrdinal(block.ordinalStart, "ordinalStart");
    assertOrdinal(block.ordinalEnd, "ordinalEnd");
    if (block.ordinalEnd < block.ordinalStart) {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: "content block ordinalEnd must not precede ordinalStart",
        safeContext: { generation: this.generation, docId: block.docId, ordinal: block.ordinalStart },
      });
    }
    if (this.digest(block.snapshot) !== block.hash) {
      throw this.digestConflict(block.docId, "content block hash does not match its canonical bytes");
    }
    return {
      docId: block.docId,
      blockIndex: block.blockIndex,
      ordinalStart: block.ordinalStart,
      ordinalEnd: block.ordinalEnd,
      hash: block.hash,
    };
  }

  /**
   * 读回某 docId 的已提交块：字节来自 `readDocStateAt`，ordinal 范围与摘要来自已提交目录。
   *
   * 三处摘要必须彼此相等——目录条目、存储自报的 doc 摘要、以及对读回字节复算的摘要。这是
   * 「返回的就是存储里那份字节」的唯一证据；任一处不符都抛 `DIGEST_CONFLICT`，绝不返回一个
   * 无法自证的块。返回 `null` 表示该 docId 当前没有可复用的已提交块（无 doc 状态、或目录里
   * 没有已封口条目），由调用方区分严重程度。
   */
  private async readCommittedBlock(docId: string): Promise<{ ref: CommittedBlockRef; hash: string } | null> {
    const state = await this.store.readDocStateAt(docId, CONTENT_BLOCK_SEQ);
    if (state === null) {
      return null;
    }
    const actualHash = this.digest(state.snapshot);
    if (state.hash !== actualHash) {
      throw this.digestConflict(docId, "committed doc digest does not match the bytes it stores");
    }
    const entry = await this.findDirectoryEntry(docId);
    if (entry === null || !entry.sealed) {
      // 未封口条目说明该块字节仍在被写入，不能充当可复用的 canonical 块。
      return null;
    }
    if (entry.hash !== actualHash) {
      throw this.digestConflict(docId, "directory entry digest does not match the committed bytes");
    }
    return {
      ref: {
        docId,
        blockIndex: parseDocId(docId).blockIndex,
        ordinalStart: entry.ordinalStart,
        ordinalEnd: entry.ordinalEnd,
        hash: actualHash,
      },
      hash: actualHash,
    };
  }

  /**
   * 按 docId 在已提交目录里定位条目。
   *
   * 目录没有按 docId 的定位出口（`locateRefs` 找的是逻辑对象索引，不是块目录），只能按 ordinal 游标
   * 顺序翻页；`DIRECTORY_SCAN_MAX_ENTRIES` 保证这次查找有界，找不到即返回 `null` 让调用方重读边界。
   */
  private async findDirectoryEntry(docId: string): Promise<DirectoryEntry | null> {
    let afterOrdinal: number | undefined;
    let scanned = 0;
    while (scanned < DIRECTORY_SCAN_MAX_ENTRIES) {
      const page = await this.store.readDirectory({
        generation: this.generation,
        afterOrdinal: afterOrdinal,
        limit: DIRECTORY_SCAN_PAGE_SIZE,
      });
      const found = page.entries.find((entry) => entry.docId === docId);
      if (found !== undefined) {
        return found;
      }
      scanned += page.entries.length;
      const last = page.entries[page.entries.length - 1];
      if (last === undefined || page.entries.length < DIRECTORY_SCAN_PAGE_SIZE) {
        return null;
      }
      afterOrdinal = last.ordinalEnd;
    }
    return null;
  }

  /** 目录条目 → 块引用：blockIndex 只能从 docId 解析（目录条目不带该字段）。 */
  private toRef(entry: DirectoryEntry): CommittedBlockRef {
    return {
      docId: entry.docId,
      blockIndex: parseDocId(entry.docId).blockIndex,
      ordinalStart: entry.ordinalStart,
      ordinalEnd: entry.ordinalEnd,
      hash: entry.hash,
    };
  }

  private digestConflict(docId: string, message: string): SyncProtocolError {
    return new SyncProtocolError("DIGEST_CONFLICT", {
      message: `content block commit: ${message}`,
      safeContext: { generation: this.generation, docId },
    });
  }
}
