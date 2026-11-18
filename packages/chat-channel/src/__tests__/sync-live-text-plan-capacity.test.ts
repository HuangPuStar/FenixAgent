import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import type { LiveRecordValue, LiveWriterOptions } from "../sync/live/live-writer-types";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { commitPlannedTextBatch } from "../sync/live/text-batch-commit";
import { planLiveTextBatch, type TextBatchPlan } from "../sync/live/text-batch-plan";
import { records } from "../sync/live/writer-support";
import {
  directoryPageDocId,
  directoryRootDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../sync/protocol/directory";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import { textBatchFixture } from "./sync-live-text-batch-plan-fixture";

type Fixture = Awaited<ReturnType<typeof textBatchFixture>>;

/** 沿既有appendUpdates落地旧数据，覆盖新容量规则启用前已经写入的块。 */
async function appendLegacy(f: Fixture, payloads: readonly string[], kind: LiveRecordValue["kind"] = "history_object") {
  const values: LiveRecordValue[] = payloads.map((text, index) => ({
    recordId: `legacy-${f.cursor.lastSeq}-${index}`,
    entryId: "prior",
    contentSlot: "text",
    contentType: "text/plain",
    partIndex: (records(f.cursor.doc)?.length ?? 0) + index,
    kind,
    payload: new TextEncoder().encode(text),
  }));
  const update = captureChange(f.cursor.doc, () => records(f.cursor.doc, values));
  if (update === null) throw new Error("fixture produced no legacy update");
  await f.store.appendUpdates({
    scopeKey: f.scopeKey,
    epoch: f.lease.epoch,
    owner: f.lease.owner,
    batchId: `legacy-${f.cursor.lastSeq}`,
    digest: f.digest(update),
    expectedFrontiers: [{ docId: f.cursor.docId, lastSeq: f.cursor.lastSeq }],
    updates: [{ docId: f.cursor.docId, fromSeq: f.cursor.lastSeq + 1, bytes: update }],
  });
  f.cursor.lastSeq += 1;
}

/** 使用真实整批提交编排，复用封口无新增片时的前沿补齐和完整批次摘要。 */
async function commit(f: Fixture, plan: TextBatchPlan): Promise<void> {
  const clock = { now: () => 1000 };
  const options: LiveWriterOptions = {
    ...f,
    clock,
    limits: RUNTIME_DOC_LIMITS,
    merge: { maxBytes: f.capacity.inputs.liveMergeMaxBytes, maxDelayMs: f.capacity.inputs.liveMergeMaxMs },
    rotation: { clock, random: f.random, limits: RUNTIME_DOC_LIMITS, maxResidentMs: 600000, maxTransactions: 1000 },
  };
  await commitPlannedTextBatch({
    options,
    plan,
    scopeKey: f.scopeKey,
    generation: f.generation,
    renew: () => f.store.renewWriter(f.lease, 30000),
    stop: (code, message, cause) => new SyncProtocolError(code, { message, cause }),
  });
  plan.commit();
}

/** 直接重读已提交根和前向页链，目录缓存不能替代可发现性的存储证据。 */
async function committedDirectory(f: Fixture): Promise<string[]> {
  const root = await loadCommittedDoc(f.store, directoryRootDocId(f.generation));
  if (root === null) throw new Error("missing committed directory root");
  let pageId: string | null;
  try {
    pageId = readDirectoryRoot(root.doc).latestPageId;
  } finally {
    root.doc.destroy();
  }
  const pages: string[][] = [];
  while (pageId !== null) {
    const page = await loadCommittedDoc(f.store, pageId);
    if (page === null) throw new Error("missing committed directory page");
    try {
      const state = readDirectoryPage(page.doc);
      pages.push([...state.contentDocIds]);
      pageId = state.previousPageId;
    } finally {
      page.doc.destroy();
    }
  }
  return pages.reverse().flat();
}

// 已提交旧块超过新写入阈值时仍须原样封口，限制只约束本次真正增长的正文。
test.each([
  {
    name: "transaction count",
    limits: { maxTransactionsPerDoc: 2 },
    groups: [["one"], ["two"], ["three"]],
    kind: "history_object" as const,
  },
  {
    name: "terminal record count",
    limits: { maxRecordsPerDoc: 1 },
    groups: [["terminal-content", "terminal-boundary"]],
    kind: "final" as const,
  },
  {
    name: "encoded active limit",
    limits: { activeHardEncodedBytes: 500 },
    groups: [["x".repeat(700)]],
    kind: "history_object" as const,
  },
  {
    name: "payload chunk limit",
    limits: { payloadChunkMaxBytes: 100 },
    groups: [["x".repeat(700)]],
    kind: "history_object" as const,
  },
])("seals an unchanged predecessor over the $name before writing into a successor", async ({
  limits,
  groups,
  kind,
}) => {
  const capacity = { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, ...limits } };
  const old = await textBatchFixture();
  for (const group of groups) await appendLegacy(old, group, kind);
  const f = await textBatchFixture(capacity, 1, old.store.exportCommittedState());
  old.cursor.doc.destroy();
  old.store.dispose();
  const prior = Y.encodeStateAsUpdate(f.cursor.doc);
  const priorSeq = f.cursor.lastSeq;
  const priorRecords = records<LiveRecordValue>(f.cursor.doc)!.toArray();
  expect(prior.byteLength).toBeLessThanOrEqual(MAX_DOC_SNAPSHOT_BYTES);
  const plan = await planLiveTextBatch({ ...f, request: f.request("N") });
  try {
    expect(plan.slices.filter((slice) => slice.docId === f.cursor.docId)).toHaveLength(0);
    expect(plan.seals[0]?.docId).toBe(f.cursor.docId);
    expect(plan.seals[0]?.finalSeq).toBe(priorSeq);
    expect(plan.seals[0]?.finalSnapshot).toEqual(prior);
    expect(plan.finalCursor.docId).not.toBe(f.cursor.docId);
    await commit(f, plan);
    const sealed = await loadCommittedDoc(f.store, f.cursor.docId);
    const successor = await loadCommittedDoc(f.store, plan.finalCursor.docId);
    try {
      expect(sealed!.lastSeq).toBe(priorSeq);
      expect(records<LiveRecordValue>(sealed!.doc)!.toArray()).toEqual(priorRecords);
      expect(
        (records<LiveRecordValue>(successor!.doc)?.toArray() ?? [])
          .map((record) => new TextDecoder().decode(record.payload))
          .join(""),
      ).toBe("N");
    } finally {
      sealed?.doc.destroy();
      successor?.doc.destroy();
    }
    expect((await committedDirectory(f)).at(-1)).toBe(plan.finalCursor.docId);
  } finally {
    plan.dispose();
    plan.finalCursor.doc.destroy();
    f.cursor.doc.destroy();
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});

// 正文事务硬限不能套到固定目录根/页上，否则第二次轮转就永久停写。
test("repeated max-one-transaction content rotations keep publishing the committed directory tail", async () => {
  const capacity = { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxTransactionsPerDoc: 1 } };
  const f = await textBatchFixture(capacity);
  const ids = [f.cursor.docId];
  try {
    for (const text of ["A", "B", "C", "D"]) {
      const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
      const previous = f.cursor;
      try {
        await commit(f, plan);
        f.cursor = plan.finalCursor;
        if (ids.at(-1) !== f.cursor.docId) ids.push(f.cursor.docId);
      } finally {
        plan.dispose();
        previous.doc.destroy();
      }
      expect(await committedDirectory(f)).toEqual(ids);
    }
    const page = await loadCommittedDoc(f.store, directoryPageDocId(f.generation, 1));
    try {
      expect(page!.lastSeq).toBe(3);
    } finally {
      page?.doc.destroy();
    }
    const text: string[] = [];
    for (const docId of ids) {
      const loaded = await loadCommittedDoc(f.store, docId);
      try {
        text.push(
          ...(records<LiveRecordValue>(loaded!.doc)?.toArray() ?? []).map((record) =>
            new TextDecoder().decode(record.payload),
          ),
        );
      } finally {
        loaded?.doc.destroy();
      }
    }
    expect(text.join("")).toBe("ABCD");
  } finally {
    f.cursor.doc.destroy();
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});

// 未传覆盖值时也须使用单raw帧加先前合并窗口的完整边界，而不是单帧上限。
test("defaults to a 115-byte complete flush limit and rejects 116 bytes without an override", async () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRawAcpFrameBytes: 100, liveMergeMaxBytes: 16 },
  };
  const f = await textBatchFixture(capacity);
  try {
    const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(115)) });
    try {
      expect(records<LiveRecordValue>(plan.finalCursor.doc)!.toArray()[0]!.payload.byteLength).toBe(115);
    } finally {
      plan.dispose();
    }
    await expect(planLiveTextBatch({ ...f, request: f.request("x".repeat(116)) })).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
  } finally {
    f.cursor.doc.destroy();
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});

