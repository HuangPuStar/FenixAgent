import { expect, test } from "bun:test";
import * as Y from "yjs";
import { TEXT_CLAIM_READ_BASE_BYTES, TEXT_CLAIM_READ_BODY_BYTES } from "../sync/capacity/text-claim-reservations";
import { sha256Digest } from "../sync/clock";
import type { LiveRecordValue } from "../sync/live/live-writer-types";
import { readTextClaimDoc } from "../sync/live/text-claim-read";
import { concatParts, records } from "../sync/live/writer-support";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import { scopeKey } from "../sync/protocol/identity";
import { authorityFixture } from "./sync-live-writer-authority-fixture";

/** 记录载荷均遵循单片硬限，组大小只影响原子批的中间态。 */
function group(prefix: string, count: number, bytes: number): LiveRecordValue[] {
  return Array.from({ length: count }, (_, index) => ({
    recordId: `${prefix}-${index}`,
    entryId: prefix,
    contentSlot: "text",
    contentType: "text/plain",
    partIndex: index,
    kind: "text",
    payload: new Uint8Array(bytes).fill(120),
  }));
}

// 多 Doc 原子批中当前内容块的三条连续更新应整体判定，不能把中间超限状态当作已提交快照。
test("同批跨页的 200 KiB 插入、32 KiB 插入再删除可完整读取", async () => {
  const f = await authorityFixture(),
    source = new Y.Doc(),
    runtime = new Y.Doc();
  try {
    records(source, group("kept", 20, 10 * 1024));
    const first = Y.encodeStateAsUpdate(source),
      firstVector = Y.encodeStateVector(source);
    records(source, group("removed", 4, 8 * 1024));
    const second = Y.encodeStateAsUpdate(source, firstVector),
      secondVector = Y.encodeStateVector(source);
    expect(Y.encodeStateAsUpdate(source).byteLength).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES);
    records(source)!.delete(20, 4);
    const third = Y.encodeStateAsUpdate(source, secondVector);
    expect(Y.encodeStateAsUpdate(source).byteLength).toBeLessThan(MAX_DOC_SNAPSHOT_BYTES);
    runtime.getMap("state").set("done", true);
    const runtimeUpdate = Y.encodeStateAsUpdate(runtime);
    const key = scopeKey(f.scope),
      pointer = await f.store.readScopePointer(key);
    if (!pointer?.writerOwner) throw new Error("Missing active writer");
    const updates = [
      { docId: f.contentId, fromSeq: 1, bytes: first },
      { docId: f.runtimeId, fromSeq: 1, bytes: runtimeUpdate },
      { docId: f.contentId, fromSeq: 2, bytes: second },
      { docId: f.contentId, fromSeq: 3, bytes: third },
    ];
    expect(
      (
        await f.store.appendUpdates({
          scopeKey: key,
          epoch: pointer.writerEpoch,
          owner: pointer.writerOwner,
          batchId: "atomic-text-and-runtime",
          digest: sha256Digest(concatParts(updates.map((update) => update.bytes))),
          expectedFrontiers: [
            { docId: f.contentId, lastSeq: 0 },
            { docId: f.runtimeId, lastSeq: 0 },
          ],
          updates,
        })
      ).outcome,
    ).toBe("committed");
    const before = f.admission.used("hotDocLive");
    const read = f.store.readUpdatesAfter.bind(f.store),
      pages: number[] = [],
      footprint: number[] = [];
    f.store.readUpdatesAfter = async (...args) => {
      pages.push(args[2]);
      footprint.push(f.admission.used("hotDocLive") - before);
      return read(...args);
    };
    expect(
      await readTextClaimDoc({
        store: f.store,
        admission: f.admission,
        scopeKey: key,
        docId: f.contentId,
        assertCurrent: () => {},
        consume(doc, seq) {
          expect(f.admission.used("hotDocLive") - before).toBe(TEXT_CLAIM_READ_BASE_BYTES);
          return {
            entries: records<LiveRecordValue>(doc)
              ?.toArray()
              .map((record) => record.entryId),
            seq,
          };
        },
      }),
    ).toEqual({ entries: Array.from({ length: 20 }, () => "kept"), seq: 3 });
    expect(pages).toEqual([1, 1, 1, 1]);
    expect(footprint).toEqual([
      TEXT_CLAIM_READ_BASE_BYTES,
      TEXT_CLAIM_READ_BASE_BYTES,
      TEXT_CLAIM_READ_BODY_BYTES,
      TEXT_CLAIM_READ_BODY_BYTES,
    ]);
    expect(f.admission.used("hotDocLive")).toBe(before);
  } finally {
    source.destroy();
    runtime.destroy();
    await f.close();
  }
});

