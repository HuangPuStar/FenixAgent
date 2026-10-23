// packages/chat-channel/src/sync/live/directory-appender.ts
// 实时轮换对分页目录的维护：内容块封口换新后，把新块 ID 追加到最新目录页；页满时建新页并更新根目录。
//
// 为什么由写者维护：目录 Doc 是客户端发现内容块的权威入口，内容块一旦轮换就必须在同一条写入路径
// 上可见，否则新块永远收不到 SUBSCRIBE。目录更新与内容写入共用同一个写者租约，不引入第二套写权。
//
// 页 Doc 与根目录都通过 `appendUpdates` 追加（不封口、不重建）；页号与 docId 确定性生成，
// 崩溃恢复时从已提交根目录重新加载，不依赖本机缓存。

import * as Y from "yjs";

import type { DigestFn, RandomSource } from "../clock";
import {
  appendDirectoryPageContent,
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  DIRECTORY_PAGE_SIZE,
  directoryPageDocId,
  directoryRootDocId,
  planDirectoryPages,
  readDirectoryPage,
  readDirectoryRoot,
  setDirectoryLatestPageId,
} from "../protocol/directory";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { createBatchId, parseDocId } from "../protocol/identity";
import type { GenerationEntryRefs, ProjectionStore, SyncDocRecord, WriterLease } from "../store/types";
import { captureChange } from "./change-capture";
import { loadCommittedDoc } from "./committed-doc";

export interface DirectoryAppenderOptions {
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly digest: DigestFn;
  readonly random: RandomSource;
}

export interface DirectoryAppender {
  /**
   * 从已提交状态恢复目录读写游标。
   *
   * 根目录缺失时按 `entryRefs.contentDocIds` 自举（旧代次/测试种子没有目录 Doc 的恢复路径）；
   * 根目录存在但页缺失属于真实损坏，直接失败而不是猜测页内容。
   */
  load(lease: WriterLease, generation: string, entryRefs: GenerationEntryRefs): Promise<void>;
  /** 内容块换新后调用：把新块 ID 追加到最新页，必要时滚动到新页。 */
  appendContentDoc(lease: WriterLease, docId: string): Promise<void>;
  /**
   * 最新页末位内容块（实时写入的候选入口）；没有页时为 `null`。
   *
   * 目录页按追加顺序记录内容块，末位即最后轮换出的块；它可能是 active（正常）或已封口
   * （封口后、追加 successor 前崩溃），调用方仍需自行确认可写性。
   */
  tailContentDocId(): string | null;
}

function fail(code: SyncErrorCode, message: string): never {
  throw new SyncProtocolError(code, { message });
}

class DirectoryAppenderImpl implements DirectoryAppender {
  private rootDoc: Y.Doc | null = null;
  private rootDocId: string | null = null;
  private rootLastSeq = 0;
  private pageDoc: Y.Doc | null = null;
  private pageDocId: string | null = null;
  private pageLastSeq = 0;
  private generation: string | null = null;

  constructor(private readonly options: DirectoryAppenderOptions) {}

  async load(lease: WriterLease, generation: string, entryRefs: GenerationEntryRefs): Promise<void> {
    this.generation = generation;
    this.rootDocId = directoryRootDocId(generation);
    const root = await loadCommittedDoc(this.options.store, this.rootDocId);
    if (root === null) {
      await this.provision(lease, generation, entryRefs.contentDocIds);
      return;
    }
    this.rootDoc = root.doc;
    this.rootLastSeq = root.lastSeq;
    const latestPageId = readDirectoryRoot(root.doc).latestPageId;
    if (latestPageId === null) {
      // 空目录（尚无内容块）：首次 append 时再建页。
      this.pageDoc = null;
      this.pageDocId = null;
      this.pageLastSeq = 0;
      return;
    }
    const page = await loadCommittedDoc(this.options.store, latestPageId);
    if (page === null) fail("DOC_NOT_FOUND", `directory page ${latestPageId} has no committed state`);
    this.pageDoc = page.doc;
    this.pageDocId = latestPageId;
    this.pageLastSeq = page.lastSeq;
  }