// 每个seal独立重建必须等于该前驱的真实片序，空快照或串入后继都不能靠完整文本断言蒙混。
test("each final snapshot independently restores exactly the predecessor records and frontier", async () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, payloadChunkMaxBytes: 100, activeHardEncodedBytes: 700 },
  };
  const f = await textBatchFixture(capacity);
  await appendLegacy(f, ["prior|"]);
  const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(1500)) });
  try {
    expect(plan.seals.length).toBeGreaterThan(1);
    for (const seal of plan.seals) {
      const expected = new Y.Doc();
      const final = new Y.Doc();
      try {
        const baseline =
          seal.docId === f.cursor.docId
            ? Y.encodeStateAsUpdate(f.cursor.doc)
            : plan.newDocs.find((doc) => doc.docId === seal.docId)!.snapshot;
        Y.applyUpdate(expected, baseline);
        const updates = plan.slices.filter((slice) => slice.docId === seal.docId);
        for (const slice of updates) Y.applyUpdate(expected, slice.bytes);
        Y.applyUpdate(final, seal.finalSnapshot);
        expect(records<LiveRecordValue>(final)?.toArray()).toEqual(records<LiveRecordValue>(expected)?.toArray());
        expect(seal.finalSeq).toBe((seal.docId === f.cursor.docId ? f.cursor.lastSeq : 0) + updates.length);
        expect(f.digest(seal.finalSnapshot)).toBe(seal.finalHash);
      } finally {
        expected.destroy();
        final.destroy();
      }
    }
    await commit(f, plan);
  } finally {
    plan.dispose();
    plan.finalCursor.doc.destroy();
    f.cursor.doc.destroy();
    f.store.dispose();
  }
});

// 提交后的发现性必须来自存储根/页，不能仅用本机计划或目录缓存验证翻页成功。
test("reloads committed root and page links to discover the new tail after directory rollover", async () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, payloadChunkMaxBytes: 100, activeHardEncodedBytes: 400 },
  };
  const f = await textBatchFixture(capacity, 64);
  const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(350)) });
  try {
    await commit(f, plan);
    const root = await loadCommittedDoc(f.store, directoryRootDocId(f.generation));
    try {
      expect(readDirectoryRoot(root!.doc).latestPageId).toBe(directoryPageDocId(f.generation, 2));
    } finally {
      root?.doc.destroy();
    }
    const ids = await committedDirectory(f);
    expect(ids).toHaveLength(64 + plan.newDocs.filter((doc) => doc.kind === "content").length);
    expect(ids.at(-1)).toBe(plan.finalCursor.docId);
  } finally {
    plan.dispose();
    plan.finalCursor.doc.destroy();
    f.cursor.doc.destroy();
    f.store.dispose();
  }
});
