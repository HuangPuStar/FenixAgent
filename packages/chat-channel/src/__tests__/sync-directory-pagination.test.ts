// packages/chat-channel/src/__tests__/sync-directory-pagination.test.ts
// 目录分页的字节契约：根目录恒为 O(1)，每页固定条数并链接上一页，页号与 docId blockIndex 一致。
//
// 背景（实施记录 §3.4）：把全部 contentDocIds 放在一个 Y.Array 时，6000 个 ID 的目录基线
// 已超过 MAX_DATA_FRAME_BYTES；分页后根目录只持一个页 ID，单帧尺寸与历史总量无关。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

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
} from "../sync/protocol/directory";
import { MAX_DATA_FRAME_BYTES } from "../sync/protocol/frames";

const GENERATION = "gen_directory_pages";

function contentIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `sync/content/${GENERATION}/${index}/block_${index}`);
}

describe("目录分页", () => {
  // 130 个块切成 64/64/2 三页，页号连续、每页只链接上一页，根目录指向页号最大的页。
  test("按固定大小切页并建立 previousPageId 链接", () => {
    const plan = planDirectoryPages(GENERATION, contentIds(130));
    expect(plan.rootDocId).toBe(directoryRootDocId(GENERATION));
    expect(plan.pages.map((page) => page.contentDocIds.length)).toEqual([64, 64, 2]);
    expect(plan.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(plan.pages.map((page) => page.previousPageId)).toEqual([
      null,
      directoryPageDocId(GENERATION, 1),
      directoryPageDocId(GENERATION, 2),
    ]);
    expect(plan.latestPageId).toBe(directoryPageDocId(GENERATION, 3));
    expect(plan.pages.every((page) => page.contentDocIds.length <= DIRECTORY_PAGE_SIZE)).toBe(true);
  });

  // 根目录基线与历史总量无关：6000 个块也只编码一个页 ID，远低于单帧上限。
  test("根目录基线尺寸有界，不随内容块总量增长", () => {
    const plan = planDirectoryPages(GENERATION, contentIds(6000));
    const firstPageId = directoryPageDocId(GENERATION, 1);
    const lastPageId = plan.latestPageId;
    if (lastPageId === null) throw new Error("expected latest page for 6000 ids");
    const small = buildDirectoryRootSnapshot(firstPageId);
    const large = buildDirectoryRootSnapshot(lastPageId);
    expect(small.byteLength).toBeLessThan(256);
    expect(large.byteLength).toBeLessThan(256);
    // 差异只来自页号位数，与内容块总量无关。
    expect(large.byteLength).toBeLessThan(small.byteLength + 16);
    expect(large.byteLength).toBeLessThan(MAX_DATA_FRAME_BYTES);

    const root = new Y.Doc();
    Y.applyUpdate(root, large);
    expect(readDirectoryRoot(root).latestPageId).toBe(lastPageId);
    root.destroy();

    const lastPage = plan.pages.at(-1);
    if (lastPage === undefined) throw new Error("expected pages for 6000 ids");
    const pageSnapshot = buildDirectoryPageSnapshot(lastPage.contentDocIds, lastPage.previousPageId);
    expect(pageSnapshot.byteLength).toBeLessThan(MAX_DATA_FRAME_BYTES);
  });

  // 页快照可往返读取；追加只写一次，重复 ID 不再膨胀页尺寸。
  test("页基线与增量追加共享同一布局", () => {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, buildDirectoryPageSnapshot(contentIds(2), null));
      expect(readDirectoryPage(doc).contentDocIds).toEqual(contentIds(2));
      expect(readDirectoryPage(doc).previousPageId).toBeNull();
      expect(appendDirectoryPageContent(doc, "sync/content/g/2/next")).toBe(true);
      expect(appendDirectoryPageContent(doc, "sync/content/g/2/next")).toBe(false);
      expect(readDirectoryPage(doc).contentDocIds).toEqual([...contentIds(2), "sync/content/g/2/next"]);
    } finally {
      doc.destroy();
    }
  });

  // 根目录改名只在值变化时产生更新；轮换页后客户端能读到新的 latestPageId。
  test("根目录只保存最新页 ID，并在轮换时更新", () => {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, buildDirectoryRootSnapshot(directoryPageDocId(GENERATION, 1)));
      expect(readDirectoryRoot(doc).latestPageId).toBe(directoryPageDocId(GENERATION, 1));
      expect(setDirectoryLatestPageId(doc, directoryPageDocId(GENERATION, 1))).toBe(false);
      expect(setDirectoryLatestPageId(doc, directoryPageDocId(GENERATION, 2))).toBe(true);
      expect(readDirectoryRoot(doc).latestPageId).toBe(directoryPageDocId(GENERATION, 2));
    } finally {
      doc.destroy();
    }
  });
});
