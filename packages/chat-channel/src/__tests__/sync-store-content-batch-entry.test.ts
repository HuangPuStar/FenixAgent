import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import {
  appendDirectoryPageContent,
  directoryRootDocId,
  readDirectoryPage,
  setDirectoryLatestPageId,
} from "../sync/protocol/directory";
import { buildDocId } from "../sync/protocol/identity";
import type { CommitContentBatchInput } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 单块文本追加仍须以已发布的内容入口为起点。 */
function singleUpdate(f: Awaited<ReturnType<typeof contentBatchFixture>>, docId = f.ids[0]): CommitContentBatchInput {
  return {
    ...f.input,
    batchId: "single",
    digest: "single",
    newDocs: [],
    seals: [],
    updates: [{ ...f.input.updates[0], docId }],
    expectedFrontiers: [{ docId, lastSeq: 0 }],
  };
}

/** 预分配文档本身不构成可写入口，只有已发布的目录或初始闭包才能授权它。 */
async function orphan(f: Awaited<ReturnType<typeof contentBatchFixture>>) {
  const id = buildDocId({ kind: "content", generation: f.input.generation, blockIndex: 3, nonce: "orphan" });
  await f.store.createDoc({
    scopeKey: f.input.scopeKey,
    epoch: f.input.epoch,
    doc: { ...f.input.newDocs[0], docId: id, blockIndex: 3 },
  });
  return id;
}

/** 空目录仍保留代次初始内容入口，不允许借此写入任意预分配块。 */
async function emptyDirectory(f: Awaited<ReturnType<typeof contentBatchFixture>>) {
  const id = directoryRootDocId(f.input.generation);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, (await f.store.readDocStateAt(id, 0))!.snapshot);
    const bytes = captureChange(doc, () => setDirectoryLatestPageId(doc, null))!;
    await f.store.appendUpdates({
      ...f.input,
      batchId: "empty-directory",
      digest: sha256Digest(bytes),
      updates: [{ docId: id, fromSeq: 1, bytes }],
      expectedFrontiers: [{ docId: id, lastSeq: 0 }],
    });
  } finally {
    doc.destroy();
  }
}

for (const empty of [false, true]) {
  // 单块更新不能绕过目录尾块约束，空目录也只能使用入口闭包中的初始块。
  test(`原子文本批次拒绝未发布首块，空目录=${empty}`, async () => {
    const f = await contentBatchFixture();
    try {
      const hidden = await orphan(f);
      if (empty) await emptyDirectory(f);
      const before = f.store.exportCommittedState();
      const usage = f.usage();
      await expect(f.store.commitContentBatch(singleUpdate(f, hidden))).rejects.toMatchObject({
        code: "MALFORMED_FRAME",
      });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
      expect((await f.store.commitContentBatch(singleUpdate(f))).outcome).toBe("committed");
    } finally {
      f.store.dispose();
    }
  });
}

// 额度准备时旧尾块被真实路由事务接管，外层不得覆盖内层已提交的后继与截止点。
test("路由事务重入后原子批次保留已提交路由并拒绝旧计划", async () => {
  const f = await contentBatchFixture();
  let nested: ReturnType<typeof f.store.registerSuccessor> | undefined;
  const alternate = buildDocId({ kind: "content", generation: f.input.generation, blockIndex: 1, nonce: "alternate" });
  try {
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      nested = f.store.registerSuccessor({
        scopeKey: f.input.scopeKey,
        epoch: f.input.epoch,
        predecessorDocId: f.ids[0],
        successorDocId: alternate,
        expectedLastSeq: 0,
        successorDoc: { ...f.input.newDocs[0], docId: alternate },
      });
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect((await nested)?.outcome).toBe("committed");
    expect(await f.store.readSuccessor(f.input.scopeKey, f.ids[0])).toMatchObject({
      state: "sealing",
      route: { successorDocId: alternate, expectedLastSeq: 0 },
    });
    expect(await f.store.readDocStateAt(f.ids[1], 0)).toBeNull();
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
  } finally {
    f.store.dispose();
  }
});

