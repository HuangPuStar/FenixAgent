import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import {
  buildDirectoryPageSnapshot,
  directoryPageDocId,
  directoryRootDocId,
  setDirectoryLatestPageId,
} from "../sync/protocol/directory";
import type { WriterLease } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

for (const target of ["update", "seal"] as const) {
  // 注入的额度端口不能在校验后改写待发布字节，否则持久化内容与承诺摘要会不一致。
  test(`额度申请期间${target}字节被改写时整批拒绝`, async () => {
    const f = await contentBatchFixture();
    try {
      const before = f.store.exportCommittedState(),
        usage = f.usage();
      f.admission.beforeReserve = () => {
        f.admission.beforeReserve = null;
        const bytes = target === "update" ? f.input.updates[0].bytes : f.input.seals[0].finalSnapshot;
        bytes[bytes.length - 1] ^= 1;
      };
      await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
    } finally {
      f.store.dispose();
    }
  });
}

// 同一租约的有效续期可在准备期间发生，发布指针时不能把新期限覆盖回旧期限。
test("额度准备期间续租后提交保留较新的租约期限", async () => {
  const f = await contentBatchFixture();
  let renewed: Promise<WriterLease> | undefined;
  try {
    f.admission.beforeReserve = () => {
      f.admission.beforeReserve = null;
      f.advance(900);
      renewed = f.store.renewWriter(
        { scopeKey: f.input.scopeKey, epoch: f.input.epoch, owner: f.input.owner, expiresAt: 2000 },
        1000,
      );
    };
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
    expect((await f.store.readScopePointer(f.input.scopeKey))?.leaseExpiresAt).toBe(2900);
    f.advance(200);
    await f.store.confirmWriter(await renewed!, f.input.generation);
  } finally {
    f.store.dispose();
  }
});

// 新目录页必须实际承接正文入口，空页不能遮住先前已发布的末位内容块。
test("正文原子批次拒绝将空目录页发布为新尾页", async () => {
  const f = await contentBatchFixture(),
    doc = new Y.Doc();
  try {
    const id = directoryPageDocId(f.input.generation, 2),
      root = directoryRootDocId(f.input.generation);
    const snapshot = buildDirectoryPageSnapshot([], f.pageId);
    f.input.newDocs.push({
      ...f.input.newDocs[0],
      docId: id,
      kind: "directory",
      blockIndex: 2,
      snapshot,
      hash: sha256Digest(snapshot),
    });
    Y.applyUpdate(doc, (await f.store.readDocStateAt(root, 0))!.snapshot);
    const bytes = captureChange(doc, () => setDirectoryLatestPageId(doc, id))!;
    f.input.updates.push({ docId: root, fromSeq: 1, bytes });
    f.input.expectedFrontiers.push({ docId: root, lastSeq: 0 });
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

// 匹配写前前沿本身不是正文，索引必须与本批实际新增的 canonical 记录一起发布。
test("正文原子批次拒绝没有新增正文的悬空定位", async () => {
  const f = await contentBatchFixture();
  try {
    const input = {
      ...f.input,
      newDocs: [],
      seals: [],
      updates: [],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
      refs: [
        {
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          lookupKind: "entry" as const,
          lookupId: "missing",
          contentSlot: 0,
          partIndex: 0,
          docId: f.ids[0],
          recordId: "missing",
          orderStart: 0,
          orderEnd: 0,
          byteStart: 0,
          byteEnd: 1,
        },
      ],
    };
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(f.store.commitContentBatch(input)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    f.store.dispose();
  }
});
