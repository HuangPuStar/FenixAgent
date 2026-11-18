import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import {
  buildDirectoryPageSnapshot,
  directoryPageDocId,
  directoryRootDocId,
  readDirectoryPage,
  setDirectoryLatestPageId,
} from "../sync/protocol/directory";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

// 正文、两次封口、完整路由和目录必须在同一次提交后全部可读，末块继续可写。
test("跨三块文本批次一次发布全部前沿与目录", async () => {
  const f = await contentBatchFixture();
  try {
    expect(typeof f.store.commitContentBatch).toBe("function");
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
    for (const [index, id] of f.ids.entries()) {
      expect(await f.store.readSuccessor(f.input.scopeKey, id)).toMatchObject({
        state: index < 2 ? "sealed" : "active",
        route: index < 2 ? { successorDocId: f.ids[index + 1], expectedLastSeq: 1 } : null,
      });
      expect(await f.store.readUpdatesAfter(id, 0, 4)).toHaveLength(1);
    }
    const directory = await f.store.readUpdatesAfter(f.pageId, 0, 4);
    const base = await f.store.readDocStateAt(f.pageId, 0);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base!.snapshot);
      Y.applyUpdate(doc, directory[0].bytes);
      expect(readDirectoryPage(doc).contentDocIds).toEqual(f.ids);
    } finally {
      doc.destroy();
    }
    expect(await f.store.readScopePointer(f.input.scopeKey)).toMatchObject({ pointerRevision: 3 });
  } finally {
    f.store.dispose();
  }
});

// 即使在最后一个额度申请处失败，也不能留下已写正文、孤立后继、目录或幂等标记。
test("跨块批次在每个额度拒绝点保持完整写前像", async () => {
  let succeeded = false;
  let rejected = 0;
  for (let cutoff = 0; cutoff < 64 && !succeeded; cutoff++) {
    const f = await contentBatchFixture();
    try {
      const before = f.store.exportCommittedState();
      const usage = f.usage();
      f.admission.remaining = cutoff;
      try {
        expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
        succeeded = true;
      } catch (error) {
        expect(error).toMatchObject({ code: "ADMISSION_REJECTED" });
        rejected++;
        expect(f.store.exportCommittedState()).toEqual(before);
        expect(f.usage()).toEqual(usage);
        f.admission.remaining = null;
        expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
      }
    } finally {
      f.store.dispose();
    }
  }
  expect(succeeded).toBe(true);
  expect(rejected).toBeGreaterThan(0);
});

// 规划后的过期不得发布任何片段；重新取权后可按原计划完整重试。
test("原子批次拒绝过期租约且不保留正文前缀", async () => {
  const f = await contentBatchFixture();
  try {
    const before = f.store.exportCommittedState();
    f.advance(1001);
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    expect((await f.store.commitContentBatch({ ...f.input, epoch: lease.epoch })).outcome).toBe("committed");
  } finally {
    f.store.dispose();
  }
});

// 回执丢失后以同批身份重试，不重复追加任何正文、路由或目录更新。
test("已提交批次丢回执后的重试只确认一次提交", async () => {
  const f = await contentBatchFixture();
  try {
    await f.store.commitContentBatch(f.input);
    const committed = f.store.exportCommittedState();
    const usage = f.usage();
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("already-committed");
    expect(f.store.exportCommittedState()).toEqual(committed);
    expect(f.usage()).toEqual(usage);
    expect((await f.store.commitContentBatch({ ...f.input, digest: "other" })).outcome).toBe("conflict");
    expect(f.store.exportCommittedState()).toEqual(committed);
  } finally {
    f.store.dispose();
  }
});

// 新页必须经当前目录根发布，只有孤立页包含新块 ID 不构成可发现的提交。
test("目录换页缺少根更新时整批拒绝，补齐根后一次发布", async () => {
  const f = await contentBatchFixture();
  try {
    const pageId = directoryPageDocId(f.input.generation, 2);
    const snapshot = buildDirectoryPageSnapshot(f.ids.slice(1), f.pageId);
    f.input.newDocs.push({
      ...f.input.newDocs[0],
      docId: pageId,
      kind: "directory",
      blockIndex: 2,
      snapshot,
      hash: sha256Digest(snapshot),
    });
    f.input.updates = f.input.updates.filter((value) => value.docId !== f.pageId);
    f.input.expectedFrontiers = f.input.expectedFrontiers.filter((value) => value.docId !== f.pageId);
    const before = f.store.exportCommittedState();
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    const rootId = directoryRootDocId(f.input.generation);
    const root = new Y.Doc();
    try {
      Y.applyUpdate(root, (await f.store.readDocStateAt(rootId, 0))!.snapshot);
      const bytes = captureChange(root, () => setDirectoryLatestPageId(root, pageId))!;
      f.input.updates.push({ docId: rootId, fromSeq: 1, bytes });
      f.input.expectedFrontiers.push({ docId: rootId, lastSeq: 0 });
    } finally {
      root.destroy();
    }
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
    expect(await f.store.readDocStateAt(pageId, 0)).not.toBeNull();
  } finally {
    f.store.dispose();
  }
});

// 预算回调中的时钟变化也必须在最终提交前复核，避免过期与额度准备交错留下前缀。
test("额度准备期间租约过期时撤销整组预留", async () => {
  const f = await contentBatchFixture();
  try {
    const before = f.store.exportCommittedState();
    const usage = f.usage();
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      f.advance(1001);
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    f.store.dispose();
  }
});

// 全部额度准备后复制计划字节失败，也必须撤销预留且不发布任何行。
test("已预留批次复制字节失败时保留完整写前像", async () => {
  const f = await contentBatchFixture();
  try {
    const before = f.store.exportCommittedState();
    const usage = f.usage();
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      const buffer = f.input.seals[0].finalSnapshot.buffer;
      if (!(buffer instanceof ArrayBuffer)) throw new Error("test requires a transferable snapshot");
      structuredClone(buffer, { transfer: [buffer] });
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toBeInstanceOf(TypeError);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    f.store.dispose();
  }
});

// 调用者复用计划缓冲或修改回执时，不得改写已提交字节及幂等确认结果。
test("原子批次隔离输入缓冲与返回前沿", async () => {
  const f = await contentBatchFixture();
  try {
    const result = await f.store.commitContentBatch(f.input);
    const committed = f.store.exportCommittedState();
    for (const update of f.input.updates) update.bytes.fill(0);
    for (const seal of f.input.seals) seal.finalSnapshot.fill(0);
    for (const doc of f.input.newDocs) doc.snapshot.fill(9);
    result.frontiers[0].lastSeq = 999;
    expect(f.store.exportCommittedState()).toEqual(committed);
    expect((await f.store.commitContentBatch(f.input)).frontiers[0].lastSeq).toBe(1);
  } finally {
    f.store.dispose();
  }
});
