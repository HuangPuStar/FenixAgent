import * as Y from "yjs";
import type { DigestFn } from "../clock";
import {
  appendDirectoryPageContent,
  buildDirectoryPageSnapshot,
  DIRECTORY_PAGE_SIZE,
  directoryPageDocId,
  readDirectoryPage,
  setDirectoryLatestPageId,
} from "../protocol/directory";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { SyncDocRecord } from "../store/types";
import { captureChange } from "./change-capture";
import type { Cursor, Slice } from "./live-writer-internal";
import type { TextDirectoryPlan, TextDirectoryState } from "./text-batch-plan-types";

function clone(cursor: Cursor): Cursor {
  const doc = new Y.Doc({ guid: cursor.docId });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(cursor.doc));
  return { ...cursor, doc };
}

/** 只复制目录根与当前页，新页初态随正文整批登记，不读取历史页链。 */
export function planTextDirectory(input: {
  readonly state: TextDirectoryState;
  readonly scopeKey: string;
  readonly digest: DigestFn;
  readonly contentDocIds: readonly string[];
  readonly install: (state: TextDirectoryState) => void;
}): TextDirectoryPlan {
  if (input.contentDocIds.length === 0) {
    return { slices: [], newDocs: [], cursors: new Map(), commit() {}, dispose() {} };
  }
  const cursors = new Map<string, Cursor>();
  const slices: Slice[] = [];
  const newDocs: SyncDocRecord[] = [];
  const root = clone(input.state.root);
  cursors.set(root.docId, root);
  let page = input.state.page === null ? null : clone(input.state.page);
  if (page) cursors.set(page.docId, page);
  let retained = false;
  let disposed = false;
  try {
    const groups: { docId: string; previousPageId: string | null; contentDocIds: string[] }[] = [];
    const existing = page === null ? [] : [...readDirectoryPage(page.doc).contentDocIds];
    const additions: string[] = [];
    let currentIds = existing;
    let currentPageId = page?.docId ?? null;
    for (const docId of input.contentDocIds) {
      if (currentIds.includes(docId)) continue;
      if (currentPageId === null || currentIds.length >= DIRECTORY_PAGE_SIZE) {
        const nextNumber = currentPageId === null ? 1 : parseDocId(currentPageId).blockIndex + 1;
        const nextId = directoryPageDocId(input.state.generation, nextNumber);
        const group = { docId: nextId, previousPageId: currentPageId, contentDocIds: [] as string[] };
        groups.push(group);
        currentPageId = nextId;
        currentIds = group.contentDocIds;
      }
      currentIds.push(docId);
      if (groups.length === 0) additions.push(docId);
    }
    if (page && additions.length > 0) {
      const currentPage = page;
      const update = captureChange(currentPage.doc, () => {
        for (const docId of additions) appendDirectoryPageContent(currentPage.doc, docId);
      });
      if (update) slices.push({ docId: page.docId, fromSeq: page.lastSeq + 1, bytes: update });
    }
    for (const group of groups) {
      const snapshot = buildDirectoryPageSnapshot(group.contentDocIds, group.previousPageId);
      const doc = new Y.Doc({ guid: group.docId });
      Y.applyUpdate(doc, snapshot);
      page = { docId: group.docId, kind: "directory", doc, lastSeq: 0 };
      cursors.set(page.docId, page);
      newDocs.push({
        scopeKey: input.scopeKey,
        generation: input.state.generation,
        docId: group.docId,
        kind: "directory",
        state: "active",
        snapshot,
        hash: input.digest(snapshot),
        baseSeq: 0,
        finalSeq: null,
        blockIndex: parseDocId(group.docId).blockIndex,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      });
    }
    if (groups.length > 0) {
      const update = captureChange(root.doc, () => setDirectoryLatestPageId(root.doc, currentPageId));
      if (update) slices.push({ docId: root.docId, fromSeq: root.lastSeq + 1, bytes: update });
    }
    const finalPage = page;
    return {
      slices,
      newDocs,
      cursors,
      commit() {
        if (disposed) throw new SyncProtocolError("RESOURCE_RETIRED", { message: "directory plan is disposed" });
        if (retained) return;
        input.install({ generation: input.state.generation, root, page: finalPage });
        retained = true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const cursor of cursors.values()) {
          if (!retained || (cursor !== root && cursor !== finalPage)) cursor.doc.destroy();
        }
      },
    };
  } catch (error) {
    for (const cursor of cursors.values()) cursor.doc.destroy();
    throw error;
  }
}