  tailContentDocId(): string | null {
    if (this.pageDoc === null) return null;
    return readDirectoryPage(this.pageDoc).contentDocIds.at(-1) ?? null;
  }

  async appendContentDoc(lease: WriterLease, docId: string): Promise<void> {
    if (this.generation === null || this.rootDoc === null || this.rootDocId === null) {
      fail("DOC_NOT_FOUND", "directory appender is not loaded");
    }
    if (this.pageDoc === null || this.pageDocId === null) {
      await this.openInitialPage(lease, docId);
      return;
    }
    const state = readDirectoryPage(this.pageDoc);
    if (state.contentDocIds.includes(docId)) return;
    if (state.contentDocIds.length >= DIRECTORY_PAGE_SIZE) {
      await this.rotatePage(lease, docId);
      return;
    }
    const doc = this.pageDoc;
    const update = captureChange(doc, () => {
      appendDirectoryPageContent(doc, docId);
    });
    if (update === null) return;
    await this.append(
      lease,
      [{ docId: this.pageDocId, fromSeq: this.pageLastSeq + 1, bytes: update }],
      [{ docId: this.pageDocId, lastSeq: this.pageLastSeq }],
    );
    this.pageLastSeq += 1;
  }

  /** 根目录存在但还没有页（空代次）：建第 1 页并让根目录指向它。 */
  private async openInitialPage(lease: WriterLease, docId: string): Promise<void> {
    const generation = this.requireGeneration();
    const pageDocId = directoryPageDocId(generation, 1);
    // 同一份字节必须同时用于落库与本地游标：分别编码会得到不同 clientID 的 snapshot，
    // 后续增量在读取方成为悬空 struct，目录更新看似成功却永远不可见。
    const snapshot = buildDirectoryPageSnapshot([docId], null);
    await this.createPageDoc(lease, pageDocId, 1, snapshot);
    await this.pointRootAt(lease, pageDocId);
    this.pageDoc = this.newDocFromSnapshot(pageDocId, snapshot);
    this.pageDocId = pageDocId;
    this.pageLastSeq = 0;
  }

  /** 当前页已满：新建下一页（只含新块），再原子地把根目录指过去。 */
  private async rotatePage(lease: WriterLease, docId: string): Promise<void> {
    const generation = this.requireGeneration();
    const previousPageId = this.pageDocId;
    if (previousPageId === null) fail("DOC_NOT_FOUND", "directory has no current page");
    const nextNumber = parseDocId(previousPageId).blockIndex + 1;
    const pageDocId = directoryPageDocId(generation, nextNumber);
    const snapshot = buildDirectoryPageSnapshot([docId], previousPageId);
    await this.createPageDoc(lease, pageDocId, nextNumber, snapshot);
    await this.pointRootAt(lease, pageDocId);
    this.pageDoc?.destroy();
    this.pageDoc = this.newDocFromSnapshot(pageDocId, snapshot);
    this.pageDocId = pageDocId;
    this.pageLastSeq = 0;
  }

  /** 根目录缺失（历史数据/测试种子）：按入口闭包一次性补齐根与全部页。 */
  private async provision(lease: WriterLease, generation: string, contentDocIds: readonly string[]): Promise<void> {
    const plan = planDirectoryPages(generation, contentDocIds);
    // 每个 Doc 的 canonical 字节只编码一次：落库与本地游标共用同一份 snapshot。
    const rootSnapshot = buildDirectoryRootSnapshot(plan.latestPageId);
    await this.createDoc(lease, plan.rootDocId, "directory", rootSnapshot, null);
    const pageSnapshots = new Map<string, Uint8Array>();
    for (const page of plan.pages) {
      const snapshot = buildDirectoryPageSnapshot(page.contentDocIds, page.previousPageId);
      pageSnapshots.set(page.pageDocId, snapshot);
      await this.createDoc(lease, page.pageDocId, "directory", snapshot, page.pageNumber);
    }
    this.rootDoc = this.newDocFromSnapshot(plan.rootDocId, rootSnapshot);
    this.rootDocId = plan.rootDocId;
    this.rootLastSeq = 0;
    const latest = plan.pages.at(-1);
    const latestSnapshot = latest === undefined ? undefined : pageSnapshots.get(latest.pageDocId);
    if (latest === undefined || latestSnapshot === undefined) {
      this.pageDoc = null;
      this.pageDocId = null;
      this.pageLastSeq = 0;
      return;
    }
    this.pageDoc = this.newDocFromSnapshot(latest.pageDocId, latestSnapshot);
    this.pageDocId = latest.pageDocId;
    this.pageLastSeq = 0;
  }

