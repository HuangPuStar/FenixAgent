import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { createTextClaim } from "../sync/live/text-claim";
import { records } from "../sync/live/writer-support";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";

/** 使用真实控制池与读取器，只替换历史基线出口以观察缺失和 pending 校验。 */
function fixture() {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const generation = "claim-boundary";
  const historyIds = [0, 1].map((blockIndex) =>
    buildDocId({ kind: "content", generation, blockIndex, nonce: "history" }),
  );
  store.readSuccessor = async (scopeKey, docId) => ({
    scopeKey,
    docId,
    generation,
    kind: "content",
    state: "sealed",
    finalSeq: 0,
    route: null,
  });
  const active = new Y.Doc({ guid: buildDocId({ kind: "content", generation, blockIndex: 1, nonce: "active" }) });
  const claims = createTextClaim({ store, admission, scopeKey: "boundary-org/boundary-session", digest: sha256Digest });
  return {
    store,
    admission,
    generation,
    active,
    claims,
    input: {
      generation,
      entryId: "entry",
      contentSlot: "text",
      activeDoc: active,
      historyDocIds: historyIds,
    },
    close() {
      claims.reset();
      active.destroy();
      store.dispose();
    },
  };
}

/** 导入文本保持历史数字槽位语义，基线可由真实 Yjs 独立重建。 */
function history(docId: string, entries: readonly string[]) {
  const doc = new Y.Doc();
  records(
    doc,
    entries.map((entryId) => ({ kind: "text_part", entryId, contentSlot: 0 })),
  );
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return { docId, snapshot, hash: sha256Digest(snapshot), baseSeq: 0, lastSeq: 0 };
}

// 列出的历史块缺失时不能缓存不完整扫描；恢复后相同消息必须重新读取全部历史并判重。
test("缺失列出的历史基线明确失败且下次重新扫描", async () => {
  const f = fixture(),
    reads: string[] = [];
  let missing = true;
  f.store.readDocStateAt = async (docId) => {
    reads.push(docId);
    return missing && docId === f.input.historyDocIds[1] ? null : history(docId, ["entry"]);
  };
  try {
    await expect(f.claims.claim(f.input)).rejects.toMatchObject({ code: "DOC_NOT_FOUND" });
    missing = false;
    expect(await f.claims.claim(f.input)).toBe(false);
    expect(reads).toEqual([...f.input.historyDocIds, ...f.input.historyDocIds]);
  } finally {
    f.close();
  }
});

for (const wrongKind of [false, true]) {
  // 相同 key 的等待者也必须验证自己的 active 文档，不能借用合法首调用的判定结果。
  test(`同键 pending 拒绝 active 文档${wrongKind ? "种类" : "代次"}错误`, async () => {
    const f = fixture(),
      paused = gate();
    const wrong = new Y.Doc({
      guid: buildDocId({
        kind: wrongKind ? "runtime" : "content",
        generation: wrongKind ? f.generation : "other-generation",
        blockIndex: 1,
        nonce: "wrong",
      }),
    });
    f.store.readDocStateAt = async (docId) => {
      paused.enter();
      await paused.released;
      return history(docId, ["entry"]);
    };
    const first = rejection(f.claims.claim(f.input));
    try {
      await withinDeadline(paused.entered);
      const second = rejection(f.claims.claim({ ...f.input, activeDoc: wrong }));
      paused.release();
      expect(await first).toBeUndefined();
      expect(await second).toMatchObject({ code: "GENERATION_MISMATCH" });
    } finally {
      paused.release();
      await first;
      wrong.destroy();
      f.close();
    }
  });
}

// 尚未取得声明缓存额度的请求不能固定代次，归还额度后另一个合法代次仍可接纳。
test("声明缓存预留失败不会把尚未接纳的代次固定", async () => {
  const f = fixture(),
    reserve = f.admission.reserve.bind(f.admission);
  const nextGeneration = "replacement-generation";
  const next = new Y.Doc({
    guid: buildDocId({ kind: "content", generation: nextGeneration, blockIndex: 0, nonce: "next" }),
  });
  records(next, [{ kind: "text", entryId: "entry", contentSlot: "text" }]);
  let reservations = 0;
  f.admission.reserve = (pool, bytes) => {
    if (pool === "controlIndex" && ++reservations === 2) throw new SyncProtocolError("ADMISSION_REJECTED");
    return reserve(pool, bytes);
  };
  try {
    await expect(f.claims.claim({ ...f.input, historyDocIds: [] })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    f.admission.reserve = reserve;
    expect(await f.claims.claim({ ...f.input, generation: nextGeneration, activeDoc: next, historyDocIds: [] })).toBe(
      false,
    );
  } finally {
    f.admission.reserve = reserve;
    next.destroy();
    f.close();
  }
});
