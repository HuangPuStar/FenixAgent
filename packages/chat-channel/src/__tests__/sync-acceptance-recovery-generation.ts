import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { buildDocId, parseDocId } from "../sync/protocol/identity";
import type { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, WriterLease } from "../sync/store/types";

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
        blockIndex: entry.kind === "content" ? parseDocId(entry.docId).blockIndex : null,
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
