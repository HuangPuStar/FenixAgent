import * as Y from "yjs";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { DigestFn } from "../clock";
import {
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  directoryRootDocId,
  planDirectoryPages,
} from "../protocol/directory";
import { SyncProtocolError } from "../protocol/errors";
import type { GenerationEntryRefs, ProjectionStore, SyncDocRecord, WriterLease } from "../store/types";

/** 导入入口文档的组装与目录读取；不持有导入事务或接收状态。 */
export class ImportEntryDocuments {
  constructor(
    private readonly store: ProjectionStore,
    private readonly capacity: SyncCapacityProfile,
    private readonly digest: DigestFn,
  ) {}
  controlDocId(generation: string): string {
    return `sync/control/${generation}/0/control`;
  }

  runtimeDocId(generation: string): string {
    return `sync/runtime/${generation}/0/runtime`;
  }

  /**
   * 已提交目录中的内容块（按 ordinal 升序）。
   *
   * 目录即权威：不从接收列表推断，也不缓存「可能已提交」的块；读取按容量档案的
   * `directoryMaxRefs` 分页，逐页累加直到目录结束，避免大目录只取到第一页就丢掉内容块。
   */
  async readCommittedContentDocIds(attempt: {
    scopeKey: string;
    generation: string;
    lease: WriterLease;
  }): Promise<string[]> {
    const pageSize = this.capacity.inputs.directoryMaxRefs;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: "directory limit must be a positive safe integer",
        safeContext: { generation: attempt.generation },
      });
    }
    const docIds: string[] = [];
    let afterOrdinal: number | undefined;
    for (;;) {
      const page = await this.store.readDirectory({
        generation: attempt.generation,
        afterOrdinal,
        limit: pageSize,
      });
      for (const entry of page.entries) {
        if (entry.sealed) docIds.push(entry.docId);
      }
      if (page.entries.length < pageSize) break;
      const last = page.entries[page.entries.length - 1];
      // 与构建阶段同一防御：游标不前进会让分页循环永不停。
      if (last.ordinalEnd <= (afterOrdinal ?? -1)) {
        throw new SyncProtocolError("MALFORMED_FRAME", {
          message: "directory cursor did not advance",
          safeContext: { generation: attempt.generation, ordinal: last.ordinalEnd },
        });
      }
      afterOrdinal = last.ordinalEnd;
    }
    return docIds;
  }

  /**
   * 创建 MANIFEST 会引用的入口 Doc：控制、运行态、根目录与全部目录页。
   *
   * 导入此前只提交内容块，MANIFEST 的 `directoryDocId` 在 store 中不可读，客户端订阅直接
   * DOC_NOT_FOUND。入口 Doc 必须在 `commitGeneration` 之前落地，否则切换后的代次无法交付。
   * 页 Doc ID 由 generation + 页号确定，重试同内容时 `createDoc` 返回 `already-committed`。
   */
  async createEntryDocuments(
    attempt: { scopeKey: string; generation: string; lease: WriterLease },
    contentDocIds: readonly string[],
  ): Promise<void> {
    // 长时间导入可能已越过初始租约：先用同一租约续期，再执行 createDoc。
    const plan = planDirectoryPages(attempt.generation, contentDocIds);
    const emptySnapshot = Y.encodeStateAsUpdate(new Y.Doc());
    const docs: SyncDocRecord[] = [
      this.entryDocRecord(attempt, this.controlDocId(attempt.generation), "control", emptySnapshot, null),
      this.entryDocRecord(attempt, this.runtimeDocId(attempt.generation), "runtime", emptySnapshot, null),
      this.entryDocRecord(attempt, plan.rootDocId, "directory", buildDirectoryRootSnapshot(plan.latestPageId), null),
      ...plan.pages.map((page) =>
        this.entryDocRecord(
          attempt,
          page.pageDocId,
          "directory",
          buildDirectoryPageSnapshot(page.contentDocIds, page.previousPageId),
          page.pageNumber,
        ),
      ),
    ];
    for (const doc of docs) {
      const created = await this.store.createDoc({ scopeKey: attempt.scopeKey, epoch: attempt.lease.epoch, doc });
      if (created.outcome === "conflict") {
        throw new SyncProtocolError("DIGEST_CONFLICT", {
          message: "import entry document conflicts with committed bytes",
          safeContext: { generation: attempt.generation, docId: doc.docId },
        });
      }
      if (created.outcome === "unknown") {
        throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
          message: "import entry document outcome is unknown",
          safeContext: { generation: attempt.generation, docId: doc.docId },
        });
      }
    }
  }

  entryDocRecord(
    attempt: { scopeKey: string; generation: string; lease: WriterLease },
    docId: string,
    kind: SyncDocRecord["kind"],
    snapshot: Uint8Array,
    blockIndex: number | null,
  ): SyncDocRecord {
    return {
      scopeKey: attempt.scopeKey,
      generation: attempt.generation,
      docId,
      kind,
      state: "active",
      snapshot,
      hash: this.digest(snapshot),
      baseSeq: 0,
      finalSeq: null,
      blockIndex,
      ordinalStart: null,
      ordinalEnd: null,
      dependsOn: [],
    };
  }

  initialEntryClosure(generation: string): GenerationEntryRefs {
    return {
      controlDocId: this.controlDocId(generation),
      directoryDocId: directoryRootDocId(generation),
      runtimeDocId: this.runtimeDocId(generation),
      contentDocIds: [],
    };
  }
}