// 新提交不能留下无法重放的已接纳数据；读取旧 active 时仍保留独立重放上限。
test("超重放上限的批次在写入前整批拒绝且旧 active 读取仍受限", async () => {
  const f = await authorityFixture(),
    source = new Y.Doc();
  try {
    const encoded: Uint8Array[] = [];
    let vector = Y.encodeStateVector(source);
    for (const [prefix, count, bytes] of [
      ["first", 20, 10240],
      ["second", 20, 10240],
      ["third", 8, 8192],
    ] as const) {
      records(source, group(prefix, count, bytes));
      encoded.push(Y.encodeStateAsUpdate(source, vector));
      vector = Y.encodeStateVector(source);
    }
    records(source)!.delete(0, 48);
    encoded.push(Y.encodeStateAsUpdate(source, vector));
    expect(Y.encodeStateAsUpdate(source).byteLength).toBeLessThan(MAX_DOC_SNAPSHOT_BYTES);
    const key = scopeKey(f.scope),
      pointer = await f.store.readScopePointer(key);
    if (!pointer?.writerOwner) throw new Error("Missing active writer");
    const pools = ["hotDocLive", "controlIndex", "transportCache"] as const;
    const state = f.store.exportCommittedState(),
      used = pools.map((pool) => f.admission.used(pool));
    await expect(
      f.store.appendUpdates({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        owner: pointer.writerOwner,
        batchId: "bounded-large-atomic",
        digest: sha256Digest(concatParts(encoded)),
        expectedFrontiers: [{ docId: f.contentId, lastSeq: 0 }],
        updates: encoded.map((bytes, index) => ({ docId: f.contentId, fromSeq: index + 1, bytes })),
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(state);
    expect(pools.map((pool) => f.admission.used(pool))).toEqual(used);
    f.store.readUpdatesAfter = async (docId, seq) =>
      encoded[seq]
        ? [
            {
              docId,
              scopeKey: key,
              generation: pointer.currentGeneration!,
              updateSeq: seq + 1,
              bytes: encoded[seq]!,
              batchId: "old-active-batch",
              digest: "old-active-digest",
            },
          ]
        : [];
    const before = f.admission.used("hotDocLive");
    let consumed = false;
    await expect(
      readTextClaimDoc({
        store: f.store,
        admission: f.admission,
        scopeKey: key,
        docId: f.contentId,
        assertCurrent: () => {},
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(consumed).toBe(false);
    expect(f.admission.used("hotDocLive")).toBe(before);
  } finally {
    source.destroy();
    await f.close();
  }
});

// 中间插入会拆分已有 Item：原始字节和刚好不超限，也不能据此跳过最终快照检查。
test("近限基线的中间插入导致 split 开销时拒绝最终超限快照", async () => {
  const f = await authorityFixture(),
    source = new Y.Doc();
  source.clientID = 12345;
  source.getText("t").insert(0, "x".repeat(MAX_DOC_SNAPSHOT_BYTES - 34));
  const snapshot = Y.encodeStateAsUpdate(source),
    vector = Y.encodeStateVector(source);
  source.getText("t").insert(Math.floor((MAX_DOC_SNAPSHOT_BYTES - 34) / 2), "z");
  const delta = Y.encodeStateAsUpdate(source, vector);
  expect(snapshot.byteLength + delta.byteLength).toBeLessThanOrEqual(MAX_DOC_SNAPSHOT_BYTES);
  expect(Y.encodeStateAsUpdate(source).byteLength).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES);
  f.store.readDocStateAt = async (docId) => ({ docId, snapshot, hash: sha256Digest(snapshot), baseSeq: 0, lastSeq: 0 });
  f.store.readUpdatesAfter = async (docId, seq) =>
    seq === 0
      ? [
          {
            docId,
            scopeKey: scopeKey(f.scope),
            generation: "gen_cursor",
            updateSeq: 1,
            bytes: delta,
            batchId: "split-batch",
            digest: sha256Digest(delta),
          },
        ]
      : [];
  let consumed = false;
  try {
    await expect(
      readTextClaimDoc({
        store: f.store,
        admission: f.admission,
        scopeKey: scopeKey(f.scope),
        docId: f.contentId,
        assertCurrent: () => {},
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(consumed).toBe(false);
  } finally {
    source.destroy();
    await f.close();
  }
});

for (const fault of ["quota", "tail"] as const) {
  // 真实大中间态要求扩展额度；扩展被拒绝或之后读取失败均须完整归还，原 Doc 仍可重读。
  test(`大中间态的 ${fault} 失败归还动态预留且恢复后可重新读取`, async () => {
    const f = await authorityFixture(),
      source = new Y.Doc();
    let hold: ReturnType<typeof f.admission.reserve> | undefined;
    try {
      records(source, group("kept", 20, 10240));
      const first = Y.encodeStateAsUpdate(source),
        firstVector = Y.encodeStateVector(source);
      records(source, group("removed", 4, 8192));
      const second = Y.encodeStateAsUpdate(source, firstVector),
        secondVector = Y.encodeStateVector(source);
      records(source)!.delete(20, 4);
      const encoded = [first, second, Y.encodeStateAsUpdate(source, secondVector)];
      const key = scopeKey(f.scope),
        pointer = await f.store.readScopePointer(key);
      if (!pointer?.writerOwner) throw new Error("Missing active writer");
      expect(
        (
          await f.store.appendUpdates({
            scopeKey: key,
            epoch: pointer.writerEpoch,
            owner: pointer.writerOwner,
            batchId: `dynamic-${fault}`,
            digest: sha256Digest(concatParts(encoded)),
            expectedFrontiers: [{ docId: f.contentId, lastSeq: 0 }],
            updates: encoded.map((bytes, index) => ({ docId: f.contentId, fromSeq: index + 1, bytes })),
          })
        ).outcome,
      ).toBe("committed");
      const baseline = f.admission.used("hotDocLive"),
        control = f.admission.used("controlIndex");
      if (fault === "quota")
        hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive") - TEXT_CLAIM_READ_BASE_BYTES);
      const held = f.admission.used("hotDocLive");
      const read = f.store.readUpdatesAfter.bind(f.store),
        positions: number[] = [];
      const failure = new Error("tail failed after growth");
      let armed = true;
      f.store.readUpdatesAfter = async (...args) => {
        positions.push(args[1]);
        if (fault === "tail" && armed && args[1] === 2) {
          expect(f.admission.used("hotDocLive") - baseline).toBe(TEXT_CLAIM_READ_BODY_BYTES);
          throw failure;
        }
        return read(...args);
      };
      const consume = () =>
        readTextClaimDoc({
          store: f.store,
          admission: f.admission,
          scopeKey: key,
          docId: f.contentId,
          assertCurrent: () => {},
          consume(doc) {
            return records(doc)?.length;
          },
        });
      const refused = await consume().catch((error: unknown) => error);
      if (fault === "quota") {
        expect(refused).toMatchObject({ code: "ADMISSION_REJECTED" });
        expect(positions).toEqual([0, 1]);
      } else expect(refused).toBe(failure);
      expect(f.admission.used("hotDocLive")).toBe(held);
      expect(f.admission.used("controlIndex")).toBe(control);
      hold?.release();
      armed = false;
      expect(await consume()).toBe(20);
      expect(f.admission.used("hotDocLive")).toBe(baseline);
    } finally {
      hold?.release();
      source.destroy();
      await f.close();
    }
  });
}
