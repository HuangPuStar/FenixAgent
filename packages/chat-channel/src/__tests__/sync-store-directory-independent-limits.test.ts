import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { captureChange } from "../sync/live/change-capture";
import { directoryRootDocId, setDirectoryLatestPageId } from "../sync/protocol/directory";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

// 根是长寿入口，正文每块限额不能误作根事务限额或跨文档批次更新总数。
test("目录根独立限制允许多次更新且正文各块分别满足记录限额", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxTransactionsPerDoc: 1, maxRecordsPerDoc: 1 },
  });
  const root = directoryRootDocId(f.input.generation),
    doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, (await f.store.readDocStateAt(root, 0))!.snapshot);
    for (const [index, target] of [null, f.pageId].entries()) {
      const bytes = captureChange(doc, () => setDirectoryLatestPageId(doc, target))!;
      expect(
        (
          await f.store.appendUpdates({
            ...f.input,
            batchId: `root-${index}`,
            digest: `root-${index}`,
            updates: [{ docId: root, fromSeq: index + 1, bytes }],
            expectedFrontiers: [{ docId: root, lastSeq: index }],
          })
        ).outcome,
      ).toBe("committed");
    }
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
    expect(await f.store.readUpdatesAfter(root, 0, 10)).toHaveLength(2);
    for (const id of f.ids) expect(await f.store.readUpdatesAfter(id, 0, 10)).toHaveLength(1);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});
