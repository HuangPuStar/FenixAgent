import { expect, test } from "bun:test";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import {
  DIRECTORY_PAGE_SIZE,
  directoryRootDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../sync/protocol/directory";
import { scopeKey } from "../sync/protocol/identity";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

/** 验证客户端能够通过已提交目录发现当前尾块，而不是只验证底层有正文。 */
async function expectTailPublished(f: Awaited<ReturnType<typeof fixture>>) {
  const pointer = await f.store.readScopePointer(scopeKey(f.scope));
  if (!pointer?.currentGeneration) throw new Error("Missing generation");
  const root = await loadCommittedDoc(f.store, directoryRootDocId(pointer.currentGeneration));
  if (!root) throw new Error("Missing directory root");
  try {
    const latest = readDirectoryRoot(root.doc).latestPageId;
    if (!latest) throw new Error("Missing directory page");
    const page = await loadCommittedDoc(f.store, latest);
    if (!page) throw new Error("Missing directory page state");
    try {
      const tail = f.store.exportCommittedState().docs.find((doc) => doc.kind === "content" && doc.state === "active");
      if (!tail) throw new Error("Missing active content");
      expect(readDirectoryPage(page.doc).contentDocIds).toContain(tail.docId);
    } finally {
      page.doc.destroy();
    }
  } finally {
    root.doc.destroy();
  }
}

// 新目录页已登记但根指针被拒时，重开必须复用同一份 canonical 快照而非生成冲突身份。
test("目录翻页根指针发布被拒后重开可继续发现新尾块", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("before"));
    for (let index = 1; index < DIRECTORY_PAGE_SIZE; index++) await f.writer.seal();
    f.faults.failDirectoryRoot = true;
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    f.faults.failDirectoryRoot = false;
    await f.reopen();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
    await expectTailPublished(f);
  } finally {
    f.faults.failDirectoryRoot = false;
    await f.close();
  }
});

for (const phase of ["page", "root"] as const) {
  // 初始化任一阶段失败后，已注册页可重用；根目录只有全部页就绪才发布。
  test(`目录初始化 ${phase} 登记被拒后重开可恢复完整目录`, async () => {
    const f = await fixture();
    try {
      await f.writer.close();
      const state = f.store.exportCommittedState();
      const directoryIds = new Set(state.docs.filter((doc) => doc.kind === "directory").map((doc) => doc.docId));
      f.store.restoreFromCommittedState({
        ...state,
        docs: state.docs.filter((doc) => !directoryIds.has(doc.docId)),
        updates: state.updates.filter((update) => !directoryIds.has(update.docId)),
      });
      f.faults.failDirectoryCreate = phase;
      await expect(f.reopen()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      f.faults.failDirectoryCreate = null;
      await f.reopen();
      await f.writer.seal();
      await f.writer.accept(object("after"));
      expect(await f.readAll()).toHaveLength(1);
      await expectTailPublished(f);
    } finally {
      f.faults.failDirectoryCreate = null;
      await f.close();
    }
  });
}
