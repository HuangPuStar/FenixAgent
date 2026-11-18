import * as Y from "yjs";
import { contentDocOverflow } from "../capacity/content-doc-limits";
import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { buildDocId, parseDocId } from "../protocol/identity";
import type { ContentBatchSeal } from "../store/live-content-batch-types";
import type { SyncDocRecord } from "../store/types";
import { captureChange } from "./change-capture";
import type { Cursor, Slice } from "./live-writer-internal";
import { buildNextLiveRecord } from "./live-writer-records";
import { reserveTextBatchBudget } from "./text-batch-plan-budget";
import type { TextBatchPlan, TextBatchPlanOptions, TextDirectoryPlan } from "./text-batch-plan-types";
import { bytes, hex, records, splitLiveText } from "./writer-support";

export type { TextBatchPlan, TextBatchPlanOptions } from "./text-batch-plan-types";

function capacityExceeded(message: string): never {
  throw new SyncProtocolError("CAPACITY_EXCEEDED", { message });
}

function cloneCursor(cursor: Cursor, snapshot: Uint8Array): Cursor {
  const doc = new Y.Doc({ guid: cursor.docId });
  Y.applyUpdate(doc, snapshot);
  return { ...cursor, doc };
}

/** 整个 MergeFlushRequest 离线规划，原游标和已提交边界在整批成功前保持不变。 */
export async function planLiveTextBatch(options: TextBatchPlanOptions): Promise<TextBatchPlan> {
  const { request, capacity } = options;
  if (
    request.key.generation !== options.generation ||
    parseDocId(options.cursor.docId).generation !== options.generation
  )
    throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text plan crosses its current generation" });
  if (options.cursor.kind !== "content")
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "text plan requires a content cursor" });
  const maxFlushBytes =
    options.maxFlushBytes ?? capacity.inputs.maxRawAcpFrameBytes + capacity.inputs.liveMergeMaxBytes - 1;
  if (!Number.isSafeInteger(maxFlushBytes) || maxFlushBytes <= 0)
    throw new SyncProtocolError("ADMISSION_REJECTED", { message: "text flush limit must be a positive safe integer" });
  if (request.bytes > maxFlushBytes || request.text.length > maxFlushBytes)
    capacityExceeded("text flush exceeds the admitted input limit");
  const budget = reserveTextBatchBudget(options);
  const cursors = new Map<string, Cursor>();
  let directory: TextDirectoryPlan | undefined;
  let committed = false;
  let disposed = false;
  try {
    const chunks = splitLiveText(request.text, capacity);
    budget.reserveRecords(chunks.length);
    const pointer = await options.store.readScopePointer(options.scopeKey);
    if (!pointer || pointer.currentGeneration !== options.generation)
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text plan generation is no longer current" });
    const initial = Y.encodeStateAsUpdate(options.cursor.doc);
    if (initial.byteLength > MAX_DOC_SNAPSHOT_BYTES)
      capacityExceeded("current content exceeds the transport hard limit");
    budget.reserveContentDoc(options.cursor.docId);
    let cursor = cloneCursor(options.cursor, initial);
    cursors.set(cursor.docId, cursor);
    const slices: Slice[] = [];
    const newDocs: SyncDocRecord[] = [];
    const seals: ContentBatchSeal[] = [];
    let plannedUpdates = 0;
    const rotate = () => {
      const snapshot = Y.encodeStateAsUpdate(cursor.doc);
      const blockIndex = parseDocId(cursor.docId).blockIndex + 1;
      const docId = buildDocId({
        kind: "content",
        generation: options.generation,
        blockIndex,
        nonce: hex(options.random, 8),
      });
      budget.reserveContentDoc(docId);
      seals.push({
        docId: cursor.docId,
        finalSeq: cursor.lastSeq + plannedUpdates,
        finalSnapshot: snapshot,
        finalHash: options.digest(snapshot),
        successorDocId: docId,
      });
      const doc = new Y.Doc({ guid: docId });
      const empty = Y.encodeStateAsUpdate(doc);
      newDocs.push({
        scopeKey: options.scopeKey,
        generation: options.generation,
        docId,
        kind: "content",
        state: "active",
        snapshot: empty,
        hash: options.digest(empty),
        baseSeq: 0,
        finalSeq: null,
        blockIndex,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      });
      cursor = { docId, kind: "content", doc, lastSeq: 0 };
      cursors.set(docId, cursor);
      plannedUpdates = 0;
    };
    // 存量超出当前写入规则时原样封口；复用Store的增长校验，避免向旧块追加后才发现不兼容。
    if (
      chunks.length > 0 &&
      contentDocOverflow({ doc: cursor.doc, capacity, lastSeq: cursor.lastSeq, snapshot: initial })
    )
      rotate();
    for (const text of chunks) {
      const payload = bytes(text);
      let size = records(cursor.doc)?.length ?? 0;
      // active内容基线固定为0；本批未确认片只计入计划，不提前修改已提交lastSeq。
      if (
        size >= capacity.inputs.maxRecordsPerDoc ||
        cursor.lastSeq + plannedUpdates + 1 > capacity.inputs.maxTransactionsPerDoc
      )
        rotate();
      const before = Y.encodeStateAsUpdate(cursor.doc);
      const append = () => {
        const update = captureChange(cursor.doc, () =>
          records(cursor.doc, [buildNextLiveRecord(options.random, cursor.doc, request.key, "text", payload)]),
        );
        if (update === null)
          throw new SyncProtocolError("MALFORMED_FRAME", { message: "text piece produced no update" });
        return update;
      };
      let update = append();
      if (Y.encodeStateAsUpdate(cursor.doc).byteLength > capacity.inputs.activeHardEncodedBytes) {
        cursor.doc.destroy();
        cursor = cloneCursor(cursor, before);
        cursors.set(cursor.docId, cursor);
        size = records(cursor.doc)?.length ?? 0;
        if (size === 0) capacityExceeded("text record cannot fit an empty content document");
        rotate();
        update = append();
        if (Y.encodeStateAsUpdate(cursor.doc).byteLength > capacity.inputs.activeHardEncodedBytes)
          capacityExceeded("text record cannot fit an empty content document");
      }
      // 单次逻辑提交保留有界物理片；合并成整Doc更新会使小连接窗口永远无法发送。
      slices.push({ docId: cursor.docId, fromSeq: cursor.lastSeq + plannedUpdates + 1, bytes: update });
      plannedUpdates += 1;
    }
    const finalCursor = cursor;
    budget.reserveDirectory(newDocs.length);
    directory = options.directory.planContentDocs(newDocs.map((doc) => doc.docId));
    slices.push(...directory.slices);
    newDocs.push(...directory.newDocs);
    for (const [docId, directoryCursor] of directory.cursors) {
      if (Y.encodeStateAsUpdate(directoryCursor.doc).byteLength > capacity.inputs.directoryHardBytes)
        capacityExceeded("planned directory exceeds its hard limit");
      cursors.set(docId, directoryCursor);
    }
    return {
      slices,
      newDocs,
      seals,
      cursors,
      finalCursor,
      expectedPointerRevision: pointer.pointerRevision,
      commit() {
        if (disposed) throw new SyncProtocolError("RESOURCE_RETIRED", { message: "text plan is disposed" });
        if (committed) return;
        directory?.commit();
        committed = true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        directory?.dispose();
        for (const item of cursors.values()) {
          if (item.kind === "content" && (!committed || item !== finalCursor)) item.doc.destroy();
        }
        budget.release();
      },
    };
  } catch (error) {
    directory?.dispose();
    for (const cursor of cursors.values()) if (cursor.kind === "content") cursor.doc.destroy();
    budget.release();
    throw error;
  }
}
