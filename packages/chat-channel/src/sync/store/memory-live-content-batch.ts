import * as Y from "yjs";
import { contentDocOverflow, contentRecordIds } from "../capacity/content-doc-limits";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn } from "../clock";
import {
  DIRECTORY_PAGE_SIZE,
  type DirectoryPageState,
  directoryRootDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../protocol/directory";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { parseDocId } from "../protocol/identity";
import type { CommitContentBatchInput } from "./live-content-batch-types";
import { type AccountedArrayMap, type AccountedMap, commitAccountedSets } from "./memory-accounting";
import { prepareActiveDocument } from "./memory-store-documents";
import { compositeKey, copyBytes, copyRef, fail, type StoredDoc } from "./memory-store-state";
import type {
  AppendUpdatesResult,
  DocFrontier,
  SyncGenerationRecord,
  SyncRefRecord,
  SyncScopeRow,
  SyncUpdateRecord,
} from "./types";

type BatchRecord = { digest: string; frontiers: DocFrontier[] };
type Route = { successorDocId: string; expectedLastSeq: number };
type DocPreimage = { readonly doc: StoredDoc; readonly lastSeq: number };
/** 原子正文提交仅访问既有行集合，不提供通用事务或外部状态句柄。 */
export interface MemoryContentBatchState {
  readonly scopes: AccountedMap<string, SyncScopeRow>;
  readonly generations: ReadonlyMap<string, SyncGenerationRecord>;
  readonly docs: AccountedMap<string, StoredDoc>;
  readonly updates: AccountedArrayMap<string, SyncUpdateRecord>;
  readonly refs: AccountedMap<string, SyncRefRecord>;
  readonly batches: AccountedMap<string, BatchRecord>;
  readonly successors: AccountedMap<string, Route>;
}

/** 提交前复核租约及代次，额度申请重入也不能使失效写者发布。 */
function currentScope(input: CommitContentBatchInput, state: MemoryContentBatchState, clock: Clock): SyncScopeRow {
  const scope = state.scopes.get(input.scopeKey);
  if (!scope || scope.writerEpoch !== input.epoch || scope.writerOwner !== input.owner)
    fail("WRITER_EPOCH_LOST", "content batch writer is fenced");
  if (scope.leaseExpiresAt <= clock.now()) fail("LEASE_EXPIRED", "content batch writer lease expired");
  if (
    scope.currentGeneration !== input.generation ||
    state.generations.get(compositeKey(input.scopeKey, input.generation))?.state !== "committed"
  )
    fail("GENERATION_MISMATCH", "content batch generation is not current");
  return scope;
}

/** 只重放本次触及的 Doc；现存 base 与 ledger 字节保持共享。 */
function projection(
  doc: StoredDoc,
  prior: readonly SyncUpdateRecord[],
  added: readonly SyncUpdateRecord[],
  beforeAdd?: (doc: Y.Doc) => void,
): Y.Doc {
  const value = new Y.Doc({ guid: doc.docId });
  try {
    Y.applyUpdate(value, doc.baseSnapshot);
    for (const update of prior) Y.applyUpdate(value, update.bytes);
    beforeAdd?.(value);
    for (const update of added) Y.applyUpdate(value, update.bytes);
    return value;
  } catch (error) {
    value.destroy();
    throw error;
  }
}

/** 内容链必须从现有活跃尾块开始，且仅将末块保留为 active。 */
function validateChain(
  input: CommitContentBatchInput,
  docs: ReadonlyMap<string, StoredDoc>,
  newIds: ReadonlySet<string>,
): string {
  const content = [...docs.values()].filter((doc) => doc.kind === "content");
  const chain =
    input.seals.length === 0
      ? content.map((doc) => doc.docId)
      : [input.seals[0].docId, ...input.seals.map((seal) => seal.successorDocId)];
  if (
    chain.length === 0 ||
    (input.seals.length === 0 && chain.length !== 1) ||
    new Set(chain).size !== chain.length ||
    chain.length !== content.length
  )
    fail("MALFORMED_FRAME", "content batch must describe one content chain");
  for (const [index, docId] of chain.entries()) {
    const doc = docs.get(docId);
    if (doc?.kind !== "content" || (index === 0 ? newIds.has(docId) : !newIds.has(docId)))
      fail("MALFORMED_FRAME", "content batch chain does not start at its existing tail");
    const previous = index === 0 ? undefined : docs.get(chain[index - 1]);
    if (previous && doc.blockIndex !== previous.blockIndex! + 1)
      fail("MALFORMED_FRAME", "content batch block indexes are not adjacent");
    if (index < input.seals.length && input.seals[index].docId !== docId)
      fail("MALFORMED_FRAME", "content seals are not in chain order");
  }
  return chain[0];
}

/** 目录读前像也参与最终 CAS，单块追加不能依赖已被其他提交替换的尾块证明。 */
function observeDirectoryDoc(
  input: CommitContentBatchInput,
  state: MemoryContentBatchState,
  id: string,
  preimages: Map<string, DocPreimage>,
): StoredDoc {
  const doc = state.docs.get(compositeKey(input.scopeKey, id));
  if (doc?.kind !== "directory" || doc.scopeKey !== input.scopeKey || doc.generation !== input.generation)
    fail("DOC_NOT_FOUND", "content batch committed directory is unavailable");
  if (doc.state !== "active") fail("RESOURCE_RETIRED", "content batch directory is not active");
  const before = preimages.get(id);
  if (before && (before.doc !== doc || before.lastSeq !== doc.lastSeq))
    fail("SEQUENCE_GAP", "content batch directory changed while planning");
  preimages.set(id, { doc, lastSeq: doc.lastSeq });
  return doc;
}

/** 只检查旧根、旧尾页与本次新页，确保整条新内容链确实从目录入口可达。 */
function validateDirectory(
  input: CommitContentBatchInput,
  state: MemoryContentBatchState,
  docs: ReadonlyMap<string, StoredDoc>,
  pages: ReadonlyMap<string, DirectoryPageState>,
  newIds: ReadonlySet<string>,
  latestPage: string | null | undefined,
  headId: string,
  preimages: Map<string, DocPreimage>,
): void {
  const rootId = directoryRootDocId(input.generation);
  const root = observeDirectoryDoc(input, state, rootId, preimages);
  const oldRoot = projection(root, state.updates.get(compositeKey(input.scopeKey, rootId)) ?? [], []);
  let oldLatest: string | null;
  try {
    oldLatest = readDirectoryRoot(oldRoot).latestPageId;
  } finally {
    oldRoot.destroy();
  }
  const newPages = new Set([...newIds].filter((id) => docs.get(id)!.kind === "directory"));
  let pageId = latestPage === undefined ? oldLatest : latestPage;
  const appendedPages: DirectoryPageState[] = [];
  while (pageId !== oldLatest) {
    if (pageId === null || !newPages.delete(pageId))
      fail("MALFORMED_FRAME", "new directory pages are not linked to the current tail");
    const page = pages.get(pageId);
    if (!page) fail("MALFORMED_FRAME", "new directory page is missing its final state");
    if (page.contentDocIds.length === 0) fail("MALFORMED_FRAME", "new directory page cannot be empty");
    appendedPages.push(page);
    pageId = page.previousPageId;
  }
  if (newPages.size > 0) fail("MALFORMED_FRAME", "new directory page is unreachable from the root");
  let appended: readonly string[] = [];
  let committedTail: string | undefined;
  let emptyDirectory = oldLatest === null;
  if (oldLatest !== null) {
    const oldPage = observeDirectoryDoc(input, state, oldLatest, preimages);
    const value = projection(oldPage, state.updates.get(compositeKey(input.scopeKey, oldLatest)) ?? [], []);
    try {
      const before = readDirectoryPage(value);
      committedTail = before.contentDocIds.at(-1);
      emptyDirectory = before.contentDocIds.length === 0 && before.previousPageId === null;
      const after = pages.get(oldLatest) ?? before;
      if (
        before.previousPageId !== after.previousPageId ||
        before.contentDocIds.some((id, index) => after.contentDocIds[index] !== id)
      )
        fail("MALFORMED_FRAME", "content batch changes committed directory entries");
      appended = after.contentDocIds.slice(before.contentDocIds.length);
    } finally {
      value.destroy();
    }
  }
  if (committedTail === undefined) {
    const generation = state.generations.get(compositeKey(input.scopeKey, input.generation));
    if (
      !emptyDirectory ||
      !generation ||
      (generation.importEndOrdinal ?? 0) > 0 ||
      generation.entryRefs.contentDocIds.length === 0
    )
      fail("MALFORMED_FRAME", "empty directory has no initial content entry");
    committedTail = generation.entryRefs.contentDocIds.at(-1);
  }
  if (headId !== committedTail) fail("MALFORMED_FRAME", "content batch does not start at the committed directory tail");
  for (const id of pages.keys())
    if (id !== oldLatest && !newIds.has(id))
      fail("MALFORMED_FRAME", "content batch updates a historical directory page");
  const actual = [...appended, ...appendedPages.reverse().flatMap((page) => page.contentDocIds)];
  const expected = input.seals.map((seal) => seal.successorDocId);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
    fail("MALFORMED_FRAME", "content batch directory does not publish the whole content chain");
}

/** 一次准备全部新增额度，然后以同步提交段发布整条正文链。 */
export function commitMemoryContentBatch(
  raw: CommitContentBatchInput,
  state: MemoryContentBatchState,
  deps: { readonly clock: Clock; readonly digest: DigestFn; readonly capacity: SyncCapacityProfile },
): AppendUpdatesResult {
  const input: CommitContentBatchInput = {
    ...raw,
    expectedFrontiers: raw.expectedFrontiers.map((v) => ({ ...v })),
    updates: raw.updates.map((v) => ({ ...v })),
    newDocs: raw.newDocs.map((v) => ({ ...v })),
    seals: raw.seals.map((v) => ({ ...v })),
    refs: raw.refs?.map(copyRef),
  };
  const scope = currentScope(input, state, deps.clock);
  const batchKey = compositeKey(input.scopeKey, input.batchId);
  const priorBatch = state.batches.get(batchKey);
  if (priorBatch)
    return priorBatch.digest === input.digest
      ? { outcome: "already-committed", frontiers: priorBatch.frontiers.map((value) => ({ ...value })) }
      : { outcome: "conflict", frontiers: [] };
  if (scope.pointerRevision !== input.expectedPointerRevision) return { outcome: "conflict", frontiers: [] };
  const docs = new Map<string, StoredDoc>();
  const preimages = new Map<string, DocPreimage>();
  const newIds = new Set<string>();
  for (const doc of input.newDocs) {
    if (newIds.has(doc.docId)) fail("MALFORMED_FRAME", "duplicate new content batch document");
    newIds.add(doc.docId);
    docs.set(doc.docId, prepareActiveDocument(doc, deps.digest, deps.capacity.inputs.dependsOnMax));
  }
  // 裸 docId 是冻结读取契约的身份：一次检查全部新增 ID，避免逐块重复扫描历史。
  if (newIds.size > 0)
    for (const doc of state.docs.values()) if (newIds.has(doc.docId)) return { outcome: "conflict", frontiers: [] };
  const expected = new Map(input.expectedFrontiers.map((value) => [value.docId, value.lastSeq]));
  if (expected.size !== input.expectedFrontiers.length) fail("MALFORMED_FRAME", "duplicate document frontier");
  const additions = new Map<string, SyncUpdateRecord[]>();
  for (const update of input.updates) {
    if (!expected.has(update.docId)) fail("SEQUENCE_GAP", "content batch is missing a frontier");
    const list = additions.get(update.docId) ?? [];
    list.push({
      scopeKey: input.scopeKey,
      generation: input.generation,
      docId: update.docId,
      updateSeq: update.fromSeq,
      bytes: update.bytes,
      batchId: input.batchId,
      digest: input.digest,
    });
    additions.set(update.docId, list);
  }
  const touched = new Set([...expected.keys(), ...input.seals.map((seal) => seal.docId), ...newIds]);
  for (const id of touched) {
    const doc = docs.get(id) ?? state.docs.get(compositeKey(input.scopeKey, id));
    if (!doc) fail("DOC_NOT_FOUND", "content batch document is unknown");
    const identity = parseDocId(id);
    if (
      doc.scopeKey !== input.scopeKey ||
      doc.generation !== input.generation ||
      identity.generation !== input.generation ||
      identity.kind !== doc.kind ||
      (doc.kind !== "content" && doc.kind !== "directory")
    )
      fail("GENERATION_MISMATCH", "content batch document identity differs");
    if (doc.state !== "active") fail("RESOURCE_RETIRED", "content batch document is not active");
    if ((doc.kind === "content" || identity.blockIndex > 0) && doc.blockIndex !== identity.blockIndex)
      fail("MALFORMED_FRAME", "content batch document block index differs from its identity");
    docs.set(id, doc);
    if (!newIds.has(id)) preimages.set(id, { doc, lastSeq: doc.lastSeq });
    const list = additions.get(id) ?? [];
    if (expected.has(id) && expected.get(id) !== doc.lastSeq) fail("SEQUENCE_GAP", "content batch frontier is stale");
    for (const [index, update] of list.entries())
      if (update.updateSeq !== doc.lastSeq + index + 1) fail("SEQUENCE_GAP", "content batch updates are not adjacent");
    if (
      newIds.has(id) &&
      doc.kind === "content" &&
      (list.length === 0 || doc.baseSnapshot.length !== 2 || doc.baseSnapshot[0] !== 0 || doc.baseSnapshot[1] !== 0)
    )
      fail("MALFORMED_FRAME", "new content block requires an empty base and contiguous updates");
  }
  const headId = validateChain(input, docs, newIds);
  const seals = new Map(input.seals.map((seal) => [seal.docId, seal]));
  if (seals.size !== input.seals.length) fail("MALFORMED_FRAME", "duplicate content seal");
  for (const seal of input.seals) {
    if (!expected.has(seal.docId)) fail("SEQUENCE_GAP", "content seal is missing its expected frontier");
    const route = state.successors.get(compositeKey(input.scopeKey, seal.docId));
    if (route) return { outcome: "conflict", frontiers: [] };
  }
  const frontiers: DocFrontier[] = [];
  const directoryPages = new Map<string, DirectoryPageState>();
  let latestPage: string | null | undefined;
  const finalDocs = new Map<string, StoredDoc>();
  const writtenRecords = new Map<string, ReadonlySet<string>>();
  for (const [id, doc] of docs) {
    const key = compositeKey(input.scopeKey, id);
    const list = additions.get(id) ?? [];
    const lastSeq = doc.lastSeq + list.length;
    let beforeRecords: ReadonlySet<string> = new Set();
    const checkRefs = (input.refs ?? []).some((ref) => ref.docId === id);
    const value = projection(
      doc,
      newIds.has(id) ? [] : (state.updates.get(key) ?? []),
      list,
      checkRefs
        ? (value) => {
            beforeRecords = contentRecordIds(value);
          }
        : undefined,
    );
    try {
      const snapshot = Y.encodeStateAsUpdate(value);
      if (doc.kind === "content" && list.length > 0) {
        const overflow = contentDocOverflow({
          doc: value,
          capacity: deps.capacity,
          lastSeq,
          baseSeq: doc.baseSeq,
          snapshot,
        });
        if (overflow) fail("CAPACITY_EXCEEDED", overflow);
      } else if (
        snapshot.byteLength >
        (doc.kind === "directory"
          ? Math.min(MAX_DOC_SNAPSHOT_BYTES, deps.capacity.inputs.directoryHardBytes)
          : MAX_DOC_SNAPSHOT_BYTES)
      )
        fail("CAPACITY_EXCEEDED", "content batch snapshot exceeds transport limit");
      if (checkRefs)
        writtenRecords.set(
          id,
          new Set([...contentRecordIds(value)].filter((recordId) => !beforeRecords.has(recordId))),
        );
      if (doc.kind === "directory" && parseDocId(id).blockIndex > 0) {
        const page = readDirectoryPage(value);
        if (page.contentDocIds.length > DIRECTORY_PAGE_SIZE)
          fail("CAPACITY_EXCEEDED", "directory page exceeds capacity");
        directoryPages.set(id, page);
      }
      if (doc.kind === "directory" && parseDocId(id).blockIndex === 0) {
        if (id !== directoryRootDocId(input.generation)) fail("MALFORMED_FRAME", "directory root identity differs");
        latestPage = readDirectoryRoot(value).latestPageId;
      }
      const seal = seals.get(id);
      if (seal && seal.finalSeq !== lastSeq) fail("SEQUENCE_GAP", "content seal differs from the batch frontier");
      if (seal && (deps.digest(snapshot) !== seal.finalHash || deps.digest(seal.finalSnapshot) !== seal.finalHash))
        fail("DIGEST_CONFLICT", "content seal differs from batch frontier");
      finalDocs.set(
        id,
        seal
          ? {
              ...doc,
              lastSeq,
              state: "sealed",
              finalSeq: lastSeq,
              snapshot: seal.finalSnapshot,
              hash: seal.finalHash,
              sealedAt: deps.clock.now(),
            }
          : { ...doc, lastSeq },
      );
      if (expected.has(id)) frontiers.push({ docId: id, lastSeq });
    } finally {
      value.destroy();
    }
  }
  validateDirectory(input, state, docs, directoryPages, newIds, latestPage, headId, preimages);
  const routePreimages = new Map(
    [...preimages.keys()].map((id) => [id, state.successors.get(compositeKey(input.scopeKey, id))]),
  );
  const refs = (input.refs ?? []).map((ref) => {
    if (ref.scopeKey !== input.scopeKey || ref.generation !== input.generation || !docs.has(ref.docId))
      fail("DOC_NOT_FOUND", "content batch reference target differs");
    if (docs.get(ref.docId)?.kind !== "content" || !writtenRecords.get(ref.docId)?.has(ref.recordId))
      fail("MALFORMED_FRAME", "reference has no canonical record written by this batch");
    const key = [ref.scopeKey, ref.generation, ref.lookupKind, ref.lookupId, ref.contentSlot, ref.partIndex].join(
      "\u0000",
    );
    return { key, value: copyRef(ref) };
  });
  const updateHashes = new Map(
    [...additions.values()].flatMap((list) => list.map((record) => [record, deps.digest(record.bytes)] as const)),
  );
  const nextScope = { ...scope, pointerRevision: scope.pointerRevision + input.seals.length };
  commitAccountedSets((pending) => {
    for (const [id, doc] of finalDocs) {
      const key = compositeKey(input.scopeKey, id);
      pending.push(
        newIds.has(id) ? state.docs.prepare(key, doc) : state.docs.prepareSharing(key, doc, ["transportCache"]),
      );
      const list = additions.get(id) ?? [];
      if (newIds.has(id)) pending.push(state.updates.prepare(key, list));
      else if (list.length > 0) pending.push(state.updates.prepareAppend(key, list));
    }
    for (const seal of input.seals)
      pending.push(
        state.successors.prepare(compositeKey(input.scopeKey, seal.docId), {
          successorDocId: seal.successorDocId,
          expectedLastSeq: seal.finalSeq,
        }),
      );
    for (const ref of refs) pending.push(state.refs.prepare(ref.key, ref.value));
    pending.push(
      state.batches.prepare(batchKey, { digest: input.digest, frontiers: frontiers.map((value) => ({ ...value })) }),
    );
    pending.push(state.scopes.prepare(input.scopeKey, nextScope));
    const verifiedScope = currentScope(input, state, deps.clock);
    nextScope.leaseExpiresAt = verifiedScope.leaseExpiresAt;
    if (state.scopes.get(input.scopeKey) !== scope || scope.pointerRevision !== input.expectedPointerRevision)
      fail("POINTER_REVISION_STALE", "content batch pointer changed during admission");
    for (const [id, before] of preimages) {
      const current = state.docs.get(compositeKey(input.scopeKey, id));
      if (current !== before.doc || current.state !== "active" || current.lastSeq !== before.lastSeq)
        fail("SEQUENCE_GAP", "content batch document changed during admission");
      if (state.successors.get(compositeKey(input.scopeKey, id)) !== routePreimages.get(id))
        fail("DIGEST_CONFLICT", "content batch route changed during admission");
    }
    if (state.batches.has(batchKey)) fail("DIGEST_CONFLICT", "content batch identity changed during admission");
    if (newIds.size > 0)
      for (const doc of state.docs.values())
        if (newIds.has(doc.docId)) fail("DIGEST_CONFLICT", "new content batch document appeared during admission");
    for (const id of newIds)
      if (state.successors.has(compositeKey(input.scopeKey, id)))
        fail("DIGEST_CONFLICT", "new content batch route appeared during admission");
    for (const [id, lastSeq] of expected)
      if (!newIds.has(id) && state.docs.get(compositeKey(input.scopeKey, id))?.lastSeq !== lastSeq)
        fail("SEQUENCE_GAP", "content batch frontier changed during admission");
    // 计划由写者独占；先取得最终存储额度再隔离正文，复制失败仍处于可整组撤销的准备阶段。
    for (const list of additions.values())
      for (const record of list) {
        const copied = copyBytes(record.bytes);
        if (deps.digest(copied) !== updateHashes.get(record))
          fail("DIGEST_CONFLICT", "update bytes changed during admission");
        record.bytes = copied;
      }
    for (const seal of input.seals) {
      const doc = finalDocs.get(seal.docId)!;
      const copied = copyBytes(doc.snapshot);
      if (deps.digest(copied) !== doc.hash) fail("DIGEST_CONFLICT", "seal bytes changed during admission");
      doc.snapshot = copied;
    }
  });
  return { outcome: "committed", frontiers };
}
