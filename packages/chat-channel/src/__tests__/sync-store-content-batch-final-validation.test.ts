import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type DigestFn, sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { records } from "../sync/live/writer-support";
import { setDirectoryLatestPageId } from "../sync/protocol/directory";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

for (const expires of [false, true]) {
  // 最终复制与摘要也占用租约时间，临界前成功、到期后必须整批释放额度。
  test(`最终摘要跨租约时重新校验写权，到期=${expires}`, async () => {
    let armed = false,
      fired = false;
    let f: Awaited<ReturnType<typeof contentBatchFixture>>;
    const digest: DigestFn = (bytes) => {
      if (armed && !fired) {
        fired = true;
        f.advance(expires ? 1000 : 999);
      }
      return sha256Digest(bytes);
    };
    f = await contentBatchFixture(DEFAULT_SYNC_CAPACITY, { digest });
    try {
      const before = f.store.exportCommittedState(),
        usage = f.usage();
      f.admission.beforeReserve = () => {
        armed = true;
      };
      if (expires) {
        await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
        expect(f.store.exportCommittedState()).toEqual(before);
        expect(f.usage()).toEqual(usage);
      } else expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
      expect(fired).toBe(true);
    } finally {
      f.store.dispose();
    }
  });
}

// 摘要回调同步重入可改变只读目录前像，最后一次 CAS 也必须在摘要之后。
test("最终摘要重入改写目录时拒绝旧计划并保留内层提交", async () => {
  let armed = false,
    fired = false;
  let nested: ReturnType<Awaited<ReturnType<typeof contentBatchFixture>>["store"]["appendUpdates"]> | undefined;
  let f: Awaited<ReturnType<typeof contentBatchFixture>>;
  let bytes: Uint8Array;
  let rootId: string;
  const digest: DigestFn = (value) => {
    if (armed && !fired) {
      fired = true;
      nested = f.store.appendUpdates({
        ...f.input,
        batchId: "digest-root",
        digest: "digest-root",
        updates: [
          {
            docId: rootId,
            fromSeq: 1,
            bytes,
          },
        ],
        expectedFrontiers: [
          {
            docId: rootId,
            lastSeq: 0,
          },
        ],
      });
    }
    return sha256Digest(value);
  };
  f = await contentBatchFixture(DEFAULT_SYNC_CAPACITY, { digest });
  rootId = f.store.exportCommittedState().docs.find((d) => d.kind === "directory" && d.blockIndex === 0)!.docId;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, (await f.store.readDocStateAt(rootId, 0))!.snapshot);
    bytes = captureChange(doc, () => setDirectoryLatestPageId(doc, null))!;
    f.admission.beforeReserve = () => {
      armed = true;
    };
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect((await nested)?.outcome).toBe("committed");
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 10)).toHaveLength(0);
    expect(await f.store.readUpdatesAfter(rootId, 0, 10)).toHaveLength(1);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

for (const invalid of ["missing-text", "identity", "payload", "lookup", "byte-range", "order-range"] as const) {
  // 定位必须能被真实文本读取器确认，只有 recordId 不足以发布成功索引。
  test(`原子正文批次拒绝无效 live-text 定位：${invalid}`, async () => {
    const f = await contentBatchFixture();
    const doc = new Y.Doc();
    try {
      const record = {
        recordId: "record-2",
        kind: "text",
        entryId: invalid === "identity" ? "other" : "entry",
        contentSlot: "text",
        payload: new TextEncoder().encode("after"),
      };
      const value: unknown =
        invalid === "missing-text"
          ? { recordId: record.recordId }
          : invalid === "payload"
            ? { ...record, payload: "after" }
            : record;
      const bytes = captureChange(doc, () => records(doc, [value]))!;
      f.input.updates = f.input.updates.map((u) => (u.docId === f.ids[2] ? { ...u, bytes } : u));
      f.input.refs = [
        {
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          lookupKind: "live-text",
          lookupId:
            invalid === "lookup"
              ? "wrong"
              : textClaimLookupId(sha256Digest, {
                  scopeKey: f.input.scopeKey,
                  generation: f.input.generation,
                  entryId: "entry",
                  contentSlot: "text",
                }),
          contentSlot: 0,
          partIndex: 0,
          docId: f.ids[2],
          recordId: "record-2",
          orderStart: 0,
          orderEnd: invalid === "order-range" ? 1 : 0,
          byteStart: 0,
          byteEnd: invalid === "byte-range" ? 4 : 5,
        },
      ];
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
}

// 身份摘要回调在投影校验后仍可改原始缓冲，最终隔离必须对照校验前绑定的更新摘要。
test("定位摘要期间改写更新字节时拒绝原子批次", async () => {
  let armed = false,
    keys = 0,
    changed = false;
  let f: Awaited<ReturnType<typeof contentBatchFixture>>;
  const digest: DigestFn = (bytes) => {
    if (armed && new TextDecoder().decode(bytes).startsWith("[1,") && ++keys === 4) {
      const target = f.input.updates.find((update) => update.docId === f.ids[2])!.bytes;
      for (let i = target.byteLength - 4; i >= 0; i--)
        if (target[i] === 116 && target[i + 1] === 101 && target[i + 2] === 120 && target[i + 3] === 116) {
          target.set(new TextEncoder().encode("nope"), i);
          changed = true;
          break;
        }
    }
    return sha256Digest(bytes);
  };
  f = await contentBatchFixture(DEFAULT_SYNC_CAPACITY, { digest });
  f.input.refs = [
    {
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      lookupKind: "live-text",
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId: "entry",
        contentSlot: "text",
      }),
      contentSlot: 0,
      partIndex: 0,
      docId: f.ids[2],
      recordId: "record-2",
      orderStart: 0,
      orderEnd: 0,
      byteStart: 0,
      byteEnd: 5,
    },
  ];
  try {
    armed = true;
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect(changed).toBe(true);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    f.store.dispose();
  }
});