// 单块更新没有目录写入，仍须在额度准备后复核目录尾块，避免使用已失效的可发现性证明。
test("目录尾块在额度准备期间变化时拒绝单块旧计划", async () => {
  const f = await contentBatchFixture();
  let nested: ReturnType<typeof f.store.appendUpdates> | undefined;
  try {
    const hidden = await orphan(f);
    const page = await loadCommittedDoc(f.store, f.pageId);
    const bytes = captureChange(page!.doc, () => appendDirectoryPageContent(page!.doc, hidden))!;
    page!.doc.destroy();
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      nested = f.store.appendUpdates({
        ...f.input,
        batchId: "publish-other-tail",
        digest: sha256Digest(bytes),
        updates: [{ docId: f.pageId, fromSeq: 1, bytes }],
        expectedFrontiers: [{ docId: f.pageId, lastSeq: 0 }],
      });
    };
    await expect(f.store.commitContentBatch(singleUpdate(f))).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect((await nested)?.outcome).toBe("committed");
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
    const latest = await loadCommittedDoc(f.store, f.pageId);
    try {
      expect(readDirectoryPage(latest!.doc).contentDocIds.at(-1)).toBe(hidden);
    } finally {
      latest!.doc.destroy();
    }
  } finally {
    f.store.dispose();
  }
});

// 相同批次身份在准备期间被另一个提交占用时，外层不得覆盖其幂等结果。
test("批次身份在额度准备期间被占用时拒绝外层计划", async () => {
  const f = await contentBatchFixture();
  let nested: ReturnType<typeof f.store.appendUpdates> | undefined;
  try {
    const inner = { ...f.input, digest: "claimed-batch", updates: [], expectedFrontiers: [] };
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      nested = f.store.appendUpdates(inner);
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect((await nested)?.outcome).toBe("committed");
    expect((await f.store.appendUpdates(inner)).outcome).toBe("already-committed");
    expect(await f.store.readDocStateAt(f.ids[1], 0)).toBeNull();
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
  } finally {
    f.store.dispose();
  }
});

// 尚未准备到的新块先被其他注册提交占用时，外层不得把该块当成自己的未发布草稿覆盖。
test("新块在额度准备期间被注册时保留注册并拒绝外层计划", async () => {
  const f = await contentBatchFixture();
  let nested: ReturnType<typeof f.store.createDoc> | undefined;
  try {
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      nested = f.store.createDoc({ scopeKey: f.input.scopeKey, epoch: f.input.epoch, doc: f.input.newDocs[1] });
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect((await nested)?.outcome).toBe("committed");
    expect(await f.store.readDocStateAt(f.ids[1], 0)).toBeNull();
    expect(await f.store.readSuccessor(f.input.scopeKey, f.ids[2])).toMatchObject({ state: "active", route: null });
    expect(await f.store.readUpdatesAfter(f.ids[2], 0, 4)).toHaveLength(0);
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
  } finally {
    f.store.dispose();
  }
});

// 旧代次可用多个空块作入口闭包，空目录回退仍只允许闭包末位，不能写入较早入口。
test("空目录的多入口闭包只允许已登记末位块", async () => {
  const f = await contentBatchFixture();
  try {
    const tail = await orphan(f);
    await emptyDirectory(f);
    const snapshot = f.store.exportCommittedState();
    const generation = snapshot.generations.find((row) => row.generation === f.input.generation)!;
    generation.entryRefs.contentDocIds.push(tail);
    f.store.restoreFromCommittedState(snapshot);
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    f.input.epoch = lease.epoch;
    const before = f.store.exportCommittedState();
    await expect(f.store.commitContentBatch(singleUpdate(f))).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect((await f.store.commitContentBatch(singleUpdate(f, tail))).outcome).toBe("committed");
    expect(await f.store.readUpdatesAfter(tail, 0, 4)).toHaveLength(1);
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
  } finally {
    f.store.dispose();
  }
});