  private async pointRootAt(lease: WriterLease, pageDocId: string): Promise<void> {
    if (this.rootDoc === null || this.rootDocId === null) fail("DOC_NOT_FOUND", "directory root is not loaded");
    const doc = this.rootDoc;
    const update = captureChange(doc, () => {
      setDirectoryLatestPageId(doc, pageDocId);
    });
    if (update === null) return;
    await this.append(
      lease,
      [{ docId: this.rootDocId, fromSeq: this.rootLastSeq + 1, bytes: update }],
      [{ docId: this.rootDocId, lastSeq: this.rootLastSeq }],
    );
    this.rootLastSeq += 1;
  }

  private async createPageDoc(
    lease: WriterLease,
    docId: string,
    pageNumber: number,
    snapshot: Uint8Array,
  ): Promise<void> {
    await this.createDoc(lease, docId, "directory", snapshot, pageNumber);
  }

  private async createDoc(
    lease: WriterLease,
    docId: string,
    kind: SyncDocRecord["kind"],
    snapshot: Uint8Array,
    blockIndex: number | null,
  ): Promise<void> {
    const record: SyncDocRecord = {
      scopeKey: this.options.scopeKey,
      generation: this.requireGeneration(),
      docId,
      kind,
      state: "active",
      snapshot,
      hash: this.options.digest(snapshot),
      baseSeq: 0,
      finalSeq: null,
      blockIndex,
      ordinalStart: null,
      ordinalEnd: null,
      dependsOn: [],
    };
    const settled = await this.options.store.createDoc({
      scopeKey: this.options.scopeKey,
      epoch: lease.epoch,
      doc: record,
    });
    if (settled.outcome === "conflict") {
      fail("DIGEST_CONFLICT", `directory document ${docId} already holds other bytes`);
    }
    if (settled.outcome === "unknown") {
      fail("COMMIT_OUTCOME_UNKNOWN", `directory document ${docId} outcome is unknown`);
    }
  }

  private async append(
    lease: WriterLease,
    updates: readonly { docId: string; fromSeq: number; bytes: Uint8Array }[],
    frontiers: readonly { docId: string; lastSeq: number }[],
  ): Promise<void> {
    const first = updates[0];
    const digest = this.options.digest(
      updates.length === 1 && first !== undefined ? first.bytes : concatBytes(updates),
    );
    const result = await this.options.store.appendUpdates({
      scopeKey: this.options.scopeKey,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: createBatchId(this.options.random),
      digest,
      expectedFrontiers: frontiers.map((frontier) => ({ ...frontier })),
      updates: updates.map((update) => ({ ...update })),
    });
    if (result.outcome === "conflict") {
      fail("DIGEST_CONFLICT", "directory update conflicts with committed bytes");
    }
    if (result.outcome === "unknown") {
      fail("COMMIT_OUTCOME_UNKNOWN", "directory update outcome is unknown");
    }
  }

  private newDocFromSnapshot(docId: string, snapshot: Uint8Array): Y.Doc {
    const doc = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc, snapshot);
    return doc;
  }

  private requireGeneration(): string {
    if (this.generation === null) fail("DOC_NOT_FOUND", "directory appender has no generation");
    return this.generation;
  }
}

function concatBytes(updates: readonly { bytes: Uint8Array }[]): Uint8Array {
  const total = updates.reduce((sum, update) => sum + update.bytes.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const update of updates) {
    out.set(update.bytes, offset);
    offset += update.bytes.byteLength;
  }
  return out;
}

export function createDirectoryAppender(options: DirectoryAppenderOptions): DirectoryAppender {
  return new DirectoryAppenderImpl(options);
}
