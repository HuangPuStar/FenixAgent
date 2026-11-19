import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { LIVE_WRITER_LEASE_TTL_MS, type LiveRecordValue } from "../sync/live/live-writer";
import { records } from "../sync/live/writer-support";
import { scopeKey } from "../sync/protocol/identity";
import { authorityFixture, text } from "./sync-live-writer-authority-fixture";

// 接管期间尾块新增legacy身份时，临时重判仍须有预算扫描增长，且不得把未提交原输入丢弃。
test("同代重判信用覆盖另一owner追加并封口的legacy身份增长", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  try {
    await f.writer.accept(text("retained"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    const key = scopeKey(f.scope),
      pointer = (await f.store.readScopePointer(key))!;
    const loaded = (await loadCommittedDoc(f.store, f.contentId))!;
    let update: Uint8Array;
    try {
      const before = Y.encodeStateVector(loaded.doc);
      const legacy: LiveRecordValue[] = Array.from({ length: 600 }, (_, index) => ({
        recordId: `legacy-${index}`,
        entryId: `legacy-${index}`.padEnd(128, "x"),
        contentSlot: "text",
        contentType: "text/plain",
        kind: "text",
        partIndex: 0,
        payload: new TextEncoder().encode("l"),
      }));
      records(loaded.doc, legacy);
      update = Y.encodeStateAsUpdate(loaded.doc, before);
    } finally {
      loaded.doc.destroy();
    }
    expect(
      (
        await f.store.appendUpdates({
          scopeKey: key,
          epoch: pointer.writerEpoch,
          owner: pointer.writerOwner!,
          batchId: "late-legacy-growth",
          digest: sha256Digest(update),
          expectedFrontiers: [{ docId: f.contentId, lastSeq: loaded.lastSeq }],
          updates: [{ docId: f.contentId, fromSeq: loaded.lastSeq + 1, bytes: update }],
          refs: [],
        })
      ).outcome,
    ).toBe("committed");
    await replacement.recover();
    await replacement.seal();
    await replacement.close();
    const boundary = f.store.exportCommittedState();
    await f.writer.acquire();
    const values = await f.readAll();
    expect(values).toHaveLength(601);
    expect(values.map((record) => new TextDecoder().decode(record.payload)).join("")).toBe(
      `${"l".repeat(600)}retained`,
    );
    expect(f.store.exportCommittedState().updates).toHaveLength(boundary.updates.length + 1);
    expect(f.admission.used("ingressSpool")).toBe(0);
    const committed = f.store.exportCommittedState();
    await f.writer.accept(text("retained"));
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    expect(f.store.exportCommittedState().refs).toEqual(committed.refs);
  } finally {
    await replacement.close();
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});
